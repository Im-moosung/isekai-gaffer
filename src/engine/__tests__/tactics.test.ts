import { describe, it, expect } from 'vitest'
import { formationEdge, instructionEffects } from '../tactics'
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
