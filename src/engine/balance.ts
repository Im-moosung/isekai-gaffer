// src/engine/balance.ts
// 밸런스 계측 전용 배치 시뮬. 프로덕션 번들에 포함되지 않도록 UI에서 import 금지.
// 목적: 지시 축이 "상대와 무관한 단조 지배 전략"이 되지 않았음을 회귀 테스트로 고정한다.
//
// ⚠ 이 하네스가 재는 것과 실제 경기의 차이(2026-07-30 점검). 게이트를 읽을 때 전제로 삼아라.
//  1. **감독 개입이 없는 경기다.** batch()는 킥오프 전술을 그대로 90분 돌린다. 하프타임
//     팀토크·터치라인 외침·개입 부스트(boostUntil)·플랜 유지 보너스(planIntact)·구조 변경
//     적응 지연(adaptLag)은 전부 game/matchStore 계층이라 여기 들어오지 않는다.
//  2. **상대 AI도 적응하지 않는다.** 실경기의 상대 감독(game/oppAi.decideAwayActions, 46·60·
//     70·80분 교체/전술 스위칭)은 matchStore가 돌린다. 여기선 원정팀이 킥오프 전술로 고정이다.
//     → 즉 여기 수치는 "플랜만의 순효과"다. 두 arm 모두 같은 조건이라 비교는 유효하지만,
//       유저가 체감하는 절대 승률은 아니다. 게이트 임계를 이 수치로 정할 때 이 점을 기억하라.
//  3. **기준선(base)의 지시 50/50/50은 게임의 실제 기본값이 아니다.** App은 pickBestXI(kor)로
//     시작하고 그 지시는 팀 프로필 스타일(라인 50·압박 62·템포 55)이다. 여기 base는 "중립
//     지시"라는 기준점일 뿐 "아무것도 안 했을 때"가 아니다. Δpp를 그렇게 읽으면 안 된다.
//  4. XI는 patch.formation을 반영해 다시 세운다(batch 주석 참고). 여기가 실제로 게이트를
//     오염시키던 구멍이었다.
import type { AttackPattern, BoxLoad, FormationId, GroupIntensity, Mentality, PhaseFormations, SetPieceRoute, TacticState, Team } from './types'
import { loadTeam, type TeamId } from '../data/loader'
import { createMatch, simulateSegment, flankStrength } from './simulate'
import { pickBestXI } from './lineup'
import { ATTACK_PATTERNS, BOX_LOADS, FORMATION_POSTURE, MENTALITIES, SET_PIECE_ROUTES } from './tactics'

export type AxisKey = 'lineHeight' | 'pressing' | 'tempo'

export interface SweepCell {
  value: number
  /** 홈(유저) 승률 0~1 */
  winRate: number
  /** 경기당 승점 0~3 — 무승부를 반영해 승률보다 노이즈가 낮다 */
  points: number
  gf: number
  ga: number
}

/** 홈 전술을 base에 patch를 병합해 구성하고 n경기 배치 시뮬. 시드는 seedBase부터 결정론 증가.
 *
 *  ⚠ XI는 **패치된 포메이션 기준**으로 세운다. 이전엔 팀 기본 포메이션(kor 4-2-3-1)의 XI에
 *  patch.formation만 덮어써서, "포메이션은 4-4-2인데 슬롯 배치는 4-2-3-1"인 유저가 만들 수
 *  없는 전술을 재고 있었다. 실측(n=800, 나쁜 판단 페널티 게이트)에서 이 구멍은 상대별로
 *  0.8~3.2pp를 왜곡했다 — 대칭이 아니다. 기준선 arm은 포메이션을 패치하지 않아 영향이 없고
 *  패치 arm만 값이 바뀌기 때문이다.
 *  UI 워룸은 포메이션 변경 시 autoFill로 XI를 재배치하는데, kor·6포메이션 전수에서
 *  pickBestXI(team, f)와 autoFill 결과의 적합도 합이 같다(실측 확인). 그래서 엔진 계층에서
 *  UI 함수를 끌어오지 않고 pickBestXI에 포메이션을 넘기는 것으로 충분하다.
 *  호출자가 patch.lineup을 명시하면 그쪽이 이긴다(아래 `...patch`). */
function batch(homeId: TeamId, awayId: TeamId, patch: Partial<TacticState>, n: number, seedBase: number) {
  const home = loadTeam(homeId)
  const away = loadTeam(awayId)
  // XI 구성은 결정론이라 경기마다 다시 세울 이유가 없다(루프 밖으로 뺀 순수 최적화).
  const t = pickBestXI(home, patch.formation)
  const tactics: TacticState = {
    ...t,
    ...patch,
    instructions: { ...t.instructions, ...(patch.instructions ?? {}) },
  }
  let w = 0, d = 0, gf = 0, ga = 0
  for (let i = 0; i < n; i++) {
    let st = createMatch(home, away, { seed: seedBase + i * 31, homeTactics: tactics })
    // 전반·후반을 나눠 돌린다: firstHalfScript는 45분 도달 시 일괄 적용되는 구조라
    // 한 번에 90으로 가면 조별 스크립트 경로가 달라진다.
    st = simulateSegment(st, 45)
    st = simulateSegment(st, 90)
    gf += st.score[0]; ga += st.score[1]
    if (st.score[0] > st.score[1]) w++
    else if (st.score[0] === st.score[1]) d++
  }
  return { winRate: w / n, points: (w * 3 + d) / n, gf: gf / n, ga: ga / n }
}

/** 중립 지시 — 축을 분리해 재는 모든 계측의 공통 기준점. */
const NEUTRAL_INS = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' as const }

/** 임의 플랜의 경기당 승점. 지시는 중립(50/50/50)으로 고정하고 patch가 그 위를 덮는다.
 *
 *  ★ 두 arm에 **같은 seedBase**를 주면 공통 난수(paired)가 되어 차이의 표준오차가 셀 단위
 *  SE보다 5~6배 작아진다(실측: 비페어드 0.085 → 페어드 0.014, n=2400). 이 저장소는
 *  "n=800에서 fra +0.3을 참값으로 착각했는데 n=3200의 참값이 −1.0이었다"로 한 번 데였다.
 *  새 축의 게이트는 전부 이 함수를 통한 페어드 차이로 판정한다. */
export function planPoints(
  homeId: TeamId, awayId: TeamId, patch: Partial<TacticState>, n: number, seedBase = 1000,
): number {
  return batch(homeId, awayId, { instructions: NEUTRAL_INS, ...patch }, n, seedBase).points
}

/** 두 플랜의 페어드 승점 차(a − b). 양수면 a가 유리. */
export function planSlope(
  homeId: TeamId, awayId: TeamId,
  a: Partial<TacticState>, b: Partial<TacticState>, n: number, seedBase = 1000,
): number {
  return planPoints(homeId, awayId, a, n, seedBase) - planPoints(homeId, awayId, b, n, seedBase)
}

/** 한 축만 values로 변화시키고 나머지는 중립(50)으로 고정한 스윕. */
export function runAxisSweep(
  homeId: TeamId, awayId: TeamId, axis: AxisKey, values: number[], n = 120,
): SweepCell[] {
  return values.map(value => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced', [axis]: value },
    }, n, 1000)
    return { value, ...r }
  })
}

/** 멘탈리티 5단 스윕. 지시는 중립(50/50/50)으로 고정해 태세 축만 분리한다.
 *  지시 축 스윕(runAxisSweep)과 시드·n 규약을 맞춰 두 축의 수치를 직접 비교할 수 있게 했다. */
export function runMentalitySweep(
  homeId: TeamId, awayId: TeamId, n = 120,
): { mentality: Mentality; winRate: number; points: number; gf: number; ga: number }[] {
  return MENTALITIES.map(mentality => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
      mentality,
    }, n, 1000)
    return { mentality, ...r }
  })
}

/** 포메이션 6종 스윕. 지시는 중립(50/50/50), 태세는 미지정으로 고정해 형태 축만 분리한다.
 *  XI는 batch()가 포메이션별로 다시 세운다 — 유저가 워룸에서 포메이션을 바꿨을 때와 같다.
 *
 *  이 스윕이 뒤늦게 추가된 이유: 지시·멘탈리티에는 지배 전략 방지 게이트가 있었는데
 *  **포메이션 축에만 아무 게이트도 없었다**. 착수 전 실측(n=3200, 중립 지시)에서 순위가
 *  8개 상대 **전부 동일**했다(3-5-2 > 4-4-2 > … > 5-4-1, 폭 0.061~0.123 · 페어드 SE
 *  0.012~0.018). 폭이 임계(0.30) 아래라 폭 게이트만으로는 이 고정 정답을 잡을 수 없다 —
 *  그래서 아래 formationSlope 기반 **부호 반전** 게이트가 함께 필요하다.
 *  수리 내용은 engine/tactics.ts의 'F1 포메이션 축 비단조성' 주석 참고. */
export function runFormationSweep(
  homeId: TeamId, awayId: TeamId, n = 120, seedBase = 1000,
): { formation: FormationId; winRate: number; points: number; gf: number; ga: number }[] {
  return FORMATION_IDS.map(formation => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
      formation,
    }, n, seedBase)
    return { formation, ...r }
  })
}

/** 형태 축의 '기울기' — 가장 전진 배치(3-5-2, posture +0.55) 빼기 가장 후진 배치
 *  (5-4-1, −1.0)의 경기당 승점 차. 양수면 "앞에 사람을 더 두는 것이 유리".
 *
 *  argmax가 아니라 두 극단의 차이를 재는 이유는 지시·멘탈리티 게이트와 같다: 6셀 중
 *  최댓값 위치는 같은 posture 부호끼리(3-5-2/4-3-3, 5-4-1/4-1-4-1) 노이즈로 흔들린다.
 *  양 끝점은 효과 크기가 커서 훨씬 안정적이고, **두 arm이 같은 시드 대역을 쓰므로 차이가
 *  페어드**라 표준오차가 셀 단위 SE보다 작다(n=2400에서 약 0.018). */
export function formationSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const ins = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' as const }
  const fwd = batch(homeId, awayId, { instructions: ins, formation: '3-5-2' }, n, seedBase)
  const back = batch(homeId, awayId, { instructions: ins, formation: '5-4-1' }, n, seedBase)
  return fwd.points - back.points
}

// ── 게이트 없던 네 축 (P1~P4, 2026-07-30) ────────────────────────────
// 지시 3축·멘탈리티·포메이션에는 비단조성 게이트가 있었는데 **아래 넷에는 아무것도 없었고,
// 넷 다 상대 무관 정답을 갖고 있었다**(실측 n=2400 페어드 · SE 0.012, 중립 지시 · 미선언 대비):
//   phaseFormations 공격 3-5-2/수비 5-4-1  rsa +0.198 · mex +0.259 · esp +0.275 · fra +0.308
//   groupIntensity  공격+1/중원−1          rsa +0.083 · mex +0.091 · esp +0.018 · fra +0.033
//   attackPattern   cross                  rsa +0.111 · mex +0.103 · esp +0.093 · fra +0.093
//   setPiece        near/heavy             rsa +0.062 · mex +0.065 · esp +0.062 · fra +0.047
// 수리 내용과 계수 근거는 engine/tactics.ts의 P1~P4 주석에 있다.
//
// ★ 네 축의 대가는 전부 **선언했을 때만** 켜진다(미선언·표준값이면 배수가 정확히 1.0).
//   캘리브레이션 배치(runBatch)는 네 축을 하나도 선언하지 않으므로 계약이 비트 단위로
//   불변이다 — 실측으로 확인했다(runBatch n=300 홈 슛 편차 kor-cze +15.3% · esp-arg +20.4%로
//   a9f946a 기록과 소수점까지 동일).
//
// 아래 계측은 전부 **페어드**(두 arm이 같은 시드 대역)다. 이 저장소는 비페어드 소표본으로
// 두 번 데였다(n=800에서 fra 참값 −1.0을 +0.3으로 읽음 · n=400 스윕이 자기 노이즈를 잼).
// 페어드 차이의 표준오차는 n=2400에서 약 0.012이고 n에 √로 줄어든다.

/** 페이즈 포메이션 축의 기울기 — 두 페이즈 모두 전진(3-5-2) 빼기 두 페이즈 모두 후진(5-4-1).
 *  36개 조합의 argmax가 아니라 **정렬된 두 극단**을 쓰는 이유는 formationSlope와 같다:
 *  argmax는 노이즈로 흔들리고, 이 게이트가 묻는 질문은 "부호가 상대에 따라 뒤집히는가"다. */
export function phaseFormationSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  return planSlope(homeId, awayId,
    { phaseFormations: { attack: '3-5-2', defense: '3-5-2' } },
    { phaseFormations: { attack: '5-4-1', defense: '5-4-1' } }, n, seedBase)
}

/** 페이즈 선언 후보들 중 **미선언 대비 최대 이득**. 0 이하면 선언 자체가 손해라는 뜻이다.
 *  폭(max−min)이 아니라 상단만 재는 이유: 이 축의 문제는 "아무 상대에게나 선언하면 공짜로
 *  이득"이었다는 것이고, 하단(공격 5-4-1/수비 3-5-2 같은 자기모순 조합)이 깊게 벌받는 것은
 *  고쳐야 할 문제가 아니라 설계 그대로다. 6종 전수 대신 무게중심 양 끝과 그 조합만 본다 —
 *  중간 형태는 정의상 두 끝 사이에 놓인다(대가·보상이 모두 posture에 선형이다). */
export function phaseDeclarationGain(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const base = planPoints(homeId, awayId, {}, n, seedBase)
  const cands: PhaseFormations[] = [
    { attack: '3-5-2', defense: '3-5-2' }, { attack: '3-5-2', defense: '5-4-1' },
    { attack: '5-4-1', defense: '5-4-1' }, { attack: '5-4-1', defense: '3-5-2' },
    { attack: '4-3-3', defense: '4-1-4-1' },
  ]
  return Math.max(...cands.map(pf => planPoints(homeId, awayId, { phaseFormations: pf }, n, seedBase) - base))
}

const GI_FWD: GroupIntensity = { attack: 1, midfield: 0, defense: -1 }
const GI_BACK: GroupIntensity = { attack: -1, midfield: 0, defense: 1 }

/** 그룹 적극성 축의 기울기 — 무게중심 앞(공격+1/수비−1) 빼기 뒤(공격−1/수비+1).
 *  ⚠ 앞쪽 arm은 '늘어남'(giStretch) 2를 함께 무는 반면 뒤쪽 arm은 0이다. 즉 이 기울기에는
 *  −0.05 정도의 고정 오프셋이 실려 있다(설계 그대로: 앞 라인만 밀어 올리면 블록이 늘어난다).
 *  부호 판정에는 영향이 없다 — 양쪽 상대에서 부호가 갈리는지만 본다. */
export function groupIntensitySlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  return planSlope(homeId, awayId, { groupIntensity: GI_FWD }, { groupIntensity: GI_BACK }, n, seedBase)
}

/** 그룹 적극성 8편성의 승점 폭(지배 방지용). */
export function groupIntensitySpan(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const cands: GroupIntensity[] = [
    { attack: 0, midfield: 0, defense: 0 }, GI_FWD, GI_BACK,
    { attack: 1, midfield: 1, defense: 0 }, { attack: 1, midfield: -1, defense: 0 },
    { attack: 1, midfield: 0, defense: 0 }, { attack: 0, midfield: 0, defense: 1 },
    { attack: 1, midfield: 1, defense: 1 },
  ]
  const pts = cands.map(gi => planPoints(homeId, awayId, { groupIntensity: gi }, n, seedBase))
  return Math.max(...pts) - Math.min(...pts)
}

/** 공격 패턴 축의 기울기 — cross 빼기 through. 두 패턴은 상대 라인 높이에 대해 정확히
 *  반대 방향으로 반응하도록 배선돼 있으므로(tactics P3), 이 차이가 축의 부호다. */
export function attackPatternSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  return planSlope(homeId, awayId, { attackPattern: 'cross' }, { attackPattern: 'through' }, n, seedBase)
}

/** 공격 패턴 4종의 승점 폭. */
export function attackPatternSpan(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const pts = ATTACK_PATTERNS.map(p => planPoints(homeId, awayId, { attackPattern: p }, n, seedBase))
  return Math.max(...pts) - Math.min(...pts)
}

/** 세트피스 루트 축의 기울기 — near 빼기 far(박스 인원은 normal로 고정).
 *  판별자는 상대 GK 제공권이다(tactics P4). */
export function setPieceRouteSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  return planSlope(homeId, awayId,
    { setPiece: { route: 'near', boxLoad: 'normal' } },
    { setPiece: { route: 'far', boxLoad: 'normal' } }, n, seedBase)
}

/** 세트피스 인원 축의 기울기 — heavy 빼기 light(루트는 far로 고정).
 *  판별자는 매치업 우위다(역습이 열렸을 때 처벌받는가). */
export function setPieceLoadSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  return planSlope(homeId, awayId,
    { setPiece: { route: 'far', boxLoad: 'heavy' } },
    { setPiece: { route: 'far', boxLoad: 'light' } }, n, seedBase)
}

/** 세트피스 9종(루트 3 × 인원 3)의 승점 폭. */
export function setPieceSpan(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const pts: number[] = []
  for (const route of SET_PIECE_ROUTES) for (const boxLoad of BOX_LOADS)
    pts.push(planPoints(homeId, awayId, { setPiece: { route, boxLoad } }, n, seedBase))
  return Math.max(...pts) - Math.min(...pts)
}

/** 승점 최대 형태. 동점이면 목록 앞쪽(결정론). */
export function bestFormation(cells: { formation: FormationId; points: number }[]): FormationId {
  return cells.reduce((a, b) => (a.points >= b.points ? a : b)).formation
}

/** 추천 플랜을 "정반대"로 뒤집는다 — 감독의 나쁜 판단을 재현하는 표준 정의.
 *  추천이 **상대를 보고 정한 축 전부**를 반대로 읽는다. 일부만 뒤집으면 "거꾸로 읽었는데
 *  포메이션 상성과 공격 방향은 정확히 골랐다"는 혼종이 되고, 그 남은 정답들이 공짜 이득
 *  (실측 합계 3~5pp)으로 들어와 게이트가 "나쁜 판단인데 이득"을 통과시킨다.
 *   - 라인·압박: 100 − x (가둬야 할 상대에게 물러서고, 벗겨질 상대에게 달려든다)
 *   - 템포: 100 − x
 *   - 멘탈리티: 사다리의 반대 극단 (index 4 − i)
 *   - 그룹 적극성: 공격 라인과 수비 라인을 맞바꾼다
 *   - 공격 방향: 상대의 **가장 강한** 지역으로 몬다 (추천은 argmin, 여기선 argmax)
 *   - 포메이션: 추천 형태와 **무게중심(posture)이 정반대 극단**인 형태.
 *     추천이 앞쪽(posture>0)이면 5-4-1, 뒤쪽이면 3-5-2다. 멘탈리티를 사다리의 반대 극단으로
 *     보내는 것과 정확히 같은 조작이며, F1 이후 형태 축의 내용이 바로 그 무게중심이다.
 *     ⚠ 두 번의 오답을 거쳐 이 정의에 왔다.
 *       (1) formationEdge argmin — F1 이전의 유일한 판별자였다. 지금은 상성이 형태 효과의
 *           일부일 뿐이라, vs 아르헨티나에서 상성 argmin이 추천과 **같은 형태**로 나왔다
 *           (게이트 값 +0.3pp).
 *       (2) formationPlanScore argmin — 점수는 argmax(추천)에 맞춰 조정된 1차 근사라
 *           **하위 서열까지 맞지는 않는다**. vs 아르헨티나 실측 최하위는 3-5-2(1.202)인데
 *           점수는 4-4-2(1.278)를 골랐고, 그 0.076 승점이 게이트를 +0.9pp로 밀었다.
 *     무게중심 반대 극단은 11개 상대 중 **10개에서 실측 최하위와 일치**한다(예외는 전력이
 *     대등해 축이 평평한 노르웨이: 최하위 4-4-2 1.587 vs 5-4-1 1.619).
 *   - 페이즈 포메이션: 각 페이즈를 **무게중심 반대 극단**으로 (형태와 같은 조작)
 *   - 공격 패턴: cross ↔ through. P3 이전엔 "4종에 뚜렷한 반대 극이 없다"며 그대로 뒀지만,
 *     이제 두 패턴은 **같은 판별자(상대 라인 높이)의 정반대 부호**다 — 뒷공간이 있으면 침투,
 *     박스가 잠겨 있으면 크로스. 중거리는 크로스와 같은 쪽(낮은 블록)이라 through로 뒤집는다.
 *   - 세트피스: 루트 near ↔ far(GK 제공권을 거꾸로 읽는다), 인원 heavy ↔ light. */
export function invertPlan(plan: Partial<TacticState>, opp: Team): Partial<TacticState> {
  const out: Partial<TacticState> = { ...plan }
  if (plan.instructions) {
    const oppXI = pickBestXI(opp)
    const stamina: Record<string, number> = {}
    for (const p of opp.squad) stamina[p.id] = 100
    const flanks = flankStrength(oppXI.lineup, opp.squad, stamina)
    const strongest = (['left', 'right', 'center'] as const).reduce((a, b) => (flanks[a] >= flanks[b] ? a : b))
    out.instructions = {
      ...plan.instructions,
      lineHeight: 100 - plan.instructions.lineHeight,
      pressing: 100 - plan.instructions.pressing,
      tempo: 100 - plan.instructions.tempo,
      attackFocus: strongest,
    }
  }
  const mi = MENTALITIES.indexOf(plan.mentality ?? 'balanced')
  out.mentality = MENTALITIES[MENTALITIES.length - 1 - mi]
  if (plan.groupIntensity) {
    out.groupIntensity = { ...plan.groupIntensity, attack: plan.groupIntensity.defense, defense: plan.groupIntensity.attack }
  }
  if (plan.formation) out.formation = oppositePosture(plan.formation)
  if (plan.phaseFormations) {
    const pf = plan.phaseFormations
    out.phaseFormations = {
      ...(pf.attack ? { attack: oppositePosture(pf.attack) } : {}),
      ...(pf.defense ? { defense: oppositePosture(pf.defense) } : {}),
    }
  }
  if (plan.attackPattern) out.attackPattern = INVERT_PATTERN[plan.attackPattern]
  if (plan.setPiece) {
    out.setPiece = {
      ...plan.setPiece,
      ...(plan.setPiece.route ? { route: INVERT_ROUTE[plan.setPiece.route] } : {}),
      ...(plan.setPiece.boxLoad ? { boxLoad: INVERT_LOAD[plan.setPiece.boxLoad] } : {}),
    }
  }
  return out
}

/** 무게중심(posture)이 정반대 극단인 형태. */
function oppositePosture(f: FormationId): FormationId {
  const rec = FORMATION_POSTURE[f]
  return FORMATION_IDS.reduce((a, b) => {
    const pick = rec > 0 ? FORMATION_POSTURE[a] <= FORMATION_POSTURE[b] : FORMATION_POSTURE[a] >= FORMATION_POSTURE[b]
    return pick ? a : b
  })
}
const INVERT_PATTERN: Record<AttackPattern, AttackPattern> = {
  balanced: 'balanced', cross: 'through', longshot: 'through', through: 'cross',
}
const INVERT_ROUTE: Record<SetPieceRoute, SetPieceRoute> = { near: 'far', far: 'near', short: 'near' }
const INVERT_LOAD: Record<BoxLoad, BoxLoad> = { heavy: 'light', light: 'heavy', normal: 'normal' }

const FORMATION_IDS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

/** 승점 최대 셀의 축 값. 동점이면 낮은 값을 택한다(안정적 선택). */
export function bestAxisValue(cells: SweepCell[]): number {
  let best = cells[0]
  for (const c of cells) if (c.points > best.points) best = c
  return best.value
}

/** 기본 지시(50/50/50) vs 지정 플랜의 승률 차(퍼센트포인트). 유저 개입 레버리지 계측. */
export function runAbBatch(
  homeId: TeamId, awayId: TeamId, plan: Partial<TacticState>, n = 200,
): { base: number; plan: number; deltaPp: number } {
  const base = batch(homeId, awayId, {
    instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  }, n, 2000)
  const p = batch(homeId, awayId, plan, n, 2000)
  return {
    base: base.winRate,
    plan: p.winRate,
    deltaPp: Math.round((p.winRate - base.winRate) * 1000) / 10,
  }
}
