#!/usr/bin/env node
// tools/round9/capture.mjs — 9라운드 증거.
//  ① 존(박스 안/밖)이 화면에서 갈리는가 — 같은 계열의 Zin/Zout 임팩트 프레임.
//  ② 계열 10종이 화면에서 서로 다른 전개로 읽히는가 — 계열마다 빌드업 3점 + 임팩트.
//
// rAF 함정: 백그라운드/헤드리스 탭은 rAF를 스로틀한다. 실제 Chrome을 headless:false로 띄우고
// 캡처 전에 **픽셀 diff로 프레임 진행을 증명**한다(이 프로젝트가 두 번 당했다).
// 작전판이 캔버스를 덮는 문제는 round7의 전용 하니스 페이지가 이미 해결해 두었다 — 재사용한다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const DWELL = 30000
const W = 1280, H = 720
/** 캡처 대상 — [파일 태그, key 조건(AND), attackPattern]. */
const CASES = [
  ['zone-in-central', 'central.a,goal.a,L0,Zin', 'balanced'],
  ['zone-out-central', 'central.a,goal.a,L0,Zout', 'longshot'],
  ['pattern-central', 'central.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-wing', 'wing.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-through', 'through.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-outside', 'outside.a,goal.a,L0', 'longshot'],
  ['pattern-counter', 'counter.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-switch', 'switch.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-longball', 'longball.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-press', 'press.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-carry', 'carry.a,goal.a,L0,Zin', 'balanced'],
  ['pattern-secondball', 'secondball.a,goal.a,L0', 'longshot'],
]

const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

const out = { dwellMs: DWELL, shots: [], logs }
try {
  for (const [tagName, key, pattern] of CASES) {
    const tag = `r9-${tagName}`
    await page.goto(
      `http://127.0.0.1:${port}/tools/round7/dribble.html?key=${encodeURIComponent(key)}`
      + `&pattern=${pattern}&dwell=${DWELL}`,
      { waitUntil: 'load' })
    const canvas = page.locator('canvas.m3d-canvas')
    await canvas.waitFor({ state: 'visible', timeout: 60000 })
    const probe = await page.evaluate(() => window.__probe)
    // 프레임 진행 증명(정지 화면이면 계측 무의미).
    const a = await canvas.screenshot()
    await page.waitForTimeout(300)
    const b = await canvas.screenshot()
    const moving = a.length !== b.length || !a.equals(b)
    if (!moving) throw new Error(`${key}: 캔버스 정지`)

    const steps = probe.steps
    // 슛 임팩트 = arc가 'shot'인 스텝 = 마지막에서 두 번째. 빌드업 3점은 t를 균등 분할.
    const tShot = steps[steps.length - 2].t
    const plan = [
      { label: 'build1', ms: steps[Math.min(1, steps.length - 1)].t * DWELL + 60 },
      { label: 'build2', ms: steps[Math.floor(steps.length / 2)].t * DWELL },
      { label: 'deliver', ms: (tShot - (tShot - steps[Math.floor(steps.length / 2)].t) * 0.35) * DWELL },
      { label: 'impact', ms: tShot * DWELL + 40 },
      { label: 'result', ms: steps[steps.length - 1].t * DWELL + 250 },
    ]
    await page.evaluate(() => window.__start())
    const t0 = Date.now()
    const files = []
    for (const p of plan) {
      const wait = p.ms - (Date.now() - t0)
      if (wait > 0) await page.waitForTimeout(wait)
      const name = `${tag}-${p.label}.jpg`
      const buf = await canvas.screenshot({ path: join(SHOTS, name), type: 'jpeg', quality: 82 })
      files.push({ label: p.label, file: name, t: +(p.ms / DWELL).toFixed(4), bytes: buf.length })
    }
    out.shots.push({ key: probe.key, minute: probe.minute, frameAdvance: moving, files })
    console.log(`${probe.key} → ${files.length}장 (서로 다른 바이트 ${new Set(files.map(f => f.bytes)).size})`)
  }
} catch (e) {
  out.error = String(e)
  console.error(e)
} finally {
  await writeFile(join(ROOT, 'docs/audit', 'r9-shots.json'), JSON.stringify(out, null, 2))
  await browser.close()
  await server.close()
}
if (logs.length) console.log('logs:', logs.slice(0, 10).join('\n'))
