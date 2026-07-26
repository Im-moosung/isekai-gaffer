// src/audio/commentary-tts.ts
// 한국어 TTS 실시간 중계 — Web Speech API(speechSynthesis)로 해설 문장을 소리로 낸다.
// 발화 텍스트는 commentary.commentate() 산출을 그대로 쓴다(스펙 §7.1 세이프가드 통과 문장).
//
// 핵심 원칙(불변):
//  1) 미지원 브라우저·ko-KR 보이스 없음 = 조용한 no-op. 절대 throw하지 않는다(TTS 실패가 경기를 멈추지 않는다).
//  2) speechSynthesis 자동재생 요건은 관대하지만, 안전하게 킥오프(유저 제스처) 이후에만 발화한다.
//  3) [🎙 해설] 토글은 음소거(rematch-muted)와 별개로 localStorage('rematch-tts')에 기억한다. 기본값 ON.
//  4) 큐 정책: 발화 중이면 일반 라인은 스킵(드롭), important(골·세이브 등)는 현재 발화를 cancel 후 즉시.
//  5) pause·모드 전환 시 stopAll()로 진행 중 발화를 취소한다(작전 지시 중 해설이 새지 않게).

const TTS_KEY = 'rematch-tts'

// ── 발화 속도 상수 ────────────────────────────────────────────
/** utterance.rate 기본값 — important(골·세이브)는 빠르고 높게(흥분), 일반은 살짝만 빠르게. */
export const RATE_IMPORTANT = 1.15
export const RATE_NORMAL = 1.05

/** rate 상한. ★ 재생 속도 토글에 rate를 연동하되(아래 utteranceRate) 여기서 끊는다.
 *  근거(실측): '유나' 보이스는 rate 2.1에서 실효 7.1 음절/초로, 한국어 뉴스 앵커의
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
export function utteranceRate(important: boolean, speed = 1): number {
  const base = important ? RATE_IMPORTANT : RATE_NORMAL
  return Math.min(MAX_UTTERANCE_RATE, base * speed)
}

// ── 모듈 상태 ─────────────────────────────────────────────────
// available = speechSynthesis 존재 + ko-KR 보이스 발견(둘 다여야 실제 발화). 아니면 조용한 no-op.
let available = false
let voice: SpeechSynthesisVoice | null = null
let voiceInitStarted = false
// ttsOn = 유저 토글(localStorage 진실원). available과 독립 — 켜져 있어도 미지원이면 no-op.
let ttsOn = readStoredTts()

// ── speechSynthesis 접근(미지원이면 null) ─────────────────────
function getSynth(): SpeechSynthesis | null {
  try {
    return (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? null
  } catch {
    return null
  }
}

/** ko-KR 보이스로 발화 utterance를 만든다. important는 rate·pitch 상향 강조. */
function makeUtterance(line: string, important: boolean, speed: number): SpeechSynthesisUtterance | null {
  try {
    const U = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
      .SpeechSynthesisUtterance
    if (!U) return null
    const u = new U(line)
    if (voice) u.voice = voice
    u.lang = 'ko-KR'
    // important(골·세이브·승부차기): 빠르고 높게(흥분). 일반: 살짝만 빠르게.
    // 재생 속도 배율을 곱한다(빨리감기 중계는 실제로도 빨라져야 한다).
    u.rate = utteranceRate(important, speed)
    u.pitch = important ? 1.15 : 1.0
    return u
  } catch {
    return null
  }
}

// ── 보이스 초기화 ─────────────────────────────────────────────
/**
 * ko-KR 보이스를 탐색한다(1회). 보이스 목록이 비동기 로드되는 브라우저를 위해
 * voiceschanged 이벤트에도 재탐색한다. 끝까지 ko 보이스가 없으면 available=false로 남아 no-op.
 * 미지원(speechSynthesis 부재)이면 즉시 no-op.
 */
export function initVoice(): void {
  if (voiceInitStarted) return
  voiceInitStarted = true
  const synth = getSynth()
  if (!synth) {
    available = false
    return
  }
  const pick = (): void => {
    try {
      const voices = synth.getVoices?.() ?? []
      const ko = voices.find(v => (v.lang || '').toLowerCase().startsWith('ko'))
      if (ko) {
        voice = ko
        available = true
      }
    } catch {
      /* no-op — 탐색 실패는 available=false 유지 */
    }
  }
  pick()
  // 아직 못 찾았으면 보이스 목록 로드(voiceschanged) 후 재탐색.
  try {
    if (!available && typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', pick)
    }
  } catch {
    /* no-op */
  }
}

// ── 발화 ──────────────────────────────────────────────────────
/**
 * 한 줄을 음성 중계한다. 미지원·보이스 없음·토글 OFF·빈 문자열이면 조용한 no-op.
 * 큐 정책: 발화 중이면 일반 라인은 드롭, important는 현재 발화를 cancel 후 즉시 발화한다.
 */
export function speak(line: string, opts: { important?: boolean; speed?: number } = {}): void {
  if (!available || !ttsOn || !line) return
  const synth = getSynth()
  if (!synth) return
  try {
    const important = !!opts.important
    if (synth.speaking) {
      if (!important) return // 발화 중 일반 라인은 스킵(드롭) — 과밀 방지
      synth.cancel() // important는 선점: 현재 발화 취소 후 즉시
    }
    const u = makeUtterance(line, important, opts.speed ?? 1)
    if (u) synth.speak(u)
  } catch {
    /* no-op — TTS 실패가 경기를 멈추지 않는다 */
  }
}

/** 지금 speak()가 실제로 소리를 낼 수 있는 상태인가(보이스 확보 + 토글 ON).
 *  재생 체류 시간을 발화 길이만큼 늘릴지 판정하는 데 쓴다 — 해설이 꺼져 있으면
 *  늘릴 이유가 없다(무음인데 화면만 느려지면 안 된다). */
export function willSpeak(): boolean {
  return available && ttsOn
}

/** 진행 중인 모든 발화를 취소한다(pause·모드 전환·언마운트). 미지원이면 no-op. */
export function stopAll(): void {
  const synth = getSynth()
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    /* no-op */
  }
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
export function estimateSpeechMs(line: string, important = false, speed = 1): number {
  const syllables = countSyllables(line)
  if (syllables <= 0) return 0
  const rate = utteranceRate(important, speed)
  return Math.round((syllables / (SYLLABLES_PER_SEC * rate)) * 1000) + SPEECH_TAIL_MS
}
