#!/usr/bin/env node
// 작전판·전술 센터 재설계 검증 — 주 CTA가 스크롤 없이 보이는가, 서브탭이 입력을 잃지
// 않는가, 잠긴 축이 이유와 함께 보이는가.
//
// 실제 Chrome(channel:'chrome', headless:false)로 돈다. 헤드리스는 rAF를 스로틀해
// 캔버스가 얼어붙고 그 정지 화면을 "3D가 죽었다"로 오진한 전례가 있다 —
// 캡처 직전마다 연속 프레임 픽셀 diff로 진행을 먼저 증명한다(6라운드 감사 관례).
//
// 사용: node tools/tactics-subtabs/verify.mjs [--w 1600 --h 900] [--root <경로>]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const REPO = resolve(import.meta.dirname, '../..')
const SHOTS = join(REPO, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
// 다른 갈래가 같은 트리를 동시에 고치는 중이라, 내 변경만 얹은 worktree를 띄울 수 있게 한다.
const ROOT = resolve(arg('root', REPO))
const TAG = `r10-tactics-${W}x${H}`

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
const notes = []
const say = s => { notes.push(s); console.log('  ' + s) }
page.on('pageerror', e => say(`[error] ${e.message}`))

async function proveMotion() {
  const c = page.locator('canvas').first()
  if ((await c.count()) === 0) return null
  const a = await c.screenshot().catch(() => null)
  if (!a) return null
  await page.waitForTimeout(220)
  const b = await c.screenshot().catch(() => null)
  if (!b) return null
  return a.length !== b.length || !a.equals(b)
}
async function shot(name) {
  const moving = await proveMotion()
  const path = join(SHOTS, `${TAG}-${name}.png`)
  await page.screenshot({ path })
  say(`${name}: 프레임진행=${moving === null ? 'n/a' : moving ? 'OK' : 'FAIL(정지)'} → ${path}`)
}

/** 이 선택자가 **지금 스크롤 위치에서** 뷰포트 안에 온전히 들어와 있는가.
 *  "스크롤하면 보인다"는 답이 아니다 — 사람이 멈추는 자리가 바로 그 지점이었다. */
async function ctaVisible(sel, label) {
  const r = await page.evaluate(({ sel, vh, vw }) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    // 이 요소를 실제로 가리는 것이 없는지도 본다(가려져 있으면 보이는 것이 아니다).
    const mid = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return {
      x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      inside: b.top >= 0 && b.left >= 0 && b.bottom <= vh + 1 && b.right <= vw + 1,
      hit: !!mid && (el === mid || el.contains(mid)),
      docScroll: document.documentElement.scrollTop,
    }
  }, { sel, vh: H, vw: W })
  if (!r) { say(`[CTA] ${label}: 없음 (${sel})`); return null }
  say(`[CTA] ${label}: rect=(${r.x},${r.y},${r.w}×${r.h}) 뷰포트안=${r.inside ? 'OK' : 'FAIL'} 가림없음=${r.hit ? 'OK' : 'FAIL'} 문서스크롤=${r.docScroll}`)
  return r
}

/** 가로 스크롤은 어느 폭에서도 결함이다(390에서 서브탭이 넘치면 여기서 잡힌다). */
async function hscroll(label) {
  const g = await page.evaluate(() => {
    const d = document.documentElement
    const rows = [...document.querySelectorAll('.tw-tabs, .tb-tabs, .tc-tabs')].map(e => ({
      c: e.className, over: e.scrollWidth - e.clientWidth,
    }))
    return { doc: d.scrollWidth - d.clientWidth, rows }
  })
  say(`[가로] ${label}: 문서 ${g.doc}px · ${g.rows.map(r => `${r.c.split(' ')[0]} ${r.over}px`).join(' · ') || '탭줄 없음'}`)
  return g
}

const click = async (name, timeout = 15000) =>
  page.getByRole('button', { name }).first().click({ timeout })
const clickIf = async (name, timeout = 2500) =>
  page.getByRole('button', { name }).first().click({ timeout }).then(() => true).catch(() => false)
const subtab = async label => {
  await page.locator('.tw-tab', { hasText: label }).first().click()
  await page.waitForTimeout(280)
}

/** 보드가 지금 그리고 있는 숫자들. 축을 만지기 전후로 비교해 "정말 움직였나"를 잰다. */
const boardGeom = () => page.evaluate(() => {
  const q = s => document.querySelector(s)
  const press = q('.an-team--home .an-press')
  const line = q('.an-team--home .an-line')
  const focus = q('.an-focus__fill')
  const root = q('.an-root')
  return {
    press: press?.getAttribute('width') ?? null,
    line: line?.getAttribute('x1') ?? null,
    focusY: focus?.getAttribute('y') ?? null,
    lanes: [...document.querySelectorAll('.an-lane')].map(e => e.getAttribute('d')).join('|').slice(0, 60),
    flow: root?.style.getPropertyValue('--an-flow') ?? null,
    dots: [...document.querySelectorAll('.pv-dot--home')].map(d => d.getAttribute('cx')).join(','),
    cap: q('.tb-cap')?.textContent ?? null,
  }
})

/** 축 하나를 만지고, 만지기 전 → 직후 → 정착 후를 **연속 프레임**으로 남긴다.
 *  정지 프레임 한 장으로는 "움직였다"를 증명할 수 없다. */
async function axisProbe(name, act) {
  // 작전판 도트는 라이브 무브먼트로 매 틱 미세하게 움직인다(shape.ts). 그 잡음을 먼저
  // 재 두지 않으면 "무엇이 이 조작 때문에 움직였나"를 가릴 수 없다.
  const gN = await boardGeom()
  await page.waitForTimeout(160)
  const g0 = await boardGeom()
  const noisy = Object.keys(g0).filter(k => gN[k] !== g0[k])
  await act()
  const g1 = await boardGeom()          // 도형은 그 프레임에 이미 도착해야 한다
  await page.waitForTimeout(120)
  const gMid = await boardGeom()        // 정착 전 — 캡션이 아직 없어야 한다
  await page.waitForTimeout(400)
  const g2 = await boardGeom()          // 정착 후 — 캡션 1회
  await shot(`10-axis-${name}`)
  await page.waitForTimeout(2200)
  const g3 = await boardGeom()          // 캡션은 스스로 사라진다
  const moved = Object.keys(g0).filter(k => k !== 'cap' && !noisy.includes(k) && g0[k] !== g1[k])
  say(`[축] ${name}: 이 조작으로 변한 도형=[${moved.join(', ') || '없음'}] (상시 잡음 축=[${noisy.join(', ') || '없음'}]) · 정착전 캡션=${gMid.cap ?? '없음'} · 정착후 캡션=${g2.cap ?? '없음'} · 2.2s 뒤=${g3.cap ?? '없음'}`)
  return { g0, g1, g2, g3 }
}

try {
  // ── 워룸(킥오프 전 전술 센터) ────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForTimeout(2200)
  await click('캠페인 시작')
  await page.waitForTimeout(1600)
  const hub = await page.getByRole('button').allInnerTexts()
  const entry = hub.find(t => /경기|시작|입장|출전|지휘|준비/.test(t))
  if (entry) await page.getByRole('button', { name: new RegExp(entry.split('\n')[0].trim()) }).first().click()
  await page.waitForTimeout(2000)

  say('── 전술 센터(킥오프 전) ──')
  await shot('01-warroom-lineup')
  await ctaVisible('.tc-head__go', '워룸 첫 화면 [킥오프]')
  await hscroll('워룸/라인업')

  await page.getByRole('tab', { name: '팀 전술' }).click()
  await page.waitForTimeout(400)
  await shot('02-warroom-team-orders')
  await ctaVisible('.tc-head__go', '워룸 팀 전술 탭')
  await hscroll('워룸/팀 전술')

  // 보드가 팀 전술 탭에 함께 서 있는가(사용자 지시) + 탭 크롬과 조작 영역의 면 구분.
  say(`[보드 상시] 워룸 팀 전술 탭 보드 = ${await page.locator('.tc-team__board .pv-root').count()}개 · 전술 레이어 = ${await page.locator('.an-team--home .an-line').count()}개`)
  const layers = await page.evaluate(() => {
    const bg = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : null }
    return { 탭줄: bg('.tw-tabs'), 본문: bg('.tw-panel'), 컨트롤: bg('.tx-btn'), 선택된탭: bg('.tw-tab--active') }
  })
  say(`[층 구분] ${JSON.stringify(layers)}`)

  // 슬라이더를 만지고 서브탭을 한 바퀴 돈 뒤 값이 남는지 본다.
  const line = page.getByRole('slider', { name: '라인' })
  await line.fill('81')
  const before = await line.inputValue()
  await subtab('태세')
  await shot('03-warroom-stance')
  say(`[보드 상시] 태세 탭 보드 = ${await page.locator('.tc-team__board .pv-root').count()}개`)
  await subtab('세트피스')
  await shot('04-warroom-setpiece')
  say(`[보드 상시] 세트피스 탭 보드 = ${await page.locator('.tc-team__board .pv-root').count()}개`)
  await hscroll('워룸/세트피스')
  // ── 축별 애니메이션 증명(워룸은 즉시 반영이라 엔진 값이 곧 보드 값이다) ──
  await subtab('태세')
  await axisProbe('멘탈리티', () => page.getByRole('button', { name: '매우 공격적' }).first().click())
  await axisProbe('그룹적극성', async () => {
    const g = page.getByRole('group', { name: '공격 적극성' })
    await g.getByRole('button', { name: '적극' }).click()
  })
  await axisProbe('공격패턴', () => page.getByRole('button', { name: '크로스' }).first().click())
  await subtab('세트피스')
  await axisProbe('코너루트', () => page.getByRole('button', { name: '코너 루트 니어' }).click())
  await axisProbe('페이즈대형', () => page.getByRole('button', { name: '공격 시 3-5-2' }).click())
  await subtab('지시')
  await axisProbe('압박', async () => { await page.getByRole('slider', { name: '압박' }).fill('95') })
  await axisProbe('공격방향', () => page.getByRole('button', { name: '좌측' }).first().click())
  await axisProbe('템포', async () => { await page.getByRole('slider', { name: '템포' }).fill('12') })

  const after = await page.getByRole('slider', { name: '라인' }).inputValue()
  say(`[입력 보존] 워룸 라인 슬라이더 ${before} → 서브탭 왕복 → ${after} : ${before === after ? 'OK' : 'FAIL'}`)
  say(`[잠금] 워룸 서브탭 잠금 표시 = ${await page.locator('.tw-tab__lock').count()}건(킥오프 전은 전원 소집이라 0이어야 한다)`)

  // 문서를 끝까지 내려도 헤더 CTA가 남는가(sticky 검증).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(400)
  await shot('05-warroom-scrolled')
  await ctaVisible('.tc-head__go', '워룸 최하단까지 스크롤 후 [킥오프]')
  await page.evaluate(() => window.scrollTo(0, 0))

  // ── 작전판 ────────────────────────────────────────────────
  await click('킥오프')
  await clickIf('입장 연출 건너뛰고 바로 킥오프', 20000)
  await page.waitForTimeout(1200)
  await clickIf('2x')

  let opened = false
  for (let step = 0; step < 160 && !opened; step++) {
    if ((await page.locator('.tb-root').count()) > 0) { opened = true; break }
    if ((await page.locator('.ms-report').count()) > 0) break
    // 감독 타임이 있으면 즉시 열어 계측 시간을 줄인다.
    if (step === 6 && await clickIf('감독 타임', 1200)) continue
    await page.waitForTimeout(700)
  }
  if (!opened) throw new Error('작전판이 열리지 않았다')
  await page.waitForTimeout(1200)
  await clickIf('감독 판단대로 간다', 2500) // 코치 회의 팝업이 있으면 닫는다
  await page.waitForTimeout(500)

  say('── 작전판(경기 중) ──')
  await shot('06-board-orders')
  await ctaVisible('.tb-head__go', '작전판 첫 화면 주 CTA')
  await hscroll('작전판/지시')
  say(`[CTA 라벨] ${await page.locator('.tb-head__go').innerText()}`)
  say(`[스코어] 헤더 스코어 유지 = ${(await page.locator('.tb-head__score').count()) > 0 ? 'OK' : 'FAIL'}`)

  const bLine = page.getByRole('slider', { name: '라인' })
  const had = await bLine.count()
  if (had) {
    const cur = Number(await bLine.inputValue())
    await bLine.fill(String(Math.min(100, cur + 12)))
    const b0 = await bLine.inputValue()
    say(`[미적용] 슬라이더 조작 후 지시 탭 배지 = "${await page.locator('.tw-tab__mark').first().innerText().catch(() => '없음')}"`)
    await subtab('태세')
    await shot('07-board-stance')
    say(`[미적용] 다른 탭 안내 = "${await page.locator('.tw-dirty').first().innerText().catch(() => '없음')}"`)
    await subtab('세트피스')
    await shot('08-board-setpiece')
    say(`[잠금] 세트피스 탭 라벨 = "${await page.locator('.tw-tab').nth(2).innerText()}"`)
    const pf = await page.locator('[aria-label="페이즈 포메이션"]').innerText().catch(() => '')
    say(`[잠금 사유] ${pf.split('\n').filter(l => l.includes('잠김')).join(' / ') || '(전원 소집 — 잠금 없음)'}`)
    await hscroll('작전판/세트피스')
    await subtab('지시')
    const b1 = await page.getByRole('slider', { name: '라인' }).inputValue()
    say(`[입력 보존] 작전판 라인 슬라이더 ${b0} → 서브탭 왕복 → ${b1} : ${b0 === b1 ? 'OK' : 'FAIL'}`)
  }

  // 작전판 본문을 끝까지 내려도 CTA가 남는가.
  await page.evaluate(() => {
    const r = document.querySelector('.tb-root')
    if (r) r.scrollTop = r.scrollHeight
    window.scrollTo(0, document.documentElement.scrollHeight)
  })
  await page.waitForTimeout(400)
  await shot('09-board-scrolled')
  await ctaVisible('.tb-head__go', '작전판 최하단까지 스크롤 후 주 CTA')
  say(`[푸터] 옛 .tb-foot 잔존 = ${await page.locator('.tb-foot').count()}건(0이어야 한다)`)
} catch (e) {
  say(`[실패] ${e.message}`)
} finally {
  await writeFile(join(SHOTS, `${TAG}-notes.txt`), notes.join('\n') + '\n')
  console.log(`\n노트 → ${join(SHOTS, `${TAG}-notes.txt`)}`)
  await browser.close()
  await server.close()
}
