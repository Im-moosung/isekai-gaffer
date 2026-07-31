#!/usr/bin/env node
// tools/discipline/run.mjs
// 경고 누적·출장정지 실측 — 8경기 캠페인을 여러 시드로 돌려
//   (1) 정지가 몇 번 발생하는가 (경고 누적 / 퇴장 별)
//   (2) 정지가 승률·득실에 얼마나 영향을 주는가 (정지 적용 ON/OFF 동일 시드 대조)
// 를 표로 찍는다. 테스트는 통과/실패만 말하지만 이 스크립트는 "얼마나"를 말한다.
//
// 사용:
//   node tools/discipline/run.mjs
//   node tools/discipline/run.mjs --seeds 200
//
// TS 모듈은 vite SSR 로더로 프로덕션 코드 그대로 불러온다(번들 사본을 재면 의미가 없다).
// Math.random·Date 미사용 — 전 과정이 시드 결정론이다.
import { createServer } from 'vite'

const seedCount = (() => {
  const i = process.argv.indexOf('--seeds')
  return i >= 0 ? Number(process.argv[i + 1]) : 120
})()

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { applyDiscipline } = await server.ssrLoadModule('/src/game/campaignStore.ts')
const { teamCardTally } = await server.ssrLoadModule('/src/game/playerStats.ts')

// campaignStore의 경로 테이블 미러(스토어는 zustand라 노드에서 바로 돌리기보다 표를 복제한다).
const GROUP = ['cze', 'mex', 'rsa']
const FIRST = { r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp' }
const SECOND = { r32: 'can', r16: 'mar', qf: 'fra', sf: 'esp', final: 'arg' }
const TOUR = ['r32', 'r16', 'qf', 'sf', 'final']

const kor = loadTeam('kor')

/** 한 경기 풀 시뮬. 홈(kor) 전술을 받아 90분을 돌리고 결과·카드·체력을 돌려준다. */
function playMatch(oppId, seed, tactics, staminaOverride, moraleOverride) {
  const away = loadTeam(oppId)
  const st0 = createMatch(kor, away, { seed, homeTactics: tactics })
  for (const [id, v] of Object.entries(staminaOverride)) {
    if (id in st0.home.staminaByPlayer) st0.home.staminaByPlayer[id] = v
  }
  for (const [id, v] of Object.entries(moraleOverride)) {
    if (id in st0.home.moraleByPlayer) st0.home.moraleByPlayer[id] = v
  }
  const st = simulateSegment(st0, 90)
  return {
    score: [st.score[0], st.score[1]],
    cards: teamCardTally(st.events, kor.id),
    stamina: { ...st.home.staminaByPlayer },
    morale: { ...st.home.moraleByPlayer },
  }
}

/** 승부차기 대용 — 토너먼트 무승부는 시드 파생 결정론 동전으로 가른다(엔진 shootout은
 *  키커 지정 UI가 필요해 헤드리스에서 재현 부담이 크다. 정지 영향 측정에는 중립이다). */
const tiebreak = (seed, stage) => ((seed * 7919 + stage.length * 31) % 2) === 0

/** 8경기 캠페인 1회. enforce=false면 정지를 적용하지 않는다(대조군). */
function runCampaign(seed, enforce) {
  let cautions = {}
  let bans = {}
  let fatigue = {}
  let morale = {}
  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0
  let played = 0
  const suspensionEvents = [] // { stage, playerId }
  const scores = [] // 경기별 [우리, 상대] — ON/OFF 대조에서 '몇 경기가 실제로 달라졌나'를 센다
  let reached = 'group3'

  const startStamina = id => (fatigue[id] === undefined ? 100 : Math.min(100, fatigue[id] + (100 - fatigue[id]) * 0.7))
  const startMorale = id => (morale[id] === undefined ? 70 : 70 + (morale[id] - 70) * 0.3)

  const stages = []
  for (let i = 0; i < 3; i++) stages.push({ stage: `group${i + 1}`, opp: GROUP[i] })

  let path = null
  let groupPts = 0, groupGd = 0

  for (let idx = 0; idx < stages.length; idx++) {
    const { stage, opp } = stages[idx]
    const suspended = enforce ? Object.keys(bans).filter(id => bans[id] > 0) : []
    for (const id of suspended) suspensionEvents.push({ stage, playerId: id })
    const tactics = pickBestXI(kor, undefined, suspended)
    const sOv = {}, mOv = {}
    for (const p of kor.squad) { sOv[p.id] = startStamina(p.id); mOv[p.id] = startMorale(p.id) }
    const r = playMatch(opp, seed * 31 + played, tactics, sOv, mOv)
    played++
    scores.push(r.score)
    gf += r.score[0]; ga += r.score[1]
    if (r.score[0] > r.score[1]) wins++
    else if (r.score[0] < r.score[1]) losses++
    else draws++

    fatigue = { ...fatigue, ...r.stamina }
    morale = { ...morale, ...r.morale }
    const next = applyDiscipline(cautions, bans, r.cards, stage)
    cautions = next.cautions; bans = next.bans

    if (stage.startsWith('group')) {
      groupPts += r.score[0] > r.score[1] ? 3 : r.score[0] === r.score[1] ? 1 : 0
      groupGd += r.score[0] - r.score[1]
    }

    if (stage === 'group3') {
      // 조 순위 근사: 승점 4 이상이면 1위, 3이면 2위, 그 미만은 탈락(스토어의 고정 표를 단순화).
      if (groupPts >= 5) path = 'first'
      else if (groupPts >= 3 || (groupPts >= 2 && groupGd >= 0)) path = 'second'
      else path = null
    }
  }

  if (path) {
    const table = path === 'first' ? FIRST : SECOND
    for (const stage of TOUR) {
      const suspended = enforce ? Object.keys(bans).filter(id => bans[id] > 0) : []
      for (const id of suspended) suspensionEvents.push({ stage, playerId: id })
      const tactics = pickBestXI(kor, undefined, suspended)
      const sOv = {}, mOv = {}
      for (const p of kor.squad) { sOv[p.id] = startStamina(p.id); mOv[p.id] = startMorale(p.id) }
      const r = playMatch(table[stage], seed * 31 + played, tactics, sOv, mOv)
      played++
      scores.push(r.score)
      gf += r.score[0]; ga += r.score[1]
      const won = r.score[0] > r.score[1] || (r.score[0] === r.score[1] && tiebreak(seed, stage))
      if (r.score[0] > r.score[1]) wins++
      else if (r.score[0] < r.score[1]) losses++
      else draws++

      fatigue = { ...fatigue, ...r.stamina }
      morale = { ...morale, ...r.morale }
      const next = applyDiscipline(cautions, bans, r.cards, stage)
      cautions = next.cautions; bans = next.bans
      reached = stage
      if (!won) break
      if (stage === 'final') break
    }
  }

  return { wins, draws, losses, gf, ga, played, suspensionEvents, reached, scores }
}

const on = []
const off = []
let changedMatches = 0
let changedRuns = 0
for (let s = 1; s <= seedCount; s++) {
  const a = runCampaign(s, true)
  const b = runCampaign(s, false)
  on.push(a); off.push(b)
  // 정지가 실제로 XI를 바꾼 경기 중 몇 경기가 다른 스코어로 끝났는가.
  const n = Math.min(a.scores.length, b.scores.length)
  for (let i = 0; i < n; i++) {
    if (a.scores[i][0] !== b.scores[i][0] || a.scores[i][1] !== b.scores[i][1]) changedMatches++
  }
  if (a.reached !== b.reached) changedRuns++
}

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0)
const rate = rows => sum(rows, 'wins') / sum(rows, 'played')

const suspTotal = sum(on, 'played') && on.reduce((a, r) => a + r.suspensionEvents.length, 0)
const campaignsWith = on.filter(r => r.suspensionEvents.length > 0).length
const byStage = {}
for (const r of on) for (const e of r.suspensionEvents) byStage[e.stage] = (byStage[e.stage] ?? 0) + 1

const pct = v => `${(v * 100).toFixed(1)}%`

console.log(`\n# 출장정지 실측 (시드 1..${seedCount}, 캠페인당 최대 8경기)\n`)
console.log(`| 지표 | 정지 적용(ON) | 미적용(OFF) |`)
console.log(`|---|---|---|`)
console.log(`| 총 경기 | ${sum(on, 'played')} | ${sum(off, 'played')} |`)
console.log(`| 승 | ${sum(on, 'wins')} | ${sum(off, 'wins')} |`)
console.log(`| 무 | ${sum(on, 'draws')} | ${sum(off, 'draws')} |`)
console.log(`| 패 | ${sum(on, 'losses')} | ${sum(off, 'losses')} |`)
console.log(`| 승률 | ${pct(rate(on))} | ${pct(rate(off))} |`)
console.log(`| 득점/경기 | ${(sum(on, 'gf') / sum(on, 'played')).toFixed(3)} | ${(sum(off, 'gf') / sum(off, 'played')).toFixed(3)} |`)
console.log(`| 실점/경기 | ${(sum(on, 'ga') / sum(on, 'played')).toFixed(3)} | ${(sum(off, 'ga') / sum(off, 'played')).toFixed(3)} |`)
console.log(`\n승률 차(ON-OFF): ${((rate(on) - rate(off)) * 100).toFixed(2)}pp`)
console.log(`스코어가 달라진 경기: ${changedMatches} · 도달 라운드가 달라진 캠페인: ${changedRuns}\n`)

console.log(`## 정지 발생`)
console.log(`- 정지로 결장한 연인원: **${suspTotal}명** (캠페인 ${seedCount}회, 총 ${sum(on, 'played')}경기)`)
console.log(`- 캠페인당 평균 ${(suspTotal / seedCount).toFixed(2)}명 · 경기당 ${(suspTotal / sum(on, 'played')).toFixed(3)}명`)
console.log(`- 정지가 한 번이라도 발생한 캠페인: **${campaignsWith}/${seedCount}** (${pct(campaignsWith / seedCount)})`)
console.log(`\n| 스테이지 | 결장 연인원 |`)
console.log(`|---|---|`)
for (const st of ['group1', 'group2', 'group3', ...TOUR]) {
  console.log(`| ${st} | ${byStage[st] ?? 0} |`)
}
console.log('')

await server.close()
