import type { Player, Position, FieldStats } from './types'

export const ADJACENT: Record<Position, Position[]> = {
  GK: [], CB: ['DM'], LB: ['LW', 'CB'], RB: ['RW', 'CB'],
  DM: ['CM', 'CB'], CM: ['DM', 'AM'], AM: ['CM', 'ST', 'LW', 'RW'],
  LW: ['ST', 'AM', 'LB'], RW: ['ST', 'AM', 'RB'], ST: ['LW', 'RW', 'AM'],
}

export function positionFitness(player: Player, slot: Position): number {
  const isGkPlayer = player.position === 'GK'
  if (isGkPlayer !== (slot === 'GK')) return 0.2
  if (player.position === slot) return 1.0
  if (player.altPositions.includes(slot)) return 0.85
  if (ADJACENT[player.position].includes(slot) || ADJACENT[slot].includes(player.position)) return 0.65
  return 0.4
}

const STAMINA_SENSITIVITY: Record<keyof FieldStats, number> = {
  pace: 0.5, physical: 0.45, dribbling: 0.35, shooting: 0.3, defending: 0.3, passing: 0.2,
}

export function effectiveStats(player: Player, slot: Position, stamina: number): FieldStats {
  const fit = positionFitness(player, slot)
  const base: FieldStats = player.stats ?? { shooting: 20, passing: 30, dribbling: 20, defending: 20, physical: 40, pace: 40 } // GK가 필드에 선 경우
  const fatigue = Math.max(0, (100 - stamina) / 100)
  const out = {} as FieldStats
  for (const k of Object.keys(base) as (keyof FieldStats)[]) {
    out[k] = base[k] * fit * (1 - STAMINA_SENSITIVITY[k] * fatigue)
  }
  return out
}
