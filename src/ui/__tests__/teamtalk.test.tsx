// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { TeamTalk } from '../match/TeamTalk'
import { useMatchStore } from '../../game/matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

describe('TeamTalk 컴포넌트', () => {
  it('4톤 버튼(격노·격려·침착·신뢰)을 렌더한다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const { getByRole } = render(<TeamTalk side="home" />)
    for (const label of ['격노', '격려', '침착', '신뢰']) {
      expect(getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('선택 시 사기 보정 후 버튼 비활성 + 완료 표시', () => {
    // 비기는 중(0-0) → 침착 +4
    store().startMatch(a, b, 42)
    store().playTo(45)
    const before = { ...store().engine!.home.moraleByPlayer }
    const { getByRole, container, rerender } = render(<TeamTalk side="home" />)
    fireEvent.click(getByRole('button', { name: '침착' }))
    rerender(<TeamTalk side="home" />)

    const anyId = Object.keys(before)[0]
    expect(store().engine!.home.moraleByPlayer[anyId]).toBe(Math.min(100, before[anyId] + 4))
    expect(store().talked).toBe(true)
    // 모든 버튼 비활성
    for (const label of ['격노', '격려', '침착', '신뢰']) {
      expect((getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(container.querySelector('.tt-done')).toBeTruthy()
  })
})
