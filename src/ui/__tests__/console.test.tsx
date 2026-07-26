// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
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
    expect(getByText('다음 브레이크까지 잠김')).toBeTruthy()
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

  it('(d) 남은 인원과 남은 교체 기회를 함께 표시한다("창"이라 쓰지 않는다)', () => {
    store().startMatch(home, away, 42)
    toHalftime()
    const { container } = render(<SubPanel side="home" />)
    const count = container.querySelector('.cs-sub__count')!.textContent!
    expect(count).toContain('교체 0/5명')
    expect(count).toContain('교체 기회 0/3회')
    expect(count).not.toContain('창')
    // 하프타임 교체는 기회를 소모하지 않는다는 사실을 그 자리에서 알린다.
    expect(container.textContent).toContain('하프타임 교체는 교체 기회를 소모하지 않습니다')
  })

  it('(e) 기회 소진 시 [교체 확정]이 막히고 이유가 표시된다 — 하프타임 전후로 문구가 다르다', () => {
    store().startMatch(home, away, 42)
    store().kickoff()
    store().advanceMinute()
    // 전반 30분·기회 3회 소진 상태를 직접 구성(시뮬 없이 규정 표시만 검증).
    const eng = store().engine!
    useMatchStore.setState({
      phase: 'paused-user',
      pauseReason: { kind: 'user' },
      engine: { ...eng, minute: 30, home: { ...eng.home, subWindowsUsed: 3, lastSubMinute: 25 } },
    })
    const { container, getByRole } = render(<SubPanel side="home" />)
    expect(container.querySelector('.cs-sub__locked')!.textContent)
      .toContain('하프타임에는 기회 소모 없이')
    // 패널 열람 자체는 막지 않는다 — 선수 카드는 그대로 보인다.
    expect(container.querySelectorAll('.cs-sub__lineup .cs-card').length).toBe(11)
    const outCard = container.querySelector('.cs-sub__lineup .cs-card') as HTMLElement
    const inCard = container.querySelector('.cs-sub__bench .cs-card') as HTMLElement
    fireEvent.click(outCard)
    fireEvent.click(inCard)
    expect((getByRole('button', { name: '교체 확정' }) as HTMLButtonElement).disabled).toBe(true)

    // 하프타임을 지난 뒤에는 "하프타임에는…" 안내가 거짓이 되므로 문구가 바뀐다.
    const eng2 = store().engine!
    act(() => { useMatchStore.setState({ engine: { ...eng2, minute: 70 } }) })
    expect(container.querySelector('.cs-sub__locked')!.textContent)
      .toContain('더 이상 교체할 수 없습니다')
  })
})
