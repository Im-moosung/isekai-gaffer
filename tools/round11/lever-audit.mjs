#!/usr/bin/env node
// tools/round11/lever-audit.mjs
//
// **세트피스 레버가 죽어 있지 않은가** — 작전판에 적힌 배수와 실측 효과의 대조.
//
// 왜 이 하네스가 따로 필요한가: `engine/balance.ts`의 planSlope는 두 arm의 **평균 승점 차**만
// 돌려준다. 차이의 표준오차를 알 수 없어 "판정 불가"를 판정할 수 없다. 여기서는 같은 시드로
// 두 arm을 나란히 돌려 **경기별 승점 차**를 모으고, 그 표본의 SE를 직접 계산한다.
// 프로젝트 규칙: |차이| < 2·SE 이면 "판정 불가"다.
//
// 함께 재는 것 — 세트피스 골 수. 승점은 여러 경로의 합이라 레버가 움직여도 묻힐 수 있다.
// 엔진이 세트피스 골에 `detail:'setpiece'`를 남기므로, 그 개수를 직접 세면 레버가
// **자기 경로에서** 무엇을 했는지가 승점보다 훨씬 선명하게 보인다.
//
// 결정론: 시드는 base에서 31씩 증가하는 정수뿐. Math.random·Date 미사용.
//
// 사용:
//   node tools/round11/lever-audit.mjs route  [--n 3000] [--base 1000]
//   node tools/round11/lever-audit.mjs load   [--n 3000]
//   node tools/round11/lever-audit.mjs mark   [--n 3000]
//   node tools/round11/lever-audit.mjs grid   [--n 1500]   # 루트3 × 인원3 전 조합
import { createServer } from 'vite'

const MODE = process.argv[2] ?? 'route'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d }
const N = arg('n', 3000)
const BASE = arg('base', 1000)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { setPieceEffects } = await server.ssrLoadModule('/src/engine/tactics.ts')

const NEUTRAL_INS = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }

/** 한 플랜을 n경기 돌려 **경기별** 결과 배열을 돌려준다(페어링의 재료). */
function runArm(homeId, awayId, patch, n, seedBase, awayPatch) {
  const home = loadTeam(homeId)
  const away = loadTeam(awayId)
  const ht = pickBestXI(home, patch.formation)
  const at = pickBestXI(away)
  const homeTactics = { ...ht, ...patch, instructions: { ...NEUTRAL_INS, ...(patch.instructions ?? {}) } }
  const awayTactics = awayPatch ? { ...at, ...awayPatch } : at
  const pts = new Float64Array(n)
  const spGf = new Float64Array(n)   // 우리 세트피스 골
  const spShots = new Float64Array(n) // 우리 세트피스 슛(goal/save/miss detail)
  const corners = new Float64Array(n)
  const gd = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let st = createMatch(home, away, { seed: seedBase + i * 31, homeTactics, awayTactics })
    st = simulateSegment(st, 45)
    st = simulateSegment(st, 90)
    pts[i] = st.score[0] > st.score[1] ? 3 : st.score[0] === st.score[1] ? 1 : 0
    gd[i] = st.score[0] - st.score[1]
    corners[i] = st.stats[0].corners
    for (const e of st.events) {
      if (e.detail !== 'setpiece' || e.teamId !== home.id) continue
      spShots[i]++
      if (e.type === 'goal') spGf[i]++
    }
    // save 이벤트의 teamId는 막은 팀(=원정)이라 위 필터에서 빠진다. 우리 세트피스 슛의
    // 세이브분을 되찾는다.
    for (const e of st.events) {
      if (e.detail === 'setpiece' && e.type === 'save' && e.teamId === away.id) spShots[i]++
    }
  }
  return { pts, spGf, spShots, corners, gd }
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length
/** 페어드 차이 통계 — 평균, SE, 배수(mean/SE). */
function paired(a, b) {
  const n = a.length
  const d = new Float64Array(n)
  for (let i = 0; i < n; i++) d[i] = a[i] - b[i]
  const m = mean(d)
  let s = 0
  for (let i = 0; i < n; i++) s += (d[i] - m) ** 2
  const se = Math.sqrt(s / (n - 1) / n)
  return { mean: m, se, ratio: se > 0 ? Math.abs(m) / se : 0 }
}
const f3 = v => (v >= 0 ? '+' : '') + v.toFixed(3)
const verdict = p => (p.ratio >= 2 ? '판정 가능' : '판정 불가')

function report(label, A, B) {
  const p = paired(A.pts, B.pts)
  const g = paired(A.spGf, B.spGf)
  const s = paired(A.spShots, B.spShots)
  const gdp = paired(A.gd, B.gd)
  console.log(
    `  ${label.padEnd(26)} 승점 ${f3(p.mean)} ±${p.se.toFixed(4)} (${p.ratio.toFixed(1)}σ ${verdict(p)})` +
    ` | 득실 ${f3(gdp.mean)} (${gdp.ratio.toFixed(1)}σ)` +
    ` | SP골 ${f3(g.mean)} (${g.ratio.toFixed(1)}σ)` +
    ` | SP슛 ${f3(s.mean)} (${s.ratio.toFixed(1)}σ)`,
  )
}

/** 작전판이 화면에 적는 배수 — TacticsExtras와 같은 호출로 뽑는다. */
function shownMultipliers(oppId) {
  const opp = loadTeam(oppId)
  const oppXI = pickBestXI(opp)
  const gkSlot = oppXI.lineup.find(l => l.slot === 'GK')
  const gk = opp.squad.find(p => p.id === gkSlot.playerId)
  const aerial = gk.gkStats?.aerial ?? 25
  const out = {}
  for (const route of ['near', 'far', 'short'])
    out[`route.${route}`] = setPieceEffects({ setPiece: { route, boxLoad: 'normal' } }, { oppGkAerial: aerial, risk: 1 })
  for (const boxLoad of ['light', 'normal', 'heavy'])
    out[`load.${boxLoad}`] = setPieceEffects({ setPiece: { route: 'far', boxLoad } }, { oppGkAerial: aerial, risk: 1 })
  return { aerial, out }
}

const sp = (route, boxLoad) => ({ setPiece: { route, boxLoad } })

if (MODE === 'route') {
  // 루트 축의 판별자는 상대 GK 제공권이다. 낮은 GK(ecu 74)와 높은 GK(eng 80)를 함께 본다.
  for (const opp of ['ecu', 'eng']) {
    const { aerial, out } = shownMultipliers(opp)
    console.log(`\n[루트] kor vs ${opp} (상대 GK 제공권 ${aerial}) n=${N} base=${BASE}`)
    console.log(`  화면 배수 conversion: near ${out['route.near'].conversion.toFixed(3)}` +
      ` · far ${out['route.far'].conversion.toFixed(3)} · short ${out['route.short'].conversion.toFixed(3)}`)
    const arms = {}
    for (const r of ['near', 'far', 'short']) arms[r] = runArm('kor', opp, sp(r, 'normal'), N, BASE)
    report('near − far', arms.near, arms.far)
    report('short − far', arms.short, arms.far)
    report('near − short', arms.near, arms.short)
  }
} else if (MODE === 'load') {
  // 인원 축의 판별자는 역습 위험(매치업 우위)이다. 낮은 상대(rsa)와 높은 상대(fra).
  for (const opp of ['rsa', 'fra']) {
    const { aerial, out } = shownMultipliers(opp)
    console.log(`\n[인원] kor vs ${opp} (상대 GK 제공권 ${aerial}) n=${N} base=${BASE}`)
    console.log(`  화면 배수 conv÷risk: light ${out['load.light'].conversion.toFixed(2)}÷${out['load.light'].counterRisk.toFixed(2)}` +
      ` · normal ${out['load.normal'].conversion.toFixed(2)}÷${out['load.normal'].counterRisk.toFixed(2)}` +
      ` · heavy ${out['load.heavy'].conversion.toFixed(2)}÷${out['load.heavy'].counterRisk.toFixed(2)}`)
    const arms = {}
    for (const b of ['light', 'normal', 'heavy']) arms[b] = runArm('kor', opp, sp('far', b), N, BASE)
    report('heavy − light', arms.heavy, arms.light)
    report('heavy − normal', arms.heavy, arms.normal)
    report('normal − light', arms.normal, arms.light)
  }
} else if (MODE === 'mark') {
  // 마킹은 **수비 축**이다. 우리 마킹을 바꾸고 상대의 세트피스 위협을 본다.
  // 상대 박스 위협이 높을수록 맨마킹이 유리하다(markingFactor). 위협 높은 상대(eng)와
  // 낮은 상대(rsa)를 함께 본다.
  for (const opp of ['eng', 'rsa']) {
    console.log(`\n[마킹] kor vs ${opp} n=${N} base=${BASE} (우리 수비 마킹만 바꾼다)`)
    const zonal = runArm('kor', opp, { setPiece: { marking: 'zonal' } }, N, BASE, { setPiece: { route: 'far', boxLoad: 'heavy' } })
    const man = runArm('kor', opp, { setPiece: { marking: 'man' } }, N, BASE, { setPiece: { route: 'far', boxLoad: 'heavy' } })
    report('man − zonal', man, zonal)
  }
} else if (MODE === 'grid') {
  for (const opp of ['ecu', 'fra']) {
    const { aerial } = shownMultipliers(opp)
    console.log(`\n[격자] kor vs ${opp} (GK 제공권 ${aerial}) n=${N} base=${BASE}`)
    const base = runArm('kor', opp, sp('far', 'normal'), N, BASE)
    for (const r of ['near', 'far', 'short']) for (const b of ['light', 'normal', 'heavy']) {
      if (r === 'far' && b === 'normal') continue
      report(`${r}/${b} − far/normal`, runArm('kor', opp, sp(r, b), N, BASE), base)
    }
  }
} else {
  console.error(`알 수 없는 모드: ${MODE}`)
}

await server.close()
