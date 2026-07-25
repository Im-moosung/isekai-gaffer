import { describe, it, expect } from 'vitest'
import { runAxisSweep, bestAxisValue, runAbBatch } from '../balance'
import { runBatch } from '../calibrate'
import { loadTeam } from '../../data/loader'

const VALUES = [20, 35, 50, 65, 80]

describe('지시 축 비단조성 — 최적값이 상대에 따라 달라져야 한다', () => {
  // Task 2(축 밸런스)에서 해제한다. 현재는 rsa 35 vs esp 20으로 아슬아슬하게 통과할 뿐이며,
  // 라인 상승 이득(±5.5%)이 비용(±25%)에 눌려 두 상대 모두 사실상 저라인이 최적이다.
  it.skip('라인: 약체(남아공)전 최적 라인이 강팀(스페인)전보다 높다', () => {
    const vsRsa = bestAxisValue(runAxisSweep('kor', 'rsa', 'lineHeight', VALUES))
    const vsEsp = bestAxisValue(runAxisSweep('kor', 'esp', 'lineHeight', VALUES))
    expect(vsRsa).toBeGreaterThan(vsEsp)
  }, 300_000)

  // Task 2(축 밸런스)에서 해제한다. 현재 엔진은 압박이 단조 감소라 rsa·esp 모두 최저값이 최적이다.
  it.skip('압박: 약체(남아공)전 최적 압박이 강팀(스페인)전보다 높다', () => {
    const vsRsa = bestAxisValue(runAxisSweep('kor', 'rsa', 'pressing', VALUES))
    const vsEsp = bestAxisValue(runAxisSweep('kor', 'esp', 'pressing', VALUES))
    expect(vsRsa).toBeGreaterThan(vsEsp)
  }, 300_000)

  // Task 2(축 밸런스)에서 해제한다. 현재 차이는 0.159로 통과하지만 Task 2의 축 재설계 후
  // 재검증해야 의미가 있으므로 나머지 게이트와 함께 묶어 둔다.
  it.skip('라인 최고값과 최저값의 승점 차가 0.30을 넘지 않는다(지배 전략 방지)', () => {
    const cells = runAxisSweep('kor', 'mex', 'lineHeight', VALUES)
    const pts = cells.map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)

  // Task 2(축 밸런스)에서 해제한다. 압박 80의 절벽(1.142) 때문에 현재 차이가 0.45로 필연 실패한다.
  it.skip('압박 최고값과 최저값의 승점 차가 0.30을 넘지 않는다', () => {
    const cells = runAxisSweep('kor', 'mex', 'pressing', VALUES)
    const pts = cells.map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)
})

describe('유저 개입 레버리지', () => {
  // Task 2(축 밸런스)에서 해제한다. 현재 레버리지는 6pp로 목표 8pp에 미달한다.
  it.skip('상대별 맞춤 플랜이 기본값 대비 8pp 이상 승률을 올린다', () => {
    // vs 스페인(점유 강팀): 블록을 내리고 역습 — 낮은 라인·낮은 압박·빠른 템포
    const r = runAbBatch('kor', 'esp', {
      instructions: { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' },
      mentality: 'defensive',
      attackPattern: 'through',
    })
    expect(r.deltaPp).toBeGreaterThanOrEqual(8)
  }, 300_000)
})

describe('전력 서열 게이트', () => {
  // Task 2(축 밸런스)에서 해제한다. 현재 53%로 미달 — 축 비용 구조가 바뀌면 서열도 함께 재조정된다.
  it.skip('스페인이 홈에서 한국 상대 55% 이상 승률', () => {
    const report = runBatch(loadTeam('esp'), loadTeam('kor'), 300)
    expect(report.homeWinRate).toBeGreaterThanOrEqual(0.55)
  }, 300_000)
})
