// src/ui/lineup/swap.ts
// 라인업 편집 순수 로직 — React·DnD 비의존. 전량 TDD 대상.
//
// 예외 규정: positionFitness는 "시뮬 실행" 함수가 아니라 (선수, 슬롯)만 받는 순수
// 적합도 계산 함수이므로 UI 계층에서 import 를 허용한다. 계획 Global Constraints 의
// "엔진 함수 금지"는 경기 시뮬을 돌리는 실행 함수(simulate/playTo 등)를 가리킨다.
import type { Team, FormationId, LineupSlot, Player, Position } from '../../engine/types'
import { positionFitness } from '../../engine/fitness'
import { XI_SLOTS } from '../pitch/formations'

export type FitLevel = 'good' | 'ok' | 'bad'

/** positionFitness 값 → 적합도 경고 등급.
 *  ≥0.85 good(초록) / ≥0.65 ok(노랑) / 미만 bad(빨강). */
export function fitLevel(player: Player, slot: Position): FitLevel {
  const f = positionFitness(player, slot)
  if (f >= 0.85) return 'good'
  if (f >= 0.65) return 'ok'
  return 'bad'
}

/** 선발 두 명의 슬롯을 맞교환한다(두 선수가 서로의 슬롯으로 이동).
 *  둘 다 선발일 때만 교환하고, 아니면 원본을 그대로 돌려준다.
 *  슬롯 순서는 보존하고 playerId만 자리를 바꾸므로 두 번 적용하면 원복된다(대칭). */
export function swapPlayers(lineup: LineupSlot[], aPlayerId: string, bPlayerId: string): LineupSlot[] {
  if (aPlayerId === bPlayerId) return lineup
  const ai = lineup.findIndex(s => s.playerId === aPlayerId)
  const bi = lineup.findIndex(s => s.playerId === bPlayerId)
  if (ai < 0 || bi < 0) return lineup
  return lineup.map((s, i) => {
    if (i === ai) return { ...s, playerId: bPlayerId }
    if (i === bi) return { ...s, playerId: aPlayerId }
    return s
  })
}

/** 벤치 선수(inId)를 선발(outId) 자리에 투입 — 슬롯은 유지되고 11인 수도 유지된다.
 *  outId가 선발이 아니거나 inId가 이미 선발이면(중복) 원본 그대로 돌려준다. */
export function substitute(lineup: LineupSlot[], outId: string, inId: string): LineupSlot[] {
  if (outId === inId) return lineup
  const oi = lineup.findIndex(s => s.playerId === outId)
  if (oi < 0) return lineup
  if (lineup.some(s => s.playerId === inId)) return lineup
  return lineup.map((s, i) => (i === oi ? { ...s, playerId: inId } : s))
}

/** 적합도 하한. planRisks가 "적합도 낮음"으로 경고하는 값(0.7)과 같은 수를 쓴다 —
 *  배치기가 스스로 경고를 유발하는 XI를 만들면 추천이 자기 리스크 카드와 모순된다.
 *  0.7 미만은 인접 포지션(0.65)조차 아닌 사실상 무관한 자리다. */
export const MIN_FIT = 0.7

/** autoFill 후보 범위. 킥오프 전과 경기 중은 규칙이 다르다.
 *  - `'squad'`(킥오프 전): 슬롯별로 **스쿼드 전체**에서 최적을 고른다. 동점이면 preferIds
 *    (현재 선발)를 유지한다. 벤치 투입이 자유로운 시점이므로 적합도가 우선이다.
 *  - `'starters-only'`(경기 중 작전판): preferIds(현재 선발 11인) **안에서만** 재배치한다.
 *    경기 중 벤치 선수를 자동 투입하면 감독이 쓰지도 않은 교체 카드를 몰래 소모하는 셈이다. */
export type AutoFillScope = 'squad' | 'starters-only'

/** 포메이션 슬롯(XI_SLOTS)에 적합도 기준으로 배치한다.
 *
 *  이전 판은 preferIds가 하나라도 남아 있으면 무조건 그 안에서 골랐다. 그래서 킥오프 전
 *  [추천 적용]이 4-2-3-1 → 3-5-2로 바꾸면, 3-5-2에서 남아도는 풀백이 ST 슬롯에 꽂혔다
 *  (실측: 김문환 RB → ST, 적합도 0.40). 벤치에 ST가 셋 있는데도 그랬다.
 *  이제 범위(scope)로 두 시점을 구분한다 — AutoFillScope 주석 참고.
 *
 *  배치는 두 단계다.
 *   (1) **희소 슬롯 우선** 그리디: 슬롯 순서대로 채우면 앞 슬롯이 뒤 슬롯의 유일한 적임자를
 *       먼저 가져간다(3-5-2에서 LW 슬롯이 ST 겸업 윙어를 선점하는 식). 임계 이상 후보가
 *       적은 슬롯부터 채워 그 선점을 막는다. 동수면 XI_SLOTS 순서(결정론).
 *   (2) **2-opt 수리**: 그래도 임계 미만이 남으면 XI 안에서 자리를 맞바꿔 구제한다.
 *       합계 적합도가 오르는 교환만 하므로 반드시 종료한다. 스쿼드 구성상 불가피한
 *       미스매치(예: 3-5-2인데 ST가 정말 둘뿐)는 그대로 남고 리스크 카드가 경고한다. */
export function autoFill(
  team: Team, formation: FormationId, preferIds?: string[], scope: AutoFillScope = 'squad',
): LineupSlot[] {
  const slots = XI_SLOTS[formation]
  const prefer = preferIds ? new Set(preferIds) : null
  const lock = scope === 'starters-only' && prefer !== null
  const fit = (p: Player, slot: Position) => positionFitness(p, slot)

  // 후보 모집단. 경기 중(lock)에는 현재 선발 11인이 전부다.
  const pool = lock ? team.squad.filter(p => prefer!.has(p.id)) : team.squad

  // (1) 희소 슬롯 우선 그리디.
  const order = slots
    .map((slot, i) => ({ slot, i, n: pool.filter(p => fit(p, slot) >= MIN_FIT).length }))
    .sort((a, b) => (a.n !== b.n ? a.n - b.n : a.i - b.i))
  const picked: (Player | undefined)[] = new Array(slots.length).fill(undefined)
  const used = new Set<string>()
  for (const { slot, i } of order) {
    let best: Player | undefined
    for (const p of pool) {
      if (used.has(p.id)) continue
      if (best === undefined) { best = p; continue }
      const d = fit(p, slot) - fit(best, slot)
      // 동점이면 현재 선발을 유지한다 — 적합도가 같다면 감독이 고른 11인이 이긴다.
      if (d > 0 || (d === 0 && prefer !== null && prefer.has(p.id) && !prefer.has(best.id))) best = p
    }
    // lock인데 선발이 11명 미만이면 pool이 마를 수 있다 — 그때만 스쿼드 전체로 보충한다.
    if (best === undefined) best = team.squad.find(p => !used.has(p.id))!
    picked[i] = best
    used.add(best.id)
  }
  const xi = picked as Player[]

  // (2) 2-opt 수리 — 임계 미만 슬롯을 XI 내 자리 교환으로 구제한다.
  for (let pass = 0; pass < slots.length; pass++) {
    let changed = false
    for (let i = 0; i < slots.length; i++) {
      if (fit(xi[i], slots[i]) >= MIN_FIT) continue
      let bestJ = -1, bestGain = 0
      for (let j = 0; j < slots.length; j++) {
        if (i === j) continue
        const gain = (fit(xi[j], slots[i]) + fit(xi[i], slots[j])) - (fit(xi[i], slots[i]) + fit(xi[j], slots[j]))
        // 문제 슬롯이 실제로 올라가고 합계도 오르는 교환만 채택한다(합계 단조 증가 → 종료 보장).
        if (gain > bestGain && fit(xi[j], slots[i]) > fit(xi[i], slots[i])) { bestGain = gain; bestJ = j }
      }
      if (bestJ >= 0) { const t = xi[i]; xi[i] = xi[bestJ]; xi[bestJ] = t; changed = true }
    }
    if (!changed) break
  }

  return slots.map((slot, i) => ({ slot, playerId: xi[i].id }))
}
