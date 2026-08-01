#!/usr/bin/env node
// 제어 pod 축소 실측 + 설정 팝업 · 쿨다운 알림 · 선수 비교 팝업 육안 감사.
//
// 실제 Chrome(channel:'chrome', headless:false)을 몰아 재생시킨다. 헤드리스/백그라운드
// 탭은 rAF가 정지해 안무가 얼어붙으므로, 캡처 전에 **연속 프레임 픽셀 diff**로 화면이
// 실제로 진행 중임을 먼저 증명한다(tools/moment-sync·commentary-sync와 같은 규약).
//
// 두 리비전을 같은 자로 재기 위해 --root로 스냅샷 디렉터리를 받는다:
//   node tools/hud-shrink/live.mjs --root <before-worktree> --tag before
//   node tools/hud-shrink/live.mjs --root .                 --tag after
//
// 측정 순서는 **되돌릴 수 없는 조작을 뒤로** 민다. 개입을 한 번 쓰면 쿨다운이 걸리고
// 잔량이 줄어 이후의 화면이 달라지기 때문에, 비교 팝업 같은 관찰은 그 전에 끝낸다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const ROOT = resolve(arg('root', resolve(import.meta.dirname, '../..')))
const OUT = resolve(import.meta.dirname, '../..', 'docs/audit/shots')
const TAG = arg('tag', 'after')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))

const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer(); s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error',
})
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome', headless: false, args: [`--window-size=${W + 40},${H + 120}`],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
page.on('pageerror', e => console.error('[pageerror]', e.message))

const report = { tag: TAG, root: ROOT, viewport: [W, H] }

// ★ 계측은 **UI 경로만** 쓴다. page.evaluate에서 `import('/src/game/matchStore.ts')`로
// store를 잡아 보려 했지만 앱과 다른 모듈 인스턴스가 잡혔다(실측: phase가 'pre'로 나왔다).
// 앱 코드에 계측용 전역 훅을 심는 것은 금지이므로, 정지가 필요한 관찰은 **하이드레이션
// 브레이크를 실제로 기다린다** — 유저가 타는 경로 그대로이기도 하다.

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
await page.getByRole('button', { name: '바로 지휘하기' }).click()
await page.locator('.ms-root').waitFor({ timeout: 20000 })
await page.getByRole('button', { name: '킥오프' }).click()
await page.getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' }).click({ timeout: 20000 })
await page.waitForTimeout(2500)

// ── 프레임 진행 증명 ────────────────────────────────────────────────
async function proveMotion(label) {
  const shots = []
  for (let i = 0; i < 3; i++) {
    shots.push(await page.locator('.ms-pitch-wrap').screenshot())
    await page.waitForTimeout(220)
  }
  let diff = 0
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1], b = shots[i]
    if (a.length !== b.length) { diff += Math.abs(a.length - b.length); continue }
    for (let k = 0; k < a.length; k += 97) if (a[k] !== b[k]) diff++
  }
  report[`motion_${label}`] = diff
  console.log(`[motion:${label}] 연속 프레임 차이 ${diff} (0이면 정지 — 계측 무효)`)
  if (diff === 0) throw new Error(`화면이 진행하지 않는다(${label})`)
}
await proveMotion('play')

// ── ① 제어 pod가 차지하는 픽셀 ──────────────────────────────────────
const podBox = () => page.evaluate(() => {
  const el = document.querySelector('.ms-controls')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    w: Math.round(r.width), h: Math.round(r.height), area: Math.round(r.width * r.height),
    items: el.querySelectorAll(':scope > *').length,
    text: el.textContent.replace(/\s+/g, ' ').trim(),
  }
})
report.pod = await podBox()
console.log('[pod]', JSON.stringify(report.pod))
await page.screenshot({ path: join(OUT, `r10-hud-${TAG}-bar.png`), clip: { x: W - 1000, y: 0, width: 1000, height: 200 } })

// ── ② 설정 팝업(after 전용 — before에는 톱니가 없다) ────────────────
const gear = page.getByRole('button', { name: '설정' })
if (await gear.count()) {
  await gear.click()
  await page.locator('[role="dialog"]').waitFor({ timeout: 5000 })
  report.sheet = await page.evaluate(() => {
    const d = document.querySelector('.ms-set__sheet')
    const r = d.getBoundingClientRect()
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      inViewport: r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 && r.left >= -1,
      labels: [...d.querySelectorAll('.ms-set__label')].map(e => e.textContent),
      focusOnOpen: document.activeElement?.textContent ?? null,
    }
  })
  console.log('[sheet]', JSON.stringify(report.sheet))
  await page.screenshot({ path: join(OUT, `r10-hud-${TAG}-settings.png`), clip: { x: W - 700, y: 0, width: 700, height: 400 } })
  await page.keyboard.press('Escape')
  report.escClosed = (await page.locator('[role="dialog"]').count()) === 0
  report.focusBack = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  console.log('[esc]', report.escClosed, '[focus-back]', report.focusBack)
}

// ── ③ 선수 비교 팝업 ────────────────────────────────────────────────
// 자유 개입을 쓰지 않는 정지(하이드레이션·하프타임)에서 두 번 잰다.
//  · 하이드레이션(≈22') — 아직 체력이 높아 상태 칩이 거의 없다(느슨한 조건).
//  · 하프타임(45')      — 체력이 떨어져 칩이 붙는다. 사용자가 캡처한 것이 이 상태이고,
//    칩이 이름과 같은 줄에서 폭을 다투던 것이 `손...` 절단의 실제 원인이다.
await page.getByRole('button', { name: '2x' }).click() // 대기 단축

/** 작전판은 코치 회의 팝업이 열린 채로 뜬다 — 보드를 덮으므로 먼저 닫는다. */
async function closeCoachPop() {
  const close = page.getByRole('button', { name: '코치 회의 닫기' })
  if (await close.count()) await close.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
}

async function measureCompare(label) {
  await closeCoachPop()
  const dots = page.locator('.tb-board__pitch .pv-dotg--click')
  if (await dots.count() < 10) return null
  await dots.nth(9).click()
  await dots.nth(4).click()
  await page.locator('.tb-pop--cmp .cmp').waitFor({ timeout: 5000 })
  await page.waitForTimeout(400)
  const m = await page.evaluate(() => {
    const pop = document.querySelector('.tb-pop--cmp')
    const cmp = pop.querySelector('.cmp')
    const pr = pop.getBoundingClientRect()
    const cut = [...cmp.querySelectorAll('.cmp__name, .cmp__label, .cmp__readout, .cmp__verdict, .cmp__ctx-text')]
      .filter(e => e.scrollWidth > e.clientWidth + 1)
      .map(e => ({ cls: e.className, text: e.textContent, sw: e.scrollWidth, cw: e.clientWidth }))
    const outside = [...cmp.querySelectorAll('*')].filter(e => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && (r.right > pr.right + 1 || r.left < pr.left - 1)
    }).map(e => String(e.className))
    // 요소끼리 실제로 겹치는가 — 머리 두 칸과 가운데 맥락이 서로를 뚫는지 본다.
    const boxes = [...cmp.querySelectorAll('.cmp__head, .cmp__ctx')].map(e => e.getBoundingClientRect())
    let overlaps = 0
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const x = boxes[i], y = boxes[j]
        if (x.right > y.left + 1 && y.right > x.left + 1 && x.bottom > y.top + 1 && y.bottom > x.top + 1) overlaps++
      }
    }
    const nameW = [...cmp.querySelectorAll('.cmp__name')].map(e => Math.round(e.getBoundingClientRect().width))
    return {
      popW: Math.round(pr.width),
      headline: (cmp.querySelector('.cmp__readout') ?? cmp.querySelector('.cmp__verdict'))?.textContent ?? null,
      names: [...cmp.querySelectorAll('.cmp__name')].map(e => e.textContent),
      nameW,
      chips: cmp.querySelectorAll('.sx__chip').length,
      truncated: cut.length, cut,
      outsideCount: outside.length, outside: outside.slice(0, 8),
      overlaps,
    }
  })
  console.log(`[compare:${label}]`, JSON.stringify(m))
  await page.locator('.tb-pop--cmp').screenshot({ path: join(OUT, `r10-hud-${TAG}-compare-${label}.png`) })
  return m
}

report.compare = {}
console.log('[wait] 하이드레이션 브레이크…')
await page.locator('.ms-tactics-layer').waitFor({ timeout: 180000 })
await page.waitForTimeout(1200)
report.compare.hydration = await measureCompare('hydration')
await page.getByRole('button', { name: /전술 확정|후반 시작/ }).first().click()
await page.waitForTimeout(1800)
await proveMotion('resume')

console.log('[wait] 하프타임…')
await page.locator('.tb-head__reason, .ms-tactics-layer').first().waitFor({ timeout: 180000 })
await page.getByRole('button', { name: '후반 시작' }).waitFor({ timeout: 180000 })
await page.waitForTimeout(1000)
report.compare.halftime = await measureCompare('halftime')
await page.getByRole('button', { name: '후반 시작' }).click()
await page.waitForTimeout(1800)
await proveMotion('secondhalf')

// ── ④ 쿨다운 알림 — 실제로 한 번 써서 쿨다운을 만든 뒤 막힌 버튼을 누른다 ──
const timeBtn = page.locator('.ms-controls button', { hasText: '감독 타임' })
await timeBtn.click()
await page.locator('.ms-tactics-layer').waitFor({ timeout: 8000 })
await closeCoachPop()
await page.getByRole('button', { name: /전술 확정|후반 시작/ }).first().click()
await page.waitForTimeout(1800)
report.ringVisible = (await page.locator('.ms-controls .sb-ring').count()) > 0
// ★ 쿨다운 중 pod가 **가장 큰** 상태다 — 예전에는 사유 문장이 여기서 상시로 붙었다.
//   사용자가 캡처한 것도 이 상태이므로, 축소량은 이 값으로 재는 것이 정직하다.
report.podCooling = await podBox()
console.log('[pod:cooling]', JSON.stringify(report.podCooling))
await page.screenshot({ path: join(OUT, `r10-hud-${TAG}-cooling.png`), clip: { x: W - 1000, y: 0, width: 1000, height: 240 } })

await timeBtn.click({ force: true })
await page.locator('.ms-notice').waitFor({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(500) // 등장 애니메이션(tt-banner-pop)이 끝난 뒤에 찍는다
report.notice = (await page.locator('.ms-notice').count()) ? await page.locator('.ms-notice').textContent() : null
console.log('[notice]', report.notice ?? '(없음 — 이 리비전에는 알림 레이어가 없다)')
if (report.notice) {
  await page.screenshot({ path: join(OUT, `r10-hud-${TAG}-notice.png`), clip: { x: W - 1000, y: 0, width: 1000, height: 300 } })
  await page.waitForTimeout(4200)
  report.noticeGone = (await page.locator('.ms-notice').count()) === 0
  console.log('[notice-gone]', report.noticeGone)
}

// ── ⑤ 순간 제안 — 자원(쿨다운)이 없을 때 [사용]이 붙는가 ──────────────
// 쿨다운이 도는 동안(10 경기분) 자연 발생하는 순간 제안을 기다린다 — 뜨면 그때
// [사용] 버튼이 붙는지 본다. 자원이 없으므로 붙으면 안 된다.
await page.locator('.ms-banner--moment').first().waitFor({ timeout: 45000 }).catch(() => {})
report.momentBlocked = await page.evaluate(() => {
  const b = document.querySelector('.ms-banner')
  if (!b) return null
  return {
    text: b.textContent.replace(/\s+/g, ' ').trim(),
    hasUseButton: [...b.querySelectorAll('button')].some(x => x.textContent.trim() === '사용'),
    info: b.classList.contains('ms-banner--info'),
  }
})
console.log('[moment:blocked]', JSON.stringify(report.momentBlocked))
if (report.momentBlocked) {
  await page.screenshot({ path: join(OUT, `r10-hud-${TAG}-moment.png`), clip: { x: W / 2 - 420, y: 90, width: 840, height: 220 } })
}

await writeFile(join(OUT, `r10-hud-${TAG}.json`), JSON.stringify(report, null, 2))
console.log(`→ docs/audit/shots/r10-hud-${TAG}.*`)
await browser.close(); await server.close()
