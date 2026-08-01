// src/audio/commentary-mp3.ts
// 미리 구워 둔 중계 mp3 재생. `commentary-tts.ts`의 **1차 경로**이고,
// 여기서 못 내면 그 모듈이 `speechSynthesis`로 떨어진다(폴백은 지우지 않는다).
//
// 핵심 원칙(불변):
//  1) **AudioContext를 만들지 않는다.** `sfx.audioBus()`가 유저 제스처에서 연 것을
//     빌려 쓴다 — 그래야 음소거 토글 **하나**(`sfx.setMuted`)가 효과음·BGM·해설을
//     한 번에 끊는다. 컨텍스트가 아직 없으면(제스처 전·jsdom·SSR) 조용히 false를
//     돌려주고 폴백이 받는다.
//  2) 어떤 경로에서도 throw하지 않는다. 오디오 실패가 경기를 멈추지 않는다.
//  3) **HTMLAudioElement를 쓰지 않는다.** jsdom에 반쪽만 있어 테스트가 환경에
//     따라 갈린다(bgm.ts가 같은 이유로 Web Audio만 쓴다). 여기도 fetch +
//     decodeAudioData + AudioBufferSourceNode만 쓴다.
//  4) 순서 보존 — 대본 발화(입장 소개)는 큐 꼬리 시각에 이어 붙인다. 추정 길이와
//     실제 mp3 길이가 달라도 **순서는 절대 뒤집히지 않는다**.
//
// ## 조회 규칙 — **임의 개수 조각의 최소 분해**
// `public/tts/index.json`은 **발화 문자열 → 클립 키** 표다. 문장이 통째로 있으면
// 한 조각. 없으면 조회표에 있는 조각들로 문장을 **빈틈없이** 덮는 분해를 찾되,
// 조각 수가 **최소**가 되는 것을 고른다(= 이음매 최소). 같은 조각 수면 앞 조각이
// 긴 쪽을 택한다.
//
// ★ 왜 최소 조각인가: 이음매 하나마다 억양이 한 번 끊긴다. 입장 소개(이음매 1개)는
//   사용자 승인을 받았지만 경기 중계는 `여기서, / 전반 4분, / 파트리크 시크 / 의 슛…`
//   처럼 넷까지 갈 수 있다. 조각 목록 자체를 이음매가 적게 나오도록 설계했고
//   (`tools/tts/live-corpus.mjs` — 실측 평균 0.67), 런타임은 그 설계를 **그대로 복원**
//   해야 한다. 탐욕적 최장일치는 `대한민국` 뒤에 `,`가 붙은 클립이 있으면 짧은 쪽을
//   먼저 집어 실패할 수 있어 쓰지 않는다. 동적계획법이라 실패가 없다.
//
// ★ 덮이지 않는 문장은 **그 문장만** 폴백한다(대본과 다르다 — `canSpeakAll` 참조).
//   경기 중 문장은 서로 독립이라 한 줄이 브라우저 음성으로 나도 회복된다.
//   그래도 티는 나므로 커버리지 100%가 목표다(`__tests__/tts-coverage.test.ts`).

import { audioAssetUrl, audioBus, decodeAudio } from './sfx'

/** 조각 사이 무음(ms). 매니페스트(`gapMs`)가 정본이고 이건 그 기본값이다. */
export const DEFAULT_GAP_MS = 90

/**
 * **문장 안** 이음매의 무음(ms). 대본(입장 소개)의 90ms보다 짧다 —
 * 명단 낭독은 이름 사이에 숨을 쉬는 게 자연스럽지만, 문장 한복판에서 90ms를 쉬면
 * 말이 끊긴 것처럼 들린다. 조각 경계는 대부분 쉼표 뒤라 클립 자체에 이미 여운이 있다.
 */
export const DEFAULT_LIVE_GAP_MS = 40

interface ClipIndex {
  v: number
  gapMs: number
  /** 문장 안 이음매용 무음(ms). 없으면 {@link DEFAULT_LIVE_GAP_MS}. */
  liveGapMs?: number
  clips: Record<string, string>
  /** 미리 받아 둘 클립 키 — **빈도 내림차순**. {@link warmLive} 참조. */
  warm?: string[]
}

let index: ClipIndex | null = null
/** 조회표 키의 최대 길이. 분해 DP의 탐색 폭을 여기서 끊는다. */
let maxKeyLen = 0
/** 분해 결과 캐시(같은 문장이 경기마다 되풀이된다). */
const resolved = new Map<string, string[] | null>()
let loadState: 'idle' | 'loading' | 'ready' | 'absent' = 'idle'
/** 디코드 캐시. null = 로드 실패(그 문장은 영구 폴백). */
const buffers = new Map<string, AudioBuffer | null>()
/** 재생 중인 소스 — stopAllClips()가 전부 끊는다. */
const active = new Set<AudioBufferSourceNode>()
/** 대본 큐의 꼬리 시각(AudioContext 시간). 순서 보존의 근거. */
let queueEndsAt = 0

/** 테스트용 리셋. 프로덕션 경로에서는 부르지 않는다. */
export function __resetClips(): void {
  index = null
  maxKeyLen = 0
  resolved.clear()
  loadState = 'idle'
  buffers.clear()
  active.clear()
  queueEndsAt = 0
  warmed = false
}

/** 테스트용 주입 — 오디오 파일 없이 조회 규칙만 검증할 수 있게 한다. */
export function __setClipIndex(next: ClipIndex | null): void {
  index = next
  loadState = next ? 'ready' : 'absent'
  resolved.clear()
  maxKeyLen = 0
  for (const k of Object.keys(next?.clips ?? {})) if (k.length > maxKeyLen) maxKeyLen = k.length
}

/**
 * 클립 조회표를 한 번 읽는다(비동기·실패해도 조용하다).
 * 파일이 없으면 `absent`로 남고 모든 재생 요청이 false를 돌려준다 = 전면 폴백.
 */
export function loadClipIndex(): void {
  if (loadState !== 'idle') return
  loadState = 'loading'
  const f = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof f !== 'function') {
    loadState = 'absent'
    return
  }
  void (async () => {
    try {
      const res = await f(audioAssetUrl('tts/index.json'))
      if (!res.ok) throw new Error(`http ${res.status}`)
      const json = (await res.json()) as ClipIndex
      if (!json || typeof json.clips !== 'object') throw new Error('bad index')
      __setClipIndex(json)
    } catch {
      index = null
      loadState = 'absent'
    }
  })()
}

/**
 * 발화 문자열 → 클립 키 배열. 없으면 null(= 폴백해라).
 * 순수 함수 — 조회표만 본다. 오디오가 로드됐는지는 따지지 않는다.
 */
export function resolveClips(speech: string): string[] | null {
  if (!index) return null
  const s = speech.trim()
  if (!s) return null
  const hit = resolved.get(s)
  if (hit !== undefined) return hit
  const out = decompose(s, index.clips)
  // 캐시는 한 경기의 문장 수(약 200)보다 넉넉하되 무한히 자라지 않게 끊는다.
  // 문장은 (분 × 선수 × 사건)의 곱이라 오래 켜 두면 계속 새로 생긴다.
  if (resolved.size > 4000) resolved.clear()
  resolved.set(s, out)
  return out
}

/**
 * 문장을 조회표의 조각으로 덮는 **최소 조각 수** 분해. 못 덮으면 null.
 *
 * 뒤에서 앞으로 채우는 동적계획법이다. `dp[i]` = `s.slice(i)`를 덮는 최소 조각 수.
 * 후보 길이를 **긴 것부터** 보고 `<`로만 갱신하므로, 조각 수가 같으면 **앞 조각이
 * 긴** 분해가 남는다 — 이름처럼 짧은 조각을 앞세우지 않는다.
 *
 * 길이 상한(`maxKeyLen`)이 있어 실질 O(n·L)이고 n은 한 문장(≤80자)이다.
 */
function decompose(s: string, clips: Record<string, string>): string[] | null {
  const n = s.length
  const dp = new Array<number>(n + 1).fill(Infinity)
  const nextAt = new Array<number>(n + 1).fill(-1)
  const keyAt = new Array<string>(n + 1).fill('')
  dp[n] = 0
  for (let i = n - 1; i >= 0; i--) {
    const hi = Math.min(n, i + maxKeyLen)
    for (let j = hi; j > i; j--) {
      if (dp[j] === Infinity) continue
      const k = clips[s.slice(i, j)]
      if (k !== undefined && dp[j] + 1 < dp[i]) {
        dp[i] = dp[j] + 1
        nextAt[i] = j
        keyAt[i] = k
      }
    }
    // ★ 조각 **사이의 공백은 공짜로 건너뛴다**. 조회표 키는 앞뒤 공백을 턴
    //   문자열이고(`골키퍼,` `김승규입니다.`), 그 사이 한 칸은 어차피 이음매 무음이
    //   대신한다. 이걸 허용하지 않으면 `골키퍼, 김승규입니다.`가 덮이지 않는다.
    //   조각 수를 늘리지 않으므로 분해 선택에도 영향이 없다.
    if (s[i] === ' ' && dp[i + 1] < dp[i]) {
      dp[i] = dp[i + 1]
      nextAt[i] = i + 1
      keyAt[i] = ''
    }
  }
  if (dp[0] === Infinity) return null
  const out: string[] = []
  for (let i = 0; i !== n; i = nextAt[i]) if (keyAt[i]) out.push(keyAt[i])
  return out
}

/** 이 문장을 mp3로 낼 수 있는가(조회표 기준). 오디오 로드 실패는 재생 시점에 걸러진다. */
export function hasClips(speech: string): boolean {
  return resolveClips(speech) !== null
}

/**
 * 여러 문장을 **한 덩어리로** 낼 수 있는가.
 * ★ 입장 소개는 전부 아니면 전무다. 스물 몇 줄 중 몇 줄만 mp3로 나오면
 *   한 사람이 문장마다 목소리를 바꾸는 소리가 난다 — 통째로 폴백하는 편이 낫다.
 */
export function canSpeakAll(speeches: readonly string[]): boolean {
  return speeches.length > 0 && speeches.every(s => hasClips(s))
}

/** 조회표가 준비됐는가(= mp3 경로가 살아 있는가). */
export function clipsReady(): boolean {
  return loadState === 'ready' && index !== null
}

function clipUrl(key: string): string {
  return audioAssetUrl(`tts/${key}.mp3`)
}

/** 클립 하나를 디코드해 캐시한다. 실패는 null로 기억해 다시 시도하지 않는다. */
async function fetchBuffer(ctx: AudioContext, key: string): Promise<AudioBuffer | null> {
  const hit = buffers.get(key)
  if (hit !== undefined) return hit
  const f = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof f !== 'function') return null
  try {
    const res = await f(clipUrl(key))
    if (!res.ok) throw new Error(`http ${res.status}`)
    const buf = await decodeAudio(ctx, await res.arrayBuffer())
    buffers.set(key, buf)
    return buf
  } catch {
    buffers.set(key, null)
    return null
  }
}

/**
 * 조회표에 있는 문장의 클립을 미리 받아 둔다. 입장 연출처럼 **시작 시각이 정해진**
 * 발화는 첫 재생에서 네트워크를 기다리면 그림과 어긋난다.
 */
export function prefetch(speeches: readonly string[]): void {
  const bus = audioBus()
  if (!bus) return
  for (const s of speeches) {
    for (const k of resolveClips(s) ?? []) void fetchBuffer(bus.ctx, k)
  }
}

/** {@link warmLive}가 동시에 여는 fetch 수. 브라우저 연결 한도(6)에 맞춘다. */
const WARM_CONCURRENCY = 6
let warmed = false

/**
 * **경기 중 중계 클립을 미리 받아 둔다.** 입장 연출이 시작될 때 한 번 부른다.
 *
 * ★ 왜 필요한가: {@link playLine}은 **동기**로 판정하므로 아직 못 받은 클립이 있으면
 *   그 줄은 `speechSynthesis`로 떨어진다. 경기 중 조각은 800개가 넘어 그냥 두면
 *   **모든 조각의 첫 등장이 브라우저 음성**이 된다 — 목소리가 계속 갈리는 그 증상이다.
 *   입장 연출은 13~63초짜리라 그 사이에 받아 두면 킥오프 시점엔 대부분 준비된다.
 *
 * 순서는 조회표의 `warm`(코퍼스 빈도 내림차순)을 그대로 따른다 — 늦게 도착해도
 * **자주 쓰는 것부터** 준비된다. 실패는 조용히 넘긴다(그 조각만 폴백).
 */
export function warmLive(): void {
  if (warmed || !index?.warm?.length) return
  const bus = audioBus()
  if (!bus) return // 아직 유저 제스처 전 — 다음 호출에서 다시 시도한다.
  warmed = true
  const queue = [...index.warm]
  let i = 0
  const pump = async (): Promise<void> => {
    while (i < queue.length) {
      const k = queue[i++]
      if (buffers.has(k)) continue
      await fetchBuffer(bus.ctx, k)
    }
  }
  for (let c = 0; c < WARM_CONCURRENCY; c++) void pump()
}

export interface PlayOpts {
  /** 재생 속도 배율(1x/1.5x/2x). mp3에는 이미 atempo 1.15가 구워져 있고 그 위에 곱한다. */
  speed?: number
  /** true면 큐 꼬리에 이어 붙인다(대본 발화 — 순서 보존). false면 지금 낸다. */
  queued?: boolean
  /** true면 **문장 안** 이음매용 짧은 무음을 쓴다(경기 중 중계). 생략 시 대본용 무음. */
  live?: boolean
  /** 조각 사이 무음(ms). 생략 시 위 두 기본값. */
  gapMs?: number
}

/** 재생 속도 상한 — 이 위로는 알아듣지 못한다(speechSynthesis의 MAX_UTTERANCE_RATE와 같은 취지). */
const MAX_RATE = 2

/**
 * 한 줄을 mp3로 낸다. **동기적으로 true/false를 돌려준다** — 호출부가 그 자리에서
 * "폴백할까"를 정해야 하기 때문이다. 그래서 판정은 *조회표 + 이미 디코드된 버퍼*로만
 * 한다. 아직 못 받은 클립이 있으면 false를 돌려주고(그 줄은 폴백), 백그라운드로 받아
 * 둔다 — 다음 경기·다음 줄부터는 mp3가 나온다.
 */
export function playLine(speech: string, opts: PlayOpts = {}): boolean {
  const keys = resolveClips(speech)
  if (!keys) return false
  const bus = audioBus()
  if (!bus) return false
  const bufs: AudioBuffer[] = []
  for (const k of keys) {
    const b = buffers.get(k)
    if (b === undefined) {
      void fetchBuffer(bus.ctx, k) // 다음 번을 위해 받아 둔다
      return false
    }
    if (b === null) return false
    bufs.push(b)
  }
  try {
    const { ctx, master } = bus
    const rate = Math.min(MAX_RATE, Math.max(0.5, opts.speed ?? 1))
    const fallbackGap = opts.live
      ? (index?.liveGapMs ?? DEFAULT_LIVE_GAP_MS)
      : (index?.gapMs ?? DEFAULT_GAP_MS)
    const gap = (opts.gapMs ?? fallbackGap) / 1000
    const now = ctx.currentTime
    let at = opts.queued ? Math.max(now, queueEndsAt) : now
    for (const buf of bufs) {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = rate
      src.connect(master)
      src.start(at)
      active.add(src)
      src.onended = () => active.delete(src)
      // ★ 무음도 rate로 나눈다. 2배속에서 소리만 빨라지고 이음매는 그대로면 조각이
      //   넷인 문장이 체류 시간(playback.minuteDwellMs)을 넘어 다음 분에 잘린다.
      //   `estimateSpeechMs`가 rate로 나눈 값을 하한으로 쓰므로 여기도 같아야 한다.
      at += (buf.duration + gap) / rate
    }
    // 마지막 조각 뒤의 gap은 큐 꼬리에 넣지 않는다 — 문장 사이 간격은 호출부(대본)가 정한다.
    queueEndsAt = at - gap / rate
    return true
  } catch {
    return false
  }
}

/** 진행 중인 모든 클립을 끊는다(일시정지·모드 전환·언마운트). */
export function stopAllClips(): void {
  for (const src of [...active]) {
    try {
      src.stop()
    } catch {
      /* 이미 끝났다 */
    }
    active.delete(src)
  }
  const bus = audioBus()
  queueEndsAt = bus ? bus.ctx.currentTime : 0
}

/** 지금 mp3가 울리고 있는가(큐 포함). `speechSynthesis.speaking`에 대응한다. */
export function clipsSpeaking(): boolean {
  const bus = audioBus()
  if (!bus) return false
  return active.size > 0 && queueEndsAt > bus.ctx.currentTime
}
