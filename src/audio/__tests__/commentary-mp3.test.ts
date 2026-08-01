// @vitest-environment jsdom
// 중계 mp3 배선 테스트 — **오디오 파일 없이** 돈다.
//  (1) 미지원 환경(AudioContext 부재): 모든 함수가 조용한 no-op이고 throw하지 않는다.
//      → commentary-tts가 speechSynthesis로 떨어진다(폴백이 정상 경로다).
//  (2) 가짜 AudioContext + 가짜 fetch: 조회 규칙·이음매 스케줄·음소거 공유·순서 보존을
//      실제 그래프 조작으로 검증한다.
// bgm.test.ts와 같은 방식이다 — jsdom에는 Web Audio도 HTMLAudioElement도 온전치 않아
// 그래프를 흉내 내는 것 말고는 재현할 방법이 없다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

class FakeParam {
  value = 1
  ramps: { v: number; t: number }[] = []
  setValueAtTime(v: number): FakeParam { this.value = v; return this }
  setTargetAtTime(v: number, t: number): FakeParam { this.ramps.push({ v, t }); return this }
  linearRampToValueAtTime(v: number, t: number): FakeParam { this.ramps.push({ v, t }); return this }
  cancelScheduledValues(): FakeParam { return this }
  get last(): number { return this.ramps.length ? this.ramps[this.ramps.length - 1].v : this.value }
}

class FakeGain {
  gain = new FakeParam()
  connectedTo: unknown = null
  connect(dest: unknown): void { this.connectedTo = dest }
  disconnect(): void { this.connectedTo = null }
}

class FakeSource {
  buffer: { duration: number } | null = null
  loop = false
  playbackRate = new FakeParam()
  onended: (() => void) | null = null
  started: number | null = null
  stopped = false
  connectedTo: unknown = null
  connect(d: unknown): void { this.connectedTo = d }
  disconnect(): void {}
  start(when = 0): void { this.started = when }
  stop(): void { this.stopped = true }
}

/** 클립 길이(초). 이음매 스케줄 검산에 쓴다. */
const CLIP_SEC = 0.8

class FakeCtx {
  currentTime = 10
  state = 'running'
  sampleRate = 48000
  destination = { name: 'dest' }
  gains: FakeGain[] = []
  sources: FakeSource[] = []
  createGain(): FakeGain { const g = new FakeGain(); this.gains.push(g); return g }
  createBufferSource(): FakeSource { const s = new FakeSource(); this.sources.push(s); return s }
  createBiquadFilter() { return { type: '', frequency: new FakeParam(), Q: new FakeParam(), connect() {}, disconnect() {} } }
  createOscillator() { return { type: '', frequency: new FakeParam(), connect() {}, disconnect() {}, start() {}, stop() {} } }
  createBuffer(_c: number, len: number, rate: number) { return { duration: len / rate, getChannelData: () => new Float32Array(len) } }
  decodeAudioData(): Promise<{ duration: number }> { return Promise.resolve({ duration: CLIP_SEC }) }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve() }
}

function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

/** 실제 매니페스트가 내는 모양 그대로의 조회표. 값은 클립 키다. */
const INDEX = {
  v: 1,
  gapMs: 90,
  clips: {
    '골키퍼,': 't/aaa',
    '김승규입니다.': 'n/bbb',
    '김민재,': 'n/ccc',
    '네 명의 수비가 출전합니다.': 't/ddd',
  },
}

type Sfx = typeof import('../sfx')
type Mp3 = typeof import('../commentary-mp3')
type Tts = typeof import('../commentary-tts')

async function setup(opts: { audio?: boolean; index?: unknown } = {}) {
  vi.resetModules()
  const ctx = new FakeCtx()
  vi.stubGlobal('localStorage', makeLocalStorage())
  if (opts.audio !== false) {
    vi.stubGlobal('AudioContext', function AudioContextStub(this: unknown) { return ctx } as unknown as typeof AudioContext)
  } else {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
  }
  const idx = 'index' in opts ? opts.index : INDEX
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('index.json')) {
      return idx === null
        ? { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, json: async () => idx, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), json: async () => ({}) }
  }))
  const sfx = (await import('../sfx')) as Sfx
  const mp3 = (await import('../commentary-mp3')) as Mp3
  const tts = (await import('../commentary-tts')) as Tts
  return { sfx, mp3, tts, ctx }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

afterEach(() => { vi.unstubAllGlobals() })

describe('미지원 환경 — 조용한 폴백', () => {
  it('AudioContext가 없으면 재생이 false를 돌려주고 throw하지 않는다', async () => {
    const { mp3 } = await setup({ audio: false })
    mp3.loadClipIndex()
    await flush()
    expect(mp3.clipsReady()).toBe(true) // 조회표는 읽었다
    expect(mp3.hasClips('네 명의 수비가 출전합니다.')).toBe(true)
    // 그러나 유저 제스처 전이라 오디오 버스가 없다 → 재생은 못 한다.
    expect(mp3.playLine('네 명의 수비가 출전합니다.')).toBe(false)
    expect(() => mp3.stopAllClips()).not.toThrow()
    expect(mp3.clipsSpeaking()).toBe(false)
  })

  it('index.json이 404면 모든 문장이 폴백 대상이다', async () => {
    const { mp3 } = await setup({ index: null })
    mp3.loadClipIndex()
    await flush()
    expect(mp3.clipsReady()).toBe(false)
    expect(mp3.hasClips('네 명의 수비가 출전합니다.')).toBe(false)
    expect(mp3.resolveClips('무엇이든')).toBeNull()
  })
})

describe('조회 규칙', () => {
  it('통문장이 있으면 조각 하나', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(INDEX)
    expect(mp3.resolveClips('네 명의 수비가 출전합니다.')).toEqual(['t/ddd'])
  })

  it('`골키퍼, {이름}입니다.`는 첫 쉼표에서 둘로 갈린다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(INDEX)
    expect(mp3.resolveClips('골키퍼, 김승규입니다.')).toEqual(['t/aaa', 'n/bbb'])
  })

  it('한 조각이라도 없으면 null — 반쪽으로 붙이지 않는다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(INDEX)
    expect(mp3.resolveClips('골키퍼, 조현우입니다.')).toBeNull()
    expect(mp3.resolveClips('손흥민,')).toBeNull()
  })

  it('canSpeakAll은 전부 아니면 전무다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(INDEX)
    expect(mp3.canSpeakAll(['김민재,', '골키퍼, 김승규입니다.'])).toBe(true)
    expect(mp3.canSpeakAll(['김민재,', '손흥민,'])).toBe(false)
    expect(mp3.canSpeakAll([])).toBe(false)
  })
})

describe('재생 — 오디오 버스 공유', () => {
  it('sfx가 연 마스터 게인에 붙는다(음소거 토글 하나가 해설도 끊는다)', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init() // 유저 제스처
    mp3.loadClipIndex()
    await flush()
    mp3.prefetch(['네 명의 수비가 출전합니다.'])
    await flush()
    expect(mp3.playLine('네 명의 수비가 출전합니다.')).toBe(true)
    const src = ctx.sources[ctx.sources.length - 1]
    expect(src.connectedTo).toBe(sfx.audioBus()!.master)

    // 음소거는 마스터 게인을 0으로 — 해설 클립도 함께 죽는다.
    sfx.setMuted(true)
    expect((sfx.audioBus()!.master.gain as unknown as FakeParam).last).toBe(0)
  })

  it('두 조각은 gap만큼 띄워 예약된다 — 이음매 길이는 조회표가 정한다', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    mp3.prefetch(['골키퍼, 김승규입니다.'])
    await flush()
    ctx.sources.length = 0
    expect(mp3.playLine('골키퍼, 김승규입니다.')).toBe(true)
    expect(ctx.sources).toHaveLength(2)
    const [a, b] = ctx.sources
    expect(a.started).toBeCloseTo(ctx.currentTime, 5)
    expect(b.started! - a.started!).toBeCloseTo(CLIP_SEC + INDEX.gapMs / 1000, 5)
  })

  it('재생 속도는 playbackRate로 간다(상한 2배)', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    mp3.prefetch(['김민재,'])
    await flush()
    ctx.sources.length = 0
    mp3.playLine('김민재,', { speed: 1.5 })
    expect(ctx.sources[0].playbackRate.value).toBeCloseTo(1.5, 5)
    ctx.sources.length = 0
    mp3.playLine('김민재,', { speed: 8 })
    expect(ctx.sources[0].playbackRate.value).toBe(2)
  })

  it('queued 발화는 앞 발화 뒤에 이어 예약된다(순서 보존)', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    mp3.prefetch(['김민재,', '네 명의 수비가 출전합니다.'])
    await flush()
    ctx.sources.length = 0
    mp3.playLine('김민재,', { queued: true })
    mp3.playLine('네 명의 수비가 출전합니다.', { queued: true })
    const [a, b] = ctx.sources
    expect(b.started!).toBeGreaterThan(a.started! + CLIP_SEC - 1e-6)
  })

  it('stopAllClips가 예약을 전부 끊는다', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    mp3.prefetch(['김민재,'])
    await flush()
    ctx.sources.length = 0
    mp3.playLine('김민재,')
    expect(mp3.clipsSpeaking()).toBe(true)
    mp3.stopAllClips()
    expect(ctx.sources[0].stopped).toBe(true)
    expect(mp3.clipsSpeaking()).toBe(false)
  })

  it('아직 못 받은 클립은 false를 돌려주고(그 줄은 폴백) 배경으로 받아 둔다', async () => {
    const { sfx, mp3, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    ctx.sources.length = 0
    expect(mp3.playLine('김민재,')).toBe(false) // 아직 디코드 전
    await flush()
    expect(mp3.playLine('김민재,')).toBe(true) // 이제 받았다
  })
})

describe('commentary-tts 통합 — mp3 우선, speechSynthesis 폴백', () => {
  it('대본은 beginScript가 전부 덮인다고 할 때만 mp3로 간다', async () => {
    const { sfx, mp3, tts, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()

    // 한 줄이 빠진 대본 → 통째로 폴백(mp3 소스가 하나도 안 생긴다).
    expect(tts.beginScript(['김민재,', '손흥민,'])).toBe(false)
    ctx.sources.length = 0
    tts.speakScripted('김민재,')
    expect(ctx.sources).toHaveLength(0)

    // 전부 덮이는 대본 → mp3.
    expect(tts.beginScript(['김민재,', '골키퍼, 김승규입니다.'])).toBe(true)
    await flush()
    ctx.sources.length = 0
    tts.speakScripted('김민재,')
    expect(ctx.sources).toHaveLength(1)

    tts.endScript()
    ctx.sources.length = 0
    tts.speakScripted('김민재,')
    expect(ctx.sources).toHaveLength(0)
  })

  it('TTS 토글 OFF면 mp3도 나오지 않는다', async () => {
    const { sfx, mp3, tts, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    tts.beginScript(['김민재,'])
    await flush()
    tts.setTtsEnabled(false)
    ctx.sources.length = 0
    tts.speakScripted('김민재,')
    expect(ctx.sources).toHaveLength(0)
    tts.setTtsEnabled(true)
  })

  it('stopAll이 mp3 예약도 끊는다', async () => {
    const { sfx, mp3, tts, ctx } = await setup()
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    tts.beginScript(['김민재,'])
    await flush()
    ctx.sources.length = 0
    tts.speakScripted('김민재,')
    expect(ctx.sources).toHaveLength(1)
    tts.stopAll()
    expect(ctx.sources[0].stopped).toBe(true)
  })

  it('클립이 없으면 speak()는 예전 경로 그대로다(회귀 없음)', async () => {
    const { mp3, tts } = await setup({ index: null })
    mp3.loadClipIndex()
    await flush()
    // speechSynthesis도 없는 jsdom — 조용한 no-op이어야 한다.
    expect(() => tts.speak('전반 12분, 파울입니다.')).not.toThrow()
    expect(() => tts.speakAside('네, 위험한 위치는 아닙니다.')).not.toThrow()
  })
})

// ── 경기 중 중계 — 임의 개수 조각 ──────────────────────────────
// 입장 소개는 이음매가 1개(도입 + 이름)라 쉼표 한 번 자르면 끝이었다. 경기 중계는
// `여기서, / 전반 4분, / {이름}, / 슛이 골문을 벗어납니다.` 처럼 넷까지 간다.
// 조각 목록은 이음매가 적게 나오도록 설계됐고(tools/tts/live-corpus.mjs),
// 런타임은 그 설계를 **최소 조각 수**로 복원해야 한다.
const LIVE_INDEX = {
  v: 1,
  gapMs: 90,
  liveGapMs: 40,
  clips: {
    '여기서,': 'l/f1',
    '전반 4분,': 'l/m4',
    '손흥민,': 'l/n1',
    '슛이 골문을 벗어납니다.': 'l/b1',
    // 통문장 — 조각으로도 덮이지만 **한 조각**이 이겨야 한다.
    '전반 4분, 손흥민, 슛이 골문을 벗어납니다.': 'l/whole',
    '대한민국': 'l/t1',
    '대한민국 진영에서 반칙이 나옵니다.': 'l/t2',
  },
  warm: ['l/f1', 'l/m4', 'l/n1', 'l/b1'],
}

describe('임의 개수 조각 분해', () => {
  it('조각 넷을 순서대로 돌려준다', async () => {
    const { mp3 } = await setup()
    // 통문장을 뺀 조회표 — 조각으로만 덮는 경로를 본다.
    const { '전반 4분, 손흥민, 슛이 골문을 벗어납니다.': _whole, ...clips } = LIVE_INDEX.clips
    mp3.__setClipIndex({ ...LIVE_INDEX, clips })
    expect(mp3.resolveClips('여기서, 전반 4분, 손흥민, 슛이 골문을 벗어납니다.'))
      .toEqual(['l/f1', 'l/m4', 'l/n1', 'l/b1'])
  })

  it('덮는 방법이 여럿이면 **조각 수가 적은** 쪽을 고른다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(LIVE_INDEX)
    // 조각 셋으로도 덮이지만 통문장 하나가 있다 → 이음매 0.
    expect(mp3.resolveClips('전반 4분, 손흥민, 슛이 골문을 벗어납니다.')).toEqual(['l/whole'])
    // 팀명도 마찬가지 — `대한민국` + 본문(둘)보다 통으로 구운 것(하나)이 이긴다.
    expect(mp3.resolveClips('대한민국 진영에서 반칙이 나옵니다.')).toEqual(['l/t2'])
  })

  it('조각 사이 공백은 공짜로 건너뛴다(조회표 키는 trim된 정본이다)', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(LIVE_INDEX)
    expect(mp3.resolveClips('여기서, 손흥민, 슛이 골문을 벗어납니다.'))
      .toEqual(['l/f1', 'l/n1', 'l/b1'])
  })

  it('한 조각이라도 없으면 그 문장만 null — 경기 중은 문장 단위 폴백이다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex(LIVE_INDEX)
    expect(mp3.resolveClips('여기서, 이강인, 슛이 골문을 벗어납니다.')).toBeNull()
    // 옆 문장은 멀쩡하다(대본의 전부 아니면 전무와 다른 계약).
    expect(mp3.resolveClips('대한민국 진영에서 반칙이 나옵니다.')).toEqual(['l/t2'])
  })
})

describe('문장 안 이음매 — 무음과 재생 속도', () => {
  async function ready() {
    const r = await setup({ index: LIVE_INDEX })
    r.sfx.init()
    r.mp3.loadClipIndex()
    await flush()
    r.mp3.prefetch(['여기서, 손흥민, 슛이 골문을 벗어납니다.'])
    await flush()
    r.ctx.sources.length = 0
    return r
  }

  it('live 발화는 대본보다 짧은 무음을 쓴다', async () => {
    const { mp3, ctx } = await ready()
    mp3.playLine('여기서, 손흥민, 슛이 골문을 벗어납니다.', { live: true })
    const [a, b] = ctx.sources
    expect(b.started! - a.started!).toBeCloseTo(CLIP_SEC + LIVE_INDEX.liveGapMs / 1000, 5)

    ctx.sources.length = 0
    mp3.playLine('여기서, 손흥민, 슛이 골문을 벗어납니다.')
    const [c, d] = ctx.sources
    expect(d.started! - c.started!).toBeCloseTo(CLIP_SEC + LIVE_INDEX.gapMs / 1000, 5)
  })

  it('무음도 재생 속도로 나뉜다 — 2배속에서 문장이 두 배로 짧아진다', async () => {
    const { mp3, ctx } = await ready()
    mp3.playLine('여기서, 손흥민, 슛이 골문을 벗어납니다.', { live: true, speed: 2 })
    const [a, , c] = ctx.sources
    expect(ctx.sources).toHaveLength(3)
    const gap = LIVE_INDEX.liveGapMs / 1000
    expect(c.started! - a.started!).toBeCloseTo(((CLIP_SEC + gap) * 2) / 2, 5)
  })
})

describe('미리 받기 — 조각의 첫 등장이 폴백이 되지 않게', () => {
  it('warm 목록을 빈도 순으로 받아 두고, 두 번 부르지 않는다', async () => {
    const { sfx, mp3 } = await setup({ index: LIVE_INDEX })
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    mp3.warmLive()
    await flush()
    const got = fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.includes('/tts/l/'))
    expect(got).toHaveLength(LIVE_INDEX.warm.length)
    for (const k of LIVE_INDEX.warm) expect(got.some(u => u.includes(k))).toBe(true)

    // 두 번째 호출은 아무것도 더 받지 않는다.
    fetchMock.mockClear()
    mp3.warmLive()
    await flush()
    expect(fetchMock.mock.calls).toHaveLength(0)
  })

  it('유저 제스처 전(오디오 버스 없음)에는 아무 일도 하지 않는다 — 다음에 다시 시도한다', async () => {
    const { sfx, mp3 } = await setup({ index: LIVE_INDEX })
    mp3.loadClipIndex()
    await flush()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    mp3.warmLive() // 버스가 아직 없다
    await flush()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/tts/l/'))).toHaveLength(0)
    sfx.init()
    mp3.warmLive()
    await flush()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/tts/l/')).length).toBeGreaterThan(0)
  })

  it('beginScript가 경기 중 조각 받기를 깨운다(대본이 덮이지 않아도)', async () => {
    const { sfx, mp3, tts } = await setup({ index: LIVE_INDEX })
    sfx.init()
    mp3.loadClipIndex()
    await flush()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    expect(tts.beginScript(['덮이지 않는 대본 한 줄'])).toBe(false)
    await flush()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/tts/l/')).length).toBeGreaterThan(0)
  })
})

describe('빌드 산출물 계약', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  it('매니페스트가 내는 조회표 모양을 그대로 읽는다', async () => {
    const { mp3 } = await setup()
    mp3.__setClipIndex({ v: 1, gapMs: 90, clips: { '스리백입니다.': 't/x' } })
    expect(mp3.hasClips('스리백입니다.')).toBe(true)
    // 앞뒤 공백은 다듬는다(대본 문자열이 sanitizeSpeech를 거치므로 실전에선 없다).
    expect(mp3.hasClips('  스리백입니다.  ')).toBe(true)
  })
})
