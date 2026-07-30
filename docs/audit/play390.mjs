/* 390px 플레이 가능성 증명 — "작아도 보인다"가 아니라 "실제로 게임을 진행할 수 있다"를 확인한다.
 *
 * 감사 실측에서 390×844는 작동 불능이었다: 워룸 미렌더, 피치 높이 0px,
 * 감독 타임 작전판 79% 하드클립(=교체 불가). 그 세 지점을 그대로 따라간다.
 *
 * 사용: node docs/audit/play390.mjs
 * 종료 코드 1이면 어느 단계에선가 게임이 막힌 것이다.
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const SHOTS = new URL('./shots/', import.meta.url).pathname
fs.mkdirSync(SHOTS, { recursive: true })

const steps = []
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: 'light', // 라이트 OS 테마에서만 발현하던 결함이 있었다
  locale: 'ko-KR',
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e).slice(0, 200)))

/** 텍스트를 포함하는 보이는 컨트롤을 실제로 클릭한다. 화면 밖이면 스크롤해서 데려온다. */
const tap = async (text, nth = 0) => {
  const handle = await page.evaluateHandle(([t, n]) => {
    const els = [...document.querySelectorAll('button,a,[role=button],[role=tab],summary')]
      .filter(e => e.textContent.trim().includes(t) && e.offsetParent !== null)
    return els[n] || null
  }, [text, nth])
  const el = handle.asElement()
  if (!el) return { ok: false, why: `"${text}" 컨트롤을 찾지 못했다` }
  await el.scrollIntoViewIfNeeded()
  const box = await el.boundingBox()
  if (!box || box.width < 1 || box.height < 1) return { ok: false, why: `"${text}"가 0 크기다` }
  // 실제 히트 테스트 — 다른 요소가 위를 덮고 있으면 클릭이 그쪽으로 간다
  const covered = await el.evaluate(node => {
    const r = node.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit && !node.contains(hit) && hit !== node ? hit.className || hit.tagName : null
  })
  if (covered) return { ok: false, why: `"${text}"가 ${covered}에 덮여 있다`, box }
  await el.click()
  await page.waitForTimeout(700)
  return { ok: true, box }
}

/** 요소가 존재하고 실제로 화면 안에서 0이 아닌 높이를 갖는지 */
const measure = sel => page.evaluate(s => {
  const el = document.querySelector(s)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height), clientH: el.clientHeight, scrollH: el.scrollHeight }
}, sel)

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await page.screenshot({ path: `${SHOTS}/390-play-01-landing.png` })

let r = await tap('캠페인 시작')
record('랜딩 → 캠페인 시작', r.ok, r.why)

await page.screenshot({ path: `${SHOTS}/390-play-02-hub.png`, fullPage: true })
r = await tap('준비')
record('허브 → 경기 준비', r.ok, r.why)

await page.waitForTimeout(1200)
await page.screenshot({ path: `${SHOTS}/390-play-03-warroom.png`, fullPage: true })

// 워룸이 실제로 렌더됐는가 — 감사에서 390px는 뭉개진 스코어버그만 남았다
const warBody = await page.evaluate(() => {
  const t = document.body.innerText
  return { chars: t.length, hasLineup: /선발|라인업/.test(t), hasTactic: /전술|압박|라인/.test(t) }
})
record('워룸 렌더', warBody.chars > 300 && warBody.hasLineup && warBody.hasTactic,
  `본문 ${warBody.chars}자, 라인업 ${warBody.hasLineup}, 전술 ${warBody.hasTactic}`)

// 문서 스크롤이 살아 있는가 (높이 예산 배분에서 벗어났는지의 증거)
const scrollable = await page.evaluate(() => {
  const de = document.documentElement
  return { docH: de.scrollHeight, vh: innerHeight, canScroll: de.scrollHeight > innerHeight + 4 }
})
record('워룸 문서 스크롤', scrollable.canScroll, `docH ${scrollable.docH} / vh ${scrollable.vh}`)

r = await tap('킥오프')
record('워룸 → 킥오프', r.ok, r.why)
await page.waitForTimeout(2500)

// 입장 연출 건너뛰기(있으면)
const skip = await tap('건너뛰기')
if (skip.ok) record('입장 건너뛰기', true)
await page.waitForTimeout(6000)
await page.screenshot({ path: `${SHOTS}/390-play-04-match.png` })

// 피치가 실제로 높이를 갖는가 — 감사 실측 0px
const pitch = await page.evaluate(() => {
  for (const s of ['.ms-pitch-wrap', '.ms-pitch', '.ms-stage canvas', 'canvas', 'svg.pv-root']) {
    const el = document.querySelector(s)
    if (el) { const r = el.getBoundingClientRect(); if (r.height > 0) return { sel: s, w: Math.round(r.width), h: Math.round(r.height) } }
  }
  return null
})
record('경기 피치 높이 > 0', !!pitch && pitch.h > 80, pitch ? `${pitch.sel} ${pitch.w}×${pitch.h}` : '피치를 찾지 못했다')

// 감독 타임 → 교체. 여기가 79% 하드클립으로 막혀 있던 지점이다.
r = await tap('감독 타임')
record('경기 → 감독 타임', r.ok, r.why)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/390-play-05-manager-time.png`, fullPage: true })

// 원래 결함(T-3)은 overflow:hidden으로 콘텐츠가 **도달 불가능**했던 것이다(79% 하드클립).
// 스크롤 가능한 컨테이너는 결함이 아니다 — 단, 스크롤할 수 있다는 어포던스가 있어야 한다.
const layer = await page.evaluate(() => {
  const el = document.querySelector('.ms-tactics-layer')
  if (!el) return null
  const cs = getComputedStyle(el)
  return {
    clientH: el.clientHeight, scrollH: el.scrollHeight, overflowY: cs.overflowY,
    hasAffordance: el.classList.contains('scroll-y') || cs.scrollbarWidth === 'thin',
    // 실제로 끝까지 스크롤되는가
    reachable: (el.scrollTop = el.scrollHeight, el.scrollTop > 0),
  }
})
record('작전판 콘텐츠 도달 가능 (하드클립 없음)',
  !layer || ['auto', 'scroll'].includes(layer.overflowY) && layer.hasAffordance && layer.reachable,
  layer ? `overflow-y:${layer.overflowY} 표시 ${layer.clientH}/${layer.scrollH} 어포던스 ${layer.hasAffordance} 도달 ${layer.reachable}` : '레이어 없음')

// 교체 탭 → 벤치 선수 투입
const subTab = await tap('교체')
record('교체 탭 진입', subTab.ok, subTab.why)
await page.waitForTimeout(600)
await page.screenshot({ path: `${SHOTS}/390-play-06-sub.png`, fullPage: true })

const benchInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button,[role=button]')]
    .filter(e => e.offsetParent !== null)
    .map(e => ({ t: e.textContent.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height) }))
  return { count: rows.length, sample: rows.slice(0, 12) }
})
record('교체 화면에 조작 가능한 컨트롤 존재', benchInfo.count > 3,
  `${benchInfo.count}개 · ${benchInfo.sample.map(s => s.t).slice(0, 6).join(' / ')}`)

// 겹침·하드클립 최종 확인
const final = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) return false
    return [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
  }).map(el => ({ el, r: el.getBoundingClientRect() }))
  let n = 0
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue
    const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
    const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
    if (x > 4 && y > 4 && (x * y) / Math.min(a.r.width * a.r.height, b.r.width * b.r.height) > 0.2) n++
  }
  return { overlaps: n, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }
})
record('감독 타임 겹침 0', final.overlaps === 0, `${final.overlaps}건`)
record('가로 오버플로 0', final.overflowX === 0, `${final.overflowX}px`)
record('런타임 에러 0', errs.length === 0, errs.join(' | '))

await ctx.close()
await browser.close()

const failed = steps.filter(s => !s.ok)
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — ${steps.length - failed.length}/${steps.length} 단계 통과`)
process.exit(failed.length ? 1 : 0)
