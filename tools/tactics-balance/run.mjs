#!/usr/bin/env node
// tools/tactics-balance/run.mjs
//
// 포메이션 상성표(EDGES) 재설계와 남아공 데이터 재보정(2026-08-01)의 실측 하네스.
// 두 가지를 잰다.
//
//  1) **상성표가 죽은 레버가 아닌가** — DiD(difference-in-differences).
//     우리 형태 A·B를 고정한 채 **상대 형태만** 바꾼다.
//       DiD = [pts(A|상대 O1) − pts(B|상대 O1)] − [pts(A|상대 O2) − pts(B|상대 O2)]
//     우리 posture(무게중심)·상대 전력 같은 형태 외 요인은 안쪽 두 차이에서 상쇄되고,
//     남는 것은 formationEdge가 만든 차이뿐이다. 구판 표에서 DiD ≈ 0인 조합을 골라
//     신판과 비교하면 "표가 실제로 승점을 움직이는가"에 바로 답이 나온다.
//
//  2) **압박 반응이 상대별로 갈리는가** — 압박 50 vs 80의 페어드 승점 차를 상대별로.
//
// 전부 **페어드**(두 arm이 같은 시드 대역 = 공통 난수)다. 이 저장소는 비페어드 소표본으로
// 두 번 데였다(n=800에서 fra 참값 −1.0을 +0.3으로 읽음). 페어드 SE는 n=4000에서 약 0.010이다.
//
// 결정론: 시드는 --base(기본 1000)에서 31씩 증가하는 정수뿐이다. Math.random·Date 미사용.
//
// 사용:
//   node tools/tactics-balance/run.mjs did     [--n 4000]
//   node tools/tactics-balance/run.mjs press   [--n 4000]
//   node tools/tactics-balance/run.mjs fslope  [--n 4000]
//   node tools/tactics-balance/run.mjs fsweep  [--n 4000]
//   node tools/tactics-balance/run.mjs zones
//   node tools/tactics-balance/run.mjs calib   [--n 400]
import { createServer } from 'vite'

const MODE = process.argv[2] ?? 'did'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d }
const N = arg('n', 4000)
const BASE = arg('base', 1000)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam, TEAM_IDS } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment, matchupEdge } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { kickoffZones } = await server.ssrLoadModule('/src/engine/strength.ts')
const { runBatch } = await server.ssrLoadModule('/src/engine/calibrate.ts')

const FORMATIONS = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
const NEUTRAL = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }

/** balance.batch와 같은 규약: XI는 패치된 포메이션으로 다시 세우고, 전·후반을 나눠 돌린다. */
function batch(homeId, awayId, n, seedBase, patch, awayFormation) {
  const home = loadTeam(homeId), away = loadTeam(awayId)
  const t = pickBestXI(home, patch.formation)
  const tactics = { ...t, ...patch, instructions: { ...t.instructions, ...(patch.instructions ?? {}) } }
  let awayTactics
  if (awayFormation) {
    awayTactics = pickBestXI(away, awayFormation)
    awayTactics.instructions = {
      lineHeight: away.profile.style.lineHeight, pressing: away.profile.style.pressing,
      tempo: away.profile.style.tempo, attackFocus: 'balanced',
    }
  }
  let w = 0, d = 0, gf = 0, ga = 0
  for (let i = 0; i < n; i++) {
    let st = createMatch(home, away, { seed: seedBase + i * 31, homeTactics: tactics, ...(awayTactics ? { awayTactics } : {}) })
    st = simulateSegment(st, 45)
    st = simulateSegment(st, 90)
    gf += st.score[0]; ga += st.score[1]
    if (st.score[0] > st.score[1]) w++
    else if (st.score[0] === st.score[1]) d++
  }
  return { winRate: w / n, points: (w * 3 + d) / n, gf: gf / n, ga: ga / n }
}

const pts = (opp, f, awayF, seed) =>
  batch('kor', opp, N, seed, { instructions: NEUTRAL, formation: f }, awayF).points

if (MODE === 'did') {
  // [우리 A, 우리 B, 상대 O1, 상대 O2]
  // 구판 edge DiD: A쌍 −0.03 · B쌍 0.00(정확히 죽은 조합) / 신판: −0.20 · −0.11
  const CASES = [
    ['4-3-3', '4-1-4-1', '3-5-2', '4-4-2'],
    ['4-2-3-1', '4-4-2', '4-1-4-1', '3-5-2'],
  ]
  for (const opp of ['mex', 'cze']) {
    for (const [A, B, O1, O2] of CASES) {
      for (const seed of [BASE, 777_000]) {
        const d1 = pts(opp, A, O1, seed) - pts(opp, B, O1, seed)
        const d2 = pts(opp, A, O2, seed) - pts(opp, B, O2, seed)
        console.log(`DiD ${opp} ${A}/${B} opp[${O1}|${O2}] seed${seed}: inner1=${d1.toFixed(4)} inner2=${d2.toFixed(4)} DiD=${(d1 - d2).toFixed(4)}`)
      }
    }
  }
} else if (MODE === 'press') {
  for (const opp of ['rsa', 'cze', 'mex', 'ecu', 'can']) {
    const lo = batch('kor', opp, N, BASE, { instructions: { ...NEUTRAL, pressing: 50 } })
    const hi = batch('kor', opp, N, BASE, { instructions: { ...NEUTRAL, pressing: 80 } })
    console.log(`PRESS ${opp}: p50 win=${(lo.winRate * 100).toFixed(1)}% pts=${lo.points.toFixed(3)} ga=${lo.ga.toFixed(2)} | p80 win=${(hi.winRate * 100).toFixed(1)}% pts=${hi.points.toFixed(3)} ga=${hi.ga.toFixed(2)} | Δpts=${(hi.points - lo.points).toFixed(4)} Δwin=${((hi.winRate - lo.winRate) * 100).toFixed(2)}pp`)
  }
} else if (MODE === 'fslope') {
  for (const opp of ['rsa', 'fra', 'esp', 'mex']) {
    for (const seed of [BASE, 777_000]) {
      const f = pts(opp, '3-5-2', undefined, seed), b = pts(opp, '5-4-1', undefined, seed)
      console.log(`FSLOPE ${opp} seed${seed}: 3-5-2=${f.toFixed(3)} 5-4-1=${b.toFixed(3)} slope=${(f - b).toFixed(4)}`)
    }
  }
} else if (MODE === 'ap') {
  // P3 게이트(공격 패턴 축)가 상성표 변경에 얼마나 흔들리는지. balance.test.ts와 같은 함수·
  // 같은 두 시드 대역이라 게이트 값을 그대로 재현한다(게이트: rsa > +0.06 · esp/fra < −0.06).
  const { attackPatternSlope } = await server.ssrLoadModule('/src/engine/balance.ts')
  const OPPS = (() => { const i = process.argv.indexOf('--opps'); return i >= 0 ? process.argv[i + 1].split(',') : ['rsa', 'esp', 'fra'] })()
  for (const opp of OPPS) {
    const a = attackPatternSlope('kor', opp, N, BASE), b = attackPatternSlope('kor', opp, N, 777_000)
    console.log(`AP ${opp}: seed${BASE}=${a.toFixed(4)} seed777000=${b.toFixed(4)}`)
  }
} else if (MODE === 'fsweep') {
  for (const opp of ['rsa', 'mex', 'fra']) {
    console.log(`FSWEEP ${opp}: ${FORMATIONS.map(f => `${f}=${pts(opp, f, undefined, BASE).toFixed(3)}`).join(' ')}`)
  }
} else if (MODE === 'default') {
  for (const opp of ['rsa', 'cze', 'mex', 'ecu', 'can', 'mar']) {
    const r = batch('kor', opp, N, BASE, {})
    console.log(`DEFAULT vs ${opp}: win=${(r.winRate * 100).toFixed(1)}% pts=${r.points.toFixed(3)} gf=${r.gf.toFixed(2)} ga=${r.ga.toFixed(2)}`)
  }
} else if (MODE === 'zones') {
  const me = kickoffZones(loadTeam('kor'))
  for (const id of TEAM_IDS) {
    const t = loadTeam(id), z = kickoffZones(t)
    console.log(`ZONE ${id} rank=${t.fifaRanking} atk=${z.attack.toFixed(2)} mid=${z.midfield.toFixed(2)} def=${z.defense.toFixed(2)} gk=${z.gk.toFixed(2)} | edge(kor)=${matchupEdge(me, z).toFixed(3)} risk=${Math.pow(matchupEdge(me, z), -10).toFixed(2)}`)
  }
} else if (MODE === 'calib') {
  for (const [h, a] of [['kor', 'rsa'], ['kor', 'cze'], ['kor', 'mex']]) {
    const rep = runBatch(loadTeam(h), loadTeam(a), N)
    const hb = loadTeam(h).statBaseline, ab = loadTeam(a).statBaseline
    const dev = (act, exp) => `${act.toFixed(2)}(${((act - exp) / exp * 100).toFixed(1)}%)`
    console.log(`CALIB ${h}-${a} home shots=${dev(rep.avg.home.shots, hb.shotsPerGame)} fouls=${dev(rep.avg.home.fouls, hb.foulsPerGame)} | away shots=${dev(rep.avg.away.shots, ab.shotsPerGame)} fouls=${dev(rep.avg.away.fouls, ab.foulsPerGame)} | homeWin=${(rep.homeWinRate * 100).toFixed(1)}%`)
  }
} else {
  console.error(`unknown mode: ${MODE}`)
}

await server.close()
