#!/usr/bin/env node
// tools/scene-timing/run.mjs
// 하이라이트 장면의 **국면 시간축** 계측표 — "세이브가 세이브로 읽히는가"를 숫자로 답한다.
//
// 재는 것:
//  1. 임팩트(슛 킥의 접촉) · 볼 도착 · GK 최대 신전 각각의 시각(ms)
//  2. 그 시각의 카메라 focus와 실제 샷(pos/lookAt/fov)
//  3. **프레임 내 배역 수** — 슈터·GK·볼을 카메라 절두체에 투영해 NDC로 판정한다
//  4. **손-공 최소 거리** — GK 다이브 신전 반경을 감안한 접촉 여부
//
// 사용: node tools/scene-timing/run.mjs [--fps 60] [--aspect 1.778]
import { createServer } from 'vite'

const argN = (flag, dflt) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}
const FPS = argN('--fps', 60)
const ASPECT = argN('--aspect', 1600 / 900)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

const { makeTestTeam } = await L('/src/engine/fixtures/testTeams.ts')
const { createMatch } = await L('/src/engine/simulate.ts')
const { buildSequence } = await L('/src/ui/pitch/choreography.ts')
const { SCENE_DWELL_MS } = await L('/src/ui/pitch/scenes.ts')
const mv = await L('/src/ui/pitch/three/movement.ts')
const cam = await L('/src/ui/pitch/three/camera.ts')
const { toWorld, PITCH_W } = await L('/src/ui/pitch/three/types.ts')

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const base = createMatch(home, away, { seed: 42 })

/**
 * GK가 완전히 누웠을 때 손이 몸통 루트에서 뻗는 수평 거리(m).
 * pose.ts: 어깨 높이 HIP_Y(0.94)+SHOULDER_Y(0.5)=1.44, 팔 UPPER_ARM+FOREARM=0.56.
 * armReach=-2.2 rad로 머리 위로 뻗은 팔이 roll=π/2에서 수평으로 눕는다 → 1.44+0.56≈2.0.
 */
const GK_REACH_M = 2.0

/** 카메라 절두체 NDC 투영(three 없이 직접). up=(0,1,0) 가정. */
function project(shot, p, aspect) {
  const f = { x: shot.lookAt.x - shot.pos.x, y: shot.lookAt.y - shot.pos.y, z: shot.lookAt.z - shot.pos.z }
  const fl = Math.hypot(f.x, f.y, f.z)
  const fw = { x: f.x / fl, y: f.y / fl, z: f.z / fl }
  // right = normalize(forward × up), up = (0,1,0)
  const rl = Math.hypot(fw.z, fw.x) || 1
  const r = { x: fw.z / rl, y: 0, z: -fw.x / rl }
  // up' = right × forward
  const u = {
    x: r.y * fw.z - r.z * fw.y,
    y: r.z * fw.x - r.x * fw.z,
    z: r.x * fw.y - r.y * fw.x,
  }
  const d = { x: p.x - shot.pos.x, y: p.y - shot.pos.y, z: p.z - shot.pos.z }
  const zc = d.x * fw.x + d.y * fw.y + d.z * fw.z
  if (zc <= 0.01) return { ndcX: 99, ndcY: 99, inFrame: false, depth: zc }
  const xc = d.x * r.x + d.y * r.y + d.z * r.z
  const yc = d.x * u.x + d.y * u.y + d.z * u.z
  const th = Math.tan((shot.fov * Math.PI) / 360)
  const ndcY = yc / (zc * th)
  const ndcX = xc / (zc * th * aspect)
  return { ndcX, ndcY, inFrame: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1, depth: zc }
}

/** 한 장면을 dwell 전체에 걸쳐 재생하며 프레임을 덤프한다. */
function play(finishType) {
  const state = structuredClone(base)
  state.minute = 8
  const event = { minute: 8, type: finishType, teamId: home.id, playerId: state.home.tactics.lineup[9].playerId }
  const seq = buildSequence(event, state.home, state.away)
  const dwellMs = SCENE_DWELL_MS[finishType]
  const gkAway = state.away.tactics.lineup[0].playerId
  const shooter = event.playerId
  const kicks = mv.kickEvents(seq)
  const tShot = kicks.length ? kicks[kicks.length - 1].tImpact : 0
  const tArrive = seq[seq.length - 1].t

  const dt = 1 / FPS
  const frames = []
  let prev = null
  const rig = cam.createCameraRig({ seed: state.seed })
  let mode = 'broadcast'
  for (let i = 0; i <= Math.round((dwellMs / 1000) * FPS); i++) {
    const t = Math.min(1, i / ((dwellMs / 1000) * FPS))
    const fr = mv.computeFrame({
      state, minute: 8, t, prev, dt, sequence: seq, sequenceSide: 'home', seed: state.seed, dwellMs, event,
    })
    prev = fr
    const ev = fr.event
    const want = ev === 'goal-home' || ev === 'goal-away' ? 'goal-cam'
      : ev === 'corner' || ev === 'foul' ? 'set-piece'
        : ev === 'shot' || ev === 'save' ? 'highlight' : 'broadcast'
    if (want !== mode) { rig.setMode(want); mode = want }
    const shot = rig.update({ focus: { ...fr.focus, r: fr.focusRadius ?? 0 }, t: i * dt, dt })
    const gk = fr.players.find(p => p.id === gkAway)
    const sh = fr.players.find(p => p.id === shooter)
    frames.push({
      i, t, ms: t * dwellMs, mode, shot, focus: { ...fr.focus }, fr: fr.focusRadius ?? 0,
      ball: { ...fr.ball },
      gk: { x: gk.x, z: gk.z, action: gk.action, actionT: gk.actionT },
      shooter: { x: sh.x, z: sh.z, action: sh.action, actionT: sh.actionT },
      // 프레임 안에 있는 배역 수(홈 무버 3 + 상대 GK 중 절두체 안)
      inFrame: fr.players.filter(p => project(shot, { x: p.x, y: 1.0, z: p.z }, ASPECT).inFrame).length,
      shooterIn: project(shot, { x: sh.x, y: 1.0, z: sh.z }, ASPECT),
      gkIn: project(shot, { x: gk.x, y: 1.0, z: gk.z }, ASPECT),
      ballIn: project(shot, fr.ball, ASPECT),
      handGap: Math.max(0, Math.hypot(fr.ball.x - gk.x, fr.ball.z - gk.z) - GK_REACH_M),
      gkBallD: Math.hypot(fr.ball.x - gk.x, fr.ball.z - gk.z),
    })
  }
  return { finishType, seq, dwellMs, tShot, tArrive, frames, shooter, gkAway }
}

const at = (frames, t) => frames.reduce((b, f) => (Math.abs(f.t - t) < Math.abs(b.t - t) ? f : b), frames[0])

for (const finish of ['save', 'goal', 'miss']) {
  const r = play(finish)
  console.log(`\n## ${finish}  (dwell ${r.dwellMs} ms, 키프레임 ${r.seq.length})`)
  console.log('키프레임 t:', r.seq.map(s => s.t.toFixed(3)).join(' '), ' arcs:', r.seq.map(s => s.arc ?? '-').join(','))
  const impact = at(r.frames, r.tShot)
  const arrive = at(r.frames, r.tArrive)
  // GK 최대 신전 = dive actionT가 0.55에 가장 가까운 프레임
  const dives = r.frames.filter(f => f.gk.action === 'dive')
  const lay = dives.length ? dives.reduce((b, f) => (Math.abs(f.gk.actionT - 0.55) < Math.abs(b.gk.actionT - 0.55) ? f : b)) : null
  const minGap = r.frames.reduce((b, f) => (f.gkBallD < b.gkBallD ? f : b))
  console.log('| 국면 | ms | 카메라 | focus(x,z) | 슈터(월드) | GK(월드) | 볼(월드) | 슈터 NDC | GK NDC | 볼 NDC | 프레임내 인원 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  const row = (label, f) => f && console.log(
    `| ${label} | ${f.ms.toFixed(0)} | ${f.mode} fov${f.shot.fov.toFixed(0)} r${f.fr.toFixed(1)} | ${f.focus.x.toFixed(1)},${f.focus.z.toFixed(1)} | ` +
    `${f.shooter.x.toFixed(1)},${f.shooter.z.toFixed(1)} | ${f.gk.x.toFixed(1)},${f.gk.z.toFixed(1)} | ${f.ball.x.toFixed(1)},${f.ball.z.toFixed(1)} | ` +
    `${f.shooterIn.ndcX.toFixed(2)},${f.shooterIn.ndcY.toFixed(2)}${f.shooterIn.inFrame ? '' : ' ✗'} | ` +
    `${f.gkIn.ndcX.toFixed(2)},${f.gkIn.ndcY.toFixed(2)}${f.gkIn.inFrame ? '' : ' ✗'} | ` +
    `${f.ballIn.ndcX.toFixed(2)},${f.ballIn.ndcY.toFixed(2)}${f.ballIn.inFrame ? '' : ' ✗'} | ${f.inFrame} |`)
  row('슛 임팩트', impact)
  row('볼 도착', arrive)
  if (lay) row('GK 최대신전', lay)
  row('GK-볼 최근접', minGap)
  console.log(`- 슛 임팩트 t=${r.tShot.toFixed(3)} (${(r.tShot * r.dwellMs).toFixed(0)} ms) / 볼 도착 t=${r.tArrive.toFixed(3)} (${(r.tArrive * r.dwellMs).toFixed(0)} ms)`)
  console.log(`- 다이브 창: ${dives.length ? `${dives[0].ms.toFixed(0)}~${dives[dives.length - 1].ms.toFixed(0)} ms` : '없음'}`)
  console.log(`- **GK-볼 최소 거리 ${minGap.gkBallD.toFixed(2)} m** (@${minGap.ms.toFixed(0)} ms) → 손-공 간극 ${minGap.handGap.toFixed(2)} m (신전 반경 ${GK_REACH_M} m)`)
  const shooterOut = r.frames.filter(f => !f.shooterIn.inFrame).length
  console.log(`- 슈터가 프레임 밖인 프레임: ${shooterOut}/${r.frames.length} (${((shooterOut / r.frames.length) * 100).toFixed(0)}%)`)
  // 국면별 시간 배분
  const segs = []
  for (let k = 0; k + 1 < r.seq.length; k++) segs.push(`${k}:${((r.seq[k + 1].t - r.seq[k].t) * r.dwellMs).toFixed(0)}ms`)
  console.log(`- 구간 배분: ${segs.join(' ')} / 여운 ${((1 - r.tArrive) * r.dwellMs).toFixed(0)}ms`)
  const world = toWorld(r.seq[r.seq.length - 1].ball.x, r.seq[r.seq.length - 1].ball.y)
  console.log(`- 마지막 볼 월드 x=${world.x.toFixed(1)} (골라인 ${(PITCH_W / 2).toFixed(1)}), z=${world.z.toFixed(1)} / GK x=${arrive.gk.x.toFixed(1)}, z=${arrive.gk.z.toFixed(1)}`)
}

await server.close()
