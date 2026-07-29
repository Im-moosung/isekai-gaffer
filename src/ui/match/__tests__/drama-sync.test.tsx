// @vitest-environment jsdom
// Phase B-1 핵심 계약 회귀 테스트 — **말한 것과 그린 것이 같다.**
//
// 예전엔 한 분의 대표 이벤트를 세 계층이 따로 골랐다(티커=전부, 음성=SPOKEN_PRIORITY,
// 안무=EVENT_DWELL_MS 최댓값). 그래서 한 분에 여러 이벤트가 나면 "음성은 세이브인데
// 화면은 코너 안무"가 가능했다. 이 테스트는 단위 함수가 아니라 **MatchScreen이 실제로
// 배선한 두 경로**를 가로채 검증한다:
//   - 음성 경로: commentary-tts.speak()에 넘어간 문장
//   - 안무 경로: choreography.buildSequence()에 넘어간 이벤트
// 두 경로가 같은 이벤트에서 나왔는지를 실엔진 90분 재생으로 분마다 대조한다.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { MatchEvent } from '../../../engine/types'

// ── 두 경로 가로채기(실제 구현은 그대로 쓰고 인자만 기록) ──
const builtByMinute = new Map<number, MatchEvent>()
const spokenByMinute = new Map<number, { line: string; important: boolean }>()

vi.mock('../../pitch/choreography', async importOriginal => {
  const actual = await importOriginal<typeof import('../../pitch/choreography')>()
  return {
    ...actual,
    buildSequence: (event: MatchEvent, h: never, a: never) => {
      builtByMinute.set(event.minute, event)
      return actual.buildSequence(event, h, a)
    },
  }
})

vi.mock('../../../audio/commentary-tts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../audio/commentary-tts')>()
  return {
    ...actual,
    speak: (line: string, opts: { important?: boolean } = {}) => {
      // 발화 시점의 표시 분 = 스토어 엔진의 분(MatchScreen이 그 분에 대해 부른다).
      const m = useMatchStore.getState().engine?.minute ?? -1
      spokenByMinute.set(m, { line, important: !!opts.important })
      actual.speak(line, opts)
    },
  }
})

import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore } from '../../../game/matchStore'
import { commentateAt } from '../../../game/commentary'
import { pickDramaEvent, isImportantEvent, eventIndex } from '../playback'

/** MatchScreen이 발화 시점에 만든 것과 **같은** 라인을 재구성한다.
 *  Phase C 이후 해설은 히스토리 의존이므로(streak·골 종류·변형 억제 링버퍼)
 *  그 분까지의 이벤트 prefix와 경기 시드를 그대로 넘겨야 같은 문장이 나온다. */
function speechAt(allEvents: MatchEvent[], minute: number, drawn: MatchEvent, seed: number): string {
  const upTo = allEvents.filter(e => e.minute <= minute)
  return commentateAt(upTo, eventIndex(upTo, drawn), home, away, seed).speech
}

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  return ls
}
let ls: ReturnType<typeof installLocalStorage>

beforeEach(() => {
  ls = installLocalStorage()
  builtByMinute.clear()
  spokenByMinute.clear()
  // 재생 루프의 setTimeout이 제멋대로 분을 넘기지 않도록 가짜 타이머를 쓰고,
  // 분 전진은 advanceMinute()로 직접 몬다(결정론).
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useMatchStore.getState().reset()
  ls.clear()
})

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** 킥오프 후 90분을 직접 전진시킨다(정지·하프타임은 전술 확정으로 즉시 재개). */
async function playFullMatch(): Promise<void> {
  const st = useMatchStore.getState()
  act(() => { st.kickoff() })
  await flush()
  for (let i = 0; i < 200; i++) {
    const s = useMatchStore.getState()
    if (s.phase === 'fulltime') break
    if (s.phase === 'playing') act(() => { s.advanceMinute() })
    else act(() => { s.confirmTactics() })
    await flush()
  }
}

describe('MatchScreen — 음성과 안무가 같은 이벤트를 쓴다(Phase B-1 계약)', () => {
  it('실엔진 90분: 발화한 분마다 안무도 같은 이벤트로 만들어졌다', async () => {
    render(<MatchScreen home={home} away={away} seed={1003} />)
    await flush()
    await playFullMatch()

    expect(useMatchStore.getState().phase).toBe('fulltime')
    const events = useMatchStore.getState().engine!.events
    expect(spokenByMinute.size).toBeGreaterThan(15) // 실제로 충분히 말했다
    expect(builtByMinute.size).toBeGreaterThanOrEqual(spokenByMinute.size)

    for (const [minute, spoken] of spokenByMinute) {
      const drawn = builtByMinute.get(minute)
      expect(drawn, `${minute}분: 말은 했는데 안무가 없다 — "${spoken.line}"`).toBeDefined()
      // 그린 이벤트의 해설 문장 === 실제로 말한 문장.
      expect(speechAt(events, minute, drawn!, 1003), `${minute}분 불일치`).toBe(spoken.line)
      expect(spoken.important).toBe(isImportantEvent(drawn!))
    }
  })

  it('한 분에 이벤트가 여러 개인 순간에도 어긋나지 않는다(그 분 전체 이벤트 대조)', async () => {
    render(<MatchScreen home={home} away={away} seed={1003} />)
    await flush()
    await playFullMatch()

    const events = useMatchStore.getState().engine!.events
    let multiEventMinutes = 0
    for (const [minute, drawn] of builtByMinute) {
      const atMinute = events.filter(e => e.minute === minute)
      if (atMinute.length > 1) multiEventMinutes++
      // 화면이 고른 이벤트는 그 분의 실제 이벤트 중 하나이며, 규칙이 정한 주인공이다.
      // (스토어가 분마다 상태를 복제하므로 참조가 아닌 값으로 대조한다.)
      expect(atMinute).toContainEqual(drawn)
      expect(drawn).toEqual(pickDramaEvent(atMinute))
    }
    // 이 계약이 의미를 가지려면 다중 이벤트 분이 실제로 존재해야 한다.
    expect(multiEventMinutes).toBeGreaterThan(5)
  })

  it('여러 시드에서도 동일 계약이 유지된다', async () => {
    for (const seed of [1000, 1005, 1009]) {
      builtByMinute.clear()
      spokenByMinute.clear()
      const { unmount } = render(<MatchScreen home={home} away={away} seed={seed} />)
      await flush()
      await playFullMatch()
      const all = useMatchStore.getState().engine!.events
      for (const [minute, spoken] of spokenByMinute) {
        const drawn = builtByMinute.get(minute)
        expect(drawn, `seed=${seed} ${minute}분`).toBeDefined()
        expect(speechAt(all, minute, drawn!, seed), `seed=${seed} ${minute}분`).toBe(spoken.line)
      }
      unmount()
      act(() => { useMatchStore.getState().reset() })
    }
  })
})
