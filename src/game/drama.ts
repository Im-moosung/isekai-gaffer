// src/game/drama.ts
// 그 분의 **주인공 이벤트** 선택자 — 음성·안무·티커가 함께 쓰는 단일 진실원.
//
// 왜 별도 모듈인가: 이 규칙은 원래 `ui/match/playback.ts`에 있었는데, playback이
// `game/commentary`를 import하므로 commentary 쪽에서 같은 규칙을 쓰려면 순환이 된다.
// 상수를 복제하면 playback.ts 주석이 경고한 "두 곳이 따로 고른다" 안티패턴으로 돌아간다.
// 그래서 아무것도 import하지 않는 중립 모듈로 내렸다 — game도 ui도 여기를 향한다.
import type { MatchEvent, MatchEventType } from '../engine/types'

/**
 * 주인공 이벤트 우선순위 — 앞일수록 우선. **안무가 있는 타입만** 넣는다
 * (choreography.buildSequence가 빈 배열을 돌려주는 타입은 주인공이 될 수 없다).
 * 근거: 결과(goal/save/miss) > 시도(shot/chance) > 징계(red/yellow) > 세트피스·반칙.
 */
export const DRAMA_PRIORITY: readonly MatchEventType[] = [
  'goal', 'save', 'miss', 'shot', 'chance', 'red', 'yellow', 'corner', 'foul',
]

/** 우선순위 순위. 후보가 아니면 `Infinity`(작을수록 우선). */
export function dramaRank(type: MatchEventType): number {
  const i = DRAMA_PRIORITY.indexOf(type)
  return i === -1 ? Infinity : i
}

/**
 * 그 분의 "주인공 이벤트"를 고른다 — 음성·안무가 **함께** 쓰는 단 하나의 선택자.
 * 티커는 그 분의 모든 이벤트를 계속 보여준다(로그이므로 전부가 맞다).
 * 결정론: 같은 배열 → 항상 같은 결과. 같은 타입이 둘이면 배열 앞쪽(먼저 발생)을 택한다.
 */
export function pickDramaEvent(events: MatchEvent[]): MatchEvent | null {
  let best: MatchEvent | null = null
  let bestRank = Infinity
  for (const e of events) {
    const rank = dramaRank(e.type)
    if (rank === -1) continue
    if (rank < bestRank) {
      bestRank = rank
      best = e
    }
  }
  return best
}
