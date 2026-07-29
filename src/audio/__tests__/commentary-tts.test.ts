// @vitest-environment jsdom
// 한국어 TTS 중계 로직 테스트 — jsdom엔 speechSynthesis가 없으므로 no-op 경로를 타거나,
// 최소 Fake speechSynthesis/SpeechSynthesisUtterance를 주입해 큐 정책·강조·토글을 검증한다.
// 실제 음성 출력은 사용자가 dev 서버에서 최종 판정.
import { describe, it, expect, afterEach, vi } from 'vitest'

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
  let pending = false
  const synth = {
    get speaking() { return speaking },
    // pending = 아직 시작 안 한 발화가 큐에 남았는가(speakAside의 과밀 가드).
    get pending() { return pending },
    getVoices: () => getVoices(),
    speak(u: { text: string; rate: number; pitch: number; lang: string }) {
      calls.speak++
      calls.spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch, lang: u.lang })
      speaking = true
    },
    cancel() { calls.cancel++; speaking = false; pending = false },
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn) },
    // 테스트 편의 훅
    __emit(type: string) { (listeners[type] ?? []).forEach(f => f()) },
    __setSpeaking(v: boolean) { speaking = v },
    __setPending(v: boolean) { pending = v },
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

  // ★ §5.7 재조정: 한국어 중계의 흥분은 "빠름"이 아니라 "높고 길게"다.
  //   예전(rate 1.15)은 골 순간에 선수 이름을 뭉갰다. 이제 rate를 내리고 pitch를 올린다.
  it('important 라인은 rate를 올리지 않고 pitch로 강조한다(§5.7)', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('골!', { important: true })
    expect(calls.speak).toBe(1)
    expect(calls.spoken[0].rate).toBeCloseTo(1.0)
    expect(calls.spoken[0].pitch).toBeCloseTo(1.3)
  })

  it('피크(강도 3)는 가장 느리고 가장 높다 — 골 순간은 오히려 천천히 내지른다', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('골! 손흥민!', { important: true, intensity: 3 })
    expect(calls.spoken[0].rate).toBeCloseTo(0.95)
    expect(calls.spoken[0].pitch).toBeCloseTo(1.35)
  })

  it('해설위원은 pitch가 캐스터보다 확실히 낮다 — 보이스 하나로 두 사람을 만든다', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('캐스터 문장')
    ctts.speakAside('해설위원 문장')
    expect(calls.speak).toBe(2)
    expect(calls.spoken[1].pitch).toBeCloseTo(0.75)
    // 두 화자의 pitch 간격이 0.2 미만이면 같은 목소리로 들린다.
    expect(calls.spoken[0].pitch - calls.spoken[1].pitch).toBeGreaterThanOrEqual(0.2)
  })

  it('speakAside는 캐스터 발화를 선점하지 않고 큐에 이어 붙인다(§5.6 체이닝)', async () => {
    const { ctts, calls } = await withVoice()
    ctts.speak('캐스터 문장') // speaking = true
    ctts.speakAside('해설이 받는 문장')
    expect(calls.cancel).toBe(0) // 캐스터를 자르지 않는다
    expect(calls.speak).toBe(2) // 드롭도 하지 않는다 — 뒤에 붙는다
    expect(calls.spoken[1].text).toBe('해설이 받는 문장')
  })

  it('이미 큐가 밀려 있으면(pending) 곁들임 발화를 얹지 않는다', async () => {
    const { ctts, synth, calls } = await withVoice()
    ctts.speak('캐스터 문장')
    synth.__setPending(true)
    ctts.speakAside('버려질 해설')
    expect(calls.speak).toBe(1)
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

// ★ 대표 이벤트 선정(구 pickSpokenEvent)은 playback.pickDramaEvent로 이관했다 —
//   음성과 안무가 하나의 선택자를 공유해야 하므로 오디오 모듈이 가질 규칙이 아니다.
//   우선순위 테스트는 src/ui/match/__tests__/playback.test.ts에 있다.

describe('countSyllables — 한국어 발화 음절 수', () => {
  it('한글 음절만 센다(공백·구두점 0)', async () => {
    const { countSyllables } = await loadFresh({})
    expect(countSyllables('골망을 흔듭니다!')).toBe(7)
    expect(countSyllables('   ,.!\'')).toBe(0)
    expect(countSyllables('')).toBe(0)
  })

  it('숫자는 한국어 수사 길이(자리당 1.5음절)로 근사한다', async () => {
    const { countSyllables } = await loadFresh({})
    expect(countSyllables('7')).toBe(1.5) // "칠"
    expect(countSyllables('72')).toBe(3) // "칠십이"
  })

  it('한글·숫자 혼합 실문장', async () => {
    const { countSyllables } = await loadFresh({})
    // "72' 손흥민, 골망을 흔듭니다!" → 숫자 2자리(3) + 한글 10
    expect(countSyllables("72' 손흥민, 골망을 흔듭니다!")).toBe(13)
  })
})

describe('estimateSpeechMs — 발화 소요 시간 추정', () => {
  it('빈 문장은 0(발화 없음 → 체류 보정 없음)', async () => {
    const { estimateSpeechMs } = await loadFresh({})
    expect(estimateSpeechMs('')).toBe(0)
    expect(estimateSpeechMs('  ')).toBe(0)
  })

  it('음절 수에 비례해 길어진다', async () => {
    const { estimateSpeechMs } = await loadFresh({})
    const short = estimateSpeechMs('골입니다')
    const long = estimateSpeechMs('골입니다 골입니다 골입니다 골입니다')
    expect(long).toBeGreaterThan(short)
  })

  // ★ §5.7 이후: important는 rate를 **낮춘다**(높고 길게). 그래서 더 오래 걸린다 —
  //   체류 시간(dwell)이 그만큼 늘어야 골 순간의 선수 이름이 잘리지 않는다.
  it('important(rate 하향)는 같은 문장을 더 길게 읽는다', async () => {
    const { estimateSpeechMs } = await loadFresh({})
    const line = "72' 손흥민, 골망을 흔듭니다!"
    expect(estimateSpeechMs(line, true)).toBeGreaterThan(estimateSpeechMs(line, false))
    expect(estimateSpeechMs(line, 'peak')).toBeGreaterThan(estimateSpeechMs(line, 'important'))
  })

  it('estimatePairMs: 해설이 붙으면 총 발화가 길어지되 체이닝 할인만큼 줄어든다', async () => {
    const { estimatePairMs, estimateSpeechMs, PAIR_CHAIN_DISCOUNT_MS } = await loadFresh({})
    const caster = '골! 손흥민!'
    const analyst = '네, 선제골의 무게가 큽니다.'
    const only = estimatePairMs(caster, 'peak', undefined)
    const pair = estimatePairMs(caster, 'peak', analyst)
    expect(only).toBe(estimateSpeechMs(caster, 'peak'))
    expect(pair).toBe(only + estimateSpeechMs(analyst, 'analyst') - PAIR_CHAIN_DISCOUNT_MS)
    expect(pair).toBeGreaterThan(only)
  })

  it('실문장 추정치가 상식 범위(1~4초)에 있다 — 실측 계수 회귀 고정', async () => {
    const { estimateSpeechMs, SYLLABLES_PER_SEC, SPEECH_TAIL_MS } = await loadFresh({})
    expect(SYLLABLES_PER_SEC).toBe(5.6)
    expect(SPEECH_TAIL_MS).toBe(650)
    for (const line of [
      "72' 손흥민, 골망을 흔듭니다!",
      "45' 대한민국 골키퍼가 슛을 걷어냅니다.",
      "13' 이강인의 슛, 골문을 빗나갑니다.",
      "88' 스페인의 코너킥 기회입니다.",
    ]) {
      const ms = estimateSpeechMs(line)
      expect(ms).toBeGreaterThan(1000)
      expect(ms).toBeLessThan(4000)
    }
  })

  it('결정론 — 같은 입력에 항상 같은 값', async () => {
    const { estimateSpeechMs } = await loadFresh({})
    const line = "72' 손흥민, 골망을 흔듭니다!"
    expect(estimateSpeechMs(line)).toBe(estimateSpeechMs(line))
  })
})

describe('willSpeak — 실제로 소리가 나는 상태인가', () => {
  it('미지원 환경이면 false', async () => {
    const ctts = await loadFresh({})
    ctts.initVoice()
    expect(ctts.willSpeak()).toBe(false)
  })

  it('ko 보이스 확보 + 토글 ON이면 true, OFF면 false', async () => {
    const { synth } = makeFakeSynth(() => [{ lang: 'ko-KR', name: 'Yuna' }])
    const ctts = await loadFresh({ synth })
    ctts.initVoice()
    expect(ctts.willSpeak()).toBe(true)
    ctts.setTtsEnabled(false)
    expect(ctts.willSpeak()).toBe(false)
  })
})
