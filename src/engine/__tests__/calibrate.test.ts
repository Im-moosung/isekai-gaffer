// src/engine/__tests__/calibrate.test.ts
import { describe, it, expect } from 'vitest'
import { runBatch, checkCalibration } from '../calibrate'
import { makeTestTeam } from '../fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)

describe('runBatch', () => {
  it('n경기 평균 리포트를 만든다', () => {
    const r = runBatch(a, b, 50)
    expect(r.n).toBe(50)
    expect(r.avg.home.possession + r.avg.away.possession).toBeCloseTo(100, 0)
    expect(r.homeWinRate + r.drawRate).toBeLessThanOrEqual(1)
  })
  it('동급 팀 평균 득점은 현실 범위 (0.8~2.2골/팀)', () => {
    const r = runBatch(a, b, 100)
    for (const g of [r.avg.home.goals, r.avg.away.goals]) {
      expect(g).toBeGreaterThan(0.8); expect(g).toBeLessThan(2.2)
    }
  })
})

describe('checkCalibration', () => {
  it('베이스라인 지표별 허용 오차 판정을 반환한다', () => {
    const r = runBatch(a, b, 100)
    const checks = checkCalibration(r, a, b)
    const metrics = new Set(checks.map(c => c.metric))
    for (const m of ['possession', 'shotsPerGame', 'foulsPerGame', 'cornersPerGame']) expect(metrics.has(m)).toBe(true)
    checks.forEach(c => expect(typeof c.withinTolerance).toBe('boolean'))
  })
  it('동급 팀·기본 지시에서 슈팅·파울은 베이스라인 ±15% 이내 (캘리브레이션 계약)', () => {
    const r = runBatch(a, b, 200)
    const checks = checkCalibration(r, a, b).filter(c => ['shotsPerGame', 'foulsPerGame'].includes(c.metric))
    const failed = checks.filter(c => !c.withinTolerance)
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0)
  })
})
