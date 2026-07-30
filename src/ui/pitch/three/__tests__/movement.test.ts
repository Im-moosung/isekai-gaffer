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
  KICK_REACH, STANDOFF, MOVER_LOOKAHEAD_MS, DEFAULT_DWELL_MS,
  kickEvents, kickAt, dragProgress, diveScheduleAt,
  GK_DIVE_MS, GK_REACTION_MS, KICK_IMPACT_T, KICK_BACKSWING_MS,
  type FrameInput,
} from '../movement'

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

  it('save 이벤트에서 슛을 받는 쪽 GK가 dive', () => {
    const e = ev('save')
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: seq[seq.length - 1].t - 0.01, event: e }))
    expect(find(f, awayId(0)).action).toBe('dive')
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
      const N = 60
      for (let k = 0; k <= N; k++) {
        const t = k / N
        const f: FrameState = computeFrame(input({ prev, dt: 0.033, t, sequence: seq, sequenceSide: 'home', event: e }))
        for (const p of f.players.filter(q => q.action === 'kick')) {
          kickFrames++
          expect(p.side).toBe('home')
          expect(carriers.has(p.id), `${type}: ${p.id}는 캐리어가 아니다`).toBe(true)
          const hit = kickAt(kicks, t, DEFAULT_DWELL_MS)!
          const kb = toWorld(hit.kick.ball.x, hit.kick.ball.y)
          expect(Math.hypot(p.x - kb.x, p.z - kb.z)).toBeLessThan(KICK_REACH)
        }
        prev = f
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
      const e = ev('save', { minute: 55, playerId: st.home.tactics.lineup[9].playerId })
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

  it('다이브 방향이 볼이 향하는 쪽을 따른다(해시 난수가 아니다)', () => {
    const st = structuredClone(base)
    const e = ev('save', { minute: 55 })
    const seq = buildSequence(e, st.home, st.away)
    const endZ = toWorld(seq[seq.length - 1].ball.x, seq[seq.length - 1].ball.y).z
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: seq[seq.length - 1].t, event: e, dwellMs: 8400 }))
    const gk = f.players.find(p => p.id === st.away.tactics.lineup[0].playerId)!
    expect(gk.action).toBe('dive')
    // away GK는 로컬 +Z가 월드 +Z와 같다(yaw 0 기준). 부호가 볼 쪽을 가리켜야 한다.
    expect(Math.sign(gk.actionDir ?? 0)).toBe(endZ >= 0 ? 1 : -1)
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
