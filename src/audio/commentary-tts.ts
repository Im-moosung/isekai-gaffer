// src/audio/commentary-tts.ts
// 한국어 중계 음성 — **미리 구운 Qwen TTS mp3 클립만** 낸다.
// 발화 텍스트는 commentary.commentate() 산출을 그대로 쓴다(스펙 §7.1 세이프가드 통과 문장).
//
// ## 왜 `speechSynthesis` 폴백을 전부 걷어냈나 (2026-08-02, 사용자 판정)
// 이 게임의 중계는 남성 캐스터·해설위원 클립 1,024개로 나간다. 예전에는 클립이 없는
// 문장만 브라우저 기본 TTS로 떨어뜨렸는데, 그러면 **그 한 문장만 macOS 기본 한국어
// 음성(여성 '유나')으로 튀어나온다.** 남성 캐스터가 말하다 갑자기 여성 목소리가
// 끼어드는 것은 "다양한 화자"가 아니라 **결함**으로 읽힌다 — 실제 플레이에서 사용자가
// 듣고 곧바로 완성도가 깎였다고 말했다.
//
// 폴백이 지키려던 것은 "정보를 잃지 않는다"였다. 그런데 **자막은 폴백과 무관하게 언제나
// 나온다**(MatchScreen이 문장을 화면에 띄운다). 즉 폴백이 없어도 잃는 정보는 없고,
// 잃는 것은 잘못된 목소리뿐이다. 그래서 **클립이 없으면 소리를 내지 않는다.**
// 커버리지 테스트(`__tests__/tts-coverage.test.ts`)는 17경기만 도므로 드문 조합은
// 언제든 샐 수 있다 — 폴백을 남겨 두면 같은 사고가 반복된다. 구조로 막는다.
//
// 핵심 원칙(불변):
//  1) 클립이 없으면 **침묵**. 절대 throw하지 않는다(오디오 실패가 경기를 멈추지 않는다).
//  2) AudioContext는 유저 제스처 뒤에만 열리므로, 킥오프 전에는 어차피 조용하다.
//  3) [🎙 해설] 토글은 음소거(rematch-muted)와 별개로 localStorage('rematch-tts')에 기억한다. 기본값 ON.
//  4) 큐 정책: 발화 중이면 일반 라인은 스킵(드롭), important(골·세이브 등)는 현재 발화를 끊고 즉시.
//  5) pause·모드 전환 시 stopAll()로 진행 중 발화를 취소한다(작전 지시 중 해설이 새지 않게).
//  6) 화자 2인(§5.7)은 **클립 자체**가 가른다 — 캐스터와 해설위원을 다른 목소리로 구웠다.
//     (예전에는 보이스가 하나뿐이라 pitch를 벌려 흉내 냈다. 그 상수 ROLE_PITCH는
//      speechSynthesis와 함께 사라졌다 — 이제 흉내 낼 대상이 없다.)
//  7) 재생·음소거·순서 보존은 전부 `commentary-mp3.ts`가 맡는다. 판정은 그 모듈의
//     `playLine()`이 돌려주는 boolean 하나다(동기). 클립 소스: `tools/tts/*`.
import * as mp3 from './commentary-mp3'

const TTS_KEY = 'rematch-tts'

// ── 화자·강도별 음성 프로파일 (§5.7) ──────────────────────────
/**
 * 발화 역할. 캐스터 3단(일반/중요/피크) + 해설위원 1단.
 *
 * ★ 예전엔 important를 `rate 1.15`로 처리했다. 그런데 **한국어 중계의 흥분은 "빠름"이
 *   아니라 "높고 길게"** 다. rate를 올리면 골 순간의 가장 중요한 정보인 선수 이름이
 *   뭉개진다. 그래서 중요·피크는 rate를 오히려 **낮춘다**(높이는 클립이 이미 담고 있다).
 *
 * ★ 폴백 제거(2026-08-02) 이후 이 값들은 **발화 길이 추정**({@link estimateSpeechMs})의
 *   기준으로 남는다 — 재생 루프가 분당 체류 시간을 잡을 때 쓰는 그 값이다.
 */
export type SpeechRole = 'normal' | 'important' | 'peak' | 'analyst'

/** 역할별 rate(1x 기준). 피크가 가장 느리다 — 골 순간은 천천히 내지른다. */
export const ROLE_RATE: Record<SpeechRole, number> = {
  normal: 1.05, important: 1.0, peak: 0.95, analyst: 1.0,
}

// ★ ROLE_PITCH(역할별 pitch)는 여기 있었고 2026-08-02에 지웠다. 보이스가 하나뿐인
//   speechSynthesis에서 캐스터와 해설위원을 갈라 놓으려고 pitch를 벌렸던 상수인데,
//   이제 화자는 클립 자체가 다르다 — 흉내 낼 이유가 없어졌다.

// 하위호환 별칭(예전 상수명을 쓰는 호출부·문서용).
export const RATE_IMPORTANT = ROLE_RATE.important
export const RATE_NORMAL = ROLE_RATE.normal

/** rate 상한. ★ 재생 속도 토글에 rate를 연동하되(아래 utteranceRate) 여기서 끊는다.
 *  근거(실측, speechSynthesis 시절): rate 2.1에서 실효 7.1 음절/초로, 한국어 뉴스 앵커의
 *  자연 발화 상단(6~7 음절/초)과 같은 수준이다 — 빠르지만 사람이 내는 속도다.
 *  그 이상은 알아듣기 어려워지고, 애초에 rate를 올려도 길이가 더 줄지 않는다
 *  (rate 1.8→2.1 구간에서 실효 음절/초가 7.17→7.07로 포화). */
export const MAX_UTTERANCE_RATE = 2.1

/**
 * 실제로 쓸 utterance.rate. 재생 속도(1x/1.5x/2x)에 비례해 올린다.
 * ★ 왜 연동하나: TTS 길이가 고정이면 2배속에서 문장이 체류 시간보다 길어져,
 *   말이 잘리거나(예전) 체류를 늘려 2배속이 무의미해진다(발화 하한만 넣었을 때
 *   실측 90분 재생이 127초 → 190초로 부풀었다). rate를 함께 올리면 둘 다 없다.
 */
export function utteranceRate(role: SpeechRole | boolean = 'normal', speed = 1): number {
  // boolean은 예전 시그니처(important) — 호출부를 한 번에 고치지 않아도 되게 받아 준다.
  const r: SpeechRole = typeof role === 'boolean' ? (role ? 'important' : 'normal') : role
  return Math.min(MAX_UTTERANCE_RATE, ROLE_RATE[r] * speed)
}

/** 캐스터 라인의 역할을 강도로 정한다 — 피크(골·퇴장)는 important보다 한 단계 더 낮고 높게. */
export function casterRole(important: boolean, intensity = 0): SpeechRole {
  if (intensity >= 3) return 'peak'
  return important ? 'important' : 'normal'
}

// ── 모듈 상태 ─────────────────────────────────────────────────
// ttsOn = 유저 토글(localStorage 진실원). 클립 준비 여부와 독립 — 켜져 있어도 클립이 없으면 침묵.
let ttsOn = readStoredTts()
/** 지금 진행 중인 대본(입장 소개)을 mp3로 낼 수 있는가. {@link beginScript}가 정한다. */
let scriptMp3 = false
/** 조회표를 이미 읽었는가. {@link initVoice}를 여러 번 불러도 한 번만 돌게 한다. */
let initStarted = false

// ── 초기화 ────────────────────────────────────────────────────
/**
 * 중계 음성 준비 — **클립 조회표를 읽는다**(1회).
 *
 * ★ 이름이 `initVoice`인 것은 유물이다. 예전에는 여기서 ko-KR **보이스**를 탐색했고
 *   (`speechSynthesis.getVoices()` + voiceschanged 재시도), 못 찾으면 조용한 no-op으로
 *   남았다. 폴백을 걷어낸 2026-08-02부터 탐색할 보이스가 없다 — 남은 일은 조회표뿐이다.
 *   호출부(MatchScreen 킥오프)가 여럿이라 이름은 그대로 둔다.
 *
 * 조회표는 보통 마운트에서 미리 읽힌다(MatchScreen). 여기 남겨 둔 호출은 그 경로가
 * 실패했을 때의 마지막 기회이고, `loadClipIndex()`는 스스로 중복을 막는다.
 */
export function initVoice(): void {
  if (initStarted) return
  initStarted = true
  mp3.loadClipIndex()
}

// ── 점유 판정 ─────────────────────────────────────────────────
/**
 * **지금 누군가 말하고 있는가.**
 *
 * ★ 예전에는 이 함수가 mp3와 speechSynthesis를 **함께** 봤다. 두 경로가 큐를 공유하지
 *   않아, 각자 자기 쪽만 보면 캐스터(mp3)와 해설(브라우저 음성)이 **동시에** 말하는
 *   사고가 났기 때문이다(2026-08-02 실사고). 폴백이 사라진 지금은 경로가 하나뿐이라
 *   겹칠 대상 자체가 없다 — 그 사고는 원인 쪽에서 소멸했다.
 */
function anySpeaking(): boolean {
  return mp3.clipsSpeaking()
}

/** 진행 중인 발화를 끊는다(important 선점 전용). */
function preempt(): void {
  mp3.stopAllClips()
}

// ── 발화 ──────────────────────────────────────────────────────
/**
 * 한 줄을 음성 중계한다. 토글 OFF·빈 문자열·**클립 없음**이면 조용한 no-op.
 * 큐 정책: 발화 중이면 일반 라인은 드롭, important는 현재 발화를 끊고 즉시 발화한다.
 *
 * ★ 클립이 없으면 **아무 소리도 내지 않는다**(파일 헤더 참조). 자막은 그대로 나가므로
 *   정보는 잃지 않는다 — 잃는 것은 잘못된 목소리뿐이다.
 *
 * `role`·`intensity`는 이제 소리를 바꾸지 않는다(억양은 클립에 구워져 있다). 호출부가
 * 이미 넘기고 있고 체류 시간 추정과 짝을 이루는 값이라 시그니처만 남긴다.
 */
export function speak(
  line: string, opts: { important?: boolean; speed?: number; role?: SpeechRole; intensity?: number } = {},
): void {
  if (!ttsOn || !line) return
  const important = !!opts.important
  if (anySpeaking()) {
    if (!important) return // 발화 중 일반 라인은 스킵(드롭) — 과밀 방지
    preempt() // important는 선점: 진행 중 발화를 끊고 즉시
  }
  mp3.playLine(line, { speed: opts.speed ?? 1, live: true })
}

/**
 * **곁들임 발화** — 해설위원의 받는 말과 소강 구간 라인 전용 채널.
 *
 * 큐 정책이 `speak()`와 정반대다:
 *  - 선점하지 않는다. 캐스터 문장을 잘라먹으면 안 된다(해설은 받아서 말하는 사람이다).
 *  - 드롭하지도 않는다. mp3 큐 꼬리(`queued`)에 붙이면 앞 발화가 끝난 **뒤에** 이어서
 *    나온다 — 이게 §5.6이 말하는 체이닝이고, 캐스터 → 해설의 자연스러운 턴 전환이
 *    공짜로 만들어진다.
 *
 * ★ 예전에는 여기에 "경로가 엇갈리면 버린다"는 가드가 있었다. mp3와 speechSynthesis가
 *   큐를 공유하지 않아, 캐스터가 mp3로 말하는 중에 이 함수가 브라우저 음성으로 떨어지면
 *   이어 붙는 게 아니라 **겹쳐서** 났기 때문이다. 경로가 하나가 된 지금은 큐가 하나뿐이라
 *   그 가드가 필요 없다 — 클립이 없으면 그냥 침묵한다.
 */
export function speakAside(
  line: string, opts: { speed?: number; role?: SpeechRole } = {},
): void {
  if (!ttsOn || !line) return
  // 선점하지 않고 mp3 큐 꼬리에 붙인다(캐스터 문장을 자르지 않는다).
  mp3.playLine(line, { speed: opts.speed ?? 1, queued: true, live: true })
}

/**
 * **대본 발화** — 입장 라인업 소개처럼 *미리 짜인 타임라인*이 발화 시각을 정하는 채널.
 *
 * 큐 정책이 둘 다와 다르다:
 *  - `speak()`처럼 드롭하지 않는다. 명단 중간의 이름 하나가 사라지면 화면 하이라이트와
 *    소리가 어긋난 채로 남은 스무 명이 계속 흘러간다 — 회복 불가능한 어긋남이다.
 *  - `speak()`처럼 선점(cancel)하지도 않는다. 앞 이름을 자르면서 다음 이름을 부르면
 *    명단이 아니라 소음이 된다.
 *  - 큐가 얼마나 밀렸든 붙인다. 대본이 이미 발화 길이(estimateSpeechMs)로 비트 간격을
 *    잡아 두었으므로 밀리는 것은 추정 오차뿐이고, 큐에 이어 붙이면 **순서는 언제나
 *    보존**된다(순서 보존 > 지연 없음).
 *
 * 취소는 호출부가 {@link stopAll}로 한다(건너뛰기·언마운트).
 */
export function speakScripted(
  line: string, opts: { speed?: number; role?: SpeechRole } = {},
): void {
  if (!ttsOn || !line) return
  // 대본은 큐 꼬리에 이어 붙인다 — mp3 실길이가 추정과 달라도 **순서는 보존**된다.
  // ★ scriptMp3는 {@link beginScript}가 **대본 전체**를 덮는다고 확인했을 때만 켜진다.
  //   덮이지 않으면 대본 전체가 침묵이다(아래 beginScript의 "전부 아니면 전무").
  if (!scriptMp3) return
  mp3.playLine(line, { speed: opts.speed ?? 1, queued: true })
}

/**
 * **대본 시작 선언**(입장 소개). 대본 전체가 mp3로 덮이는지 한 번에 판정하고,
 * 덮이면 클립을 미리 받아 둔다(시작 시각이 정해진 발화는 네트워크를 기다릴 수 없다).
 *
 * ★ **전부 아니면 전무**다. 한 줄이라도 클립이 없으면 대본 전체를 침묵으로 낸다 —
 *   반쯤만 소리가 나는 라인업 소개는 "몇 명은 빠뜨린" 것처럼 들린다.
 *   (폴백이 있던 시절엔 "통째로 브라우저 음성"이었다. 폴백이 사라져 그 자리가
 *    침묵이 됐을 뿐, 계약의 목적 — 한 대본 안에서 목소리가 갈리지 않는다 — 은 같다.)
 *
 * @returns mp3로 낼 것인가(호출부 로깅·테스트용). false면 이번 대본은 무음이다.
 */
export function beginScript(speeches: readonly string[]): boolean {
  scriptMp3 = mp3.canSpeakAll(speeches)
  if (scriptMp3) mp3.prefetch(speeches)
  // ★ 입장 연출이 도는 동안 **경기 중 중계 조각**도 받아 둔다. 대본이 mp3로
  //   덮이든 아니든 부른다 — 두 경로는 별개고, 여기가 킥오프 전에 유저 제스처
  //   뒤로 도는 유일한 지점이다(commentary-mp3.warmLive 주석 참조).
  mp3.warmLive()
  return scriptMp3
}

/**
 * 대본 종료. 다음 {@link beginScript}까지 **대본** mp3는 꺼진다.
 *
 * ★ 경기 중 중계에는 영향이 없다. `scriptMp3`는 {@link speakScripted} 한 곳만 보고,
 *   {@link speak}·{@link speakAside}는 줄마다 `mp3.playLine`이 스스로 판정한다.
 *   (2026-08-02: "경기 중은 mp3가 없으니 여기서 꺼야 한다"던 MatchScreen 주석은
 *    이제 사실이 아니다 — 조각이 생겼고, 끄는 것도 아니었다.)
 */
export function endScript(): void {
  scriptMp3 = false
}

/**
 * 지금 speak()가 실제로 소리를 낼 수 있는 상태인가(조회표 준비 + 토글 ON).
 * 재생 체류 시간을 발화 길이만큼 늘릴지 판정하는 데 쓴다 — 해설이 꺼져 있으면
 * 늘릴 이유가 없다(무음인데 화면만 느려지면 안 된다).
 *
 * ★ 폴백이 사라진 뒤로 **답은 mp3 가능 여부 하나**다. 예전엔 `available`(ko-KR 보이스)을
 *   OR로 함께 봤는데, 그 항을 남겨 두면 클립이 하나도 없는 환경에서 "소리가 난다"고
 *   답해 **무음인 채 화면만 느려진다**. 소비자는 MatchScreen의 `minuteDwellWithSpeech`다.
 *
 * ★ 자막·연출은 이 값과 무관하게 흐른다(reveal gate는 자기 타이머로 돈다).
 *   여기서 false가 나와도 정보가 사라지지 않는 이유다.
 */
export function willSpeak(): boolean {
  return ttsOn && mp3.clipsReady()
}

/** 진행 중인 모든 발화를 취소한다(pause·모드 전환·언마운트). */
export function stopAll(): void {
  mp3.stopAllClips()
}

/**
 * 일시정지 훅. **지금은 no-op이다** — 시그니처만 남긴다(MatchScreen이 frozen 토글에서 부른다).
 *
 * 예전에는 `speechSynthesis.pause()`로 발화를 문장 중간에서 얼렸다. 폴백이 사라진 지금
 * 남은 경로는 mp3뿐인데, **mp3에는 애초에 걸지 않았다**: Web Audio의
 * `AudioBufferSourceNode`는 한 번 멈추면 이어 재생할 수 없고(끊으면 그 문장은 사라진다),
 * mp3 조각은 0.5~2초라 일시정지 버튼을 누른 뒤 그만큼만 더 들리고 끝난다 —
 * 얼리지 않아도 화면과 어긋나지 않는다.
 *
 * 관전을 **떠나는** 조작(작전판 진입)은 여전히 {@link stopAll}이 맞다.
 */
export function pauseSpeech(): void {
  /* no-op — 위 주석 참조 */
}

/** {@link pauseSpeech}의 짝. 얼린 발화가 없으므로 마찬가지로 no-op이다. */
export function resumeSpeech(): void {
  /* no-op — pauseSpeech 참조 */
}

// ── 토글(localStorage 기억) ───────────────────────────────────
/** localStorage에서 TTS 활성 여부를 읽는다. 기본 ON — '0'만 OFF, 부재·오류 시 ON. */
export function readStoredTts(): boolean {
  try {
    return globalThis.localStorage?.getItem(TTS_KEY) !== '0'
  } catch {
    return true
  }
}

/** 현재 TTS 토글 상태(유저 설정). */
export function isTtsEnabled(): boolean {
  return ttsOn
}

/** TTS 토글 설정 + localStorage 반영. OFF로 끄면 진행 중 발화도 즉시 중단. */
export function setTtsEnabled(next: boolean): void {
  ttsOn = next
  try {
    if (next) globalThis.localStorage?.removeItem(TTS_KEY)
    else globalThis.localStorage?.setItem(TTS_KEY, '0')
  } catch {
    /* localStorage 미지원 — 메모리 상태만 유지 */
  }
  if (!next) stopAll()
}

/** TTS 토글 — 새 상태를 반환(UI 동기화용). */
export function toggleTts(): boolean {
  setTtsEnabled(!ttsOn)
  return ttsOn
}

// ── 발화 소요 시간 추정(순수 함수) ────────────────────────────
// ★ 왜 필요한가: 재생 루프의 분당 체류 시간(playback.minuteDwellMs)이 해설 길이와
//   무관하면 두 방향으로 어긋난다 — 체류가 짧으면 말이 끝나기 전에 다음 분으로 넘어가고
//   (다음 분 라인은 큐 정책상 드롭되어 "화면은 A인데 들리는 건 A-1분" 상태가 된다),
//   체류가 길면 말이 끝난 뒤 정적이 흐른다. 발화 길이를 추정해 체류의 하한으로 쓴다.
//   TTS 속도는 재생 속도 토글(1x/1.5x/2x)과 무관하므로, 이 추정치는 speed로 나누지 않는다.

/** rate 1.0 기준 한국어 TTS 발화 속도(음절/초).
 *  ★ 실측(2026-07-26, Chrome + macOS ko-KR 보이스 '유나', commentate() 실문장 8개를
 *  rate 1.05·1.15로 각각 발화하고 onstart→onend를 계측):
 *    - rate 1.05: 2915~3716ms, 음절당 회귀 기울기 170.1ms → 5.90 음절/초(rate 1.0 환산 5.62)
 *    - rate 1.15: 2729~3454ms, 음절당 회귀 기울기 148.9ms → 6.72 음절/초(rate 1.0 환산 5.84)
 *    - 두 rate 모두 고정 오버헤드(문두·문말 묵음) ~600ms로 rate와 거의 무관
 *  기울기 평균 5.7보다 살짝 보수적인 5.6을 쓴다(과소추정=말 잘림이 과대추정=정적보다 나쁨).
 *  이 값으로 실측 16건을 재현하면 최대 과소추정 60ms(최단 문장)로, 나머지는 전부 여유. */
export const SYLLABLES_PER_SEC = 5.6

/** 문장 길이와 무관한 고정 오버헤드 + 여운(ms). 실측 회귀 절편 558~648ms에서 650 채택.
 *  문두 묵음·문말 하강조·다음 분 전환 마진을 함께 흡수한다. */
export const SPEECH_TAIL_MS = 650

/**
 * 한국어 문장의 발화 음절 수를 센다(결정론·순수).
 * - 한글 음절(가~힣) 1음절.
 * - 숫자는 한국어 수사로 읽히며 자릿수보다 길다(72→"칠십이" 3음절, 8→"팔" 1음절).
 *   자리당 1.5음절로 근사한다.
 * - 그 외 문자(공백·구두점·따옴표)는 0 — 대신 SPEECH_TAIL_MS가 문말 여운을 담당한다.
 */
export function countSyllables(line: string): number {
  let n = 0
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0xac00 && c <= 0xd7a3) n += 1
    else if (ch >= '0' && ch <= '9') n += 1.5
  }
  return n
}

/**
 * 한 줄을 읽는 데 걸릴 시간(ms) 추정. speak()가 쓸 rate(utteranceRate)와 동일한 값으로
 * 계산한다 — 추정과 실제가 다른 rate를 쓰면 보정이 무의미해진다.
 *
 * 고 rate 구간에서는 보이스가 요청만큼 압축하지 않아(실효 음절/초가 5.6 → 7.1로 포화)
 * 이 추정이 최대 0.4초쯤 **과대**하게 나온다. 과대추정은 약간의 여운으로 끝나지만
 * 과소추정은 말이 잘리므로, 상수 하나로 보수적으로 가는 쪽을 택했다.
 */
export function estimateSpeechMs(line: string, role: SpeechRole | boolean = 'normal', speed = 1): number {
  const syllables = countSyllables(line)
  if (syllables <= 0) return 0
  const rate = utteranceRate(role, speed)
  return Math.round((syllables / (SYLLABLES_PER_SEC * rate)) * 1000) + SPEECH_TAIL_MS
}

/**
 * 캐스터 라인 + 이어지는 해설 라인의 **총** 발화 시간(ms).
 * 화자가 둘이 되면 한 이벤트의 발화가 길어진다 — 체류 시간(dwell)이 이만큼 늘지 않으면
 * 해설이 다음 분에 잘려 나간다. 재생 루프가 쓰는 하한이 바로 이 값이다.
 *
 * @param caster [문장, 역할]
 * @param analyst 이어 붙는 해설 문장(없으면 undefined).
 */
export function estimatePairMs(
  caster: string, role: SpeechRole, analyst: string | undefined, speed = 1,
): number {
  const a = estimateSpeechMs(caster, role, speed)
  if (!analyst) return a
  // 체이닝 할인: 두 유터런스는 같은 큐에서 연속 재생되므로 **문두 묵음이 한 번만** 든다.
  // SPEECH_TAIL_MS(650)는 문두 묵음 + 문말 여운 + 분 전환 마진을 합친 값이고,
  // 이어 붙는 쪽에 필요한 건 문말 여운뿐이다. 절반보다 조금 적은 400을 뺀다
  // (250이 남으므로 문말 하강조는 그대로 확보된다).
  const chained = Math.max(0, estimateSpeechMs(analyst, 'analyst', speed) - PAIR_CHAIN_DISCOUNT_MS)
  return a + chained
}

/** 이어 붙는 유터런스의 문두 묵음 절감분(ms). estimatePairMs 참조. */
export const PAIR_CHAIN_DISCOUNT_MS = 400
