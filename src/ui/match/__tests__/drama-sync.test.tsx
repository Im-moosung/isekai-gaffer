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
/** 그 분의 안무가 처음 만들어진 시각(= 분 시작). 발화 지연을 재는 기준점이다. */
const builtAt = new Map<number, number>()
/** 그 분의 캐스터 발화가 실제로 시작된 시각. */
const spokenAt = new Map<number, number>()
/**
 * 그 분의 안무가 **실제로 만들어졌을 때의** 결과 노출 진행도(0~1).
 *
 * ★ 2026-08-01: 예전에는 단언부에서 `minuteRevealMs(…, 최종 engine 상태)`로 되계산했다.
 *   장면이 공격 팀 전술에만 의존하던 때는 그 근사가 정확했지만, 오프사이드 상한이
 *   들어오면서 장면이 **수비 팀의 라인 높이**에도 의존하게 됐다(scenes.OffsideLimit).
 *   상대 AI는 경기 중 라인을 바꾸므로(실측: 4분 50 → 종료 38) 되계산한 노출 시각이
 *   실제로 그려진 장면과 어긋난다. 그래서 그 순간의 값을 그대로 기록한다 —
 *   근사가 아니라 실측이므로 계약이 오히려 엄밀해진다.
 */
const revealTAt = new Map<number, number>()

vi.mock('../../pitch/choreography', async importOriginal => {
  const actual = await importOriginal<typeof import('../../pitch/choreography')>()
  return {
    ...actual,
    buildSequence: (event: MatchEvent, h: never, a: never) => {
      const seq = actual.buildSequence(event, h, a)
      builtByMinute.set(event.minute, event)
      if (!builtAt.has(event.minute)) {
        builtAt.set(event.minute, Date.now())
        revealTAt.set(event.minute, sceneRevealT(seq))
      }
      return seq
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
      spokenAt.set(m, Date.now())
      actual.speak(line, opts)
    },
  }
})

import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore } from '../../../game/matchStore'
import { commentateAt } from '../../../game/commentary'
import {
  pickDramaEvent, isImportantEvent, eventIndex, minuteRevealMs, sceneDwellMs, sceneRevealT, REVEAL_LAG_MS,
} from '../playback'

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
  builtAt.clear()
  spokenAt.clear()
  revealTAt.clear()
  // 재생 체인·노출 게이트·발화 지연이 전부 setTimeout이므로 가짜 시계로 몬다.
  // ★ requestAnimationFrame은 **일부러 진짜로 남긴다**. 가짜로 만들면 16 ms짜리
  //   rAF 루프가 타이머 큐를 가득 채워, `advanceTimersToNextTimer` 한 번이 16 ms밖에
  //   못 나아간다(90분을 굴리려면 2만 번 넘게 돌아야 한다).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useMatchStore.getState().reset()
  ls.clear()
})

/**
 * 가짜 시계를 한 번에 밀어 주는 폭(ms). React 스케줄러가 지연 0짜리 태스크를 쉼 없이
 * 큐에 넣으므로 `advanceTimersToNextTimer`로는 시계가 거의 안 나아간다(실측: 90분에
 * 2만 번 이상). 대신 일정 폭씩 민다 — 발화 시각 측정의 양자화 오차가 이 값이다.
 */
const TICK_MS = 200

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/**
 * 킥오프 후 90분을 **실제 재생 체인으로** 굴린다(정지·하프타임은 전술 확정으로 즉시 재개).
 *
 * ★ 2026-08-01: 예전에는 `advanceMinute()`를 직접 불러 분을 넘겼다. 그때는 한 분 안에
 *   타이머가 하나(다음 분 예약)뿐이라 그래도 됐지만, 지금은 발화가 **결과 노출 뒤**로
 *   스케줄된다(reveal 타이머 → 발화 타이머 → 분 전환 타이머). 분을 손으로 넘기면 그
 *   두 타이머가 영원히 안 돈다. 그래서 가짜 시계를 **타이머 하나씩** 전진시켜
 *   실제 순서를 그대로 재현한다.
 */
async function playFullMatch(): Promise<void> {
  act(() => { useMatchStore.getState().kickoff() })
  await flush()
  for (let i = 0; i < 4000; i++) {
    const s = useMatchStore.getState()
    if (s.phase === 'fulltime') break
    if (s.phase === 'playing') {
      await act(async () => { vi.advanceTimersByTime(TICK_MS) })
    } else {
      act(() => { s.confirmTactics() })
    }
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

  // ── 타이밍 계약(2026-08-01 5라운드 피드백 ①) ────────────────────────
  // 위 계약이 "**무엇을** 말하는가"라면 이건 "**언제** 말하는가"다.
  // 사용자 지적: "'김승규가 슛을 막았습니다'가 나오고 그에 맞는 화면이 다음에 나와."
  it('캐스터는 결과가 화면에 보인 **뒤에** 말한다(예지력 금지)', async () => {
    render(<MatchScreen home={home} away={away} seed={1003} />)
    await flush()
    await playFullMatch()

    const events = useMatchStore.getState().engine!.events
    let checked = 0
    for (const [minute, at] of spokenAt) {
      const t0 = builtAt.get(minute)
      if (t0 === undefined) continue
      const atMinute = events.filter(e => e.minute === minute)
      const eng = useMatchStore.getState().engine!
      const diff = Math.abs(eng.score[0] - eng.score[1])
      const sceneMs = sceneDwellMs(atMinute, 1, minute >= 80 && diff <= 1, 0)
      // 하이라이트 분인가는 상태와 무관한 판정이라 되계산해도 안전하다(코너·파울은 0).
      if (minuteRevealMs(atMinute, eng.home, eng.away, sceneMs) <= 0) continue
      // 값은 **그 순간 그려진 장면**에서 잰다(revealTAt 주석 참조).
      const rt = revealTAt.get(minute)
      if (rt == null) continue
      const revealMs = Math.round(rt * sceneMs)
      const delay = at - t0
      // 결과가 보이기 **전에** 말하면 예지력이다. 이 한 줄이 이번 버그의 회귀 방지선이다.
      expect(delay, `${minute}분: 결과 노출 ${revealMs}ms보다 먼저 말했다(${delay}ms)`)
        .toBeGreaterThanOrEqual(revealMs)
      // 반대로 한없이 늦어도 안 된다 — 반응 지연 + 가짜 시계 양자화(TICK_MS) 안쪽.
      expect(delay, `${minute}분: 반응이 너무 늦다(${delay}ms)`)
        .toBeLessThanOrEqual(revealMs + REVEAL_LAG_MS + TICK_MS * 3)
      checked++
    }
    // 하이라이트(골·세이브·미스·슛)가 실제로 여러 번 있어야 계약에 의미가 있다.
    expect(checked).toBeGreaterThan(5)
  })

  it('sceneRevealT — 세이브는 GK 접촉, 나머지는 마지막 키프레임', () => {
    expect(sceneRevealT([])).toBe(0)
    expect(sceneRevealT([{ t: 0 }, { t: 0.4 }, { t: 0.76 }])).toBe(0.76)
    // 접촉 스텝이 있으면 그 뒤에 리바운드 여운이 붙어도 접촉이 결과다.
    expect(sceneRevealT([{ t: 0 }, { t: 0.62, contact: true }, { t: 0.78 }])).toBe(0.62)
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
