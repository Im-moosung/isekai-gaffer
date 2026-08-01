#!/usr/bin/env node
// 6라운드 감사 — 좌상단 판때기 겹침 실측 + 입장 컷 캡처(1600×900 · 390×844).
//
// rAF 함정: 헤드리스/백그라운드 탭은 rAF를 스로틀한다. 실제 Chrome 창을 띄우고
// 캡처 전에 **연속 프레임 픽셀 diff**로 진행을 먼저 증명한다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const VIEWPORTS = [
  { w: 1600, h: 900 },
  { w: 390, h: 844 },
]

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

/** 두 사각형의 겹침 넓이. 0이면 안 겹친다. */
function overlap(a, b) {
  if (!a || !b) return null
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return { w: +w.toFixed(1), h: +h.toFixed(1), area: +(w * h).toFixed(0) }
}

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
})
await server.listen()

const report = []
const logs = []

for (const { w: W, h: H } of VIEWPORTS) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
  })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  page.on('console', m => logs.push(`[${W}][${m.type()}] ${m.text()}`))
  page.on('pageerror', e => logs.push(`[${W}][error] ${e.message}`))
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
    await page.getByRole('button', { name: '바로 지휘하기' }).click()
    await page.getByRole('button', { name: '킥오프' }).click()
    const canvas = page.locator('canvas.m3d-canvas')
    await canvas.waitFor({ state: 'visible', timeout: 30000 })
    const a = await canvas.screenshot()
    await page.waitForTimeout(250)
    const b = await canvas.screenshot()
    const moving = a.length !== b.length || !a.equals(b)
    console.log(`${W}x${H} 프레임 진행 ${moving ? 'OK' : 'FAIL'}`)
    if (!moving) throw new Error('캔버스 정지 — 계측 무의미')

    for (const [label, waitMs] of [['walkout', 2500], ['split', 4200]]) {
      await page.waitForTimeout(waitMs)
      const rects = await page.evaluate(() => {
        const q = s => {
          const e = document.querySelector(s)
          if (!e) return null
          const r = e.getBoundingClientRect()
          return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
        }
        return {
          bar: q('.ent__bar'),
          pre: q('.ms-prematch'),
          preTeams: q('.ms-prematch__teams'),
          preCtx: q('.ms-prematch__ctx'),
          skip: q('.ent__actions'),
          close: q('.ent__close'),
          root: q('.ms-root'),
        }
      })
      const ov = overlap(rects.bar, rects.pre)
      const ovSkip = overlap(rects.bar, rects.skip)
      report.push({ vp: `${W}x${H}`, label, ...rects, overlapPrematch: ov, overlapSkip: ovSkip })
      const p = join(SHOTS, `r6-entrance-${W}x${H}-${label}.png`)
      await page.screenshot({ path: p })
      console.log(
        `${W}x${H} ${label}: bar↔prematch ${ov ? ov.area : 'n/a'}px² · bar↔skip ${ovSkip ? ovSkip.area : 'n/a'}px²` +
          ` · bar=${JSON.stringify(rects.bar)} pre=${JSON.stringify(rects.pre)}`,
      )
    }
  } catch (e) {
    console.error(`${W}x${H} 실패:`, e.message)
    console.error(logs.slice(-20).join('\n'))
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}
await writeFile(join(SHOTS, 'r6-overlap.json'), JSON.stringify(report, null, 1))
await writeFile(join(SHOTS, 'r6-probe.log'), logs.join('\n'))
await server.close()
