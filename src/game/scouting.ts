// src/game/scouting.ts
// 상대 프로필 기반 플랜 추천 — 순수·결정론. 엔진이 아니라 게임 로직 계층에 둔다
// (엔진은 시뮬레이션만 담당하고, "감독에게 무엇을 권할까"는 게임 규칙이기 때문).
// 추천은 정답이 아니라 출발점이다. UI는 반드시 "감독 판단으로 수정하십시오"를 함께 보여준다.
import type { FormationId, Instructions, TacticState, Team } from '../engine/types'
import { formationEdge } from '../engine/tactics'
import { mapFormation } from '../engine/formations'
import { positionFitness } from '../engine/fitness'

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

export function recommendPlan(me: Team, opp: Team): PlanRecommendation {
  const s = opp.profile.style
  const reasons: { field: string; text: string }[] = []
  // 출발점은 우리 팀 프로필 스타일 — 감독의 색을 지우지 않고 상대에 맞춰 보정한다.
  const ins: Instructions = {
    lineHeight: me.profile.style.lineHeight,
    pressing: me.profile.style.pressing,
    tempo: me.profile.style.tempo,
    attackFocus: 'balanced',
  }
  const patch: Partial<TacticState> = {}

  if (s.possession >= 70) {
    patch.mentality = 'defensive'
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
