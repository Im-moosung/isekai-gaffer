import { describe, it, expect } from 'vitest'
import {
  runAxisSweep, runAbBatch, runMentalitySweep, runFormationSweep, formationSlope, bestFormation, invertPlan,
  phaseFormationSlope, phaseDeclarationGain, groupIntensitySlope, groupIntensitySpan,
  attackPatternSlope, attackPatternSpan, setPieceRouteSlope, setPieceLoadSlope, setPieceSpan,
  type AxisKey,
} from '../balance'
import { FORMATION_POSTURE } from '../tactics'
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
// F0·F2·F1 이후 실측(n=3200, SE ≈ 1.24pp): cze −17.4 · rsa −16.8 · esp −13.1 · can −12.7 ·
// ecu −10.9 · eng −9.5 · mar −6.8 · nor −5.9 · mex −5.5 · fra −3.5 · arg −3.1 (평균 −9.56).
// 전력이 대등한 매치업(mex edge 1.045 · arg 0.955)에서 폭이 작은 것은 구조적이다 —
// 그 구간에선 어느 쪽으로 틀어도 중립 지시와 큰 차이가 없고, 대신 추천과 오판의 **간격**이
// 유저가 실제로 체감하는 레버다.
//
// ⚠ 2026-07-30 F0·F2·F1 이후 이 게이트의 성격이 한 번 바뀌었다. 그 전엔 뒤집은 플랜이
// 고르는 형태(당시 정의 = formationEdge argmin)가 우리 스쿼드엔 오히려 잘 맞아
// **+2.2~2.5pp가 공짜로 돌아왔고**, 프랑스전 페널티가 −1pp까지 얇아지는 원인이었다.
// F0(존 인원수)·F2(미드필드)로 그 공짜 점심을 없애고, invertPlan의 형태 정의를 추천과
// 같은 점수의 argmin으로 바꿔(balance.invertPlan 주석) 세 갈래가 함께 뒤집히게 했다.
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

// ── 포메이션 축 (F0·F2·F1) ──────────────────────────────────────
// 폭 게이트만 있던 판(2026-07-30 오전)은 **고정 정답을 잡지 못했다**. 그때 실측(n=3200,
// 중립 지시)에서 순위가 11개 상대 전부 동일했는데(3-5-2 > 4-4-2 > … > 5-4-1) 폭은
// 0.061~0.123으로 임계 0.30 한참 아래였기 때문이다. 즉 "압도하지 않는다"와 "상대가 다르면
// 정답이 다르다"는 서로 다른 명제이고, 후자는 **부호 반전**으로만 잴 수 있다.
//
// 수리 후 실측 (n=3200, 중립 지시, 경기당 승점. 셀 SE 0.021~0.024 · 페어드 SE 0.015~0.021):
//   상대   4-3-3  4-2-3-1  4-4-2  3-5-2  4-1-4-1  5-4-1   최적    최악   기울기(3-5-2 − 5-4-1)
//   rsa    2.073   1.996   2.008  2.059   2.023   1.957   4-3-3   5-4-1    +0.102
//   cze    2.112   2.047   2.075  2.112   2.092   2.008   3-5-2   5-4-1    +0.104
//   can    1.926   1.846   1.859  1.907   1.883   1.797   4-3-3   5-4-1    +0.110
//   ecu    1.805   1.726   1.727  1.754   1.760   1.664   4-3-3   5-4-1    +0.090
//   mex    1.673   1.582   1.623  1.651   1.664   1.571   4-3-3   5-4-1    +0.080
//   mar    2.013   1.941   1.962  1.991   1.994   1.915   4-3-3   5-4-1    +0.076
//   nor    1.644   1.609   1.587  1.609   1.644   1.619   4-1-4-1 4-4-2    −0.010
//   esp    0.884   0.854   0.851  0.808   0.934   0.936   5-4-1   3-5-2    −0.128
//   arg    1.296   1.271   1.278  1.202   1.356   1.334   4-1-4-1 3-5-2    −0.132
//   eng    0.907   0.918   0.904  0.788   1.007   1.072   5-4-1   3-5-2    −0.284
//   fra    0.801   0.857   0.811  0.743   0.974   1.034   5-4-1   3-5-2    −0.291
// **최적 형태뿐 아니라 최악 형태도 함께 뒤집힌다**: 약체·중간 6팀은 5-4-1이 최악,
// 강팀 4팀은 3-5-2가 최악이다. 그리고 기울기 순서가 매치업 우위 순서(rsa 1.096 … fra 0.898)와
// 단조로 일치한다 — 임의의 팀별 예외가 아니라 하나의 연속 축이라는 뜻이다.
// 전력이 대등한 노르웨이(edge 0.997)에서 폭 0.057·기울기 −0.010으로 축이 평평해지는 것도
// 설계 그대로다("대등하면 형태로 얻을 것이 없다").
describe('포메이션 축 비단조성 — 최적 형태가 상대에 따라 뒤집혀야 한다', () => {
  // 판정 통계는 **두 극단 형태의 페어드 승점 차**다(balance.formationSlope).
  // argmax를 직접 보지 않는 이유: 위 표에서 4-3-3과 4-1-4-1(또는 3-5-2)의 간격이 rsa 0.014~0.050
  // 으로 좁아, 셀 SE 0.02대에서는 argmax가 노이즈로 흔들린다(지시 축 게이트가 같은 이유로
  // 기울기를 쓴다). 반면 두 극단의 차이는 그보다 훨씬 안정적이고, 무엇보다
  // **부호가 상대에 따라 뒤집히는가**가 이 게이트가 실제로 묻는 질문이다.
  //
  // n=4000 · 페어드(같은 시드 대역) → 기울기의 표준오차 약 0.014. 마진 0.06은 그 4.3배이고,
  // 가장 얇은 셀(mar +0.076)도 마진 위로 1.1σ, 게이트가 거는 rsa(+0.102)는 3.0σ 위다.
  // 지시 축 MARGIN(0.08)보다 작은 것은 게이트가 헐거워서가 아니라 **측정이 페어드라
  // 표준오차가 6배 작기 때문**이다(지시 축은 n=400 비페어드로 SE 0.085).
  const N_FORM = 4000
  const FORM_MARGIN = 0.06

  it('약체(남아공) 상대로는 전진 배치(3-5-2)가 후진 배치(5-4-1)보다 유리해야 한다', () => {
    expect(formationSlope('kor', 'rsa', N_FORM)).toBeGreaterThan(FORM_MARGIN)
  }, 300_000)

  it('강팀(프랑스) 상대로는 후진 배치가 유리해야 한다', () => {
    expect(formationSlope('kor', 'fra', N_FORM)).toBeLessThan(-FORM_MARGIN)
  }, 300_000)

  // 스페인은 프랑스보다 매치업 지수가 완만하다(0.956 vs 0.898). 부호가 프랑스에서만
  // 뒤집히면 "세계 최강 한 팀에만 통하는 예외"가 되므로 두 번째 강팀에서도 요구한다.
  it('강팀(스페인) 상대로도 후진 배치가 유리해야 한다', () => {
    expect(formationSlope('kor', 'esp', N_FORM)).toBeLessThan(-FORM_MARGIN)
  }, 300_000)

  // 고정 시드는 재현성만 보장하지 안정성은 보장하지 않는다. 대역을 바꿔 부호를 재확인한다.
  it('시드 대역을 바꿔도 부호가 유지된다 (남아공 양수 / 프랑스 음수)', () => {
    expect(formationSlope('kor', 'rsa', N_FORM, 777_000)).toBeGreaterThan(FORM_MARGIN)
    expect(formationSlope('kor', 'fra', N_FORM, 777_000)).toBeLessThan(-FORM_MARGIN)
  }, 600_000)

  // 6종 전수에서도 "강팀 상대의 정답은 뒤에 사람을 두는 형태"가 성립해야 한다.
  // 프랑스에서만 거는 이유는 표본 근거다: fra는 최상위 후진 배치(5-4-1 1.034)와
  // 최상위 전진 배치(4-4-2 0.811)의 간격이 0.223으로 셀 SE(n=1200 기준 0.037)의 6배다.
  // 남아공은 그 간격이 0.050(1.4배)이라 같은 형태의 단언을 걸면 게이트가 노이즈를 잰다.
  it('강팀(프랑스) 상대의 최적 형태는 무게중심이 뒤에 있다', () => {
    const best = bestFormation(runFormationSweep('kor', 'fra', 1200))
    expect(FORMATION_POSTURE[best], `fra best=${best}`).toBeLessThan(0)
  }, 300_000)
})

describe('포메이션 축 지배 방지 — 어느 형태도 압도하면 안 된다', () => {
  // n을 400 → 4000으로 올린다. 6셀의 max−min은 셀 노이즈를 **양쪽 끝에서 한 번씩** 흡수해
  // 참값보다 체계적으로 부풀려지는 통계다: 참값이 전부 같아도 기댓값이 약 2.5σ다.
  // n=400이면 셀 SE 0.065 → 폭 기댓값 +0.16이라 **임계 0.30 게이트가 자기 노이즈를 재고
  // 있었다**(통과·실패가 시드 운). n=4000이면 셀 SE 0.021 → 부풀림 약 0.05로, 참값
  // 0.102(mex)를 임계와 안전하게 구분한다.
  it('중간 전력(멕시코)에서 6종 승점 폭이 0.30 미만', () => {
    const pts = runFormationSweep('kor', 'mex', 4000).map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 600_000)
})

// ── 게이트 없던 네 축 (P1~P4, 2026-07-30) ─────────────────────────
// 지시 3축·멘탈리티·포메이션에는 비단조성 게이트가 있었는데 아래 네 축에는 **아무 게이트도
// 없었고, 넷 다 상대 무관 정답을 갖고 있었다**(수리 전 실측, n=2400 페어드 · SE 0.012,
// 중립 지시 · 미선언 대비 경기당 승점):
//   phaseFormations 공격 3-5-2/수비 5-4-1  rsa +0.198 · mex +0.259 · esp +0.275 · fra +0.308
//   groupIntensity  공격+1/중원−1          rsa +0.083 · mex +0.091 · esp +0.018 · fra +0.033
//   attackPattern   cross                  rsa +0.111 · mex +0.103 · esp +0.093 · fra +0.093
//   setPiece        near/heavy             rsa +0.062 · mex +0.065 · esp +0.062 · fra +0.047
// 수리 내용과 계수 근거는 engine/tactics.ts P1~P4 주석에 있다.
//
// ── 표본 수의 근거 ────────────────────────────────────────────────
// 전부 **페어드**(두 arm이 같은 시드 대역 = 공통 난수)로 잰다. 실측 페어드 표준오차는
// n=2400에서 0.012이고 √n로 줄어든다 → n=4000에서 0.0093 · n=8000에서 0.0066.
// 비페어드였다면 같은 정밀도에 30배 넘는 표본이 필요하다(지시 축 게이트는 n=400 비페어드라
// SE가 0.085다 — 그래서 그쪽 MARGIN이 0.08로 크다).
// 마진은 각 축의 실측 효과 크기에서 정한다: **가장 얇은 쪽 게이트 값이 마진 위로 최소 5σ**가
// 되도록 잡되, 마진 자체가 "노이즈가 아니라 감독이 체감할 크기"여야 하므로 0.06 아래로는
// 내리지 않는다(경기당 승점 0.06 = 승률 약 2pp).
describe('페이즈 포메이션 축 (P1) — 최적 선언이 상대에 따라 뒤집혀야 한다', () => {
  // n=4000 · 페어드 → SE 0.0093. 실측(시드 대역 2개):
  //   rsa +0.224/+0.244 · mex +0.130/+0.111 · nor +0.062/+0.065 · esp −0.181/−0.174 · fra −0.378/−0.385
  // 가장 얇은 게이트(rsa)도 마진 위로 (0.224−0.06)/0.0093 = 17.6σ다.
  const N_PF = 4000
  const PF_MARGIN = 0.06

  it('약체(남아공) 상대로는 두 페이즈 모두 전진 배치가 유리해야 한다', () => {
    expect(phaseFormationSlope('kor', 'rsa', N_PF)).toBeGreaterThan(PF_MARGIN)
  }, 300_000)

  it('강팀(스페인) 상대로는 두 페이즈 모두 후진 배치가 유리해야 한다', () => {
    expect(phaseFormationSlope('kor', 'esp', N_PF)).toBeLessThan(-PF_MARGIN)
  }, 300_000)

  it('강팀(프랑스) 상대로도 후진 배치가 유리해야 한다', () => {
    expect(phaseFormationSlope('kor', 'fra', N_PF)).toBeLessThan(-PF_MARGIN)
  }, 300_000)

  it('시드 대역을 바꿔도 부호가 유지된다 (남아공 양수 / 프랑스 음수)', () => {
    expect(phaseFormationSlope('kor', 'rsa', N_PF, 777_000)).toBeGreaterThan(PF_MARGIN)
    expect(phaseFormationSlope('kor', 'fra', N_PF, 777_000)).toBeLessThan(-PF_MARGIN)
  }, 600_000)

  // 이 축의 원래 고장은 "폭이 크다"가 아니라 **"선언 자체가 공짜 이득"**이었다(중간 전력
  // 상대에게도 +0.259). 그래서 폭(max−min)이 아니라 **미선언 대비 상단**을 잰다 —
  // 하단(공격 5-4-1/수비 3-5-2 같은 자기모순 선언)이 깊게 벌받는 것은 설계 그대로다.
  // 임계 0.12: 수리 후 실측이 mex 0.052/0.057이라 7σ 여유가 있고, 수리 전 값(0.259)은
  // 확실히 잡는다. 다른 축의 폭 임계(0.30)보다 낮은 것은 이것이 폭이 아니라 상단이기 때문이다.
  it('지배 방지: 중간 전력(멕시코)에서 어떤 선언도 미선언 대비 +0.12를 넘지 않는다', () => {
    expect(phaseDeclarationGain('kor', 'mex', N_PF)).toBeLessThan(0.12)
    expect(phaseDeclarationGain('kor', 'mex', N_PF, 777_000)).toBeLessThan(0.12)
  }, 600_000)
})

describe('그룹 적극성 축 (P2) — 최적 무게중심이 상대에 따라 뒤집혀야 한다', () => {
  // n=4000 실측: rsa +0.123/+0.137 · mex +0.026/+0.021 · esp −0.184/−0.153 · fra −0.291/−0.295
  // 가장 얇은 게이트(rsa)가 마진 위로 (0.123−0.06)/0.0093 = 6.8σ.
  const N_GI = 4000
  const GI_MARGIN = 0.06

  it('약체(남아공) 상대로는 앞으로 옮기는 쪽이 유리해야 한다', () => {
    expect(groupIntensitySlope('kor', 'rsa', N_GI)).toBeGreaterThan(GI_MARGIN)
  }, 300_000)

  it('강팀(스페인) 상대로는 뒤로 옮기는 쪽이 유리해야 한다', () => {
    expect(groupIntensitySlope('kor', 'esp', N_GI)).toBeLessThan(-GI_MARGIN)
  }, 300_000)

  it('시드 대역을 바꿔도 부호가 유지된다 (남아공 양수 / 프랑스 음수)', () => {
    expect(groupIntensitySlope('kor', 'rsa', N_GI, 777_000)).toBeGreaterThan(GI_MARGIN)
    expect(groupIntensitySlope('kor', 'fra', N_GI, 777_000)).toBeLessThan(-GI_MARGIN)
  }, 600_000)

  it('지배 방지: 중간 전력(멕시코)에서 8편성 승점 폭이 0.30 미만', () => {
    expect(groupIntensitySpan('kor', 'mex', N_GI)).toBeLessThan(0.30)
  }, 600_000)
})

describe('공격 패턴 축 (P3) — 크로스와 중앙 침투의 서열이 상대에 따라 뒤집혀야 한다', () => {
  // 판별자는 상대 라인 높이다(뒷공간이 있으면 침투, 박스가 잠겨 있으면 크로스).
  // n=4000 실측: rsa +0.169/+0.194 · cze +0.120/+0.151 · mex −0.048/−0.033 ·
  //              esp −0.137/−0.119 · fra −0.135/−0.133
  const N_AP = 4000
  const AP_MARGIN = 0.06

  it('물러선 블록(남아공 라인 40) 상대로는 크로스가 중앙 침투보다 낫다', () => {
    expect(attackPatternSlope('kor', 'rsa', N_AP)).toBeGreaterThan(AP_MARGIN)
  }, 300_000)

  it('하이라인(스페인 라인 62) 상대로는 중앙 침투가 낫다', () => {
    expect(attackPatternSlope('kor', 'esp', N_AP)).toBeLessThan(-AP_MARGIN)
  }, 300_000)

  it('시드 대역을 바꿔도 부호가 유지된다 (남아공 양수 / 프랑스 음수)', () => {
    expect(attackPatternSlope('kor', 'rsa', N_AP, 777_000)).toBeGreaterThan(AP_MARGIN)
    expect(attackPatternSlope('kor', 'fra', N_AP, 777_000)).toBeLessThan(-AP_MARGIN)
  }, 600_000)

  it('지배 방지: 중간 전력(멕시코)에서 4종 승점 폭이 0.30 미만', () => {
    expect(attackPatternSpan('kor', 'mex', N_AP)).toBeLessThan(0.30)
  }, 300_000)
})

describe('세트피스 축 (P4) — 루트는 상대 GK가, 박스 인원은 매치업이 정한다', () => {
  // 이 축은 효과 크기가 네 축 중 가장 작다(세트피스 슛이 경기당 1.75회뿐이다). 그래서
  // **표본을 세 배로** 쓴다: n=12000 → 페어드 SE 0.0054(n=2400의 0.012에서 √5배 축소).
  // 마진도 그에 맞춰 0.02~0.03으로 내린다 — 다른 축의 0.06을 그대로 쓰면 게이트가 영원히
  // 통과할 수 없고, 반대로 마진 0으로 두면 부호가 시드 운에 걸린다.
  const N_SP = 12_000

  // 루트 실측(n=12000, near − far, 박스 normal 고정)은 상대 **선발 GK 제공권에 단조**다.
  // 참고로 n=4800 전수(11개 상대, near − far):
  //   74 ecu +0.043 | 76 can +0.017 rsa +0.015 cze +0.015 fra +0.009
  //   78 mex −0.007 nor −0.010 arg −0.011 | 80 esp −0.022 mar −0.023 eng −0.029
  // 게이트에 쓰는 두 상대의 n=12000 값(시드 대역 2개): ecu +0.040/+0.038 · eng −0.033/−0.030.
  // 마진 위로 ecu 3.3σ · eng 2.8σ다.
  it('제공권이 약한 GK(에콰도르 74) 상대로는 니어가 파포스트보다 낫다 (두 시드 대역)', () => {
    expect(setPieceRouteSlope('kor', 'ecu', N_SP)).toBeGreaterThan(0.02)
    expect(setPieceRouteSlope('kor', 'ecu', N_SP, 777_000)).toBeGreaterThan(0.02)
  }, 600_000)

  it('제공권이 강한 GK(잉글랜드 80) 상대로는 파포스트가 낫다 (두 시드 대역)', () => {
    expect(setPieceRouteSlope('kor', 'eng', N_SP)).toBeLessThan(-0.015)
    expect(setPieceRouteSlope('kor', 'eng', N_SP, 777_000)).toBeLessThan(-0.015)
  }, 600_000)

  // 인원 실측(n=12000, heavy − light, 루트 far 고정) — 역습 위험 지수에 단조이고
  // arg(risk 1.578) 부근에서 부호가 갈린다:
  //   rsa(0.40) +0.050/+0.053 · mex(0.64) +0.048/+0.047 · arg(1.58) +0.008/+0.007 ·
  //   eng(2.14) −0.030/−0.031 · fra(2.50) −0.049/−0.045
  it('역습이 무섭지 않은 상대(남아공)에겐 박스에 사람을 더 넣는 쪽이 낫다 (두 시드 대역)', () => {
    expect(setPieceLoadSlope('kor', 'rsa', N_SP)).toBeGreaterThan(0.03)
    expect(setPieceLoadSlope('kor', 'rsa', N_SP, 777_000)).toBeGreaterThan(0.03)
  }, 600_000)

  it('역습이 치명적인 상대(프랑스)에겐 박스 인원을 줄이는 쪽이 낫다 (두 시드 대역)', () => {
    expect(setPieceLoadSlope('kor', 'fra', N_SP)).toBeLessThan(-0.02)
    expect(setPieceLoadSlope('kor', 'fra', N_SP, 777_000)).toBeLessThan(-0.02)
  }, 600_000)

  it('지배 방지: 중간 전력(멕시코)에서 9종 승점 폭이 0.30 미만', () => {
    expect(setPieceSpan('kor', 'mex', 4000)).toBeLessThan(0.30)
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
