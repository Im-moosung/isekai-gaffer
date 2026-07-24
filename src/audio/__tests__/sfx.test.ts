// @vitest-environment jsdom
// 사운드 로직 테스트 — jsdom엔 AudioContext가 없으므로 합성 함수는 no-op 경로를 탄다.
// 검증 대상: (1) 음소거 토글 상태·localStorage 기억, (2) 미지원 환경에서 절대 throw하지 않음.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isMuted,
  setMuted,
  toggleMuted,
  readStoredMute,
  init,
  crowdLoop,
  goalBurst,
  whistle,
  concedeMurmur,
} from '../sfx'

const MUTE_KEY = 'rematch-muted'

// 이 환경은 jsdom이라도 localStorage를 기본 노출하지 않는다(leaderboard 테스트와 동일 패턴).
// 인메모리 스텁을 주입해 음소거 기억 계약을 검증한다.
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  setMuted(false) // 각 테스트를 소리 ON(기본)으로 정규화
})
afterEach(() => vi.unstubAllGlobals())

describe('sfx 음소거 토글 + localStorage 기억', () => {
  it('기본값은 소리 ON(음소거 아님)', () => {
    expect(isMuted()).toBe(false)
  })

  it('setMuted(true)면 isMuted true + localStorage에 "1" 기록', () => {
    setMuted(true)
    expect(isMuted()).toBe(true)
    expect(localStorage.getItem(MUTE_KEY)).toBe('1')
  })

  it('setMuted(false)면 localStorage 키 제거', () => {
    setMuted(true)
    setMuted(false)
    expect(isMuted()).toBe(false)
    expect(localStorage.getItem(MUTE_KEY)).toBeNull()
  })

  it('toggleMuted는 상태를 뒤집고 새 상태를 반환', () => {
    expect(toggleMuted()).toBe(true)
    expect(isMuted()).toBe(true)
    expect(toggleMuted()).toBe(false)
    expect(isMuted()).toBe(false)
  })

  it('readStoredMute는 localStorage "1"을 읽는다(부재 시 false)', () => {
    expect(readStoredMute()).toBe(false)
    localStorage.setItem(MUTE_KEY, '1')
    expect(readStoredMute()).toBe(true)
  })
})

describe('sfx 미지원 환경 no-op — 크래시 금지', () => {
  it('AudioContext 부재(jsdom)에서 모든 합성 함수가 throw 없이 반환', () => {
    expect(() => init()).not.toThrow()
    expect(() => crowdLoop('start', 0.3)).not.toThrow()
    expect(() => crowdLoop('start', 0.8)).not.toThrow()
    expect(() => crowdLoop('stop')).not.toThrow()
    expect(() => goalBurst()).not.toThrow()
    expect(() => whistle('kickoff')).not.toThrow()
    expect(() => whistle('halftime')).not.toThrow()
    expect(() => whistle('fulltime')).not.toThrow()
    expect(() => whistle('break')).not.toThrow()
    expect(() => concedeMurmur()).not.toThrow()
  })

  it('음소거 상태에서도 합성 함수 호출이 안전하다', () => {
    setMuted(true)
    expect(() => {
      init()
      crowdLoop('start', 0.5)
      goalBurst()
      whistle('fulltime')
      concedeMurmur()
      crowdLoop('stop')
    }).not.toThrow()
  })
})

// ── 실음원 재생 vs 합성 폴백 경로 ─────────────────────────────
// jsdom엔 실제 AudioContext가 없으므로, 노드 생성을 기록하는 최소 Fake AudioContext를 주입해
// (1) 샘플 로드 실패 시 합성 폴백(오실레이터/lowpass 필터 생성)이 선택되는지,
// (2) 샘플 로드 성공 시 실음원 재생(AudioBufferSourceNode에 디코드 버퍼 장착, 폴백 노드 미생성)이
//     선택되는지를 검증한다. (실제 오디오 출력은 사용자가 dev 서버에서 최종 판정)

interface Created {
  oscillators: number
  filters: number
  bufferSources: Array<{ buffer: unknown; loop: boolean }>
}

function makeFakeAudio(decodeOk: boolean) {
  const created: Created = { oscillators: 0, filters: 0, bufferSources: [] }
  class Param {
    value = 0
    setValueAtTime() { return this }
    setTargetAtTime() { return this }
    exponentialRampToValueAtTime() { return this }
  }
  class FakeCtx {
    currentTime = 0
    sampleRate = 44100
    state = 'running'
    destination = {}
    createGain() { return { gain: new Param(), connect() {}, disconnect() {} } }
    createBufferSource() {
      const n = { buffer: null as unknown, loop: false, connect() {}, disconnect() {}, start() {}, stop() {} }
      created.bufferSources.push(n)
      return n
    }
    createBiquadFilter() {
      created.filters++
      return { type: '', frequency: new Param(), Q: new Param(), connect() {}, disconnect() {} }
    }
    createOscillator() {
      created.oscillators++
      return { type: '', frequency: new Param(), connect() {}, disconnect() {}, start() {}, stop() {} }
    }
    createBuffer(_ch: number, len: number) {
      return { duration: len / 44100, getChannelData: () => new Float32Array(len) }
    }
    decodeAudioData(_ab: ArrayBuffer) {
      return decodeOk
        ? Promise.resolve({ duration: 1, getChannelData: () => new Float32Array(1) })
        : Promise.reject(new Error('decode fail'))
    }
    resume() { return Promise.resolve() }
  }
  return { FakeCtx, created }
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

async function loadFreshSfx(opts: { fetchOk: boolean; decodeOk: boolean; created: Created; FakeCtx: unknown }) {
  vi.resetModules()
  vi.stubGlobal('localStorage', makeLocalStorage())
  vi.stubGlobal('AudioContext', opts.FakeCtx)
  vi.stubGlobal(
    'fetch',
    opts.fetchOk
      ? () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })
      : () => Promise.reject(new Error('network fail')),
  )
  const mod = await import('../sfx')
  mod.init() // AudioContext 생성 + 샘플 로드 개시
  await flush() // 로드 settle 대기(성공/실패 무관)
  return mod
}

describe('sfx 실음원 vs 합성 폴백 경로 선택', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('샘플 로드 실패(fetch 거부) → goalBurst/crowd/whistle가 합성 폴백 노드를 생성', async () => {
    const { FakeCtx, created } = makeFakeAudio(false)
    const sfx = await loadFreshSfx({ fetchOk: false, decodeOk: false, created, FakeCtx })
    sfx.goalBurst()
    expect(created.oscillators).toBeGreaterThan(0) // 골 합성(오실레이터 피치 스윕)
    const oscAfterGoal = created.oscillators
    sfx.crowdLoop('start', 0.3)
    expect(created.filters).toBeGreaterThan(0) // 합성 관중(lowpass 필터)
    sfx.whistle('fulltime')
    expect(created.oscillators).toBeGreaterThan(oscAfterGoal) // 휘슬 합성(사각파)
    expect(() => sfx.crowdLoop('stop')).not.toThrow()
  })

  it('디코드 실패(fetch는 성공, decode 거부)도 합성 폴백', async () => {
    const { FakeCtx, created } = makeFakeAudio(false)
    const sfx = await loadFreshSfx({ fetchOk: true, decodeOk: false, created, FakeCtx })
    sfx.goalBurst()
    expect(created.oscillators).toBeGreaterThan(0)
  })

  it('샘플 로드 성공 → 실음원 재생(디코드 버퍼 장착), 합성 노드 미생성', async () => {
    const { FakeCtx, created } = makeFakeAudio(true)
    const sfx = await loadFreshSfx({ fetchOk: true, decodeOk: true, created, FakeCtx })
    sfx.goalBurst()
    expect(created.oscillators).toBe(0) // 합성 오실레이터 미사용
    // goal 재생용 AudioBufferSourceNode에 디코드 버퍼가 장착됨
    expect(created.bufferSources.some((n) => n.buffer !== null)).toBe(true)

    sfx.crowdLoop('start', 0.3)
    expect(created.filters).toBe(0) // 실음원 관중은 lowpass 필터 없이 loop 재생
    expect(created.bufferSources.some((n) => n.loop === true)).toBe(true)

    sfx.whistle('fulltime')
    expect(created.oscillators).toBe(0) // 휘슬도 실음원(사각파 합성 안 함)
  })

  it('로드 완료 전 crowdLoop("start") 호출 → 로드 후 실음원으로 시작(초기 무음, 합성 폴백 안 함)', async () => {
    const { FakeCtx, created } = makeFakeAudio(true)
    vi.resetModules()
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.stubGlobal('AudioContext', FakeCtx)
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }))
    const sfx = await import('../sfx')
    sfx.init()
    sfx.crowdLoop('start', 0.3) // 로드 완료 전 — 대기 상태여야 함
    expect(created.filters).toBe(0) // 아직 합성 폴백으로 시작하지 않음
    await flush()
    // 로드 완료 후 실음원 loop로 시작
    expect(created.bufferSources.some((n) => n.loop === true)).toBe(true)
    expect(created.filters).toBe(0)
    vi.unstubAllGlobals()
  })
})
