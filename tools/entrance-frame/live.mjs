#!/usr/bin/env node
// 입장 연출 · 하이라이트 **실주행 캡처** — 실제 Chrome(headless:false)을 몰아
// 랜딩 → 데모 → 킥오프 → 입장 연출 각 단계 + 경기 장면을 찍는다.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭에서는 rAF가 스로틀되어 캔버스가
// 얼어붙는다("3D가 정지했다"는 오진의 원인). 실제 창을 띄우고 **연속 프레임
// 픽셀 diff**로 진행이 실제로 일어나는지 먼저 증명한 뒤에 계측한다.
//
// 단계 동기화는 시계가 아니라 오버레이의 `data-phase`를 본다 — 페이지 로드·청크
// 다운로드 지연이 몇백 ms씩 흔들려서 고정 타임아웃으로는 매번 다른 단계를 찍는다.
//
// 사용: node tools/entrance-frame/live.mjs --tag after [--w 1600 --h 900] [--play 8]
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
const TAG = arg('tag', 'live')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const PLAYS = Number(arg('play', 8))

/**
 * 스토리보드 4컷 + 흩어짐. 단계 안 **어디를** 찍을지만 정하는 값이다(진짜 동기는
 * 오버레이의 `data-phase`가 잡는다). 소개 컷은 캐스트에 따라 길이가 변하므로
 * 고정 대기 대신 "단계 진입 후 n ms"로 잡는다.
 */
const PHASES = [
  ['tunnel', 900],
  ['walkout', 3000],
  ['split', 3600],
  ['home-intro', 9000],
  ['away-intro', 9000],
  ['disperse', 1100],
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
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

const shot = async name => {
  const path = join(SHOTS, `entrance-${TAG}-${W}x${H}-${name}.png`)
  await page.screenshot({ path })
  return path
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()

  // ── ① 캔버스가 실제로 갱신되는지부터 증명한다(rAF 스로틀 함정) ──
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 20000 })
  const box = await canvas.boundingBox()
  const a = await canvas.screenshot()
  await page.waitForTimeout(220)
  const b = await canvas.screenshot()
  const moving = a.length !== b.length || !a.equals(b)
  console.log(
    `캔버스 ${box.width.toFixed(0)}×${box.height.toFixed(0)} (aspect ${(box.width / box.height).toFixed(3)}) · ` +
      `프레임 진행 ${moving ? 'OK(픽셀 변화 있음)' : 'FAIL(정지)'}`,
  )
  if (!moving) throw new Error('캔버스가 정지했다 — 계측 무의미')

  // ── ② 입장 단계: data-phase가 바뀌는 순간을 잡아 단계 중반을 찍는다 ──
  for (const [name, ms] of PHASES) {
    await page.waitForFunction(
      p => document.querySelector('[data-testid="entrance-overlay"]')?.dataset.phase === p,
      name,
      { timeout: 30000 },
    )
    await page.waitForTimeout(ms)
    console.log(`  ${name} → ${await shot(name)}`)
  }

  // ── ③ 경기 장면: 골 드라마가 뜨면 즉시, 아니면 일정 간격으로 ──
  for (let i = 0; i < PLAYS; i++) {
    const drama = await page
      .locator('.ms-drama')
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (drama) console.log(`  goal-${i} → ${await shot(`goal-${i}`)}`)
    await page.waitForTimeout(3500)
    console.log(`  play-${i} → ${await shot(`play-${i}`)}`)
  }
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(SHOTS, `entrance-${TAG}-${W}x${H}.log`), logs.join('\n'))
  await browser.close()
  await server.close()
}
