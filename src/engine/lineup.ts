// src/engine/lineup.ts
// XI 선정 로직을 fixtures와 simulate가 공유하도록 추출 (순환 import 회피).
import type { FormationId, Player, TacticState, Team } from './types'
import { positionFitness } from './fitness'
import { XI_SLOTS, mapFormation } from './formations'

/**
 * 팀의 스쿼드에서 포메이션 슬롯별 적합도 최상위 선수로 XI를 구성한다.
 * @param team squad + (선택) profile을 가진 팀. profile이 있으면 미지정 formation을
 *   profile.preferredFormations[0] 매핑값으로 결정한다(AI가 시그니처 포메이션으로 출전).
 * @param formation 명시하면 그대로 사용. 미지정 시 프로필 첫 선호 포메이션 매핑(없으면 4-3-3).
 */
export function pickBestXI(team: { squad: Player[]; profile?: Team['profile'] }, formation?: FormationId): TacticState {
  const f = formation ?? mapFormation(team.profile?.preferredFormations[0] ?? '4-3-3')
  const used = new Set<string>()
  const lineup = XI_SLOTS[f].map(slot => {
    const candidate = team.squad
      .filter(p => !used.has(p.id))
      .sort((a, b) => positionFitness(b, slot) - positionFitness(a, slot))[0]
    used.add(candidate.id)
    return { slot, playerId: candidate.id }
  })
  // 초기 지시는 팀 프로필 스타일로 시딩한다. AI는 simulate.defaultTactics에서
  // profile.style을 쓰는데 유저만 50/50/50으로 시작하던 비대칭을 해소한다.
  // profile이 없는 호출자는 기존 중립값을 유지한다.
  const style = team.profile?.style
  return {
    formation: f,
    lineup,
    instructions: style
      ? { lineHeight: style.lineHeight, pressing: style.pressing, tempo: style.tempo, attackFocus: 'balanced' }
      : { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  }
}
