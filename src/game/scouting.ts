// src/game/scouting.ts
// 상대 프로필 기반 플랜 추천 — 순수·결정론. 엔진이 아니라 게임 로직 계층에 둔다
// (엔진은 시뮬레이션만 담당하고, "감독에게 무엇을 권할까"는 게임 규칙이기 때문).
// 추천은 정답이 아니라 출발점이다. UI는 반드시 "감독 판단으로 수정하십시오"를 함께 보여준다.
import type { FormationId, Instructions, TacticState, Team } from '../engine/types'
import { formationEdge, trapFactor } from '../engine/tactics'
import { mapFormation } from '../engine/formations'
import { positionFitness } from '../engine/fitness'
import { pickBestXI } from '../engine/lineup'

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

// ── 라인·압박 목표를 엔진 판별자에서 파생 (Phase A 보정) ──────────────────
// 엔진에서 하이라인·하이프레스의 **보상**(compress 항)은 정확히 trapFactor에 비례한다.
// 그래서 추천도 별도 규칙표를 만들지 않고 같은 판별자에서 목표치를 뽑는다 —
// 나중에 엔진의 기준(72)이나 폭(13)을 손봐도 조언이 자동으로 따라온다.
//
// 기울기 36: trap 상한 1.1에서 라인 89.6 ≈ 90. 실측(kor vs rsa/cze)에서 라인은
// 올릴수록 단조 유리했고 90이 최적이었다. trap 0이면 정확히 50(중립 지시)이다.
const K_AXIS = 36
// 하방 배수 1.5: 상방은 체력·파울 비용 때문에 압박 70 부근에서 꺾이지만, 압박·라인을
// **버리는** 선택엔 그런 비용이 없다(오히려 체력이 남는다). 그래서 벗겨지는 상대(trap<0)
// 에겐 지표가 시키는 만큼 끝까지 내린다. 실측 kor vs esp: 22/22가 +13.5pp, 32/32가 +8.2pp.
const K_DOWN = 1.5
// 압박 상한 68: 실측 정점이 70 부근이고(90은 체력·파울로 다시 하락), 70을 **넘지 않아야**
// 엔진의 하이라인×하이프레스 결합 페널티(둘 다 >70)와 planRisks의 역습 경고(둘 다 ≥70)를
// 동시에 피한다 — 추천이 자기 리스크 카드와 모순되면 안 된다.
const PRESS_MAX = 68
// 하한 20: 격자 실측의 하한이 20이라 그 아래는 검증되지 않았다. 검증 범위 밖으로 나가지 않는다.
const AXIS_MIN = 20

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

  // 상대의 후방 전개 능력(GK 빌드업 · 점유 성향의 평균)이 라인·압박의 유일한 구동자다.
  const gkBuildup = oppGkBuildup(opp)
  const buildupIndex = Math.round((gkBuildup + s.possession) / 2)
  const trap = trapFactor({ oppGkBuildup: gkBuildup, oppPossession: s.possession })
  // 라인과 압박은 같은 값에서 나온다(엔진의 compress도 두 축을 하나의 trap으로 묶는다).
  // 갈리는 건 상한뿐이다 — 압박에만 체력·파울 비용이 걸려 68에서 멈춘다.
  const axis = 50 + trap * K_AXIS * (trap < 0 ? K_DOWN : 1)
  ins.lineHeight = clampTo(axis, AXIS_MIN, 100)
  ins.pressing = clampTo(axis, AXIS_MIN, PRESS_MAX)
  // 아래 랭킹 규칙은 멘탈리티만 정하고 이 두 축은 건드리지 않는다. 수비적 멘탈리티에 맞춰
  // 축을 중립 쪽으로 절반 되돌려 봤지만 실측은 전부 손해였다(n=600, 기본 대비 Δpp):
  // eng +2.0→+0.8 / arg +1.3→−0.3 / mar +0.2→−1.3 / fra +2.5→+0.5.
  // 태세는 멘탈리티로, 라인·압박은 전개 지표로 — 두 레버는 독립이다.

  const indexText = `상대 후방 전개 지표 ${buildupIndex} (GK 빌드업 ${gkBuildup} · 점유 성향 ${s.possession})`
  reasons.push({
    field: 'lineHeight',
    // 조사는 숫자 읽기에 따라 '로/으로'가 갈리므로 '까지'로 통일한다(85→팔십오'로', 86→팔십육'으로').
    text: trap >= 0.35
      ? `${indexText} — 기준 72보다 낮아 전방에서 가둘 수 있습니다. 라인 ${ins.lineHeight} · 압박 ${ins.pressing}까지 올립니다`
      : trap <= -0.1
        ? `${indexText} — 기준 72를 넘어 압박이 벗겨집니다. 라인 ${ins.lineHeight} · 압박 ${ins.pressing}까지 내려 블록을 세웁니다`
        : `${indexText} — 기준 72와 비슷해 어느 쪽도 크게 통하지 않습니다. 라인 ${ins.lineHeight} · 압박 ${ins.pressing}의 중간 강도를 권합니다`,
  })

  if (s.possession >= 70) {
    patch.mentality = 'defensive'
    // 파생 라인(점유 78이면 25 부근)이 이미 낮으므로 보통은 무효한 안전장치다.
    // 전개 지표는 낮은데 점유만 높은 상대(=파생 라인이 높게 나오는 경우)에 대비해 남긴다 —
    // 수비적 멘탈리티에 하이라인이 붙으면 플랜이 앞뒤가 맞지 않는다.
    ins.lineHeight = Math.min(ins.lineHeight, 30)
    patch.attackPattern = 'through'
    reasons.push({ field: 'mentality', text: `상대 점유 성향 ${s.possession} — 블록을 내리고 회수 후 전환을 노립니다` })
  }
  if (s.lineHeight >= 62) {
    patch.attackPattern = 'through'
    ins.tempo = clampAxis(ins.tempo + 15)
    reasons.push({ field: 'tempo', text: `상대 라인 높이 ${s.lineHeight} — 뒷공간 침투가 유효합니다` })
  }
  if (s.pressing >= 65) {
    ins.tempo = clampAxis(ins.tempo + 10)
    patch.groupIntensity = { attack: 0, midfield: 1, defense: 0 }
    reasons.push({ field: 'pressing', text: `상대 압박 ${s.pressing} — 빠른 전개로 압박을 벗깁니다` })
  }

  // FIFA 랭킹 격차 — 숫자가 작을수록 강팀이므로 (내 랭킹 − 상대 랭킹)이 클수록 우리가 약체.
  const gap = me.fifaRanking - opp.fifaRanking
  if (gap >= 15) {
    patch.mentality = 'defensive'
    patch.groupIntensity = { ...(patch.groupIntensity ?? { attack: 0, midfield: 0, defense: 0 }), defense: 1 }
    reasons.push({ field: 'mentality', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 실점 최소화가 승점 기대값을 높입니다` })
  } else if (gap <= -15) {
    patch.mentality = 'attacking'
    patch.groupIntensity = { ...(patch.groupIntensity ?? { attack: 0, midfield: 0, defense: 0 }), attack: 1 }
    reasons.push({ field: 'mentality', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 주도권을 잡을 수 있는 매치업입니다` })
  }

  // 랭킹이 멘탈리티를 정하지 않은 매치업(격차 15 미만)에선 전개 지표가 대신 정한다.
  // 가두기가 통하는 상대(trap ≥ 0.5)에게 라인·압박만 올리고 멘탈리티를 중립으로 두면 태세가
  // 어긋난다 — 하이라인·하이프레스는 그 자체가 공격적 선택이다.
  // 실측 kor vs mex(라인 75 · 압박 68, n=800): 수비적 +0.7 / 균형 +2.5 / 공격적 +5.6pp.
  if (patch.mentality === undefined && trap >= 0.5) {
    patch.mentality = 'attacking'
    reasons.push({ field: 'mentality', text: `상대 후방 전개 지표 ${buildupIndex} — 전방에서 끊어낼 수 있어 공격적 태세가 유리합니다` })
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
