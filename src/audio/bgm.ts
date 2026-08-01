// src/audio/bgm.ts
// 배경음악 — public/bgm/M01~M11.mp3(사용자 자작 음원, 규격 docs/audio/bgm-spec.md).
//
// ★ 가장 중요한 설계 결정: **경기 중에는 음악을 깔지 않는다.**
//   이미 관중 루프 + 원샷 효과음 + 한국어 TTS 2화자가 돌고 있고, 실제 축구 중계도
//   인플레이에 음악을 쓰지 않는다. 유일한 예외가 M09 클러치 베드(80분 이후 + 1골 차
//   이내, −28 LUFS 서브베이스)다. 나머지 음악은 전부 **경기가 멈춰 있는 화면**의 것이다.
//
// 핵심 원칙(sfx.ts의 규약을 그대로 물려받는다 — 새 규약을 만들지 않는다):
//  1) AudioContext는 sfx가 유저 제스처에서 연 것을 **공유**한다(sfx.audioBus).
//     제스처 전에는 재생 요청을 "원하는 상태"로 기억만 하고 소리를 내지 않는다
//     (랜딩 M01이 첫 클릭 전에 울리면 브라우저가 막고 콘솔 경고가 뜬다).
//  2) 출력은 sfx의 masterGain에 붙는다 → **기존 음소거 토글 하나가 BGM도 끊는다.**
//     별도 토글을 만들지 않는다(컨트롤이 이미 7개다).
//  3) 어떤 경로에서도 throw하지 않는다. 음악 실패가 경기를 멈추지 않는다.
//  4) Math.random·Date 미사용(결정론 계약). 시간은 전부 AudioContext.currentTime과
//     performance.now()로만 잰다. 엔진·스토어를 건드리지 않는다.
//
// 오디오 그래프:
//   [loop voice]  ─┐
//   [sting voice] ─┴→ bus(장면 게인) → duck(골·실점 0.1배) → sfx.masterGain(음소거) → 출력

import { audioAssetUrl, audioBus, decodeAudio, init as initAudio, onAudioUnlock } from './sfx'

/** 음원 ID — docs/audio/bgm-spec.md의 곡 번호와 1:1. */
export type BgmTrack =
  | 'M01' | 'M02' | 'M03' | 'M04' | 'M05' | 'M06'
  | 'M07' | 'M08' | 'M09' | 'M10' | 'M11'

/**
 * 루프가 도는 **장면**. 전부 "경기가 멈춰 있는" 표면이다(clutch만 예외 — 아래 참조).
 *  - landing  M01 랜딩 테마
 *  - hub      M02 허브(여정)
 *  - warroom  M03 워룸(킥오프 전 전술 설계)
 *  - tactics  M04 작전판(감독 타임·하프타임)
 *  - shootout M05 승부차기
 *  - clutch   M09 클러치 베드 — **유일하게 인플레이에 도는 음악**. 80분 이후 + 1골 차 이내.
 */
export type BgmScene = 'landing' | 'hub' | 'warroom' | 'tactics' | 'shootout' | 'clutch'

const SCENE_TRACK: Record<BgmScene, BgmTrack> = {
  landing: 'M01', hub: 'M02', warroom: 'M03', tactics: 'M04', shootout: 'M05', clutch: 'M09',
}

/** 루프 트랙(이음매 없이 반복). 그 외는 스팅(1회 재생). */
const LOOPING: ReadonlySet<BgmTrack> = new Set<BgmTrack>(['M01', 'M02', 'M03', 'M04', 'M05', 'M09'])

/** 화면 전환 크로스페이드(ms). 스펙 §배선 "300~500ms, 하드 컷 금지". */
export const CROSSFADE_MS = 400

/** 골·실점 순간 덕킹 배율 — 관중음에 쓴 값과 같다(8a35662). */
export const DUCK_RATIO = 0.1

/** 덕킹 유지 시간(ms). 관중 스웰(4s)보다 짧게 잡아 함성이 걷히기 전에 음악이 돌아온다. */
export const DUCK_HOLD_MS = 2600

/**
 * 스팅 덕킹이 풀리는 데 걸리는 시간(ms) — `playSting({ duckUntilMs })` 전용.
 *
 * 왜 램프인가(= 왜 완전 무음이 아닌가): 이 계약의 유일한 손님인 M06은 "11초쯤 정점 →
 * 13.8초에 해소"로 만들어진 팡파르다. 소개 구간을 게인 0으로 막았다가 풀면, 곡의 **가장
 * 큰 소절**이 예고 없이 튀어나온다 — 스펙 §배선의 "하드 컷 금지"를 정면으로 어긴다.
 * DUCK_RATIO로 깔아 두면 캐스터의 마지막 이름들 밑에 팡파르가 이미 스며 있다가 소개가
 * 끝나는 순간 부풀어 오른다(실제 중계가 명단 낭독 꼬리에서 하는 바로 그 동작).
 * 900ms는 한 소절(≈2초)보다 짧아 "지금 커졌다"가 들리면서, 400ms(CROSSFADE_MS)처럼
 * 스위치를 켠 것으로는 들리지 않는 값이다.
 */
export const STING_UNDUCK_MS = 900

/** 장면을 null로 내릴 때의 유예(ms). setScene 주석 참조 — 화면 전환의 언마운트/마운트
 *  틈에서 음악이 끊기지 않게 하는 값이라, 크로스페이드(400ms)보다 짧아야 한다. */
const NULL_GRACE_MS = 250

/** 일시정지 진입·해제 페이드(ms). 하드 스톱은 클릭 노이즈를 낸다. */
const PAUSE_FADE_MS = 140

/**
 * 트랙별 출력 게인. 파일이 이미 라우드니스 정규화(루프 −20 / 스팅 −16 / M09 −28 LUFS)되어
 * 있으므로 곡 간 균형은 파일이 맡고, 여기서는 효과음·중계 대비 **음악 전체의 자리**만 정한다.
 * 0.8: 관중 루프(0.04~0.30)와 TTS(−16 LUFS) 밑으로 들어가되 존재는 남는 값.
 */
const TRACK_GAIN: Partial<Record<BgmTrack, number>> = {
  // M09는 애초에 −28 LUFS로 만들어져 있다. 여기서 더 줄이면 들리지 않는다.
  M09: 1,
}
const DEFAULT_GAIN = 0.8

/** 디코드 버퍼 캐시 상한. 루프 1곡 = 28.8s·48kHz·스테레오 ≈ 11MB(Float32)라 전부 들고 있으면
 *  한 세션에 100MB를 넘는다. 재방문 비용(HTTP 캐시 + 디코드 ~150ms)이 훨씬 싸다. */
const CACHE_MAX = 4

// ── 모듈 상태 ─────────────────────────────────────────────────
interface Voice {
  track: BgmTrack
  gain: GainNode
  src: AudioBufferSourceNode | null
  /** 버퍼 안에서 지금 재생 중인 위치(초) — 일시정지 재개의 기준점. */
  offset: number
  /** src.start()에 넘긴 ctx 시각(초). */
  startedAt: number
  duration: number
  loop: boolean
}

let bus: GainNode | null = null
let duckNode: GainNode | null = null
let loopVoice: Voice | null = null
let stingVoice: Voice | null = null
/** 페이드아웃 중인 보이스들(크로스페이드가 실제로 겹치는지 실측할 수 있게 남긴다). */
const fading: Voice[] = []

/** 원하는 장면(제스처 전에도 기억해 둔다 — 컨텍스트가 열리면 그때 시작한다). */
let wantedScene: BgmScene | null = null
/** 원하는 스팅(로드 대기·제스처 대기 중인 1회 재생 요청). */
let wantedSting: { track: BgmTrack; alignEndAtMs?: number; duckUntilMs?: number; requestedAt: number } | null = null
/** 스팅이 끝나는 ctx 시각(초). 그때까지 루프 시작을 미룬다 — 겹치면 둘 다 죽는다. */
let stingEndsAt = 0
let stingTimer: ReturnType<typeof setTimeout> | undefined
/** setScene(null) 유예 타이머. */
let nullTimer: ReturnType<typeof setTimeout> | undefined
let paused = false

const buffers = new Map<BgmTrack, AudioBuffer>()
const loadingTracks = new Set<BgmTrack>()
/** 로드·디코드에 실패한 트랙(재시도 금지 — loadTrack 주석 참조). */
const failedTracks = new Set<BgmTrack>()
/** LRU 순서(뒤가 최근). */
const recent: BgmTrack[] = []

let unlockHooked = false
let gestureHooked = false

// ── 그래프 준비 ───────────────────────────────────────────────
/** sfx가 연 컨텍스트에 BGM 버스를 붙인다. 컨텍스트가 아직 없으면 null(=조용한 대기). */
function ensureBus(): { ctx: AudioContext; bus: GainNode } | null {
  hookUnlock()
  const g = audioBus()
  if (!g) return null
  try {
    if (!bus || !duckNode) {
      duckNode = g.ctx.createGain()
      duckNode.gain.value = 1
      duckNode.connect(g.master)
      bus = g.ctx.createGain()
      bus.gain.value = 1
      bus.connect(duckNode)
    }
    return { ctx: g.ctx, bus }
  } catch {
    bus = null
    duckNode = null
    return null
  }
}

/** 컨텍스트가 열리는 순간(sfx.init) 대기 중이던 장면·스팅을 실제로 시작한다. */
function hookUnlock(): void {
  if (unlockHooked) return
  unlockHooked = true
  try {
    onAudioUnlock(() => {
      applyScene()
      if (wantedSting) startSting(wantedSting.track)
    })
  } catch {
    /* no-op */
  }
}

/**
 * **첫 유저 제스처에서 오디오를 연다.** 킥오프 버튼(sfx.init)만으로는 늦다 —
 * 허브(M02)·워룸(M03)은 킥오프보다 먼저 나오는 화면이라 첫 경기에서 영영 무음이 된다.
 * 그래서 화면 아무 곳의 첫 클릭·첫 키 입력에서 **같은 경로(sfx.init)**를 한 번 호출한다.
 * 자동재생 정책을 우회하는 게 아니라 정책이 요구하는 제스처를 그대로 쓰는 것이다.
 * 랜딩 M01은 이 첫 클릭 전에는 울리지 않는다(= 첫 방문의 랜딩은 무음, 캠페인을 마치고
 * 돌아온 랜딩에는 테마가 깔린다).
 */
function hookFirstGesture(): void {
  if (gestureHooked) return
  gestureHooked = true
  try {
    const w = globalThis as unknown as {
      addEventListener?: (t: string, f: () => void, o?: AddEventListenerOptions) => void
    }
    if (typeof w.addEventListener !== 'function') return
    const unlock = (): void => initAudio()
    w.addEventListener('pointerdown', unlock, { once: true, capture: true })
    w.addEventListener('keydown', unlock, { once: true, capture: true })
  } catch {
    /* no-op */
  }
}

// ── 버퍼 로드 ─────────────────────────────────────────────────
function touch(track: BgmTrack): void {
  const i = recent.indexOf(track)
  if (i >= 0) recent.splice(i, 1)
  recent.push(track)
  while (recent.length > CACHE_MAX) {
    const old = recent.shift()
    // 지금 소리를 내고 있는 트랙은 버리지 않는다(버퍼를 놓아도 재생 중 src는 살아 있지만,
    // 일시정지 재개·크로스페이드에서 다시 필요하다).
    if (!old || old === loopVoice?.track || old === stingVoice?.track) continue
    buffers.delete(old)
  }
}

/** 트랙 하나를 fetch + decode 한다(중복 호출 안전). 완료 후 대기 중이던 재생을 재시도. */
function loadTrack(ctx: AudioContext, track: BgmTrack): void {
  // ★ 실패한 트랙은 다시 시도하지 않는다. applyScene → loadTrack → (실패) → applyScene의
  //   되먹임이 있어서, 표시를 남기지 않으면 404 하나가 무한 재요청 루프가 된다.
  if (buffers.has(track) || loadingTracks.has(track) || failedTracks.has(track)) return
  const f = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof f !== 'function') return
  loadingTracks.add(track)
  void (async () => {
    try {
      const res = await f(audioAssetUrl(`bgm/${track}.mp3`))
      if (!res.ok) throw new Error(`http ${res.status}`)
      const buf = await decodeAudio(ctx, await res.arrayBuffer())
      buffers.set(track, buf)
      touch(track)
    } catch {
      // 로드·디코드 실패 = 그 곡만 조용하다. 폴백 합성은 두지 않는다(음악은 대체 불가).
      failedTracks.add(track)
    } finally {
      loadingTracks.delete(track)
      // 실패한 스팅 요청은 여기서 버린다 — 남겨 두면 "스팅 대기 중"으로 판정되어
      // 그 뒤의 루프가 영영 시작되지 않는다(하프타임 M07 실패 → 작전판 M04 무음).
      if (wantedSting?.track === track && !buffers.has(track)) wantedSting = null
      if (wantedSting?.track === track) startSting(track)
      applyScene()
    }
  })()
}

// ── 보이스 조작 ───────────────────────────────────────────────
function targetGain(track: BgmTrack): number {
  return TRACK_GAIN[track] ?? DEFAULT_GAIN
}

/** 보이스의 소스를 offset부터 실제로 돌린다(일시정지 재개도 이 경로). */
function startVoice(ctx: AudioContext, v: Voice, buf: AudioBuffer, fadeMs: number): void {
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.loop = v.loop
  src.connect(v.gain)
  const now = ctx.currentTime
  src.start(now, v.offset)
  v.src = src
  v.startedAt = now
  v.gain.gain.cancelScheduledValues(now)
  v.gain.gain.setValueAtTime(v.gain.gain.value, now)
  v.gain.gain.linearRampToValueAtTime(targetGain(v.track), now + fadeMs / 1000)
}

/** 지금 재생 위치(초). 루프는 길이로 나눈 나머지. */
function currentOffset(ctx: AudioContext, v: Voice): number {
  const played = v.offset + (v.src ? ctx.currentTime - v.startedAt : 0)
  return v.loop && v.duration > 0 ? played % v.duration : played
}

/** 보이스를 페이드아웃하고 정리한다. */
function fadeOutVoice(ctx: AudioContext, v: Voice | null, fadeMs: number): void {
  if (!v) return
  fading.push(v)
  const drop = (): void => {
    const i = fading.indexOf(v)
    if (i >= 0) fading.splice(i, 1)
  }
  // onended가 오지 않는 경로(시작 전에 취소된 예약 스팅 등)를 위한 안전망.
  setTimeout(drop, fadeMs + 2000)
  try {
    const now = ctx.currentTime
    const end = now + fadeMs / 1000
    v.gain.gain.cancelScheduledValues(now)
    v.gain.gain.setValueAtTime(v.gain.gain.value, now)
    v.gain.gain.linearRampToValueAtTime(0, end)
    const src = v.src
    if (src) {
      src.stop(end + 0.02)
      src.onended = () => {
        drop()
        try {
          src.disconnect()
          v.gain.disconnect()
        } catch {
          /* no-op */
        }
      }
    } else {
      drop()
      v.gain.disconnect()
    }
  } catch {
    drop()
  }
}

// ── 장면(루프 채널) ───────────────────────────────────────────
/**
 * 지금 화면의 장면을 선언한다. 같은 장면 재선언은 무시(멱등)하므로 effect에서 매 렌더
 * 불러도 안전하다. null이면 음악 없음(= 인플레이 기본값).
 */
export function setScene(scene: BgmScene | null): void {
  hookFirstGesture()
  if (nullTimer) {
    clearTimeout(nullTimer)
    nullTimer = undefined
  }
  if (scene === null) {
    // ★ 실측으로 잡은 결함(2026-08-01): 화면 전환은 "이전 화면 언마운트 → 다음 화면
    //   마운트" 순서라, 언마운트가 곧바로 음악을 끊으면 다음 화면이 곡을 선언하기 전에
    //   구멍이 난다(StrictMode 이중 마운트에서 허브 M02가 **580ms 먼저** 끊겼다).
    //   유예를 두고, 그 사이에 새 장면이 선언되면 끊지 않는다.
    if (wantedScene === null) return
    nullTimer = setTimeout(() => {
      nullTimer = undefined
      wantedScene = null
      applyScene()
    }, NULL_GRACE_MS)
    return
  }
  if (wantedScene === scene) {
    applyScene()
    return
  }
  wantedScene = scene
  applyScene()
}

/** 현재 원하는 장면(테스트·디버그). */
export function currentScene(): BgmScene | null {
  return wantedScene
}

/** 원하는 장면과 실제 재생 상태를 수렴시킨다(멱등). 컨텍스트·버퍼가 없으면 조용히 대기. */
function applyScene(): void {
  const g = ensureBus()
  if (!g) return
  const { ctx } = g
  const track = wantedScene ? SCENE_TRACK[wantedScene] : null

  if (loopVoice && loopVoice.track === track) return

  // 스팅이 도는 동안(또는 로드를 기다리는 동안)에는 루프를 얹지 않는다 —
  // 입장 팡파르 위에 워룸 루프가 겹치면 둘 다 죽는다.
  if (wantedSting || stingEndsAt > ctx.currentTime) {
    if (loopVoice) {
      fadeOutVoice(ctx, loopVoice, CROSSFADE_MS)
      loopVoice = null
    }
    // 스팅이 실제로 예약된 경우에만 그 끝에 재시도를 건다. 아직 로드 대기 중이라면
    // loadTrack의 finally가 applyScene을 다시 부른다(30ms 폴링 루프를 만들지 않는다).
    if (stingEndsAt > ctx.currentTime) scheduleAfterSting(ctx)
    return
  }

  // ★ 실측으로 잡은 결함(2026-08-01): 예전에는 여기서 먼저 이전 루프를 걷고 새 트랙을
  //   로드했다. 그러면 크로스페이드가 아니라 "페이드아웃 → 침묵 → 페이드인"이 된다
  //   (허브 M02 → 워룸 M03 실측 **629ms 무음**). 새 버퍼가 준비되기 전에는 **이전 곡을
  //   그대로 둔다** — 교체는 둘이 겹칠 수 있을 때만 한다.
  const buf = track ? buffers.get(track) : undefined
  if (track && !buf) {
    loadTrack(ctx, track) // 로드 완료 시 finally에서 applyScene() 재시도
    return
  }

  if (loopVoice) {
    fadeOutVoice(ctx, loopVoice, CROSSFADE_MS)
    loopVoice = null
  }
  if (!track || !buf) return
  touch(track)
  try {
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(g.bus)
    const v: Voice = {
      track, gain, src: null, offset: 0, startedAt: ctx.currentTime,
      duration: buf.duration, loop: LOOPING.has(track),
    }
    loopVoice = v
    if (!paused) startVoice(ctx, v, buf, CROSSFADE_MS)
  } catch {
    loopVoice = null
  }
}

/** 스팅이 끝나는 시점에 루프 재시도를 한 번 예약한다. */
function scheduleAfterSting(ctx: AudioContext): void {
  if (stingTimer) clearTimeout(stingTimer)
  const waitMs = Math.max(0, (stingEndsAt - ctx.currentTime) * 1000) + 30
  stingTimer = setTimeout(() => {
    stingTimer = undefined
    stingEndsAt = 0
    applyScene()
  }, waitMs)
}

// ── 스팅(1회 재생 채널) ───────────────────────────────────────
/**
 * 스팅을 1회 재생한다(입장·하프타임·풀타임·엔딩).
 *
 * @param opts.alignEndAtMs 이 시각(요청 시점 기준 ms)에 **끝이 맞도록** 시작을 미룬다.
 *   입장 연출 M06 전용 계약이다 — 곡이 킥오프 휘슬 직전에 해소되게 만들어졌으므로
 *   길이가 어긋나면 앞을 자르거나 시작을 늦춰서 **끝을 맞춘다**(entrance.entranceScript의
 *   totalMs가 길이의 정본이고, 이 모듈은 그 값을 받기만 한다).
 *
 * @param opts.duckUntilMs 이 시각(요청 시점 기준 ms)까지 스팅을 {@link DUCK_RATIO} 배로
 *   눌러 두었다가 {@link STING_UNDUCK_MS}에 걸쳐 제 음량으로 올린다. **말이 주인인 구간**을
 *   위한 것이다 — 입장 연출 full 모드에서 M06은 끝 맞추기 때문에 캐스터가 22명을 호명하는
 *   소개 구간 위로 11.6초 겹쳐 드는데, 그 위를 제 음량으로 밟으면 안 된다. 시각의 정본은
 *   entrance.entranceIntroEndMs이고 이 모듈은 그 값을 받기만 한다.
 *   `alignEndAtMs`와 독립이다 — 곡이 **언제 시작하느냐**는 앞이 정하고, **언제 커지느냐**는
 *   이쪽이 정한다. 곡이 시작하기도 전에 덕킹이 풀리는 순서(duckUntil < 시작 시각)라면
 *   덕킹은 아무 일도 하지 않는다(처음부터 제 음량).
 */
export function playSting(track: BgmTrack, opts: { alignEndAtMs?: number; duckUntilMs?: number } = {}): void {
  hookFirstGesture()
  wantedSting = {
    track,
    ...(opts.alignEndAtMs != null ? { alignEndAtMs: opts.alignEndAtMs } : {}),
    ...(opts.duckUntilMs != null ? { duckUntilMs: opts.duckUntilMs } : {}),
    requestedAt: now(),
  }
  startSting(track)
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance
  return typeof p?.now === 'function' ? p.now() : 0
}

function startSting(track: BgmTrack): void {
  const req = wantedSting
  if (!req || req.track !== track) return
  const g = ensureBus()
  if (!g) return
  const { ctx } = g
  const buf = buffers.get(track)
  if (!buf) {
    loadTrack(ctx, track)
    return
  }
  touch(track)
  // 이미 이 스팅이 돌고 있으면 다시 걸지 않는다(멱등).
  if (stingVoice?.track === track && stingVoice.src) return
  try {
    if (stingVoice) {
      fadeOutVoice(ctx, stingVoice, CROSSFADE_MS)
      stingVoice = null
    }
    // 스팅은 채널을 독점한다 — 돌고 있던 루프는 크로스페이드로 비켜 준다.
    if (loopVoice) {
      fadeOutVoice(ctx, loopVoice, CROSSFADE_MS)
      loopVoice = null
    }
    const durMs = buf.duration * 1000
    // 끝 맞추기: 남은 시간이 곡보다 길면 그만큼 늦게 시작하고, 짧으면 앞을 잘라 낸다.
    const leftMs = req.alignEndAtMs != null ? Math.max(0, req.alignEndAtMs - (now() - req.requestedAt)) : durMs
    const delaySec = Math.max(0, leftMs - durMs) / 1000
    const offset = Math.max(0, Math.min(buf.duration - 0.05, (durMs - leftMs) / 1000))

    const full = targetGain(track)
    const gain = ctx.createGain()
    gain.gain.value = full
    gain.connect(g.bus)
    const startAt = ctx.currentTime + delaySec
    // ── 말이 주인인 구간의 덕킹(duckUntilMs) ──────────────────
    // 스팅 **자체의** 게인 노드에 건다. 공용 duckNode를 쓰면 골 덕킹과 서로를 덮어쓴다.
    // 스케줄은 AudioParam이 잡으므로 rAF·타이머가 죽어도(백그라운드 탭) 곡선이 그대로 간다.
    const duckLeftSec = req.duckUntilMs != null
      ? (req.duckUntilMs - (now() - req.requestedAt)) / 1000
      : -1
    const unduckAt = ctx.currentTime + duckLeftSec
    if (duckLeftSec > 0 && unduckAt > startAt) {
      gain.gain.setValueAtTime(full * DUCK_RATIO, ctx.currentTime)
      gain.gain.setValueAtTime(full * DUCK_RATIO, unduckAt)
      gain.gain.linearRampToValueAtTime(full, unduckAt + STING_UNDUCK_MS / 1000)
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    src.start(startAt, offset)
    const v: Voice = {
      track, gain, src, offset, startedAt: startAt,
      duration: buf.duration, loop: false,
    }
    stingVoice = v
    stingEndsAt = startAt + (buf.duration - offset)
    src.onended = () => {
      if (stingVoice === v) {
        stingVoice = null
        wantedSting = null
      }
      try {
        src.disconnect()
        gain.disconnect()
      } catch {
        /* no-op */
      }
    }
    // 스팅이 끝나면 대기 중이던 장면 루프가 들어온다(하프타임 M07 → 작전판 M04).
    scheduleAfterSting(ctx)
  } catch {
    stingVoice = null
  }
}

/** 진행 중·예약된 스팅을 페이드아웃하며 취소한다(입장 건너뛰기·모드 교체). */
export function stopSting(fadeMs = 300): void {
  wantedSting = null
  const g = ensureBus()
  if (!g) return
  fadeOutVoice(g.ctx, stingVoice, fadeMs)
  stingVoice = null
  stingEndsAt = 0
  if (stingTimer) clearTimeout(stingTimer)
  stingTimer = undefined
  applyScene()
}

// ── 덕킹(골·실점) ─────────────────────────────────────────────
/**
 * 골·실점 순간 음악을 0.1배로 눌렀다가 되돌린다 — 관중음 덕킹(8a35662)과 같은 방식·같은 배율.
 * 인플레이에 도는 음악은 M09 클러치 베드뿐이므로 실제로 이게 눌러 주는 대상도 대개 M09다.
 */
export function duck(holdMs = DUCK_HOLD_MS): void {
  const g = ensureBus()
  if (!g || !duckNode) return
  try {
    const t = g.ctx.currentTime
    duckNode.gain.cancelScheduledValues(t)
    duckNode.gain.setValueAtTime(duckNode.gain.value, t)
    duckNode.gain.setTargetAtTime(DUCK_RATIO, t, 0.05)
    duckNode.gain.setTargetAtTime(1, t + holdMs / 1000, 0.35)
  } catch {
    /* no-op */
  }
}

// ── 일시정지 ──────────────────────────────────────────────────
/**
 * 일시정지 중에는 음악도 **멈춘다**(관중음이 낮은 웅성거림으로 남는 것과 다르다 —
 * 관중은 경기장에 그대로 있지만 음악은 연출이라, 화면이 얼어 있는데 곡만 흘러가면
 * 재개 시점의 소절이 어긋난다). 재개하면 끊긴 자리에서 이어 붙는다.
 *
 * ⚠ 재개는 게인을 targetGain으로 되돌리므로 `duckUntilMs` 스케줄이 지워진다. 입장 연출은
 *   일시정지 대상이 아니라(MatchScreen.canFreeze가 entranceScr를 제외한다) 지금은 도달하지
 *   않는 경로다. 입장 중 일시정지를 열게 되면 여기서 덕킹 잔여 시간을 다시 걸어야 한다.
 */
export function setPaused(next: boolean): void {
  if (paused === next) return
  paused = next
  const g = ensureBus()
  if (!g) return
  const { ctx } = g
  for (const v of [loopVoice, stingVoice]) {
    if (!v) continue
    try {
      if (next) {
        if (!v.src) continue
        v.offset = currentOffset(ctx, v)
        const end = ctx.currentTime + PAUSE_FADE_MS / 1000
        v.gain.gain.cancelScheduledValues(ctx.currentTime)
        v.gain.gain.setValueAtTime(v.gain.gain.value, ctx.currentTime)
        v.gain.gain.linearRampToValueAtTime(0, end)
        v.src.onended = null
        v.src.stop(end + 0.02)
        v.src = null
      } else {
        const buf = buffers.get(v.track)
        if (!buf) continue
        if (!v.loop && v.offset >= buf.duration - 0.05) continue // 이미 끝난 스팅은 되살리지 않는다
        startVoice(ctx, v, buf, PAUSE_FADE_MS)
      }
    } catch {
      /* no-op */
    }
  }
}

// ── 정리 ──────────────────────────────────────────────────────
/** 모든 음악을 끈다(언마운트·앱 종료 경로). */
export function stopAll(fadeMs = CROSSFADE_MS): void {
  if (nullTimer) {
    clearTimeout(nullTimer)
    nullTimer = undefined
  }
  wantedScene = null
  wantedSting = null
  const g = ensureBus()
  if (!g) return
  fadeOutVoice(g.ctx, loopVoice, fadeMs)
  fadeOutVoice(g.ctx, stingVoice, fadeMs)
  loopVoice = null
  stingVoice = null
  stingEndsAt = 0
  if (stingTimer) clearTimeout(stingTimer)
  stingTimer = undefined
}

// ── 상태 조회(테스트 · 브라우저 실측) ─────────────────────────
/** 현재 ctx 시각(초). 컨텍스트가 없으면 null. */
function ctxTime(): number | null {
  return audioBus()?.ctx.currentTime ?? null
}

/**
 * 지금 무엇이 어느 게인으로 울리고 있는지. 순수 조회이며 아무것도 바꾸지 않는다.
 * 브라우저 실측(크로스페이드 ms·덕킹 배율·일시정지 반응)이 이 값을 폴링한다.
 */
export function bgmState(): {
  scene: BgmScene | null
  loop: BgmTrack | null
  loopGain: number
  sting: BgmTrack | null
  stingGain: number
  /** 예약된 스팅이 실제로 소리를 내기 시작하기까지 남은 ms(이미 울리는 중이면 0). */
  stingStartsInMs: number
  /** 예약된 스팅이 끝나기까지 남은 ms. M06 끝 맞추기 실측의 근거. */
  stingEndsInMs: number
  /** 페이드아웃 중인 보이스 [트랙, 현재 게인] — 크로스페이드가 실제로 겹치는지 볼 수 있다. */
  fading: [BgmTrack, number][]
  duck: number
  paused: boolean
  ready: boolean
} {
  return {
    scene: wantedScene,
    loop: loopVoice?.track ?? null,
    loopGain: loopVoice ? loopVoice.gain.gain.value : 0,
    sting: stingVoice?.track ?? null,
    stingGain: stingVoice ? stingVoice.gain.gain.value : 0,
    stingStartsInMs: stingVoice && bus && ctxTime() != null
      ? Math.max(0, Math.round((stingVoice.startedAt - ctxTime()!) * 1000)) : 0,
    stingEndsInMs: stingVoice && ctxTime() != null
      ? Math.max(0, Math.round((stingEndsAt - ctxTime()!) * 1000)) : 0,
    fading: fading.map(v => [v.track, v.gain.gain.value] as [BgmTrack, number]),
    duck: duckNode ? duckNode.gain.value : 1,
    paused,
    ready: !!bus,
  }
}

/** 테스트 격리용 — 모듈 상태를 초기화한다(브라우저 런타임에서는 쓰지 않는다). */
export function __resetForTest(): void {
  loopVoice = null
  stingVoice = null
  bus = null
  duckNode = null
  wantedScene = null
  wantedSting = null
  stingEndsAt = 0
  if (stingTimer) clearTimeout(stingTimer)
  stingTimer = undefined
  if (nullTimer) clearTimeout(nullTimer)
  nullTimer = undefined
  paused = false
  fading.length = 0
  buffers.clear()
  loadingTracks.clear()
  failedTracks.clear()
  recent.length = 0
}
