#!/usr/bin/env node
// tools/sim-audit/live.mjs
// 3D 연출 4대 항목의 **실주행 연속 캡처**. 실제 Chrome(headless:false)을 몰아
// 하이라이트 장면을 프레임 단위로 이어 찍는다 — 정지 프레임 한 장으로는
// "공이 손에 붙어 있는가", "얼마나 멀리 빗나가는가"를 증명할 수 없다.
//
// ⚠ 헤드리스/백그라운드 탭은 rAF가 스로틀되어 캔버스가 얼어붙는다. 그래서
//    ① 실제 창을 띄우고 ② 연속 프레임 픽셀 diff로 진행을 먼저 증명한 뒤 계측한다.
//
// 장면 타게팅: MatchScreen이 `.ms-pitch-wrap[data-scene]`에 장면 키를 실어 준다
// (예: `H/wing.b/save.c/L1`). 시계가 아니라 이 값을 보고 원하는 마무리를 기다린다.
//
// 사용: node tools/sim-audit/live.mjs --tag after [--w 1600 --h 900] [--shots 14] [--gap 130]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const TAG = arg('tag', 'live')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
/** 한 장면에서 이어 찍을 프레임 수. */
const SHOTS_N = Number(arg('shots', 14))
/** 프레임 간격(ms). 캡처 자체가 100~200 ms를 먹으므로 실제 간격은 이보다 크다. */
const GAP = Number(arg('gap', 60))
/**
 * 장면 감지 후 버스트 시작까지의 대기(ms).
 *
 * 왜 처음부터 찍지 않나: 결정적 순간(슛 임팩트 → GK 접촉 → 여운)은 dwell의 55~85%
 * 구간이다(save dwell 8400 ms 기준 4.6~7.1 s). 앞에서부터 찍으면 캡처 오버헤드가
 * 누적돼 정작 접촉 프레임을 지나쳐 버린다(실측: 30프레임 × 260 ms가 12 s로 늘어 다음 분).
 */
const LEAD = Number(arg('lead', 4400))
/** 잡을 마무리 종류. */
const WANT = arg('want', 'save,save,miss,goal').split(',')

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

const seen = new Set()

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()

  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 30000 })
  const box = await canvas.boundingBox()

  // ── ① rAF가 실제로 도는지부터 증명한다 ──────────────────────────────
  let moved = 0
  let last = await canvas.screenshot()
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(120)
    const cur = await canvas.screenshot()
    if (cur.length !== last.length || !cur.equals(last)) moved++
    last = cur
  }
  console.log(`캔버스 ${box.width.toFixed(0)}×${box.height.toFixed(0)} (aspect ${(box.width / box.height).toFixed(3)}) · ` +
    `연속 프레임 변화 ${moved}/6 ${moved >= 5 ? 'OK' : 'FAIL(rAF 정지 의심)'}`)
  if (moved < 5) throw new Error('캔버스가 갱신되지 않는다 — 계측 무의미')

  // ── ② 원하는 마무리가 3D로 뜨는 순간을 잡아 연속 캡처 ────────────────
  const want = [...WANT]
  const deadline = Date.now() + Number(arg('budget', 260000))
  while (want.length > 0 && Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const el = document.querySelector('.ms-pitch-wrap')
      const clock = document.querySelector('.bc-scorebug__clock')?.textContent ?? ''
      return el ? { mode: el.dataset.mode, scene: el.dataset.scene ?? '', clock } : null
    })
    if (!info || info.mode !== '3d') { await page.waitForTimeout(90); continue }
    // 장면 키 `H/wing.b/save.c/L1` → 마무리 종류 `save`
    const finish = info.scene.split('/')[2]?.split('.')[0]
    const idx = want.indexOf(finish)
    // 같은 장면 키라도 **다른 분**이면 다른 사건이다 — 잡는/쳐내는 세이브는 분 해시로 갈리므로
    //   같은 키를 여러 번 잡아야 두 종류를 다 볼 수 있다.
    const key = `${info.scene}@${info.clock}`
    if (idx < 0 || seen.has(key)) { await page.waitForTimeout(90); continue }
    seen.add(key)
    want.splice(idx, 1)
    const slug = `${finish}-${seen.size}`
    console.log(`  ▶ ${info.scene} → ${slug} (대기 ${LEAD} ms → ${SHOTS_N}프레임 × ${GAP} ms)`)
    await page.waitForTimeout(LEAD)
    for (let f = 0; f < SHOTS_N; f++) {
      const path = join(SHOTS, `sim-${TAG}-${W}x${H}-${slug}-f${String(f).padStart(2, '0')}.png`)
      await canvas.screenshot({ path })
      await page.waitForTimeout(GAP)
    }
  }
  if (want.length > 0) console.log(`  (못 잡은 장면: ${want.join(',')})`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(SHOTS, `sim-${TAG}-${W}x${H}.log`), logs.join('\n'))
  await browser.close()
  await server.close()
}
