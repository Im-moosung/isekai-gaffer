#!/usr/bin/env node
// tools/team-balance/run.mjs
//
// 팀 전력 사다리 실측 하네스 (2026-08-01).
//
// 재는 것:
//   ladder — 한국(랭킹 25) 기본 전술로 상대 11개국을 각 N시드 90분 완주. 승/무/패·평균 득실.
//   zones  — 전 팀의 킥오프 존 전력(공격/미드/수비/GK)과 합성 지표. 데이터 변경의 즉시 진단용.
//   calib  — 팀별 슛/90분을 statBaseline.shotsPerGame과 대조(캘리브레이션 계약).
//
// 결정론: 시드는 --base(기본 7000)에서 31씩 증가하는 정수뿐이다. Math.random·Date 미사용.
//
// 사용:
//   node tools/team-balance/run.mjs zones
//   node tools/team-balance/run.mjs ladder [--n 60] [--base 7000]
//   node tools/team-balance/run.mjs calib  [--n 300]
import { createServer } from 'vite'

const MODE = process.argv[2] ?? 'zones'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d }

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam, TEAM_IDS } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { kickoffZones } = await server.ssrLoadModule('/src/engine/strength.ts')
const { runBatch, checkCalibration } = await server.ssrLoadModule('/src/engine/calibrate.ts')

const ORDER = TEAM_IDS.slice().sort((a, b) => loadTeam(a).fifaRanking - loadTeam(b).fifaRanking)

if (MODE === 'zones') {
  console.log('rank tier team    atk    mid    def     gk   outfield')
  for (const id of ORDER) {
    const t = loadTeam(id)
    const z = kickoffZones(t)
    const outfield = (z.attack + z.midfield + z.defense) / 3
    console.log(
      `${String(t.fifaRanking).padStart(4)}  T${t.tier} ${id.padEnd(4)} ` +
      `${z.attack.toFixed(2).padStart(6)} ${z.midfield.toFixed(2).padStart(6)} ` +
      `${z.defense.toFixed(2).padStart(6)} ${z.gk.toFixed(2).padStart(6)}   ${outfield.toFixed(2)}`)
  }
}

if (MODE === 'ladder') {
  const N = arg('n', 60), BASE = arg('base', 7000)
  const kor = loadTeam('kor')
  console.log(`# kor 기본 전술 · n=${N} · base=${BASE}`)
  console.log('rank tier opp    GF    GA    GD   W/D/L      win%')
  const rows = []
  for (const id of ORDER) {
    if (id === 'kor') continue
    const away = loadTeam(id)
    let w = 0, d = 0, gf = 0, ga = 0
    for (let i = 0; i < N; i++) {
      let st = createMatch(kor, away, { seed: BASE + i * 31 })
      st = simulateSegment(st, 45)
      st = simulateSegment(st, 90)
      gf += st.score[0]; ga += st.score[1]
      if (st.score[0] > st.score[1]) w++
      else if (st.score[0] === st.score[1]) d++
    }
    const gd = (gf - ga) / N
    rows.push({ id, rank: away.fifaRanking, tier: away.tier, gd, w, d, l: N - w - d, win: w / N })
    console.log(
      `${String(away.fifaRanking).padStart(4)}  T${away.tier} ${id.padEnd(4)} ` +
      `${(gf / N).toFixed(2)} ${(ga / N).toFixed(2)} ${gd >= 0 ? '+' : ''}${gd.toFixed(2)}  ` +
      `${w}/${d}/${N - w - d}   ${(w / N * 100).toFixed(0)}%`)
  }
  // 역전 검사: 랭킹이 높은(숫자가 작은) 팀이 낮은 팀보다 한국 승률이 높으면 역전이다.
  console.log('\n# 역전 (랭킹 상위인데 더 쉬운 쌍) — 마진 3%p')
  let bad = 0
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (rows[i].win > rows[j].win + 0.03) { console.log(`  ${rows[i].id}(${rows[i].rank}) ${(rows[i].win * 100).toFixed(0)}% > ${rows[j].id}(${rows[j].rank}) ${(rows[j].win * 100).toFixed(0)}%`); bad++ }
  }
  console.log(`  총 ${bad}건`)
}

if (MODE === 'calib') {
  const N = arg('n', 100)
  // 캘리브레이션 계약을 **엔진의 판정 함수 그대로** 돌린다(checkCalibration).
  // 팀 하나를 전 상대 평균으로 재면 강팀이 약팀을 두들긴 몫까지 섞여 편향된다 —
  // 계약은 어디까지나 **매치업별** 판정이다. 132개 전 매치업을 돌려 최악값을 낸다.
  // 동급 기준 ±15%, 실팀 매치업 완화 기준 ±25%(realdata-calibration.test.ts와 같은 규약).
  console.log(`# 전 매치업 캘리브레이션 · n=${N} · 지표 shotsPerGame·foulsPerGame`)
  const worst = []
  let over15 = 0, over25 = 0, total = 0
  for (const h of TEAM_IDS) for (const a of TEAM_IDS) {
    if (h === a) continue
    const home = loadTeam(h), away = loadTeam(a)
    const rows = checkCalibration(runBatch(home, away, N, 3000), home, away)
      .filter(r => ['shotsPerGame', 'foulsPerGame'].includes(r.metric))
    for (const r of rows) {
      const dev = (r.actual - r.expected) / r.expected
      total++
      if (Math.abs(dev) > 0.15) over15++
      if (Math.abs(dev) > 0.25) over25++
      worst.push({ key: `${h}-${a} ${r.side} ${r.metric}`, dev })
    }
  }
  worst.sort((x, y) => Math.abs(y.dev) - Math.abs(x.dev))
  console.log(`판정 ${total}건 · ±15% 초과 ${over15}건 · ±25% 초과 ${over25}건`)
  for (const w of worst.slice(0, 10)) console.log(`  ${w.key.padEnd(34)} ${(w.dev * 100).toFixed(1)}%`)
}

await server.close()
