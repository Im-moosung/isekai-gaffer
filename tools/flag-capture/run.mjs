#!/usr/bin/env node
// 입장 배너 **국기** 실주행 캡처 — 실제 Chrome(headless:false)을 몰아 컷1·컷2를 찍고,
// 배너가 원근·조명 속에서 국기로 읽히는지 눈으로 확인할 확대 크롭까지 남긴다.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭은 rAF를 스로틀해 캔버스가 얼어붙는다.
// 그래서 **연속 프레임 픽셀 diff**로 진행을 먼저 증명한 뒤에 찍는다(tools/entrance-frame/live.mjs 관례).
//
// 추가로 `/flags/*.svg` 네트워크 응답을 기록한다 — 배너가 폴백 도안인지 실제 국기인지
// 그림만 보고 헷갈리지 않기 위해서다(체코기처럼 단순한 도안은 폴백과 혼동될 수 있다).
//
// 사용: node tools/flag-capture/run.mjs [--w 1600 --h 900]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))

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

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
})
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
const flagReqs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))
page.on('response', r => {
  if (r.url().includes('/flags/')) flagReqs.push(`${r.status()} ${r.url()}`)
})

const shot = async (name, clip) => {
  const path = join(SHOTS, `flag-${name}-${W}x${H}.png`)
  await page.screenshot({ path, ...(clip ? { clip } : {}) })
  return path
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()

  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 20000 })
  const box = await canvas.boundingBox()
  const a = await canvas.screenshot()
  await page.waitForTimeout(220)
  const b = await canvas.screenshot()
  const moving = a.length !== b.length || !a.equals(b)
  console.log(`캔버스 ${box.width.toFixed(0)}×${box.height.toFixed(0)} · 프레임 진행 ${moving ? 'OK(픽셀 변화 있음)' : 'FAIL(정지)'}`)
  if (!moving) throw new Error('캔버스가 정지했다 — 계측 무의미')

  const waitPhase = async p =>
    page.waitForFunction(
      q => document.querySelector('[data-testid="entrance-overlay"]')?.dataset.phase === q,
      p,
      { timeout: 30000 },
    )

  await waitPhase('walkout')
  await page.waitForTimeout(2600)
  console.log(`  walkout → ${await shot('walkout')}`)
  // 배너는 화면 상단(피치 안쪽)에 눕는다 — 위쪽 절반을 확대해 도안을 확인한다.
  console.log(`  walkout-crop → ${await shot('walkout-crop', { x: 0, y: Math.round(H * 0.12), width: W, height: Math.round(H * 0.42) })}`)

  await waitPhase('split')
  await page.waitForTimeout(3800)
  console.log(`  split → ${await shot('split')}`)
  console.log(`  split-crop → ${await shot('split-crop', { x: 0, y: Math.round(H * 0.12), width: W, height: Math.round(H * 0.42) })}`)

  console.log('국기 요청:', flagReqs.length ? flagReqs.join(' | ') : '(없음 — 폴백 도안이다)')
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(SHOTS, `flag-capture-${W}x${H}.log`), [...logs, '', ...flagReqs].join('\n'))
  await browser.close()
  await server.close()
}
