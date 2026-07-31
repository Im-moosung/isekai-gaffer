// docs/audit/shootout-drive.mjs
// 승부차기 실주행 하니스 — 토너먼트(32강) 무승부를 만들어 승부차기 전 과정을 캡처한다.
//
// 무엇을 조작하고 무엇을 조작하지 않는가(하니스의 정직성 경계):
//  - 조작: ① 캠페인 store를 "조별 통과 직후(32강)" 상태로 세팅 ② 풀타임 스코어를 1-1 동점으로 맞춤.
//          동점은 확률 사건이라 매 실행 재현이 불가능해 강제한다.
//  - 미조작: 승부차기 자체는 실제 UI·실제 엔진(simulateShootout)·실제 시드로 돈다.
//            캠페인 반영(recordResult)도 실제 경로(기자회견→신문→다음)를 그대로 탄다.
//
// 실행: node docs/audit/shootout-drive.mjs   (W/H/WARP/BASE 환경변수)
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { AUDIT } from './auditfn.mjs'

const ROOT = '/Users/moo/Projects/daker/MH_Soccer-Manager'
const SHOTS = `${ROOT}/docs/audit/shots`
const BASE = process.env.BASE || 'http://localhost:5175'
const W = +(process.env.W || 1440), H = +(process.env.H || 900)
const WARP = +(process.env.WARP || 24)
const FULLFLOW = process.env.FULLFLOW === '1'
fs.mkdirSync(SHOTS, { recursive: true })

const GROUP_PASS = [
  { stage: 'group1', opponentId: 'cze', score: [2, 1], decisions: [] },
  { stage: 'group2', opponentId: 'mex', score: [1, 1], decisions: [] },
  { stage: 'group3', opponentId: 'rsa', score: [2, 0], decisions: [] },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  colorScheme: 'light', locale: 'ko-KR',
})
// 90분 압축(drive2.mjs와 같은 방식).
// 승부차기 연출은 0.8초 간격이라 워프가 걸리면 캡처할 틈이 없다 —
// 원본 타이머를 남겨 두고 풀타임 도달 후 되돌린다.
await ctx.addInitScript(`(() => { const w=${WARP}; const st=window.setTimeout, si=window.setInterval;
  window.__unwarp = () => { window.setTimeout = st; window.setInterval = si; };
  window.setTimeout=(f,d,...a)=>st(f,Math.max(0,(d||0)/w),...a);
  window.setInterval=(f,d,...a)=>si(f,Math.max(1,(d||0)/w),...a); })();`)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 200)) })
page.on('response', r => { if (r.status() >= 400) errs.push(`http ${r.status()} ${r.url()}`) })

const R = { W, H, steps: {}, console: errs }
const tag = `shootout-${W}`
const snap = async (name, full = true) => {
  await page.screenshot({ path: `${SHOTS}/${tag}-${name}.png`, fullPage: full })
  const a = await page.evaluate(AUDIT)
  R.steps[name] = {
    shot: `${tag}-${name}.png`,
    overflowX: a.overflowX,
    overlaps: (a.overlaps || []).filter(o => !o.sticky),
    stickyOverlaps: (a.overlaps || []).filter(o => o.sticky).length,
    hidScroll: a.hidScroll, lowContrast: a.lowContrast, clippedLH: a.clippedLH, tinyTap: a.tinyTap,
    text: (await page.evaluate(() => document.body.innerText)).slice(0, 900),
  }
  console.log(`shot ${name} overflowX=${a.overflowX} overlaps=${R.steps[name].overlaps.length} low=${(a.lowContrast || []).length}`)
}
const clickText = async (t, nth = 0) => {
  const r = await page.evaluate(([t, nth]) => {
    const els = [...document.querySelectorAll('button,a,[role=button],[role=tab]')]
      .filter(e => e.textContent.trim().includes(t) && e.offsetParent !== null)
    if (!els[nth]) return 'MISS:' + t
    els[nth].click(); return 'OK:' + els[nth].textContent.trim().slice(0, 24)
  }, [t, nth])
  await page.waitForTimeout(350)
  return r
}
const clickAny = async (cands, nth = 0) => {
  for (const t of cands) { const r = await clickText(t, nth); if (r.startsWith('OK')) return r }
  return 'MISS-ALL:' + cands.join('|')
}

await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
console.log(await clickText('캠페인'))
await page.waitForTimeout(400)
// 조별 통과 직후(32강) 상태 주입.
await page.evaluate(async st => {
  const recs = st.recs
  const m = await import('/src/game/campaignStore.ts')
  m.useCampaignStore.setState({
    stage: 'r32', groupRank: 1, path: 'first', records: recs,
    ...(st.seed ? { seed: st.seed } : {}),
  })
}, { recs: GROUP_PASS, seed: +(process.env.SEED || 0) })
await page.waitForTimeout(600)
console.log('hub:', await clickAny(['준비하기', '경기 준비', '준비']))
await page.waitForTimeout(700)
console.log('kickoff:', await clickAny(['킥오프']))
await page.waitForTimeout(3000)
await clickText('2x')

// 풀타임까지 진행. 도중 브레이크·하프타임은 확정 버튼으로 넘긴다.
let full = false
for (let i = 0; i < 200; i++) {
  await page.waitForTimeout(600)
  const txt = await page.evaluate(() => document.body.innerText)
  if (/경기 종료/.test(txt) && /결과 확정|승부차기로|다시 보기/.test(txt)) { full = true; break }
  if (/전술 확정/.test(txt)) { await clickText('전술 확정'); continue }
  if (/후반 시작|후반전 시작/.test(txt)) { await clickAny(['후반 시작', '후반전 시작']); continue }
  if (/하프타임/.test(txt)) { await clickAny(['후반 시작', '확정', '계속']); continue }
}
if (!full) throw new Error('풀타임 도달 실패')
await page.evaluate(() => window.__unwarp?.()) // 승부차기부터는 실시간으로 본다
await snap('01-fulltime-raw')

// 동점 강제 — 이 한 줄만 조작이다(무승부는 확률 사건이라 재현 불가).
await page.evaluate(async () => {
  const m = await import('/src/game/matchStore.ts')
  const s = m.useMatchStore.getState()
  m.useMatchStore.setState({ engine: { ...s.engine, score: [1, 1] } })
})
await page.waitForTimeout(500)
await snap('02-fulltime-draw')

console.log('승부차기로:', await clickAny(['승부차기로']))
await page.waitForTimeout(500)
await snap('03-shootout-setup')

// 키커 후보 목록 점검 — 정지·퇴장 선수가 남아 있는지 본다.
R.kickerAudit = await page.evaluate(async () => {
  const cs = await import('/src/game/campaignStore.ts')
  const ms = await import('/src/game/matchStore.ts')
  const st = ms.useMatchStore.getState()
  const eng = st.engine
  const sel = document.querySelector('.so-slot__pick')
  const options = sel ? [...sel.options].map(o => o.textContent.trim()) : []
  const name = id => (eng.home.team.squad.find(p => p.id === id) || {}).name?.ko ?? id
  const onPitch = eng.home.tactics.lineup.map(l => l.playerId)
  const sentOff = eng.home.sentOff
  const eligible = onPitch.filter(id => !sentOff.includes(id))
  // 규정상 자격 없는 후보 = 후보에는 있는데 종료 시점 그라운드에 없던 선수
  const selected = [...document.querySelectorAll('.so-slot__pick')].map(s => s.value)
  return {
    optionCount: options.length,
    bans: cs.useCampaignStore.getState().bans,
    onPitch: onPitch.map(id => `${id}:${name(id)}`),
    sentOff: sentOff.map(id => `${id}:${name(id)}`),
    eligibleCount: eligible.length,
    ineligibleOptions: options.length - eligible.filter(id => {
      const p = eng.home.team.squad.find(x => x.id === id)
      return p && p.position !== 'GK'
    }).length,
    selectedDefault: selected.map(id => `${id}:${name(id)}` + (eligible.includes(id) ? '' : ' ← 그라운드에 없음')),
    selectedIneligible: selected.filter(id => !eligible.includes(id)).map(id => `${id}:${name(id)}`),
    subs: (eng.events || []).filter(e => e.type === 'sub' && e.teamId === eng.home.team.id)
      .map(e => `${e.minute}' in=${name(e.playerId)} ${e.detail}`),
    reds: (eng.events || []).filter(e => e.type === 'red' && e.teamId === eng.home.team.id)
      .map(e => `${e.minute}' ${name(e.playerId)}`),
  }
})

// 방향 세그먼트 조작이 먹는가. NOEDIT=1이면 건너뛴다(기본 키커·방향 그대로 돌려야
// 오프라인으로 예측한 시드가 그대로 재현된다 — 서든데스 캡처용).
const EDIT = process.env.NOEDIT !== '1'
if (EDIT) {
R.dirToggle = await page.evaluate(() => {
  const segs = document.querySelectorAll('.so-slot .seg')
  if (!segs.length) return 'NO-SEG'
  const before = [...segs[0].querySelectorAll('button')].map(b => b.getAttribute('aria-pressed'))
  segs[0].querySelectorAll('button')[2].click()
  return { before }
})
await page.waitForTimeout(200)
R.dirAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.so-slot .seg')[0].querySelectorAll('button')].map(b => b.getAttribute('aria-pressed')))
// 키커 슬롯 교환이 먹는가(중복 방지).
R.swap = await page.evaluate(() => {
  const sels = [...document.querySelectorAll('.so-slot__pick')]
  const before = sels.map(s => s.value)
  sels[0].value = before[3]
  sels[0].dispatchEvent(new Event('change', { bubbles: true }))
  return { before }
})
await page.waitForTimeout(250)
R.swapAfter = await page.evaluate(() => [...document.querySelectorAll('.so-slot__pick')].map(s => s.value))
await snap('04-shootout-setup-edited')
}

console.log('시작:', await clickAny(['승부차기 시작']))
// 킥 공개(0.8초 간격)를 단계별로 캡처. 킥 수 변화를 추적해 전 과정을 남긴다.
R.kickTrace = []
let last = -1
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(200)
  const s = await page.evaluate(() => {
    const panel = document.querySelector('.so-panel')
    if (!panel) return null
    return {
      n: document.querySelectorAll('.so-kick').length,
      score: (document.querySelector('.so-panel .ms-final__score') || {}).textContent || '',
      rows: [...document.querySelectorAll('.so-kick')].map(k => k.innerText.replace(/\n/g, ' ')),
    }
  })
  if (!s) break
  if (s.n !== last) {
    last = s.n
    R.kickTrace.push({ n: s.n, score: s.score, rows: s.rows })
    if (s.n === 1) await snap('05-shootout-kick1')
    if (s.n === 5) await snap('06-shootout-mid')
    R.lastRows = s.rows
    R.lastScore = s.score
  }
  R.kicksAtEnd = s.n
  // 전부 공개되면 승패 문구 + [계속]이 뜬다(자동 진행 없음).
  const verdict = await page.evaluate(() => {
    const v = document.querySelector('.so-verdict')
    return v ? v.innerText.replace(/\n/g, ' / ') : null
  })
  if (verdict) {
    R.verdict = verdict
    await snap('06b-shootout-verdict')
    console.log('verdict:', verdict)
    await clickAny(['계속'])
    break
  }
}
// 마지막 킥이 공개된 직후 화면(onDone 직전)은 위 루프의 마지막 스냅으로 남긴다.
if (R.lastRows) R.finalBoard = { score: R.lastScore, rows: R.lastRows }
await page.waitForTimeout(400)
await snap('07-after-shootout')

R.storeAfter = await page.evaluate(async () => {
  const cs = await import('/src/game/campaignStore.ts')
  const s = cs.useCampaignStore.getState()
  return { stage: s.stage, records: s.records, ending: s.ending }
})

if (FULLFLOW) {
  // 기자회견 3문항 → 신문 → 다음 → 캠페인 반영 확인.
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500)
    const txt = await page.evaluate(() => document.body.innerText)
    if (/일간 축구|다음/.test(txt) && /대체역사|FICTION/.test(txt)) break
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.pc-choice,button')].filter(e => e.offsetParent && /^[^<]{4,}$/.test(e.textContent.trim()))
      const cand = b.find(e => e.className.includes('pc-') || e.closest('.pc-root'))
      if (cand) { cand.click(); return cand.textContent.trim().slice(0, 30) }
      return null
    })
    if (!clicked) break
  }
  await snap('08-press-or-paper')
  await clickAny(['다음'])
  await page.waitForTimeout(900)
  await snap('09-back-to-hub')
  R.storeAfterNext = await page.evaluate(async () => {
    const cs = await import('/src/game/campaignStore.ts')
    const s = cs.useCampaignStore.getState()
    return { stage: s.stage, lastRecord: s.records[s.records.length - 1], ending: s.ending }
  })
}

await browser.close()
fs.writeFileSync(`${ROOT}/docs/audit/shootout-audit-${W}.json`, JSON.stringify(R, null, 2))
console.log('wrote docs/audit/shootout-audit-' + W + '.json')
