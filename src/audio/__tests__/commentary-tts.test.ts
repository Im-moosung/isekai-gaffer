// @vitest-environment jsdom
// 한국어 TTS 중계 로직 테스트 — jsdom엔 speechSynthesis가 없으므로 no-op 경로를 타거나,
// 최소 Fake speechSynthesis/SpeechSynthesisUtterance를 주입해 큐 정책·강조·토글을 검증한다.
// 실제 음성 출력은 사용자가 dev 서버에서 최종 판정.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { MatchEvent, MatchEventType } from '../../engine/types'

const TTS_KEY = 'rematch-tts'

// 인메모리 localStorage 스텁(sfx 테스트와 동일 패턴 — jsdom은 기본 미노출).
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

// 노드 생성/호출을 기록하는 최소 Fake speechSynthesis.
interface FakeVoice { lang: string; name: string }
function makeFakeSynth(getVoices: () => FakeVoice[]) {
  const calls = { speak: 0, cancel: 0, spoken: [] as Array<{ text: string; rate: number; pitch: number; lang: string }> }
  const listeners: Record<string, Array<() => void>> = {}
  let speaking = false
  const synth = {
    get speaking() { return speaking },
    getVoices: () => getVoices(),
    speak(u: { text: string; rate: number; pitch: number; lang: string }) {
      calls.speak++
      calls.spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch, lang: u.lang })
      speaking = true
    },
    cancel() { calls.cancel++; speaking = false },
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn) },
    // 테스트 편의 훅
    __emit(type: string) { (listeners[type] ?? []).forEach(f => f()) },
    __setSpeaking(v: boolean) { speaking = v },
  }
  return { synth, calls }
}

class FakeUtterance {
  text: string
  voice: unknown = null
  lang = ''
  rate = 1
  pitch = 1
  constructor(text: string) { this.text = text }
}

// 각 테스트마다 신선한 모듈(모듈 상태: available·voice·voiceInitStarted·ttsOn)로 격리.
async function loadFresh(opts: { synth?: unknown } = {}) {
  vi.resetModules()
  vi.stubGlobal('localStorage', makeLocalStorage())
  // synth 미지정 = 미지원 환경(speechSynthesis undefined).
  vi.stubGlobal('speechSynthesis', opts.synth ?? undefined)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  return await import('../commentary-tts')
}

const ev = (type: MatchEventType, minute = 10): MatchEvent => ({ minute, type, teamId: 'KOR' })

afterEach(() => vi.unstubAllGlobals())

describe('commentary-tts 미지원·보이스 없음 no-op — 크래시 금지', () => {
  it('speechSynthesis 미지원 → initVoice/speak/stopAll 모두 throw 없이 no-op', async () => {
    const ctts = await loadFresh({}) // synth 없음
    expect(() => ctts.initVoice()).not.toThrow()
    expect(() => ctts.speak('테스트 라인')).not.toThrow()
    expect(() => ctts.speak('중요 라인', { important: true })).not.toThrow()
    expect(() => ctts.stopAll()).not.toThrow()
  })

  it('ko-KR 보이스 없음(영어만) → available=false로 speak가 발화하지 않음', async () => {
    const { synth, calls } = makeFakeSynth(() => [{ lang: 'en-US', name: 'Alex' }])
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    ctts.speak('안녕하세요')
    expect(calls.speak).toBe(0)
  })

  it('보이스 목록 지연 로드 → voiceschanged 후 ko 보이스가 오면 발화 가능', async () => {
    let voices: FakeVoice[] = []
    const { synth, calls } = makeFakeSynth(() => voices)
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    ctts.speak('첫 시도') // 아직 보이스 없음 → no-op
    expect(calls.speak).toBe(0)
    voices = [{ lang: 'ko-KR', name: 'Yuna' }]
    synth.__emit('voiceschanged')
    ctts.speak('둘째 시도') // 이제 발화
    expect(calls.speak).toBe(1)
  })
})

describe('commentary-tts 큐 정책 (speechSynthesis mock)', () => {
  async function withVoice() {
    const { synth, calls } = makeFakeSynth(() => [{ lang: 'ko-KR', name: 'Yuna' }])
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    return { ctts, synth, calls }
  }

  it('발화 중이 아니면 일반 라인 발화(rate 1.05·pitch 1.0·lang ko-KR)', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('일반 라인')
    expect(calls.speak).toBe(1)
    expect(calls.spoken[0].rate).toBeCloseTo(1.05)
    expect(calls.spoken[0].pitch).toBeCloseTo(1.0)
    expect(calls.spoken[0].lang).toBe('ko-KR')
  })

  it('important 라인은 rate 1.15·pitch 1.15 강조', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('골!', { important: true })
    expect(calls.speak).toBe(1)
    expect(calls.spoken[0].rate).toBeCloseTo(1.15)
    expect(calls.spoken[0].pitch).toBeCloseTo(1.15)
  })

  it('발화 중이면 일반 라인은 스킵(드롭) — cancel 없음', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('진행 중 라인') // 발화 시작(speaking=true)
    ctts.speak('둘째 일반 라인') // 드롭
    expect(calls.speak).toBe(1)
    expect(calls.cancel).toBe(0)
  })

  it('발화 중이라도 important는 현재 발화를 cancel 후 즉시 발화(선점)', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('진행 중 라인') // 발화 시작
    ctts.speak('골!!', { important: true }) // 선점
    expect(calls.cancel).toBe(1)
    expect(calls.speak).toBe(2)
    expect(calls.spoken[1].text).toBe('골!!')
  })

  it('stopAll은 speechSynthesis.cancel을 호출한다', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('중계 중')
    ctts.stopAll()
    expect(calls.cancel).toBe(1)
  })
})

describe('commentary-tts 토글 + localStorage 기억', () => {
  it('기본값은 ON', async () => {
    const ctts = await loadFresh({})
    expect(ctts.isTtsEnabled()).toBe(true)
  })

  it('setTtsEnabled(false)면 isTtsEnabled false + localStorage "0" 기록', async () => {
    const ctts = await loadFresh({})
    ctts.setTtsEnabled(false)
    expect(ctts.isTtsEnabled()).toBe(false)
    expect(localStorage.getItem(TTS_KEY)).toBe('0')
  })

  it('setTtsEnabled(true)면 localStorage 키 제거(기본 ON 복귀)', async () => {
    const ctts = await loadFresh({})
    ctts.setTtsEnabled(false)
    ctts.setTtsEnabled(true)
    expect(ctts.isTtsEnabled()).toBe(true)
    expect(localStorage.getItem(TTS_KEY)).toBeNull()
  })

  it('toggleTts는 상태를 뒤집고 새 상태를 반환', async () => {
    const ctts = await loadFresh({})
    expect(ctts.toggleTts()).toBe(false)
    expect(ctts.isTtsEnabled()).toBe(false)
    expect(ctts.toggleTts()).toBe(true)
    expect(ctts.isTtsEnabled()).toBe(true)
  })

  it('readStoredTts: 부재 시 true(ON), 저장값 "0"이면 false', async () => {
    const ctts = await loadFresh({})
    expect(ctts.readStoredTts()).toBe(true) // 부재 = 기본 ON
    localStorage.setItem(TTS_KEY, '0')
    expect(ctts.readStoredTts()).toBe(false) // '0' = OFF
  })

  it('토글 OFF면 보이스가 있어도 speak가 no-op', async () => {
    const { synth, calls } = makeFakeSynth(() => [{ lang: 'ko-KR', name: 'Yuna' }])
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    ctts.setTtsEnabled(false)
    ctts.speak('발화 안 됨', { important: true })
    expect(calls.speak).toBe(0)
  })

  it('발화 중 토글 OFF면 진행 발화를 stopAll로 중단', async () => {
    const { synth, calls } = makeFakeSynth(() => [{ lang: 'ko-KR', name: 'Yuna' }])
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    ctts.speak('중계 중')
    ctts.setTtsEnabled(false)
    expect(calls.cancel).toBe(1)
  })
})

describe('pickSpokenEvent 대표 이벤트 선정 우선순위', () => {
  it('goal > save > miss > corner > foul (최상위 1개)', async () => {
    const { pickSpokenEvent } = await loadFresh({})
    expect(pickSpokenEvent([ev('foul'), ev('corner'), ev('goal')])?.type).toBe('goal')
    expect(pickSpokenEvent([ev('foul'), ev('save'), ev('miss')])?.type).toBe('save')
    expect(pickSpokenEvent([ev('foul'), ev('miss'), ev('corner')])?.type).toBe('miss')
    expect(pickSpokenEvent([ev('foul'), ev('corner')])?.type).toBe('corner')
    expect(pickSpokenEvent([ev('foul')])?.type).toBe('foul')
  })

  it('발화 대상 아닌 타입만 있으면 null', async () => {
    const { pickSpokenEvent } = await loadFresh({})
    expect(pickSpokenEvent([ev('kickoff'), ev('chance'), ev('shot')])).toBeNull()
    expect(pickSpokenEvent([ev('yellow'), ev('sub'), ev('halftime')])).toBeNull()
  })

  it('빈 배열 → null', async () => {
    const { pickSpokenEvent } = await loadFresh({})
    expect(pickSpokenEvent([])).toBeNull()
  })
})
