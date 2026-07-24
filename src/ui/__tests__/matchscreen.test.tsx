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

// 하프타임까지 재생 — 도중 하이드레이션 브레이크(paused-break)에서 confirmTactics로 재개.
function replayToHalftime() {
  for (let i = 0; i < 300 && store().phase !== 'halftime'; i++) {
    if (store().phase === 'playing') act(() => { vi.advanceTimersToNextTimer() })
    else act(() => { store().confirmTactics() })
  }
}

beforeEach(() => { vi.useFakeTimers(); store().reset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const clock = (c: HTMLElement) =>
  parseInt(c.querySelector('.bc-scorebug__clock')!.textContent!.replace(/\D/g, ''), 10)

describe('MatchScreen 조립', () => {
  it('(a) 렌더 → 킥오프 버튼 존재', () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
  })

  it('(b) 킥오프 클릭 → 재생 진행 → Scorebug 분 표기 증가', () => {
    const view = render(<MatchScreen home={home} away={away} seed={20260724} />)
    const { getByRole, container } = view
    expect(clock(container as HTMLElement)).toBe(0)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    // 가변 dwell 체인이 1분씩 전진 → engine.minute(표시 분) 증가 (첫 브레이크 전까지)
    step(10)
    expect(clock(container as HTMLElement)).toBeGreaterThan(0)
  })

  it('(c) 크래시 없이 halftime 도달 → "후반 시작" 버튼 등장', () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    replayToHalftime() // 하이드레이션 브레이크 재개 포함
    expect(store().phase).toBe('halftime')
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
  })

  it('(e) LIVE 뱃지는 재생 중에만 노출 — 킥오프 전 없음, 재생 진행 중 존재', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    const live = () => container.querySelector('.bc-scorebug__live')
    // 킥오프 전(pre): 재생 아님 → LIVE 없음
    expect(live()).toBeNull()
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(3) // playing, minute < 45 → 재생 중
    expect(live()).not.toBeNull()
    expect(live()!.textContent).toContain('LIVE')
  })

  it('(d) 재생 전 스코어 스포일러 방지 — 킥오프 직후 minute=0이면 0:0', () => {
    // seed=6: 데모 픽스처(kor 76 vs esp 88)에서 전반 초반 골. 엔진이 분 단위로만
    //   전진하므로 minute=0에선 어떤 골도 아직 발생하지 않아 반드시 0:0.
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={6} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    // 타이머 미진행 → engine.minute=0
    const nums = container.querySelectorAll('.bc-scorebug__num')
    expect(nums[0].textContent).toBe('0')
    expect(nums[1].textContent).toBe('0')
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

    // 감독 타임 → 체인 정지. 이후 시간을 크게 흘려도 분이 전진하지 않아야 한다.
    act(() => { store().pauseByUser() })
    expect(store().phase).toBe('paused-user')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(store().engine!.minute).toBe(before)

    // 전술 확정 → 재개. 한 스텝 진행하면 분이 다시 늘어난다.
    act(() => { store().confirmTactics() })
    expect(store().phase).toBe('playing')
    step(1)
    expect(store().engine!.minute).toBeGreaterThan(before)
  })

  it('(g) 속도 토글 — 선택 상태 반영 + 2x가 같은 시간에 더 많이 전진', () => {
    // 동일 예산(wall time) 대비 2x는 dwell이 절반이라 더 많은 분을 소화한다.
    function minutesInBudget(setTo2x: boolean, budgetMs: number): number {
      store().reset()
      const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
      fireEvent.click(getByRole('button', { name: '킥오프' }))
      if (setTo2x) {
        const btn = getByRole('button', { name: '2x' })
        fireEvent.click(btn)
        expect(btn.getAttribute('aria-pressed')).toBe('true')
      }
      // 브레이크(28'±) 이전에 머무는 작은 예산으로 순수 속도 효과만 측정.
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
