#!/usr/bin/env node
// 11라운드 증거 — 코너 루틴의 **연속 프레임**을 캡처한다.
//
// 정지 프레임 한 장으로는 세트피스가 도는지 알 수 없다. 그래서
//  (a) 캡처 전에 **픽셀 diff로 프레임 진행을 먼저 증명**하고(이 프로젝트가 두 번 당했다:
//      백그라운드 Chrome 탭은 rAF를 정지시킨다 → `channel:'chrome', headless:false`),
//  (b) 장면 전 구간을 등간격으로 훑되 **키프레임 시각을 반드시 포함**한다.
//
// 사용:
//   node tools/round11/capture.mjs                       # far/normal/goal
//   ROUTE=near LOAD=heavy node tools/round11/capture.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const ROUTE = process.env.ROUTE ?? 'far'
const LOAD = process.env.LOAD ?? 'normal'
const TYPE = process.env.TYPE ?? 'goal'
const LANE = process.env.LANE ?? '0'
const TAG = process.env.TAG ?? `r11-sp-${ROUTE}-${LOAD}-${TYPE}`
const DWELL = Number(process.env.DWELL ?? 24000)
const W = 1280, H = 720

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
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

const out = { tag: TAG, route: ROUTE, boxLoad: LOAD, type: TYPE, frames: [], logs }
try {
  const url = `http://127.0.0.1:${port}/tools/round11/sp.html?route=${ROUTE}&load=${LOAD}&type=${TYPE}&lane=${LANE}&dwell=${DWELL}`
  await page.goto(url, { waitUntil: 'load' })
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 60000 })
  const probe = await page.evaluate(() => window.__probe)
  out.probe = { key: probe.key, moverCount: probe.moverCount, steps: probe.steps.map(s => ({ t: s.t, ball: s.ball })) }
  console.log(`장면 ${probe.key} · 무버 ${probe.moverCount}명`)

  // ── 1) 프레임 진행 증명 ────────────────────────────────────────────────
  const a = await canvas.screenshot()
  await page.waitForTimeout(300)
  const b = await canvas.screenshot()
  const moving = a.length !== b.length || !a.equals(b)
  out.frameAdvance = moving
  console.log(`프레임 진행 ${moving ? 'OK' : 'FAIL'} (${a.length} vs ${b.length} bytes)`)
  if (!moving) throw new Error('캔버스 정지 — 계측 무의미')

  // ── 2) 촬영 계획: 키프레임 시각 + 그 사이 등간격 ──────────────────────
  const keyMs = probe.steps.map(s => s.t * DWELL)
  const endMs = keyMs[keyMs.length - 1] + 1200
  const plan = new Set(keyMs.map(ms => Math.round(ms)))
  for (let ms = 0; ms <= endMs; ms += Math.round(endMs / 14)) plan.add(ms)
  const shots = [...plan].sort((x, y) => x - y)

  await page.evaluate(() => window.__start())
  const startedAt = Date.now()
  for (let i = 0; i < shots.length; i++) {
    const ms = shots[i]
    const wait = ms - (Date.now() - startedAt)
    if (wait > 0) await page.waitForTimeout(wait)
    const t = ms / DWELL
    const name = `${TAG}-${String(i).padStart(2, '0')}-t${t.toFixed(3)}.jpg`
    const buf = await canvas.screenshot({ path: join(SHOTS, name), type: 'jpeg', quality: 82 })
    const onKey = keyMs.some(k => Math.abs(k - ms) < 30)
    out.frames.push({ i, t: +t.toFixed(4), ms, file: name, keyframe: onKey, bytes: buf.length })
    console.log(`${name}${onKey ? ' ★키프레임' : ''}`)
  }
  out.distinctBytes = new Set(out.frames.map(f => f.bytes)).size
  console.log(`서로 다른 프레임 ${out.distinctBytes}/${out.frames.length}`)
} catch (e) {
  out.error = String(e)
  console.error(e)
} finally {
  await writeFile(join(ROOT, 'docs/audit', `${TAG}.json`), JSON.stringify(out, null, 2))
  await browser.close()
  await server.close()
}
console.log('logs:', logs.slice(0, 10).join('\n'))
