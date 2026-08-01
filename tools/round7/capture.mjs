#!/usr/bin/env node
// 7라운드 ① 증거 — 드리블 구간의 **연속 프레임**을 캡처한다.
//
// rAF 함정: 헤드리스·백그라운드 탭은 rAF를 스로틀한다. 실제 Chrome 창을 headless:false로
// 띄우고, 캡처 전에 **픽셀 diff로 프레임 진행을 먼저 증명**한다(이 프로젝트가 두 번 당했다).
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const KEY = process.env.KEY ?? 'goal.e'
const TAG = process.env.TAG ?? 'r7-dribble'
const DWELL = Number(process.env.DWELL ?? 36000)
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

const out = { key: KEY, frames: [], logs }
try {
  await page.goto(`http://127.0.0.1:${port}/tools/round7/dribble.html?key=${encodeURIComponent(KEY)}&dwell=${DWELL}`, { waitUntil: 'load' })
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 60000 })
  const probe = await page.evaluate(() => window.__probe)
  out.probe = probe

  // ── 1) 프레임 진행 증명 ────────────────────────────────────────────────
  const a = await canvas.screenshot()
  await page.waitForTimeout(300)
  const b = await canvas.screenshot()
  const moving = a.length !== b.length || !a.equals(b)
  out.frameAdvance = moving
  console.log(`프레임 진행 ${moving ? 'OK' : 'FAIL'} (${a.length} vs ${b.length} bytes)`)
  if (!moving) throw new Error('캔버스 정지 — 계측 무의미')

  // ── 2) 드리블 구간(같은 캐리어 연속)을 t로 계산 ────────────────────────
  const steps = probe.steps
  const spans = []
  for (let k = 0; k + 1 < steps.length; k++) {
    if (steps[k].carrier && steps[k + 1].carrier === steps[k].carrier) {
      spans.push([steps[k].t, steps[k + 1].t, steps[k].carrier])
    }
  }
  // 마지막 킥(소유권 이전)의 t — 여기서만 발이 나가야 한다.
  let shotT = 0
  for (let k = 0; k + 1 < steps.length; k++) {
    if (steps[k].carrier && steps[k + 1].carrier !== steps[k].carrier) shotT = steps[k].t
  }
  out.dribbleSpans = spans
  out.shotT = shotT

  // ── 3) 연속 캡처 ───────────────────────────────────────────────────────
  // 두 구간을 찍는다.
  //  A) 드리블 구간 — dwell을 늘려 놓았으므로 t 등간격으로 넓게.
  //  B) 임팩트 구간 — 킥 창은 **ms 고정**(백스윙 260 + 팔로스루 340 = 600 ms)이라
  //     dwell을 늘려도 넓어지지 않는다. 여기만 55 ms 간격으로 촘촘히 찍어야
  //     "발이 나가는 순간이 여기 하나뿐"임을 보일 수 있다.
  const shotMs = shotT * DWELL
  const plan = []
  // A) 드리블 터치 시각 — **여기가 개편 전 유령 킥의 임팩트**다. 킥 창은 ms 고정(600 ms)이라
  //    dwell을 늘리면 t축에서 바늘이 된다(0.0167). 등간격 샘플링으로는 스치듯 놓치므로,
  //    저술이 터치를 둔 시각을 그대로 겨냥해 백스윙·임팩트·팔로스루 세 점을 찍는다.
  const touchMs = []
  for (let k = 0; k + 1 < steps.length; k++) {
    const a = steps[k], b = steps[k + 1]
    if (!a.carrier || b.carrier !== a.carrier) continue
    if (Math.hypot(a.ball.x - b.ball.x, a.ball.y - b.ball.y) < 1) continue
    if (a.t <= 0) continue
    touchMs.push(a.t * DWELL)
  }
  out.touchMs = touchMs
  for (const ms of touchMs) for (const d of [-110, 0, 160]) plan.push({ ms: ms + d, band: 'touch' })
  for (let ms = shotMs - 320; ms <= shotMs + 340; ms += 80) plan.push({ ms, band: 'impact' })

  // 시퀀스를 **지금** 꽂는다. Match3D가 다음 rAF에서 클럭을 리셋하므로
  // 이 시점이 곧 t=0이다(오차 ≈ 한 프레임).
  await page.evaluate(() => window.__start())
  const startedAt = Date.now()
  const shot = async (idx, p) => {
    const wait = p.ms - (Date.now() - startedAt)
    if (wait > 0) await page.waitForTimeout(wait)
    const t = p.ms / DWELL
    const rel = Math.round(p.ms - shotMs)
    const name = `${TAG}-${p.band}-${String(idx).padStart(2, '0')}-t${t.toFixed(4)}-${rel >= 0 ? '+' : ''}${rel}ms.jpg`
    // 슈터 네임플레이트를 기준으로 **몸 전체가 들어오는 크롭**을 찍는다 — 와이드 프레임에서는
    // 발이 몇 픽셀이라 "발이 나갔는지"를 눈으로 확인할 수 없다.
    // 임팩트 국면은 카메라가 슈터+골문을 함께 물려고 뒤로 빠진다(movement의 striking 프레이밍).
    // 그래서 크롭 상자를 국면별로 다르게 잡는다 — 안 그러면 선수가 몇십 픽셀이 되어
    // "발이 나갔는지"를 볼 수 없다.
    const box = 220
    const clip = await page.evaluate((box) => {
      const el = [...document.querySelectorAll('.m3d-plate')].find(e => e.textContent.includes('선수16'))
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = r.x + r.width / 2, cy = r.y + r.height
      const w = box, h = box
      return {
        x: Math.max(0, Math.min(window.innerWidth - w, cx - w / 2)),
        y: Math.max(0, Math.min(window.innerHeight - h, cy - 20)),
        width: w, height: h,
      }
    }, box)
    const buf = clip
      ? await page.screenshot({ path: join(SHOTS, name), clip, type: 'jpeg', quality: 88 })
      : await canvas.screenshot({ path: join(SHOTS, name), type: 'jpeg', quality: 88 })
    const inDribble = spans.some(([s2, e2]) => t >= s2 && t < e2)
    out.frames.push({ i: idx, t: +t.toFixed(4), relMs: rel, band: p.band, file: name, inDribble, bytes: buf.length })
    console.log(`${name} ${p.band}${inDribble ? '/캐리' : ''}`)
  }
  for (let i = 0; i < plan.length; i++) await shot(i, plan[i])
  out.distinctBytes = new Set(out.frames.map(f => f.bytes)).size
} catch (e) {
  out.error = String(e)
  console.error(e)
} finally {
  await writeFile(join(ROOT, 'docs/audit', `${TAG}.json`), JSON.stringify(out, null, 2))
  await browser.close()
  await server.close()
}
console.log('logs:', logs.slice(0, 20).join('\n'))
