import { describe, it, expect } from 'vitest'
import {
  bezierAt, easeFor, controlFor, cameraTarget, clampFocus, shakeOffset,
  toWorld, lerp, clamp, PITCH_W, PITCH_H, ZOOM,
} from '../stage'
import type { ChoreoStep } from '../../choreography'

describe('bezierAt', () => {
  it('t=0은 p0, t=1은 p1', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 4 }, ctrl = { x: 5, y: 20 }
    expect(bezierAt(p0, p1, ctrl, 0)).toEqual(p0)
    expect(bezierAt(p0, p1, ctrl, 1)).toEqual(p1)
  })

  it('t=0.5는 2차 베지에 공식 값(제어점으로 휜다)', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 0 }, ctrl = { x: 5, y: 10 }
    const m = bezierAt(p0, p1, ctrl, 0.5)
    // 0.25*p0 + 0.5*ctrl + 0.25*p1
    expect(m.x).toBeCloseTo(5, 6)
    expect(m.y).toBeCloseTo(5, 6) // 0.5*10 = 5 (제어점으로 끌림)
  })

  it('직선 제어점(중점)이면 직선 위를 지난다', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 10 }
    const ctrl = { x: 5, y: 5 }
    for (const t of [0.2, 0.5, 0.8]) {
      const b = bezierAt(p0, p1, ctrl, t)
      expect(b.x).toBeCloseTo(b.y, 6) // y=x 직선 유지
    }
  })
})

describe('easeFor', () => {
  it('모든 타입이 0→0, 1→1로 정규화', () => {
    for (const type of ['linear', 'pass', 'shot', 'camera', 'ease'] as const) {
      const e = easeFor(type)
      expect(e(0)).toBeCloseTo(0, 6)
      expect(e(1)).toBeCloseTo(1, 6)
    }
  })

  it('shot은 가속(중간값 < 선형) — 뒤로 갈수록 빠름', () => {
    expect(easeFor('shot')(0.5)).toBeLessThan(0.5)
  })

  it('camera는 감속(중간값 > 선형) — 빠르게 붙고 감속', () => {
    expect(easeFor('camera')(0.5)).toBeGreaterThan(0.5)
  })

  it('linear는 항등', () => {
    expect(easeFor('linear')(0.37)).toBeCloseTo(0.37, 6)
  })
})

describe('controlFor', () => {
  it('shot은 중점(직선)', () => {
    const c = controlFor({ x: 0, y: 0 }, { x: 10, y: 4 }, 'shot')
    expect(c).toEqual({ x: 5, y: 2 })
  })

  it('pass는 중점에서 벗어나 휜다(아크)', () => {
    const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 0 }
    const c = controlFor(p0, p1, 'pass')
    expect(c.x).toBeCloseTo(5, 6)
    expect(Math.abs(c.y)).toBeGreaterThan(0.5) // 수직으로 휨
  })
})

describe('clampFocus', () => {
  it('scale≤1이면 항상 피치 중앙', () => {
    expect(clampFocus(10, 10, 1)).toEqual({ x: PITCH_W / 2, y: PITCH_H / 2 })
    expect(clampFocus(90, 60, 0.5)).toEqual({ x: PITCH_W / 2, y: PITCH_H / 2 })
  })

  it('줌 상태에서 초점이 경계 밖 뷰포트를 만들지 않는다', () => {
    const scale = 1.6
    const halfW = PITCH_W / 2 / scale
    const halfH = PITCH_H / 2 / scale
    // 코너 근처 극단 초점 요청
    const f = clampFocus(PITCH_W, 0, scale)
    // 뷰포트 [f.x-halfW, f.x+halfW] 가 [0, PITCH_W] 안에 있어야 함
    expect(f.x - halfW).toBeGreaterThanOrEqual(-1e-6)
    expect(f.x + halfW).toBeLessThanOrEqual(PITCH_W + 1e-6)
    expect(f.y - halfH).toBeGreaterThanOrEqual(-1e-6)
    expect(f.y + halfH).toBeLessThanOrEqual(PITCH_H + 1e-6)
  })
})

describe('cameraTarget', () => {
  const seq: ChoreoStep[] = [
    { t: 0, ball: { x: 55, y: 50 }, movers: [] },
    { t: 0.5, ball: { x: 80, y: 50 }, movers: [] },
    { t: 0.78, ball: { x: 99, y: 46 }, movers: [] }, // 골문 코너 근처
  ]

  it('빈 시퀀스는 중앙·배율 1', () => {
    expect(cameraTarget([], 0)).toEqual({ x: PITCH_W / 2, y: PITCH_H / 2, scale: 1 })
  })

  it('배율은 zoom 인자(기본 ZOOM)', () => {
    expect(cameraTarget(seq, 0).scale).toBe(ZOOM)
    expect(cameraTarget(seq, 0, 2).scale).toBe(2)
  })

  it('마지막(골문 근처) 스텝 초점이 피치 경계 밖으로 나가지 않는다', () => {
    const cam = cameraTarget(seq, 2)
    const halfW = PITCH_W / 2 / cam.scale
    expect(cam.x + halfW).toBeLessThanOrEqual(PITCH_W + 1e-6)
    expect(cam.x - halfW).toBeGreaterThanOrEqual(-1e-6)
  })

  it('stepIndex 범위 밖은 클램프(음수→0, 초과→마지막)', () => {
    expect(cameraTarget(seq, -5)).toEqual(cameraTarget(seq, 0))
    expect(cameraTarget(seq, 99)).toEqual(cameraTarget(seq, 2))
  })
})

describe('shakeOffset', () => {
  it('progress=1이면 정지(감쇠 완료)', () => {
    const s = shakeOffset(1, 4)
    expect(s.dx).toBeCloseTo(0, 6)
    expect(s.dy).toBeCloseTo(0, 6)
  })

  it('진폭이 amp를 넘지 않는다', () => {
    for (let p = 0; p <= 1; p += 0.1) {
      const s = shakeOffset(p, 4)
      expect(Math.abs(s.dx)).toBeLessThanOrEqual(4 + 1e-6)
      expect(Math.abs(s.dy)).toBeLessThanOrEqual(4 + 1e-6)
    }
  })

  it('결정론(같은 입력 같은 출력)', () => {
    expect(shakeOffset(0.3, 4)).toEqual(shakeOffset(0.3, 4))
  })
})

describe('toWorld / helpers', () => {
  it('0~100 → 105×68 월드', () => {
    expect(toWorld({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(toWorld({ x: 100, y: 100 })).toEqual({ x: PITCH_W, y: PITCH_H })
    expect(toWorld({ x: 50, y: 50 })).toEqual({ x: PITCH_W / 2, y: PITCH_H / 2 })
  })

  it('clamp / lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(lerp(0, 10, 0.25)).toBe(2.5)
  })
})
