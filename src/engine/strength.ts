// src/engine/strength.ts
import type { SideState, Position } from './types'
import { effectiveStats, positionFitness } from './fitness'

const ZONE_OF: Record<Position, 'gk' | 'defense' | 'midfield' | 'attack'> = {
  GK: 'gk', CB: 'defense', LB: 'defense', RB: 'defense',
  DM: 'midfield', CM: 'midfield', AM: 'midfield', LW: 'attack', RW: 'attack', ST: 'attack',
}
const ZONE_WEIGHT: Record<'defense' | 'midfield' | 'attack', (keyof ReturnType<typeof effectiveStats>)[]> = {
  defense: ['defending', 'physical', 'pace'], midfield: ['passing', 'dribbling', 'defending'], attack: ['shooting', 'dribbling', 'pace'],
}

// 참고: keyPlayer 의존 가중은 존 전력이 아니라 찬스 참여자 선정(simulate.resolveChance)에서 반영된다 (계획 결정 — Task 6 리뷰 판정).
export function zoneStrength(side: SideState) {
  const zones = { attack: [] as number[], midfield: [] as number[], defense: [] as number[], gk: [] as number[] }
  for (const { slot, playerId } of side.tactics.lineup) {
    if (side.sentOff.includes(playerId)) continue
    const player = side.team.squad.find(p => p.id === playerId)!
    const stamina = side.staminaByPlayer[playerId]
    if (slot === 'GK') {
      const fit = positionFitness(player, 'GK')
      const gs = player.gkStats ?? { saving: 20, aerial: 25, buildup: 30 }
      zones.gk.push(((gs.saving * 0.6 + gs.aerial * 0.25 + gs.buildup * 0.15) * fit * (0.7 + 0.3 * stamina / 100)))
      continue
    }
    const es = effectiveStats(player, slot, stamina)
    const zone = ZONE_OF[slot] as 'defense' | 'midfield' | 'attack'
    const keys = ZONE_WEIGHT[zone]
    zones[zone].push(keys.reduce((s, k) => s + es[k], 0) / keys.length)
  }
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 10)
  // 수적 열세 페널티: 존 인원이 기대보다 적으면 평균에 그대로 반영됨(빈 슬롯 미포함) + 전체 10인 이하 시 추가 페널티
  const shortage = side.sentOff.length * 0.06
  return {
    attack: avg(zones.attack) * (1 - shortage), midfield: avg(zones.midfield) * (1 - shortage),
    defense: avg(zones.defense) * (1 - shortage), gk: avg(zones.gk),
  }
}
