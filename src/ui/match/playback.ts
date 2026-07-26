// src/ui/match/playback.ts
// 하이라이트 리듬 — "1x = 경기 3~5분"의 게임 페이스를 만드는 순수 로직.
//
// 재생 루프(MatchScreen)는 매 분마다 이 함수로 "이 분에 머무를 시간(dwell)"을
// 계산해 다음 스텝을 예약한다. 사건이 큰 분(골·슛)은 오래 머물러 연출하고,
// 무사건 분은 빠르게 넘겨(빨리감기) 지루함을 줄인다. 랜덤·시간 의존 없음(결정론).
import type { MatchEvent, MatchEventType, Team } from '../../engine/types'
import { commentate } from '../../game/commentary'
import { estimateSpeechMs } from '../../audio/commentary-tts'

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

/** 블로우아웃 스코어차 임계 — 이 이상 벌어지면 연출을 가속한다(FM 교훈: 승부 갈린 뒤 늘어짐 방지). */
export const BLOWOUT_DIFF = 3
/** 블로우아웃 dwell 배수 — 전체 dwell을 이 비율로 압축(빠른 소화). */
export const BLOWOUT_MULTIPLIER = 0.6

/** dwell 상한(ms, 속도 적용 후). 발화 길이 보정이 무한정 늘어나지 않게 막는다. */
export const MAX_DWELL_MS = 9000

// ── 주인공 이벤트 선택자(단일 진실원) ─────────────────────────
// ★ 왜 하나여야 하나: 예전엔 한 분의 대표 이벤트를 두 곳이 따로 골랐다.
//   - 안무: EVENT_DWELL_MS 최댓값(부분 순서 + 동점은 events 배열 순서라는 우연)
//   - 음성: commentary-tts.SPOKEN_PRIORITY(goal>save>miss>corner>foul, shot·chance 제외)
//   두 규칙은 동점 처리와 후보 집합이 달라 "말한 것 ≠ 그린 것"이 될 수 있었다.
//   dwell 가중치는 '그 분이 얼마나 큰 분인가'(리듬)를 재는 값이지 '무엇을 보여줄까'의
//   기준이 아니다 — 동점(shot·save·miss 4300, corner·foul 2700)이 많아 순서를 정하지
//   못한다. 그래서 **명시적 전순서 목록**(음성 쪽 규칙의 확장)을 단일 규칙으로 채택했다.
/**
 * 주인공 이벤트 우선순위 — 앞일수록 우선. **안무가 있는 타입만** 넣는다
 * (choreography.buildSequence가 빈 배열을 돌려주는 타입은 주인공이 될 수 없다).
 * 근거: 결과(goal/save/miss) > 시도(shot/chance) > 징계(red/yellow) > 세트피스·반칙.
 */
export const DRAMA_PRIORITY: readonly MatchEventType[] = [
  'goal', 'save', 'miss', 'shot', 'chance', 'red', 'yellow', 'corner', 'foul',
]

/**
 * 그 분의 "주인공 이벤트"를 고른다 — 음성·안무가 **함께** 쓰는 단 하나의 선택자.
 * 티커는 그 분의 모든 이벤트를 계속 보여준다(로그이므로 전부가 맞다).
 * 결정론: 같은 배열 → 항상 같은 결과. 같은 타입이 둘이면 배열 앞쪽(먼저 발생)을 택한다.
 */
export function pickDramaEvent(events: MatchEvent[]): MatchEvent | null {
  let best: MatchEvent | null = null
  let bestRank = Infinity
  for (const e of events) {
    const rank = DRAMA_PRIORITY.indexOf(e.type)
    if (rank === -1) continue // 안무 없는 타입(kickoff·sub·halftime·fulltime)은 후보 아님
    if (rank < bestRank) {
      bestRank = rank
      best = e
    }
  }
  return best
}

/** 주인공 이벤트가 강조 발화(rate·pitch 상향 + 발화 중 선점) 대상인가. */
export function isImportantEvent(e: MatchEvent): boolean {
  return e.type === 'goal' || e.type === 'save'
}

/** 그 분 주인공 이벤트의 해설 발화 소요 시간(ms). 주인공이 없으면 0.
 *  speed는 발화 rate에 연동되므로(commentary-tts.utteranceRate) 함께 넘긴다 —
 *  2배속에서는 문장도 빨리 읽히므로 필요한 체류 하한이 그만큼 짧다. */
export function minuteSpeechMs(
  eventsAtMinute: MatchEvent[],
  home: Team,
  away: Team,
  speed: PlaybackSpeed = 1,
): number {
  const drama = pickDramaEvent(eventsAtMinute)
  if (!drama) return 0
  return estimateSpeechMs(commentate(drama, home, away), isImportantEvent(drama), speed)
}

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
 * @param scoreDiff 현재 스코어차(절댓값). BLOWOUT_DIFF 이상이면 전체 dwell을 압축(가속).
 *   미지정 시 0 → 가속 미적용(총합 가드 캘리브레이션은 이 기본값 기준).
 * @param speechMs 이 분에 발화할 해설의 예상 길이(ms). 리듬 dwell이 이보다 짧으면
 *   말이 잘리므로 하한으로 쓴다(속도로 나눈 **뒤** 적용 — TTS는 speed를 따르지 않는다).
 *   미지정 시 0 → 기존 동작 그대로.
 */
export function minuteDwellMs(
  _minute: number,
  eventsAtMinute: MatchEvent[],
  speed: PlaybackSpeed,
  clutch: boolean,
  scoreDiff = 0,
  speechMs = 0,
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
  // 블로우아웃 가속: 승부가 갈린(3골차+) 경기는 연출을 압축해 빠르게 넘긴다.
  if (scoreDiff >= BLOWOUT_DIFF) base *= BLOWOUT_MULTIPLIER
  // 발화 길이 하한 → 상한 클램프. 말이 끝나기 전에 다음 분으로 넘어가지 않게 하되,
  // 긴 문장 하나가 화면을 무한정 붙잡지 못하도록 MAX_DWELL_MS로 막는다.
  return Math.min(MAX_DWELL_MS, Math.max(Math.round(base / speed), Math.round(speechMs)))
}

/**
 * 재생 루프와 안무 재생이 **함께 쓰는** 분당 체류 시간. 두 곳이 각자 계산하면
 * 안무 타임라인(dwell 기준 상대 t)과 실제 분 전환 시점이 어긋나므로 한 함수로 묶는다.
 *
 * @param speechEnabled 해설 음성이 실제로 들리는 상태인가(commentary-tts.willSpeak()).
 *   꺼져 있으면 발화 길이 보정을 하지 않는다 — 무음인데 화면만 느려질 이유가 없다.
 */
export function minuteDwellWithSpeech(
  minute: number,
  eventsAtMinute: MatchEvent[],
  home: Team,
  away: Team,
  speed: PlaybackSpeed,
  clutch: boolean,
  scoreDiff: number,
  speechEnabled: boolean,
): number {
  const speechMs = speechEnabled ? minuteSpeechMs(eventsAtMinute, home, away, speed) : 0
  return minuteDwellMs(minute, eventsAtMinute, speed, clutch, scoreDiff, speechMs)
}
