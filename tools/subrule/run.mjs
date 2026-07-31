#!/usr/bin/env node
// tools/subrule/run.mjs
// 교체 재투입 금지(IFAB 제3조)의 **밸런스 영향 실측**.
//
// 이 규칙은 상대 AI 쪽에서만 전력에 영향을 준다 — 헤드리스에는 유저 교체가 없고,
// 우리 팀 제약은 UI 선택지의 문제이지 시뮬 결과를 바꾸지 않는다. 반대로 상대 AI는
// 매 창(46/60/70/80)마다 bestBench로 IN을 뽑는데, 수정 전에는 방금 뺀 선수(= 대개
// 그 자리 적합도 1위였던 선발)를 다시 넣을 수 있어 사실상 "무한 리필"이었다.
// 그래서 ON/OFF는 상대 후반 전력의 차이이고, 그것이 우리 승률로 나타난다.
//
// 사용: node tools/subrule/run.mjs [--seeds 200]
//
// 대조 방법: 같은 시드로 90분을 분 단위로 두 번 돌린다.
//   ON  = 현재 프로덕션 decideAwayActions (재투입 차단)
//   OFF = 같은 결정에서 IN 선정만 수정 전 규칙(bestBench에 제외 목록 없음)으로 되돌린다
// tiredIn(OUT 선정)·전술 스위칭은 이 변경과 무관하므로 프로덕션 코드를 그대로 쓴다.
// Math.random·Date 미사용 — 전 과정이 시드 결정론이다.
import { createServer } from 'vite'

const seedCount = (() => {
  const i = process.argv.indexOf('--seeds')
  return i >= 0 ? Number(process.argv[i + 1]) : 150
})()

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment, applyCommand } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { positionFitness } = await server.ssrLoadModule('/src/engine/fitness.ts')
const { decideAwayActions } = await server.ssrLoadModule('/src/game/oppAi.ts')
const { subbedOffIds } = await server.ssrLoadModule('/src/game/playerStats.ts')

const kor = loadTeam('kor')
const OPPONENTS = ['cze', 'mex', 'rsa', 'ecu', 'can', 'eng', 'mar', 'nor', 'fra', 'arg', 'esp']

/** 수정 전 bestBench 재현 — 라인업 밖 + 미퇴장 중 적합도 1위(교체 아웃 제외 없음). */
function legacyBestBench(side, slot) {
  const inXI = new Set(side.tactics.lineup.map(l => l.playerId))
  return side.team.squad
    .filter(p => !inXI.has(p.id) && !side.sentOff.includes(p.id))
    .sort((a, b) => positionFitness(b, slot) - positionFitness(a, slot) || a.id.localeCompare(b.id))[0]?.id ?? null
}

/** 프로덕션 결정을 받아 OFF 모드에서는 sub의 IN만 수정 전 규칙으로 되돌린다. */
function toLegacy(st, actions) {
  const away = st.away
  const nameOf = id => away.team.squad.find(p => p.id === id)?.name.ko ?? id
  return actions.map(a => {
    if (a.cmd.type !== 'sub') return a
    // 프로덕션이 고른 OUT은 그대로 두고, IN만 제외 목록 없는 규칙으로 다시 뽑는다.
    const slot = away.tactics.lineup.find(l => l.playerId === a.cmd.out)?.slot
    const legacyIn = legacyBestBench(away, slot ?? 'CM')
    if (!legacyIn) return null
    return {
      cmd: { type: 'sub', out: a.cmd.out, in: legacyIn },
      notice: `📢 ${away.team.name.ko} 교체 — ${nameOf(a.cmd.out)} OUT, ${nameOf(legacyIn)} IN`,
    }
  }).filter(Boolean)
}

/** 90분 분 단위 재생(matchStore.advanceMinute의 상대 AI 부분을 그대로 옮긴 것). */
function playMatch(oppId, seed, enforce) {
  let st = createMatch(kor, loadTeam(oppId), { seed })
  const done = []
  let reentry = 0
  for (let m = 1; m <= 90; m++) {
    st = simulateSegment(st, m)
    let actions = decideAwayActions(st, m, done)
    if (!enforce) actions = toLegacy(st, actions)
    for (const a of actions) {
      if (done.includes(a.notice)) continue
      if (a.cmd.type === 'sub') {
        const off = subbedOffIds(st.events, st.away.team.id)
        if (off.includes(a.cmd.in)) {
          if (enforce) continue // 프로덕션 최종 방어선(matchStore와 동일)
          reentry++ // OFF 모드에서는 규정 위반이 그대로 통과한다 — 세어 둔다
        }
      }
      try { st = applyCommand(st, 'away', a.cmd) } catch { continue }
      done.push(a.notice)
    }
  }
  return { score: [st.score[0], st.score[1]], reentry, awaySubs: st.away.subsUsed }
}

const modes = [true, false]
const agg = { true: { w: 0, d: 0, l: 0, gf: 0, ga: 0, re: 0 }, false: { w: 0, d: 0, l: 0, gf: 0, ga: 0, re: 0 } }
let games = 0, diffScore = 0, diffResult = 0

for (let seed = 1; seed <= seedCount; seed++) {
  for (const opp of OPPONENTS) {
    const r = {}
    for (const enforce of modes) {
      const m = playMatch(opp, seed, enforce)
      r[enforce] = m
      const a = agg[enforce]
      a.gf += m.score[0]; a.ga += m.score[1]; a.re += m.reentry
      if (m.score[0] > m.score[1]) a.w++
      else if (m.score[0] === m.score[1]) a.d++
      else a.l++
    }
    games++
    const on = r[true].score, off = r[false].score
    if (on[0] !== off[0] || on[1] !== off[1]) diffScore++
    const res = s => (s[0] > s[1] ? 'W' : s[0] === s[1] ? 'D' : 'L')
    if (res(on) !== res(off)) diffResult++
  }
}

const pct = (n, d) => ((n / d) * 100).toFixed(2)
console.log(`시드 1..${seedCount} × 상대 ${OPPONENTS.length}팀 = ${games}경기 (모드당)`)
for (const enforce of modes) {
  const a = agg[enforce]
  const label = enforce ? 'ON  (재투입 차단)' : 'OFF (수정 전)   '
  console.log(
    `${label}  승 ${a.w} 무 ${a.d} 패 ${a.l}  승률 ${pct(a.w, games)}%  ` +
    `득 ${(a.gf / games).toFixed(3)} 실 ${(a.ga / games).toFixed(3)}  규정 위반 재투입 ${a.re}건`,
  )
}
const dW = agg[true].w / games - agg[false].w / games
console.log(`Δ승률 ${(dW * 100 >= 0 ? '+' : '')}${(dW * 100).toFixed(2)}pp · 스코어가 달라진 경기 ${diffScore} (${pct(diffScore, games)}%) · 결과(승무패)가 달라진 경기 ${diffResult} (${pct(diffResult, games)}%)`)

await server.close()
