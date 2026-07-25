// node 환경(document 없음) — 절차 텍스처 생성기는 throw 없이 null을 반환해야 한다.
import { describe, it, expect } from 'vitest'
import {
  AD_TEXTS,
  CENTER_CIRCLE_R,
  CORNER_R,
  GOAL_AREA_D,
  GOAL_AREA_W,
  GOAL_H,
  GOAL_W,
  LINE_W,
  PENALTY_BOX_D,
  PENALTY_BOX_W,
  PENALTY_SPOT_D,
  POST_R,
  fnv1a,
  hash01,
  hash2,
  makeAdBoardCanvas,
  makeCanvas,
  makeConcreteCanvas,
  makeNetCanvas,
  makeNoiseCanvas,
  makePitchCanvas,
  makeShadowCanvas,
  penaltyArcHalfAngle,
  worldToPx,
} from '../textures'
import { PITCH_W, PITCH_H } from '../types'

describe('canvas 미지원 환경 안전성', () => {
  it('document가 없으면 makeCanvas가 throw 없이 null', () => {
    expect(typeof document).toBe('undefined') // node 환경 전제
    expect(makeCanvas(16, 16)).toBeNull()
  })

  it('모든 텍스처 생성기가 null 반환(크래시 금지)', () => {
    const makers = [
      () => makePitchCanvas(),
      () => makePitchCanvas(4),
      () => makeNetCanvas(),
      () => makeNoiseCanvas(),
      () => makeShadowCanvas(),
      () => makeConcreteCanvas(),
      () => makeAdBoardCanvas(),
      () => makeAdBoardCanvas([]),
    ]
    for (const make of makers) {
      expect(make).not.toThrow()
      expect(make()).toBeNull()
    }
  })
})

describe('결정론 해시', () => {
  it('fnv1a는 같은 입력에 같은 값, 다른 입력에 다른 값', () => {
    expect(fnv1a('crowd')).toBe(fnv1a('crowd'))
    expect(fnv1a('crowd')).not.toBe(fnv1a('crowe'))
    expect(fnv1a('')).toBe(2166136261)
  })

  it('hash01은 0 이상 1 미만이며 반복 호출에 안정', () => {
    for (let i = 0; i < 500; i++) {
      const v = hash01(i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(hash01(i)).toBe(v)
    }
  })

  it('hash01은 넓게 퍼진다(평균 0.5 근방, 사분면 고른 분포)', () => {
    const n = 4000
    let sum = 0
    const buckets = [0, 0, 0, 0]
    for (let i = 0; i < n; i++) {
      const v = hash01(i * 3 + 11)
      sum += v
      buckets[Math.min(3, Math.floor(v * 4))]++
    }
    expect(sum / n).toBeGreaterThan(0.45)
    expect(sum / n).toBeLessThan(0.55)
    for (const b of buckets) expect(b).toBeGreaterThan(n * 0.2)
  })

  it('hash2는 축 대칭이 아니다(격자 줄무늬 방지)', () => {
    expect(hash2(3, 7)).not.toBe(hash2(7, 3))
    expect(hash2(3, 7)).toBe(hash2(3, 7))
    expect(hash2(3, 7, 1)).not.toBe(hash2(3, 7, 2))
  })
})

describe('피치 규격 상수', () => {
  it('FIFA 규격 근사값', () => {
    expect(PITCH_W).toBe(105)
    expect(PITCH_H).toBe(68)
    expect(CENTER_CIRCLE_R).toBeCloseTo(9.15, 5)
    expect(PENALTY_BOX_D).toBeCloseTo(16.5, 5)
    expect(PENALTY_BOX_W).toBeCloseTo(40.32, 5)
    expect(GOAL_AREA_D).toBeCloseTo(5.5, 5)
    expect(GOAL_AREA_W).toBeCloseTo(18.32, 5)
    expect(PENALTY_SPOT_D).toBe(11)
    expect(CORNER_R).toBe(1)
    expect(LINE_W).toBeLessThanOrEqual(0.12)
    expect(GOAL_W).toBeCloseTo(7.32, 5)
    expect(GOAL_H).toBeCloseTo(2.44, 5)
    expect(POST_R).toBeCloseTo(0.06, 5)
  })

  it('페널티 박스·골 에어리어가 피치 안에 들어간다', () => {
    expect(PENALTY_BOX_W).toBeLessThan(PITCH_H)
    expect(PENALTY_BOX_D * 2).toBeLessThan(PITCH_W)
    expect(GOAL_AREA_W).toBeLessThan(PENALTY_BOX_W)
    expect(GOAL_AREA_D).toBeLessThan(PENALTY_BOX_D)
    // 골대는 골 에어리어보다 좁다.
    expect(GOAL_W).toBeLessThan(GOAL_AREA_W)
  })

  it('페널티 아크 반각은 박스 밖으로 드러나는 구간과 일치', () => {
    const a = penaltyArcHalfAngle()
    expect(Number.isFinite(a)).toBe(true)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(Math.PI / 2)
    // cos(a)·r = 박스 앞선까지의 거리(5.5m)
    expect(Math.cos(a) * CENTER_CIRCLE_R).toBeCloseTo(PENALTY_BOX_D - PENALTY_SPOT_D, 6)
    // 아크 끝점의 z는 페널티 박스 폭 안쪽이어야 한다.
    expect(Math.sin(a) * CENTER_CIRCLE_R).toBeLessThan(PENALTY_BOX_W / 2)
  })
})

describe('worldToPx 매핑', () => {
  const W = 2100
  const H = 1360

  it('센터는 캔버스 중앙', () => {
    const p = worldToPx(0, 0, W, H)
    expect(p.px).toBeCloseTo(W / 2, 6)
    expect(p.py).toBeCloseTo(H / 2, 6)
  })

  it('피치 네 모서리가 캔버스 모서리에 대응', () => {
    expect(worldToPx(-PITCH_W / 2, -PITCH_H / 2, W, H)).toEqual({ px: 0, py: 0 })
    const far = worldToPx(PITCH_W / 2, PITCH_H / 2, W, H)
    expect(far.px).toBeCloseTo(W, 6)
    expect(far.py).toBeCloseTo(H, 6)
  })

  it('등방 스케일(px/m이 두 축에서 동일)', () => {
    const a = worldToPx(1, 0, W, H).px - worldToPx(0, 0, W, H).px
    const b = worldToPx(0, 1, W, H).py - worldToPx(0, 0, W, H).py
    expect(a).toBeCloseTo(b, 6)
  })
})

describe('광고보드 문구', () => {
  it('실존 상표 없이 가상 브랜드만 사용', () => {
    expect(AD_TEXTS.length).toBeGreaterThan(0)
    for (const t of AD_TEXTS) expect(t.length).toBeGreaterThan(0)
    const joined = AD_TEXTS.join(' ').toUpperCase()
    for (const banned of ['FIFA', 'NIKE', 'ADIDAS', 'COCA', 'HYUNDAI']) {
      expect(joined).not.toContain(banned)
    }
  })
})
