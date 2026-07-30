// src/game/scouting.ts
// 상대 프로필 기반 플랜 추천 — 순수·결정론. 엔진이 아니라 게임 로직 계층에 둔다
// (엔진은 시뮬레이션만 담당하고, "감독에게 무엇을 권할까"는 게임 규칙이기 때문).
// 추천은 정답이 아니라 출발점이다. UI는 반드시 "감독 판단으로 수정하십시오"를 함께 보여준다.
import type { FormationId, Instructions, Mentality, TacticState, Team } from '../engine/types'
import { FORMATION_POSTURE, MENTALITIES, formationEdge, formationEffects, trapFactor } from '../engine/tactics'
import { mapFormation } from '../engine/formations'
import { positionFitness } from '../engine/fitness'
import { pickBestXI } from '../engine/lineup'
import { STRENGTH_SENSITIVITY, counterRiskScale, effectiveAttack, effectiveDefense, flankStrength, weakestFlank, matchupEdge } from '../engine/simulate'
import { kickoffZones } from '../engine/strength'

export interface PlanRecommendation {
  patch: Partial<TacticState>
  /** 각 변경의 근거 1줄 — UI 툴팁·요약에 그대로 노출된다. 상대 수치를 문구에 박아
   *  "왜 이걸 권하는가"를 유저가 검증할 수 있게 한다. */
  reasons: { field: string; text: string }[]
}

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

/** 상대 선호 포메이션을 엔진 6종으로 매핑. 로더·pickBestXI와 같은 규칙(mapFormation)을 써야
 *  "상대가 실제로 들고 나오는 형태"와 추천 근거가 어긋나지 않는다. */
function oppFormation(opp: Team): FormationId {
  return mapFormation(opp.profile.preferredFormations[0] ?? '4-3-3')
}

const clampAxis = (v: number) => Math.min(100, Math.max(0, Math.round(v)))
const clampTo = (v: number, lo: number, hi: number) => clampAxis(Math.min(hi, Math.max(lo, v)))

/** 상대 GK의 빌드업 능력. 엔진(simulate의 matchupContext)이 실제로 보는 값과 어긋나면
 *  추천 근거가 거짓이 되므로, 상대 XI도 엔진과 같은 pickBestXI로 세워 그 GK를 읽는다.
 *  GK가 없으면 엔진과 같은 기본값 50. */
function oppGkBuildup(opp: Team): number {
  const gkSlot = pickBestXI(opp).lineup.find(l => l.slot === 'GK')
  const gk = gkSlot ? opp.squad.find(p => p.id === gkSlot.playerId) : undefined
  return gk?.gkStats?.buildup ?? 50
}

// ── 추천은 엔진 판별자에서 파생한다 (별도 규칙표 금지) ──────────────────────
// 엔진에서 하이라인·하이프레스의 **보상**(compress 항)은 정확히 trapFactor에 비례한다.
// 그래서 축은 그 판별자에서, 태세는 엔진이 태세 위험을 스케일할 때 쓰는 판별자
// (simulate.matchupEdge)에서 그대로 뽑는다 — 엔진 계수를 손봐도 조언이 자동으로 따라온다.
//
// 판(版) 이력:
//  1차(28bd711) 축=trap · 태세=FIFA 랭킹 격차. 두 규칙이 서로를 몰라 "수비적으로 가되 라인은
//    74까지"라는 문면 모순이 났고 토너먼트 상대엔 효과도 없었다(Δpp: arg +1.0 / fra +2.3).
//  2차 축·태세·그룹 적극성을 전부 trap 하나에서. 문면 모순은 사라졌지만, 그 전제는
//    "공격적 태세는 상대와 무관하게 이득"이라는 당시 엔진 상태였다.
//  3차(지금, E1 후속) 엔진이 태세 위험을 매치업 우위에 비례해 물리게 되면서 그 전제가 깨졌다.
//    축은 trap, 태세는 edge — 판별자 둘, 축 둘이다. 문면 모순은 캡이 아니라 근거 문구가
//    두 판별자를 모두 말하는 것으로 막는다(recommendPlan의 axisClause·postureClause).
//
// 검증하고 **기각한** 가설: "강팀에겐 스페인처럼 라인을 내려야 하는데 trap이 그걸 못 잡는다."
// 3차 엔진에서 다시 재본 라인 스윕도 같은 결론이다 — eng·fra는 태세가 최하단이어도
// 라인은 올릴수록 유리했다(coherentAxis를 걷어낸 근거, 아래 표 참고).

// 기울기 45: trap 상한 1.1에서 라인 99.5 ≈ 100.
// 근거는 라인 스윕(n=400, 압박 68·공격 라인 적극성 고정)이다. trap>0인 10팀 전부 라인은
// 올릴수록 단조 유리했고(구간 55→100), 그 **기울기가 trap에 비례**했다:
//   trap 0.58(eng) +3.7pp · 0.65(arg) +5.5 · 0.92(nor) +7.7 · 1.10(rsa) +8.8.
// 즉 "얼마나 올릴 가치가 있는가"가 trap에 비례하므로, trap 상한이 축 상한(100)에 정확히
// 닿도록 기울기를 맞춘다. trap 0이면 정확히 50(중립 지시)이다.
const K_AXIS = 45
// 하방 배수 1.5: 상방은 체력·파울 비용 때문에 압박 70 부근에서 꺾이지만, 압박·라인을
// **버리는** 선택엔 그런 비용이 없다(오히려 체력이 남는다). 그래서 벗겨지는 상대(trap<0)
// 에겐 지표가 시키는 만큼 끝까지 내린다. 실측 kor vs esp: 라인 20이 +18.0pp, 25가 +15.2pp.
const K_DOWN = 1.5
// 압박 상한 68: 70을 **넘지 않아야** 엔진의 하이라인×하이프레스 결합 페널티(둘 다 >70)와
// planRisks의 역습 경고(둘 다 ≥70)를 동시에 피한다 — 추천이 자기 리스크 카드와 모순되면
// 안 된다. 실측도 같은 방향이다(라인 90 고정, 압박 68→75: arg +3.3→−1.7 / fra +8.3→+5.7 /
// eng +3.5→0.0 / mar +6.0→+0.8).
const PRESS_MAX = 68
// 하한 20: 격자 실측의 하한이 20이라 그 아래는 검증되지 않았다. 검증 범위 밖으로 나가지 않는다.
const AXIS_MIN = 20
// ── 태세는 trap이 아니라 **매치업 우위**(edge)에서 뽑는다 (E1 후속) ──────────
// 2차 판(위 주석)은 축·태세·그룹 적극성을 전부 trap 하나에서 뽑았다. 그 전제는
// "공격적 태세는 상대와 무관하게 이득"이라는 당시 엔진 상태였고, E1 수정으로 그 전제가 깨졌다.
// 이제 공격 태세의 위험(counterVulnerability·concedeQuality)은 상대 공격진이 우리 수비보다
// 얼마나 강한가(engine matchupEdge)에 비례해 물린다.
//
// 실측(n=300, 추천 축 위에서 멘탈리티만 스윕한 최적값 · 기본 지시 대비 Δpp):
//   rsa edge 1.096 → 매우공격(+12.7)  cze 1.069 → 공격(+11.7)  ecu 1.054 → 공격(+7.7)
//   can 1.049 → 매우공격(+16.3)  mex 1.045 → 매우공격(+8.0)   mar 1.021 → 공격(+10.0)
//   nor 0.997 → 균형(+12.0)      esp 0.956 → 균형(+17.3)      arg 0.955 → 매우수비(+8.0)
//   eng 0.927 → 매우수비(+12.3)  fra 0.898 → 매우수비(+16.7)
// trap으로는 이 서열을 만들 수 없다 — eng·arg·fra는 trap 0.58~0.65(가둘 수 있는 상대)인데
// 최적 태세는 최하단이다.
// 계수 25: 위 11점의 최소제곱 기울기는 23.3이지만, 사다리는 반올림 계단이라 기울기 자체보다
// **계단 경계가 실측 argmax와 맞는지**가 중요하다. 정수 후보를 실측과 대조하면 25가 가장 적게
// 어긋난다(23이면 mar·esp가 한 칸씩 더 어긋나 6곳, 25면 4곳이며 전부 한 칸 차이다).
const K_MENTALITY_EDGE = 25
/** trap → 목표 (라인, 압박). **킥오프 추천과 경기 중 코치 조언이 같은 축을 말해야** 하므로
 *  공식을 여기 한 벌만 두고 game/coach.ts가 재사용한다(엔진 compress와 같은 판별자에서 파생). */
export function trapAxis(trap: number): { lineHeight: number; pressing: number } {
  const axis = 50 + trap * K_AXIS * (trap < 0 ? K_DOWN : 1)
  return { lineHeight: clampTo(axis, AXIS_MIN, 100), pressing: clampTo(axis, AXIS_MIN, PRESS_MAX) }
}

// ── "높은 라인 + 수비적 태세"는 모순이 아니다 (실측으로 확인) ─────────────────
// 이전 판은 태세가 수비적이면 라인을 60에서 잘라(캡) 문면 모순을 막으려 했다.
// 실측이 그 캡을 기각했다 — 추천 플랜의 라인·압박만 스윕한 결과(n=600, Δpp 대 기본 지시):
//   eng(매우 수비적): 라인 20 +3.0 · 40 +9.3 · 60 +11.3 · 70 +14.8 · 80 +15.2
//   fra(매우 수비적): 라인 20 +8.3 · 40 +15.3 · 60 +18.2 · 70 +20.3 · 80 +21.2
//   arg(수비적):      라인 20 +0.8 · 40 +4.2  · 60 +1.7  · 70 +4.3  · 80 +5.7
// 즉 잉글랜드·프랑스 상대의 최적은 **라인을 끝까지 올리고 태세는 최하단**이다.
// 축과 태세는 서로 다른 것을 재기 때문이다:
//   축(trap)  — 상대가 후방에서 볼을 빼낼 수 있는가 → 나가서 끊을 값이 있는가
//   태세(edge) — 볼을 잃었을 때 상대가 처벌할 수 있는가 → 얼마나 걸고 나갈 것인가
// 전방에서 압박해 끊되 잡았을 때 무리하지 않는 것은 실제 축구의 표준 처방이다.
// 캡을 씌우면 그 처방을 표현할 수 없어 eng·fra에서 4~5pp를 버린다.
// 대신 **근거 문구가 두 판별자를 모두 말하도록** 강제한다(아래 postureClause·axisClause).

/** 매치업 우위 → 태세 사다리 index(0~4). MENTALITIES는 [매우 수비적 … 매우 공격적]이고 중립은 2다. */
export function edgeMentalityIndex(edge: number): number {
  return Math.min(4, Math.max(0, Math.round(2 + (edge - 1) * K_MENTALITY_EDGE)))
}

/** 매치업 우위 → 태세. */
export function edgeMentality(edge: number): Mentality {
  return MENTALITIES[edgeMentalityIndex(edge)]
}

/** 두 팀의 킥오프 매치업 우위(엔진 판별자 그대로). */
export function planEdge(me: Team, opp: Team): number {
  return matchupEdge(kickoffZones(me), kickoffZones(opp))
}

// ── 포메이션 추천 점수 (F1 후속) ───────────────────────────────────
// 형태는 승점에 **두 갈래**로 작용하고, 추천은 둘을 다 봐야 한다.
//  (1) 구조 — 그 형태로 XI를 세웠을 때의 실효 공격·수비 전력. F0(존 인원수)·F2(미드필드
//      혼합) 이후 형태마다 실제로 달라진다. 엔진의 찬스 확률이 (atk/def)^STRENGTH_SENSITIVITY
//      이므로 로그를 취하면 그대로 가산 항이 된다.
//  (2) xG — engine tactics.formationEffects의 상성·태세 항.
// 이전 판은 (2)만 봤고, 그 점수는 posture에 대해 단조라 **항상 양 끝(3-5-2/5-4-1)만 골랐다**.
// 실측 argmax는 중간(4-3-3 / 4-1-4-1)이다 — 양 끝은 구조적 대가(3-5-2 수비 −9.5%,
// 5-4-1·4-4-2 미드 −13.2%)를 치르기 때문이다. 그 대가를 모르는 점수는 틀린 형태를 권한다.
//
// W_CONCEDE 0.50: 실점 항의 승점 무게(engine F1 주석 (a) 실측 0.49~0.79)에서 온 값이고,
// 이 값에서 **11개 상대 전부 실측 argmax와 정확히 일치**한다(n=3200 스윕):
//   4-3-3 ← rsa·cze·mex·ecu·can·mar   4-1-4-1 ← eng·nor·arg·esp·fra
// 손익분기 risk는 약 0.98이고, 실측 경계도 mar(0.81, 전진)와 nor(1.03, 후진) 사이다.
const W_CONCEDE = 0.50

/** 형태 f의 상대적 가치(단위 없음, 6종 간 서열만 쓴다). 전부 엔진 판별자에서 파생한다. */
export function formationPlanScore(me: Team, oppForm: FormationId, risk: number, f: FormationId): number {
  const z = kickoffZones(me, f)
  const fx = formationEffects(f, oppForm, risk)
  const gain = STRENGTH_SENSITIVITY * Math.log(effectiveAttack(z)) + Math.log(fx.chanceQuality)
  const cost = -STRENGTH_SENSITIVITY * Math.log(effectiveDefense(z)) + Math.log(fx.concedeQuality)
  return gain - W_CONCEDE * cost
}

const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}
// attackFocus 근거 문구용. 좌우가 뒤집힌다 — 우리가 왼쪽으로 몰면 상대의 **오른쪽** 수비를 만난다
// (엔진 flankStrength의 정의와 동일). 문구에서 이걸 틀리면 근거가 거짓이 된다.
const FOCUS_KO: Record<'left' | 'right' | 'center', { ours: string; theirs: string }> = {
  left: { ours: '왼쪽', theirs: '오른쪽 수비' },
  right: { ours: '오른쪽', theirs: '왼쪽 수비' },
  center: { ours: '중앙', theirs: '중앙 수비' },
}

export function recommendPlan(me: Team, opp: Team): PlanRecommendation {
  const s = opp.profile.style
  const reasons: { field: string; text: string }[] = []
  // 출발점은 우리 팀 프로필 스타일 — 감독의 색을 지우지 않고 상대에 맞춰 보정한다.
  // 다만 라인·압박은 아래에서 상대 전개 지표로 완전히 덮어쓴다(우리 프로필이 아니라 상대가
  // 정하는 축이다). 우리 색이 남는 축은 템포다.
  const ins: Instructions = {
    lineHeight: me.profile.style.lineHeight,
    pressing: me.profile.style.pressing,
    tempo: me.profile.style.tempo,
    attackFocus: 'balanced',
  }
  const patch: Partial<TacticState> = {}

  // 판별자는 둘이다. 서로 다른 것을 재고 서로 다른 축을 정한다.
  //  (1) trap — 상대의 후방 전개 능력. "가둘 수 있는가"를 재고 **라인·압박**을 정한다.
  //  (2) edge — 매치업 우위. "볼을 잃었을 때 처벌받는가"를 재고 **태세**를 정한다.
  // 둘을 하나로 묶었던 이전 판이 틀렸다는 것은 실측이 보였다(edgeMentalityIndex 주석 참고):
  // 잉글랜드·아르헨티나·프랑스는 trap이 높은데(가둘 수 있다) 최적 태세는 최하단이다.
  const gkBuildup = oppGkBuildup(opp)
  const buildupIndex = Math.round((gkBuildup + s.possession) / 2)
  const trap = trapFactor({ oppGkBuildup: gkBuildup, oppPossession: s.possession })
  const myZones = kickoffZones(me), oppZones = kickoffZones(opp)
  const edge = matchupEdge(myZones, oppZones)
  // 라인과 압박은 같은 값에서 나온다(엔진의 compress도 두 축을 하나의 trap으로 묶는다).
  // 갈리는 건 상한뿐이다 — 압박에만 체력·파울 비용이 걸려 68에서 멈춘다.
  const mentalityIndex = edgeMentalityIndex(edge)
  const targetAxis = trapAxis(trap)
  ins.lineHeight = targetAxis.lineHeight
  ins.pressing = targetAxis.pressing
  const mentality = MENTALITIES[mentalityIndex]
  patch.mentality = mentality
  // 그룹 적극성은 태세를 따른다 — 나갈 땐 공격 라인을, 물러설 땐 수비 라인을 끌어올린다.
  // E3 수정 이후 이 선택은 공짜가 아니다: 한 라인을 올리면 그 뒤 라인이 얇아진다
  // (engine tactics.GI_ZONE_FX). 그래서 태세와 같은 방향일 때만 값이 있다.
  // 이전 판의 "상대 압박 ≥65면 midfield+1"은 실측에서 오히려 손해라 제거했다
  // (지정 없음 대비 arg −3.6 / mar −3.8pp).
  patch.groupIntensity = mentalityIndex >= 3
    ? { attack: 1, midfield: 0, defense: 0 }
    : mentalityIndex <= 1
      ? { attack: 0, midfield: 0, defense: 1 }
      : { attack: 0, midfield: 0, defense: 0 }

  // 축과 태세를 한 문장 안에서 말하되, **각자의 근거 수치를 붙여** 말한다.
  // 축은 전개 지표에서, 태세는 매치업 지수에서 나온다 — 유저가 둘을 따로 검증할 수 있어야 한다.
  const indexText = `상대 후방 전개 지표 ${buildupIndex} (GK 빌드업 ${gkBuildup} · 점유 성향 ${s.possession})`
  const axisText = `라인 ${ins.lineHeight} · 압박 ${ins.pressing}`
  // 조사는 숫자 읽기에 따라 '로/으로'가 갈리므로 '까지'로 통일한다(85→팔십오'로', 86→팔십육'으로').
  const axisClause = trap >= 0.25
    ? `기준 72보다 낮아 전방에서 가둘 수 있습니다. ${axisText}까지 올립니다`
    : trap <= -0.25
      ? `기준 72를 넘어 압박이 벗겨집니다. ${axisText}까지 내려 블록을 세웁니다`
      : `기준 72와 비슷해 어느 쪽도 크게 통하지 않습니다. ${axisText}의 중간 강도로 형태를 고정합니다`
  const edgeText = `매치업 지수 ${edge.toFixed(2)} (우리 공격 ${myZones.attack.toFixed(0)}·수비 ${myZones.defense.toFixed(0)} vs 상대 공격 ${oppZones.attack.toFixed(0)}·수비 ${oppZones.defense.toFixed(0)})`
  const postureClause = mentalityIndex >= 3
    ? `${edgeText} — 우리가 우위라 ${MENTALITY_KO[mentality]} 태세로 나섭니다`
    : mentalityIndex <= 1
      ? `${edgeText} — 상대 공격진이 우리 수비보다 강해 볼을 잃었을 때 처벌이 큽니다. ${MENTALITY_KO[mentality]} 태세로 무리하지 않습니다`
      : `${edgeText} — 전력이 대등해 ${MENTALITY_KO[mentality]} 태세로 균형을 잡습니다`
  reasons.push({ field: 'lineHeight', text: `${indexText} — ${axisClause}. ${postureClause}` })

  if (s.possession >= 70) {
    // 태세는 이미 위에서 정해졌다(점유 78인 스페인은 trap −0.46 → 수비적 · 라인 20).
    // 여기서 멘탈리티나 라인을 다시 건드리면 레버가 둘로 갈라져 문면 모순이 되살아나므로
    // 이 분기는 **공격 방식**만 정한다. 물러선 블록의 보상은 엔진의 counterGain
    // (라인<40 && 템포>60, 상대 점유에 비례)이고, 중앙 침투가 그 전환을 받는다.
    patch.attackPattern = 'through'
    reasons.push({ field: 'attackPattern', text: `상대 점유 성향 ${s.possession} — 회수 후 중앙 침투로 전환을 노립니다` })
  }
  if (s.lineHeight >= 62) {
    patch.attackPattern = 'through'
    ins.tempo = clampAxis(ins.tempo + 15)
    reasons.push({ field: 'tempo', text: `상대 라인 높이 ${s.lineHeight} — 뒷공간 침투가 유효합니다` })
  }
  if (s.pressing >= 65) {
    ins.tempo = clampAxis(ins.tempo + 10)
    reasons.push({ field: 'pressing', text: `상대 압박 ${s.pressing} — 빠른 전개로 압박을 벗깁니다` })
  }

  // 공격 방향: 상대의 가장 약한 측면. 엔진 판별자(flankStrength)를 그대로 쓰고 argmin을 고른다 —
  // attackFocusEffects의 edge가 (평균 − 대상)에 비례하므로 argmin이면 보상이 음수가 될 수 없다.
  // 상대 XI는 여기서도 엔진과 같은 pickBestXI로 세우고 체력은 킥오프 값(100)으로 본다.
  // 실측 이득(n=1200, 균형 대비): arg +1.3 / fra +0.8 / eng +0.4 / mar +0.5pp — 작지만 공짜다.
  const oppXI = pickBestXI(opp)
  const oppStamina: Record<string, number> = {}
  for (const p of opp.squad) oppStamina[p.id] = 100
  const flanks = flankStrength(oppXI.lineup, opp.squad, oppStamina)
  const focus = weakestFlank(flanks)
  ins.attackFocus = focus
  const flankAvg = (flanks.left + flanks.right + flanks.center) / 3
  reasons.push({
    field: 'attackFocus',
    // 세 후보(왼쪽·오른쪽·중앙) 모두 받침으로 끝나므로 조사는 '으로'로 고정해도 안전하다.
    text: `상대 ${FOCUS_KO[focus].theirs} ${flanks[focus].toFixed(0)} (3개 지역 평균 ${flankAvg.toFixed(0)}) — 우리 ${FOCUS_KO[focus].ours}으로 공격을 몹니다`,
  })

  // FIFA 랭킹 격차는 **참고 정보로만** 남긴다(patch를 건드리지 않는다).
  // 숫자가 작을수록 강팀이므로 (내 랭킹 − 상대 랭킹)이 클수록 우리가 약체다.
  // 이 값으로 태세를 정하면 위의 trap 파생 태세와 충돌하고, 실측상 승률도 떨어진다.
  const gap = me.fifaRanking - opp.fifaRanking
  if (gap >= 15) {
    // 문구가 태세를 지시하면 안 된다 — 스페인(블록)과 아르헨티나(하이라인)가 같은 이 문장을
    // 받는데, "물러서라"거나 "나가라"고 쓰면 둘 중 하나에서 반드시 추천과 어긋난다.
    // 태세를 정하는 건 trap(후방 전개)이 아니라 edge(매치업 우위)다 — 문구가 실제 배선과
    // 어긋나면 유저가 근거를 검증할 수 없다.
    reasons.push({ field: 'note', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 전력차가 큽니다. 태세는 랭킹이 아니라 실제 스쿼드 매치업 지수에 맞춥니다` })
  } else if (gap <= -15) {
    reasons.push({ field: 'note', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 주도권을 잡을 수 있는 매치업입니다` })
  }

  // ── 포메이션: 축·태세와 같은 방식으로 **엔진 판별자 둘**에서 파생한다 (F1) ──────────
  // 이전 판은 formationEdge argmax 하나였다. 그때는 그것이 유일한 후보였지만, 실측에서
  // formationEdge는 승점에 0.01 미만밖에 기여하지 않는 장식이었고(engine/tactics F1 주석),
  // 지금은 형태가 **상성(상대 형태) + 태세(상대 전력)** 두 항으로 실제 승점을 움직인다.
  // 추천도 그 두 항을 그대로 읽어야 한다 — 상성만 보면 프랑스 상대에 4-3-3(상성 0·태세 +0.45)
  // 같은 자살 형태를 권하게 된다(실측 vs fra: 4-3-3 0.766 vs 5-4-1 1.242 승점).
  // 판별자는 새로 만들지 않는다. 엔진이 실점 항을 스케일할 때 쓰는 counterRiskScale에
  // 킥오프 존을 그대로 넣어 계산한다(태세 추천이 쓰는 matchupEdge와 같은 뿌리다).
  const of = oppFormation(opp)
  const formationRisk = counterRiskScale(myZones, oppZones)
  let best = FORMATIONS[0], bestScore = -Infinity
  for (const f of FORMATIONS) {
    const sc = formationPlanScore(me, of, formationRisk, f)
    if (sc > bestScore) { bestScore = sc; best = f }
  }
  const bestEdge = formationEdge(best, of)
  //
  // **XI 실현 가능성으로 포메이션을 재고(veto)하지 않는 이유** (2026-07-30, 풀백-ST 버그 수정 중 검토):
  // "3-5-2를 권했는데 세울 ST가 없다"는 사고는 실제로 났었다. 그러나 원인은 포메이션 선택이
  // 아니라 XI 배치기였다 — 배치기가 현재 선발을 적합도보다 우선해 남아도는 풀백을 ST에 꽂았다
  // (ui/lineup/swap.autoFill 참고). 12팀 × 6포메이션 전수 실측에서 스쿼드로 세울 수 없는
  // 조합은 0건이고(최소 적합도 0.85 = 대체 포지션), 수리 후 kor는 11개 상대 전부 전 슬롯 1.00이다.
  // 즉 veto 분기는 영원히 실행되지 않는 죽은 가지이면서, 이 함수의 설계 원칙("축 하나에
  // 판별자 하나, 전부 엔진 판별자에서 파생")에 세 번째 숨은 기준을 끼워 넣는다.
  // 전제가 깨지면 테스트가 먼저 터지게 해 뒀다(scouting.test.ts '[추천 적용] 결과 XI').
  patch.formation = best
  // 근거 문구도 두 판별자를 모두 말한다(축·태세 문구와 같은 규칙). 형태 하나만 말하면
  // "상성 우위가 없는데 왜 5-4-1인가"를 유저가 검증할 수 없다.
  const shapeClause = bestEdge > 0
    ? `상대 ${of}에 상성 우위(+${bestEdge.toFixed(2)})`
    : bestEdge < 0
      ? `상대 ${of}에는 상성이 불리하지만(${bestEdge.toFixed(2)})`
      : `상대 ${of}와 상성은 대등하지만`
  // 무게중심은 **고른 형태의 posture 부호**로 설명한다. 임계값을 문구에 따로 박으면
  // 상성 항이 태세 항을 이기는 경우(예: 멕시코 risk 0.64인데 상성 +0.04로 3-5-2)에
  // 문면과 추천이 어긋난다 — 결과를 그대로 말하는 편이 항상 참이다.
  const posture = FORMATION_POSTURE[best]
  const shapeRiskClause = posture > 0
    ? `볼을 잃었을 때의 처벌이 감당할 만해 앞에 사람을 더 둡니다(역습 위험 지수 ${formationRisk.toFixed(2)})`
    : posture < 0
      ? `볼을 잃었을 때의 처벌이 커 뒤에 사람을 더 둡니다(역습 위험 지수 ${formationRisk.toFixed(2)})`
      : `앞뒤 균형을 맞춥니다(역습 위험 지수 ${formationRisk.toFixed(2)})`
  reasons.push({
    field: 'formation',
    text: `${best} — ${shapeClause} — ${shapeRiskClause}`,
  })

  if (opp.profile.benchPattern === 'protect-lead') {
    reasons.push({ field: 'note', text: '상대는 리드하면 내려앉습니다 — 선제골이 특히 중요합니다' })
  } else if (opp.profile.benchPattern === 'chase-attack') {
    reasons.push({ field: 'note', text: '상대는 지면 공격 카드를 씁니다 — 후반 역습 대비가 필요합니다' })
  }

  patch.instructions = ins
  return { patch, reasons }
}

export interface PlanRisk { level: 'warn' | 'ok'; text: string }

/** 킥오프 전 검토 요약의 리스크 카드. 경고가 없으면 ok 항목만 돌려준다.
 *  positionFitness는 0~1 스케일이다(1.0 정포지션 / 0.85 대체 / 0.65 인접 / 0.4 무관 / 0.2 GK 오배치). */
export function planRisks(me: Team, tactics: TacticState, stamina: Record<string, number>): PlanRisk[] {
  const out: PlanRisk[] = []
  for (const l of tactics.lineup) {
    const p = me.squad.find(q => q.id === l.playerId)
    if (!p) continue
    const st = stamina[l.playerId] ?? 100
    if (st < 65) out.push({ level: 'warn', text: `${p.name.ko} 시작 체력 ${Math.round(st)}` })
    if (positionFitness(p, l.slot) < 0.7) out.push({ level: 'warn', text: `${p.name.ko} ${l.slot} 적합도 낮음` })
  }
  const ins = tactics.instructions
  if (ins.lineHeight >= 70 && ins.pressing >= 70) {
    out.push({ level: 'warn', text: '하이라인 + 하이프레스 — 역습 취약성이 크게 증가합니다' })
  }
  if (out.length === 0) out.push({ level: 'ok', text: '검토 완료 — 특이사항 없음' })
  return out
}
