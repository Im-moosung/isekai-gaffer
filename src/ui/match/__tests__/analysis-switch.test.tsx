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

  // ★ 선만 움직이고 팀은 안 움직이던 버그의 회귀 방지. 마커 x와 실제 최후방 4명의
  //   도트 x가 같은 함수(shape.lineDepth)에서 나오는지 DOM에서 직접 잰다.
  function boardGeom(lineHeight: number, pressing: number) {
    const st = createMatch(home, away, { seed: 42 })
    st.home.tactics.instructions = { ...st.home.tactics.instructions, lineHeight, pressing }
    const { container } = render(<PitchView state={st} variant="tactics" analysis />)
    const line = container.querySelector('.an-team--home .an-line') as SVGLineElement
    const zone = container.querySelector('.an-team--home .an-press') as SVGRectElement
    const dots = [...container.querySelectorAll('.pv-dot--home')]
      .map(n => Number(n.getAttribute('cx')))
      .sort((a, b) => a - b)
    // dots[0]은 GK — 최후방 필드플레이어는 그 다음 4명.
    const rear4 = dots.slice(1, 5)
    const ys = [...container.querySelectorAll('.pv-dot--home')].map(n => Number(n.getAttribute('cy')))
    return {
      lineX: Number(line.getAttribute('x1')),
      zoneW: Number(zone.getAttribute('width')),
      rear4Mean: rear4.reduce((s, v) => s + v, 0) / 4,
      dots,
      width: Math.max(...ys) - Math.min(...ys),
    }
  }

  it('★ 수비 라인 마커가 실제 수비진 도트 위를 지난다(라인 10~90 전 구간)', () => {
    for (let L = 10; L <= 90; L += 10) {
      const g = boardGeom(L, 50)
      // viewBox 105 폭 기준 0.5(=약 0.5m) 이내 — 4백은 수식상 정확히 일치한다.
      expect(Math.abs(g.lineX - g.rear4Mean), `라인 ${L}`).toBeLessThan(0.5)
    }
  })

  it('★ 라인을 움직이면 선수 도트가 실제로 따라 움직인다', () => {
    const lo = boardGeom(10, 50)
    const hi = boardGeom(90, 50)
    // 수비진이 화면에서 크게(피치 105 중 15 이상 = 15m) 전진한다.
    expect(hi.rear4Mean - lo.rear4Mean).toBeGreaterThan(15)
    // 11명 전원이 전진하되 통짜 평행이동은 아니다(수비진 이동폭 > 최전방 이동폭).
    for (let k = 0; k < 11; k++) expect(hi.dots[k]).toBeGreaterThan(lo.dots[k])
    expect(hi.dots[1] - lo.dots[1]).toBeGreaterThan((hi.dots[10] - lo.dots[10]) * 2)
  })

  it('★ 압박을 올리면 도트 블록이 좁아진다(존만 넓어지는 게 아니다)', () => {
    const lo = boardGeom(50, 10)
    const hi = boardGeom(50, 90)
    expect(hi.width).toBeLessThan(lo.width - 2)
    // 백라인은 라인 슬라이더 전용 — 압박이 마커-도트 일치를 깨지 않는다.
    expect(Math.abs(hi.lineX - hi.rear4Mean)).toBeLessThan(0.5)
    expect(hi.zoneW).toBeGreaterThan(lo.zoneW)
  })

  it('전술 레이어는 broadcast 기본값에서는 그리지 않는다', () => {
    const st = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={st} />)
    expect(container.querySelector('.an-root')).toBeNull()
  })
})
