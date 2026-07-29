// tools/tone-stats/driver.mjs
// 헤드리스 Chrome 드라이버 — vite dev 서버를 띄우고, 시스템 Chrome을 CDP로 몰아
// `tools/tone-stats/harness.ts`의 `window.__toneHarness.run()`을 호출하고 스크린샷을 남긴다.
//
// 왜 직접 CDP를 말하는가:
//   puppeteer/playwright를 devDependency로 넣으면 수백 MB의 Chromium을 내려받는다.
//   필요한 건 "페이지 열고 함수 하나 호출하고 스크린샷 찍기"뿐이고, Node 26에는 전역
//   fetch/WebSocket이 있으므로 **새 npm 의존성 0**으로 끝난다. 대신 시스템 Chrome을 쓴다
//   (CHROME 환경변수로 경로 지정 가능).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

export const ROOT = resolve(import.meta.dirname, '../..')
export const SHOTS = join(ROOT, 'docs/audit/shots')

/** 계측 해상도. 1600×900은 심사자가 볼 노트북 창 크기에 가깝고 16:9다. */
export const WIDTH = 1600
export const HEIGHT = 900

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

/** 최소 CDP 클라이언트 — id 기반 요청/응답 + 페이지 로그 수집만 한다. */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /** 페이지 콘솔·예외 — 하네스가 안 뜰 때 원인을 여기서 본다. */
    this.pageLog = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        this.pageLog.push(`[예외] ${d?.exception?.description ?? d?.text ?? JSON.stringify(d)}`)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const txt = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
        this.pageLog.push(`[${msg.params.type}] ${txt}`)
        return
      }
      if (msg.method === 'Log.entryAdded') {
        this.pageLog.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`)
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
      else p.resolve(msg.result)
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => res(ws), { once: true })
    ws.addEventListener('error', () => rej(new Error(`WebSocket 실패: ${url}`)), { once: true })
  })
}

async function waitFor(fn, { timeoutMs = 30000, everyMs = 100, what = '조건' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* 재시도 */
    }
    if (Date.now() > deadline) throw new Error(`${what} 대기 시간 초과`)
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

/** OS에서 빈 포트를 하나 받아 즉시 반납한다(TOCTOU 창은 있지만 실무상 충분). */
function freePort() {
  return new Promise((res, rej) => {
    const srv = netCreateServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => res(p))
    })
  })
}

async function launchChrome(userDataDir) {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!bin) throw new Error(`Chrome을 찾을 수 없다. CHROME=<경로>로 지정하라.\n후보: ${CHROME_CANDIDATES.join(', ')}`)
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      // GPU가 없는 CI에서도 렌더는 되게 한다(수치는 실 GPU와 다르다 — 비교용으로만).
      '--enable-unsafe-swiftshader',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  proc.stderr.on('data', () => {})
  const port = await waitFor(
    async () => {
      const [p] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split('\n')
      return p ? Number(p) : null
    },
    { what: 'Chrome DevTools 포트' },
  )
  return { proc, port }
}

/**
 * 여러 렌더 조합을 한 브라우저 세션에서 순차 실행한다.
 * @param {{label: string, opts: object}[]} runs 각 실행의 라벨(스크린샷 파일명)과 하네스 옵션
 * @param {{shots?: boolean}} [cfg] shots=false면 스크린샷을 생략한다(스윕에서 유용).
 * @returns {Promise<Array<object>>} 하네스 RunResult에 label·shot 경로를 얹은 배열
 */
export async function runInBrowser(runs, cfg = {}) {
  const withShots = cfg.shots !== false
  if (withShots) await mkdir(SHOTS, { recursive: true })

  // 포트는 우리가 직접 잡는다. vite에 port:0을 주면 기본 5173으로 정규화되는데, 다른
  // 프로젝트의 dev 서버가 그 포트를 쓰고 있으면 **엉뚱한 앱을 계측하게 된다**(실제로 당했다).
  const port = await freePort()
  const server = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port, strictPort: true },
    logLevel: 'error',
  })
  await server.listen()
  const url = `http://127.0.0.1:${port}/tools/tone-stats/harness.html`

  const userDataDir = join(tmpdir(), `tone-stats-${process.pid}`)
  const { proc, port: cdpPort } = await launchChrome(userDataDir)

  const results = []
  let ws
  try {
    const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(), {
      what: 'CDP /json/version',
    })
    ws = await connect(version.webSocketDebuggerUrl)
    const cdp = new CDP(ws)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const call = (m, p) => cdp.send(m, p, sessionId)

    await call('Page.enable')
    await call('Runtime.enable')
    await call('Log.enable')
    await call('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await call('Page.navigate', { url })
    await waitFor(
      async () => {
        const r = await call('Runtime.evaluate', {
          expression: 'typeof window.__toneHarness === "object"',
          returnByValue: true,
        })
        return r.result.value === true
      },
      { what: '하네스 로드', timeoutMs: 60000 },
    ).catch((e) => {
      throw new Error(`${e.message}\n페이지 로그:\n${cdp.pageLog.join('\n') || '(없음)'}`)
    })

    for (const run of runs) {
      const opts = { width: WIDTH, height: HEIGHT, ...run.opts }
      const r = await call('Runtime.evaluate', {
        expression: `window.__toneHarness.run(${JSON.stringify(opts)})`,
        awaitPromise: true,
        returnByValue: true,
      })
      if (r.exceptionDetails) {
        throw new Error(
          `${run.label} 렌더 실패: ${JSON.stringify(r.exceptionDetails)}\n` +
            `페이지 로그:\n${cdp.pageLog.slice(-40).join('\n') || '(없음)'}`,
        )
      }
      const res = { label: run.label, ...r.result.value }
      if (withShots) {
        const shot = join(SHOTS, `tone-${run.label}.png`)
        const cap = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        await writeFile(shot, Buffer.from(cap.data, 'base64'))
        res.shot = shot
        process.stderr.write(`  ✓ ${run.label} → ${shot}\n`)
      } else {
        process.stderr.write(`  ✓ ${run.label}\n`)
      }
      results.push(res)
    }
    await call('Runtime.evaluate', { expression: 'window.__toneHarness.teardown()' })
  } finally {
    ws?.close()
    proc.kill('SIGKILL')
    await server.close()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
  return results
}
