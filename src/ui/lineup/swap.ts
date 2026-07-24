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

/** 포메이션 슬롯(XI_SLOTS)에 적합도순 그리디 배치 — 엔진 pickBestXI 로직을 6종 포메이션으로 일반화.
 *  preferIds가 주어지면 해당 선수군을 우선 채우고 부족분은 나머지 스쿼드에서 보충한다
 *  (포메이션 변경 시 "현재 선발 우선 유지 후 부족분 벤치에서"에 사용).
 *  GK 슬롯이 인덱스 0이라 GK 적합도 1.0 선수가 가장 먼저 선점된다(GK 슬롯 GK 우선). */
export function autoFill(team: Team, formation: FormationId, preferIds?: string[]): LineupSlot[] {
  const slots = XI_SLOTS[formation]
  const used = new Set<string>()
  const prefer = preferIds ? new Set(preferIds) : null
  const bestFor = (slot: Position, pool: Player[]) =>
    pool.reduce((best, p) => (positionFitness(p, slot) > positionFitness(best, slot) ? p : best))
  return slots.map(slot => {
    const avail = team.squad.filter(p => !used.has(p.id))
    const preferred = prefer ? avail.filter(p => prefer.has(p.id)) : []
    const pool = preferred.length > 0 ? preferred : avail
    const best = bestFor(slot, pool)
    used.add(best.id)
    return { slot, playerId: best.id }
  })
}
