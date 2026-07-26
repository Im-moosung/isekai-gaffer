// src/game/scouting.ts
// 상대 프로필 기반 플랜 추천 — 순수·결정론. 엔진이 아니라 게임 로직 계층에 둔다
// (엔진은 시뮬레이션만 담당하고, "감독에게 무엇을 권할까"는 게임 규칙이기 때문).
// 추천은 정답이 아니라 출발점이다. UI는 반드시 "감독 판단으로 수정하십시오"를 함께 보여준다.
import type { FormationId, Instructions, Mentality, TacticState, Team } from '../engine/types'
import { MENTALITIES, formationEdge, trapFactor } from '../engine/tactics'
import { mapFormation } from '../engine/formations'
import { positionFitness } from '../engine/fitness'
import { pickBestXI } from '../engine/lineup'
import { flankStrength, weakestFlank } from '../engine/simulate'

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

// ── 태세를 엔진 판별자 하나에서 통째로 파생 (Phase A 보정 2차) ──────────────
// 엔진에서 하이라인·하이프레스의 **보상**(compress 항)은 정확히 trapFactor에 비례한다.
// 그래서 추천도 별도 규칙표를 만들지 않고 같은 판별자에서 목표치를 뽑는다 —
// 나중에 엔진의 기준(72)이나 폭(13)을 손봐도 조언이 자동으로 따라온다.
//
// 1차(28bd711)는 **축만** trap에서 뽑고 멘탈리티는 FIFA 랭킹 격차에서 따로 뽑았다.
// 두 규칙이 서로를 몰라서 "수비적 태세로 가되 라인을 74까지 올리십시오"라는 문면 모순이
// 났고, 정작 토너먼트 상대에겐 효과도 없었다(n=400 실측 Δpp: arg +1.0 / mar +1.5 /
// fra +2.3 / eng +3.3 — 조별 상대의 +3.7~+9.8과 비교하면 사실상 무효).
//
// 2차인 지금은 **축·멘탈리티·그룹 적극성을 모두 trap 하나에서** 뽑는다. 레버가 하나뿐이라
// 문면 모순이 구조적으로 불가능해진다(아래 사다리 주석의 구간 증명 참고).
//
// 검증하고 **기각한** 가설: "강팀에겐 스페인처럼 라인을 내려야 하는데 trap이 그걸 못 잡는다."
// 실측(n=400, 라인·압박을 25/25로 내리고 수비적)은 전부 더 나빴다 —
// arg −1.2 / fra −0.3 / eng +0.8 / mar −5.0. 아르헨티나·프랑스 상대로도 **올리는 쪽**이
// 맞았고, 틀린 것은 축이 아니라 멘탈리티 규칙이었다.

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
// 태세 사다리 기울기 2 = trap 0.5마다 한 칸. K_AXIS와 맞물려 한 칸이 축 22.5의 이동에 대응한다.
// MENTALITIES(엔진 정본)는 [매우 수비적, 수비적, 균형, 공격적, 매우 공격적]이고 중립은 index 2다.
//
// **이 한 줄이 문면 일관성을 구조적으로 보장한다.** trap이 clamp(−0.5, 1.1)이므로:
//   defensive(1)      ⟺ trap ∈ [−0.50, −0.25) ⟹ 라인 = 50 + trap·45·1.5 ∈ [20, 33]  (≤ 60 ✓)
//   balanced(2)       ⟺ trap ∈ [−0.25,  0.25) ⟹ 라인 ∈ [33, 61]                      (제약 없음)
//   attacking(3)      ⟺ trap ∈ [ 0.25,  0.75) ⟹ 라인 = 50 + trap·45 ∈ [61, 84]      (≥ 40 ✓)
//   very-attacking(4) ⟺ trap ≥ 0.75           ⟹ 라인 ≥ 84                            (≥ 40 ✓)
// very-defensive(0)는 trap ≤ −0.75가 필요해 도달 불가다 — 현재 데이터의 최강 전개팀
// (스페인 78)조차 블록만 세우면 충분했다(라인 20 실측: 수비적 +18.0 / 매우 수비적 +16.7).
const K_MENTALITY = 2

/** trap → 목표 (라인, 압박). **킥오프 추천과 경기 중 코치 조언이 같은 축을 말해야** 하므로
 *  공식을 여기 한 벌만 두고 game/coach.ts가 재사용한다(엔진 compress와 같은 판별자에서 파생). */
export function trapAxis(trap: number): { lineHeight: number; pressing: number } {
  const axis = 50 + trap * K_AXIS * (trap < 0 ? K_DOWN : 1)
  return { lineHeight: clampTo(axis, AXIS_MIN, 100), pressing: clampTo(axis, AXIS_MIN, PRESS_MAX) }
}

/** trap → 태세. 축과 같은 사다리에서 뽑아야 "수비적으로 가되 라인은 올려라"가 구조적으로 불가능하다. */
export function trapMentality(trap: number): Mentality {
  return MENTALITIES[Math.min(4, Math.max(0, 2 + Math.round(trap * K_MENTALITY)))]
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

  // 상대의 후방 전개 능력(GK 빌드업 · 점유 성향의 평균)이 태세 전체의 유일한 구동자다.
  const gkBuildup = oppGkBuildup(opp)
  const buildupIndex = Math.round((gkBuildup + s.possession) / 2)
  const trap = trapFactor({ oppGkBuildup: gkBuildup, oppPossession: s.possession })
  // 라인과 압박은 같은 값에서 나온다(엔진의 compress도 두 축을 하나의 trap으로 묶는다).
  // 갈리는 건 상한뿐이다 — 압박에만 체력·파울 비용이 걸려 68에서 멈춘다.
  const targetAxis = trapAxis(trap)
  ins.lineHeight = targetAxis.lineHeight
  ins.pressing = targetAxis.pressing
  // 멘탈리티도 같은 사다리에서 뽑는다. 이전 판의 FIFA 랭킹 규칙(격차 ≥15 → 수비적)은
  // 실측으로 기각했다: trap 파생 라인에서 수비적은 공격적보다 항상 나빴다
  // (n=400 — fra 공격적 +10.2 vs 수비적 +1.0 / eng +6.3 vs +1.5 / mar +7.5 vs +0.8).
  const mentalityIndex = Math.min(4, Math.max(0, 2 + Math.round(trap * K_MENTALITY)))
  const mentality = trapMentality(trap) // === MENTALITIES[mentalityIndex] — 사다리 정의는 한 곳(trapMentality)뿐이다.
  patch.mentality = mentality
  // 그룹 적극성도 같은 태세를 따른다 — 나갈 땐 공격 라인을, 물러설 땐 수비 라인을 끌어올린다.
  // 실측(n=400, trap 파생 라인 · 지정 없음 대비): 공격 태세의 attack+1은 arg +4.0 / fra +5.0 /
  // eng +3.0 / mex +3.8pp. 스페인(블록)의 defense+1은 +3.0pp.
  // 이전 판의 "상대 압박 ≥65면 midfield+1"은 실측에서 오히려 손해라 제거했다
  // (지정 없음 대비 arg −3.6 / mar −3.8pp).
  patch.groupIntensity = mentalityIndex >= 3
    ? { attack: 1, midfield: 0, defense: 0 }
    : mentalityIndex <= 1
      ? { attack: 0, midfield: 0, defense: 1 }
      : { attack: 0, midfield: 0, defense: 0 }

  // 축과 태세를 **한 문장 안에서** 함께 말한다. 둘이 같은 trap에서 나오므로 서로를 배신할 수 없다.
  const indexText = `상대 후방 전개 지표 ${buildupIndex} (GK 빌드업 ${gkBuildup} · 점유 성향 ${s.possession})`
  const axisText = `라인 ${ins.lineHeight} · 압박 ${ins.pressing}`
  reasons.push({
    field: 'lineHeight',
    // 조사는 숫자 읽기에 따라 '로/으로'가 갈리므로 '까지'로 통일한다(85→팔십오'로', 86→팔십육'으로').
    text: mentalityIndex >= 3
      ? `${indexText} — 기준 72보다 낮아 전방에서 가둘 수 있습니다. ${axisText}까지 올리고 ${MENTALITY_KO[mentality]} 태세로 나섭니다`
      : mentalityIndex <= 1
        ? `${indexText} — 기준 72를 넘어 압박이 벗겨집니다. ${axisText}까지 내려 ${MENTALITY_KO[mentality]} 태세로 블록을 세웁니다`
        : `${indexText} — 기준 72와 비슷해 어느 쪽도 크게 통하지 않습니다. ${axisText}의 중간 강도에 ${MENTALITY_KO[mentality]} 태세를 권합니다`,
  })

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
    reasons.push({ field: 'note', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 전력차가 큽니다. 태세는 랭킹이 아니라 상대의 후방 전개 지표에 맞춥니다` })
  } else if (gap <= -15) {
    reasons.push({ field: 'note', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 주도권을 잡을 수 있는 매치업입니다` })
  }

  // 포메이션: 상대 포메이션 대비 상성 최댓값. 동점이면 목록 앞쪽(=결정론).
  const of = oppFormation(opp)
  let best = FORMATIONS[0], bestEdge = -Infinity
  for (const f of FORMATIONS) {
    const e = formationEdge(f, of)
    if (e > bestEdge) { bestEdge = e; best = f }
  }
  // 우위가 없어도(최댓값 ≤ 0) argmax는 제시한다 — "고를 수 있는 최선"이 곧 추천이다.
  patch.formation = best
  reasons.push({
    field: 'formation',
    text: bestEdge > 0
      ? `${best}가 상대 ${of}에 상성 우위(+${bestEdge.toFixed(2)})`
      : `상대 ${of}에 상성 우위를 가진 형태가 없어 ${best}로 맞섭니다`,
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
