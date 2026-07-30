// src/engine/strength.ts
import type { FormationId, SideState, Position, Team } from './types'
import { effectiveStats, positionFitness } from './fitness'
import { groupIntensityZoneFactor, phaseTilt } from './tactics'
import { pickBestXI } from './lineup'

const ZONE_OF: Record<Position, 'gk' | 'defense' | 'midfield' | 'attack'> = {
  GK: 'gk', CB: 'defense', LB: 'defense', RB: 'defense',
  DM: 'midfield', CM: 'midfield', AM: 'midfield', LW: 'attack', RW: 'attack', ST: 'attack',
}
const ZONE_WEIGHT: Record<'defense' | 'midfield' | 'attack', (keyof ReturnType<typeof effectiveStats>)[]> = {
  defense: ['defending', 'physical', 'pace'], midfield: ['passing', 'dribbling', 'defending'], attack: ['shooting', 'dribbling', 'pace'],
}

// ── F0 존 인원수 (2026-07-30) ────────────────────────────────────
// 문제: zoneStrength는 **존 평균만** 냈다. 그래서 존에서 사람을 빼도 그 존이 얇아지지 않는다 —
// 오히려 나간 사람보다 들어온 사람이 좋으면 평균이 **오른다**. 실측(kor):
//   4-4-2는 DM(p_kor_23)을 빼고 2번째 ST를 넣는데 미드필드 평균이 72.22 → 72.33으로 상승
//   3-5-2는 LB·RB를 빼고 3번째 CB를 넣는데 수비 평균이 75.08 → 76.33으로 상승
// 대가가 문자 그대로 0이라, 형태 선택이 "여분의 공격수가 그가 밀어낸 수비/미드보다 자기 존
// 평균을 더 올리는가"만 보는 단조 문제가 된다. 그 결과가 12상대 전부에서 같은 순위였다.
//
// 처방: 존 인원이 기준 편성보다 **적으면** 그 존을 얇게 만든다.
//  · 기준 편성 (4,3,3) — 4백·3미들·3공격. 4-3-3 / 4-2-3-1 / 4-1-4-1이 정확히 여기라
//    이 셋과 kor 기본 포메이션(4-2-3-1)은 계수가 정확히 1.0 → **시드 회귀 불변**이다.
//  · **위쪽은 보상하지 않는다.** 공은 하나뿐이라 공격수를 하나 더 세운다고 그 존이 비례해
//    강해지지 않는다(이미 '좋은 선수가 들어와 평균이 오르는' 이득은 받는다). 반대로 빼면
//    커버할 폭이 그대로인 채 사람만 준 것이라 확실히 얇아진다. 이 비대칭이 공짜 점심을 없앤다.
//  · 지수 0.20은 **캘리브레이션 계약이 정한 상한**이다. 이 항은 chanceP의
//    (atk/def)^1.6을 통해 슛 수에 직접 들어가므로, 세게 잡으면 상대 팀 형태에 따라 슛
//    베이스라인이 밀린다. 실측(runBatch n=300, 홈 슛 편차):
//      지수 0.35 → kor-cze +25.3% · esp-arg +28.7% (실팀 게이트 ±25% **위반**)
//      지수 0.20 → kor-cze +15.3% · esp-arg +20.4% (통과)
//    지수를 낮춰도 형태 축의 부호 반전은 유지된다(F1이 그 역할을 맡는다) —
//    0.20에서 3-5-2 3/4 → 0.945(−5.5%), 4-4-2·5-4-1 미드 2/3 → 0.923(−7.7%).
const ZONE_REF: Record<'defense' | 'midfield' | 'attack', number> = { defense: 4, midfield: 3, attack: 3 }
const K_ZONE_COUNT = 0.20
const countFactor = (zone: 'defense' | 'midfield' | 'attack', n: number) =>
  n >= ZONE_REF[zone] ? 1 : Math.pow(n / ZONE_REF[zone], K_ZONE_COUNT)

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
  // F0: 인원수 계수를 함께 곱한다. 기준 편성(4,3,3) 이상이면 정확히 1.0.
  // 퇴장으로 인원이 줄면 여기서도 자연히 얇아진다 — shortage(전체 인원 페널티)와 겹치지만
  // 서로 다른 것을 잰다(shortage = 팀 전체 수적 열세, countFactor = 그 존의 커버 밀도).
  const mod = (zone: 'attack' | 'midfield' | 'defense') =>
    groupIntensityZoneFactor(gi, zone) * (phase ? phaseTilt(pf, phase, zone) : 1.0) * moraleFactor
    * countFactor(zone, zones[zone].length)
  return {
    attack: avg(zones.attack) * (1 - shortage) * mod('attack'),
    midfield: avg(zones.midfield) * (1 - shortage) * mod('midfield'),
    defense: avg(zones.defense) * (1 - shortage) * mod('defense'),
    gk: avg(zones.gk),
  }
}

/** 킥오프 시점(체력 100·사기 70·최적 XI)의 존 전력. 추천 계층(game/scouting·game/coach)이
 *  엔진과 **같은 판별자**로 매치업을 읽을 수 있게 하려고 여기 둔다 — 수식을 복제하면
 *  "조언이 말하는 매치업"과 "엔진이 계산하는 매치업"이 어긋난다.
 *  `formation`을 주면 그 형태로 XI를 다시 세운다(F0 이후 형태마다 존 전력이 실제로 달라진다).
 *  미지정이면 팀 기본 포메이션 — 기존 호출부와 완전히 동일하다. */
export function kickoffZones(team: Team, formation?: FormationId) {
  const staminaByPlayer: Record<string, number> = {}, moraleByPlayer: Record<string, number> = {}
  team.squad.forEach(p => { staminaByPlayer[p.id] = 100; moraleByPlayer[p.id] = 70 })
  return zoneStrength({ team, tactics: pickBestXI(team, formation), staminaByPlayer, moraleByPlayer, subsUsed: 0, sentOff: [] })
}
