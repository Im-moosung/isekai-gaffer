import { describe, it, expect } from 'vitest'
import { runAxisSweep, runAbBatch, runMentalitySweep, runFormationSweep, invertPlan, type AxisKey } from '../balance'
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
// 임계 0의 근거: 착수 시 목표는 상대별 −2pp였으나, 그 임계는 n=400에서 측정 불가다
// (승률 차의 표준오차 ≈ 3.5pp > 2pp). 상대별로는 **부호**만(오판이 보상받지 않는다) 요구하고
// 크기는 11팀 평균으로 건다.
//
// ⚠ n=1600의 근거(2026-07-30, 계측 하네스 구멍 수리 중 실측). 이전 판은 n=800이었는데,
// 그때 balance.batch()가 patch.formation만 덮어쓰고 XI 슬롯은 팀 기본 포메이션(4-2-3-1)
// 것을 그대로 뒀다 — 유저가 만들 수 없는 전술을 재고 있었다(워룸은 포메이션을 바꾸면 XI를
// 재배치한다). invertPlan은 11개 상대 **전부**에서 포메이션을 바꾸므로(4-4-2 ×9 · 5-4-1 ×2)
// 이 구멍은 뒤집은 플랜 arm에만, 기준선 arm에는 걸리지 않아 **대칭이 아니었다**.
// 수리 전후(n=800, Δpp): cze −14.5→−12.7 · mex −4.0→−1.4 · rsa −16.2→−15.3 · ecu −9.2→−8.4 ·
// eng −6.4→−3.4 · nor −4.7→−3.8 · arg −1.5→−2.6 · esp −15.0→−13.4 · can −12.2→−10.8 ·
// mar −10.2→−8.7 · **fra −2.9→+0.3** (평균 −8.8→−7.3). 즉 게이트는 vs 프랑스에서
// "존재할 수 없는 XI가 만든 페널티" 덕에 통과하고 있었고, 제대로 재면 부호가 뒤집혔다.
// n=800의 표준오차(≈2.5pp)로는 프랑스(참값 ≈−1pp)를 판정할 수 없어 n=1600(≈1.75pp)으로 올린다.
// 수리 후 실측(n=1600): rsa −15.7 · cze −13.2 · esp −12.8 · can −10.9 · ecu −9.4 · mar −6.7 ·
// eng −4.6 · nor −3.2 · mex −2.1 · arg −2.1 · fra −0.3 (평균 −7.4).
// (fra는 n=3200에서 −1.0으로, n=800의 +0.3은 노이즈였음이 확인됐다.)
//
// 전력이 대등한 매치업(mex edge 1.045 · arg 0.955)에서 폭이 작은 것은 구조적이다 —
// 그 구간에선 어느 쪽으로 틀어도 중립 지시와 큰 차이가 없고, 대신 추천과 오판의 **간격**이
// 유저가 실제로 체감하는 레버다. 프랑스가 유독 얇은 건 별개 이유다: 뒤집은 포메이션(4-4-2)이
// 상성상 최악이면서도 우리 스쿼드엔 기본 4-2-3-1보다 잘 맞아, 형태 교체만으로 상대와 무관하게
// +2.2~2.5pp가 되돌아온다(n=3200: fra A −1.0 vs 포메이션 미변경 B −3.2 · eng −5.1/−7.6 ·
// mex −3.1/−5.3). 아래 '포메이션 축 지배 방지' 게이트가 그 상대 무관 이득의 크기를 감시한다.
describe('나쁜 판단 페널티 — 뒤집은 플랜은 모든 상대에서 기본 지시보다 나빠야 한다', () => {
  const kor = loadTeam('kor')
  const N_BAD = 1600
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
    }, 600_000)
  }

  it('11팀 평균 −5pp 이하 — 오판의 대가가 측정 가능한 크기여야 한다', () => {
    const opps = TEAM_IDS.filter(t => t !== 'kor')
    const avg = opps.reduce((s, o) => s + badDelta(o), 0) / opps.length
    expect(avg).toBeLessThanOrEqual(-5)
  }, 900_000)
})

// 포메이션 축에는 지금까지 아무 게이트도 없었다 — 지시 3축과 멘탈리티는 지배 전략을 막고 있는데
// 정작 유저가 가장 먼저 만지는 축이 무감시였다. 위 페널티 게이트에서 드러난 사실이 계기다:
// 뒤집은 플랜이 고른 4-4-2는 상성상 최악인데도 상대와 무관하게 +2.2~2.5pp를 돌려준다.
// 실측(n=400, 중립 지시, 승점): 4-4-2·3-5-2가 mex·rsa·esp 세 상대 전부에서 상위 둘이고
// 승점 폭은 mex 0.137 · rsa 0.058 · esp 0.185다. 다른 축과 같은 임계(0.30) 아래라 지금은
// 통과하지만, 형태가 상대 무관 정답을 갖게 되면 여기서 먼저 터진다.
describe('포메이션 축 지배 방지 — 어느 형태도 압도하면 안 된다', () => {
  it('중간 전력(멕시코)에서 6종 승점 폭이 0.30 미만', () => {
    const pts = runFormationSweep('kor', 'mex', N).map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)
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
