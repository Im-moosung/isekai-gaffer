// src/engine/lineup.ts
// XI 선정 로직을 fixtures와 simulate가 공유하도록 추출 (순환 import 회피).
import type { Player, Position, TacticState } from './types'

const XI_433: Position[] = ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST']

// 순환 import 회피용 로컬 정렬 키 (fitness.ts와 동일 로직의 단순화: 주=2, alt=1, 그 외=0)
function positionFitnessSort(p: Player, slot: Position): number {
  return p.position === slot ? 2 : p.altPositions.includes(slot) ? 1 : 0
}

export function pickBestXI(team: { squad: Player[] }): TacticState {
  const used = new Set<string>()
  const lineup = XI_433.map(slot => {
    const candidate = team.squad
      .filter(p => !used.has(p.id))
      .sort((a, b) => positionFitnessSort(b, slot) - positionFitnessSort(a, slot))[0]
    used.add(candidate.id)
    return { slot, playerId: candidate.id }
  })
  return { formation: '4-3-3', lineup, instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' } }
}
