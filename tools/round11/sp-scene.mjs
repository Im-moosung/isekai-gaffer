#!/usr/bin/env node
// tools/round11/sp-scene.mjs
//
// 세트피스 코너 루틴의 전수 검증 하네스(11라운드).
//
// 재는 것 — 저술을 고칠 때마다 여기서 먼저 깨진다:
//  1) **dwell 계약**: 마지막 키프레임 t ≤ 0.8 (전 루트 × 인원 × 결과 × 레인).
//  2) **도트 가독성 계약**: 무버가 `shape.separateDots`에 1.85 m 넘게 밀리지 않는다.
//     (`highlight-dots.test.tsx`가 고정한 계약. 박스에 사람을 넣는 저술이라 여기가 조인다.)
//  3) **유저 선택이 보이는가**: 루트가 바뀌면 배달 도착 y가, 인원이 바뀌면 무버 수가 달라진다.
//  4) **GK 접촉 계약**: save 장면의 마지막 키프레임이 골라인 앞 접촉 띠 안이고 contact다.
//  5) **결정론**: 같은 입력 두 번이 같은 좌표.
//
// 사용: node tools/round11/sp-scene.mjs
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { buildSequence } = await server.ssrLoadModule('/src/ui/pitch/choreography.ts')
const { buildScene, SCENE_DWELL_MS, SAVE_CONTACT_M } = await server.ssrLoadModule('/src/ui/pitch/scenes.ts')
const { separateDots, tacticalCoords } = await server.ssrLoadModule('/src/ui/pitch/shape.ts')
const { PITCH_W, PITCH_H } = await server.ssrLoadModule('/src/ui/pitch/geometry.ts')

const ROUTES = ['near', 'far', 'short']
const LOADS = ['light', 'normal', 'heavy']
const FINISHES = ['goal', 'save', 'miss', 'shot', 'chance', 'corner']
const LANES = [0, 1, 2, 3, 4, 5]

let fail = 0
const bad = (msg) => { console.log(`  ✘ ${msg}`); fail++ }

// ── ① dwell 계약 + ③ 유저 선택 가시성 ────────────────────────────────
console.log('[1] dwell 계약 (마지막 t ≤ 0.8) · 전수')
let maxT = 0, maxKey = ''
const deliverY = {}
const moverCount = {}
for (const route of ROUTES) for (const boxLoad of LOADS) for (const finish of FINISHES) for (const lane of LANES) {
  const sc = buildScene('balanced', finish, lane, { setPiece: { route, boxLoad } })
  const last = sc.points[sc.points.length - 1]
  if (last.t > maxT) { maxT = last.t; maxKey = `${sc.key}/${finish}` }
  if (last.t > 0.8) bad(`dwell 초과 ${sc.key} t=${last.t.toFixed(3)}`)
  if (sc.points.some(p => p.movers.length !== sc.roles.length)) bad(`무버 수 불일치 ${sc.key}`)
  if (lane === 0 && finish === 'goal') {
    // 배달 도착 = 마무리 배역(슬롯 0)이 공을 잡는 스테이션의 y.
    const shotStep = sc.points.find(p => p.carrier === 0)
    deliverY[`${route}/${boxLoad}`] = shotStep.movers[0][1]
    moverCount[`${route}/${boxLoad}`] = sc.roles.length
  }
}
console.log(`  최대 t = ${maxT.toFixed(3)} (${maxKey})  ${maxT <= 0.8 ? '✔' : '✘'}`)

console.log('\n[3] 유저 선택이 화면에 보이는가')
for (const boxLoad of LOADS) {
  const ys = ROUTES.map(r => deliverY[`${r}/${boxLoad}`])
  console.log(`  인원 ${boxLoad.padEnd(6)} 무버 ${moverCount[`far/${boxLoad}`]}명 | 마무리 y: ` +
    ROUTES.map((r, i) => `${r} ${ys[i].toFixed(1)}`).join(' · '))
  // 니어(코너 쪽)와 파(반대쪽)는 골문 중앙을 사이에 두고 갈려야 한다.
  if (!(ys[0] > 50 && ys[1] < 50)) bad(`루트가 좌우로 갈리지 않는다 (${boxLoad})`)
  if (Math.abs(ys[0] - ys[1]) < 8) bad(`니어-파 간격이 좁다 (${boxLoad})`)
}
const counts = LOADS.map(b => moverCount[`far/${b}`])
if (!(counts[0] < counts[1] && counts[1] < counts[2])) bad(`박스 인원이 무버 수를 바꾸지 않는다: ${counts}`)

// ── ④ GK 접촉 계약 ────────────────────────────────────────────────
console.log('\n[4] GK 접촉 계약 (save)')
let minGap = Infinity
for (const route of ROUTES) for (const boxLoad of LOADS) for (const lane of LANES) {
  const sc = buildScene('balanced', 'save', lane, { setPiece: { route, boxLoad } })
  const last = sc.points[sc.points.length - 1]
  if (!last.contact) { bad(`save 마지막 키프레임에 contact 없음 ${sc.key}`); continue }
  const m = ((100 - last.ball[0]) / 100) * PITCH_W
  minGap = Math.min(minGap, Math.abs(m - SAVE_CONTACT_M))
  if (m > 3.4) bad(`접촉점이 GK 신전 반경 밖 ${sc.key} ${m.toFixed(2)}m`)
}
console.log(`  접촉점이 전부 골라인 앞 3.4 m 안 ✔ (기준 ${SAVE_CONTACT_M} m)`)

// ── ② 도트 가독성 계약 ─────────────────────────────────────────────
console.log('\n[2] 도트 가독성 — 무버가 분리 패스에 밀리는 최대 거리')
const home = loadTeam('kor'), away = loadTeam('esp')
const teamCoords = (side, key) => side.tactics.lineup.map((_, i) =>
  tacticalCoords(side.tactics.formation, i, key, side.tactics.instructions))
let worst = 0, worstKey = ''
for (const route of ROUTES) for (const boxLoad of LOADS) for (const type of ['corner', 'goal', 'save', 'miss']) {
  const st = createMatch(home, away, { seed: 7 })
  st.home.tactics.setPiece = { route, boxLoad }
  const ev = { minute: 30, type, teamId: type === 'save' ? away.id : home.id, ...(type === 'corner' ? {} : { detail: 'setpiece' }) }
  const seq = buildSequence(ev, st.home, st.away)
  if (seq.length === 0) continue
  for (const step of seq) {
    const hc = teamCoords(st.home, 'home')
    const ac = teamCoords(st.away, 'away')
    const byId = new Map(step.movers.map(m => [m.playerId, m]))
    st.home.tactics.lineup.forEach((s, i) => { const m = byId.get(s.playerId); if (m) hc[i] = { x: m.x, y: m.y } })
    const sep = separateDots([...hc, ...ac])
    st.home.tactics.lineup.forEach((s, i) => {
      if (!byId.has(s.playerId)) return
      const d = Math.hypot(((sep[i].x - hc[i].x) / 100) * PITCH_W, ((sep[i].y - hc[i].y) / 100) * PITCH_H)
      if (d > worst) { worst = d; worstKey = `${route}/${boxLoad}/${type} ${s.playerId}` }
    })
  }
}
console.log(`  최대 밀림 ${worst.toFixed(2)} m (${worstKey}) ${worst <= 1.85 ? '✔' : '✘ 계약 1.85 m'}`)
if (worst > 1.85) fail++

// ── ⑤ 결정론 ──────────────────────────────────────────────────────
console.log('\n[5] 결정론')
const a = JSON.stringify(buildScene('balanced', 'goal', 3, { setPiece: { route: 'near', boxLoad: 'heavy' } }))
const b = JSON.stringify(buildScene('balanced', 'goal', 3, { setPiece: { route: 'near', boxLoad: 'heavy' } }))
console.log(`  같은 입력 두 번이 같은 좌표 ${a === b ? '✔' : '✘'}`)
if (a !== b) fail++

console.log(`\n${fail === 0 ? '전부 통과' : `실패 ${fail}건`}`)
await server.close()
process.exitCode = fail === 0 ? 0 : 1
