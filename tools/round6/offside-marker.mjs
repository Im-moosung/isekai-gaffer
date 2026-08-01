#!/usr/bin/env node
// 회귀 의심 B-4 — 오프사이드 상한 × 작전판 백라인 마커.
//
// 묻는 것: 작전판(AnalysisBoard)이 그리는 **우리 수비 라인 마커**보다 앞(우리 골문 쪽)에서
// 상대가 공을 잡는 프레임이 있는가. 있으면 안무의 오프사이드 상한(scenes.clampOffside)과
// 마커가 서로 다른 값을 보고 있다는 뜻이다.
//
// 방법: 두 값을 **같은 SVG 좌표계**에서 읽는다 — 마커는 `.an-team--home .an-line`의 x1,
// 선수는 `.pv-dot--away`의 cx, 공은 `.pv-ball`의 cx. 화면 픽셀이 아니라 뷰박스 좌표라
// 뷰포트 크기와 무관하다.
//
// 판정 규칙(축구 규칙 그대로):
//  · 우리가 지키는 골문 쪽 = 우리 라인 마커가 상대 라인 마커보다 가까운 쪽.
//  · 상대 공잡이가 (a) 우리 라인보다 골문 쪽이고 (b) 공보다 골문 쪽이면 오프사이드 위치다.
//    (b)를 빼면 안 된다 — 공보다 뒤에 있으면 언제나 온사이드다(스루패스가 아니라 드리블).
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const W = 1600
const H = 900

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
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'error',
})
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const samples = []
const flagged = []
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 30000 })
  const a = await canvas.screenshot()
  await page.waitForTimeout(240)
  if (a.equals(await canvas.screenshot())) throw new Error('캔버스 정지 — 계측 무의미')
  // 연출은 건너뛴다(이 계측의 대상이 아니다).
  await page.getByRole('button', { name: '건너뛰기' }).click().catch(() => {})
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '2x' }).click().catch(() => {})

  for (let step = 0; step < 900; step++) {
    if ((await page.locator('.ms-report').count()) > 0) break
    if ((await page.locator('.tb-root').count()) > 0) {
      if (!(await page.getByRole('button', { name: '후반 시작' }).click({ timeout: 2500 }).then(() => true).catch(() => false))) {
        await page.getByRole('button', { name: '전술 확정' }).click({ timeout: 2500 }).catch(() => {})
      }
      await page.getByRole('button', { name: '2x' }).click().catch(() => {})
      await page.waitForTimeout(600)
      continue
    }
    const s = await page.evaluate(() => {
      const board = document.querySelector('.ab-root')
      if (!board) return null
      const num = (el, attr) => (el ? Number(el.getAttribute(attr)) : NaN)
      const us = num(board.querySelector('.an-team--home .an-line'), 'x1')
      const them = num(board.querySelector('.an-team--away .an-line'), 'x1')
      const ball = board.querySelector('.pv-ball')
      const bx = num(ball, 'cx')
      const foes = [...board.querySelectorAll('.pv-dot--away')].map(e => Number(e.getAttribute('cx')))
      const mins = document.querySelector('.bc-scorebug')?.textContent?.match(/(\d+)'/)
      if (![us, them, bx].every(Number.isFinite) || foes.length === 0) return null
      // 우리 골문 방향: 우리 라인이 상대 라인보다 작은 x면 왼쪽을 지킨다.
      const dir = us < them ? -1 : 1 // -1 = 우리 골문이 x 작은 쪽
      // 우리 골문 쪽으로 더 간 정도(양수일수록 깊다).
      const depth = v => (dir === -1 ? -v : v)
      const carrier = foes.reduce((best, cx) => (Math.abs(cx - bx) < Math.abs(best - bx) ? cx : best), foes[0])
      return {
        minute: mins ? Number(mins[1]) : -1,
        usLine: +us.toFixed(2),
        ball: +bx.toFixed(2),
        carrier: +carrier.toFixed(2),
        carrierGap: +(depth(carrier) - depth(us)).toFixed(2), // >0 이면 우리 라인보다 골문 쪽
        beyondBall: +(depth(carrier) - depth(bx)).toFixed(2), // >0 이면 공보다 골문 쪽
        carrierOnBall: Math.abs(carrier - bx) < 2.5,
      }
    })
    if (s) {
      samples.push(s)
      if (s.carrierOnBall && s.carrierGap > 0.5 && s.beyondBall > 0.5) flagged.push(s)
    }
    await page.waitForTimeout(450)
  }
} catch (e) {
  samples.push({ error: e.message })
  process.exitCode = 1
} finally {
  const n = samples.filter(s => !s.error).length
  const onBall = samples.filter(s => s.carrierOnBall).length
  const lines = [
    `표본 ${n}프레임(작전판이 떠 있던 프레임만) · 그중 상대가 공을 잡고 있던 프레임 ${onBall}`,
    `마커보다 앞 + 공보다 앞에서 공을 잡은 프레임: ${flagged.length}`,
    ...flagged.slice(0, 20).map(f => `  ${f.minute}' 라인 ${f.usLine} · 공 ${f.ball} · 공잡이 ${f.carrier} (라인 대비 +${f.carrierGap})`),
  ]
  await writeFile(join(SHOTS, 'r6-offside-marker.json'), JSON.stringify({ samples, flagged }, null, 1))
  await writeFile(join(SHOTS, 'r6-offside-marker.txt'), lines.join('\n'))
  console.log(lines.join('\n'))
  await browser.close()
  await server.close()
}
