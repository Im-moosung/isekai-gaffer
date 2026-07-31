// @vitest-environment jsdom
// BGM 배선 테스트 — 두 층으로 나눈다.
//  (1) 미지원 환경(jsdom 기본, AudioContext 부재): 모든 함수가 조용한 no-op이고 throw하지 않는다.
//  (2) 가짜 AudioContext 주입: 장면 매핑·크로스페이드·스팅 우선·덕킹·일시정지·음소거 공유를
//      실제 오디오 그래프 조작으로 검증한다(jsdom엔 Web Audio가 없으므로 그래프를 흉내 낸다).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── 가짜 Web Audio 그래프 ─────────────────────────────────────
class FakeParam {
  value = 1
  /** 예약된 램프 [목표값, 목표 시각(초)] — 크로스페이드·덕킹 검증에 쓴다. */
  ramps: { v: number; t: number }[] = []
  setValueAtTime(v: number, _t: number): FakeParam {
    this.value = v
    return this
  }
  linearRampToValueAtTime(v: number, t: number): FakeParam {
    this.ramps.push({ v, t })
    return this
  }
  setTargetAtTime(v: number, t: number, _c: number): FakeParam {
    this.ramps.push({ v, t })
    return this
  }
  exponentialRampToValueAtTime(v: number, t: number): FakeParam {
    this.ramps.push({ v, t })
    return this
  }
  cancelScheduledValues(_t: number): FakeParam {
    return this
  }
  /** 마지막으로 예약된 목표값(없으면 현재 값). */
  get last(): number {
    return this.ramps.length ? this.ramps[this.ramps.length - 1].v : this.value
  }
}

class FakeGain {
  gain = new FakeParam()
  connectedTo: unknown = null
  connect(dest: unknown): void {
    this.connectedTo = dest
  }
  disconnect(): void {
    this.connectedTo = null
  }
}

class FakeSource {
  buffer: { duration: number } | null = null
  loop = false
  playbackRate = new FakeParam()
  onended: (() => void) | null = null
  started: { when: number; offset: number } | null = null
  stopped: number | null = null
  connect(): void {}
  disconnect(): void {}
  start(when = 0, offset = 0): void {
    this.started = { when, offset }
  }
  stop(when = 0): void {
    this.stopped = when
  }
}

class FakeCtx {
  currentTime = 10
  state = 'running'
  destination = { name: 'dest' }
  gains: FakeGain[] = []
  sources: FakeSource[] = []
  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createBiquadFilter() {
    return { type: '', frequency: new FakeParam(), Q: new FakeParam(), connect() {}, disconnect() {} }
  }
  createOscillator() {
    return {
      type: '', frequency: new FakeParam(), connect() {}, disconnect() {},
      start() {}, stop() {},
    }
  }
  createBuffer(_ch: number, len: number, rate: number) {
    return { duration: len / rate, getChannelData: () => new Float32Array(len) }
  }
  sampleRate = 48000
  decodeAudioData(_data: ArrayBuffer): Promise<{ duration: number }> {
    // 모든 트랙을 28.8초로 가정한다(실제 루프 길이). 스팅 길이 계약은 별도 테스트에서 덮어쓴다.
    return Promise.resolve({ duration: DECODE_DURATION })
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
}

let DECODE_DURATION = 28.8

function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

type Sfx = typeof import('../sfx')
type Bgm = typeof import('../bgm')

/** 가짜 컨텍스트를 주입한 새 모듈 쌍을 만든다(모듈 상태가 테스트 간에 새지 않게 resetModules). */
async function setup(): Promise<{ sfx: Sfx; bgm: Bgm; ctx: FakeCtx }> {
  vi.resetModules()
  const ctx = new FakeCtx()
  vi.stubGlobal('localStorage', makeLocalStorage())
  vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) {
    return ctx
  } as unknown as typeof AudioContext)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
  const sfx = (await import('../sfx')) as Sfx
  const bgm = (await import('../bgm')) as Bgm
  return { sfx, bgm, ctx }
}

/** 로드(fetch+decode) 마이크로태스크가 전부 흐를 때까지 기다린다. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  DECODE_DURATION = 28.8
})

// ── (1) 미지원 환경 ───────────────────────────────────────────
describe('bgm 미지원 환경 no-op — 크래시 금지', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  it('AudioContext 부재(jsdom)에서 모든 함수가 throw 없이 반환한다', async () => {
    const bgm = await import('../bgm')
    expect(() => {
      bgm.setScene('landing')
      bgm.setScene('hub')
      bgm.playSting('M06', { alignEndAtMs: 62730 })
      bgm.stopSting()
      bgm.duck()
      bgm.setPaused(true)
      bgm.setPaused(false)
      bgm.stopAll()
    }).not.toThrow()
    expect(bgm.bgmState().ready).toBe(false)
  })

  it('장면 선언은 기억하되 소리는 내지 않는다(제스처 전 자동재생 금지)', async () => {
    const bgm = await import('../bgm')
    bgm.setScene('landing')
    expect(bgm.currentScene()).toBe('landing')
    expect(bgm.bgmState().loop).toBeNull()
  })
})

// ── (2) 가짜 그래프 ───────────────────────────────────────────
describe('bgm 장면 배선', () => {
  it('제스처(sfx.init) 전에는 재생하지 않고, 열리면 대기 중이던 장면이 시작된다', async () => {
    const { sfx, bgm } = await setup()
    bgm.setScene('hub')
    await flush()
    expect(bgm.bgmState().loop).toBeNull() // 컨텍스트가 없다 = 무음

    sfx.init() // 유저 제스처 경로
    await flush()
    expect(bgm.bgmState().loop).toBe('M02') // 허브 = M02
  })

  it('장면 → 곡 매핑이 스펙 표와 일치한다', async () => {
    const { sfx, bgm } = await setup()
    sfx.init()
    for (const [scene, track] of [
      ['landing', 'M01'], ['hub', 'M02'], ['warroom', 'M03'],
      ['tactics', 'M04'], ['shootout', 'M05'], ['clutch', 'M09'],
    ] as const) {
      bgm.setScene(scene)
      await flush()
      expect(bgm.bgmState().loop).toBe(track)
    }
  })

  it('null 장면은 음악 없음 — 인플레이 기본값(유예 후)', async () => {
    const { sfx, bgm } = await setup()
    sfx.init()
    bgm.setScene('warroom')
    await flush()
    bgm.setScene(null)
    // 유예(250ms) 동안은 아직 울린다 — 화면 전환의 언마운트/마운트 틈을 메운다.
    expect(bgm.bgmState().loop).toBe('M03')
    await new Promise(r => setTimeout(r, 320))
    await flush()
    expect(bgm.bgmState().loop).toBeNull()
  })

  it('유예 안에 새 장면이 선언되면 끊지 않는다(언마운트 → 마운트 순서)', async () => {
    const { sfx, bgm } = await setup()
    sfx.init()
    bgm.setScene('hub')
    await flush()
    bgm.setScene(null) // 이전 화면 언마운트
    bgm.setScene('warroom') // 곧바로 다음 화면 마운트
    await flush()
    await new Promise(r => setTimeout(r, 320))
    expect(bgm.bgmState().loop).toBe('M03')
  })

  it('전환은 하드 컷이 아니라 300~500ms 크로스페이드다', async () => {
    const { sfx, bgm, ctx } = await setup()
    sfx.init()
    bgm.setScene('hub')
    await flush()
    const before = ctx.gains.length
    bgm.setScene('warroom')
    await flush()
    // 나가는 보이스는 0으로, 들어오는 보이스는 목표 게인으로 같은 길이만큼 램프한다.
    const fadeOut = ctx.gains.slice(0, before).find(g => g.gain.ramps.some(r => r.v === 0))
    const fadeIn = ctx.gains.slice(before).find(g => g.gain.ramps.some(r => r.v > 0))
    expect(fadeOut).toBeTruthy()
    expect(fadeIn).toBeTruthy()
    const outMs = (fadeOut!.gain.ramps[fadeOut!.gain.ramps.length - 1].t - ctx.currentTime) * 1000
    const inMs = (fadeIn!.gain.ramps[fadeIn!.gain.ramps.length - 1].t - ctx.currentTime) * 1000
    expect(outMs).toBeGreaterThanOrEqual(300)
    expect(outMs).toBeLessThanOrEqual(500)
    expect(inMs).toBeCloseTo(outMs, 5)
    expect(bgm.bgmState().loop).toBe('M03')
  })

  it('새 곡이 준비되기 전에는 이전 곡을 끊지 않는다(무음 구간 금지)', async () => {
    // 실측으로 잡은 결함: 먼저 걷고 나중에 로드하면 크로스페이드가 아니라
    // 페이드아웃 → 침묵(629ms) → 페이드인이 된다.
    const { sfx, bgm } = await setup()
    sfx.init()
    bgm.setScene('hub')
    await flush()
    expect(bgm.bgmState().loop).toBe('M02')
    bgm.setScene('warroom') // M03은 아직 미로드
    expect(bgm.bgmState().loop).toBe('M02') // 이전 곡이 계속 울린다
    await flush()
    expect(bgm.bgmState().loop).toBe('M03') // 준비된 순간에 교체
  })
})

describe('bgm 스팅', () => {
  it('스팅이 도는 동안 장면 루프는 시작을 미룬다(하프타임 M07 → 작전판 M04)', async () => {
    const { sfx, bgm } = await setup()
    sfx.init()
    bgm.playSting('M07')
    await flush()
    expect(bgm.bgmState().sting).toBe('M07')
    bgm.setScene('tactics')
    await flush()
    expect(bgm.bgmState().loop).toBeNull() // 아직 팡파르가 돈다
    expect(bgm.currentScene()).toBe('tactics') // 원하는 상태는 기억한다
  })

  it('stopSting 후에는 대기 중이던 장면 루프가 들어온다', async () => {
    const { sfx, bgm } = await setup()
    sfx.init()
    bgm.playSting('M07')
    await flush()
    bgm.setScene('tactics')
    await flush()
    bgm.stopSting()
    await flush()
    expect(bgm.bgmState().sting).toBeNull()
    expect(bgm.bgmState().loop).toBe('M04')
  })

  it('M06은 alignEndAtMs로 **끝을 맞춘다** — full은 늦게 시작, short는 앞을 자른다', async () => {
    DECODE_DURATION = 13.8
    const { sfx, bgm, ctx } = await setup()
    sfx.init()

    // full 62.73s: 13.8s 곡이 끝에서 끝나려면 48.93s 뒤에 시작해야 한다.
    bgm.playSting('M06', { alignEndAtMs: 62730 })
    await flush()
    const full = ctx.sources[ctx.sources.length - 1]
    expect(full.started).toBeTruthy()
    expect(full.started!.when - ctx.currentTime).toBeCloseTo(48.93, 1)
    expect(full.started!.offset).toBeCloseTo(0, 3)

    // short 13.00s: 곡이 0.8s 더 길다 → 앞 0.8s를 잘라 낸다(해소는 휘슬에 맞는다).
    bgm.stopSting(0)
    bgm.playSting('M06', { alignEndAtMs: 13000 })
    await flush()
    const short = ctx.sources[ctx.sources.length - 1]
    expect(short.started!.when - ctx.currentTime).toBeCloseTo(0, 2)
    expect(short.started!.offset).toBeCloseTo(0.8, 1)
  })
})

describe('bgm 덕킹 · 일시정지 · 음소거', () => {
  it('duck()은 0.1배로 눌렀다가 되돌린다(관중음 덕킹과 같은 배율)', async () => {
    const { sfx, bgm, ctx } = await setup()
    sfx.init()
    bgm.setScene('clutch')
    await flush()
    bgm.duck()
    const ducked = ctx.gains.find(g => g.gain.ramps.some(r => r.v === bgm.DUCK_RATIO))
    expect(bgm.DUCK_RATIO).toBe(0.1)
    expect(ducked).toBeTruthy()
    // 마지막 예약은 원위치(1배)로 돌아오는 램프여야 한다 — 눌린 채로 남지 않는다.
    expect(ducked!.gain.ramps[ducked!.gain.ramps.length - 1].v).toBe(1)
  })

  it('일시정지는 소스를 멈추고, 재개는 끊긴 위치에서 이어 붙인다', async () => {
    const { sfx, bgm, ctx } = await setup()
    sfx.init()
    bgm.setScene('tactics')
    await flush()
    const first = ctx.sources[ctx.sources.length - 1]
    expect(first.started).toBeTruthy()

    ctx.currentTime += 5 // 5초 재생
    bgm.setPaused(true)
    expect(first.stopped).not.toBeNull()
    expect(bgm.bgmState().paused).toBe(true)

    ctx.currentTime += 30 // 정지 상태로 30초 경과 — 곡은 흐르지 않아야 한다
    bgm.setPaused(false)
    const resumed = ctx.sources[ctx.sources.length - 1]
    expect(resumed).not.toBe(first)
    expect(resumed.started!.offset).toBeCloseTo(5, 3) // 30초가 아니라 끊긴 자리
  })

  it('기존 음소거 토글 하나가 BGM도 끊는다 — 별도 토글 없음', async () => {
    const { sfx, bgm, ctx } = await setup()
    sfx.init()
    bgm.setScene('hub')
    await flush()
    // BGM 버스는 sfx masterGain 아래에 붙는다(=마스터 게인 0이면 음악도 0).
    const master = ctx.gains[0] // ensureCtx가 가장 먼저 만드는 노드
    expect(master.connectedTo).toBe(ctx.destination)
    sfx.setMuted(true)
    expect(master.gain.last).toBe(0)
    sfx.setMuted(false)
    expect(master.gain.last).toBe(1)
    // bgm 모듈은 음소거 API를 노출하지 않는다.
    expect('setMuted' in bgm).toBe(false)
  })
})
