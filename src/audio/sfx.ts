// src/audio/sfx.ts
// 매치데이 사운드 — ★ 실제 CC0 음원 재생 + Web Audio 합성 폴백.
// 1차: public/sfx/*.mp3 (CC0 실음원 — 라이선스 원장 docs/assets-licenses.md §사운드)을
//      fetch + decodeAudioData로 로드해 AudioBufferSourceNode로 재생한다.
// 2차: 로드 실패·decodeAudioData 미지원·미지원 환경(SSR·jsdom·구형)에선 기존 순수 합성으로 폴백.
//
// 핵심 원칙(불변):
//  1) AudioContext는 **유저 제스처 후에만** lazy 생성한다(브라우저 자동재생 정책 — 킥오프 클릭에서 init()).
//  2) 어떤 경로에서도 절대 throw하지 않는다(try/catch 감싸기) — 사운드 실패가 경기를 멈추지 않는다.
//  3) 전역 음소거 토글은 localStorage('rematch-muted')에 기억한다. 기본값은 소리 ON.
//  4) 재현성(엔진 Math.random 금지 원칙)을 합성 폴백에도 적용 — 노이즈는 경량 결정론 PRNG로 생성한다.
//  5) 공개 인터페이스(crowdLoop/goalBurst/whistle/concedeMurmur/init/setMuted 등)는 불변 — MatchScreen 무수정.

const MUTE_KEY = 'rematch-muted'

/** 휘슬 종류 — 킥오프 1회·하프 2회·풀타임 3회·브레이크 짧게. */
export type WhistleKind = 'kickoff' | 'halftime' | 'fulltime' | 'break'

// ── 모듈 상태(오디오 그래프 핸들) ─────────────────────────────
let ctx: AudioContext | null = null
let masterGain: GainNode | null = null

// 관중 함성 루프 핸들 — 실음원(real) 또는 합성(synth) 중 하나로 재생.
let crowdSource: AudioBufferSourceNode | null = null
let crowdGain: GainNode | null = null
let crowdFilter: BiquadFilterNode | null = null // 합성 폴백 전용(lowpass)
let crowdMode: 'none' | 'real' | 'synth' = 'none'
// crowdLoop('start')는 비동기 로드 완료 전에도 호출될 수 있으므로 "원하는 상태"를 기억해 두었다가
// 샘플 로드가 끝나면 실음원으로 시작한다(로드 실패 시 합성으로 시작).
let crowdWanted = false
let crowdIntensity = 0.3

// 음소거 상태 — 모듈 로드 시 localStorage에서 복원(기본 false = 소리 ON).
let muted = readStoredMute()

// ── 실음원 샘플 로드 ──────────────────────────────────────────
const SAMPLES = {
  crowd: 'crowd.mp3', // 관중 앰비언스 루프
  goal: 'goal.mp3', // 골 함성 폭발
  concede: 'concede.mp3', // 실점 탄식("aww")
  whistle: 'whistle.mp3', // 심판 휘슬(단일 취주 — 종류별 횟수만큼 반복)
} as const
type SampleName = keyof typeof SAMPLES

// 디코드된 버퍼 캐시. undefined = 미로드, null = 로드 시도했으나 실패(합성 폴백 대상).
const buffers: Partial<Record<SampleName, AudioBuffer | null>> = {}
let loadState: 'idle' | 'loading' | 'ready' = 'idle'

/** 정적 자산 경로(Vite base 고려). 예: '/sfx/crowd.mp3' 또는 '/base/sfx/crowd.mp3'. */
function sfxUrl(file: string): string {
  let base = '/'
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    if (env?.BASE_URL) base = env.BASE_URL
  } catch {
    /* import.meta 미지원 — 루트 기준 */
  }
  if (!base.endsWith('/')) base += '/'
  return `${base}sfx/${file}`
}

/** decodeAudioData를 Promise/콜백 양식 모두 지원하도록 감싼다. */
function decode(c: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const maybe = c.decodeAudioData(data, resolve, reject) as unknown
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
        ;(maybe as Promise<AudioBuffer>).then(resolve, reject)
      }
    } catch (e) {
      reject(e as Error)
    }
  })
}

/** 샘플 4종을 병렬 로드한다(1회만). 실패한 항목은 null로 표시해 합성 폴백으로 흘린다. */
function loadSamples(c: AudioContext): void {
  if (loadState !== 'idle') return
  loadState = 'loading'
  const f = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof f !== 'function') {
    // fetch 미지원(구형·일부 SSR) — 전부 합성 폴백.
    loadState = 'ready'
    return
  }
  const names = Object.keys(SAMPLES) as SampleName[]
  const done = () => {
    loadState = 'ready'
    onSamplesReady()
  }
  Promise.all(
    names.map(async (name) => {
      try {
        const res = await f(sfxUrl(SAMPLES[name]))
        if (!res.ok) throw new Error(`http ${res.status}`)
        const ab = await res.arrayBuffer()
        buffers[name] = await decode(c, ab)
      } catch {
        buffers[name] = null // 로드/디코드 실패 → 합성 폴백
      }
    }),
  ).then(done, done)
}

/** 샘플 로드가 끝나면(성공/실패 무관) 대기 중이던 관중 루프를 실제로 시작한다. */
function onSamplesReady(): void {
  if (crowdWanted && crowdMode === 'none') applyCrowd()
}

// ── 음소거 상태 ───────────────────────────────────────────────
/** localStorage에서 음소거 여부를 읽는다(부재·오류 시 false = 소리 ON). */
export function readStoredMute(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

/** 현재 음소거 상태. */
export function isMuted(): boolean {
  return muted
}

/** 음소거 설정 + localStorage 반영 + 재생 중이면 마스터 게인 즉시 반영. */
export function setMuted(next: boolean): void {
  muted = next
  try {
    if (next) globalThis.localStorage?.setItem(MUTE_KEY, '1')
    else globalThis.localStorage?.removeItem(MUTE_KEY)
  } catch {
    /* localStorage 미지원 — 메모리 상태만 유지 */
  }
  // 이미 재생 중인 오디오에도 즉시 반영(부드럽게).
  if (masterGain && ctx) {
    try {
      masterGain.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.05)
    } catch {
      /* no-op */
    }
  }
}

/** 음소거 토글 — 새 상태를 반환(UI 아이콘 갱신용). */
export function toggleMuted(): boolean {
  setMuted(!muted)
  return muted
}

// ── 결정론 노이즈용 경량 PRNG(LCG) — Math.random 미사용(엔진 재현성 원칙 준수) ──
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296 // [0, 1)
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ── AudioContext lazy 생성 ────────────────────────────────────
/** AudioContext를 준비한다. 미지원이면 null(모든 함수가 no-op이 됨). */
function ensureCtx(): AudioContext | null {
  if (ctx) return ctx
  try {
    const AC: typeof AudioContext | undefined =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    masterGain = ctx.createGain()
    masterGain.gain.value = muted ? 0 : 1
    masterGain.connect(ctx.destination)
    loadSamples(ctx) // 컨텍스트가 살아있는 첫 순간 실음원 로드 개시
    return ctx
  } catch {
    ctx = null
    masterGain = null
    return null
  }
}

/** 유저 제스처(킥오프 클릭)에서 호출 — AudioContext 생성/재개 + 실음원 로드. 미지원이면 no-op. */
export function init(): void {
  const c = ensureCtx()
  if (!c) return
  try {
    if (c.state === 'suspended') void c.resume()
  } catch {
    /* no-op */
  }
}

// ── 공용 재생 헬퍼(실음원 원샷) ───────────────────────────────
/** 디코드된 버퍼를 원샷 재생한다(when 미지정 시 즉시). */
function playSampleAt(c: AudioContext, dest: AudioNode, buf: AudioBuffer, gainVal: number, when?: number): void {
  const start = when ?? c.currentTime
  const src = c.createBufferSource()
  src.buffer = buf
  const g = c.createGain()
  g.gain.value = gainVal
  src.connect(g)
  g.connect(dest)
  src.start(start)
  try {
    src.stop(start + buf.duration + 0.05)
  } catch {
    /* stop 미지원 — 버퍼가 알아서 끝남 */
  }
}

// ── 합성 폴백: 노이즈 버퍼 생성 ───────────────────────────────
/** 함성 베이스(brown) / 폭발·웅성(white) 노이즈 버퍼를 결정론 PRNG로 채운다. */
function makeNoiseBuffer(c: AudioContext, seconds: number, kind: 'white' | 'brown'): AudioBuffer {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  const rng = makeRng(kind === 'brown' ? 0x9e3779b1 : 0x1000193)
  if (kind === 'white') {
    for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1
  } else {
    // brown noise: 화이트를 적분(누설) — 저역이 강한 함성 베이스.
    let last = 0
    for (let i = 0; i < len; i++) {
      const w = rng() * 2 - 1
      last = (last + 0.02 * w) / 1.02
      data[i] = last * 3.5
    }
  }
  return buf
}

/** 관중 강도(0~1) → 실제 게인(배경음이므로 절제). */
function crowdBaseGain(intensity: number): number {
  return 0.04 + clamp01(intensity) * 0.26
}

// ── 관중 함성 루프 ────────────────────────────────────────────
/**
 * 함성 루프. 'start'로 시작(이미 켜져 있으면 intensity만 부드럽게 갱신),
 * 'stop'으로 정지·정리. intensity 0~1로 게인(스코어 상황·골 직후 스웰).
 * 실음원 crowd.mp3 loop 재생을 우선하고, 미로드·실패 시 합성 브라운노이즈로 폴백.
 */
export function crowdLoop(action: 'start' | 'stop', intensity = 0.3): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
    if (action === 'stop') {
      crowdWanted = false
      teardownCrowd()
      return
    }
    crowdWanted = true
    crowdIntensity = intensity
    applyCrowd()
  } catch {
    /* no-op — 사운드 실패가 경기를 멈추지 않는다 */
  }
}

/** 관중 루프의 현재 상태를 원하는 상태로 수렴시킨다(멱등). */
function applyCrowd(): void {
  const c = ctx
  if (!c || !masterGain || !crowdWanted) return
  const target = crowdBaseGain(crowdIntensity)
  // 이미 재생 중이면 게인만 스웰/디케이(약 0.4s 램프).
  if (crowdMode !== 'none' && crowdGain) {
    crowdGain.gain.setTargetAtTime(target, c.currentTime, 0.4)
    return
  }
  if (buffers.crowd) {
    startRealCrowd(c, masterGain, buffers.crowd, target)
  } else if (loadState === 'ready') {
    // 로드 완료됐는데 crowd 버퍼가 없음(실패) → 합성 폴백.
    startSynthCrowd(c, masterGain, target)
  }
  // loadState === 'loading' 이면 아무 것도 시작하지 않고 onSamplesReady()에서 재시도(무음 대기).
}

function startRealCrowd(c: AudioContext, dest: AudioNode, buf: AudioBuffer, target: number): void {
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  const gain = c.createGain()
  gain.gain.value = target
  src.connect(gain)
  gain.connect(dest)
  src.start()
  crowdSource = src
  crowdGain = gain
  crowdFilter = null
  crowdMode = 'real'
}

function startSynthCrowd(c: AudioContext, dest: AudioNode, target: number): void {
  const buf = makeNoiseBuffer(c, 2, 'brown')
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 700
  filter.Q.value = 0.6
  const gain = c.createGain()
  gain.gain.value = target
  src.connect(filter)
  filter.connect(gain)
  gain.connect(dest)
  src.start()
  crowdSource = src
  crowdGain = gain
  crowdFilter = filter
  crowdMode = 'synth'
}

function teardownCrowd(): void {
  if (crowdSource) {
    try {
      crowdSource.stop()
    } catch {
      /* 이미 정지 */
    }
    crowdSource.disconnect()
    crowdSource = null
  }
  if (crowdGain) {
    crowdGain.disconnect()
    crowdGain = null
  }
  if (crowdFilter) {
    crowdFilter.disconnect()
    crowdFilter = null
  }
  crowdMode = 'none'
}

// ── 골 폭발(함성) ─────────────────────────────────────────────
/** 실음원 goal.mp3(환호 폭발). 미로드·실패 시 화이트노이즈 버스트 + 피치 스윕 합성. */
export function goalBurst(): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
    if (buffers.goal) {
      playSampleAt(c, masterGain, buffers.goal, 0.9)
      return
    }
    synthGoalBurst(c, masterGain)
  } catch {
    /* no-op */
  }
}

function synthGoalBurst(c: AudioContext, dest: AudioNode): void {
  const now = c.currentTime
  // 함성 폭발 — 화이트노이즈 밴드패스 + 게인 엔벨로프.
  const buf = makeNoiseBuffer(c, 1.6, 'white')
  const src = c.createBufferSource()
  src.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 900
  bp.Q.value = 0.7
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.6, now + 0.08)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5)
  src.connect(bp)
  bp.connect(g)
  g.connect(dest)
  src.start(now)
  src.stop(now + 1.6)
  // 피치 스윕 — 상승하는 환호.
  const osc = c.createOscillator()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(220, now)
  osc.frequency.exponentialRampToValueAtTime(660, now + 0.5)
  const og = c.createGain()
  og.gain.setValueAtTime(0.0001, now)
  og.gain.exponentialRampToValueAtTime(0.25, now + 0.1)
  og.gain.exponentialRampToValueAtTime(0.0001, now + 0.9)
  osc.connect(og)
  og.connect(dest)
  osc.start(now)
  osc.stop(now + 0.9)
}

// ── 심판 휘슬 ─────────────────────────────────────────────────
/** 실음원 반복 횟수 — 킥오프 1·하프 2·풀타임 3·브레이크 1. */
const WHISTLE_COUNT: Record<WhistleKind, number> = {
  kickoff: 1,
  halftime: 2,
  fulltime: 3,
  break: 1,
}

/** 합성 폴백용 삑 시퀀스(초 단위 길이). 마지막이 길수록 종료감(풀타임). */
const WHISTLE_PATTERN: Record<WhistleKind, number[]> = {
  kickoff: [0.5], // 1회 길게
  halftime: [0.32, 0.32], // 2회
  fulltime: [0.3, 0.3, 0.6], // 3회(마지막 길게)
  break: [0.18], // 짧게
}

/** 심판 휘슬 재생. 실음원 whistle.mp3를 종류별 횟수만큼 반복(폴백 시 사각파 합성). */
export function whistle(kind: WhistleKind): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
    const buf = buffers.whistle
    if (buf) {
      let t = c.currentTime + 0.02
      const gap = 0.1
      for (let i = 0; i < WHISTLE_COUNT[kind]; i++) {
        playSampleAt(c, masterGain, buf, 0.85, t)
        t += buf.duration + gap
      }
      return
    }
    // 합성 폴백
    let t = c.currentTime + 0.02
    for (const dur of WHISTLE_PATTERN[kind]) {
      blowWhistle(c, masterGain, t, dur)
      t += dur + 0.12
    }
  } catch {
    /* no-op */
  }
}

function blowWhistle(c: AudioContext, dest: AudioNode, start: number, dur: number): void {
  const osc = c.createOscillator()
  osc.type = 'square'
  osc.frequency.setValueAtTime(2100, start)
  // 워블 — 실제 호루라기의 떨림(구슬 회전).
  const lfo = c.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 18
  const lfoGain = c.createGain()
  lfoGain.gain.value = 90
  lfo.connect(lfoGain)
  lfoGain.connect(osc.frequency)
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(0.26, start + 0.02)
  g.gain.setValueAtTime(0.26, Math.max(start + 0.03, start + dur - 0.04))
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g)
  g.connect(dest)
  osc.start(start)
  osc.stop(start + dur)
  lfo.start(start)
  lfo.stop(start + dur)
}

// ── 실점 탄식 ─────────────────────────────────────────────────
/** 실음원 concede.mp3(관중 "aww" 탄식). 미로드·실패 시 저역 노이즈 + 하강 저음 합성. */
export function concedeMurmur(): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
    if (buffers.concede) {
      playSampleAt(c, masterGain, buffers.concede, 0.85)
      return
    }
    synthConcede(c, masterGain)
  } catch {
    /* no-op */
  }
}

function synthConcede(c: AudioContext, dest: AudioNode): void {
  const now = c.currentTime
  const buf = makeNoiseBuffer(c, 2, 'brown')
  const src = c.createBufferSource()
  src.buffer = buf
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 300
  lp.Q.value = 0.7
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.3, now + 0.3)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.8)
  src.connect(lp)
  lp.connect(g)
  g.connect(dest)
  src.start(now)
  src.stop(now + 2)
  // 하강 저음 — 관중의 탄식.
  const osc = c.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(160, now)
  osc.frequency.exponentialRampToValueAtTime(90, now + 1.2)
  const og = c.createGain()
  og.gain.setValueAtTime(0.0001, now)
  og.gain.exponentialRampToValueAtTime(0.12, now + 0.2)
  og.gain.exponentialRampToValueAtTime(0.0001, now + 1.4)
  osc.connect(og)
  og.connect(dest)
  osc.start(now)
  osc.stop(now + 1.4)
}
