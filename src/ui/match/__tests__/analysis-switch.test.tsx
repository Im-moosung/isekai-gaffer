// @vitest-environment jsdom
// 3D 하이라이트 ↔ 2D 작전판 전환 계약.
//  - 하이라이트 분에는 작전판이 물러나고 라이브가 보인다.
//  - 그 외 모든 분(코너·파울·무사건)에는 작전판이 보인다 → **리사주를 볼 창이 없다.**
//  - 작전판의 수비 라인은 유저가 만진 lineHeight를 따라 실제로 움직인다.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { MatchScreen } from '../MatchScreen'
import { PitchView } from '../../pitch/PitchView'
import { lineDepth, pressReach } from '../../pitch/AnalysisLayer'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import { useMatchStore } from '../../../game/matchStore'
import { isHighlightEvent, pickDramaEvent } from '../playback'

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

beforeEach(() => { ls = installLocalStorage() })
afterEach(() => { cleanup(); useMatchStore.getState().reset(); ls.clear() })

describe('전환 — 하이라이트에서만 라이브, 그 외엔 작전판', () => {
  it('90분 내내 규칙이 지켜진다(작전판 노출 = 비하이라이트 분)', async () => {
    const { container } = render(<MatchScreen home={home} away={away} seed={1003} />)
    act(() => { useMatchStore.getState().kickoff() })

    let analysisMinutes = 0
    let liveMinutes = 0
    for (let i = 0; i < 200; i++) {
      const s = useMatchStore.getState()
      if (s.phase === 'fulltime') break
      if (s.phase !== 'playing') { act(() => { s.confirmTactics() }) ; continue }
      act(() => { s.advanceMinute() })
      const eng = useMatchStore.getState().engine
      if (!eng || useMatchStore.getState().phase !== 'playing') continue
      const m = eng.minute
      const d = pickDramaEvent(eng.events.filter(e => e.minute === m))
      const shouldBeLive = !!d && isHighlightEvent(d)
      const boardOn = !!container.querySelector('.ab-root--on')
      expect(boardOn, `${m}분 — 라이브여야 하나? ${shouldBeLive}`).toBe(!shouldBeLive)
      if (boardOn) analysisMinutes++
      else liveMinutes++
    }
    // 두 모드가 실제로 번갈아 나왔는지(공허한 통과 방지).
    expect(liveMinutes).toBeGreaterThan(8)
    expect(analysisMinutes).toBeGreaterThan(30)
  })

  it('작전판은 라이브 중에도 마운트를 유지한다(3D 언마운트 = WebGL 재생성 히치)', () => {
    const { container } = render(<MatchScreen home={home} away={away} seed={1003} />)
    act(() => { useMatchStore.getState().kickoff() })
    act(() => { useMatchStore.getState().advanceMinute() })
    expect(container.querySelector('.ab-root')).toBeTruthy()
  })
})

describe('★ 2D 작전판의 전술 시각화가 유저 입력을 따른다', () => {
  function boardWithLine(lineHeight: number, pressing: number) {
    const st = createMatch(home, away, { seed: 42 })
    st.home.tactics.instructions = { ...st.home.tactics.instructions, lineHeight, pressing }
    const { container } = render(<PitchView state={st} variant="tactics" analysis />)
    const line = container.querySelector('.an-team--home .an-line') as SVGLineElement
    const zone = container.querySelector('.an-team--home .an-press') as SVGRectElement
    return { x: Number(line.getAttribute('x1')), w: Number(zone.getAttribute('width')) }
  }

  it('라인을 내리면 수비 라인이 자기 골문 쪽으로 실제로 내려간다', () => {
    const high = boardWithLine(90, 50)
    const low = boardWithLine(20, 50)
    expect(low.x).toBeLessThan(high.x)
    // 슬라이더 전 구간이 화면에서 유의미한 거리로 나타난다(105m 피치에서 20m 이상).
    expect(high.x - low.x).toBeGreaterThan(20)
  })

  it('압박을 올리면 압박 존이 넓어진다', () => {
    expect(boardWithLine(50, 90).w).toBeGreaterThan(boardWithLine(50, 10).w)
  })

  it('lineDepth·pressReach는 단조 증가하며 피치 안에 머문다', () => {
    expect(lineDepth(0)).toBeLessThan(lineDepth(100))
    expect(lineDepth(100)).toBeLessThan(50) // 하프라인을 넘지 않는다
    expect(pressReach(0)).toBeLessThan(pressReach(100))
  })

  it('공격 패턴을 바꾸면 패스 레인 화살표가 바뀐다', () => {
    const draw = (p: 'balanced' | 'cross' | 'through' | 'longshot') => {
      const st = createMatch(home, away, { seed: 42 })
      st.home.tactics.attackPattern = p
      const { container } = render(<PitchView state={st} variant="tactics" analysis />)
      return [...container.querySelectorAll('.an-lane')].map(n => n.getAttribute('d')).join('|')
    }
    const all = new Set(['balanced', 'cross', 'through', 'longshot'].map(p => draw(p as 'balanced')))
    expect(all.size).toBe(4)
  })

  it('전술 레이어는 broadcast 기본값에서는 그리지 않는다', () => {
    const st = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={st} />)
    expect(container.querySelector('.an-root')).toBeNull()
  })
})
