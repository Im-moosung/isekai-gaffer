#!/usr/bin/env node
// tools/sim-audit/shots.mjs
// R5 계측 — ① 슛 발사점↔골대 거리 분포, ② 킥 임팩트 순간의 yaw vs 볼 출발 방향 오차.
//
// 왜 별도 스크립트인가: run.mjs는 "슛 **종점**"(빗나감 거리)을 재고, 여기서 필요한 것은
// "슛 **발사점**"과 "차는 사람이 어디를 보고 있나"다. 둘 다 run.mjs가 재지 않는다.
//
// ① 은 두 층으로 잰다.
//   (a) 라이브러리 전수 — 패턴 4 × 빌드업 2 × 마무리 3 × 레인 6 = 144조합/마무리.
//       저술이 만들 수 있는 분포의 정의역 전체다.
//   (b) 90분 실주행 — 임팩트 프레임에서 **실제 슈터의 월드 좌표**를 잰다. 앵커링·속도
//       클램프를 거친 뒤라 화면에 보이는 값은 이쪽이다.
// ② 는 실주행에서만 의미가 있다(yaw는 프레임 적분의 결과다).
//
// 실측 대조군: statsbomb/open-data 오픈플레이 슛 8,348건(350경기 무작위 표본).
//
// 사용: node tools/sim-audit/shots.mjs [--fps 60] [--seeds 42,7,99]
import { createServer } from 'vite'

const argN = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d }
const argS = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const FPS = argN('--fps', 60)
const SEEDS = argS('--seeds', '42,7,99,2026').split(',').map(Number)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = p => server.ssrLoadModule(p)

const { makeTestTeam } = await L('/src/engine/fixtures/testTeams.ts')
const sim = await L('/src/engine/simulate.ts')
const { buildSequence } = await L('/src/ui/pitch/choreography.ts')
const { buildFlowSequence } = await L('/src/ui/pitch/flow.ts')
const scenes = await L('/src/ui/pitch/scenes.ts')
const mv = await L('/src/ui/pitch/three/movement.ts')
const pb = await L('/src/ui/match/playback.ts')
const { pickDramaEvent } = await L('/src/game/drama.ts')
const { toWorld, PITCH_W, PITCH_H } = await L('/src/ui/pitch/three/types.ts')

const HALF_W = PITCH_W / 2
/** 페널티 박스 깊이(m) — 골라인에서 16.5. 박스 안/밖 판정의 기준. */
const BOX_D = 16.5
/** 페널티 박스 반폭(m) — 40.32 / 2. */
const BOX_HALF = 20.16

const pct = (arr, p) => {
  if (arr.length === 0) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—')

/** 골문 중앙(공격 방향 오른쪽)까지의 거리(m). 실측 대조군과 같은 정의. */
const goalDist = (w, side) => Math.hypot((side === 'home' ? HALF_W : -HALF_W) - w.x, w.z)
/** 페널티 박스 안인가 — 골라인에서 16.5 m 이내 & 폭 40.32 m 이내. */
const inBox = (w, side) =>
  Math.abs((side === 'home' ? HALF_W : -HALF_W) - w.x) <= BOX_D && Math.abs(w.z) <= BOX_HALF

const patterns = ['balanced', 'cross', 'through', 'longshot']
const finishes = ['goal', 'save', 'miss', 'shot']

// ─────────────────────────────────────────────────────────────────────────
// ① (a) 라이브러리 전수 — 슛 발사점
// ─────────────────────────────────────────────────────────────────────────
console.log('# 슛 거리 · 킥 yaw 계측')
console.log(`\n실측 대조군(statsbomb/open-data 오픈플레이 8,348건, 350경기 무작위):`)
console.log('  p25 10.7 · **p50 16.1** · p75 22.2 · p90 27.1 · p95 30.0 · p99 37.2 m · 박스 안 63.8%')
console.log('  구간: 0~6 4.6% · 6~11 21.6% · 11~16.5 25.4% · 16.5~20 14.3% · 20~25 18.8% · 25~30 10.2% · 30~35 3.4% · 35+ 1.6%')

console.log('\n## ① (a) 슛 발사점 — 장면 라이브러리 전수 (home 프레임)')
console.log('\n| 패턴 | 조합 | p10 | p25 | **p50** | p75 | p90 | max | 박스 안 | 25 m 초과 | 30 m 초과 |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
const byPattern = {}
for (const p of patterns) {
  const ds = []
  let box = 0
  for (const finish of finishes) {
    for (let b = 0; b < scenes.BUILDUP_VARIANT_COUNT; b++) {
      for (let f = 0; f < scenes.FINISH_VARIANT_COUNT; f++) {
        for (let l = 0; l < scenes.LANE_COUNT; l++) {
          const sc = scenes.buildScene(p, finish, l, { buildup: b, finish: f })
          // 슛 스테이션 = 마지막에서 두 번째 키프레임(마지막은 결과 지점).
          const shotPt = sc.points[sc.points.length - 2]
          const w = toWorld(shotPt.ball[0], shotPt.ball[1])
          ds.push(goalDist(w, 'home'))
          if (inBox(w, 'home')) box++
        }
      }
    }
  }
  byPattern[p] = ds
  console.log(`| ${p} | ${ds.length} | ${f1(pct(ds, 0.1))} | ${f1(pct(ds, 0.25))} | **${f1(pct(ds, 0.5))}** | ` +
    `${f1(pct(ds, 0.75))} | ${f1(pct(ds, 0.9))} | ${f1(Math.max(...ds))} | ` +
    `${((box / ds.length) * 100).toFixed(0)}% | ${((ds.filter(d => d > 25).length / ds.length) * 100).toFixed(0)}% | ` +
    `${((ds.filter(d => d > 30).length / ds.length) * 100).toFixed(0)}% |`)
}
const spread = pct(byPattern.longshot, 0.5) - pct(byPattern.balanced, 0.5)
console.log(`\n- **패턴 대비(longshot p50 − balanced p50): ${f1(spread)} m** — 유저 전술이 화면에서 갈리는 폭.`)

// ─────────────────────────────────────────────────────────────────────────
// 90분 실주행 — ① (b) 실제 발사점, ② 킥 yaw 오차
// ─────────────────────────────────────────────────────────────────────────
function runMatch(seed) {
  const home = makeTestTeam('kor', 82)
  const away = makeTestTeam('esp', 84)
  let engine = sim.createMatch(home, away, { seed })
  const dt = 1 / FPS
  /** 임팩트 프레임 기록: { kind, arc, side, yawErr(deg), shotDist(m), inBox } */
  const impacts = []
  let prev = null
  let guard = 0

  while (engine.minute < 90 && guard++ < 200) {
    const minute = engine.minute
    const evs = engine.events.filter(e => e.minute === minute)
    const drama = pickDramaEvent(evs)
    let seq = null
    let side = 'home'
    let event = null
    let kind = 'flow'
    if (drama) {
      const s = buildSequence(drama, engine.home, engine.away)
      if (s.length > 0 && pb.isHighlightEvent(drama)) {
        seq = s
        side = drama.teamId === engine.home.team.id ? 'home' : 'away'
        event = drama
        kind = `hl:${drama.type}`
      }
    }
    if (!seq) {
      const fl = buildFlowSequence(engine, minute, seed)
      if (fl.seq.length > 0) { seq = fl.seq; side = fl.side; kind = 'flow' }
    }
    const dwellMs = pb.minuteDwellMs(minute, evs, 1, false, 0, 0)
    const nFrames = Math.max(1, Math.round((dwellMs / 1000) * FPS))
    // 안무의 공격 방향(save는 teamId가 수비 팀이므로 movement와 같은 규칙을 쓴다).
    const atkSide = event ? (event.type === 'save' ? (side === 'home' ? 'away' : 'home') : side) : side
    const kicks = seq ? mv.kickEvents(seq) : []

    for (let i = 0; i <= nFrames; i++) {
      const t = Math.min(1, i / nFrames)
      const fr = mv.computeFrame({
        state: engine, minute, t, prev, dt, sequence: seq, sequenceSide: side, seed, event, dwellMs, cut: i === 0,
      })
      // ── 임팩트 프레임 검출: 이 프레임에서 |t − tImpact|가 최소인 킥 ──
      for (const k of kicks) {
        const half = 0.5 / nFrames
        if (Math.abs(t - k.tImpact) > half) continue
        const kicker = fr.players.find(p => p.id === k.playerId)
        if (!kicker || kicker.action !== 'kick') continue
        const si = k.stepIndex
        const a = toWorld(seq[si].ball.x, seq[si].ball.y)
        const b = toWorld(seq[si + 1].ball.x, seq[si + 1].ball.y)
        // 볼 출발 방향은 **저술 궤적**이 정본이다(앵커링은 출발점만 옮긴다).
        const want = Math.atan2(b.z - a.z, b.x - a.x)
        // 실제 비행 방향 — 공은 차는 선수의 발에 앵커링되므로 "그 선수 → 저술 도착점"이다.
        const real = Math.atan2(b.z - kicker.z, b.x - kicker.x)
        const wrap = v => { while (v > Math.PI) v -= Math.PI * 2; while (v < -Math.PI) v += Math.PI * 2; return v }
        const e = wrap(kicker.yaw - want)
        const e2 = wrap(kicker.yaw - real)
        const isShot = (seq[si].arc ?? '') === 'shot'
        const w = { x: kicker.x, z: kicker.z }
        const authored = toWorld(seq[si].ball.x, seq[si].ball.y)
        impacts.push({
          minute, kind, side: atkSide,
          arc: seq[si].arc ?? 'pass',
          yawErr: Math.abs((e * 180) / Math.PI),
          yawErrReal: Math.abs((e2 * 180) / Math.PI),
          shotDist: isShot ? goalDist(w, atkSide) : NaN,
          inBox: isShot ? inBox(w, atkSide) : null,
          lag: Math.hypot(w.x - authored.x, w.z - authored.z),
          authoredDist: isShot ? goalDist(authored, atkSide) : NaN,
        })
      }
      prev = fr
    }
    engine = sim.simulateSegment(engine, minute + 1)
  }
  return impacts
}

const all = []
for (const seed of SEEDS) all.push(...runMatch(seed))

console.log(`\n## ① (b) 슛 발사점 — 90분 실주행 × ${SEEDS.length}시드 (임팩트 프레임의 실제 슈터 좌표)`)
const shots = all.filter(r => Number.isFinite(r.shotDist))
const shotBy = k => shots.filter(r => r.kind === k)
console.log('\n| 국면 | 슛 | p10 | p25 | **p50** | p75 | p90 | max | 박스 안 | 25 m 초과 | 30 m 초과 |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const k of [...new Set(shots.map(r => r.kind))].sort().concat('ALL')) {
  const rs = k === 'ALL' ? shots : shotBy(k)
  if (rs.length === 0) continue
  const d = rs.map(r => r.shotDist)
  console.log(`| ${k} | ${rs.length} | ${f1(pct(d, 0.1))} | ${f1(pct(d, 0.25))} | **${f1(pct(d, 0.5))}** | ` +
    `${f1(pct(d, 0.75))} | ${f1(pct(d, 0.9))} | ${f1(Math.max(...d))} | ` +
    `${((rs.filter(r => r.inBox).length / rs.length) * 100).toFixed(0)}% | ` +
    `${((d.filter(v => v > 25).length / d.length) * 100).toFixed(0)}% | ` +
    `${((d.filter(v => v > 30).length / d.length) * 100).toFixed(0)}% |`)
}

{
  const lag = shots.map(r => r.lag)
  console.log(`\n- 임팩트 시점 **슈터 위치 − 저술 슛 지점 어긋남**: p50 ${f1(pct(lag, 0.5))} · p90 ${f1(pct(lag, 0.9))} · max ${f1(Math.max(...lag))} m`)
  const ad = shots.map(r => r.authoredDist)
  console.log(`- 같은 슛의 **저술** 거리: p50 ${f1(pct(ad, 0.5))} · p90 ${f1(pct(ad, 0.9))} · max ${f1(Math.max(...ad))} m · 박스 안 ${((ad.filter(v => v <= 16.5).length / ad.length) * 100).toFixed(0)}%`)
  for (const r of shots.filter(r => r.shotDist > 30).sort((a, b) => b.shotDist - a.shotDist)) {
    console.log(`  · ${r.minute}' ${r.kind} ${r.side} 실제 ${f1(r.shotDist)} m / 저술 ${f1(r.authoredDist)} m / 어긋남 ${f1(r.lag)} m`)
  }
}

console.log('\n## ② 킥 임팩트 순간 yaw 오차 (|yaw − 볼 출발 방향|, deg)')
console.log('\n| 궤적 | 킥 | p25 | **p50** | p75 | p90 | max | 30° 초과 | 90° 초과(뒤돌아 참) |')
console.log('|---|---|---|---|---|---|---|---|---|')
for (const arc of ['ground', 'pass', 'cross', 'shot', 'ALL']) {
  const rs = arc === 'ALL' ? all : all.filter(r => r.arc === arc)
  if (rs.length === 0) continue
  const e = rs.map(r => r.yawErr)
  const r2 = rs.map(x => x.yawErrReal)
  console.log(`| ${arc} | ${rs.length} | ${f1(pct(e, 0.25))} | **${f1(pct(e, 0.5))}** | ${f1(pct(e, 0.75))} | ` +
    `${f1(pct(e, 0.9))} | ${f1(Math.max(...e))} | ` +
    `${((e.filter(v => v > 30).length / e.length) * 100).toFixed(0)}% | ` +
    `${((e.filter(v => v > 90).length / e.length) * 100).toFixed(0)}% | ` +
    `**${f1(pct(r2, 0.5))}** | ${f1(pct(r2, 0.9))} | ${((r2.filter(v => v > 30).length / r2.length) * 100).toFixed(0)}% |`)
}

void PITCH_H
await server.close()
