// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { MatchScreen } from '../match/MatchScreen'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// 재생 루프는 200ms 간격 setInterval으로 advanceMinute(1분 전진)을 호출한다.
// 각 스텝을 act로 감싸 interval 콜백·리렌더를 안정적으로 진행시킨다.
function step(times: number) {
  for (let i = 0; i < times; i++) {
    act(() => { vi.advanceTimersByTime(200) })
  }
}

// 하프타임까지 재생 — 도중 하이드레이션 브레이크(paused-break)에서 confirmTactics로 재개.
function replayToHalftime() {
  for (let i = 0; i < 300 && store().phase !== 'halftime'; i++) {
    if (store().phase === 'playing') act(() => { vi.advanceTimersByTime(200) })
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
    // advanceMinute이 1분씩 전진 → engine.minute(표시 분) 증가 (첫 브레이크 전까지)
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
