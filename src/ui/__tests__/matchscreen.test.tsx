// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { MatchScreen } from '../match/MatchScreen'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// 재생 루프는 분당 가변 setTimeout 체인(playback.minuteDwellMs)으로 1분씩 전진한다.
// 각 스텝은 "다음 타이머로 진행"(advanceTimersToNextTimer)으로 dwell 길이와 무관하게
// 정확히 1분씩 넘긴다. act로 감싸 콜백·리렌더를 안정적으로 진행시킨다.
function step(times: number) {
  for (let i = 0; i < times; i++) {
    act(() => { vi.advanceTimersToNextTimer() })
  }
}

// 목표 phase까지 재생 — 도중 자동 정지(브레이크·하프타임)는 confirmTactics로 재개.
function replayTo(target: string) {
  for (let i = 0; i < 400 && store().phase !== target; i++) {
    if (store().phase === 'playing') act(() => { vi.advanceTimersToNextTimer() })
    else act(() => { store().confirmTactics() })
  }
}

beforeEach(() => { vi.useFakeTimers(); store().reset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const clock = (c: HTMLElement) =>
  parseInt(c.querySelector('.bc-scorebug__clock')!.textContent!.replace(/\D/g, ''), 10)
const svg = (c: HTMLElement) => c.querySelector('svg.pv-root')

describe('MatchScreen 조립 — 오버레이 폐지(피치 상시 노출)', () => {
  it('(a) 렌더 → 하단 바에 킥오프 버튼 + 피치 SVG 존재', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    // pre 단계에서도 피치는 보인다(가리는 오버레이 없음).
    expect(svg(container as HTMLElement)).toBeTruthy()
  })

  it('(b) 킥오프 → 재생 진행 → Scorebug 분 표기 증가', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(clock(container as HTMLElement)).toBe(0)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(10)
    expect(clock(container as HTMLElement)).toBeGreaterThan(0)
  })

  it('(c) 크래시 없이 halftime 도달 → 작전판(tactics) 모드: 팀토크 카드 + [후반 시작] + 사유', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    replayTo('halftime')
    expect(store().phase).toBe('halftime')
    // 하프타임 = 작전판 진입(다크 보드).
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.pv-root--tactics')).toBeTruthy()
    // 하프타임 팀토크 카드가 작전판 상단에 존재.
    expect(container.querySelector('.tt-root')).toBeTruthy()
    // 하단 재개 버튼은 [후반 시작] 라벨.
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
    // 정지 사유 표시.
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('전반 종료')
  })

  it('(e) LIVE 뱃지는 재생 중에만 노출 — 킥오프 전 없음, 재생 중 존재', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    const live = () => container.querySelector('.bc-scorebug__live')
    expect(live()).toBeNull()
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(3)
    expect(live()).not.toBeNull()
    expect(live()!.textContent).toContain('LIVE')
  })

  it('(d) 재생 전 스코어 스포일러 방지 — 킥오프 직후 minute=0이면 0:0', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={6} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    const nums = container.querySelectorAll('.bc-scorebug__num')
    expect(nums[0].textContent).toBe('0')
    expect(nums[1].textContent).toBe('0')
  })
})

describe('MatchScreen 개입 허브 — 브레이크·순간 제안·풀타임', () => {
  it('(h) paused-break → 작전판: 다크 보드 pitch + [전술 확정] + 사유(하이드레이션)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    replayTo('paused-break')
    expect(store().phase).toBe('paused-break')
    // 작전판 다크 보드.
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.pv-root--tactics')).toBeTruthy()
    // 하단 [전술 확정] 대형 버튼.
    expect(getByRole('button', { name: '전술 확정' })).toBeTruthy()
    // 정지 사유 문구.
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('하이드레이션 브레이크')
  })

  it('(i) momentPrompt 배너: [사용]→paused-moment, [흘려보낸다]→playing 유지', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(2)
    expect(store().phase).toBe('playing')
    // 재생 중 순간 제안을 세팅(레이아웃 스모크: 배너 액션 배선 확인).
    act(() => { useMatchStore.setState({ momentPrompt: { kind: 'conceded', minute: 12, title: 't' } }) })
    const banner = container.querySelector('.ms-banner')!
    expect(banner.textContent).toContain('실점 직후')
    // 피치는 순간 제안 중에도 보인다.
    expect(svg(container as HTMLElement)).toBeTruthy()

    // [흘려보낸다] → 재생 유지, 제안만 사라짐.
    fireEvent.click(getByRole('button', { name: '흘려보낸다' }))
    expect(store().phase).toBe('playing')
    expect(store().momentPrompt).toBeNull()

    // 다시 제안 세팅 후 [사용] → paused-moment로 정지.
    act(() => { useMatchStore.setState({ momentPrompt: { kind: 'conceded', minute: 13, title: 't' } }) })
    fireEvent.click(getByRole('button', { name: '사용' }))
    expect(store().phase).toBe('paused-moment')
  })

  it('(j) fulltime: 피치 유지 + 하단 바 스탯(점유율) + 액션 버튼', () => {
    const onMatchEnd = vi.fn()
    const { container } = render(<MatchScreen home={home} away={away} seed={20260724} onMatchEnd={onMatchEnd} />)
    act(() => { store().kickoff() })
    replayTo('fulltime')
    expect(store().phase).toBe('fulltime')
    // 피치는 종료 화면에서도 가려지지 않는다.
    expect(svg(container as HTMLElement)).toBeTruthy()
    // 하단 바 확장 + 스탯 표.
    expect(container.querySelector('.ms-bottom--full')).toBeTruthy()
    expect(container.querySelector('.ms-stats')!.textContent).toContain('점유율')
  })
})

describe('MatchScreen 재생 루프 — 정지·재개·속도', () => {
  it('(f) 재생 중 pause → 체인 정지(시간 흘려도 분 불변) → confirmTactics 재개', () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(4)
    expect(store().phase).toBe('playing')
    const before = store().engine!.minute
    expect(before).toBeGreaterThan(0)

    // [⏸ 감독 타임] → 체인 정지. 이후 시간을 크게 흘려도 분이 전진하지 않아야 한다.
    fireEvent.click(getByRole('button', { name: '⏸ 감독 타임' }))
    expect(store().phase).toBe('paused-user')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(store().engine!.minute).toBe(before)

    // 전술 확정 → 재개. 시간이 흐르면 분이 다시 늘어난다(전환 연출 타이머와 무관하게).
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    expect(store().phase).toBe('playing')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(store().engine!.minute).toBeGreaterThan(before)
  })

  it('(g) 속도 토글 — 선택 상태 반영 + 2x가 같은 시간에 더 많이 전진', () => {
    function minutesInBudget(setTo2x: boolean, budgetMs: number): number {
      store().reset()
      const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
      fireEvent.click(getByRole('button', { name: '킥오프' }))
      if (setTo2x) {
        const btn = getByRole('button', { name: '2x' })
        fireEvent.click(btn)
        expect(btn.getAttribute('aria-pressed')).toBe('true')
      }
      act(() => { vi.advanceTimersByTime(budgetMs) })
      const m = store().engine!.minute
      cleanup()
      return m
    }
    const budget = 9000
    const at1x = minutesInBudget(false, budget)
    const at2x = minutesInBudget(true, budget)
    expect(at1x).toBeGreaterThan(0)
    expect(at2x).toBeGreaterThan(at1x)
  })
})

describe('MatchScreen 모드 분리 — 방송 관전 ↔ 작전 지시', () => {
  it('(k) broadcast(pre·재생)엔 콘솔·작전판이 DOM에 없다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    // pre = 방송 모드.
    expect(container.querySelector('.tb-root')).toBeNull()
    expect(container.querySelector('.cs-panel')).toBeNull()
    // 재생 중에도 작전판·콘솔 부재.
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(3)
    expect(store().phase).toBe('playing')
    expect(container.querySelector('.tb-root')).toBeNull()
    expect(container.querySelector('.cs-panel')).toBeNull()
  })

  it('(l) pause → 작전판(콘솔 포함) 렌더 / confirm → 방송 복귀(작전판 언마운트)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    replayTo('paused-break')
    // 작전판 진입 — 보드 + 콘솔이 작전판 안으로 이관됨.
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.cs-panel')).toBeTruthy()

    // 전술 확정 → 방송 복귀. 역연출 시간 경과 후 작전판 언마운트.
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    expect(store().phase).toBe('playing')
    act(() => { vi.advanceTimersByTime(700) })
    expect(container.querySelector('.tb-root')).toBeNull()
  })
})
