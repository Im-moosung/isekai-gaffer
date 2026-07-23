// src/engine/fixtures/testTeams.ts
import type { Team, Player, Position, FieldStats, SideState } from '../types'
import { pickBestXI } from '../lineup'

export { pickBestXI }

const LAYOUT: { pos: Position; alt: Position[]; count: number }[] = [
  { pos: 'GK', alt: [], count: 2 },
  { pos: 'CB', alt: ['DM'], count: 3 },
  { pos: 'LB', alt: ['LW'], count: 1 }, { pos: 'RB', alt: ['RW'], count: 1 },
  { pos: 'DM', alt: ['CB', 'CM'], count: 2 }, { pos: 'CM', alt: ['DM', 'AM'], count: 3 },
  { pos: 'AM', alt: ['CM', 'ST'], count: 1 },
  { pos: 'LW', alt: ['ST', 'RW'], count: 2 }, { pos: 'RW', alt: ['ST', 'LW'], count: 1 },
  { pos: 'ST', alt: ['LW', 'AM'], count: 2 },
]

function fieldStats(base: number, pos: Position, i: number): FieldStats {
  const v = (off: number) => Math.max(30, Math.min(95, base + off - i)) // i로 선수 간 편차
  const atk = ['LW', 'RW', 'ST', 'AM'].includes(pos)
  const def = ['CB', 'LB', 'RB', 'DM'].includes(pos)
  return {
    shooting: v(atk ? 5 : def ? -18 : -6), passing: v(0), dribbling: v(atk ? 4 : -8),
    defending: v(def ? 6 : atk ? -22 : -4), physical: v(def ? 3 : -2), pace: v(['LW','RW','LB','RB'].includes(pos) ? 5 : -3),
  }
}

export function makeTestTeam(id: string, tierPower: number): Team {
  const squad: Player[] = []
  let n = 1
  for (const { pos, alt, count } of LAYOUT) {
    for (let i = 0; i < count; i++) {
      const p: Player = {
        id: `p_${id}_${String(n).padStart(2, '0')}`, number: n,
        name: { ko: `${id}선수${n}`, en: `${id}-P${n}` },
        position: pos, altPositions: alt, foot: n % 4 === 0 ? 'L' : 'R',
        setPiece: tierPower - 10 + (n % 7), penalty: tierPower - 8 + (n % 9), stamina: 70 + (n % 20),
      }
      if (pos === 'GK') p.gkStats = { saving: tierPower - i * 6, aerial: tierPower - 4, buildup: tierPower - 12 }
      else p.stats = fieldStats(tierPower, pos, i)
      squad.push(p); n++
    }
  }
  return {
    id, name: { ko: id, en: id }, fifaCode: id.toUpperCase().slice(0, 3), fifaRanking: 100 - tierPower, tier: tierPower >= 85 ? 1 : tierPower >= 75 ? 2 : 3,
    profile: {
      preferredFormations: ['4-3-3'], style: { possession: tierPower >= 80 ? 65 : 45, pressing: 55, lineHeight: 50, tempo: 55 },
      keyPlayers: [{ playerId: `p_${id}_14`, dependency: 0.6 }], benchPattern: 'balanced',
    },
    statBaseline: { possession: 50, passAccuracy: 78 + (tierPower - 70) / 2, shotsPerGame: 12, shotsOnTargetPerGame: 4.5, foulsPerGame: 12, cornersPerGame: 5, xgPerGame: 1.3 },
    squad,
  }
}

export function makeSideState(team: Team): SideState {
  const staminaByPlayer: Record<string, number> = {}, moraleByPlayer: Record<string, number> = {}
  team.squad.forEach(p => { staminaByPlayer[p.id] = 100; moraleByPlayer[p.id] = 70 })
  return { team, tactics: pickBestXI(team), staminaByPlayer, moraleByPlayer, subsUsed: 0, sentOff: [] }
}
