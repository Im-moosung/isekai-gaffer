// src/ui/match/playback.ts
// 하이라이트 리듬 — "1x = 경기 3~5분"의 게임 페이스를 만드는 순수 로직.
//
// 재생 루프(MatchScreen)는 매 분마다 이 함수로 "이 분에 머무를 시간(dwell)"을
// 계산해 다음 스텝을 예약한다. 사건이 큰 분(골·슛)은 오래 머물러 연출하고,
// 무사건 분은 빠르게 넘겨(빨리감기) 지루함을 줄인다. 랜덤·시간 의존 없음(결정론).
import type { MatchEvent, MatchEventType, SideState, Team } from '../../engine/types'
import { FLOW_DWELL_MS } from '../pitch/flow'
import { SCENE_DWELL_MS } from '../pitch/scenes'
import { buildSequence } from '../pitch/choreography'
import { commentateAt, flowLineAt, type CommentaryCtx } from '../../game/commentary'
import { casterRole, estimatePairMs, estimateSpeechMs } from '../../audio/commentary-tts'

/** 재생 속도 배율. UI 토글 1x / 1.5x / 2x. */
export type PlaybackSpeed = 1 | 1.5 | 2

/**
 * 이벤트 타입별 연출 dwell(ms, 1x 기준). 목록에 없는 타입(kickoff·yellow 등)은
 * 가중 0으로 취급 → 그 분에 다른 유의미 이벤트가 없으면 무사건과 동일하게 넘긴다.
 *
 * ★ 2026-07-30부터 **값의 정본은 scenes.SCENE_DWELL_MS**다.
 *
 * 왜 뒤집혔나: 안무 키프레임의 t는 dwell 상대값이다. 예전엔 여기서 정한 dwell 안에
 * 장면이 "알아서" 들어가야 했고, 그래서 4300 ms 안에 20 m 패스 3번 + 슛 1번을 밀어
 * 넣어 패스가 22~25 m/s로 날아갔다(실측). 지금은 반대다 — 장면이 실제 볼 속도(슛
 * 25 · 크로스 20 · 패스 15 · 지면 13 m/s)와 컨트롤 정지에서 소요를 역산하고, dwell은
 * 그 소요에 여운을 더한 값을 **받아온다**. "1x면 진짜 축구처럼"의 근거가 여기 있다.
 */
export const EVENT_DWELL_MS: Partial<Record<MatchEventType, number>> = {
  goal: SCENE_DWELL_MS.goal,
  shot: SCENE_DWELL_MS.shot,
  save: SCENE_DWELL_MS.save,
  miss: SCENE_DWELL_MS.miss,
  chance: SCENE_DWELL_MS.chance,
  foul: SCENE_DWELL_MS.foul,
  corner: SCENE_DWELL_MS.corner,
}

/** 무사건 분 dwell(ms, 1x). 빠르게 넘어가는 "빨리감기" 구간.
 *  ★ 1800 → 1100: 하이라이트가 실제 축구 속도로 길어진 만큼(장면당 6~7 s) 무사건 분은
 *  더 과감히 넘긴다. 이 구간은 2D 작전판이 받으므로 안무를 밀어 넣을 이유가 없다. */
export const NO_EVENT_DWELL_MS = FLOW_DWELL_MS

/** 클러치(80'+ & 스코어차 ≤1) 무사건 dwell 배수 — 긴장 유지(FM26 Dynamic Highlights 참조). */
export const CLUTCH_MULTIPLIER = 2

/** 블로우아웃 스코어차 임계 — 이 이상 벌어지면 연출을 가속한다(FM 교훈: 승부 갈린 뒤 늘어짐 방지). */
export const BLOWOUT_DIFF = 3
/** 블로우아웃 dwell 배수 — 전체 dwell을 이 비율로 압축(빠른 소화). */
export const BLOWOUT_MULTIPLIER = 0.6

/** dwell 상한(ms, 속도 적용 후). 발화 길이 보정이 무한정 늘어나지 않게 막는다.
 *
 *  ★ 2026-08-01: 9600 → 13500. **발화가 장면 뒤로 옮겨졌다**(아래 "발화 시점" 절).
 *  결과가 화면에 보이는 시각(골 ≈ 6.5 s)이 지난 **뒤**에 캐스터 문장이 시작하므로,
 *  한 분에 필요한 시간이 `장면 소요 + 캐스터 발화`가 됐다. 골 기준 6.5 + 0.26 + 5 ≈ 12 s다.
 *  상한을 올리지 않으면 그 문장이 다음 분에 잘려 예전 증상(말과 화면의 어긋남)이
 *  방향만 바뀐 채 되돌아온다. 90분 총 재생은 약 40 s 늘어난다 — 사용자가 완성도를
 *  우선한다고 명시했다(2026-08-01 5라운드 피드백 ①).
 *
 *  ★ 2026-07-30 기록: 9000 → 9600. 골 dwell이 8600이 되면서(장면 소요 6.5 s + 세리머니 2 s)
 *  상한 9000이 골 해설의 하한 보정을 잘라 낼 수 있게 됐다.
 *
 *  ★ Phase C 4단계 기록(9000 시절). 화자가 둘이 되어 골 순간의 요구 발화가
 *  늘었지만(피크 캐스터 + 해설), 상한을 내리면 **골의 해설 문장이 다음 분에 잘린다**
 *  (브라우저 실측: 상한 7000에서 골 해설 2건이 전부 interrupted). 대신 길이를 콘텐츠
 *  쪽에서 줄였다 — 해설이 붙는 골에는 연호(`{선수}! {선수}!`)를 생략한다(commentary.ts).
 *  그 결과 골 한 분의 총 발화가 약 9초로 상한 안에 들어온다. */
export const MAX_DWELL_MS = 13500

// ── 발화 시점 — "화면을 보고 해설한다" (2026-08-01 5라운드 피드백 ①) ─────
//
// 사용자 지적 원문: *"해설이 먼저 나오고 화면이 다음에 나와. '김승규가 슛을 막았습니다'가
// 나오고 그에 맞는 화면이 다음에 나와. 무슨 예지력이야?"*
//
// 구조상 원인: 재생이 분 단위라 한 분에 들어서는 **즉시** 그 분의 결과 문장을 발화했다.
// 그런데 안무는 dwell 전체(골 8.6 s)에 걸쳐 재생되고 결과(골 · 세이브 접촉)는 그 끝에
// 온다. 즉 캐스터가 6~7초 앞서 결과를 말하고 있었다 — 예지력.
//
// 처방: **결과가 화면에 보이는 시각(reveal)을 안무에서 역산**하고, 캐스터는 그 뒤에
// 말한다. 해설위원은 캐스터 뒤(유터런스 체이닝)이므로 순서는 저절로 유지된다.
// "해설은 절대 먼저 말하지 않는다"(§1.1)를 **화면 대비**로 확장한 것이다.

/**
 * 캐스터가 결과를 보고 입을 떼기까지의 지연(ms).
 *
 * 0이면 공이 그물에 닿는 **프레임과 동시에** 말이 시작돼 여전히 예지력처럼 들린다
 * (사람은 보고 말하기까지 최소 0.2 s가 걸린다). 0.5 s를 넘기면 이번엔 반응이 굼떠
 * 중계가 아니라 나레이션이 된다. 실제 중계의 골 콜 시작 지연이 대략 이 범위다.
 */
export const REVEAL_LAG_MS = 260

/**
 * 안무에서 **결과가 화면에 보이는 순간**의 dwell 상대 시각(0~1).
 *
 *  - 세이브: `contact` 스텝(= GK 손이 공에 닿는 순간). 그 뒤 리바운드 스텝이 붙어도
 *    "막았습니다"의 근거는 접촉이다.
 *  - 그 외(골 · 미스 · 슛): 마지막 스텝. 골은 공이 그물에 닿는 지점, 미스는 골라인을
 *    벗어나는 지점이라 둘 다 마지막 키프레임이 곧 결과다.
 *
 * 구조적 타입만 받는다 — choreography를 import하지 않아도 테스트가 리터럴로 부를 수 있다.
 */
export function sceneRevealT(seq: readonly { t: number; contact?: boolean }[]): number {
  if (seq.length === 0) return 0
  const contact = seq.find(s => s.contact)
  const t = contact ? contact.t : seq[seq.length - 1].t
  return t > 0 && t < 1 ? t : t >= 1 ? 1 : 0
}

/**
 * 이 분의 **결과 노출 시각**(ms, 분 시작 기준). 하이라이트 안무가 없는 분은 0이다
 * (코너 · 파울 · 무사건 분의 문장은 결과가 아니라 국면 서술이라 미룰 이유가 없다).
 *
 * @param sceneMs 안무가 실제로 재생되는 시간 = {@link sceneDwellMs}. **dwell이 아니다** —
 *   dwell은 발화 때문에 늘어나지만 안무는 늘어나지 않는다(늘리면 reveal도 함께 밀려
 *   방정식이 스스로를 쫓는다).
 */
export function minuteRevealMs(
  eventsAtMinute: MatchEvent[],
  homeState: SideState,
  awayState: SideState,
  sceneMs: number,
): number {
  const drama = pickDramaEvent(eventsAtMinute)
  if (!drama || !isHighlightEvent(drama)) return 0
  const seq = buildSequence(drama, homeState, awayState)
  if (seq.length === 0) return 0
  return Math.round(sceneRevealT(seq) * sceneMs)
}

// ── 주인공 이벤트 선택자(단일 진실원) ─────────────────────────
// ★ 왜 하나여야 하나: 예전엔 한 분의 대표 이벤트를 두 곳이 따로 골랐다.
//   - 안무: EVENT_DWELL_MS 최댓값(부분 순서 + 동점은 events 배열 순서라는 우연)
//   - 음성: commentary-tts.SPOKEN_PRIORITY(goal>save>miss>corner>foul, shot·chance 제외)
//   두 규칙은 동점 처리와 후보 집합이 달라 "말한 것 ≠ 그린 것"이 될 수 있었다.
//   dwell 가중치는 '그 분이 얼마나 큰 분인가'(리듬)를 재는 값이지 '무엇을 보여줄까'의
//   기준이 아니다 — 동점(shot·save·miss 4300, corner·foul 2700)이 많아 순서를 정하지
//   못한다. 그래서 **명시적 전순서 목록**(음성 쪽 규칙의 확장)을 단일 규칙으로 채택했다.
// 주인공 선택자는 game/drama.ts가 정본이다 — commentary(game)도 같은 규칙을 써야 하는데
// playback이 commentary를 import하므로 여기 두면 순환이 된다. 기존 import 경로 호환을 위해
// 재수출만 남긴다.
export { DRAMA_PRIORITY, dramaRank, pickDramaEvent } from '../../game/drama'
import { pickDramaEvent } from '../../game/drama'

/**
 * **3D 하이라이트로 보여줄** 이벤트 타입. 나머지(코너·파울·경고·찬스)와 무사건 분은
 * 2D 작전판이 받는다.
 *
 * 왜 전부를 3D로 보내지 않나: 경기당 유의미 이벤트가 20~30건인데 장면 라이브러리는
 * 유한하다. 전부 3D로 돌리면 같은 장면이 금방 눈에 띈다. "하이라이트"의 뜻이 그거다 —
 * 중요한 것만 보여준다. 코너·파울은 결과가 아니라 국면이라 전술 보드에서 더 잘 읽힌다.
 *
 * ★ 반드시 DRAMA_PRIORITY의 부분집합이어야 한다(안무가 있는 타입만) — choreography와
 *   playback 테스트가 양방향으로 고정한다.
 */
export const HIGHLIGHT_TYPES: readonly MatchEventType[] = ['goal', 'save', 'miss', 'shot', 'red']

/** 이 이벤트를 3D 하이라이트로 재생하는가(false면 2D 작전판이 그 분을 받는다). */
export function isHighlightEvent(e: MatchEvent): boolean {
  return HIGHLIGHT_TYPES.includes(e.type)
}

/** 주인공 이벤트가 강조 발화(rate·pitch 상향 + 발화 중 선점) 대상인가. */
export function isImportantEvent(e: MatchEvent): boolean {
  return e.type === 'goal' || e.type === 'save'
}

/** 그 분 주인공 이벤트의 해설 발화 소요 시간(ms). 주인공이 없으면 0.
 *  speed는 발화 rate에 연동되므로(commentary-tts.utteranceRate) 함께 넘긴다 —
 *  2배속에서는 문장도 빨리 읽히므로 필요한 체류 하한이 그만큼 짧다.
 *
 *  ★ allEvents/seed: Phase C 이후 해설은 히스토리 의존이다(streak·골 종류·변형 억제).
 *  경기 전체 이벤트 배열과 시드를 넘겨야 실제 발화될 문장과 **같은** 문장을 추정한다.
 *  생략하면 그 분 이벤트만을 히스토리로 취급한다(맥락 없는 근사 — 단위 테스트용). */
export function minuteSpeechMs(
  eventsAtMinute: MatchEvent[],
  home: Team,
  away: Team,
  speed: PlaybackSpeed = 1,
  allEvents: readonly MatchEvent[] = eventsAtMinute,
  seed = 0,
  ctx: CommentaryCtx = {},
  minute?: number,
): number {
  return minuteSpeechParts(eventsAtMinute, home, away, speed, allEvents, seed, ctx, minute).pairMs
}

/**
 * 그 분 발화의 **두 조각** — 캐스터만 / 캐스터 + 해설.
 *
 * 왜 나눠야 하나: 발화가 장면 뒤로 밀리면서 "한 분에 다 담을 수 있는 발화"가 줄었다.
 * 캐스터 문장은 반드시 그 분 안에서 끝나야 한다(그 분의 결과를 말하는 사람이다).
 * 해설위원 문장은 넘쳐도 된다 — 실제 중계도 다음 국면이 시작된 뒤까지 골 이야기를
 * 이어 간다. 그래서 **하한은 캐스터, 참고치는 쌍**이다.
 */
export function minuteSpeechParts(
  eventsAtMinute: MatchEvent[],
  home: Team,
  away: Team,
  speed: PlaybackSpeed = 1,
  allEvents: readonly MatchEvent[] = eventsAtMinute,
  seed = 0,
  ctx: CommentaryCtx = {},
  minute?: number,
): { casterMs: number; pairMs: number } {
  const drama = pickDramaEvent(eventsAtMinute)
  if (!drama) {
    // 무사건 분 — 소강 구간 라인이 나올 수 있다. 짧지만 이것도 잘리면 안 된다.
    if (minute === undefined) return { casterMs: 0, pairMs: 0 }
    const flow = flowLineAt(allEvents, minute, home, away, seed)
    const ms = flow
      ? estimateSpeechMs(flow.speech, flow.speaker === 'analyst' ? 'analyst' : 'normal', speed)
      : 0
    return { casterMs: ms, pairMs: ms }
  }
  const line = commentateAt(allEvents, eventIndex(allEvents, drama), home, away, seed, ctx)
  // ★ 화자가 둘이면 총 발화가 길어진다 — 캐스터 + 해설을 합쳐서 하한을 잡아야
  //   해설이 다음 분에 잘리지 않는다(B-1 체류 보정의 화자 2인 확장).
  const role = casterRole(isImportantEvent(drama), line.intensity)
  return {
    casterMs: estimateSpeechMs(line.speech, role, speed),
    pairMs: estimatePairMs(line.speech, role, line.follow?.speech, speed),
  }
}

/** allEvents 안에서 이벤트의 위치. 참조가 다를 수 있으므로(스토어가 상태를 복제한다)
 *  참조 → 필드 동등 순으로 찾는다. 못 찾으면 마지막(= 히스토리 전체를 맥락으로). */
export function eventIndex(allEvents: readonly MatchEvent[], e: MatchEvent): number {
  const byRef = allEvents.indexOf(e)
  if (byRef >= 0) return byRef
  const byVal = allEvents.findIndex(
    x => x.minute === e.minute && x.type === e.type && x.teamId === e.teamId && x.playerId === e.playerId,
  )
  return byVal >= 0 ? byVal : allEvents.length - 1
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
  revealMs = 0,
): number {
  const rhythm = sceneDwellMs(eventsAtMinute, speed, clutch, scoreDiff)
  // 발화 길이 하한 → 상한 클램프. 말이 끝나기 전에 다음 분으로 넘어가지 않게 하되,
  // 긴 문장 하나가 화면을 무한정 붙잡지 못하도록 MAX_DWELL_MS로 막는다.
  //
  // ★ revealMs가 있으면 발화는 **그 뒤에** 시작한다(예지력 금지). 그래서 하한이
  //   `발화 길이`가 아니라 `결과 노출 + 반응 지연 + 발화 길이`가 된다.
  const floor = revealMs > 0 ? revealMs + REVEAL_LAG_MS + speechMs : speechMs
  return Math.min(MAX_DWELL_MS, Math.max(rhythm, Math.round(floor)))
}

/**
 * **안무가 실제로 재생되는 시간**(ms, 속도 적용 후) — 리듬 dwell 그 자체다.
 *
 * ★ dwell과 분리된 이유(2026-08-01): 예전에는 렌더러에도 최종 dwell(발화 하한이 반영된
 *   값)을 넘겼다. 안무 키프레임 t는 dwell 상대값이라 **발화가 길어질수록 장면이 느려졌고**,
 *   결과 노출 시각도 함께 밀려서 "발화를 결과 뒤로" 방정식이 스스로를 쫓았다
 *   (골 기준 필요 dwell이 22초로 발산한다). 지금은 안무가 자기 속도로 끝나고,
 *   남는 시간은 세리머니·중계의 여운이 된다 — 실제 중계의 리듬이기도 하다.
 */
export function sceneDwellMs(
  eventsAtMinute: MatchEvent[],
  speed: PlaybackSpeed,
  clutch: boolean,
  scoreDiff = 0,
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
  return Math.round(base / speed)
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
  allEvents: readonly MatchEvent[] = eventsAtMinute,
  seed = 0,
  ctx: CommentaryCtx = {},
  revealMs = 0,
): number {
  if (!speechEnabled) return minuteDwellMs(minute, eventsAtMinute, speed, clutch, scoreDiff, 0, revealMs)
  const parts = minuteSpeechParts(eventsAtMinute, home, away, speed, allEvents, seed, ctx, minute)
  // 발화가 결과 뒤로 밀린 분은 **캐스터만** 그 분 안에서 끝나면 된다(해설은 넘쳐도 된다).
  // 밀리지 않는 분(코너·파울·무사건)은 예전처럼 쌍 전체를 하한으로 쓴다.
  const speechMs = revealMs > 0 ? parts.casterMs : parts.pairMs
  return minuteDwellMs(minute, eventsAtMinute, speed, clutch, scoreDiff, speechMs, revealMs)
}
