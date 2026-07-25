import { describe, it, expect } from 'vitest'
import type { MatchEvent, MatchState } from '../../../../engine/types'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'
import { buildSequence, type ChoreoStep } from '../../choreography'
import { slotCoords } from '../../formations'
import { PITCH_H, PITCH_W, toWorld, type FrameState } from '../types'
import {
  computeFrame, ballHeight, arcKindFor, sampleSequence, gkBox,
  BALL_PEAK, BALL_RADIUS, BALL_SHIFT, CONVERGE_MAX, GK_MAX_SPEED, MAX_SPEED,
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
      const c = slotCoords(base.home.tactics.formation, i, 'home')
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
      const c = slotCoords(base.home.tactics.formation, i, 'home')
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

  it('prev=null이면 무버가 안무 좌표에 정확히 놓인다', () => {
    const seq = buildSequence(ev('goal'), base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: seq[1].t, event: ev('goal') }))
    for (const m of seq[1].movers) {
      const pose = f.players.find(p => p.id === m.playerId)
      if (!pose || pose.id === homeId(0)) continue // GK는 박스 클램프 우선
      const w = toWorld(m.x, m.y)
      expect(pose.x).toBeCloseTo(w.x, 6)
      expect(pose.z).toBeCloseTo(w.z, 6)
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

  it('computeFrame 볼 Y 최대값이 이벤트 타입별 피크', () => {
    const maxY = (type: MatchEvent['type']) => {
      const e = ev(type)
      const seq = buildSequence(e, base.home, base.away)
      let m = 0
      for (let i = 0; i <= 100; i++) {
        m = Math.max(m, computeFrame(input({ sequence: seq, sequenceSide: 'home', t: i / 100, event: e })).ball.y)
      }
      return m
    }
    expect(maxY('corner')).toBeCloseTo(BALL_PEAK.cross, 4)
    expect(maxY('goal')).toBeCloseTo(BALL_PEAK.shot, 4)
    expect(maxY('foul')).toBeCloseTo(BALL_RADIUS, 6)
  })

  it('시퀀스가 없으면 볼은 지면에서 중원을 완만히 순환한다', () => {
    let prev: FrameState | null = null
    let maxStep = 0
    for (let k = 0; k <= 40; k++) {
      const f: FrameState = computeFrame(input({ prev, dt: 0.05, t: k / 40 }))
      expect(f.ball.y).toBeCloseTo(BALL_RADIUS, 6)
      expect(Math.abs(f.ball.x)).toBeLessThan(PITCH_W / 2)
      expect(Math.abs(f.ball.z)).toBeLessThan(PITCH_H / 2)
      if (prev) maxStep = Math.max(maxStep, Math.hypot(f.ball.x - prev.ball.x, f.ball.z - prev.ball.z))
      prev = f
    }
    expect(maxStep).toBeLessThan(3) // 완만한 순환(프레임당 급점프 없음)
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

  it('슛/패스 키프레임 시작엔 kicker가 kick(actionT 0~1)', () => {
    const e = ev('goal')
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: seq[1].t + 0.001, event: e }))
    const kickers = f.players.filter(p => p.action === 'kick')
    expect(kickers).toHaveLength(1)
    expect(kickers[0].actionT).toBeGreaterThanOrEqual(0)
    expect(kickers[0].actionT).toBeLessThanOrEqual(1)
  })

  it('파울 뒤엔 한 명이 down', () => {
    const e = ev('foul')
    const seq = buildSequence(e, base.home, base.away)
    const f = computeFrame(input({ sequence: seq, sequenceSide: 'home', t: 0.95, event: e }))
    expect(f.players.filter(p => p.action === 'down')).toHaveLength(1)
    expect(f.event).toBe('foul')
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
