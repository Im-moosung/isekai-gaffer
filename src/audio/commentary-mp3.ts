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
// ## 조회 규칙
// `public/tts/index.json`은 **발화 문자열 → 클립 키** 표다. 문장이 통째로 있으면
// 한 조각, 없으면 첫 `, ` 경계에서 둘로 갈라 각각을 찾는다
// (`골키퍼, 김승규입니다.` = `골키퍼,` + `김승규입니다.`).
// 그보다 더 잘게 쪼개지 않는다 — 이름 뒤 어미를 떼면 이음매가 음절 한복판에
// 떨어져 연음이 깨진다(docs/audio/tts/README.md).

import { audioAssetUrl, audioBus, decodeAudio } from './sfx'

/** 조각 사이 무음(ms). 매니페스트(`gapMs`)가 정본이고 이건 그 기본값이다. */
export const DEFAULT_GAP_MS = 90

interface ClipIndex {
  v: number
  gapMs: number
  clips: Record<string, string>
}

let index: ClipIndex | null = null
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
  loadState = 'idle'
  buffers.clear()
  active.clear()
  queueEndsAt = 0
}

/** 테스트용 주입 — 오디오 파일 없이 조회 규칙만 검증할 수 있게 한다. */
export function __setClipIndex(next: ClipIndex | null): void {
  index = next
  loadState = next ? 'ready' : 'absent'
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
      index = json
      loadState = 'ready'
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
  const whole = index.clips[s]
  if (whole) return [whole]
  // `골키퍼, 김승규입니다.` 처럼 도입 + 이름으로 갈리는 문장.
  const i = s.indexOf(', ')
  if (i > 0) {
    const head = index.clips[s.slice(0, i + 1)]
    const tail = index.clips[s.slice(i + 2)]
    if (head && tail) return [head, tail]
  }
  return null
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

export interface PlayOpts {
  /** 재생 속도 배율(1x/1.5x/2x). mp3에는 이미 atempo 1.15가 구워져 있고 그 위에 곱한다. */
  speed?: number
  /** true면 큐 꼬리에 이어 붙인다(대본 발화 — 순서 보존). false면 지금 낸다. */
  queued?: boolean
  /** 조각 사이 무음(ms). 생략 시 조회표 값. */
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
    const gap = (opts.gapMs ?? index?.gapMs ?? DEFAULT_GAP_MS) / 1000
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
      at += buf.duration / rate + gap
    }
    // 마지막 조각 뒤의 gap은 큐 꼬리에 넣지 않는다 — 문장 사이 간격은 호출부(대본)가 정한다.
    queueEndsAt = at - gap
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
