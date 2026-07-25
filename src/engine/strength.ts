// src/engine/strength.ts
import type { SideState, Position } from './types'
import { effectiveStats, positionFitness } from './fitness'
import { groupIntensityZoneFactor, phaseTilt } from './tactics'

const ZONE_OF: Record<Position, 'gk' | 'defense' | 'midfield' | 'attack'> = {
  GK: 'gk', CB: 'defense', LB: 'defense', RB: 'defense',
  DM: 'midfield', CM: 'midfield', AM: 'midfield', LW: 'attack', RW: 'attack', ST: 'attack',
}
const ZONE_WEIGHT: Record<'defense' | 'midfield' | 'attack', (keyof ReturnType<typeof effectiveStats>)[]> = {
  defense: ['defending', 'physical', 'pace'], midfield: ['passing', 'dribbling', 'defending'], attack: ['shooting', 'dribbling', 'pace'],
}

// 참고: keyPlayer 의존 가중은 존 전력이 아니라 찬스 참여자 선정(simulate.resolveChance)에서 반영된다 (계획 결정 — Task 6 리뷰 판정).
// phase 인자: 지정 시 phaseFormations에 따라 존 가중을 이동한다(공격 시/수비 시). 미지정이면 중립.
// groupIntensity는 phase 무관하게 항상 반영된다. 두 배수 모두 기본값에서 정확히 1.0 → 기존 결과 불변.
export function zoneStrength(side: SideState, phase?: 'attack' | 'defense') {
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
  const gi = side.tactics.groupIntensity
  const pf = side.tactics.phaseFormations
  // 사기 반영: 주전(퇴장 제외) 평균 사기를 존 전력 배수로. 팀토크·외침이 결과에 닿는 유일한 경로다.
  // 초기값 70에서 정확히 1.0이 되도록 70을 중심으로 정의한다(시드 회귀 불변).
  // 100→1.06, 40→0.94, 0→0.86. 팀토크 최대 delta +11은 81→1.022로, 체감되되 밸런스를 흔들지 않는다.
  const moraleVals = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId))
    .map(l => side.moraleByPlayer[l.playerId] ?? 70)
  const avgMorale = moraleVals.length ? moraleVals.reduce((s, v) => s + v, 0) / moraleVals.length : 70
  const moraleFactor = 1 + ((avgMorale - 70) / 100) * 0.20
  // 존별 배수: 그룹 적극성 × 페이즈 틸트 × 사기. 기본값에서 전부 1.0 → (val * 1 * 1 * 1) === val (회귀 불변).
  // gk 존에는 곱하지 않는다 — 반환값을 소비하는 곳이 없어(resolveChance는 gkStats.saving을 직접 읽는다)
  // 죽은 경로에 로직을 얹을 이유가 없다.
  const mod = (zone: 'attack' | 'midfield' | 'defense') =>
    groupIntensityZoneFactor(gi, zone) * (phase ? phaseTilt(pf, phase, zone) : 1.0) * moraleFactor
  return {
    attack: avg(zones.attack) * (1 - shortage) * mod('attack'),
    midfield: avg(zones.midfield) * (1 - shortage) * mod('midfield'),
    defense: avg(zones.defense) * (1 - shortage) * mod('defense'),
    gk: avg(zones.gk),
  }
}
