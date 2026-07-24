// src/audio/sfx.ts
// 매치데이 사운드 — ★ Web Audio API 순수 합성 전용(외부 음원 파일 0 → 라이선스 리스크 0).
// 함성 노이즈 루프·골 폭발·심판 휘슬·실점 웅성거림을 모두 코드로 생성한다.
//
// 핵심 원칙:
//  1) AudioContext는 **유저 제스처 후에만** lazy 생성한다(브라우저 자동재생 정책 — 킥오프 클릭에서 init()).
//  2) 미지원 환경(SSR·jsdom·구형)에선 전부 no-op — 어떤 경로에서도 절대 throw하지 않는다(try/catch 감싸기).
//  3) 전역 음소거 토글은 localStorage('rematch-muted')에 기억한다. 기본값은 소리 ON(feature가 들려야 의미).
//  4) 재현성(엔진 Math.random 금지 원칙)을 사운드에도 적용 — 노이즈는 경량 결정론 PRNG로 생성한다.

const MUTE_KEY = 'rematch-muted'

/** 휘슬 종류 — 킥오프 1회·하프 2회·풀타임 3회·브레이크 짧게. */
export type WhistleKind = 'kickoff' | 'halftime' | 'fulltime' | 'break'

// ── 모듈 상태(오디오 그래프 핸들) ─────────────────────────────
let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
// 관중 함성 루프 핸들(intensity로 게인을 갱신하며 한 번만 start).
let crowdSource: AudioBufferSourceNode | null = null
let crowdGain: GainNode | null = null
let crowdFilter: BiquadFilterNode | null = null

// 음소거 상태 — 모듈 로드 시 localStorage에서 복원(기본 false = 소리 ON).
let muted = readStoredMute()

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
    return ctx
  } catch {
    ctx = null
    masterGain = null
    return null
  }
}

/** 유저 제스처(킥오프 클릭)에서 호출 — AudioContext 생성/재개. 미지원이면 no-op. */
export function init(): void {
  const c = ensureCtx()
  if (!c) return
  try {
    if (c.state === 'suspended') void c.resume()
  } catch {
    /* no-op */
  }
}

// ── 노이즈 버퍼 생성 ──────────────────────────────────────────
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
 * 함성 베이스 루프. 'start'로 시작(이미 켜져 있으면 intensity만 부드럽게 갱신),
 * 'stop'으로 정지·정리. intensity 0~1로 게인(스코어 상황·골 직후 스웰).
 */
export function crowdLoop(action: 'start' | 'stop', intensity = 0.3): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
    if (action === 'stop') {
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
      return
    }

    const target = crowdBaseGain(intensity)
    // 이미 루프 중이면 게인만 스웰/디케이(약 0.4s 램프).
    if (crowdSource && crowdGain) {
      crowdGain.gain.setTargetAtTime(target, c.currentTime, 0.4)
      return
    }

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
    gain.connect(masterGain)
    src.start()
    crowdSource = src
    crowdGain = gain
    crowdFilter = filter
  } catch {
    /* no-op — 사운드 실패가 경기를 멈추지 않는다 */
  }
}

// ── 골 폭발(함성) ─────────────────────────────────────────────
/** 화이트노이즈 버스트(빠른 어택·긴 디케이) + 삼각파 피치 스윕(환호 상승). */
export function goalBurst(): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
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
    g.connect(masterGain)
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
    og.connect(masterGain)
    osc.start(now)
    osc.stop(now + 0.9)
  } catch {
    /* no-op */
  }
}

// ── 심판 휘슬 ─────────────────────────────────────────────────
/** 종류별 삑 시퀀스(초 단위 길이). 마지막이 길수록 종료감(풀타임). */
const WHISTLE_PATTERN: Record<WhistleKind, number[]> = {
  kickoff: [0.5], // 1회 길게
  halftime: [0.32, 0.32], // 2회
  fulltime: [0.3, 0.3, 0.6], // 3회(마지막 길게)
  break: [0.18], // 짧게
}

/** 심판 휘슬 시퀀스 재생. 사각파 + 미세 워블(LFO)로 실제 호루라기 질감. */
export function whistle(kind: WhistleKind): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
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

// ── 실점 웅성거림 ─────────────────────────────────────────────
/** 낮은 웅성거림(저역 노이즈) + 하강 저음(실망감). */
export function concedeMurmur(): void {
  const c = ensureCtx()
  if (!c || !masterGain) return
  try {
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
    g.connect(masterGain)
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
    og.connect(masterGain)
    osc.start(now)
    osc.stop(now + 1.4)
  } catch {
    /* no-op */
  }
}
