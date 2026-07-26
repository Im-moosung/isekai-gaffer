import { describe, it, expect } from 'vitest'
import { runAxisSweep, runAbBatch, runMentalitySweep, invertPlan, type AxisKey } from '../balance'
import { runBatch } from '../calibrate'
import { recommendPlan } from '../../game/scouting'
import { loadTeam, TEAM_IDS, type TeamId } from '../../data/loader'

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
  // Task 2에서 해결: 라인·압박에 '상대 억제'(suppression)와 압축 이득(chanceRate)을 추가하고
  // 그 효율을 상대의 후방 전개 능력에 반비례시켰다(tactics.ts trapFactor).
  it('라인: 약체 상대로는 올릴수록 유리해야 한다', () => {
    expect(slope('kor', 'rsa', 'lineHeight')).toBeGreaterThan(MARGIN)
  }, 300_000)

  it('라인: 강팀 상대로는 올릴수록 불리해야 한다', () => {
    expect(slope('kor', 'esp', 'lineHeight')).toBeLessThan(-MARGIN)
  }, 300_000)

  // 압박은 counterVulnerability 과금에서 빠지고(B4), 지속압박 체력 가중은 임계 초과분에
  // 비례하는 연속 함수가 됐다(기존 고정 계단이 press 69→70에서 승점 0.35 절벽을 만들었다).
  it('압박: 약체 상대로는 올릴수록 유리해야 한다', () => {
    expect(slope('kor', 'rsa', 'pressing')).toBeGreaterThan(MARGIN)
  }, 300_000)

  it('압박: 강팀 상대로는 올릴수록 불리해야 한다', () => {
    expect(slope('kor', 'esp', 'pressing')).toBeLessThan(-MARGIN)
  }, 300_000)
})

describe('지배 전략 방지 — 어느 축도 한쪽 끝이 압도하면 안 된다', () => {
  // 중간 전력 상대(멕시코)에서는 어느 축도 뚜렷한 정답이 없어야 한다.
  for (const axis of ['lineHeight', 'pressing', 'tempo'] as const) {
    it(`${axis}: 최고·최저 승점 차가 0.30 미만 (vs 멕시코)`, () => {
      const pts = runAxisSweep('kor', 'mex', axis, GRID, N).map(c => c.points)
      expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
    }, 300_000)
  }
})

// ── 멘탈리티 축 (E1) ────────────────────────────────────────────
// 지시 축과 같은 이유로 게이트가 필요하다. 착수 전 실측(n=400, 지시 50/50/50)에서
// 멘탈리티는 상대와 무관하게 공격적일수록 유리한 단조 지배 축이었다:
//   rsa slope(매우공격 − 매우수비) +0.210 / mex span 0.107 / esp slope **+0.035**
// esp에서도 부호가 양수라는 것이 문제의 핵심이다 — 세계 2위 상대로 총공세가 공짜였다.
describe('멘탈리티 축 비단조성 — 최적 태세가 상대에 따라 뒤집혀야 한다', () => {
  /** 매우 공격적 − 매우 수비적의 경기당 승점 차. 양수면 "나갈수록 유리". */
  function mentalitySlope(awayId: TeamId): number {
    const cells = runMentalitySweep('kor', awayId, N)
    return cells[cells.length - 1].points - cells[0].points
  }

  // 마진은 지시 축 게이트와 동일한 MARGIN(0.08) — n=400에서 승점 차 표준오차 ≈ 0.085이므로
  // 부호만 보면 동전던지기다. 실질적 효과 크기를 요구한다.
  it('약체(남아공) 상대로는 나갈수록 유리해야 한다', () => {
    expect(mentalitySlope('rsa')).toBeGreaterThan(MARGIN)
  }, 300_000)

  it('강팀(스페인) 상대로는 나갈수록 불리해야 한다', () => {
    expect(mentalitySlope('esp')).toBeLessThan(-MARGIN)
  }, 300_000)

  it('지배 방지: 중간 전력(멕시코)에서 5단 승점 폭이 0.30 미만', () => {
    const pts = runMentalitySweep('kor', 'mex', N).map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)
})

// 사용자 요구의 직접 번역: "잘하면 올라가고 **못하면 내려가야** 한다".
// 추천 플랜을 뒤집은 플랜(invertPlan)이 기본 지시보다 나은 상대가 하나라도 있으면
// 그 상대에겐 감독의 오판이 처벌받지 않는다는 뜻이다.
//
// n=800·임계 0의 근거: 착수 시 목표는 상대별 −2pp였으나, 그 임계는 n=400에서 측정 불가다
// (승률 차의 표준오차 ≈ 3.5pp > 2pp). n을 800으로 올려 오차를 ≈2.5pp로 줄이고, 상대별로는
// **부호**만(오판이 보상받지 않는다) 요구하되 크기는 11팀 평균으로 건다.
// 착수 후 실측(n=800): rsa −17.5 · cze −13.6 · can −12.4 · esp −11.6 · ecu −8.3 · mar −7.5 ·
// eng −5.1 · nor −2.6 · fra −2.0 · arg −1.4 · mex −1.0 (평균 −7.6).
// 전력이 대등한 매치업(mex edge 1.045 · arg 0.955)에서 폭이 작은 것은 구조적이다 —
// 그 구간에선 어느 쪽으로 틀어도 중립 지시와 큰 차이가 없고, 대신 추천과 오판의 **간격**
// (mex 7.3pp · arg 7.9pp)이 유저가 실제로 체감하는 레버다.
describe('나쁜 판단 페널티 — 뒤집은 플랜은 모든 상대에서 기본 지시보다 나빠야 한다', () => {
  const kor = loadTeam('kor')
  const N_BAD = 800
  const measured: Record<string, number> = {}
  const badDelta = (opp: TeamId) => {
    if (measured[opp] === undefined) {
      const plan = recommendPlan(kor, loadTeam(opp)).patch
      measured[opp] = runAbBatch('kor', opp, invertPlan(plan, loadTeam(opp)), N_BAD).deltaPp
    }
    return measured[opp]
  }

  for (const opp of TEAM_IDS.filter(t => t !== 'kor')) {
    it(`vs ${opp}: 뒤집은 플랜이 기본 지시보다 낫지 않다`, () => {
      expect(badDelta(opp)).toBeLessThanOrEqual(0)
    }, 300_000)
  }

  it('11팀 평균 −5pp 이하 — 오판의 대가가 측정 가능한 크기여야 한다', () => {
    const opps = TEAM_IDS.filter(t => t !== 'kor')
    const avg = opps.reduce((s, o) => s + badDelta(o), 0) / opps.length
    expect(avg).toBeLessThanOrEqual(-5)
  }, 600_000)
})

describe('유저 개입 레버리지', () => {
  it('상대별 맞춤 플랜이 기본값 대비 8pp 이상 승률을 올린다', () => {
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
  it('스페인이 홈에서 한국 상대 55% 이상 승률', () => {
    const report = runBatch(loadTeam('esp'), loadTeam('kor'), 400)
    expect(report.homeWinRate).toBeGreaterThanOrEqual(0.55)
  }, 300_000)
})
