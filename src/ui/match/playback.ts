// src/ui/match/playback.ts
// 하이라이트 리듬 — "1x = 경기 3~5분"의 게임 페이스를 만드는 순수 로직.
//
// 재생 루프(MatchScreen)는 매 분마다 이 함수로 "이 분에 머무를 시간(dwell)"을
// 계산해 다음 스텝을 예약한다. 사건이 큰 분(골·슛)은 오래 머물러 연출하고,
// 무사건 분은 빠르게 넘겨(빨리감기) 지루함을 줄인다. 랜덤·시간 의존 없음(결정론).
import type { MatchEvent, MatchEventType } from '../../engine/types'

/** 재생 속도 배율. UI 토글 1x / 1.5x / 2x. */
export type PlaybackSpeed = 1 | 1.5 | 2

/** 이벤트 타입별 연출 dwell(ms, 1x 기준). 목록에 없는 타입(kickoff·yellow 등)은
 *  가중 0으로 취급 → 그 분에 다른 유의미 이벤트가 없으면 무사건과 동일하게 넘긴다.
 *  상수 설계 근거: 실경기 이벤트 밀도(경기당 유의미 이벤트 ~25~40 + 무사건 분)에서
 *  90분 총합이 180,000~300,000ms(=3~5분)에 들어오도록 캘리브레이션(playback.test 참조). */
export const EVENT_DWELL_MS: Partial<Record<MatchEventType, number>> = {
  goal: 6500,
  shot: 4300,
  save: 4300,
  miss: 4300,
  foul: 2700,
  corner: 2700,
}

/** 무사건 분 dwell(ms, 1x). 빠르게 넘어가는 "빨리감기" 구간. */
export const NO_EVENT_DWELL_MS = 1800

/** 클러치(80'+ & 스코어차 ≤1) 무사건 dwell 배수 — 긴장 유지(FM26 Dynamic Highlights 참조). */
export const CLUTCH_MULTIPLIER = 2

/**
 * 해당 분에 머무를 재생 시간(ms)을 계산한다.
 * - 그 분의 이벤트 중 최고 가중 dwell을 채택(여러 이벤트가 겹쳐도 가장 큰 연출 기준).
 * - 유의미 이벤트가 없으면 무사건 dwell(빨리감기). clutch면 무사건도 ×2로 늦춰 긴장 유지.
 * - 마지막에 speed(1|1.5|2)로 나눠 반영.
 *
 * @param _minute 표시 분(현재는 계산에 미사용 — 시그니처 계약 유지·향후 확장용).
 * @param eventsAtMinute 그 분에 발생한 이벤트들(engine.events.filter(e => e.minute === minute)).
 * @param speed 재생 속도 배율.
 * @param clutch 80'+ & 스코어차 ≤1 여부(호출부가 판정해 전달).
 */
export function minuteDwellMs(
  _minute: number,
  eventsAtMinute: MatchEvent[],
  speed: PlaybackSpeed,
  clutch: boolean,
): number {
  let base = 0
  for (const e of eventsAtMinute) {
    const w = EVENT_DWELL_MS[e.type] ?? 0
    if (w > base) base = w
  }
  if (base === 0) {
    // 무사건 분: 빨리감기. 클러치면 긴장 유지를 위해 늦춘다.
    base = clutch ? NO_EVENT_DWELL_MS * CLUTCH_MULTIPLIER : NO_EVENT_DWELL_MS
  }
  return Math.round(base / speed)
}
