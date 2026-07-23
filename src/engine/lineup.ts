// src/engine/lineup.ts
// XI 선정 로직을 fixtures와 simulate가 공유하도록 추출 (순환 import 회피).
import type { Player, Position, TacticState } from './types'
import { positionFitness } from './fitness'

const XI_433: Position[] = ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST']

export function pickBestXI(team: { squad: Player[] }): TacticState {
  const used = new Set<string>()
  const lineup = XI_433.map(slot => {
    const candidate = team.squad
      .filter(p => !used.has(p.id))
      .sort((a, b) => positionFitness(b, slot) - positionFitness(a, slot))[0]
    used.add(candidate.id)
    return { slot, playerId: candidate.id }
  })
  return { formation: '4-3-3', lineup, instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' } }
}
