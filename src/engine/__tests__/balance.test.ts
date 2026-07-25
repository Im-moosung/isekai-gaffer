import { describe, it, expect } from 'vitest'
import { runAxisSweep, runAbBatch, type AxisKey } from '../balance'
import { runBatch } from '../calibrate'
import { loadTeam, type TeamId } from '../../data/loader'

// 격자는 10~90을 쓴다. 20~80으로 좁히면 축의 절벽이 격자 밖으로 빠져나가
// "고쳐지지 않았는데 통과하는" 게이트가 된다(Task 1 실측에서 실제로 발생).
const GRID = [10, 30, 50, 70, 90]
const N = 400

/** 축을 10에서 90으로 올렸을 때 경기당 승점의 변화. 양수면 "올릴수록 유리". */
function slope(homeId: TeamId, awayId: TeamId, axis: AxisKey): number {
  const cells = runAxisSweep(homeId, awayId, axis, [10, 90], N)
  return cells[1].points - cells[0].points
}

/**
 * 설계 의도: 라인·압박은 **상대에 따라 부호가 뒤집혀야** 한다.
 *  - 약체(남아공) 상대: 라인을 올려 상대를 가두고, 압박으로 후방에서 볼을 뺏는 것이 유리해야 한다.
 *  - 강팀(스페인) 상대: 하이라인은 뒷공간을 내주고, 하이프레스는 벗겨져 역효과여야 한다.
 *
 * argmax 비교가 아니라 **기울기 부호**로 판정하는 이유: 5셀 중 최댓값 위치는 n=400에서도
 * 노이즈로 흔들린다(Task 1 실측: 승점 폭 0.066 = 노이즈 수준인데 argmax는 매번 달라짐).
 * 양 끝점의 차이는 효과 크기가 커서 훨씬 안정적이다.
 *
 * 마진 0.08: n=400에서 승점 차의 표준오차가 약 0.085이므로, 부호만 보면 동전던지기가 된다.
 * 실질적 효과가 있어야 통과하도록 최소 크기를 요구한다.
 */
const MARGIN = 0.08

describe('지시 축 비단조성 — 최적 방향이 상대에 따라 뒤집혀야 한다', () => {
  // Task 2(축 밸런스)에서 해제한다.
  // 현재: 라인 상승 이득은 chanceQuality ±5.5%뿐인데 비용은 counterVulnerability ±25%라
  // 상대와 무관하게 "내릴수록 유리"다. 상대 빌드업 방해 보상 항(B1)이 아예 없다.
  it.skip('라인: 약체 상대로는 올릴수록 유리해야 한다', () => {
    expect(slope('kor', 'rsa', 'lineHeight')).toBeGreaterThan(MARGIN)
  }, 300_000)

  it.skip('라인: 강팀 상대로는 올릴수록 불리해야 한다', () => {
    expect(slope('kor', 'esp', 'lineHeight')).toBeLessThan(-MARGIN)
  }, 300_000)

  // 현재: 압박 이득은 chanceRate ×1.1 하나인데 비용은 counterVulnerability + foulRate
  // + staminaDrain + 지속압박 페널티로 4중 누적이라 상대와 무관하게 "내릴수록 유리"다.
  it.skip('압박: 약체 상대로는 올릴수록 유리해야 한다', () => {
    expect(slope('kor', 'rsa', 'pressing')).toBeGreaterThan(MARGIN)
  }, 300_000)

  it.skip('압박: 강팀 상대로는 올릴수록 불리해야 한다', () => {
    expect(slope('kor', 'esp', 'pressing')).toBeLessThan(-MARGIN)
  }, 300_000)
})

describe('지배 전략 방지 — 어느 축도 한쪽 끝이 압도하면 안 된다', () => {
  // Task 2에서 해제. 중간 전력 상대(멕시코)에서는 어느 축도 뚜렷한 정답이 없어야 한다.
  // 현재 압박은 폭 0.45(80에서 절벽), 라인은 0.159.
  for (const axis of ['lineHeight', 'pressing', 'tempo'] as const) {
    it.skip(`${axis}: 최고·최저 승점 차가 0.30 미만 (vs 멕시코)`, () => {
      const pts = runAxisSweep('kor', 'mex', axis, GRID, N).map(c => c.points)
      expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
    }, 300_000)
  }
})

describe('유저 개입 레버리지', () => {
  // Task 2에서 해제. 현재 6.0pp로 목표 8pp에 미달한다(Task 1 실측: base 32.0% → plan 38.0%).
  it.skip('상대별 맞춤 플랜이 기본값 대비 8pp 이상 승률을 올린다', () => {
    // vs 스페인(점유 강팀): 블록을 내리고 역습 — 낮은 라인·낮은 압박·빠른 템포
    const r = runAbBatch('kor', 'esp', {
      instructions: { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' },
      mentality: 'defensive',
      attackPattern: 'through',
    }, 400)
    expect(r.deltaPp).toBeGreaterThanOrEqual(8)
  }, 300_000)
})

describe('전력 서열 게이트', () => {
  // Task 2에서 해제. 현재 53.0%로 미달 — FIFA 1위 팀이 20위권 팀에 반반이라는 뜻이다.
  it.skip('스페인이 홈에서 한국 상대 55% 이상 승률', () => {
    const report = runBatch(loadTeam('esp'), loadTeam('kor'), 400)
    expect(report.homeWinRate).toBeGreaterThanOrEqual(0.55)
  }, 300_000)
})
