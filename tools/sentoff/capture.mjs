#!/usr/bin/env node
// 8라운드 ① 증거 캡처 — 퇴장 전/후, 세 렌더러.
//
// rAF 함정: 백그라운드·헤드리스 탭은 rAF를 멈춘다. 실제 Chrome을 headless:false로 띄우고
// **캡처 전에 픽셀 diff로 프레임 진행을 먼저 증명한다**(이 프로젝트가 두 번 당했다).
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const W = 1280, H = 830

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
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

const rows = []
try {
  for (const r of ['svg', 'pixi', '3d']) {
    for (const minute of [39, 41, 69]) {
      const url = `http://127.0.0.1:${port}/tools/sentoff/board.html?r=${r}&minute=${minute}`
      await page.goto(url, { waitUntil: 'load' })
      const sel = r === '3d' ? 'canvas.m3d-canvas' : r === 'pixi' ? 'canvas, .pv-root' : '.pv-root'
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 60000 })
      await page.waitForTimeout(r === '3d' ? 2500 : 600)

      // ── 프레임 진행 증명(캡처 **전에**) ──────────────────────────
      // 안무(dwell 3s)가 도는 동안 잰다 — 정지 화면에서 diff를 재면 스로틀과 구분되지 않는다.
      const a = await page.screenshot()
      await page.waitForTimeout(400)
      const b = await page.screenshot()
      const moving = a.length !== b.length || !a.equals(b)

      // 안무가 끝나면 카메라가 줌 1(피치 전체)로 복귀한다 — 그때 세야 22/21/20이 다 보인다.
      await page.waitForTimeout(6000)

      const probe = await page.evaluate(() => window.__probe)
      // 화면에 실제로 그려진 도트 수. SVG 경로는 DOM으로 셀 수 있다.
      const svgDots = await page.evaluate(() => document.querySelectorAll('.pv-dot').length)
      const file = join(SHOTS, `r8-sentoff-${r}-${minute}m.png`)
      await page.screenshot({ path: file })
      rows.push({ r, minute, moving, expected: probe.expected, svgDots, framePlayers: probe.framePlayers, awaySentOff: probe.awaySentOff, file })
      console.log(`${r.padEnd(4)} ${String(minute).padStart(2)}분  프레임진행=${moving ? 'OK' : 'FAIL'}  기대=${probe.expected.total}  SVG도트=${svgDots}  3D프레임배역=${probe.framePlayers}  퇴장=[${probe.awaySentOff.join(',')}]`)
      if (!moving) console.log('   ⚠ 프레임 정지 — 이 캡처는 신뢰할 수 없다')
    }
  }
  await writeFile(join(SHOTS, 'r8-sentoff.json'), JSON.stringify({ rows, logs }, null, 2))
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await server.close()
}
