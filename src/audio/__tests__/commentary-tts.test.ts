// @vitest-environment jsdom
// 한국어 중계 음성 로직 테스트.
//
// ## 2026-08-02 계약 변경 — 무엇이 바뀌었나
// 이 파일은 예전에 **Fake speechSynthesis를 주입해** 큐 정책·rate·pitch·보이스 탐색을
// 검증했다. 그 경로가 통째로 사라졌다: 클립이 없는 문장은 브라우저 기본 TTS로 폴백하지
// 않고 **침묵한다**(근거는 commentary-tts.ts 헤더 — 남성 캐스터 사이에 macOS 기본
// 여성 음성이 한 문장만 끼어들면 결함으로 읽힌다. 자막은 그대로 나가므로 정보는 잃지 않는다).
//
// 그래서 테스트도 뒤집혔다:
//  · 사라진 것 — ko-KR 보이스 탐색(voiceschanged), utterance rate/pitch 검증,
//    `pending`을 이용한 곁들임 과밀 가드, "브라우저 음성과 mp3가 겹치지 않는가"(경로가
//    하나가 되어 겹칠 대상 자체가 없다).
//  · 남은 것 — 큐 정책(드롭/선점), 대본의 전부 아니면 전무, 토글·localStorage, 발화 길이 추정.
//  · **새로 생긴 것** — 이 파일의 첫 describe: speechSynthesis가 멀쩡히 존재해도
//    **한 번도 부르지 않는다**. 이게 이 작업의 핵심 계약이다.
//
// mp3 경로는 스텁으로 세운다(진짜 모듈은 AudioContext가 필요하고, 그쪽 배선은
// commentary-mp3.test.ts가 가짜 오디오 그래프로 따로 검증한다).
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

/**
 * **감시용** speechSynthesis. 진짜처럼 보이지만 호출되면 기록만 남긴다 —
 * 어떤 테스트에서도 `spoken`이 비어 있어야 한다(폴백은 없다).
 */
function makeSynthSpy() {
  const calls = { speak: 0, cancel: 0, pause: 0, resume: 0, spoken: [] as string[] }
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => [{ lang: 'ko-KR', name: 'Yuna' }],
    speak(u: { text: string }) { calls.speak++; calls.spoken.push(u.text) },
    cancel() { calls.cancel++ },
    pause() { calls.pause++ },
    resume() { calls.resume++ },
    addEventListener() {},
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

/** mp3 경로 스텁. `clips`에 든 문장만 소리가 난다. */
interface Mp3Stub {
  speaking: boolean
  ready: boolean
  clips: Set<string>
  played: Array<{ line: string; queued: boolean }>
  stopped: number
  warmed: number
  prefetched: string[]
}

function makeMp3Stub(clips: string[]): Mp3Stub {
  return {
    speaking: false, ready: true, clips: new Set(clips),
    played: [], stopped: 0, warmed: 0, prefetched: [],
  }
}

/**
 * 각 테스트마다 신선한 모듈로 격리한다(모듈 상태: ttsOn·scriptMp3·initStarted).
 * speechSynthesis는 **언제나** 감시용으로 심는다 — "부르지 않는다"를 보려면 있어야 한다.
 */
async function loadFresh(opts: { clips?: string[]; ready?: boolean } = {}) {
  const stub = makeMp3Stub(opts.clips ?? [])
  if (opts.ready === false) stub.ready = false
  vi.resetModules()
  vi.doMock('../commentary-mp3', () => ({
    loadClipIndex: () => {},
    hasClips: (s: string) => stub.clips.has(s),
    canSpeakAll: (ss: readonly string[]) => ss.length > 0 && ss.every(s => stub.clips.has(s)),
    playLine: (s: string, o: { queued?: boolean } = {}) => {
      if (!stub.clips.has(s)) return false
      stub.played.push({ line: s, queued: !!o.queued })
      stub.speaking = true
      return true
    },
    clipsSpeaking: () => stub.speaking,
    stopAllClips: () => { stub.stopped++; stub.speaking = false },
    clipsReady: () => stub.ready,
    prefetch: (ss: readonly string[]) => { stub.prefetched.push(...ss) },
    warmLive: () => { stub.warmed++ },
  }))
  vi.stubGlobal('localStorage', makeLocalStorage())
  const { synth, calls } = makeSynthSpy()
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  const ctts = await import('../commentary-tts')
  return { ctts, stub, synth, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../commentary-mp3')
})

// ── 이 작업의 핵심 계약 ───────────────────────────────────────
describe('클립이 없으면 침묵한다 — speechSynthesis를 부르지 않는다', () => {
  it('클립 없는 캐스터 라인: 아무 소리도 나지 않고 브라우저 TTS도 호출되지 않는다', async () => {
    const { ctts, stub, calls } = await loadFresh({ clips: [] })
    ctts.initVoice()
    ctts.speak('조회표에 없는 문장입니다.')
    ctts.speak('중요한데 클립이 없습니다!', { important: true, intensity: 3 })
    expect(stub.played).toEqual([])
    expect(calls.speak).toBe(0)
    expect(calls.spoken).toEqual([])
  })

  it('클립 없는 해설 아사이드도 침묵한다', async () => {
    const { ctts, stub, calls } = await loadFresh({ clips: [] })
    ctts.speakAside('네, 위험한 위치는 아닙니다.')
    expect(stub.played).toEqual([])
    expect(calls.speak).toBe(0)
  })

  it('덮이지 않는 대본은 통째로 침묵한다(전부 아니면 전무)', async () => {
    const { ctts, stub, calls } = await loadFresh({ clips: ['김민재,'] })
    expect(ctts.beginScript(['김민재,', '손흥민,'])).toBe(false)
    ctts.speakScripted('김민재,') // 덮이는 줄이어도 대본이 무음이면 내지 않는다
    expect(stub.played).toEqual([])
    expect(calls.speak).toBe(0)
  })

  it('클립이 **있는** 문장 옆에 섞여도 없는 문장만 조용하다(문장 단위 계약)', async () => {
    const { ctts, stub, calls } = await loadFresh({ clips: ['클립 있는 문장'] })
    ctts.speak('클립 있는 문장')
    stub.speaking = false // 앞 발화가 끝났다고 치고
    ctts.speak('클립 없는 문장')
    expect(stub.played.map(p => p.line)).toEqual(['클립 있는 문장'])
    expect(calls.speak).toBe(0)
  })

  it('일시정지·재개는 speechSynthesis를 건드리지 않는다(이제 no-op이다)', async () => {
    const { ctts, calls } = await loadFresh({ clips: ['어떤 문장'] })
    ctts.speak('어떤 문장')
    expect(() => ctts.pauseSpeech()).not.toThrow()
    expect(() => ctts.resumeSpeech()).not.toThrow()
    expect(calls.pause).toBe(0)
    expect(calls.resume).toBe(0)
  })

  it('stopAll·토글 OFF도 speechSynthesis.cancel을 부르지 않는다', async () => {
    const { ctts, stub, calls } = await loadFresh({ clips: ['어떤 문장'] })
    ctts.speak('어떤 문장')
    ctts.stopAll()
    expect(stub.stopped).toBe(1)
    ctts.setTtsEnabled(false)
    expect(stub.stopped).toBe(2) // OFF는 진행 발화를 끊는다
    expect(calls.cancel).toBe(0)
  })
})

describe('미지원 환경 — 크래시 금지', () => {
  it('조회표 없음(clipsReady=false) → 모든 함수가 throw 없이 no-op', async () => {
    const { ctts } = await loadFresh({ clips: [], ready: false })
    expect(() => ctts.initVoice()).not.toThrow()
    expect(() => ctts.speak('테스트 라인')).not.toThrow()
    expect(() => ctts.speak('중요 라인', { important: true })).not.toThrow()
    expect(() => ctts.speakAside('해설 라인')).not.toThrow()
    expect(() => ctts.speakScripted('대본 라인')).not.toThrow()
    expect(() => ctts.stopAll()).not.toThrow()
    expect(() => ctts.pauseSpeech()).not.toThrow()
    expect(() => ctts.resumeSpeech()).not.toThrow()
  })

  it('빈 문자열은 어느 채널에서도 소리를 내지 않는다', async () => {
    const { ctts, stub } = await loadFresh({ clips: [''] })
    ctts.speak('')
    ctts.speakAside('')
    expect(stub.played).toEqual([])
  })
})

describe('큐 정책 — 드롭과 선점', () => {
  it('발화 중이 아니면 일반 라인은 그대로 나간다', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['일반 라인'] })
    ctts.speak('일반 라인')
    expect(stub.played).toEqual([{ line: '일반 라인', queued: false }])
  })

  it('발화 중이면 일반 라인은 스킵(드롭) — 선점하지 않는다', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['진행 중 라인', '둘째 일반 라인'] })
    ctts.speak('진행 중 라인')
    ctts.speak('둘째 일반 라인')
    expect(stub.played.map(p => p.line)).toEqual(['진행 중 라인'])
    expect(stub.stopped).toBe(0)
  })

  it('발화 중이라도 important는 현재 발화를 끊고 즉시 발화(선점)', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['진행 중 라인', '골!!'] })
    ctts.speak('진행 중 라인')
    ctts.speak('골!!', { important: true })
    expect(stub.stopped).toBe(1)
    expect(stub.played.map(p => p.line)).toEqual(['진행 중 라인', '골!!'])
  })

  it('speakAside는 선점하지 않고 큐 꼬리에 붙인다(§5.6 체이닝)', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['캐스터 문장', '해설이 받는 문장'] })
    ctts.speak('캐스터 문장')
    ctts.speakAside('해설이 받는 문장')
    expect(stub.stopped).toBe(0) // 캐스터를 자르지 않는다
    expect(stub.played).toEqual([
      { line: '캐스터 문장', queued: false },
      { line: '해설이 받는 문장', queued: true }, // 드롭도 하지 않는다 — 뒤에 붙는다
    ])
  })

  it('stopAll은 진행 중 클립을 전부 끊는다', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['중계 중'] })
    ctts.speak('중계 중')
    ctts.stopAll()
    expect(stub.stopped).toBe(1)
  })
})

describe('대본(입장 소개) — 전부 아니면 전무', () => {
  it('전부 덮이면 mp3로 내고 클립을 미리 받아 둔다', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['김민재,', '골키퍼, 김승규입니다.'] })
    expect(ctts.beginScript(['김민재,', '골키퍼, 김승규입니다.'])).toBe(true)
    expect(stub.prefetched).toEqual(['김민재,', '골키퍼, 김승규입니다.'])
    ctts.speakScripted('김민재,')
    expect(stub.played).toEqual([{ line: '김민재,', queued: true }]) // 순서 보존
  })

  it('endScript 뒤에는 대본 발화가 나가지 않는다', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['김민재,'] })
    ctts.beginScript(['김민재,'])
    ctts.endScript()
    ctts.speakScripted('김민재,')
    expect(stub.played).toEqual([])
  })

  it('beginScript는 대본이 덮이지 않아도 경기 중 조각 받기를 깨운다', async () => {
    const { ctts, stub } = await loadFresh({ clips: [] })
    expect(ctts.beginScript(['덮이지 않는 한 줄'])).toBe(false)
    expect(stub.warmed).toBe(1)
  })
})

describe('토글 + localStorage 기억', () => {
  it('기본값은 ON', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.isTtsEnabled()).toBe(true)
  })

  it('setTtsEnabled(false)면 isTtsEnabled false + localStorage "0" 기록', async () => {
    const { ctts } = await loadFresh()
    ctts.setTtsEnabled(false)
    expect(ctts.isTtsEnabled()).toBe(false)
    expect(localStorage.getItem(TTS_KEY)).toBe('0')
  })

  it('setTtsEnabled(true)면 localStorage 키 제거(기본 ON 복귀)', async () => {
    const { ctts } = await loadFresh()
    ctts.setTtsEnabled(false)
    ctts.setTtsEnabled(true)
    expect(ctts.isTtsEnabled()).toBe(true)
    expect(localStorage.getItem(TTS_KEY)).toBeNull()
  })

  it('toggleTts는 상태를 뒤집고 새 상태를 반환', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.toggleTts()).toBe(false)
    expect(ctts.isTtsEnabled()).toBe(false)
    expect(ctts.toggleTts()).toBe(true)
    expect(ctts.isTtsEnabled()).toBe(true)
  })

  it('readStoredTts: 부재 시 true(ON), 저장값 "0"이면 false', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.readStoredTts()).toBe(true) // 부재 = 기본 ON
    localStorage.setItem(TTS_KEY, '0')
    expect(ctts.readStoredTts()).toBe(false) // '0' = OFF
  })

  it('토글 OFF면 클립이 있어도 모든 채널이 no-op', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['발화 안 됨', '해설도 안 됨'] })
    ctts.setTtsEnabled(false)
    ctts.speak('발화 안 됨', { important: true })
    ctts.speakAside('해설도 안 됨')
    expect(stub.played).toEqual([])
  })

  it('발화 중 토글 OFF면 진행 발화를 stopAll로 중단', async () => {
    const { ctts, stub } = await loadFresh({ clips: ['중계 중'] })
    ctts.speak('중계 중')
    ctts.setTtsEnabled(false)
    expect(stub.stopped).toBe(1)
  })
})

// ★ 대표 이벤트 선정(구 pickSpokenEvent)은 playback.pickDramaEvent로 이관했다 —
//   음성과 안무가 하나의 선택자를 공유해야 하므로 오디오 모듈이 가질 규칙이 아니다.
//   우선순위 테스트는 src/ui/match/__tests__/playback.test.ts에 있다.

describe('countSyllables — 한국어 발화 음절 수', () => {
  it('한글 음절만 센다(공백·구두점 0)', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.countSyllables('골망을 흔듭니다!')).toBe(7)
    expect(ctts.countSyllables('   ,.!\'')).toBe(0)
    expect(ctts.countSyllables('')).toBe(0)
  })

  it('숫자는 한국어 수사 길이(자리당 1.5음절)로 근사한다', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.countSyllables('7')).toBe(1.5) // "칠"
    expect(ctts.countSyllables('72')).toBe(3) // "칠십이"
  })

  it('한글·숫자 혼합 실문장', async () => {
    const { ctts } = await loadFresh()
    // "72' 손흥민, 골망을 흔듭니다!" → 숫자 2자리(3) + 한글 10
    expect(ctts.countSyllables("72' 손흥민, 골망을 흔듭니다!")).toBe(13)
  })
})

describe('estimateSpeechMs — 발화 소요 시간 추정', () => {
  it('빈 문장은 0(발화 없음 → 체류 보정 없음)', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.estimateSpeechMs('')).toBe(0)
    expect(ctts.estimateSpeechMs('  ')).toBe(0)
  })

  it('음절 수에 비례해 길어진다', async () => {
    const { ctts } = await loadFresh()
    const short = ctts.estimateSpeechMs('골입니다')
    const long = ctts.estimateSpeechMs('골입니다 골입니다 골입니다 골입니다')
    expect(long).toBeGreaterThan(short)
  })

  // ★ §5.7 이후: important는 rate를 **낮춘다**(높고 길게). 그래서 더 오래 걸린다 —
  //   체류 시간(dwell)이 그만큼 늘어야 골 순간의 선수 이름이 잘리지 않는다.
  it('important(rate 하향)는 같은 문장을 더 길게 읽는다', async () => {
    const { ctts } = await loadFresh()
    const line = "72' 손흥민, 골망을 흔듭니다!"
    expect(ctts.estimateSpeechMs(line, true)).toBeGreaterThan(ctts.estimateSpeechMs(line, false))
    expect(ctts.estimateSpeechMs(line, 'peak')).toBeGreaterThan(ctts.estimateSpeechMs(line, 'important'))
  })

  it('estimatePairMs: 해설이 붙으면 총 발화가 길어지되 체이닝 할인만큼 줄어든다', async () => {
    const { ctts } = await loadFresh()
    const caster = '골! 손흥민!'
    const analyst = '네, 선제골의 무게가 큽니다.'
    const only = ctts.estimatePairMs(caster, 'peak', undefined)
    const pair = ctts.estimatePairMs(caster, 'peak', analyst)
    expect(only).toBe(ctts.estimateSpeechMs(caster, 'peak'))
    expect(pair).toBe(only + ctts.estimateSpeechMs(analyst, 'analyst') - ctts.PAIR_CHAIN_DISCOUNT_MS)
    expect(pair).toBeGreaterThan(only)
  })

  it('실문장 추정치가 상식 범위(1~4초)에 있다 — 실측 계수 회귀 고정', async () => {
    const { ctts } = await loadFresh()
    expect(ctts.SYLLABLES_PER_SEC).toBe(5.6)
    expect(ctts.SPEECH_TAIL_MS).toBe(650)
    for (const line of [
      "72' 손흥민, 골망을 흔듭니다!",
      "45' 대한민국 골키퍼가 슛을 걷어냅니다.",
      "13' 이강인의 슛, 골문을 빗나갑니다.",
      "88' 스페인의 코너킥 기회입니다.",
    ]) {
      const ms = ctts.estimateSpeechMs(line)
      expect(ms).toBeGreaterThan(1000)
      expect(ms).toBeLessThan(4000)
    }
  })

  it('결정론 — 같은 입력에 항상 같은 값', async () => {
    const { ctts } = await loadFresh()
    const line = "72' 손흥민, 골망을 흔듭니다!"
    expect(ctts.estimateSpeechMs(line)).toBe(ctts.estimateSpeechMs(line))
  })
})

// ★ 이 판정이 화면 타이밍을 정한다(MatchScreen → playback.minuteDwellWithSpeech).
//   폴백이 있던 시절엔 `available || clipsReady`였다. 그 `available`(ko-KR 보이스 존재)을
//   남겨 두면 클립이 하나도 없는 환경에서 "소리가 난다"고 답해, **무음인데 화면만 느려진다**.
describe('willSpeak — 실제로 소리가 나는 상태인가', () => {
  it('조회표가 없으면 false — ko-KR 보이스가 있어도 마찬가지다', async () => {
    const { ctts, synth } = await loadFresh({ clips: [], ready: false })
    ctts.initVoice()
    expect(synth.getVoices()).toHaveLength(1) // 보이스는 멀쩡히 있다
    expect(ctts.willSpeak()).toBe(false) // 그래도 소리는 안 난다
  })

  it('조회표 준비 + 토글 ON이면 true, OFF면 false', async () => {
    const { ctts } = await loadFresh({ clips: ['아무 문장'] })
    ctts.initVoice()
    expect(ctts.willSpeak()).toBe(true)
    ctts.setTtsEnabled(false)
    expect(ctts.willSpeak()).toBe(false)
  })
})
