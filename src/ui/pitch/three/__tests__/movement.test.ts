import { describe, it, expect } from 'vitest'
import type { MatchEvent, MatchState } from '../../../../engine/types'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'
import { buildSequence, type ChoreoStep } from '../../choreography'
import { slotCoords } from '../../formations'
import { backlineIndices, lineDepth, tacticalCoords } from '../../shape'
import { strideLength } from '../player3d'
import { PITCH_H, PITCH_W, toWorld, type FrameState } from '../types'
import {
  computeFrame, ballHeight, arcKindFor, sampleSequence, gkBox,
  BALL_PEAK, BALL_END, BALL_RADIUS, BALL_SHIFT, CONVERGE_MAX, GK_MAX_SPEED, MAX_SPEED,
  STANDOFF, MOVER_LOOKAHEAD_MS, DEFAULT_DWELL_MS,
  kickEvents, kickAt, kickFacingAt, KICK_YAW_LEAD_MS, KICK_FOLLOW_MS, dragProgress,
  goalNetRest, GOAL_NET_MS, GOAL_NET_REST_M, diveScheduleAt, gkDiveAnchor, gkHandWorld,
  GK_DIVE_MS, GK_REACTION_MS, KICK_IMPACT_T, KICK_BACKSWING_MS,
  GK_DIVE_REACH, GK_HAND_HEIGHT, GK_BEATEN_LATE_MS, DIVE_LAY_U, A_SEPARATE,
  type FrameInput,
} from '../movement'
import { buildScene } from '../../scenes'
import { buildFlowSequence } from '../../flow'
import { createCameraRig, type CameraShot } from '../camera'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const base = createMatch(home, away, { seed: 42 })

function input(over: Partial<FrameInput> = {}): FrameInput {
  return {
    state: base, minute: 30, t: 0, prev: null, dt: 0,
    sequence: null, sequenceSide: null, seed: 42, event: null,
    ...over,
  }
}

/** 볼이 "두 라인업 좌표를 잇는 선분" 위에 있는지 — 무사건 분 패스 체인 검증용.
 *  리사주 곡선은 선수와 무관한 궤적이라 이 거리가 크게 벌어진다. */
function distToLineupSegments(bx: number, bz: number): number {
  const pts: { x: number; z: number }[] = []
  for (const side of ['home', 'away'] as const) {
    const st = base[side]
    st.tactics.lineup.forEach((_, i) => {
      // 무사건 분 패스 체인은 **전술 좌표**를 잇는다(3D·2D 동일 정본).
      const c = tacticalCoords(st.tactics.formation, i, side, st.tactics.instructions)
      pts.push(toWorld(c.x, c.y))
    })
  }
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const ax = pts[i].x, az = pts[i].z, dx = pts[j].x - ax, dz = pts[j].z - az
      const len2 = dx * dx + dz * dz
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((bx - ax) * dx + (bz - az) * dz) / len2)) : 0
      best = Math.min(best, Math.hypot(bx - (ax + dx * u), bz - (az + dz * u)))
    }
  }
  return best
}

/** 정지 볼을 원하는 0~100 좌표에 고정하는 더미 시퀀스(무버 없음). */
function pinnedBall(x: number, y: number): ChoreoStep[] {
  return [
    { t: 0, ball: { x, y }, movers: [] },
    { t: 1, ball: { x, y }, movers: [] },
  ]
}

const ev = (type: MatchEvent['type'], over: Partial<MatchEvent> = {}): MatchEvent =>
  ({ minute: 30, type, teamId: home.id, ...over })

const find = (f: FrameState, id: string) => f.players.find(p => p.id === id)!
const homeId = (i: number) => base.home.tactics.lineup[i].playerId
const awayId = (i: number) => base.away.tactics.lineup[i].playerId

describe('toWorld — 좌표계 계약', () => {
  it('코너 4점과 중앙이 정확히 매핑된다', () => {
    expect(toWorld(0, 0)).toEqual({ x: -PITCH_W / 2, z: -PITCH_H / 2 })
    expect(toWorld(100, 0)).toEqual({ x: PITCH_W / 2, z: -PITCH_H / 2 })
    expect(toWorld(0, 100)).toEqual({ x: -PITCH_W / 2, z: PITCH_H / 2 })
    expect(toWorld(100, 100)).toEqual({ x: PITCH_W / 2, z: PITCH_H / 2 })
    expect(toWorld(50, 50)).toEqual({ x: 0, z: 0 })
  })
})

describe('computeFrame — 기본 프레임 구성', () => {
  it('22명(홈 11 + 어웨이 11)을 반환한다', () => {
    const f = computeFrame(input())
    expect(f.players).toHaveLength(22)
    expect(f.players.filter(p => p.side === 'home')).toHaveLength(11)
    expect(f.players.filter(p => p.side === 'away')).toHaveLength(11)
  })

  it('전원이 피치 경계 내(±2m 여유)에 있다', () => {
    for (const bx of [1, 25, 50, 75, 99]) {
      for (const by of [3, 50, 97]) {
        const f = computeFrame(input({ sequence: pinnedBall(bx, by), sequenceSide: 'home', t: 0.5 }))
        for (const p of f.players) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(PITCH_W / 2 + 2)
          expect(Math.abs(p.z)).toBeLessThanOrEqual(PITCH_H / 2 + 2)
        }
      }
    }
  })

  it('등번호·side가 라인업과 일치한다', () => {
    const f = computeFrame(input())
    const numById = new Map(home.squad.map(p => [p.id, p.number]))
    for (const slot of base.home.tactics.lineup) {
      const pose = find(f, slot.playerId)
      expect(pose.side).toBe('home')
      expect(pose.number).toBe(numById.get(slot.playerId))
    }
  })

  it('퇴장 선수는 프레임에서 제외된다(22 미만)', () => {
    const off = homeId(5)
    const state: MatchState = { ...base, home: { ...base.home, sentOff: [off] } }
    const f = computeFrame(input({ state }))
    expect(f.players).toHaveLength(21)
    expect(f.players.some(p => p.id === off)).toBe(false)
  })

  it('엔진 상태를 변형하지 않는다', () => {
    const snapshot = structuredClone(base)
    computeFrame(input({ sequence: buildSequence(ev('goal'), base.home, base.away), sequenceSide: 'home', t: 0.4 }))
    expect(base).toEqual(snapshot)
  })
})

describe('computeFrame — prev=null 첫 프레임', () => {
  it('크래시 없이 포메이션 앵커 근처(볼 시프트+수렴 범위 내)를 반환한다', () => {
    const f = computeFrame(input())
    const tol = BALL_SHIFT + CONVERGE_MAX + 2
    base.home.tactics.lineup.forEach((slot, i) => {
      const c = tacticalCoords(base.home.tactics.formation, i, 'home', base.home.tactics.instructions)
      const anchor = toWorld(c.x, c.y)
      const pose = find(f, slot.playerId)
      expect(Math.hypot(pose.x - anchor.x, pose.z - anchor.z)).toBeLessThanOrEqual(tol)
    })
    expect(f.players.every(p => p.speed === 0)).toBe(true)
  })

  it('dt=0에서도 NaN이 없다', () => {
    const f = computeFrame(input({ dt: 0 }))
    for (const p of f.players) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
      expect(Number.isFinite(p.yaw)).toBe(true)
    }
    expect(Number.isFinite(f.ball.y)).toBe(true)
  })
})

describe('computeFrame — 속도 클램프', () => {
  it('dt=0.016 한 프레임 이동량이 7.5*dt 이하(GK는 5.5*dt)', () => {
    // 전원을 반대편 구석에 몰아넣은 prev → 목표까지 거리가 매우 멀다.
    const first = computeFrame(input())
    const prev: FrameState = {
      ...first,
      players: first.players.map(p => ({ ...p, x: -PITCH_W / 2 + 1, z: -PITCH_H / 2 + 1 })),
    }
    const dt = 0.016
    const f = computeFrame(input({ prev, dt, t: 0.3, sequence: pinnedBall(90, 50), sequenceSide: 'home' }))
    for (const p of f.players) {
      const pp = prev.players.find(q => q.id === p.id)!
      const moved = Math.hypot(p.x - pp.x, p.z - pp.z)
      const cap = (p.id === homeId(0) || p.id === awayId(0) ? GK_MAX_SPEED : MAX_SPEED) * dt
      expect(moved).toBeLessThanOrEqual(cap + 1e-9)
      expect(p.speed).toBeLessThanOrEqual(MAX_SPEED + 1e-9)
    }
  })

  it('실제 안무(무버 포함) 재생에서도 프레임당 클램프를 지킨다', () => {
    // 무버는 안무 좌표를 목표로 삼지만 이동은 클램프를 통과한다(텔레포트 금지).
    for (const type of ['goal', 'corner'] as const) {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      let prev: FrameState | null = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0, event: e }))
      const dt = 0.033
      const N = 60
      for (let k = 1; k <= N; k++) {
        const f: FrameState = computeFrame(input({ prev, dt, t: k / N, sequence: seq, sequenceSide: 'home', event: e }))
        for (const p of f.players) {
          const pp = prev!.players.find(q => q.id === p.id)!
          const cap = (p.id === homeId(0) || p.id === awayId(0) ? GK_MAX_SPEED : MAX_SPEED) * dt
          const moved = Math.hypot(p.x - pp.x, p.z - pp.z)
          if (moved > cap + 1e-9) throw new Error(`${type} frame ${k} ${p.id}: ${moved.toFixed(4)} > ${cap.toFixed(4)}`)
          expect(p.speed).toBeLessThanOrEqual(MAX_SPEED + 1e-9)
        }
        prev = f
      }
    }
  })

  it('여러 프레임 누적해도 프레임당 클램프를 지킨다', () => {
    let prev = computeFrame(input())
    const dt = 0.05
    for (let k = 1; k <= 20; k++) {
      const f = computeFrame(input({ prev, dt, t: k / 20, sequence: pinnedBall(95, 20), sequenceSide: 'home' }))
      for (const p of f.players) {
        const pp = prev.players.find(q => q.id === p.id)!
        expect(Math.hypot(p.x - pp.x, p.z - pp.z)).toBeLessThanOrEqual(MAX_SPEED * dt + 1e-9)
      }
      prev = f
    }
  })
})

describe('computeFrame — 선수 간 간격(관통 방지)', () => {
  it('하이라이트 전 프레임에서 임의의 두 선수 거리가 1m 이상(같은 팀·상대 팀 모두)', () => {
    for (const type of ['goal', 'shot', 'save', 'miss', 'corner', 'foul'] as const) {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      let prev: FrameState | null = null
      const N = 90
      for (let k = 0; k <= N; k++) {
        const f: FrameState = computeFrame(input({ prev, dt: 0.033, t: k / N, sequence: seq, sequenceSide: 'home', event: e }))
        for (let i = 0; i < f.players.length; i++) {
          for (let j = i + 1; j < f.players.length; j++) {
            const a = f.players[i]
            const b = f.players[j]
            const d = Math.hypot(a.x - b.x, a.z - b.z)
            if (d < 1) throw new Error(`${type} frame ${k}: ${a.id}(${a.side}) — ${b.id}(${b.side}) = ${d.toFixed(3)}m`)
          }
        }
        prev = f
      }
    }
  })

  it('평시(시퀀스 없음) 재생에서도 1m 이상', () => {
    let prev: FrameState | null = null
    for (let k = 0; k <= 60; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.033, t: k / 60 }))
      for (let i = 0; i < f.players.length; i++) {
        for (let j = i + 1; j < f.players.length; j++) {
          expect(Math.hypot(f.players[i].x - f.players[j].x, f.players[i].z - f.players[j].z)).toBeGreaterThanOrEqual(1)
        }
      }
      prev = f
    }
  })

  it('수렴 선수도 공 좌표에 겹치지 않는다(STANDOFF 유지)', () => {
    const seq = pinnedBall(50, 50)
    let prev: FrameState | null = null
    for (let k = 0; k <= 40; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 40, sequence: seq, sequenceSide: 'home' }))
      prev = f
    }
    for (const p of prev!.players) {
      expect(Math.hypot(p.x - prev!.ball.x, p.z - prev!.ball.z)).toBeGreaterThan(STANDOFF * 0.8)
    }
  })
})

describe('computeFrame — 볼 시프트(팀 라인 전후 이동)', () => {
  it('볼이 +X 끝이면 홈 수비진이 평상시보다 전진해 있다', () => {
    const mid = computeFrame(input({ sequence: pinnedBall(50, 50), sequenceSide: 'home', t: 0.5 }))
    const far = computeFrame(input({ sequence: pinnedBall(99, 50), sequenceSide: 'home', t: 0.5 }))
    for (const i of [1, 2, 3, 4]) { // CB CB LB RB
      expect(find(far, homeId(i)).x).toBeGreaterThan(find(mid, homeId(i)).x)
    }
  })

  it('볼이 -X 끝이면 홈 수비진이 후퇴해 있다', () => {
    const mid = computeFrame(input({ sequence: pinnedBall(50, 50), sequenceSide: 'home', t: 0.5 }))
    const own = computeFrame(input({ sequence: pinnedBall(1, 50), sequenceSide: 'home', t: 0.5 }))
    for (const i of [1, 2]) {
      expect(find(own, homeId(i)).x).toBeLessThan(find(mid, homeId(i)).x)
    }
  })

  it('볼 근처 선수는 볼 쪽으로 수렴한다(앵커보다 가까워짐)', () => {
    const f = computeFrame(input({ sequence: pinnedBall(50, 50), sequenceSide: 'home', t: 0.5 }))
    const ball = f.ball
    const dists = base.home.tactics.lineup.map((slot, i) => {
      const c = tacticalCoords(base.home.tactics.formation, i, 'home', base.home.tactics.instructions)
      const a = toWorld(c.x, c.y)
      return {
        anchor: Math.hypot(a.x - ball.x, a.z - ball.z),
        actual: Math.hypot(find(f, slot.playerId).x - ball.x, find(f, slot.playerId).z - ball.z),
      }
    })
    // 최소 3명은 앵커보다 볼에 가까워져 있다.
    expect(dists.filter(d => d.actual < d.anchor - 1).length).toBeGreaterThanOrEqual(3)
  })
})

describe('computeFrame — GK 박스', () => {
  it('어떤 볼 위치에서도 GK가 박스를 벗어나지 않는다', () => {
    const hb = gkBox('home')
    const ab = gkBox('away')
    let prev: FrameState | null = null
    for (const bx of [0, 10, 30, 50, 70, 90, 100]) {
      for (const by of [0, 20, 50, 80, 100]) {
        const f: FrameState = computeFrame(input({ sequence: pinnedBall(bx, by), sequenceSide: 'home', t: 0.5, prev, dt: 0.1 }))
        const hg = find(f, homeId(0))
        const ag = find(f, awayId(0))
        expect(hg.x).toBeGreaterThanOrEqual(hb.xMin - 1e-9)
        expect(hg.x).toBeLessThanOrEqual(hb.xMax + 1e-9)
        expect(hg.z).toBeGreaterThanOrEqual(hb.zMin - 1e-9)
        expect(hg.z).toBeLessThanOrEqual(hb.zMax + 1e-9)
        expect(ag.x).toBeGreaterThanOrEqual(ab.xMin - 1e-9)
        expect(ag.x).toBeLessThanOrEqual(ab.xMax + 1e-9)
        prev = f
      }
    }
  })

  it('홈 GK 박스는 -X 골문 앞 6m, 어웨이는 +X 골문 앞 6m', () => {
    expect(gkBox('home').xMax).toBeLessThanOrEqual(-PITCH_W / 2 + 6)
    expect(gkBox('home').xMin).toBeGreaterThanOrEqual(-PITCH_W / 2)
    expect(gkBox('away').xMin).toBeGreaterThanOrEqual(PITCH_W / 2 - 6)
    expect(gkBox('away').xMax).toBeLessThanOrEqual(PITCH_W / 2)
  })

  it('안무가 GK를 박스 밖으로 지정해도 박스 클램프가 우선한다', () => {
    const gk = homeId(0)
    const seq: ChoreoStep[] = [
      { t: 0, ball: { x: 90, y: 10 }, movers: [{ playerId: gk, x: 90, y: 10 }] },
      { t: 1, ball: { x: 90, y: 10 }, movers: [{ playerId: gk, x: 90, y: 10 }] },
    ]
    const box = gkBox('home')
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.5 }))
    const pose = find(f, gk)
    expect(pose.x).toBeLessThanOrEqual(box.xMax + 1e-9)
    expect(pose.x).toBeGreaterThanOrEqual(box.xMin - 1e-9)
    expect(Math.abs(pose.z)).toBeLessThanOrEqual(box.zMax + 1e-9)
  })

  it('볼이 상대 진영으로 갈수록 GK가 골문에서 전진한다', () => {
    const back = computeFrame(input({ sequence: pinnedBall(5, 50), sequenceSide: 'home', t: 0.5 }))
    const up = computeFrame(input({ sequence: pinnedBall(95, 50), sequenceSide: 'home', t: 0.5 }))
    expect(find(up, homeId(0)).x).toBeGreaterThan(find(back, homeId(0)).x)
  })
})

describe('computeFrame — 결정론', () => {
  it('동일 입력 2회는 완전히 같은 프레임', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const a = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.42, dt: 0.033 }))
    const b = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.42, dt: 0.033 }))
    expect(a).toEqual(b)
  })

  it('prev 체인을 두 번 돌려도 같은 결과', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const run = () => {
      let prev: FrameState | null = null
      for (let k = 0; k <= 30; k++) {
        prev = computeFrame(input({ prev, dt: 0.033, t: k / 30, sequence: seq, sequenceSide: 'home', event: ev('goal') }))
      }
      return prev!
    }
    expect(run()).toEqual(run())
  })

  it('seed가 다르면 미세 변형이 달라진다', () => {
    const a = computeFrame(input({ seed: 1 }))
    const b = computeFrame(input({ seed: 2 }))
    expect(a).not.toEqual(b)
  })

  it('볼이 고정돼도 seed가 다르면 선수 흔들림이 달라진다(시드 해시 의존)', () => {
    const seq = pinnedBall(50, 50)
    const a = computeFrame(input({ seed: 1, sequence: seq, sequenceSide: 'home', t: 0.5 }))
    const b = computeFrame(input({ seed: 2, sequence: seq, sequenceSide: 'home', t: 0.5 }))
    expect(a.ball).toEqual(b.ball) // 볼은 동일 — 차이는 선수 위치에서만 나온다
    const moved = a.players.filter(p => {
      const q = b.players.find(r => r.id === p.id)!
      return Math.hypot(p.x - q.x, p.z - q.z) > 1e-6
    })
    expect(moved.length).toBeGreaterThan(5)
  })
})

describe('sampleSequence / 안무 추종', () => {
  it('키프레임 시각에 볼이 정확히 그 좌표', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    for (const step of seq) {
      const s = sampleSequence(seq, step.t)
      expect(s.ball.x).toBeCloseTo(step.ball.x, 6)
      expect(s.ball.y).toBeCloseTo(step.ball.y, 6)
    }
  })

  it('마지막 키프레임 이후는 finished(마지막 좌표 유지)', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const s = sampleSequence(seq, 1)
    expect(s.finished).toBe(true)
    expect(s.ball).toEqual(seq[seq.length - 1].ball)
  })

  it('prev=null이면 무버가 안무 좌표(선행 보정 포함)에 정확히 놓인다', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const t = seq[1].t
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t, event: ev('goal') }))
    // 무버 목표는 도착 감속 지연을 상쇄하려고 MOVER_LOOKAHEAD_MS만큼 앞선 시각을 읽는다.
    const target = sampleSequence(seq, t, MOVER_LOOKAHEAD_MS / DEFAULT_DWELL_MS)
    for (const m of target.movers) {
      const pose = f.players.find(p => p.id === m.playerId)
      if (!pose || pose.id === homeId(0)) continue // GK는 박스 클램프 우선
      const w = toWorld(m.x, m.y)
      // 완전 일치가 아닌 이유: 무버끼리 MIN_POSE_SEPARATION(1.3 m) 안으로 붙으면
      // 소프트 분리가 밀어낸다. 그 폭 안에 있으면 "안무 좌표에 놓였다"로 본다.
      expect(Math.hypot(pose.x - w.x, pose.z - w.z), m.playerId).toBeLessThan(1.4)
    }
  })

  it('prev가 있으면 무버가 안무 좌표 쪽으로 가까워진다', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const start = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0, event: ev('goal') }))
    const next = computeFrame(input({ prev: start, dt: 0.1, t: 0.3, sequence: seq, sequenceSide: 'home', event: ev('goal') }))
    const m = seq[1].movers.find(mv => mv.playerId !== homeId(0))!
    const w = toWorld(m.x, m.y)
    const d0 = Math.hypot(find(start, m.playerId).x - w.x, find(start, m.playerId).z - w.z)
    const d1 = Math.hypot(find(next, m.playerId).x - w.x, find(next, m.playerId).z - w.z)
    expect(d1).toBeLessThan(d0)
  })
})

describe('볼 높이(Y) — 이벤트 타입별 아크', () => {
  it('ballHeight 피크가 계약값과 일치(지면 0.11 / 패스 1.2 / 슛 2.5 / 크로스 6)', () => {
    const peak = (kind: Parameters<typeof ballHeight>[0]) => {
      let m = 0
      for (let i = 0; i <= 200; i++) m = Math.max(m, ballHeight(kind, i / 200))
      return m
    }
    expect(BALL_RADIUS).toBeCloseTo(0.11, 6)
    expect(peak('ground')).toBeCloseTo(0.11, 6)
    expect(peak('pass')).toBeCloseTo(BALL_PEAK.pass, 6)
    expect(peak('shot')).toBeCloseTo(BALL_PEAK.shot, 6)
    expect(peak('cross')).toBeCloseTo(BALL_PEAK.cross, 6)
  })

  it('모든 아크가 지면(공 반지름) 아래로 내려가지 않는다', () => {
    for (const kind of ['ground', 'pass', 'shot', 'cross'] as const) {
      for (let i = 0; i <= 50; i++) expect(ballHeight(kind, i / 50)).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-9)
    }
  })

  it('arcKindFor: 코너 첫 구간=크로스, 슛 계열 마지막 구간=슛, 파울=지면', () => {
    expect(arcKindFor('corner', 0, 2)).toBe('cross')
    expect(arcKindFor('corner', 1, 2)).toBe('pass')
    expect(arcKindFor('goal', 2, 3)).toBe('shot')
    expect(arcKindFor('goal', 0, 3)).toBe('pass')
    expect(arcKindFor('shot', 1, 2)).toBe('shot')
    expect(arcKindFor('foul', 0, 1)).toBe('ground')
  })

  it('근거 이벤트를 모르면 지면 궤적(계획: "그 외 지면")', () => {
    expect(arcKindFor(undefined, 0, 2)).toBe('ground')
    const f = computeFrame(input({ sequence: pinnedBall(60, 40), sequenceSide: 'home', t: 0.5, event: null }))
    expect(f.ball.y).toBeCloseTo(BALL_RADIUS, 6)
  })

  it('computeFrame 볼 Y 최대값이 이벤트 타입별 피크', () => {
    const maxY = (type: MatchEvent['type']) => {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      let m = 0
      // 정점이 구간 내부(u≈0.5~0.59)라 표본을 촘촘히 잡아야 실제 최고점을 밟는다.
      for (let i = 0; i <= 2000; i++) {
        m = Math.max(m, computeFrame(input({ sequence: seq, sequenceSide: 'home', t: i / 2000, event: e })).ball.y)
      }
      return m
    }
    // 정점은 구간 내부(u≈0.5~0.59)라 dwell을 100등분한 표본이 정확히 밟지 못한다 —
    // 소수 둘째 자리까지만 본다.
    expect(maxY('corner')).toBeCloseTo(BALL_PEAK.cross, 3)
    expect(maxY('goal')).toBeCloseTo(BALL_PEAK.shot, 3)
    expect(maxY('foul')).toBeCloseTo(BALL_RADIUS, 6)
  })

  // ★ 예전엔 이 자리에 리사주 곡선(cos/sin 합성)이 있었다 — 공이 사람과 무관하게 8자를
  //   그리니 "혼자 떠다닌다"로 보였다. 지금은 실제 선수를 잇는 짧은 패스 체인이므로
  //   "가장 가까운 선수와의 거리"가 항상 작아야 한다(리사주는 이 검사를 통과할 수 없다).
  it('시퀀스가 없으면 볼은 항상 어떤 선수의 발밑 근처에 있다(리사주 금지)', () => {
    let prev: FrameState | null = null
    let maxStep = 0
    let maxToPlayer = 0
    for (let k = 0; k <= 40; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 40 }))
      // 지면 또는 짧은 패스 아크(공중 최고점도 pass 피크를 넘지 않는다).
      expect(f.ball.y).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-9)
      expect(f.ball.y).toBeLessThanOrEqual(BALL_PEAK.pass + 1e-9)
      expect(Math.abs(f.ball.x)).toBeLessThan(PITCH_W / 2)
      expect(Math.abs(f.ball.z)).toBeLessThan(PITCH_H / 2)
      maxToPlayer = Math.max(maxToPlayer, distToLineupSegments(f.ball.x, f.ball.z))
      if (prev) maxStep = Math.max(maxStep, Math.hypot(f.ball.x - prev.ball.x, f.ball.z - prev.ball.z))
      prev = f
    }
    // 공은 **두 라인업 좌표를 잇는 선분 위**에 정확히 있다(패스 중이거나 발밑이거나).
    // 리사주 곡선은 이 검사를 통과할 수 없다.
    expect(maxToPlayer).toBeLessThan(0.05)
    expect(maxStep).toBeLessThan(3) // 완만한 전개(프레임당 급점프 없음)
  })
})

describe('액션 판정', () => {
  it('정지 상태는 idle, 이동 중이면 run', () => {
    const first = computeFrame(input())
    const still = computeFrame(input({ prev: first, dt: 0.05, t: 0.02 }))
    expect(still.players.filter(p => p.action === 'idle').length).toBeGreaterThan(0)

    const prev: FrameState = { ...first, players: first.players.map(p => ({ ...p, x: 0, z: 0 })) }
    const moving = computeFrame(input({ prev, dt: 0.05, t: 0.5, sequence: pinnedBall(90, 50), sequenceSide: 'home' }))
    expect(moving.players.every(p => p.action === 'run' || p.action === 'idle')).toBe(true)
    expect(moving.players.filter(p => p.action === 'run').length).toBeGreaterThan(10)
  })

  it('골 이벤트 뒤 득점팀 전원이 celebrate', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.9, event: e, dwellMs: 3000 }))
    const homePoses = f.players.filter(p => p.side === 'home')
    expect(homePoses.every(p => p.action === 'celebrate')).toBe(true)
    expect(f.players.filter(p => p.side === 'away').every(p => p.action !== 'celebrate')).toBe(true)
    expect(f.event).toBe('goal-home')
  })

  it("goal 라벨은 공이 네트에 들어간 뒤부터 — 그 전엔 'shot'", () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    const goalT = seq[seq.length - 1].t
    for (const t of [0, 0.2, 0.5, goalT - 0.01]) {
      expect(computeFrame(input({ sequence: seq, sequenceSide: 'home', t, event: e })).event).toBe('shot')
    }
    for (const t of [goalT, goalT + 0.05, 1]) {
      expect(computeFrame(input({ sequence: seq, sequenceSide: 'home', t, event: e })).event).toBe('goal-home')
    }
  })

  it('어웨이 득점은 goalT 이후 goal-away', () => {
    const e = ev('goal', { teamId: away.id })
    const seq = buildSequence(e, base.home, base.away)
    const goalT = seq[seq.length - 1].t
    expect(computeFrame(input({ sequence: seq, sequenceSide: 'away', t: 0.3, event: e })).event).toBe('shot')
    expect(computeFrame(input({ sequence: seq, sequenceSide: 'away', t: goalT, event: e })).event).toBe('goal-away')
  })

  it('세리머니는 골 이후 2초 창에서만(dwell 환산)', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    const before = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.5, event: e }))
    expect(before.players.some(p => p.action === 'celebrate')).toBe(false)
    // dwell이 짧으면 창도 짧다 → 2초 이후 프레임은 세리머니 종료.
    const after = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 1, event: e, dwellMs: 20000 }))
    expect(after.players.some(p => p.action === 'celebrate')).toBe(false)
  })

  it('save 이벤트에서 **막은 팀의** GK가 dive한다', () => {
    // save의 teamId는 막은 팀이다 → 홈이 막았으면 몸을 던지는 것도 홈 GK다.
    const e = ev('save', { teamId: base.home.team.id, playerId: homeId(0) })
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'away', t: seq[seq.length - 1].t - 0.01, event: e }))
    expect(find(f, homeId(0)).action).toBe('dive')
    expect(find(f, awayId(0)).action).not.toBe('dive')
    expect(f.event).toBe('save')
  })

  it('공 옆에 선수가 있으면 그 선수가 kick(actionT 0~1)', () => {
    const striker = homeId(10)
    const seq: ChoreoStep[] = [
      { t: 0, ball: { x: 80, y: 50 }, movers: [{ playerId: striker, x: 80, y: 50 }], carrier: striker },
      { t: 0.6, ball: { x: 99, y: 50 }, movers: [{ playerId: striker, x: 82, y: 50 }] },
    ]
    const e = ev('goal')
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.05, event: e }))
    const kickers = f.players.filter(p => p.action === 'kick')
    expect(kickers).toHaveLength(1)
    expect(kickers[0].id).toBe(striker)
    expect(kickers[0].actionT).toBeGreaterThanOrEqual(0)
    expect(kickers[0].actionT).toBeLessThanOrEqual(1)
  })

  // ★ R3: 킥은 **저술이 지정한 캐리어**만 받는다. 예전엔 "구간 시작 볼에서 가장 가까운
  //   아무나"였고, 실측에서 그 선수는 수렴 로직에 빨려온 일반 선수였다.
  it('kick은 임팩트 볼에서 KICK_REACH 이내 + 그 구간의 캐리어에게만 부여된다', () => {
    let kickFrames = 0
    for (const type of ['goal', 'shot', 'save', 'miss', 'corner', 'foul'] as const) {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      const kicks = kickEvents(seq)
      const carriers = new Set(kicks.map(k => k.playerId))
      let prev: FrameState | null = null
      const N = 240
      /** 킥마다 "그 킥이 재생되는 동안의 최소 볼-발 거리". */
      const bestPerKick = new Map<number, number>()
      for (let k = 0; k <= N; k++) {
        const t = k / N
        const f: FrameState = computeFrame(input({ prev, dt: 0.033, t, sequence: seq, sequenceSide: 'home', event: e }))
        // 공격 팀은 이벤트가 정한다 — save만 teamId가 막은 팀이라 반대편이 찬다.
        const atk = type === 'save' ? 'away' : 'home'
        for (const p of f.players.filter(q => q.action === 'kick')) {
          kickFrames++
          expect(p.side).toBe(atk)
          expect(carriers.has(p.id), `${type}: ${p.id}는 캐리어가 아니다`).toBe(true)
          const hit = kickAt(kicks, t, DEFAULT_DWELL_MS)!
          expect(hit).not.toBeNull()
          // ★ 저술 좌표가 아니라 **화면에 그려진 볼**과 잰다(볼은 캐리어의 발에 앵커링된다).
          //   그리고 킥 창 **전체**가 아니라 그 창의 **최솟값**을 본다: 백스윙 구간에는
          //   공이 아직 날아오는 중이고 팔로스루 구간에는 이미 떠난 뒤라, 둘 다 거리가
          //   벌어지는 것이 정상이다. 계약은 "킥 한 번에 공이 실제로 그 발을 거친다"이다.
          const d = Math.hypot(p.x - f.ball.x, p.z - f.ball.z)
          const key = hit.kick.stepIndex
          bestPerKick.set(key, Math.min(bestPerKick.get(key) ?? Infinity, d))
        }
        prev = f
      }
      for (const [step, d] of bestPerKick) {
        expect(d, `${type}: step${step} 킥의 최소 볼-발 ${d.toFixed(2)} m`).toBeLessThan(1.0)
      }
    }
    // 규칙이 kick을 죽이지 않았는지도 확인 — 공 옆에 실제로 선 프레임에서는 발동한다.
    expect(kickFrames).toBeGreaterThan(0)
  })

  // ★ 사용자 불만 ①: "공을 차는 느낌이 없다". 원인은 임팩트 프레임(actionT≈0.45)이
  //   볼 출발보다 90 ms **뒤**에 왔다는 것이다(백스윙 중에 공이 이미 떠났다).
  it('킥 임팩트 프레임이 볼 출발 시각과 정확히 일치한다(역방향 스케줄링)', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    const kicks = kickEvents(seq)
    expect(kicks.length).toBeGreaterThanOrEqual(3)
    for (const k of kicks) {
      const at = kickAt(kicks, k.tImpact, DEFAULT_DWELL_MS)!
      expect(at.kick.playerId).toBe(k.playerId)
      expect(at.actionT).toBeCloseTo(KICK_IMPACT_T, 6)
    }
    // 임팩트 전에는 백스윙 구간(0 ~ 0.45), 뒤에는 팔로스루(0.45 ~ 1).
    const mid = kicks[1]
    const back = kickAt(kicks, mid.tImpact - (KICK_BACKSWING_MS / 2) / DEFAULT_DWELL_MS, DEFAULT_DWELL_MS)!
    expect(back.actionT).toBeLessThan(KICK_IMPACT_T)
    expect(back.actionT).toBeGreaterThan(0)
  })

  it('파울 뒤엔 한 명이 down', () => {
    const e = ev('foul')
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.95, event: e }))
    expect(f.players.filter(p => p.action === 'down')).toHaveLength(1)
    expect(f.event).toBe('foul')
  })

  it('모든 gaitPhase는 0~1', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    let prev: FrameState | null = null
    for (let k = 0; k <= 20; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 20, sequence: seq, sequenceSide: 'home', event: e }))
      for (const p of f.players) {
        expect(p.gaitPhase).toBeGreaterThanOrEqual(0)
        expect(p.gaitPhase).toBeLessThan(1)
      }
      prev = f
    }
  })

  it('모든 actionT는 0~1', () => {
    for (const type of ['goal', 'shot', 'save', 'corner', 'foul'] as const) {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      let prev: FrameState | null = null
      for (let k = 0; k <= 20; k++) {
        const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 20, sequence: seq, sequenceSide: 'home', event: e }))
        for (const p of f.players) {
          expect(p.actionT).toBeGreaterThanOrEqual(0)
          expect(p.actionT).toBeLessThanOrEqual(1)
        }
        prev = f
      }
    }
  })
})

describe('yaw(바라보는 방향)', () => {
  const shortest = (a: number, b: number) => {
    let d = (b - a) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return Math.abs(d)
  }

  it('한 프레임 yaw 변화가 급회전하지 않는다(스무딩)', () => {
    const first = computeFrame(input())
    const prev: FrameState = { ...first, players: first.players.map(p => ({ ...p, x: -40, z: 0, yaw: 2.5 })) }
    const f = computeFrame(input({ prev, dt: 0.016, t: 0.5, sequence: pinnedBall(90, 50), sequenceSide: 'home' }))
    for (const p of f.players) expect(shortest(2.5, p.yaw)).toBeLessThan(0.6)
  })

  it('정지하면 볼 쪽을 바라본다', () => {
    let prev: FrameState | null = computeFrame(input({ sequence: pinnedBall(90, 50), sequenceSide: 'home', t: 0 }))
    for (let k = 1; k <= 100; k++) {
      prev = computeFrame(input({ prev, dt: 0.05, t: k / 100, sequence: pinnedBall(90, 50), sequenceSide: 'home' }))
    }
    const f = prev!
    for (const p of f.players) {
      if (p.speed >= 0.4) continue
      expect(shortest(Math.atan2(f.ball.z - p.z, f.ball.x - p.x), p.yaw)).toBeLessThan(0.3)
    }
  })
})

describe('focus 스무딩', () => {
  it('하이라이트 중 focus가 볼을 향해 수렴한다', () => {
    const seq = pinnedBall(95, 20)
    let prev: FrameState | null = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0 }))
    const d0 = Math.hypot(prev!.focus.x - prev!.ball.x, prev!.focus.z - prev!.ball.z)
    for (let k = 0; k < 10; k++) {
      prev = computeFrame(input({ prev, dt: 0.05, t: 0.5, sequence: seq, sequenceSide: 'home' }))
    }
    const d1 = Math.hypot(prev!.focus.x - prev!.ball.x, prev!.focus.z - prev!.ball.z)
    expect(d1).toBeLessThanOrEqual(d0 + 1e-9)
    expect(d1).toBeLessThan(1)
  })

  it('프레임 간 focus 점프가 없다(스무딩)', () => {
    const far = pinnedBall(99, 5)
    const start = computeFrame(input({ sequence: pinnedBall(1, 95), sequenceSide: 'home', t: 0 }))
    const next = computeFrame(input({ prev: start, dt: 0.016, t: 0.5, sequence: far, sequenceSide: 'home' }))
    const jump = Math.hypot(next.focus.x - start.focus.x, next.focus.z - start.focus.z)
    expect(jump).toBeLessThan(10)
    expect(jump).toBeGreaterThan(0)
  })

  it('평시(시퀀스 없음) focus는 중앙 근처', () => {
    const f = computeFrame(input())
    expect(Math.hypot(f.focus.x, f.focus.z)).toBeLessThan(15)
  })
})

describe('볼 스핀', () => {
  it('굴러간 거리만큼 누적되고 0~2π로 감긴다', () => {
    let prev: FrameState | null = computeFrame(input({ sequence: pinnedBall(20, 50), sequenceSide: 'home', t: 0 }))
    expect(prev!.ball.spin).toBe(0)
    for (let k = 1; k <= 10; k++) {
      prev = computeFrame(input({ prev, dt: 0.05, t: k / 10, sequence: pinnedBall(20 + k * 5, 50), sequenceSide: 'home' }))
      expect(prev.ball.spin).toBeGreaterThanOrEqual(0)
      expect(prev.ball.spin).toBeLessThan(Math.PI * 2)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B-2: 보폭 모델 통일 — movement가 계산한 gaitPhase가 렌더러의 정본이다
// ─────────────────────────────────────────────────────────────────────────────

describe('gaitPhase(보폭 위상)', () => {
  /** 한 선수를 dt 간격으로 n프레임 굴리며 (속도, 위상) 궤적을 얻는다. */
  function trace(n: number, dt: number): { speed: number; phase: number }[] {
    let prev: FrameState | null = null
    const out: { speed: number; phase: number }[] = []
    for (let k = 0; k < n; k++) {
      const f: FrameState = computeFrame(input({ prev, dt, t: (k % 20) / 20, minute: 30 }))
      const p = f.players[5]
      out.push({ speed: p.speed, phase: p.gaitPhase! })
      prev = f
    }
    return out
  }

  it('위상 증가분 = 이동거리 / strideLength(speed) — 공유 보폭 모델을 쓴다', () => {
    const dt = 1 / 60
    const tr = trace(40, dt)
    let checked = 0
    for (let i = 1; i < tr.length; i++) {
      const v = tr[i].speed
      if (v < 1) continue // 정지 구간은 최소 보행 속도 바닥이 걸려 별도 계약
      const expected = (v * dt) / strideLength(v)
      let d = tr[i].phase - tr[i - 1].phase
      if (d < 0) d += 1 // 랩어라운드
      expect(d).toBeCloseTo(expected, 9)
      checked++
    }
    expect(checked).toBeGreaterThan(5)
  })

  it('상수 보폭(옛 STRIDE=2.2)과는 다른 값이다 — 회귀 가드', () => {
    const dt = 1 / 60
    const tr = trace(40, dt)
    const fast = tr.find((r) => r.speed > 4)
    expect(fast).toBeDefined()
    expect(strideLength(fast!.speed)).not.toBeCloseTo(2.2, 2)
  })

  it('22명의 초기 위상이 서로 다르다(한 몸처럼 걷지 않는다)', () => {
    const f = computeFrame(input())
    const phases = new Set(f.players.map((p) => p.gaitPhase!.toFixed(6)))
    expect(phases.size).toBeGreaterThan(18)
  })

  it('run의 actionT는 곧 gaitPhase다(더 이상 죽은 값이 아니다)', () => {
    let prev: FrameState | null = null
    let found = 0
    for (let k = 0; k < 30; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 1 / 60, t: k / 30 }))
      for (const p of f.players) {
        if (p.action !== 'run') continue
        expect(p.actionT).toBe(p.gaitPhase)
        found++
      }
      prev = f
    }
    expect(found).toBeGreaterThan(0)
  })

  it('위상은 액션과 무관하게 계속 진행한다(킥·세리머니 뒤 다리가 튀지 않게)', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    let prev: FrameState | null = null
    let moved = 0
    for (let k = 0; k <= 20; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 20, sequence: seq, sequenceSide: 'home', event: e }))
      if (prev) {
        for (const p of f.players) {
          if (p.action === 'run') continue
          const q = prev.players.find((o) => o.id === p.id)!
          if (Math.abs(p.gaitPhase! - q.gaitPhase!) > 1e-9) moved++
        }
      }
      prev = f
    }
    expect(moved).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3D 정적 배치 ↔ 2D 작전판 정합 — 같은 정본(tacticalCoords)에서 파생돼야 한다
// ─────────────────────────────────────────────────────────────────────────────

describe('전술 좌표 정합(3D ↔ 2D)', () => {
  /** lineHeight/pressing만 바꾼 상태(양 팀 동일). 나머지는 base 그대로. */
  function withInstructions(lineHeight: number, pressing = 50): MatchState {
    const patch = (st: MatchState['home']) => ({
      ...st,
      tactics: { ...st.tactics, instructions: { ...st.tactics.instructions, lineHeight, pressing } },
    })
    return { ...base, home: patch(base.home), away: patch(base.away) }
  }

  /** 정적 배치 프레임(안무 없음·볼 중앙 고정·prev 없음) — 무버 개입 없이 앵커만 본다. */
  const staticFrame = (state: MatchState) =>
    computeFrame(input({ state, sequence: pinnedBall(50, 50), sequenceSide: 'home', t: 0.5 }))

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }

  /** 각 필드 플레이어의 실제 포즈 ↔ 앵커 좌표 거리(m). GK는 박스 로직이라 제외. */
  function deviations(f: FrameState, state: MatchState, anchor: 'slot' | 'tactical'): number[] {
    const out: number[] = []
    for (const side of ['home', 'away'] as const) {
      const st = state[side]
      st.tactics.lineup.forEach((slot, i) => {
        if (i === 0) return
        const c = anchor === 'slot'
          ? slotCoords(st.tactics.formation, i, side)
          : tacticalCoords(st.tactics.formation, i, side, st.tactics.instructions)
        const w = toWorld(c.x, c.y)
        const p = find(f, slot.playerId)
        out.push(Math.hypot(p.x - w.x, p.z - w.z))
      })
    }
    return out
  }

  // 중앙값을 쓰는 이유: 볼 수렴(CONVERGE_COUNT=3명/팀)이 소수의 선수를 최대 12m 당긴다.
  // 나머지 대다수는 앵커 + 미세 흔들림(최대 √2·1.1 ≈ 1.56m)만 받으므로 중앙값이
  // "정적 배치가 어느 좌표계를 쓰는가"를 오염 없이 드러낸다(볼 중앙 → 라인 시프트 0).
  const WOBBLE_MAX = Math.hypot(1.1, 1.1)

  for (const lineHeight of [10, 90] as const) {
    it(`극단 lineHeight ${lineHeight}에서 정적 배치가 tacticalCoords를 따른다`, () => {
      const state = withInstructions(lineHeight)
      const f = staticFrame(state)
      expect(median(deviations(f, state, 'tactical'))).toBeLessThanOrEqual(WOBBLE_MAX)
    })

    it(`극단 lineHeight ${lineHeight}에서 slotCoords 원형과는 유의미하게 어긋난다(회귀 가드)`, () => {
      const state = withInstructions(lineHeight)
      const f = staticFrame(state)
      // 흔들림만으로는 절대 나올 수 없는 이탈 — 예전 slotCoords 배치로 되돌아가면 여기서 걸린다.
      expect(median(deviations(f, state, 'slot'))).toBeGreaterThan(WOBBLE_MAX * 3)
    })
  }

  it('lineHeight를 올리면 3D 백라인도 실제로 전진한다(2D 라인 마커와 같은 방향)', () => {
    const low = staticFrame(withInstructions(10))
    const high = staticFrame(withInstructions(90))
    const backline = backlineIndices(base.home.tactics.formation)
    const meanX = (f: FrameState) =>
      backline.reduce((s, i) => s + find(f, homeId(i)).x, 0) / backline.length
    // 0~100 좌표의 lineDepth 차이를 월드 m로 환산한 값에 근접해야 한다.
    // 완전 일치가 아닌 이유: 볼 수렴·경계 클램프가 개별 수비수를 몇 m 흔든다(WOBBLE_MAX 이내가
    // 아니라 수렴 폭까지 열어둔다). slotCoords 시절엔 이 차이가 0에 가까웠다 — 큰 회귀 신호.
    const expected = ((lineDepth(90) - lineDepth(10)) / 100) * PITCH_W
    expect(Math.abs(meanX(high) - meanX(low) - expected)).toBeLessThan(2.5)
  })
})

describe('저속 히스테리시스', () => {
  // 분리 밀어내기·목표 흔들림 때문에 실측 속도는 IDLE_SPEED(0.4) 근처에서 프레임마다
  // 오르내린다. 단일 문턱이면 run↔idle이 깜빡이고 매번 0.3s 크로스페이드가 재시작돼
  // 발이 떤다. 이탈 문턱을 진입 문턱의 60%(0.24)로 낮춰 그 구간을 흡수한다.
  it('run 중 속도가 이탈 문턱 위에 있으면 idle로 떨어지지 않는다', () => {
    let band = 0
    // ★ 무사건 분의 볼이 리사주 곡선에서 **패스 체인**으로 바뀐 뒤(smoothstep) 속도가
    //   양극화되어 무사건 케이스만으로는 문턱 밴드 표본이 줄었다. 안무 케이스를 함께
    //   돌려 표본을 유지한다 — 도착 감속(ARRIVE_RADIUS)이 밴드를 반드시 통과시킨다.
    const goalSeq = buildSequence(ev('goal'), base.home, base.away)
    const cases: { dts: number[]; seq: ChoreoStep[] | null }[] = [
      { dts: [0.02, 0.09], seq: null },
      { dts: [1 / 60, 1 / 60], seq: null },
      { dts: [0.03, 0.05, 0.11], seq: null },
      { dts: [0.02, 0.05], seq: goalSeq },
      { dts: [1 / 60, 1 / 60], seq: goalSeq },
      { dts: [0.03, 0.07], seq: buildSequence(ev('save'), base.home, base.away) },
      { dts: [1 / 60, 0.04], seq: buildSequence(ev('corner'), base.home, base.away) },
    ]
    for (const { dts, seq } of cases) {
      let prev: FrameState | null = null
      for (let k = 0; k < 200; k++) {
        const f: FrameState = computeFrame(
          input({
            prev, dt: dts[k % dts.length], t: (k % 20) / 20, minute: 30 + Math.floor(k / 20),
            ...(seq ? { sequence: seq, sequenceSide: 'home' as const } : {}),
          }),
        )
        if (prev) {
          for (const p of f.players) {
            const q = prev.players.find((o) => o.id === p.id)!
            if (q.action !== 'run') continue
            // 킥·다이브·세리머니·다운은 run/idle 판정을 **덮어쓴다**(computeFrame §5).
            // 이 테스트가 고정하는 것은 그 아래의 히스테리시스뿐이다.
            if (p.action === 'kick' || p.action === 'dive' || p.action === 'celebrate' || p.action === 'down') continue
            if (p.speed >= 0.24 && p.speed < 0.4) {
              band++
              expect(p.action).toBe('run') // 히스테리시스가 없으면 여기서 idle이 된다
            }
            if (p.speed < 0.24) expect(p.action).not.toBe('run')
          }
        }
        prev = f
      }
    }
    expect(band).toBeGreaterThan(20) // 실제로 문턱 밴드를 지나갔는지(공허한 통과 방지)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 2026-07-30 물리·인과 개편 (docs/research/football-sim-physics.md)
//   사용자 원문: "공을 차는 느낌이 없고 공이 혼자 떠다닌다 / 너무 빠르다 /
//   공이 가지도 않았는데 GK가 먼저 넘어진다". 아래가 그 셋의 회귀 가드다.
// ─────────────────────────────────────────────────────────────────────────────

describe('★ R5 — 골이 크로스바 아래로 들어간다', () => {
  // 예전 `ballHeight('shot', u) = 0.11 + 2.39·sin(πu/2)`는 **끝에서 정점**이라
  // 골라인 통과 높이가 항상 정확히 2.50 m였다. 크로스바는 2.44 m다.
  const CROSSBAR = 2.44

  it('슛 아크의 도착 높이가 1.05 m이고 정점도 크로스바 아래다', () => {
    expect(BALL_END.shot).toBeCloseTo(1.05, 6)
    expect(ballHeight('shot', 1)).toBeCloseTo(BALL_END.shot, 6)
    let peak = 0
    for (let i = 0; i <= 1000; i++) peak = Math.max(peak, ballHeight('shot', i / 1000))
    expect(peak).toBeCloseTo(BALL_PEAK.shot, 4)
    expect(peak).toBeLessThan(CROSSBAR)
  })

  it('전 패턴·전 변형의 골 장면에서 볼이 크로스바를 넘지 않는다', () => {
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      const st = structuredClone(base)
      st.home.tactics.attackPattern = pattern
      for (const minute of [12, 27, 41, 58, 73, 88]) {
        const e = ev('goal', { minute, playerId: st.home.tactics.lineup[9].playerId })
        const seq = buildSequence(e, st.home, st.away)
        let maxAfterShot = 0
        const tShot = seq.find(p => p.arc === 'shot')!.t
        for (let i = 0; i <= 400; i++) {
          const t = i / 400
          if (t < tShot) continue
          const f = computeFrame(input({ state: st, sequence: seq, sequenceSide: 'home', t, event: e, minute }))
          maxAfterShot = Math.max(maxAfterShot, f.ball.y)
        }
        expect(maxAfterShot, `${pattern}/${minute}`).toBeLessThan(CROSSBAR)
      }
    }
  })
})

describe('★ R1 — 볼이 감속한다(항력 곡선)', () => {
  it('dragProgress는 u(0)=0, u(1)=1이고 항상 선형보다 앞선다(= 감속)', () => {
    for (const kind of ['pass', 'shot', 'cross', 'ground'] as const) {
      for (const S of [5, 12, 25, 40]) {
        expect(dragProgress(kind, S, 0)).toBeCloseTo(0, 9)
        expect(dragProgress(kind, S, 1)).toBeCloseTo(1, 9)
        for (const tau of [0.15, 0.35, 0.5, 0.75, 0.9]) {
          expect(dragProgress(kind, S, tau), `${kind}/${S}/${tau}`).toBeGreaterThan(tau)
        }
      }
    }
  })

  it('거리 0(컨트롤 정지) 구간은 선형으로 되돌아간다', () => {
    for (const tau of [0, 0.3, 0.7, 1]) expect(dragProgress('pass', 0, tau)).toBeCloseTo(tau, 9)
  })

  it('긴 구간일수록 감속이 크다(같은 τ에서 진행도가 더 앞선다)', () => {
    expect(dragProgress('shot', 40, 0.5)).toBeGreaterThan(dragProgress('shot', 10, 0.5))
    // 지면 구름은 공중보다 더 빨리 죽는다(잔디 저항).
    expect(dragProgress('ground', 20, 0.5)).toBeGreaterThan(dragProgress('pass', 20, 0.5))
  })

  it('실제 하이라이트 재생에서 구간 안 볼 속도가 단조 감소한다', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    // 슛 구간을 5등분해 앞뒤 속도를 잰다 — 예전엔 선형 lerp라 완전히 일정했다.
    const tShot = seq.findIndex(p => p.arc === 'shot')
    const t0 = seq[tShot].t
    const t1 = seq[tShot + 1].t
    const at = (t: number) => computeFrame(input({ sequence: seq, sequenceSide: 'home', t, event: e })).ball
    const speeds: number[] = []
    const N = 8
    for (let i = 0; i < N; i++) {
      const a = at(t0 + ((t1 - t0) * i) / N)
      const b = at(t0 + ((t1 - t0) * (i + 1)) / N)
      speeds.push(Math.hypot(b.x - a.x, b.z - a.z))
    }
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThan(speeds[i - 1])
  })
})

describe('★ R4 — GK가 볼보다 먼저 넘어지지 않는다', () => {
  it('다이브 최대 신전(u=0.55)이 볼 도착과 정확히 일치한다', () => {
    const dwell = 8400
    for (const [imp, arr] of [[0.4, 0.5], [0.2, 0.9], [0.55, 0.62]] as const) {
      expect(diveScheduleAt(imp, arr, arr, dwell)).toBeCloseTo(0.55, 9)
      // 도착 전에는 아직 눕지 않았다.
      expect(diveScheduleAt(imp, arr, arr - 0.01, dwell)!).toBeLessThan(0.55)
      // 도착 이후에만 착지·정착이 진행된다.
      expect(diveScheduleAt(imp, arr, arr + 0.05, dwell)!).toBeGreaterThan(0.55)
    }
  })

  it('반응 지연 — 슛 임팩트 직후에는 아직 뛰지 않는다', () => {
    const dwell = 8400
    const imp = 0.4
    const arr = 0.4 + 0.9 // 아주 먼 슛(도착이 늦다)
    expect(diveScheduleAt(imp, arr, imp, dwell)).toBeNull()
    expect(diveScheduleAt(imp, arr, imp + (GK_REACTION_MS / 2) / dwell, dwell)).toBeNull()
  })

  it('먼 슛일수록 늦게 반응한다(다이브 지속은 GK_DIVE_MS로 고정)', () => {
    const dwell = 8400
    const dive = GK_DIVE_MS / dwell
    // 도착까지 여유가 크면 시작은 "도착 − 550 ms"다.
    const arr = 0.9
    expect(diveScheduleAt(0.1, arr, arr - dive - 1e-6, dwell)).toBeNull()
    expect(diveScheduleAt(0.1, arr, arr - dive + 1e-6, dwell)).not.toBeNull()
  })

  it('실제 save 장면 재생: GK가 완전히 눕는 시각이 볼 도착보다 앞서지 않는다', () => {
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      const st = structuredClone(base)
      st.home.tactics.attackPattern = pattern
      // ★ save의 teamId·playerId는 **막은 팀과 그 GK**다(simulate.ts L649). 홈이 공격하는
      //   세이브를 만들려면 teamId를 어웨이로 준다 — 예전 픽스처는 이 규약을 반대로 알고
      //   있었고, 그래서 화면이 사건의 거울상이라는 사실을 아무 테스트도 잡지 못했다.
      const e = ev('save', { minute: 55, teamId: st.away.team.id, playerId: st.away.tactics.lineup[0].playerId })
      const seq = buildSequence(e, st.home, st.away)
      const dwell = 8400
      const tArrive = seq[seq.length - 1].t
      let laidAt: number | null = null
      let prev: FrameState | null = null
      const N = 600
      for (let k = 0; k <= N; k++) {
        const t = k / N
        const f: FrameState = computeFrame(
          input({ state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home', event: e, minute: 55, dwellMs: dwell }),
        )
        const gk = f.players.find(p => p.id === st.away.tactics.lineup[0].playerId)!
        if (laidAt == null && gk.action === 'dive' && gk.actionT >= 0.55) laidAt = t
        prev = f
      }
      expect(laidAt, `${pattern}: GK가 눕지 않았다`).not.toBeNull()
      // 프레임 격자(1/600) 오차만 허용한다. 예전 실측은 −473 ms(= −0.11 dwell)였다.
      const leadMs = (tArrive - laidAt!) * dwell
      expect(leadMs, `${pattern}: GK가 볼보다 ${leadMs.toFixed(0)} ms 먼저 누웠다`).toBeLessThan(30)
    }
  })

  it('다이브가 볼 쪽을 향한다 — **손이 접촉점에 오는 쪽**으로 눕는다', () => {
    // ★ 예전 계약은 `actionDir`의 부호를 월드 Z와 직접 비교했다. 그것은 GK의 yaw를
    //   통제하지 않던 시절의 근사다(그래서 home/away를 뒤집는 보정이 붙어 있었다).
    //   지금은 접촉 기하가 yaw와 dir을 함께 정하므로, 계약은 부호가 아니라
    //   **손이 실제로 볼 쪽에 있는가**로 적는 것이 옳다(더 강한 조건이다).
    const st = structuredClone(base)
    const e = ev('save', { minute: 55, teamId: st.away.team.id, playerId: st.away.tactics.lineup[0].playerId })
    const seq = buildSequence(e, st.home, st.away)
    const tEnd = (seq.find(s2 => s2.contact) ?? seq[seq.length - 1]).t
    let prev: FrameState | null = null
    let best = Infinity
    const N = 600
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.min(1, tEnd + 0.05)
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home', event: e, minute: 55, dwellMs: 8400,
      }))
      prev = f
      const gk = f.players.find(p => p.id === st.away.tactics.lineup[0].playerId)!
      if (gk.action !== 'dive') continue
      const hand = gkHandWorld({ x: gk.x, z: gk.z }, gk.yaw, gk.actionT, gk.actionDir ?? 1)
      best = Math.min(best, Math.hypot(hand.x - f.ball.x, hand.y - f.ball.y, hand.z - f.ball.z))
    }
    expect(Number.isFinite(best), 'GK가 다이브하지 않았다').toBe(true)
    expect(best, `최소 손-공 ${best.toFixed(2)} m`).toBeLessThan(0.33)
  })
})

describe('★ R2 — 공은 캐리어의 발에 있다', () => {
  it('킥 임팩트 순간 렌더된 캐리어가 볼에서 1.5 m 안에 있다(전 이벤트 타입)', () => {
    let worst = 0
    let worstTag = ''
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      const st = structuredClone(base)
      st.home.tactics.attackPattern = pattern
      for (const type of ['goal', 'save', 'miss', 'shot'] as const) {
        for (const minute of [12, 37, 64, 81]) {
          const e = ev(type, { minute, playerId: st.home.tactics.lineup[9].playerId })
          const seq = buildSequence(e, st.home, st.away)
          const dwell = 8400
          const kicks = kickEvents(seq)
          let prev: FrameState | null = null
          const N = 500
          for (let k = 0; k <= N; k++) {
            const t = k / N
            const f: FrameState = computeFrame(
              input({ state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home', event: e, minute, dwellMs: dwell }),
            )
            for (const kick of kicks) {
              if (Math.abs(t - kick.tImpact) > 0.5 / N) continue
              const p = f.players.find(q => q.id === kick.playerId)!
              const d = Math.hypot(p.x - f.ball.x, p.z - f.ball.z)
              if (d > worst) { worst = d; worstTag = `${pattern}/${type}/${minute}` }
            }
            prev = f
          }
        }
      }
    }
    // 예전 실측: 저술 키프레임에서 볼-무버 거리 6.7 ~ 17.9 m.
    expect(worst, `최악 볼-캐리어 거리 ${worst.toFixed(2)} m @ ${worstTag}`).toBeLessThan(1.5)
  })

  it('킥을 받는 선수는 항상 이벤트의 주인공(playerId)을 포함한다', () => {
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      const st = structuredClone(base)
      st.home.tactics.attackPattern = pattern
      const shooter = st.home.tactics.lineup[9].playerId
      for (const minute of [9, 31, 52, 77]) {
        const e = ev('goal', { minute, playerId: shooter })
        const kicks = kickEvents(buildSequence(e, st.home, st.away))
        // 마지막 킥 = 슛. 그 주인공은 엔진이 정한 선수여야 한다.
        expect(kicks[kicks.length - 1].playerId, `${pattern}/${minute}`).toBe(shooter)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 2026-07-31 "읽힘" 개편 — 수치는 맞는데 화면이 안 읽히던 간극.
//   사용자 캡처(docs/audit/shots/entrance-after-1600x900-play-2.png): GK는 이미 완전히
//   누워 있고 공은 8 m 밖 빈 잔디에, 슈터는 프레임 밖. 실측으로 셋 다 재현됐다 —
//   GK-볼 최소거리 7.03 m / 볼 도착 시각 슈터 NDC x = -1.29. 아래가 그 회귀 가드다.
// ─────────────────────────────────────────────────────────────────────────────

/** 카메라 샷에 점을 투영해 NDC를 얻는다(three 없이 — camera.ts와 같은 up=(0,1,0) 규약). */
function ndc(shot: CameraShot, p: { x: number; y: number; z: number }, aspect: number) {
  const f = { x: shot.lookAt.x - shot.pos.x, y: shot.lookAt.y - shot.pos.y, z: shot.lookAt.z - shot.pos.z }
  const fl = Math.hypot(f.x, f.y, f.z)
  const fw = { x: f.x / fl, y: f.y / fl, z: f.z / fl }
  const rl = Math.hypot(fw.z, fw.x) || 1
  const r = { x: fw.z / rl, y: 0, z: -fw.x / rl }
  const u = {
    x: r.y * fw.z - r.z * fw.y,
    y: r.z * fw.x - r.x * fw.z,
    z: r.x * fw.y - r.y * fw.x,
  }
  const d = { x: p.x - shot.pos.x, y: p.y - shot.pos.y, z: p.z - shot.pos.z }
  const zc = d.x * fw.x + d.y * fw.y + d.z * fw.z
  if (zc <= 0.01) return { x: 99, y: 99 }
  const th = Math.tan((shot.fov * Math.PI) / 360)
  return {
    x: (d.x * r.x + d.y * r.y + d.z * r.z) / (zc * th * aspect),
    y: (d.x * u.x + d.y * u.y + d.z * u.z) / (zc * th),
  }
}

/**
 * 한 장면을 dwell 전체에 걸쳐 60 fps로 재생하며 프레임을 모은다.
 *
 * ★ 이벤트를 **엔진과 같은 규약**으로 만든다: `save`의 teamId·playerId는 막은 팀과 그
 *   팀의 GK다(simulate.ts L649). 그래서 홈이 공격하는 세이브를 만들려면 teamId를
 *   어웨이로 줘야 한다. 슈터는 안무가 역할 좌표로 뽑으므로 무버 0에서 읽는다.
 */
function playScene(type: MatchEvent['type'], pattern: 'balanced' | 'cross' | 'through' | 'longshot', minute = 55) {
  const st = structuredClone(base)
  st.home.tactics.attackPattern = pattern
  const e: MatchEvent = type === 'save'
    ? ev('save', { minute, teamId: st.away.team.id, playerId: st.away.tactics.lineup[0].playerId })
    : ev(type, { minute, playerId: st.home.tactics.lineup[9].playerId })
  const seq = buildSequence(e, st.home, st.away)
  const shooter = seq[0].movers[0].playerId
  const dwell = 8400
  const gkId = st.away.tactics.lineup[0].playerId // 홈이 공격하므로 막는 쪽은 어웨이 GK
  const frames: FrameState[] = []
  let prev: FrameState | null = null
  const N = 504 // 8.4 s × 60 fps
  for (let k = 0; k <= N; k++) {
    const f: FrameState = computeFrame(
      input({ state: st, prev, dt: 1 / 60, t: k / N, sequence: seq, sequenceSide: 'home', event: e, minute, dwellMs: dwell }),
    )
    frames.push(f)
    prev = f
  }
  return { seq, frames, gkId, shooter, dwell }
}

describe('★ R6 — 세이브에 접촉 프레임이 존재한다', () => {
  it('접촉 스텝이 저술돼 있고 GK 손이 닿는 거리까지 들어온다(전 패턴)', () => {
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      const { seq, frames, gkId } = playScene('save', pattern)
      expect(seq.some(s => s.contact), pattern).toBe(true)
      let best = Infinity
      for (const f of frames) {
        const gk = f.players.find(p => p.id === gkId)!
        best = Math.min(best, Math.hypot(f.ball.x - gk.x, f.ball.z - gk.z))
      }
      // 예전 실측 7.03 m — 신전 반경 2 m를 5 m 초과해 접촉이 불가능했다.
      expect(best, `${pattern}: GK-볼 최소거리 ${best.toFixed(2)} m`).toBeLessThanOrEqual(GK_DIVE_REACH + 0.05)
    }
  })

  it('골에서는 GK가 던지되 닿지 않는다 — 최대 신전이 볼 통과보다 늦다', () => {
    const { seq, frames, gkId, dwell } = playScene('goal', 'balanced')
    const tArrive = seq[seq.length - 1].t
    let laidAt: number | null = null
    frames.forEach((f, i) => {
      const gk = f.players.find(p => p.id === gkId)!
      if (laidAt == null && gk.action === 'dive' && gk.actionT >= 0.55) laidAt = i / (frames.length - 1)
    })
    expect(laidAt, '골 장면에서 GK가 몸을 던지지 않았다').not.toBeNull()
    // 늦는다 = 못 막았다. 프레임 격자(1/504 dwell ≈ 17 ms) 오차를 뺀 하한.
    expect((laidAt! - tArrive) * dwell).toBeGreaterThan(GK_BEATEN_LATE_MS - 25)
  })

  it('gkDiveAnchor는 손이 접촉점에 닿는 몸통 자리를 주고, 그 자리는 GK 박스 안이다', () => {
    // ★ 예전 계약은 "접촉점에서 스칼라 반경 2.0 m만큼 물러난 자리"였다. 실제 손의 도달은
    //   방향이 있다 — 로컬 (−0.40, 1.01, ±1.80)이라 거의 전부 **측방**이다. 그래서 스칼라
    //   반경으로 물린 몸통의 손은 접촉점에 닿지 않았다(실측 손-공 최소 1.42~3.46 m, 접촉 0프레임).
    //   지금 계약은 순기구학의 역함수라는 것 자체다.
    for (const side of ['home', 'away'] as const) {
      const box = gkBox(side)
      for (const cz of [-4.5, -2, 0, 2, 4.5]) {
        const gx = side === 'home' ? -PITCH_W / 2 : PITCH_W / 2
        const contact = { x: gx - (side === 'home' ? -2.6 : 2.6), z: cz }
        const from = { x: side === 'home' ? contact.x + 18 : contact.x - 18, z: cz * 0.4 }
        const a = gkDiveAnchor(side, contact, from)
        const hand = gkHandWorld(a, a.yaw, DIVE_LAY_U, a.dir)
        expect(Math.hypot(hand.x - contact.x, hand.z - contact.z)).toBeLessThan(1e-9)
        expect(hand.y).toBeCloseTo(GK_HAND_HEIGHT, 6)
        // 수평 도달 거리는 순기구학이 정한 값이다(상수 GK_DIVE_REACH가 그것을 재수출한다).
        expect(Math.hypot(a.x - contact.x, a.z - contact.z)).toBeCloseTo(GK_DIVE_REACH, 6)
        expect(a.x).toBeGreaterThanOrEqual(box.xMin - 1e-9)
        expect(a.x).toBeLessThanOrEqual(box.xMax + 1e-9)
        expect(Math.abs(a.z)).toBeLessThanOrEqual(box.zMax + 1e-9)
      }
    }
  })
})

describe('★ R7 — 슛 국면에 슈터가 프레임 안에 남는다', () => {
  const ASPECT = 16 / 9

  it('임팩트·볼 도착 두 시각 모두에서 슈터·GK·볼이 전부 프레임 안이다', () => {
    for (const type of ['save', 'goal', 'miss'] as const) {
      for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
        const { seq, frames, gkId, shooter } = playScene(type, pattern)
        const tShot = seq.filter(s => s.arc === 'shot').pop()!.t
        const tArrive = seq[seq.length - 1].t
        const rig = createCameraRig({ seed: 42, mode: 'highlight' })
        let atShot: CameraShot | null = null
        let atArrive: CameraShot | null = null
        frames.forEach((f, i) => {
          const t = i / (frames.length - 1)
          const shot = rig.update({ focus: { ...f.focus, r: f.focusRadius ?? 0 }, t: i / 60, dt: 1 / 60 })
          if (atShot == null && t >= tShot) atShot = shot
          if (atArrive == null && t >= tArrive) atArrive = shot
        })
        const idx = (t: number) => Math.round(t * (frames.length - 1))
        for (const [label, shot, f] of [
          ['임팩트', atShot!, frames[idx(tShot)]],
          ['도착', atArrive!, frames[idx(tArrive)]],
        ] as const) {
          const sh = f.players.find(p => p.id === shooter)!
          const gk = f.players.find(p => p.id === gkId)!
          for (const [who, pt] of [
            ['슈터', { x: sh.x, y: 1, z: sh.z }],
            ['GK', { x: gk.x, y: 1, z: gk.z }],
            ['볼', { x: f.ball.x, y: f.ball.y, z: f.ball.z }],
          ] as const) {
            const n = ndc(shot, pt, ASPECT)
            const tag = `${type}/${pattern}/${label}/${who} → NDC ${n.x.toFixed(2)},${n.y.toFixed(2)}`
            expect(Math.abs(n.x), tag).toBeLessThanOrEqual(1)
            expect(Math.abs(n.y), tag).toBeLessThanOrEqual(1)
          }
        }
      }
    }
  })

  it('focusRadius는 슛 국면에만 열리고 빌드업·여운에는 0에 수렴한다', () => {
    const { seq, frames } = playScene('save', 'balanced')
    const tShot = seq.filter(s => s.arc === 'shot').pop()!.t
    const idx = (t: number) => Math.round(t * (frames.length - 1))
    // 빌드업 초반(임팩트 2 s 전)에는 닫혀 있다.
    expect(frames[idx(Math.max(0, tShot - 2 / 8.4))].focusRadius ?? 0).toBeLessThan(1)
    // 임팩트에서는 슈터-접촉점 반경이 열려 있다.
    // ★ 하한을 8 → 5로 내렸다. 예전 저술은 모든 슛이 골문 26.9 m에서 나가 반경이 항상
    //   12 m를 넘었는데, 그 값 자체가 사용자 지적 ①("너무 먼 곳에서 중거리 슛")이었다.
    //   실측 분포로 재저술한 지금 세이브 슛은 16.8~20.6 m이고 반경은 6.6~9 m다.
    expect(frames[idx(tShot)].focusRadius ?? 0).toBeGreaterThan(5)
    // dwell 끝(여운)에는 다시 닫혀 결과 지점에 붙는다.
    expect(frames[frames.length - 1].focusRadius ?? 0).toBeLessThan(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2026-07-31 4대 연출 결함 — 사용자가 세 번째로 지적한 항목들의 회귀 고정.
//
// 계측 도구: `node tools/sim-audit/run.mjs` (90분 실주행 60 fps 프레임 단위).
// 아래 테스트는 그 계측이 잡아낸 것을 **단위 수준에서 다시 못박는다.**
// ═══════════════════════════════════════════════════════════════════════════

describe('★ ① 공은 차는 것과 무관하게 움직이지 않는다 — 장면 전환 후에도', () => {
  /**
   * 왜 기존 R2 테스트로 부족했나: 기존 테스트는 매 장면을 `prev = null`로 시작한다.
   * 그러면 첫 프레임에 22명이 안무 좌표로 **스냅**하므로 무버가 항상 제자리에 있다.
   * 실제 게임은 다르다 — Match3D가 분 경계에서 prev를 **일부러 유지**하므로(리셋하면
   * 22명이 순간이동한다) 새 장면은 직전 분이 남긴 자리에서 시작한다. 실측(90분 실주행)에서
   * 그 조건의 소유 중 볼-발 거리는 t 0.1~0.2 구간 **p50 11.76 m**였다.
   */
  const heldDistances = (type: MatchEvent['type'], warmType: MatchEvent['type']) => {
    const st = structuredClone(base)
    const dwell = 8400
    // ① 먼저 다른 장면을 끝까지 재생해 22명을 "엉뚱한 자리"에 남긴다.
    const warm = buildSequence(ev(warmType, { minute: 29, playerId: homeId(7) }), st.home, st.away)
    let prev: FrameState | null = null
    for (let k = 0; k <= 200; k++) {
      prev = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / 200, sequence: warm, sequenceSide: 'home',
        event: ev(warmType, { minute: 29, playerId: homeId(7) }), minute: 29, dwellMs: dwell,
      }))
    }
    // ② 그 prev를 그대로 물려 새 장면을 시작한다(= 실제 게임의 분 경계).
    const e = ev(type, { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    const out: { t: number; d: number }[] = []
    const N = 400
    for (let k = 0; k <= N; k++) {
      const t = k / N
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: dwell, ...(k === 0 ? { cut: true } : {}),
      }))
      prev = f
      // 구간 양끝의 캐리어가 같은 "소유" 구간만 본다(비행 중에 멀어지는 것은 정상).
      let i = 0
      for (let j = 0; j < seq.length - 1; j++) if (t >= seq[j].t) i = j
      const a = seq[i]
      const b = seq[i + 1]
      if (!a?.carrier || !b || a.carrier !== b.carrier) continue
      const p = f.players.find(q => q.id === a.carrier)
      if (p) out.push({ t, d: Math.hypot(p.x - f.ball.x, p.z - f.ball.z) })
    }
    return out
  }

  it('소유 구간에서 볼-발 거리가 항상 1.0 m 이내다(직전 장면을 물려받아도)', () => {
    for (const [warm, type] of [['goal', 'save'], ['save', 'miss'], ['miss', 'goal']] as const) {
      const ds = heldDistances(type, warm)
      expect(ds.length, `${warm}→${type}: 소유 프레임이 없다`).toBeGreaterThan(20)
      const worst = ds.reduce((a, b) => (b.d > a.d ? b : a))
      expect(worst.d, `${warm}→${type}: 최악 볼-발 ${worst.d.toFixed(2)} m @ t=${worst.t.toFixed(2)}`)
        .toBeLessThan(1.0)
    }
  })

  it('무사건 분(flow)에도 소유자가 있고 공이 그 발에 있다', () => {
    const st = structuredClone(base)
    const fl = buildFlowSequence(st, 34, 42)
    expect(fl.seq.length).toBeGreaterThan(1)
    // 예전엔 carrier가 없어 무사건 분에는 킥이 한 번도 나오지 않았다.
    expect(fl.seq.filter(s => s.carrier).length).toBe(fl.seq.length)
    expect(kickEvents(fl.seq).length).toBeGreaterThan(0)
  })
})

describe('★ ② 선수 관성 — 목표가 바뀌어도 속도 벡터가 한 프레임에 꺾이지 않는다', () => {
  /** 실측(개편 전, 90분): |Δv|/dt p50 15.7 · p99 320 · max 445 m/s². 문헌 상한은 7~8. */
  it('프레임 간 속도 변화가 A_SEPARATE 상한을 넘지 않는다', () => {
    const st = structuredClone(base)
    const dwell = 8400
    const e = ev('goal', { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    let prev: FrameState | null = null
    let worst = 0
    let worstId = ''
    const dt = 1 / 60
    const N = 500
    for (let k = 0; k <= N; k++) {
      const f: FrameState = computeFrame(input({
        state: st, prev, dt, t: k / N, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: dwell,
      }))
      if (prev) {
        const pm = new Map(prev.players.map(p => [p.id, p]))
        for (const p of f.players) {
          const q = pm.get(p.id)
          if (!q || q.vx == null) continue
          const a = Math.hypot((p.vx ?? 0) - q.vx, (p.vz ?? 0) - (q.vz ?? 0)) / dt
          if (a > worst) { worst = a; worstId = p.id }
        }
      }
      prev = f
    }
    // 자력 가속은 A_ACCEL/A_BRAKE/A_LATERAL, 밀어내기(외력)는 A_SEPARATE가 상한이다.
    expect(worst, `최악 |Δv|/dt ${worst.toFixed(1)} m/s² (${worstId})`).toBeLessThanOrEqual(A_SEPARATE + 0.5)
  })

  it('한 프레임에 진행 방향이 60° 넘게 꺾이지 않는다(관성 없는 급회전 금지)', () => {
    const st = structuredClone(base)
    const e = ev('save', { minute: 30, teamId: away.id, playerId: awayId(0) })
    const seq = buildSequence(e, st.home, st.away)
    let prev: FrameState | null = null
    let flips = 0
    let samples = 0
    const N = 500
    for (let k = 0; k <= N; k++) {
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / N, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: 8400,
      }))
      if (prev) {
        const pm = new Map(prev.players.map(p => [p.id, p]))
        for (const p of f.players) {
          const q = pm.get(p.id)
          if (!q || q.vx == null) continue
          const l1 = Math.hypot(q.vx, q.vz ?? 0)
          const l2 = Math.hypot(p.vx ?? 0, p.vz ?? 0)
          if (l1 < 1.2 || l2 < 1.2) continue // 걷는 속도 미만은 방향이 의미 없다
          samples++
          const cos = (q.vx * (p.vx ?? 0) + (q.vz ?? 0) * (p.vz ?? 0)) / (l1 * l2)
          if (cos < Math.cos((60 * Math.PI) / 180)) flips++
        }
      }
      prev = f
    }
    expect(samples).toBeGreaterThan(500)
    expect(flips, `1프레임 60°+ 전환 ${flips}/${samples}`).toBe(0)
  })

  it('정지에서 최고속까지 A_ACCEL이 요구하는 시간(≥1.0 s)이 걸린다', () => {
    // 목표를 멀리 두고 정지 상태에서 출발시킨다 — 관성이 없으면 1프레임에 상한에 닿는다.
    const st = structuredClone(base)
    const dt = 1 / 60
    let prev: FrameState | null = computeFrame(input({ state: st, minute: 30, t: 0 }))
    // 시작 프레임의 속도를 0으로 만든다.
    prev = { ...prev, players: prev.players.map(p => ({ ...p, speed: 0, vx: 0, vz: 0 })) }
    const seq = pinnedBall(95, 50)
    let framesToTop = 0
    for (let k = 1; k <= 200; k++) {
      const f: FrameState = computeFrame(input({
        state: st, prev, dt, t: k / 200, sequence: seq, sequenceSide: 'home', minute: 30, dwellMs: 8400,
      }))
      const fastest = Math.max(...f.players.map(p => Math.hypot(p.vx ?? 0, p.vz ?? 0)))
      if (fastest >= MAX_SPEED * 0.95) { framesToTop = k; break }
      prev = f
    }
    // 7.5 m/s ÷ 7 m/s² ≈ 1.07 s ≈ 64 프레임. 관성이 없으면 1~2 프레임이었다.
    expect(framesToTop, `최고속 도달 ${framesToTop} 프레임`).toBeGreaterThan(50)
  })
})

describe('★ ③ 빗나간 슛은 골대 근처로 간다', () => {
  /**
   * 실측 기준: StatsBomb open-data 오프타깃 슛 7,772건.
   *  · 포스트 밖 수평 간극 p50 2.10 m · 크로스바 위 p50 2.04 m
   *  · 프레임에서 2 m 안 40.5% · 3 m 안 60.9%
   * 개편 전 우리 값은 포스트 밖 5.18 / 11.30 / 19.46 m — 전부 p90~p99 꼬리였다.
   */
  const GOAL_HALF_Z = 3.66
  const CROSSBAR = 2.44

  /** 라이브러리 전수(패턴 4 × 빌드업 2 × 마무리 3 × 레인 6)의 미스 종점. */
  const allMisses = () => {
    const out: { key: string; outZ: number; over: number; frame: number }[] = []
    for (const pattern of ['balanced', 'cross', 'through', 'longshot'] as const) {
      for (let b = 0; b < 2; b++) {
        for (let fv = 0; fv < 3; fv++) {
          for (let lane = 0; lane < 6; lane++) {
            const sc = buildScene(pattern, 'miss', lane, { buildup: b, finish: fv })
            const last = sc.points[sc.points.length - 1]
            const w = toWorld(last.ball[0], last.ball[1])
            const outZ = Math.max(0, Math.abs(w.z) - GOAL_HALF_Z)
            const over = Math.max(0, (last.endY ?? BALL_END.shot) - CROSSBAR)
            out.push({ key: sc.key, outZ, over, frame: Math.hypot(outZ, over) })
          }
        }
      }
    }
    return out
  }

  it('골대 프레임에서 8 m 넘게 벗어나는 미스가 없다', () => {
    const ms = allMisses()
    expect(ms).toHaveLength(144)
    const worst = ms.reduce((a, b) => (b.frame > a.frame ? b : a))
    expect(worst.frame, `최악 ${worst.frame.toFixed(2)} m @ ${worst.key}`).toBeLessThan(8)
  })

  it('절반 이상이 골대에서 3 m 안을 지난다(실측 60.9%)', () => {
    const ms = allMisses()
    const near = ms.filter(m => m.frame <= 3).length
    expect(near / ms.length, `3 m 안 ${((near / ms.length) * 100).toFixed(1)}%`).toBeGreaterThan(0.5)
  })

  it('세 범주(옆·위·옆+위)가 모두 나오고 실측 비율에 가깝다', () => {
    const ms = allMisses()
    const wideOnly = ms.filter(m => m.outZ > 0 && m.over === 0).length / ms.length
    const overOnly = ms.filter(m => m.outZ === 0 && m.over > 0).length / ms.length
    const both = ms.filter(m => m.outZ > 0 && m.over > 0).length / ms.length
    expect(wideOnly).toBeGreaterThan(0.35) // 실측 45.4%
    expect(overOnly).toBeGreaterThan(0.2) // 실측 27.9%
    expect(both).toBeGreaterThan(0.2) // 실측 26.6%
    expect(wideOnly + overOnly + both).toBeCloseTo(1, 6)
  })

  it('크로스바를 넘긴 공은 여운에서 골문으로 가라앉지 않고 뒤로 넘어간다', () => {
    const st = structuredClone(base)
    const e = ev('miss', { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    const endY = seq[seq.length - 1].endY
    if (endY == null || endY <= CROSSBAR) return // 이 조합은 낮은 미스다
    const tEnd = seq[seq.length - 1].t
    let prev: FrameState | null = null
    let lastX = -Infinity
    for (let k = 0; k <= 400; k++) {
      const t = k / 400
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: 8400,
      }))
      prev = f
      if (t > tEnd) lastX = Math.max(lastX, f.ball.x)
    }
    // 골라인(52.5 m)을 실제로 넘어간다 — 그 앞에서 멈춰 내려앉으면 "골대 맞고 떨어짐"이다.
    expect(lastX, `여운 끝 볼 x=${lastX.toFixed(1)} (골라인 ${PITCH_W / 2})`).toBeGreaterThan(PITCH_W / 2)
  })
})

describe('★ ④ 세이브는 손에 닿고, 잡거나 쳐낸다', () => {
  /**
   * 실측(개편 전, 90분 실주행): 다이브 프레임의 **실제 손-공 최소 거리 1.42 ~ 3.46 m**,
   * 손이 공에 닿은 프레임 **0개**. 예전 `gkDiveAnchor`가 손의 도달을 스칼라 반경 2.0 m로
   * 근사하고 방향을 "골문 중앙 쪽"으로 잡았기 때문이다 — 실제 도달은 거의 전부 **측방**
   * (로컬 ±Z 1.80 m)이고 몸통보다 0.40 m 뒤이며 높이는 1.01 m다.
   */
  const savePlay = (minute: number) => {
    const st = structuredClone(base)
    // 엔진과 같은 형태: save는 **막은 팀(away)**의 사건이고 playerId는 그 팀 GK.
    const e = ev('save', { minute, teamId: away.id, playerId: awayId(0) })
    const seq = buildSequence(e, st.home, st.away)
    const dwell = 8400
    const gkId = awayId(0)
    const rows: { t: number; handD: number; ballX: number; ballY: number; ballZ: number; diveT: number }[] = []
    let prev: FrameState | null = null
    const N = 600
    for (let k = 0; k <= N; k++) {
      const t = k / N
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home',
        event: e, minute, dwellMs: dwell,
      }))
      prev = f
      const gk = f.players.find(p => p.id === gkId)!
      if (gk.action !== 'dive') continue
      const hand = gkHandWorld({ x: gk.x, z: gk.z }, gk.yaw, gk.actionT, gk.actionDir ?? 1)
      rows.push({
        t,
        handD: Math.hypot(hand.x - f.ball.x, hand.y - f.ball.y, hand.z - f.ball.z),
        ballX: f.ball.x, ballY: f.ball.y, ballZ: f.ball.z, diveT: gk.actionT,
      })
    }
    return rows
  }

  it('다이브 중 손이 실제로 공에 닿는다(공 반지름 안)', () => {
    for (const minute of [12, 30, 55, 71]) {
      const rows = savePlay(minute)
      expect(rows.length, `${minute}': 다이브 프레임 없음`).toBeGreaterThan(30)
      const best = Math.min(...rows.map(r => r.handD))
      // 공 반지름 0.11 + 손 반지름 0.055 = 접촉 판정 0.165 m. 여유 두 배로 잡는다.
      expect(best, `${minute}': 최소 손-공 ${best.toFixed(2)} m`).toBeLessThan(0.33)
    }
  })

  it('gkDiveAnchor는 순기구학의 역함수다 — 손이 접촉점에 정확히 온다', () => {
    for (const side of ['home', 'away'] as const) {
      for (const cz of [-3, -1, 0, 2, 3.4]) {
        const contact = { x: side === 'home' ? -49.9 : 49.9, z: cz }
        const from = { x: side === 'home' ? -30 : 30, z: cz * 0.4 }
        const a = gkDiveAnchor(side, contact, from)
        const hand = gkHandWorld(a, a.yaw, DIVE_LAY_U, a.dir)
        expect(Math.hypot(hand.x - contact.x, hand.z - contact.z), `${side}/z=${cz}`).toBeLessThan(1e-9)
        // 결과 몸통 자리는 GK 박스 안이어야 한다.
        const box = gkBox(side)
        expect(a.x).toBeGreaterThanOrEqual(box.xMin - 1e-6)
        expect(a.x).toBeLessThanOrEqual(box.xMax + 1e-6)
        expect(Math.abs(a.z)).toBeLessThanOrEqual(box.zMax + 1e-6)
      }
    }
  })

  it('잡는 세이브와 쳐내는 세이브가 둘 다 나오고, 그림이 다르다', () => {
    const kinds: string[] = []
    for (const minute of [8, 12, 19, 26, 30, 37, 44, 55, 61, 71, 78, 84]) {
      const rows = savePlay(minute)
      const contact = rows.filter(r => r.handD <= 0.33)
      if (contact.length === 0) continue
      // 접촉이 오래 유지되면 잡은 것(공이 손에 붙어 함께 내려온다),
      // 잠깐이면 쳐낸 것(공이 튕겨 나가 손에서 멀어진다).
      kinds.push(contact.length >= 30 ? 'catch' : 'punch')
    }
    expect(kinds.length).toBeGreaterThan(6)
    expect(kinds.filter(k => k === 'catch').length, `catch 없음: ${kinds.join(',')}`).toBeGreaterThan(0)
    expect(kinds.filter(k => k === 'punch').length, `punch 없음: ${kinds.join(',')}`).toBeGreaterThan(0)
  })

  it('잡은 공은 손을 따라 내려온다(접촉 이후 손-공 거리가 유지된다)', () => {
    // 12개 분 중 catch가 나오는 것을 찾아 접촉 이후 전 프레임을 검사한다.
    for (const minute of [8, 12, 19, 26, 30, 37, 44, 55, 61, 71, 78, 84]) {
      const rows = savePlay(minute)
      const first = rows.findIndex(r => r.handD <= 0.33)
      if (first < 0) continue
      const after = rows.slice(first)
      if (after.filter(r => r.handD <= 0.33).length < 30) continue // punch
      // 잡았으면 **끝까지** 손에 붙어 있어야 한다.
      const worst = Math.max(...after.map(r => r.handD))
      expect(worst, `${minute}' catch: 접촉 후 최악 손-공 ${worst.toFixed(2)} m`).toBeLessThan(0.33)
      return
    }
    throw new Error('catch 세이브를 하나도 찾지 못했다')
  })

  it('쳐낸 공은 골문에서 멀어진다(문전 정면 반사 금지)', () => {
    for (const minute of [8, 12, 19, 26, 30, 37, 44, 55, 61, 71, 78, 84]) {
      const rows = savePlay(minute)
      const first = rows.findIndex(r => r.handD <= 0.33)
      if (first < 0) continue
      const after = rows.slice(first)
      if (after.filter(r => r.handD <= 0.33).length >= 30) continue // catch
      const goalX = PITCH_W / 2 // away 골문(+X) — 홈이 공격한다
      const d0 = Math.hypot(after[0].ballX - goalX, after[0].ballZ)
      const dN = Math.hypot(after[after.length - 1].ballX - goalX, after[after.length - 1].ballZ)
      expect(dN, `${minute}' punch: 골문 거리 ${d0.toFixed(1)} → ${dN.toFixed(1)} m`).toBeGreaterThan(d0 + 2)
      return
    }
    throw new Error('punch 세이브를 하나도 찾지 못했다')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 킥 폼이 방향과 맞는다 (사용자 지적 R5 ③)
//
// > 슛/패스 하는 방향을 바라보고 해야 하는데 뒤를 바라보고 슛을 하는데 공은 반대로 가고 있어.
//
// 원인은 yaw가 **이동 방향**이었던 것이다. 킥 순간 슈터는 공을 향해 달려가는 중이라
// yaw가 주력 방향을 가리키고, 공은 목표로 나간다. 실측(90분 4시드 361킥):
// |yaw − 볼 방향| **p50 83.3° · 30° 초과 79% · 90° 초과 46%**.
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 차는 사람은 공이 나갈 방향을 본다', () => {
  /** 각도 차를 −π~π로 접어 절댓값(도)으로. */
  const angleGap = (a: number, b: number) => {
    let d = a - b
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    return Math.abs((d * 180) / Math.PI)
  }

  /**
   * 한 장면을 **직전 장면을 물려받은 채** 프레임 단위로 돌려, 임팩트 프레임의
   * (yaw, 볼이 실제로 날아갈 방향) 각도 차를 모은다.
   * 직전 장면을 물려받는 것이 중요하다 — prev=null로 시작하면 첫 프레임에 모두가
   * 안무 좌표로 스냅해 yaw가 이미 맞아 있고, 실제 게임 조건이 아니다.
   */
  function impactGaps(type: MatchEvent['type']): { arc: string; gap: number }[] {
    const st = structuredClone(base)
    const dwell = 8400
    const warm = buildSequence(ev('goal', { minute: 29, playerId: homeId(7) }), st.home, st.away)
    let prev: FrameState | null = null
    for (let k = 0; k <= 200; k++) {
      prev = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / 200, sequence: warm, sequenceSide: 'home',
        event: ev('goal', { minute: 29, playerId: homeId(7) }), minute: 29, dwellMs: dwell,
      }))
    }
    const e = ev(type, { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    const kicks = kickEvents(seq)
    const out: { arc: string; gap: number }[] = []
    const N = 504
    for (let k = 0; k <= N; k++) {
      const t = k / N
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: dwell, ...(k === 0 ? { cut: true } : {}),
      }))
      prev = f
      for (const kick of kicks) {
        if (Math.abs(t - kick.tImpact) > 0.5 / N) continue
        const p = f.players.find(q => q.id === kick.playerId)
        if (!p) continue
        // 공은 차는 사람의 발에 앵커링되므로 실제 비행은 "그 선수 → 다음 키프레임"이다.
        const to = toWorld(seq[kick.stepIndex + 1].ball.x, seq[kick.stepIndex + 1].ball.y)
        out.push({
          arc: seq[kick.stepIndex].arc ?? 'pass',
          gap: angleGap(p.yaw, Math.atan2(to.z - p.z, to.x - p.x)),
        })
      }
    }
    return out
  }

  it('★ 임팩트 순간 yaw가 볼 출발 방향과 15° 안에서 맞는다(슛·패스·크로스 전부)', () => {
    for (const type of ['goal', 'save', 'miss', 'shot'] as const) {
      const gaps = impactGaps(type)
      expect(gaps.length, `${type}: 임팩트 프레임이 없다`).toBeGreaterThanOrEqual(3)
      for (const g of gaps) {
        expect(g.gap, `${type} arc=${g.arc}: yaw가 ${g.gap.toFixed(0)}° 어긋났다`).toBeLessThan(15)
      }
    }
  })

  it('★ 뒤돌아 차는 프레임이 하나도 없다(90° 초과 금지)', () => {
    for (const type of ['goal', 'save', 'miss'] as const) {
      for (const g of impactGaps(type)) expect(g.gap).toBeLessThan(90)
    }
  })

  it('몸을 여는 창은 킥 모션 창보다 앞에서 열리고 뒤로는 같이 닫힌다', () => {
    const kicks = kickEvents(buildScene('balanced', 'goal', 0).points.map(p => ({
      t: p.t, ball: { x: p.ball[0], y: p.ball[1] }, movers: [],
      ...(p.carrier != null ? { carrier: `slot${p.carrier}` } : {}),
      ...(p.arc ? { arc: p.arc } : {}),
    })))
    expect(kicks.length).toBeGreaterThan(0)
    const k = kicks[kicks.length - 1]
    const dwell = 8600
    // 킥 모션은 아직 안 열렸는데 몸은 이미 돌기 시작하는 시각이 존재한다.
    const early = k.tImpact - (KICK_BACKSWING_MS + KICK_YAW_LEAD_MS / 2) / dwell
    expect(kickAt(kicks, early, dwell)).toBeNull()
    expect(kickFacingAt(kicks, early, dwell)?.tImpact).toBe(k.tImpact)
    // 선행 창보다 더 앞이면 둘 다 닫혀 있다.
    const tooEarly = k.tImpact - (KICK_BACKSWING_MS + KICK_YAW_LEAD_MS + 60) / dwell
    expect(kickFacingAt(kicks, tooEarly, dwell)).toBeNull()
    // 팔로스루가 끝나면 둘 다 닫힌다(몸의 방향까지 붙잡아 두지 않는다).
    const late = k.tImpact + (KICK_FOLLOW_MS + 60) / dwell
    expect(kickFacingAt(kicks, late, dwell)).toBeNull()
  })

  it('선행 시간이 yaw 시상수의 2배 이상이다 — 안 그러면 제때 못 돈다', () => {
    // YAW_TAU = 0.12 s. 백스윙 260 + 선행 240 = 500 ms → 1−e^(−0.5/0.12) = 98.5% 수렴.
    const window = (KICK_BACKSWING_MS + KICK_YAW_LEAD_MS) / 1000
    expect(1 - Math.exp(-window / 0.12)).toBeGreaterThan(0.97)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 장면 전환에서 무버가 저술 위치로 컷된다 (사용자 지적 R5 ①의 꼬리)
//
// 볼과 카메라는 이미 컷하는데 무버만 직전 분 자리에서 걸어왔다. 배역이 자기 진영에
// 있던 분에는 끝까지 따라잡지 못했고, 공이 그 선수 발에 앵커링되므로 저술이 12 m로
// 쓴 슛이 화면에서는 58 m 하프라인 슛이 됐다(실측 90분 4시드: 어긋남 max 46.2 m).
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 장면 전환 — 무버는 저술 위치에서 시작한다', () => {
  function firstFrameAfterCut() {
    const st = structuredClone(base)
    const dwell = 8400
    // 반대편 골문으로 향하는 장면을 먼저 끝까지 돌려 배역을 멀리 떨어뜨린다.
    const warmEv = ev('goal', { minute: 29, teamId: away.id, playerId: awayId(9) })
    const warm = buildSequence(warmEv, st.home, st.away)
    let prev: FrameState | null = null
    for (let k = 0; k <= 200; k++) {
      prev = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / 200, sequence: warm, sequenceSide: 'away',
        event: warmEv, minute: 29, dwellMs: dwell,
      }))
    }
    const e = ev('goal', { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    const f = computeFrame(input({
      state: st, prev, dt: 1 / 60, t: 0, sequence: seq, sequenceSide: 'home',
      event: e, minute: 30, dwellMs: dwell, cut: true,
    }))
    return { f, seq, prev: prev! }
  }

  it('컷 프레임에서 무버 3명이 안무 좌표에 있다', () => {
    const { f, seq } = firstFrameAfterCut()
    for (const m of seq[0].movers) {
      const p = find(f, m.playerId)
      const w = toWorld(m.x, m.y)
      // 선행(MOVER_LOOKAHEAD_MS)과 분리 밀어내기만큼의 여유만 허용한다.
      expect(Math.hypot(p.x - w.x, p.z - w.z), `${m.playerId}`).toBeLessThan(3)
    }
  })

  it('컷된 무버의 속도는 0이다 — 컷 거리를 dt로 나누면 관성이 폭발한다', () => {
    const { f, seq } = firstFrameAfterCut()
    for (const m of seq[0].movers) {
      const p = find(f, m.playerId)
      expect(Math.hypot(p.vx ?? 0, p.vz ?? 0), `${m.playerId} 속도`).toBeLessThan(0.1)
      expect(p.speed).toBeLessThan(0.1)
    }
  })

  it('무버가 아닌 19명은 컷하지 않는다(이유 없이 22명이 튀지 않는다)', () => {
    const { f, seq, prev } = firstFrameAfterCut()
    const moverIds = new Set(seq[0].movers.map(m => m.playerId))
    for (const p of f.players) {
      if (moverIds.has(p.id)) continue
      const q = prev.players.find(o => o.id === p.id)!
      // 한 프레임 이동은 속도 상한 안이다.
      expect(Math.hypot(p.x - q.x, p.z - q.z) * 60, p.id).toBeLessThanOrEqual(MAX_SPEED + 0.5)
    }
  })

  it('컷 이후에는 슈터가 저술 슛 지점에 제때 도착한다', () => {
    const st = structuredClone(base)
    const dwell = 8600
    const warmEv = ev('goal', { minute: 29, teamId: away.id, playerId: awayId(9) })
    const warm = buildSequence(warmEv, st.home, st.away)
    let prev: FrameState | null = null
    for (let k = 0; k <= 200; k++) {
      prev = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / 200, sequence: warm, sequenceSide: 'away',
        event: warmEv, minute: 29, dwellMs: dwell,
      }))
    }
    const e = ev('goal', { minute: 30, playerId: homeId(9) })
    const seq = buildSequence(e, st.home, st.away)
    const kicks = kickEvents(seq)
    const shot = kicks[kicks.length - 1]
    const N = 516
    let gap = Infinity
    for (let k = 0; k <= N; k++) {
      const t = k / N
      const f: FrameState = computeFrame(input({
        state: st, prev, dt: 1 / 60, t, sequence: seq, sequenceSide: 'home',
        event: e, minute: 30, dwellMs: dwell, ...(k === 0 ? { cut: true } : {}),
      }))
      prev = f
      if (Math.abs(t - shot.tImpact) > 0.5 / N) continue
      const p = find(f, shot.playerId)
      const w = toWorld(shot.ball.x, shot.ball.y)
      gap = Math.hypot(p.x - w.x, p.z - w.z)
    }
    expect(gap, `임팩트 시점 슈터-저술 슛지점 ${gap.toFixed(1)} m`).toBeLessThan(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 골 여운 — 공이 골망 안에 멈춘다 (블라인드 감사 ⑥)
//
// 저술 좌표계(0~100)는 골라인까지밖에 못 쓴다. 그래서 골 종점은 늘 골라인 **위**이고,
// 예전에는 여운 동안 그 자리에 내려앉아 "골망은 비어 있고 공은 골문 앞 잔디"가 됐다.
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 골은 골망 안에서 멈춘다', () => {
  /** 골문 반폭(m). */
  const POST_Z = 3.66
  /** 네트 깊이(m) — props.NET_DEPTH. 공이 이보다 뒤로 가면 그물을 뚫은 것이다. */
  const NET_DEPTH = 2.0

  const playGoal = (side: 'home' | 'away', minute: number) => {
    const st = structuredClone(base)
    const team = side === 'home' ? st.home : st.away
    const e = ev('goal', { minute, teamId: team.team.id, playerId: team.tactics.lineup[9].playerId })
    const seq = buildSequence(e, st.home, st.away)
    let prev: FrameState | null = null
    const N = 600
    for (let k = 0; k <= N; k++) {
      prev = computeFrame(input({
        state: st, prev, dt: 1 / 60, t: k / N, sequence: seq, sequenceSide: side,
        event: e, minute, dwellMs: 8600, ...(k === 0 ? { cut: true } : {}),
      }))
    }
    return prev!
  }

  it('여운 끝에 공이 골라인 뒤·기둥 사이·크로스바 아래에 있다(양 팀)', () => {
    for (const side of ['home', 'away'] as const) {
      for (const minute of [7, 23, 44, 66, 88]) {
        const f = playGoal(side, minute)
        const sign = side === 'home' ? 1 : -1
        const depth = sign * f.ball.x - PITCH_W / 2
        const tag = `${side}/${minute}': 깊이 ${depth.toFixed(2)} m · z ${f.ball.z.toFixed(2)}`
        expect(depth, `${tag} — 골라인을 못 넘었다`).toBeGreaterThan(0.5)
        expect(depth, `${tag} — 그물을 뚫었다`).toBeLessThan(NET_DEPTH)
        expect(Math.abs(f.ball.z), `${tag} — 기둥 밖이다`).toBeLessThan(POST_Z - 0.5)
        expect(f.ball.y, `${tag} — 크로스바 위다`).toBeLessThan(2.44)
      }
    }
  })

  it('goalNetRest는 여운 앞부분에서 네트에 안착하고 그 뒤로는 움직이지 않는다', () => {
    const at = { x: PITCH_W / 2, z: 1.2 }
    const rest = 2000
    const early = goalNetRest(at, 'home', GOAL_NET_MS / rest / 2, rest, 1.05)
    const settled = goalNetRest(at, 'home', GOAL_NET_MS / rest, rest, 1.05)
    const late = goalNetRest(at, 'home', 1, rest, 1.05)
    expect(early.x).toBeGreaterThan(at.x)
    expect(early.x).toBeLessThan(settled.x)
    expect(late.x).toBeCloseTo(settled.x, 6)
    expect(late.z).toBe(at.z)
    // 안착하면 잔디에 놓인다(공 반지름).
    expect(late.y).toBeCloseTo(BALL_RADIUS, 6)
    // away는 반대 골문으로 들어간다.
    expect(goalNetRest({ x: -PITCH_W / 2, z: 0 }, 'away', 1, rest, 1.05).x)
      .toBeCloseTo(-PITCH_W / 2 - GOAL_NET_REST_M, 6)
  })
})
