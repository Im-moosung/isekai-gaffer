#!/usr/bin/env node
// tools/round9/shots.mjs
// R9 계측 — **박스 안/밖 슛 비율**을 패턴 4종 × N시드 90분 실주행으로 잰다.
//
// 왜 새 스크립트인가: tools/sim-audit/shots.mjs는 거리 분위수를 재고 패턴을
// **라이브러리 전수**(BUILDUP_BY_PATTERN 고정)로만 가른다. 여기서 필요한 것은
// "유저가 그 전술을 골랐을 때 실제 90분에서 박스 안 슛이 몇 %인가"이고,
// 그 값은 BUILDUP_WEIGHTS 추첨을 거친 실주행에서만 나온다.
//
// 판정: 저술 슛 스테이션의 볼 좌표를 월드로 옮겨 골라인 거리 ≤ 16.5 m &
// |z| ≤ 20.16 m 이면 박스 안(StatsBomb 박스 폴리곤과 같은 정의).
//
// 사용: node tools/round9/shots.mjs [--seeds 40] [--json out.json]
import { createServer } from 'vite'

const argN = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d }
const argS = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const NSEEDS = argN('--seeds', 40)
const JSON_OUT = argS('--json', '')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = p => server.ssrLoadModule(p)

const { makeTestTeam } = await L('/src/engine/fixtures/testTeams.ts')
const { pickBestXI } = await L('/src/engine/lineup.ts')
const sim = await L('/src/engine/simulate.ts')
const { buildSequence, sceneKeyFor } = await L('/src/ui/pitch/choreography.ts')
const pb = await L('/src/ui/match/playback.ts')
const { pickDramaEvent } = await L('/src/game/drama.ts')
const { toWorld, PITCH_W, PITCH_H } = await L('/src/ui/pitch/three/types.ts')

const HALF_W = PITCH_W / 2
const BOX_D = 16.5
const BOX_HALF = 20.16
void PITCH_H

const patterns = ['balanced', 'cross', 'through', 'longshot']
const SHOT_TYPES = new Set(['goal', 'save', 'miss', 'shot'])

function tacticsFor(team, pattern) {
  const t = pickBestXI(team)
  t.instructions = {
    lineHeight: team.profile.style.lineHeight, pressing: team.profile.style.pressing,
    tempo: team.profile.style.tempo, attackFocus: 'balanced',
  }
  t.attackPattern = pattern
  return t
}

/** 이 이벤트가 공격 팀 기준 어느 골문을 향하나 — save는 teamId가 수비 팀이다. */
const atkSideOf = (ev, homeId) => {
  const owner = ev.teamId === homeId ? 'home' : 'away'
  return ev.type === 'save' ? (owner === 'home' ? 'away' : 'home') : owner
}

function runMatch(pattern, seed) {
  const home = makeTestTeam('kor', 82)
  const away = makeTestTeam('esp', 84)
  let engine = sim.createMatch(home, away, {
    seed, homeTactics: tacticsFor(home, pattern), awayTactics: tacticsFor(away, pattern),
  })
  const out = []
  let guard = 0
  while (engine.minute < 90 && guard++ < 200) {
    const minute = engine.minute
    const evs = engine.events.filter(e => e.minute === minute)
    const drama = pickDramaEvent(evs)
    if (drama && pb.isHighlightEvent(drama) && SHOT_TYPES.has(drama.type)) {
      const seq = buildSequence(drama, engine.home, engine.away)
      if (seq.length >= 2) {
        // 슛 스테이션 = 마지막에서 두 번째 스텝(마지막은 결과 지점).
        const p = seq[seq.length - 2]
        const side = atkSideOf(drama, engine.home.team.id)
        const w = toWorld(p.ball.x, p.ball.y)
        const gx = Math.abs((side === 'home' ? HALF_W : -HALF_W) - w.x)
        const dist = Math.hypot(gx, w.z)
        out.push({
          minute, type: drama.type, side, dist, depth: gx,
          inBox: gx <= BOX_D && Math.abs(w.z) <= BOX_HALF,
          key: sceneKeyFor(drama, engine.home, engine.away),
        })
      }
    }
    engine = sim.simulateSegment(engine, minute + 1)
  }
  return out
}

const pct = (arr, p) => {
  if (arr.length === 0) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—')

const rows = {}
const perMatch = {}
for (const p of patterns) {
  const rs = []
  perMatch[p] = []
  for (let i = 0; i < NSEEDS; i++) {
    const one = runMatch(p, 1000 + i * 37)
    perMatch[p].push(new Set(one.map(r => (r.key ?? '').split('/')[1]?.split('.')[0])))
    rs.push(...one)
  }
  rows[p] = rs
}

console.log('# R9 — 박스 안/밖 슛 비율 (90분 실주행 × %d시드, 저술 좌표)'.replace('%d', NSEEDS))
console.log('\n관문: balanced 박스 안 ≥ 70% · longshot 박스 **밖** ≥ 70%')
console.log('\n| 패턴 | 슛 n | 박스 안 | SE | 박스 밖 | p25 | p50 | p75 | p90 |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const p of patterns) {
  const rs = rows[p]
  const n = rs.length
  const k = rs.filter(r => r.inBox).length
  const q = k / n
  const se = Math.sqrt((q * (1 - q)) / n)
  const d = rs.map(r => r.dist)
  console.log(`| ${p} | ${n} | **${(q * 100).toFixed(1)}%** | ±${(se * 100).toFixed(1)} | ${((1 - q) * 100).toFixed(1)}% | ` +
    `${f1(pct(d, 0.25))} | **${f1(pct(d, 0.5))}** | ${f1(pct(d, 0.75))} | ${f1(pct(d, 0.9))} |`)
}

console.log('\n## 결과 종류별 박스 안 비율')
console.log('\n| 패턴 | goal | save | miss | shot |')
console.log('|---|---|---|---|---|')
for (const p of patterns) {
  const cells = ['goal', 'save', 'miss', 'shot'].map(t => {
    const rs = rows[p].filter(r => r.type === t)
    if (rs.length === 0) return '—'
    return `${((rs.filter(r => r.inBox).length / rs.length) * 100).toFixed(0)}% (n=${rs.length})`
  })
  console.log(`| ${p} | ${cells.join(' | ')} |`)
}

console.log('\n## 빌드업 계열별 박스 안 비율 (전 패턴 합산)')
const byFam = {}
for (const p of patterns) for (const r of rows[p]) {
  const fam = (r.key ?? '').split('/')[1]?.split('.')[0] ?? '?'
  ;(byFam[fam] ??= []).push(r)
}
console.log('\n| 계열 | n | 박스 안 | p50 |')
console.log('|---|---|---|---|')
for (const fam of Object.keys(byFam).sort()) {
  const rs = byFam[fam]
  console.log(`| ${fam} | ${rs.length} | ${((rs.filter(r => r.inBox).length / rs.length) * 100).toFixed(0)}% | ${f1(pct(rs.map(r => r.dist), 0.5))} |`)
}

console.log('\n## 한 경기에 보이는 계열 수 / 존 분포')
console.log('\n| 패턴 | 경기당 계열 수(평균) | 최소 | 최대 | 박스밖 존 비율 |')
console.log('|---|---|---|---|---|')
for (const p of patterns) {
  const per = perMatch[p].map(set => set.size)
  const mean = per.reduce((a, b) => a + b, 0) / per.length
  const zo = rows[p].filter(r => (r.key ?? '').endsWith('Zout')).length / rows[p].length
  console.log(`| ${p} | **${mean.toFixed(1)}** | ${Math.min(...per)} | ${Math.max(...per)} | ${(zo * 100).toFixed(0)}% |`)
}

if (JSON_OUT) {
  const fs = await import('node:fs')
  fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1))
}
await server.close()
