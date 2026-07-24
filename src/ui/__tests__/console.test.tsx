// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

/** 킥오프→하프타임 재생(하이드레이션 브레이크는 재개). */
function toHalftime() {
  store().kickoff()
  let guard = 0
  while (store().phase !== 'halftime' && guard++ < 200) {
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

describe('ConsolePanel (지시 4축)', () => {
  it('(a) playing/pre 시점엔 "지시 적용" 버튼 disabled + 잠금 문구', () => {
    store().startMatch(home, away, 42) // phase='pre'
    const { getByRole, getByText } = render(<ConsolePanel side="home" />)
    const btn = getByRole('button', { name: '지시 적용' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(getByText('다음 개입 창까지 잠김')).toBeTruthy()
  })

  it('(b) halftime에서 압박 슬라이더 변경 → 적용 → 엔진 지시 반영', () => {
    store().startMatch(home, away, 42)
    toHalftime()
    const { getByLabelText, getByRole } = render(<ConsolePanel side="home" />)
    const pressing = getByLabelText('압박') as HTMLInputElement
    fireEvent.change(pressing, { target: { value: '80' } })
    const btn = getByRole('button', { name: '지시 적용' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(store().engine!.home.tactics.instructions.pressing).toBe(80)
  })
})

describe('SubPanel (교체)', () => {
  it('(c) halftime에서 아웃/인 선택 → 교체 → subsUsed 1 증가', () => {
    store().startMatch(home, away, 42)
    toHalftime()
    const before = store().engine!.home.subsUsed
    const { container, getByRole } = render(<SubPanel side="home" />)

    const outCard = container.querySelector('.cs-sub__lineup .cs-card') as HTMLElement
    const inCard = container.querySelector('.cs-sub__bench .cs-card') as HTMLElement
    fireEvent.click(outCard)
    fireEvent.click(inCard)

    fireEvent.click(getByRole('button', { name: '교체 확정' }))
    expect(store().engine!.home.subsUsed).toBe(before + 1)
  })
})
