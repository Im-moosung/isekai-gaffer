import { describe, it, expect } from 'vitest'
import { positionFitness, effectiveStats } from '../fitness'
import { makeTestTeam } from '../fixtures/testTeams'

const team = makeTestTeam('t', 85)
const striker = team.squad.find(p => p.position === 'ST')!
const gk = team.squad.find(p => p.position === 'GK')!

describe('positionFitness', () => {
  it('주 포지션 = 1.0', () => expect(positionFitness(striker, 'ST')).toBe(1.0))
  it('altPositions = 0.85', () => expect(positionFitness(striker, 'LW')).toBe(0.85))
  it('인접(alt에 없어도 ADJACENT면) = 0.65', () => expect(positionFitness(striker, 'RW')).toBeGreaterThanOrEqual(0.65))
  it('공격수→CB 극단 미스매치 = 0.4', () => expect(positionFitness(striker, 'CB')).toBe(0.4))
  it('필드 선수→GK = 0.2 (파국)', () => expect(positionFitness(striker, 'GK')).toBe(0.2))
  it('GK→필드 = 0.2', () => expect(positionFitness(gk, 'ST')).toBe(0.2))
})

describe('effectiveStats', () => {
  it('미스매치 배치는 실효 능력치를 크게 깎는다', () => {
    const atST = effectiveStats(striker, 'ST', 100)
    const atCB = effectiveStats(striker, 'CB', 100)
    expect(atCB.defending).toBeLessThan(atST.defending * 0.5)
  })
  it('체력 50%면 pace·physical이 유의하게 감소', () => {
    const fresh = effectiveStats(striker, 'ST', 100)
    const tired = effectiveStats(striker, 'ST', 50)
    expect(tired.pace).toBeLessThan(fresh.pace * 0.85)
    expect(tired.shooting).toBeLessThan(fresh.shooting) // 전 스탯 감소하되
    expect(tired.shooting).toBeGreaterThan(fresh.shooting * 0.8) // pace보다 완만
  })
})
