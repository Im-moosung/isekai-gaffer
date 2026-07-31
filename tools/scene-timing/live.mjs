#!/usr/bin/env node
// tools/scene-timing/live.mjs
// 하이라이트 **5단계 연속 캡처** — 실제 Chrome(headless:false)에서 3D 하이라이트가 뜨는
// 분을 잡아 dwell 전체를 조밀하게(기본 120 ms 간격) 찍는다. "슈터 임팩트 → 비행 →
// GK 반응 → 접촉 → 결과"가 실제 프레임에 있는지를 눈으로 증명하기 위한 하네스다.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭에서는 rAF가 스로틀되어 캔버스가 얼어붙는다.
// 실제 창을 띄우고 **연속 프레임 픽셀 diff**로 진행을 먼저 증명한 뒤에 찍는다
// (tools/entrance-frame/live.mjs와 같은 패턴).
//
// 사용: node tools/scene-timing/live.mjs --tag save5 [--w 1600 --h 900] [--step 120] [--shots 60]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const TAG = arg('tag', 'live')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const STEP = Number(arg('step', 120))
const SHOTS_N = Number(arg('shots', 60))
const OUT = join(ROOT, 'docs/audit/shots', `scene-${TAG}`)

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()
  // 입장 연출은 건너뛴다(있으면).
  const skip = page.getByRole('button', { name: /건너뛰기|스킵|skip/i })
  if (await skip.isVisible().catch(() => false)) await skip.click()

  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 40000 })

  // ── ① rAF 진행 증명(픽셀 diff) ──
  const a = await canvas.screenshot()
  await page.waitForTimeout(200)
  const b = await canvas.screenshot()
  if (a.length === b.length && a.equals(b)) throw new Error('캔버스 정지 — 계측 무의미')
  const box = await canvas.boundingBox()
  console.log(`캔버스 ${box.width.toFixed(0)}×${box.height.toFixed(0)} · rAF 진행 OK`)

  // ── ② 하이라이트 분 경계를 잡아 dwell 0 지점부터 연속 캡처 ──
  // 하이라이트 분의 경계는 캔버스 가시성이 아니다 — MatchScreen은 3D를 언마운트하지
  // 않고 2D 작전판을 opacity로 덮는다(WebGL 컨텍스트 재생성 히치 회피). 대신
  // `.ms-pitch-wrap[data-mode]`가 2d↔3d로 뒤집히고 `data-scene`이 그 분의 장면 키
  // (`H/central.a/save.b/L3`)를 그대로 노출한다 — 무엇을 찍었는지가 파일에 남는다.
  const wrap = '.ms-pitch-wrap'
  const modeIs = m => page.waitForFunction(
    ([sel, want]) => document.querySelector(sel)?.dataset.mode === want, [wrap, m], { timeout: 90000 },
  )
  const TAKES = Number(arg('takes', 4))
  const idx = []
  for (let take = 0; take < TAKES; take++) {
    if (!(await modeIs('2d').then(() => true).catch(() => false))) break
    if (!(await modeIs('3d').then(() => true).catch(() => false))) break
    const t0 = Date.now()
    const scene = await page.evaluate(sel => document.querySelector(sel)?.dataset.scene ?? '?', wrap)
    const dir = join(OUT, `take${take}-${scene.replace(/[^\w.-]/g, '_')}`)
    await mkdir(dir, { recursive: true })
    const lines = await page.evaluate(() => {
      const ls = [...document.querySelectorAll('.bc-ticker__line')].slice(-3)
      return ls.map(n => (n.textContent ?? '').replace(/\s+/g, ' '))
    })
    const rows = [`# ${scene} :: ${lines.join(' | ')}`]
    for (let i = 0; i < SHOTS_N; i++) {
      const ms = Date.now() - t0
      const name = `f${String(i).padStart(3, '0')}-${String(ms).padStart(5, '0')}ms.png`
      await page.screenshot({ path: join(dir, name) })
      rows.push(`${name}\t${ms}ms`)
      const wait = STEP - (Date.now() - t0 - ms)
      if (wait > 0) await page.waitForTimeout(wait)
    }
    await writeFile(join(dir, 'index.tsv'), rows.join('\n'))
    idx.push(`${dir.split('/').pop()}\t${lines.join(' | ')}`)
    console.log(`take${take} ${scene}: ${lines.join(' | ')}`)
  }
  await writeFile(join(OUT, 'takes.tsv'), idx.join('\n'))
  console.log(`→ ${OUT}`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'console.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
