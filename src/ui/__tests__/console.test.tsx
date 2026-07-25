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
  it('(a) 재생 중(playing)엔 "지시 적용" 버튼 disabled + 잠금 문구', () => {
    store().startMatch(home, away, 42)
    store().kickoff() // phase='playing'
    const { getByRole, getByText } = render(<ConsolePanel side="home" />)
    const btn = getByRole('button', { name: '지시 적용' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(getByText('다음 개입 창까지 잠김')).toBeTruthy()
  })

  it("(a2) 킥오프 전('pre')은 슬라이더 조작이 버튼 없이 즉시 반영된다", () => {
    store().startMatch(home, away, 42) // phase='pre'
    const { queryByRole, getByLabelText } = render(<ConsolePanel side="home" />)
    // 즉시 반영이므로 [지시 적용] 버튼 자체가 없다(있으면 "아직 적용 안 됨"이라는 거짓 신호).
    expect(queryByRole('button', { name: '지시 적용' })).toBeNull()
    fireEvent.change(getByLabelText('템포') as HTMLInputElement, { target: { value: '70' } })
    expect(store().engine!.home.tactics.instructions.tempo).toBe(70)
    fireEvent.change(getByLabelText('공격방향') as HTMLSelectElement, { target: { value: 'left' } })
    expect(store().engine!.home.tactics.instructions.attackFocus).toBe('left')
  })

  it("(a3) 킥오프 전 슬라이더 드래그는 결정 로그를 남기지 않는다(기자회견 노이즈 방지)", () => {
    store().startMatch(home, away, 42)
    const { getByLabelText } = render(<ConsolePanel side="home" />)
    const line = getByLabelText('라인') as HTMLInputElement
    for (const v of ['51', '52', '53', '54']) fireEvent.change(line, { target: { value: v } })
    expect(store().engine!.home.tactics.instructions.lineHeight).toBe(54)
    expect(store().decisionLog).toHaveLength(0)
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
