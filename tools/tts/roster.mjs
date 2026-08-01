#!/usr/bin/env node
// tools/tts/roster.mjs
// **이름이 실제로 발화되는 선수**를 실측한다. TTS 클립을 몇 개 구워야 하는지가
// 이 숫자에서 나온다 — 312명(12팀×26)을 다 구우면 요청이 폭발하므로 추측이 아니라
// 시뮬레이션으로 센다.
//
// 세는 경로는 셋이다(런타임이 실제로 발화하는 세 채널과 1:1):
//   ① 입장 소개  lineupIntroBeats — 양 팀 선발 11명 **전원**을 호명한다.
//   ② 경기 중계  commentateTimeline — 골·선방·경고·파울·교체 등 이름이 든 템플릿.
//   ③ 교체 투입  경기 중 sub 이벤트로 들어온 선수(②에 포함되지만 따로도 센다).
//
// ★ 한국(kor)만은 예외다 — 유저가 라인업을 직접 바꾸므로 26명 전원이 후보다.
//   그래서 kor은 '실측 집합'이 아니라 '스쿼드 전원'으로 보고한다.
//
// 화자별로도 센다. 이름 클립은 캐스터/해설위원 각각 따로 필요할 수 있고,
// 그 분포가 곧 내일 쓸 API 요청 수다.
//
// 사용:
//   node tools/tts/roster.mjs [--seeds 24] [--json docs/audio/tts/roster.json]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const SEEDS = Number(arg('seeds', 24))
const JSON_OUT = arg('json', 'docs/audio/tts/roster.json')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { applyDiscipline } = await server.ssrLoadModule('/src/game/campaignStore.ts')
const { teamCardTally } = await server.ssrLoadModule('/src/game/playerStats.ts')
const { commentateTimeline, lineupIntroBeats, lineupSplitOf } =
  await server.ssrLoadModule('/src/game/commentary.ts')

// campaignStore의 경로 테이블 미러(tools/discipline/run.mjs와 같은 표).
const GROUP = ['cze', 'mex', 'rsa']
const FIRST = { r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp' }
const SECOND = { r32: 'can', r16: 'mar', qf: 'fra', sf: 'esp', final: 'arg' }
const TOUR = ['r32', 'r16', 'qf', 'sf', 'final']
const ALL_TEAMS = ['kor', ...GROUP, ...new Set([...Object.values(FIRST), ...Object.values(SECOND)])]

const teams = Object.fromEntries(ALL_TEAMS.map(id => [id, loadTeam(id)]))
const kor = teams.kor

/** teamId → { playerId → { caster:n, analyst:n, entrance:n, sub:n } } */
const hits = {}
for (const id of ALL_TEAMS) hits[id] = {}
const bump = (teamId, playerId, chan) => {
  const t = (hits[teamId][playerId] ??= { caster: 0, analyst: 0, entrance: 0, sub: 0 })
  t[chan] += 1
}

/** 이름이 든 문장 통계 — 화자별 / 템플릿 id별. */
const nameLinesBySpeaker = { caster: 0, analyst: 0 }
const nameLineIds = {}          // `${speaker}|${id}` → 횟수
const nameLineSample = {}       // 같은 키의 첫 문장(재작성 대상 목록)

/** XI 슬롯 순서대로 LineupMember 배열(entrance.buildEntranceCast와 같은 계약). */
function membersOf(team, tactics) {
  return tactics.lineup.map(s => {
    const p = team.squad.find(x => x.id === s.playerId)
    return { id: p.id, number: p.number, nameKo: p.name.ko, position: p.position }
  })
}

/**
 * 한 경기를 돌리고 발화되는 이름을 집계한다.
 * @returns 카드·체력·사기 등 캠페인 진행에 필요한 값
 */
function playMatch(oppId, seed, homeTactics, staminaOverride, moraleOverride) {
  const away = teams[oppId]
  const st0 = createMatch(kor, away, { seed, homeTactics })
  for (const [id, v] of Object.entries(staminaOverride)) {
    if (id in st0.home.staminaByPlayer) st0.home.staminaByPlayer[id] = v
  }
  for (const [id, v] of Object.entries(moraleOverride)) {
    if (id in st0.home.moraleByPlayer) st0.home.moraleByPlayer[id] = v
  }
  const st = simulateSegment(st0, 90)

  // ① 입장 소개 — 양 팀 선발 11명 전원.
  for (const [side, team] of [['home', kor], ['away', away]]) {
    const t = st[side].tactics
    const ms = membersOf(team, t)
    for (const m of ms) bump(team.id, m.id, 'entrance')
    // 소개 문장이 실제로 이름을 부르는지 확인(폴백 경로에서도 이름 비트는 남는다).
    const beats = lineupIntroBeats(team.name.ko, t.formation, ms)
    const named = beats.filter(b => b.kind === 'name').length
    if (named !== ms.length) {
      console.error(`  ! ${team.id} 소개 이름 비트 ${named} != XI ${ms.length} (formation ${t.formation}, split ${JSON.stringify(lineupSplitOf(t.formation))})`)
    }
  }

  // ② 경기 중계 — 라인 문자열에 이름이 들어갔는지로 판정한다(템플릿을 흉내내지 않는다).
  const lines = commentateTimeline(st.events, kor, away, seed, {}, 95)
  const roster = [
    ...kor.squad.map(p => [kor.id, p.id, p.name.ko]),
    ...away.squad.map(p => [away.id, p.id, p.name.ko]),
  ]
  for (const l of lines) {
    let named = false
    for (const [tid, pid, ko] of roster) {
      if (l.speech.includes(ko)) { bump(tid, pid, l.speaker); named = true }
    }
    if (named) {
      nameLinesBySpeaker[l.speaker] += 1
      const key = `${l.speaker}|${l.id}`
      nameLineIds[key] = (nameLineIds[key] ?? 0) + 1
      nameLineSample[key] ??= l.speech
    }
  }

  // ③ 교체 투입.
  for (const e of st.events) {
    if (e.type === 'sub' && e.playerId) bump(e.teamId, e.playerId, 'sub')
  }

  return {
    score: [st.score[0], st.score[1]],
    cards: teamCardTally(st.events, kor.id),
    stamina: { ...st.home.staminaByPlayer },
    morale: { ...st.home.moraleByPlayer },
  }
}

const tiebreak = (seed, stage) => ((seed * 7919 + stage.length * 31) % 2) === 0

function runCampaign(seed) {
  let cautions = {}, bans = {}, fatigue = {}, morale = {}
  let played = 0, groupPts = 0, groupGd = 0, path = null
  const startStamina = id => (fatigue[id] === undefined ? 100 : Math.min(100, fatigue[id] + (100 - fatigue[id]) * 0.7))
  const startMorale = id => (morale[id] === undefined ? 70 : 70 + (morale[id] - 70) * 0.3)

  const step = (oppId, stage) => {
    const suspended = Object.keys(bans).filter(id => bans[id] > 0)
    const tactics = pickBestXI(kor, undefined, suspended)
    const sOv = {}, mOv = {}
    for (const p of kor.squad) { sOv[p.id] = startStamina(p.id); mOv[p.id] = startMorale(p.id) }
    const r = playMatch(oppId, seed * 31 + played, tactics, sOv, mOv)
    played++
    fatigue = { ...fatigue, ...r.stamina }
    morale = { ...morale, ...r.morale }
    const next = applyDiscipline(cautions, bans, r.cards, stage)
    cautions = next.cautions; bans = next.bans
    return r
  }

  for (let i = 0; i < 3; i++) {
    const r = step(GROUP[i], `group${i + 1}`)
    groupPts += r.score[0] > r.score[1] ? 3 : r.score[0] === r.score[1] ? 1 : 0
    groupGd += r.score[0] - r.score[1]
  }
  if (groupPts >= 5) path = 'first'
  else if (groupPts >= 3 || (groupPts >= 2 && groupGd >= 0)) path = 'second'
  if (!path) return
  const table = path === 'first' ? FIRST : SECOND
  for (const stage of TOUR) {
    const r = step(table[stage], stage)
    const won = r.score[0] > r.score[1] || (r.score[0] === r.score[1] && tiebreak(seed, stage))
    if (!won || stage === 'final') break
  }
}

for (let s = 1; s <= SEEDS; s++) runCampaign(s)

// ── 보고 ────────────────────────────────────────────────────
const nameOf = (tid, pid) => teams[tid].squad.find(p => p.id === pid)?.name.ko ?? pid

console.log(`\n# 이름 발화 실측 — 캠페인 시드 1..${SEEDS}\n`)
console.log('| 팀 | 스쿼드 | 발화됨 | 입장만 | 중계에도 | 캐스터 | 해설 | 클립 대상 |')
console.log('|---|---:|---:|---:|---:|---:|---:|---:|')

const clipTargets = {}
let totalTargets = 0
for (const tid of ALL_TEAMS) {
  const team = teams[tid]
  const h = hits[tid]
  const spoken = Object.keys(h)
  const entranceOnly = spoken.filter(id => h[id].entrance > 0 && h[id].caster === 0 && h[id].analyst === 0)
  const inPlay = spoken.filter(id => h[id].caster > 0 || h[id].analyst > 0)
  const casterN = spoken.filter(id => h[id].caster > 0).length
  const analystN = spoken.filter(id => h[id].analyst > 0).length
  // kor은 유저가 라인업을 바꿀 수 있으므로 스쿼드 전원이 후보다.
  const targets = tid === 'kor' ? team.squad.map(p => p.id) : spoken
  clipTargets[tid] = targets.map(id => ({ id, ko: nameOf(tid, id) }))
  totalTargets += targets.length
  console.log(`| ${team.name.ko} (${tid}) | ${team.squad.length} | ${spoken.length} | ${entranceOnly.length} | ${inPlay.length} | ${casterN} | ${analystN} | **${targets.length}**${tid === 'kor' ? ' (전원)' : ''} |`)
}
console.log(`| **합계** | ${ALL_TEAMS.reduce((a, t) => a + teams[t].squad.length, 0)} | | | | | | **${totalTargets}** |`)

console.log(`\n## 이름이 든 문장의 화자 분포\n`)
const tot = nameLinesBySpeaker.caster + nameLinesBySpeaker.analyst
console.log(`| 화자 | 이름 든 문장 수 | 비율 |`)
console.log(`|---|---:|---:|`)
for (const sp of ['caster', 'analyst']) {
  console.log(`| ${sp === 'caster' ? '캐스터' : '해설위원'} | ${nameLinesBySpeaker[sp]} | ${((nameLinesBySpeaker[sp] / tot) * 100).toFixed(1)}% |`)
}

console.log(`\n## 이름이 든 템플릿 (화자|id, 등장 횟수 순)\n`)
console.log('| 화자 | 템플릿 id | 등장 | 예시 |')
console.log('|---|---|---:|---|')
for (const [k, n] of Object.entries(nameLineIds).sort((a, b) => b[1] - a[1])) {
  const [sp, id] = k.split('|')
  console.log(`| ${sp} | \`${id}\` | ${n} | ${nameLineSample[k]} |`)
}

const out = resolve(JSON_OUT)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({
  seeds: SEEDS,
  totalTargets,
  nameLinesBySpeaker,
  nameLineIds,
  clipTargets,
}, null, 1) + '\n')
console.log(`\n${JSON_OUT} 에 기록했다 (이름 대상 ${totalTargets}명).`)

await server.close()
