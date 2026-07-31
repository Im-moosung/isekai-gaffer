#!/usr/bin/env node
// tools/sim-audit/run.mjs
// 3D 경기 연출 4대 불만의 **전 구간 계측**. 90분 실주행을 60 fps로 프레임 단위 재생하며
// MatchScreen과 **같은 규칙**(pickDramaEvent → isHighlightEvent → 하이라이트/flow)으로
// 시퀀스를 고르고 dwell을 계산한다.
//
// 재는 것:
//  ① 볼-캐리어 거리 (전 구간·국면별) — "차는 것과 무관하게 움직이는 공"
//  ② 선수 속도·가속도 급변 — "이상하게 움직이는 선수"
//  ③ 슛 종점 ↔ 골대 거리 — "너무 멀찍하게 빗나간다"
//  ④ GK 손-공 거리 시간축 + 접촉 지속 프레임 — "공이 손에 안 붙는다"
//
// 사용: node tools/sim-audit/run.mjs [--fps 60] [--seed 42] [--seeds 42,7,99] [--json out.json]
import { createServer } from 'vite'

const argN = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d }
const argS = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const FPS = argN('--fps', 60)
const SEEDS = argS('--seeds', String(argN('--seed', 42))).split(',').map(Number)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = p => server.ssrLoadModule(p)

const { makeTestTeam } = await L('/src/engine/fixtures/testTeams.ts')
const sim = await L('/src/engine/simulate.ts')
const { buildSequence } = await L('/src/ui/pitch/choreography.ts')
const { buildFlowSequence } = await L('/src/ui/pitch/flow.ts')
const scenes = await L('/src/ui/pitch/scenes.ts')
const mv = await L('/src/ui/pitch/three/movement.ts')
const poseM = await L('/src/ui/pitch/three/pose.ts')
const pb = await L('/src/ui/match/playback.ts')
const { pickDramaEvent } = await L('/src/game/drama.ts')
const cam = await L('/src/ui/pitch/three/camera.ts')
const { toWorld, PITCH_W } = await L('/src/ui/pitch/three/types.ts')

const HALF_W = PITCH_W / 2
/** 골문 반폭(m) — 규정 7.32 m. 포스트는 z = ±3.66. */
const GOAL_HALF_Z = 3.66
/** 크로스바 높이(m). */
const CROSSBAR = 2.44
/** GK 완전 신전 손 도달 반경(m) — movement.GK_DIVE_REACH. */
const GK_REACH = mv.GK_DIVE_REACH ?? 2.0

const pct = (arr, p) => {
  if (arr.length === 0) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—')

// ─────────────────────────────────────────────────────────────────────────
// 90분 실주행
// ─────────────────────────────────────────────────────────────────────────
function runMatch(seed) {
  const home = makeTestTeam('kor', 82)
  const away = makeTestTeam('esp', 84)
  let engine = sim.createMatch(home, away, { seed })
  // 킥오프까지 진행시킨다(createMatch 직후 상태 규약은 엔진에 맡긴다).
  const dt = 1 / FPS

  const rows = []            // 프레임별 기록
  const scenesSeen = []      // 분별 요약
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
        seq = s; side = drama.teamId === engine.home.team.id ? 'home' : 'away'
        event = drama; kind = `hl:${drama.type}`
      }
    }
    if (!seq) {
      const fl = buildFlowSequence(engine, minute, seed)
      if (fl.seq.length > 0) { seq = fl.seq; side = fl.side; kind = 'flow' }
    }
    const dwellMs = pb.minuteDwellMs(minute, evs, 1, false, 0, 0)
    const nFrames = Math.max(1, Math.round((dwellMs / 1000) * FPS))

    const minuteRows = []
    for (let i = 0; i <= nFrames; i++) {
      const t = Math.min(1, i / nFrames)
      const fr = mv.computeFrame({
        state: engine, minute, t, prev, dt, sequence: seq, sequenceSide: side, seed, event, dwellMs, cut: i === 0,
      })
      // ── ① 볼-캐리어 / 볼-최근접 ──
      let nearest = Infinity
      let nearestId = null
      for (const p of fr.players) {
        const d = Math.hypot(p.x - fr.ball.x, p.z - fr.ball.z)
        if (d < nearest) { nearest = d; nearestId = p.id }
      }
      // 저술 캐리어 — 이 시각에 공을 소유해야 하는 선수(구간 시작 스텝의 carrier).
      //  · held  : 구간 양끝의 carrier가 같다(드리블·컨트롤 정지) → 공은 **내내 발밑**이어야 한다
      //  · flight: 구간 양끝의 carrier가 다르다(패스·슛) → 공이 떨어지는 것이 정상이고,
      //            대신 **출발 순간 차는 사람 / 도착 순간 받는 사람**과의 거리만 본다
      let carrierId = null
      let phase = 'free'
      let k = 0
      if (seq) {
        for (let j = 0; j < seq.length - 1; j++) if (t >= seq[j].t) k = j
        const past = t >= seq[seq.length - 1].t
        const a = seq[k]
        const b = seq[k + 1]
        if (past) {
          carrierId = seq[seq.length - 1].carrier ?? null
          phase = carrierId ? 'held' : 'free'
        } else if (a.carrier && b && a.carrier === b.carrier) {
          carrierId = a.carrier
          phase = 'held'
        } else if (a.carrier) {
          carrierId = a.carrier
          phase = 'flight'
        }
      }
      const carrier = carrierId ? fr.players.find(p => p.id === carrierId) : null
      const carrierD = carrier ? Math.hypot(carrier.x - fr.ball.x, carrier.z - fr.ball.z) : NaN
      const heldD = phase === 'held' ? carrierD : NaN
      // 출발/도착 순간(구간 경계 ±1 프레임)의 킥/리시브 거리
      let boundaryD = NaN
      if (seq && phase !== 'free') {
        const a = seq[k]
        const b = seq[k + 1]
        if (b && Math.abs(t - a.t) < 1 / (nFrames || 1)) boundaryD = carrierD
        else if (b && b.carrier && Math.abs(t - b.t) < 1 / (nFrames || 1)) {
          const rec = fr.players.find(p => p.id === b.carrier)
          if (rec) boundaryD = Math.hypot(rec.x - fr.ball.x, rec.z - fr.ball.z)
        }
      }
      const flying = phase !== 'held'

      // ── ② 선수 운동 ──
      // 속도 벡터의 프레임 간 변화(= 실제 가속도). 스칼라 speed가 아니라 벡터로 재야
      // "속도는 같은데 방향만 꺾었다"가 잡힌다.
      let maxAcc = 0, maxAccId = null, teleports = 0
      if (prev) {
        const pm = new Map(prev.players.map(p => [p.id, p]))
        for (const p of fr.players) {
          const q = pm.get(p.id)
          if (!q) continue
          if (Math.hypot(p.x - q.x, p.z - q.z) / dt > 8.0) teleports++
          const a = Math.hypot((p.vx ?? 0) - (q.vx ?? 0), (p.vz ?? 0) - (q.vz ?? 0)) / dt
          if (a > maxAcc) { maxAcc = a; maxAccId = p.id }
        }
      }

      // ── ④ GK 손-공 ──
      const gkHome = fr.players.find(p => p.side === 'home' && p.action === 'dive')
      const gkAway = fr.players.find(p => p.side === 'away' && p.action === 'dive')
      const diver = gkHome ?? gkAway
      const gkBallD = diver ? Math.hypot(diver.x - fr.ball.x, diver.z - fr.ball.z) : NaN
      // 실제 손 위치(pose.diveHandLocal 순기구학 + yaw 회전) ↔ 공 중심의 3D 거리.
      let handD = NaN
      if (diver) {
        const l = poseM.diveHandLocal(diver.actionT, diver.actionDir ?? 1)
        const cy = Math.cos(diver.yaw), sy = Math.sin(diver.yaw)
        const hx = diver.x + l.x * cy - l.z * sy
        const hz = diver.z + l.x * sy + l.z * cy
        handD = Math.hypot(hx - fr.ball.x, l.y - fr.ball.y, hz - fr.ball.z)
      }

      const row = {
        minute, t, ms: t * dwellMs, kind, nearest, nearestId, carrierId, carrierD, heldD, boundaryD, phase, flying,
        ball: { x: fr.ball.x, y: fr.ball.y, z: fr.ball.z },
        maxAcc, maxAccId, teleports,
        gkBallD, handD, gkAction: diver ? diver.actionT : NaN,
        players: fr.players.map(p => ({ id: p.id, x: p.x, z: p.z, s: p.speed, a: p.action })),
      }
      minuteRows.push(row)
      rows.push(row)
      prev = fr
    }
    scenesSeen.push({ minute, kind, dwellMs, frames: minuteRows.length, seqLen: seq ? seq.length : 0 })
    engine = sim.simulateSegment(engine, minute + 1)
  }
  return { rows, scenesSeen, home, away }
}

// ─────────────────────────────────────────────────────────────────────────
// 리포트
// ─────────────────────────────────────────────────────────────────────────
console.log(`# 3D 연출 계측 — ${FPS} fps, seeds ${SEEDS.join(',')}`)

for (const seed of SEEDS) {
  const { rows, scenesSeen } = runMatch(seed)
  console.log(`\n## seed ${seed} — ${scenesSeen.length}분, ${rows.length} 프레임`)

  // ── ① 볼-캐리어 거리 ──
  console.log('\n### ① 볼-캐리어 거리 (국면별, m)')
  console.log('소유(held) = 구간 양끝 캐리어 동일(드리블·컨트롤 정지) → 공은 발밑이어야 한다.')
  console.log('비행(flight) = 패스·슛 구간 → 멀어지는 것이 정상. 경계(boundary) = 차는/받는 순간.')
  console.log('')
  console.log('| 국면 | 프레임 | 소유 프레임 | **소유 중 볼-발 p50** | p90 | max | 경계(킥·리시브) p50 | p90 | 최근접 선수 p50 | p90 | max |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  const kinds = [...new Set(rows.map(r => r.kind))].sort()
  for (const k of [...kinds, 'ALL']) {
    const rs = k === 'ALL' ? rows : rows.filter(r => r.kind === k)
    const hd = rs.filter(r => Number.isFinite(r.heldD)).map(r => r.heldD)
    const bd = rs.filter(r => Number.isFinite(r.boundaryD)).map(r => r.boundaryD)
    const nd = rs.map(r => r.nearest)
    console.log(`| ${k} | ${rs.length} | ${hd.length} (${((hd.length / rs.length) * 100).toFixed(0)}%) | ` +
      `**${f2(pct(hd, 0.5))}** | ${f2(pct(hd, 0.9))} | ${f2(hd.length ? Math.max(...hd) : NaN)} | ` +
      `${f2(pct(bd, 0.5))} | ${f2(pct(bd, 0.9))} | ` +
      `${f2(pct(nd, 0.5))} | ${f2(pct(nd, 0.9))} | ${f2(Math.max(...nd))} |`)
  }
  // 소유 중 이탈이 **분의 어디에서** 일어나는가 — 장면 시작 직후인가, 내내인가.
  console.log('\n  소유(held) 중 볼-발 거리의 분내 시각 분포:')
  console.log('  | t 구간 | 프레임 | p50 | p90 | max | 1.5 m 초과 |')
  console.log('  |---|---|---|---|---|---|')
  for (const [lo, hi] of [[0, 0.1], [0.1, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]) {
    const rs = rows.filter(r => Number.isFinite(r.heldD) && r.t >= lo && r.t < hi).map(r => r.heldD)
    if (rs.length === 0) continue
    console.log(`  | ${lo}~${hi} | ${rs.length} | ${f2(pct(rs, 0.5))} | ${f2(pct(rs, 0.9))} | ${f2(Math.max(...rs))} | ${rs.filter(v => v > 1.5).length} |`)
  }
  console.log('')
  const heldAll = rows.filter(r => Number.isFinite(r.heldD))
  const detached = heldAll.filter(r => r.heldD > 1.5)
  console.log(`\n- **소유 구간인데 볼-발 1.5 m 초과: ${detached.length} / ${heldAll.length}** ` +
    `(${((detached.length / Math.max(1, heldAll.length)) * 100).toFixed(1)}%) — 저술 목표는 ${scenes.FOOT_OFFSET_M} m`)
  // 캐리어가 아예 없는 채로 공이 움직인 프레임(비행이 아닌데 자유)
  const freeMoving = []
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    if (b.minute !== a.minute) continue
    const v = Math.hypot(b.ball.x - a.ball.x, b.ball.z - a.ball.z) * FPS
    if (b.flying && v > 0.5 && b.nearest > 3.0) freeMoving.push({ ...b, v })
  }
  console.log(`- 캐리어 없이 움직이며 최근접 선수 3 m 초과: ${freeMoving.length} 프레임 ` +
    `(${((freeMoving.length / rows.length) * 100).toFixed(1)}%) — 국면: ` +
    Object.entries(freeMoving.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}))
      .map(([k, v]) => `${k}:${v}`).join(' '))

  // 분 경계 볼 점프
  const jumps = []
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    if (b.minute === a.minute) continue
    jumps.push({ from: a.minute, to: b.minute, a: a.kind, b: b.kind, d: Math.hypot(b.ball.x - a.ball.x, b.ball.z - a.ball.z) })
  }
  const jd = jumps.map(j => j.d)
  console.log(`- **분 경계 볼 순간이동**: ${jumps.length}회, p50 ${f2(pct(jd, 0.5))} m · p90 ${f2(pct(jd, 0.9))} m · max ${f2(Math.max(...jd))} m`)
  // 3D가 실제로 보이는 전환(하이라이트 → 하이라이트)만 추려낸다 — 작전판이 덮는 전환은 안 보인다.
  const vis = jumps.filter(j => j.a.startsWith('hl:') && j.b.startsWith('hl:'))
  const vd = vis.map(j => j.d)
  console.log(`  - 그중 **3D가 계속 보이는 전환(하이라이트→하이라이트)**: ${vis.length}회` +
    (vis.length ? `, p50 ${f2(pct(vd, 0.5))} m · max ${f2(Math.max(...vd))} m — ${vis.map(j => `${j.from}'→${j.to}' ${j.d.toFixed(0)}m`).join(', ')}` : ''))

  // ── ② 선수 운동 ──
  console.log('\n### ② 선수 운동')
  const accs = rows.map(r => r.maxAcc).filter(Number.isFinite)
  console.log(`- 프레임 최대 |Δv|/dt: p50 ${f2(pct(accs, 0.5))} · p90 ${f2(pct(accs, 0.9))} · p99 ${f2(pct(accs, 0.99))} · max ${f2(Math.max(...accs))} m/s²`)
  const overAcc = accs.filter(a => a > 8).length
  console.log(`- 8 m/s² 초과(문헌 상한 7~8) 프레임: ${overAcc} (${((overAcc / accs.length) * 100).toFixed(1)}%)`)
  const over20 = accs.filter(a => a > 20).length
  console.log(`- 20 m/s² 초과 프레임: ${over20} (${((over20 / accs.length) * 100).toFixed(1)}%)`)
  // 남은 급변이 **어디서** 나오는가 — 분의 첫 프레임인가, 액션 전환인가, 밀어내기인가.
  const spikes = rows.filter(r => r.maxAcc > 50)
  const firstFrame = spikes.filter(r => r.t === 0).length
  console.log(`  - 50 m/s² 초과 ${spikes.length}프레임 중 **분의 첫 프레임(t=0)**: ${firstFrame} (${((firstFrame / Math.max(1, spikes.length)) * 100).toFixed(0)}%)`)
  const byT = {}
  for (const r of spikes) { const b = r.t === 0 ? 't=0' : r.t < 0.1 ? 't<0.1' : r.t < 0.5 ? 't<0.5' : 't>=0.5'; byT[b] = (byT[b] ?? 0) + 1 }
  console.log(`  - 분포: ${Object.entries(byT).map(([k, v]) => `${k}:${v}`).join(' ')}`)
  // 방향 급변: 연속 3프레임의 속도벡터 각도 차
  let turnCount = 0, turnTotal = 0
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i - 2], b = rows[i - 1], c = rows[i]
    if (a.minute !== c.minute) continue
    const bm = new Map(b.players.map(p => [p.id, p]))
    const am = new Map(a.players.map(p => [p.id, p]))
    for (const p of c.players) {
      const q = bm.get(p.id), o = am.get(p.id)
      if (!q || !o) continue
      const v1 = { x: q.x - o.x, z: q.z - o.z }
      const v2 = { x: p.x - q.x, z: p.z - q.z }
      const l1 = Math.hypot(v1.x, v1.z), l2 = Math.hypot(v2.x, v2.z)
      if (l1 < 0.02 || l2 < 0.02) continue // 0.02 m/frame ≈ 1.2 m/s
      turnTotal++
      const cosang = (v1.x * v2.x + v1.z * v2.z) / (l1 * l2)
      if (cosang < Math.cos((60 * Math.PI) / 180)) turnCount++
    }
  }
  console.log(`- 1 프레임에 60° 초과 방향 전환(속도 1.2 m/s 이상): ${turnCount} / ${turnTotal} (${((turnCount / Math.max(1, turnTotal)) * 100).toFixed(2)}%)`)
  // 제자리 진동: 같은 선수가 20프레임 안에 방향을 4회 이상 뒤집으면서 순변위 < 0.5 m
  let jitterPlayers = 0
  const ids = rows[0].players.map(p => p.id)
  for (const id of ids) {
    let worst = 0
    for (let i = 40; i < rows.length; i += 20) {
      if (rows[i].minute !== rows[i - 40].minute) continue
      const seg = rows.slice(i - 40, i + 1).map(r => r.players.find(p => p.id === id)).filter(Boolean)
      if (seg.length < 40) continue
      let flips = 0
      for (let j = 2; j < seg.length; j++) {
        const v1 = { x: seg[j - 1].x - seg[j - 2].x, z: seg[j - 1].z - seg[j - 2].z }
        const v2 = { x: seg[j].x - seg[j - 1].x, z: seg[j].z - seg[j - 1].z }
        const l1 = Math.hypot(v1.x, v1.z), l2 = Math.hypot(v2.x, v2.z)
        if (l1 < 0.005 || l2 < 0.005) continue
        if ((v1.x * v2.x + v1.z * v2.z) / (l1 * l2) < 0) flips++
      }
      const net = Math.hypot(seg[seg.length - 1].x - seg[0].x, seg[seg.length - 1].z - seg[0].z)
      let path = 0
      for (let j = 1; j < seg.length; j++) path += Math.hypot(seg[j].x - seg[j - 1].x, seg[j].z - seg[j - 1].z)
      if (flips >= 8 && path > 0.6 && net < 0.4 * path) worst++
    }
    if (worst > 0) jitterPlayers++
  }
  console.log(`- 제자리 진동(0.67 s 창에서 방향 반전 8회+ & 순변위 < 경로 40%) 검출 선수: ${jitterPlayers} / ${ids.length}`)

  // ── ④ GK 손-공 ──
  console.log('\n### ④ GK 손-공 (다이브 프레임)')
  const byMin = new Map()
  for (const r of rows) if (Number.isFinite(r.gkBallD)) {
    if (!byMin.has(r.minute)) byMin.set(r.minute, [])
    byMin.get(r.minute).push(r)
  }
  console.log('| 분 | 국면 | 다이브 프레임 | 몸통-볼 최소 | **실측 손-공 최소** | 손-공 ≤0.3 m 프레임 | 지속 ms | 신전(t=0.55) 시점 손-공 |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [m, rs] of [...byMin].sort((a, b) => a[0] - b[0])) {
    const min = Math.min(...rs.map(r => r.gkBallD))
    const hands = rs.map(r => r.handD).filter(Number.isFinite)
    const touch = hands.filter(g => g <= 0.3).length
    const lay = rs.reduce((b, r) => (Math.abs(r.gkAction - 0.55) < Math.abs(b.gkAction - 0.55) ? r : b), rs[0])
    console.log(`| ${m} | ${rs[0].kind} | ${rs.length} | ${f2(min)} | **${f2(Math.min(...hands))}** | ${touch} | ${(touch * (1000 / FPS)).toFixed(0)} | ${f2(lay.handD)} |`)
  }
  void GK_REACH
  if (byMin.size === 0) console.log('| — | 다이브 프레임 없음 | | | | | |')

  // 잡는 세이브 / 쳐내는 세이브 각각 하나씩 **시간축**을 찍는다 — 정지 표가 아니라
  // "접촉 후 공이 손에 남는가, 튕겨 나가는가"를 보여야 두 배역이 구분된다.
  const saveMins = [...byMin].filter(([, rs]) => rs[0].kind === 'hl:save')
  const withTouch = saveMins.map(([m, rs]) => {
    const hands = rs.map(r => r.handD).filter(Number.isFinite)
    return { m, rs, hold: hands.filter(g => g <= 0.3).length }
  })
  const catchPick = withTouch.filter(x => x.hold >= 30).sort((a, b) => b.hold - a.hold)[0]
  const punchPick = withTouch.filter(x => x.hold > 0 && x.hold < 30).sort((a, b) => a.hold - b.hold)[0]
  for (const [label, pick] of [['잡는 세이브(캐치)', catchPick], ['쳐내는 세이브(펀칭)', punchPick]]) {
    if (!pick) { console.log(`\n${label}: 이 시드에서는 나오지 않았다`); continue }
    console.log(`\n**${label} — ${pick.m}' 손-공 거리 시간축(접촉 전후 ±0.6 s, 60 fps 중 6프레임마다)**`)
    const rs = pick.rs
    const ci = rs.findIndex(r => r.handD <= 0.3)
    const from = Math.max(0, ci - 36)
    const to = Math.min(rs.length - 1, ci + 72)
    const cells = []
    for (let i = from; i <= to; i += 6) {
      cells.push(`${((i - ci) * (1000 / FPS)).toFixed(0)}ms:${f2(rs[i].handD)}`)
    }
    console.log(`  ${cells.join('  ')}`)
    console.log(`  → 접촉(≤0.3 m) 유지 ${pick.hold}프레임 = ${(pick.hold * (1000 / FPS)).toFixed(0)} ms`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ③ 슛 종점 ↔ 골대 — 라이브러리 전수(경기 무관)
// ─────────────────────────────────────────────────────────────────────────
console.log('\n## ③ 슛 종점 ↔ 골대 거리 — 장면 라이브러리 전수')
console.log(`골문: z ±${GOAL_HALF_Z} m, 크로스바 ${CROSSBAR} m, 골라인 x ${HALF_W} m`)
console.log('\n| finish | 조합 수 | 포스트 밖 거리 p50 | p90 | max | 골문 안 | 5 m 초과 |')
console.log('|---|---|---|---|---|---|---|')
const patterns = ['balanced', 'cross', 'through', 'longshot']
for (const finish of ['goal', 'save', 'miss', 'shot']) {
  const outs = []
  let inGoal = 0, n = 0
  const detail = []
  for (const p of patterns) {
    for (let b = 0; b < scenes.BUILDUP_VARIANT_COUNT; b++) {
      for (let f = 0; f < scenes.FINISH_VARIANT_COUNT; f++) {
        for (let l = 0; l < scenes.LANE_COUNT; l++) {
          const sc = scenes.buildScene(p, finish, l, { buildup: b, finish: f })
          const last = sc.points[sc.points.length - 1]
          const w = toWorld(last.ball[0], last.ball[1])
          const outZ = Math.max(0, Math.abs(w.z) - GOAL_HALF_Z)
          n++
          if (outZ === 0) inGoal++
          outs.push(outZ)
          detail.push({ key: sc.key, z: w.z, x: w.x, outZ, h: last.endY ?? mv.BALL_END.shot })
        }
      }
    }
  }
  console.log(`| ${finish} | ${n} | ${f2(pct(outs, 0.5))} | ${f2(pct(outs, 0.9))} | ${f2(Math.max(...outs))} | ${inGoal} | ${outs.filter(o => o > 5).length} |`)
  if (finish === 'miss') {
    const frameD = detail.map(d => Math.hypot(d.outZ, Math.max(0, d.h - CROSSBAR)))
    const over = detail.filter(d => d.h > CROSSBAR).length
    const wide = detail.filter(d => d.outZ > 0).length
    const both = detail.filter(d => d.h > CROSSBAR && d.outZ > 0).length
    console.log('')
    console.log(`  범주: 옆으로만 ${(((wide - both) / n) * 100).toFixed(1)}% (실측 45.4) · ` +
      `위로만 ${(((over - both) / n) * 100).toFixed(1)}% (실측 27.9) · 옆+위 ${((both / n) * 100).toFixed(1)}% (실측 26.6)`)
    console.log(`  포스트 밖 수평 간극(옆으로 빗나간 것만): p25 ${f2(pct(detail.filter(d => d.outZ > 0).map(d => d.outZ), 0.25))} · ` +
      `**p50 ${f2(pct(detail.filter(d => d.outZ > 0).map(d => d.outZ), 0.5))}** · p75 ${f2(pct(detail.filter(d => d.outZ > 0).map(d => d.outZ), 0.75))} ` +
      `(실측 1.10 / 2.10 / 4.30)`)
    const ov = detail.filter(d => d.h > CROSSBAR).map(d => d.h - CROSSBAR)
    console.log(`  크로스바 위 높이: p25 ${f2(pct(ov, 0.25))} · **p50 ${f2(pct(ov, 0.5))}** · p75 ${f2(pct(ov, 0.75))} (실측 1.31 / 2.04 / 2.86)`)
    console.log(`  **프레임(골대)에서의 최단 거리**: p50 ${f2(pct(frameD, 0.5))} · 2 m 안 ${((frameD.filter(v => v <= 2).length / n) * 100).toFixed(1)}% (실측 40.5) · ` +
      `3 m 안 ${((frameD.filter(v => v <= 3).length / n) * 100).toFixed(1)}% (실측 60.9) · 5 m 초과 ${((frameD.filter(v => v > 5).length / n) * 100).toFixed(1)}%`)
    console.log('')
  }
  if (finish === 'miss') {
    const uniq = new Map()
    for (const d of detail) {
      const k = d.key.split('/')[1]
      if (!uniq.has(k)) uniq.set(k, [])
      uniq.get(k).push(d.outZ)
    }
    console.log('\n  miss 변형별 포스트 밖 거리(m):')
    for (const [k, v] of uniq) console.log(`  - ${k}: p50 ${f2(pct(v, 0.5))} / min ${f2(Math.min(...v))} / max ${f2(Math.max(...v))}`)
    console.log('')
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 새 캔버스 4종에서의 카메라 프레이밍 재검증
// ─────────────────────────────────────────────────────────────────────────
// 레이아웃 개편(8a35662)으로 캔버스가 뷰포트 전체가 됐다. 이전 계측은 1568×576(2.72)
// 기준이라 무효다. `camera.applyCamera`가 aspect < FRAME_ASPECT(1.5)에서 세로 fov를
// 넓히는 Hor+ 보정(fovForAspect)을 하므로 종횡비마다 담기는 범위가 달라진다.
const CANVASES = [
  ['3456×2234 (풀블리드)', 3456 / 2234],
  ['1920×1080', 1920 / 1080],
  ['1440×900', 1440 / 900],
  ['390×465 (모바일)', 390 / 465],
]

/** 절두체 NDC 투영(three 없이). up=(0,1,0) 가정. fov는 aspect 보정 후 값. */
function project(shot, p, aspect) {
  const f = { x: shot.lookAt.x - shot.pos.x, y: shot.lookAt.y - shot.pos.y, z: shot.lookAt.z - shot.pos.z }
  const fl = Math.hypot(f.x, f.y, f.z) || 1
  const fw = { x: f.x / fl, y: f.y / fl, z: f.z / fl }
  const rl = Math.hypot(fw.z, fw.x) || 1
  const r = { x: fw.z / rl, y: 0, z: -fw.x / rl }
  const u = { x: r.y * fw.z - r.z * fw.y, y: r.z * fw.x - r.x * fw.z, z: r.x * fw.y - r.y * fw.x }
  const d = { x: p.x - shot.pos.x, y: p.y - shot.pos.y, z: p.z - shot.pos.z }
  const zc = d.x * fw.x + d.y * fw.y + d.z * fw.z
  if (zc <= 0.01) return { ndcX: 99, ndcY: 99, inFrame: false }
  const xc = d.x * r.x + d.y * r.y + d.z * r.z
  const yc = d.x * u.x + d.y * u.y + d.z * u.z
  const th = Math.tan((cam.fovForAspect(shot.fov, aspect) * Math.PI) / 360)
  const ndcY = yc / (zc * th)
  const ndcX = xc / (zc * th * aspect)
  return { ndcX, ndcY, inFrame: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1 }
}

console.log('\n## ⑤ 카메라 프레이밍 — 새 캔버스 4종')
console.log('배역(슈터·상대 GK·볼)이 절두체 안에 있는 프레임 비율. 슛 임팩트~접촉 구간만 잰다.')
console.log('')
console.log('| 캔버스 | aspect | 장면 | 슈터 in | GK in | 볼 in | 셋 다 in |')
console.log('|---|---|---|---|---|---|---|')
{
  const home = makeTestTeam('kor', 82)
  const away = makeTestTeam('esp', 84)
  const base = sim.createMatch(home, away, { seed: 42 })
  for (const [label, aspect] of CANVASES) {
    for (const type of ['goal', 'save', 'miss']) {
      const state = structuredClone(base)
      state.minute = 30
      // ★ save는 **막은 팀(수비)의 사건**이다(simulate.ts). 엔진과 똑같이 수비 팀 id와
      //   그 팀 GK를 싣는다 — attackingSideOf가 뒤집어 home이 공격 팀이 된다.
      const teamId = type === 'save' ? away.id : home.id
      const playerId = type === 'save'
        ? state.away.tactics.lineup[0].playerId
        : state.home.tactics.lineup[9].playerId
      const event = { minute: 30, type, teamId, playerId }
      const seq = buildSequence(event, state.home, state.away)
      const dwellMs = scenes.SCENE_DWELL_MS[type]
      const kicks = mv.kickEvents(seq)
      const tShot = kicks.length ? kicks[kicks.length - 1].tImpact : 0
      const contact = seq.find(s2 => s2.contact) ?? seq[seq.length - 1]
      const tEnd = contact.t
      // 배역은 시퀀스에서 꺼낸다 — 슈터 = 마지막 킥의 캐리어, GK = 반대편 골키퍼.
      const attackSide = 'home'
      const shooter = kicks.length ? kicks[kicks.length - 1].playerId : seq[0].carrier
      const gkId = state.away.tactics.lineup[0].playerId
      const rig = cam.createCameraRig({ seed: state.seed })
      let prev = null, mode = 'broadcast'
      const dt = 1 / FPS
      let n = 0, sIn = 0, gIn = 0, bIn = 0, all = 0
      const N = Math.round((dwellMs / 1000) * FPS)
      for (let i = 0; i <= N; i++) {
        const t = Math.min(1, i / N)
        const fr = mv.computeFrame({
          state, minute: 30, t, prev, dt, sequence: seq, sequenceSide: attackSide,
          seed: state.seed, dwellMs, event, cut: i === 0,
        })
        prev = fr
        const ev = fr.event
        const wantMode = ev === 'goal-home' || ev === 'goal-away' ? 'goal-cam'
          : ev === 'shot' || ev === 'save' ? 'highlight' : 'broadcast'
        if (wantMode !== mode) { rig.setMode(wantMode); mode = wantMode }
        const shot = rig.update({ focus: { ...fr.focus, r: fr.focusRadius ?? 0 }, t: i * dt, dt })
        if (t < tShot || t > tEnd) continue
        const sh = fr.players.find(q => q.id === shooter)
        const gk = fr.players.find(q => q.id === gkId)
        const a = project(shot, { x: sh.x, y: 1.0, z: sh.z }, aspect)
        const b = project(shot, { x: gk.x, y: 1.0, z: gk.z }, aspect)
        const c = project(shot, fr.ball, aspect)
        n++
        if (a.inFrame) sIn++
        if (b.inFrame) gIn++
        if (c.inFrame) bIn++
        if (a.inFrame && b.inFrame && c.inFrame) all++
      }
      const pc = v => `${((v / Math.max(1, n)) * 100).toFixed(0)}%`
      console.log(`| ${label} | ${aspect.toFixed(3)} | ${type} | ${pc(sIn)} | ${pc(gIn)} | ${pc(bIn)} | **${pc(all)}** |`)
    }
  }
}

await server.close()
