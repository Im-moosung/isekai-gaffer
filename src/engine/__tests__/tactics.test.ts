import { describe, it, expect } from 'vitest'
import { formationEdge, instructionEffects, attackFocusEffects } from '../tactics'
import type { FormationId, Instructions } from '../types'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
const base: Instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }

describe('formationEdge', () => {
  it('반대칭: edge(a,b) = -edge(b,a)', () => {
    for (const a of FORMATIONS) for (const b of FORMATIONS)
      expect(formationEdge(a, b)).toBeCloseTo(-formationEdge(b, a), 10)
  })
  it('상한 ±0.15', () => {
    for (const a of FORMATIONS) for (const b of FORMATIONS) {
      expect(Math.abs(formationEdge(a, b))).toBeLessThanOrEqual(0.15)
    }
  })
  it('3-5-2는 4-4-2 상대로 중원 수적 우위 (양수 edge)', () => {
    expect(formationEdge('3-5-2', '4-4-2')).toBeGreaterThan(0)
  })
})

describe('instructionEffects', () => {
  it('기준 지시(50/50/50)는 모든 효과 ≈ 1.0', () => {
    const e = instructionEffects(base)
    for (const v of Object.values(e)) expect(v).toBeCloseTo(1.0, 1)
  })
  it('하이라인+맹렬압박 → 역습 취약성 증폭 (결합이 개별 합보다 큼)', () => {
    const both = instructionEffects({ ...base, lineHeight: 85, pressing: 85 })
    const lineOnly = instructionEffects({ ...base, lineHeight: 85 })
    const pressOnly = instructionEffects({ ...base, pressing: 85 })
    expect(both.counterVulnerability).toBeGreaterThan(lineOnly.counterVulnerability * pressOnly.counterVulnerability)
  })
  // B4: 역습 취약성은 '라인 뒤 공간'의 함수다. 압박 단독은 이 항에 과금하지 않는다
  // (기존엔 압박이 counterVulnerability·foulRate·staminaDrain·지속압박으로 4중 과금돼
  //  상대와 무관하게 "압박은 손해"가 됐다). 압박의 비용은 아래 두 항목이 담당한다.
  it('압박 단독은 역습 취약성을 올리지 않는다 (비용은 체력·파울로 이관)', () => {
    const e = instructionEffects({ ...base, pressing: 90 })
    expect(e.counterVulnerability).toBeCloseTo(1.0, 10)
  })
  it('맹렬압박은 체력 소모·파울 증가', () => {
    const e = instructionEffects({ ...base, pressing: 90 })
    expect(e.staminaDrain).toBeGreaterThan(1.2)
    expect(e.foulRate).toBeGreaterThan(1.15)
  })
  it('높은 템포는 찬스 빈도↑ 찬스 퀄리티↓', () => {
    const e = instructionEffects({ ...base, tempo: 90 })
    expect(e.chanceRate).toBeGreaterThan(1.1)
    expect(e.chanceQuality).toBeLessThan(1.0)
  })
})

describe('MatchupContext — 미지정 시 기존 동작 불변', () => {
  const NEUTRAL: Instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }

  it('ctx 없으면 모든 축이 정확히 1.0', () => {
    const fx = instructionEffects(NEUTRAL)
    expect(fx.chanceRate).toBeCloseTo(1.0, 10)
    expect(fx.chanceQuality).toBeCloseTo(1.0, 10)
    expect(fx.counterVulnerability).toBeCloseTo(1.0, 10)
    expect(fx.possessionBias).toBeCloseTo(1.0, 10)
    expect(fx.suppression).toBe(1.0)
  })

  // 회귀 항등성: ctx 미지정이면 paceScale=1.0이라 lineVul === lerp(line,0.75,1.25).
  // 이게 깨지면 700개 시드 회귀가 통째로 무너진다.
  it('ctx 없으면 counterVulnerability는 라인 lerp(0.75~1.25)×결합증폭과 정확히 같다', () => {
    const lerp = (t: number, lo: number, hi: number) => lo + ((hi - lo) * t) / 100
    for (const line of [0, 10, 25, 50, 51, 70, 85, 90, 100]) {
      const combo = line > 70 ? ((line - 70) / 30) * ((85 - 70) / 30) * 0.5 : 0
      const fx = instructionEffects({ ...NEUTRAL, lineHeight: line, pressing: 85 })
      expect(fx.counterVulnerability).toBeCloseTo(lerp(line, 0.75, 1.25) * (1 + combo), 12)
    }
  })

  it('ctx 없으면 chanceRate·suppression에 상대 의존 항이 붙지 않는다', () => {
    for (const v of [0, 20, 50, 80, 100]) {
      const fx = instructionEffects({ ...NEUTRAL, lineHeight: v, pressing: v })
      expect(fx.suppression).toBe(1.0)
      // 압박 항 lerp(0.9,1.1)만 남아야 한다
      expect(fx.chanceRate).toBeCloseTo(0.9 + 0.2 * v / 100, 12)
    }
  })

  it('ctx가 있어도 라인·압박이 중립대(40~60)면 suppression은 1.0', () => {
    const ctx = { oppFrontPace: 80, oppGkBuildup: 50, oppPossession: 50 }
    expect(instructionEffects({ ...NEUTRAL, lineHeight: 55 }, ctx).suppression).toBe(1.0)
    expect(instructionEffects({ ...NEUTRAL, pressing: 45 }, ctx).suppression).toBe(1.0)
  })

  it('하이라인은 상대 찬스를 억제한다(suppression < 1)', () => {
    const ctx = { oppFrontPace: 60, oppGkBuildup: 50, oppPossession: 50 }
    expect(instructionEffects({ ...NEUTRAL, lineHeight: 90 }, ctx).suppression).toBeLessThan(1.0)
  })

  // 반대편: 물러선 라인·소극적 압박은 상대에게 전개를 허용한다(suppression > 1).
  // 저지시가 "공짜 수비 보너스"가 되지 않게 하는 항 — 단조 지배 제거의 핵심.
  it('낮은 라인·낮은 압박은 전개가 서툰 상대에게 오히려 자유를 준다(suppression > 1)', () => {
    const weakBuildup = { oppFrontPace: 60, oppGkBuildup: 50, oppPossession: 40 }
    expect(instructionEffects({ ...NEUTRAL, lineHeight: 10, pressing: 10 }, weakBuildup).suppression).toBeGreaterThan(1.0)
  })

  // 전개가 뛰어난 상대(점유 78·GK 빌드업 78)에게는 압박이 벗겨진다 — 부호가 뒤집힌다.
  it('전개 최상위 상대에게는 하이프레스가 역효과다(suppression > 1)', () => {
    const elite = { oppFrontPace: 85, oppGkBuildup: 78, oppPossession: 78 }
    expect(instructionEffects({ ...NEUTRAL, pressing: 90 }, elite).suppression).toBeGreaterThan(1.0)
    expect(instructionEffects({ ...NEUTRAL, pressing: 90 }, elite).chanceRate)
      .toBeLessThan(instructionEffects({ ...NEUTRAL, pressing: 90 }).chanceRate)
  })

  it('하이라인 역습 비용은 상대 최전방이 빠를수록 크다', () => {
    const slow = { oppFrontPace: 55, oppGkBuildup: 50, oppPossession: 50 }
    const fast = { oppFrontPace: 92, oppGkBuildup: 50, oppPossession: 50 }
    const ins: Instructions = { ...NEUTRAL, lineHeight: 90 }
    expect(instructionEffects(ins, fast).counterVulnerability)
      .toBeGreaterThan(instructionEffects(ins, slow).counterVulnerability)
  })

  it('라인 50 이하 구간의 역습 취약성은 상대 pace와 무관하다 (하방은 스케일 미적용)', () => {
    const slow = { oppFrontPace: 55, oppGkBuildup: 50, oppPossession: 50 }
    const fast = { oppFrontPace: 92, oppGkBuildup: 50, oppPossession: 50 }
    const ins: Instructions = { ...NEUTRAL, lineHeight: 20 }
    expect(instructionEffects(ins, fast).counterVulnerability)
      .toBeCloseTo(instructionEffects(ins, slow).counterVulnerability, 12)
  })

  it('하이프레스 점유 이득은 상대 GK 빌드업이 낮을수록 크다', () => {
    const badGk = { oppFrontPace: 60, oppGkBuildup: 30, oppPossession: 45 }
    const goodGk = { oppFrontPace: 60, oppGkBuildup: 88, oppPossession: 45 }
    const ins: Instructions = { ...NEUTRAL, pressing: 90 }
    expect(instructionEffects(ins, badGk).possessionBias)
      .toBeGreaterThan(instructionEffects(ins, goodGk).possessionBias)
  })
})

describe('attackFocus — 상대 약한 측면을 노리면 보상', () => {
  it('balanced는 정확히 1.0', () => {
    expect(attackFocusEffects('balanced', { left: 70, right: 70, center: 70 }).chanceQuality).toBe(1.0)
  })
  it('상대 좌측이 약할 때 left 집중이 right 집중보다 유리', () => {
    const flank = { left: 55, right: 82, center: 70 }
    expect(attackFocusEffects('left', flank).chanceQuality)
      .toBeGreaterThan(attackFocusEffects('right', flank).chanceQuality)
  })
  it('강한 측면을 고르면 1.0 미만 — 집중은 도박이다', () => {
    const flank = { left: 55, right: 82, center: 70 }
    expect(attackFocusEffects('right', flank).chanceQuality).toBeLessThan(1.0)
  })
})
