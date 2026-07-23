// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { MatchScreen } from '../match/MatchScreen'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// displayMinute 재생 루프는 200ms 간격 setInterval. 각 스텝을 act로 감싸
// interval 재생성(displayMinute 의존 useEffect)을 안정적으로 진행시킨다.
function step(times: number) {
  for (let i = 0; i < times; i++) {
    act(() => { vi.advanceTimersByTime(200) })
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
    // playTo(45)는 즉시 실행 → engine.minute=45, displayMinute은 재생으로 증가
    step(10)
    expect(clock(container as HTMLElement)).toBeGreaterThan(0)
  })

  it('(c) 크래시 없이 halftime 도달 → "후반 시작" 버튼 등장', () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    step(50) // 45분 재생 + 여유
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
  })
})
