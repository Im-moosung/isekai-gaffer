// @vitest-environment jsdom
// 교체가 막혔을 때 화면이 그 이유를 말하는가.
//
// 감사 재현: `교체 5/5명 · 교체 기회 2/3회`가 떠 있는데 선수 목록은 그대로 보이고,
// 카드를 눌러도 아무 일이 일어나지 않으며, [교체 확정]만 조용히 죽어 있었다.
// 사용자에게 이건 규칙이 아니라 고장으로 읽힌다.
//
// 계약: (1) 패널을 막는 사유는 상단 배너에 **전부** 열거된다(둘 이상이면 둘 다),
//       (2) 막힌 카드는 disabled가 아니라 aria-disabled라 **눌리고**, 누르면 사유가 뜬다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { SubPanel } from '../console/SubPanel'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import type { MatchState } from '../../engine/types'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

/** 개입 창(하이드레이션 브레이크)을 연 상태로 홈 사이드를 원하는 값으로 바꾼다. */
function atBreak(patch: Partial<MatchState['home']> = {}, minute = 60) {
  store().startMatch(home, away, 42)
  const eng = store().engine!
  useMatchStore.setState({
    phase: 'paused-break',
    pauseReason: { kind: 'hydration1' },
    engine: { ...eng, minute, home: { ...eng.home, ...patch } },
  })
}

const banner = (c: HTMLElement) => c.querySelector('.cs-sub__locked')?.textContent ?? ''
const errorText = (c: HTMLElement) => c.querySelector('.cs-error')?.textContent ?? ''
const lineupCard = (c: HTMLElement, i = 0) =>
  c.querySelectorAll<HTMLButtonElement>('.cs-sub__lineup .cs-card')[i]
const benchCard = (c: HTMLElement, i = 0) =>
  c.querySelectorAll<HTMLButtonElement>('.cs-sub__bench .cs-card')[i]

describe('교체 패널 — 차단 사유 고지', () => {
  it('인원 5/5 소진: 배너가 이유를 말하고 카운터가 경고 상태가 된다', () => {
    atBreak({ subsUsed: 5 })
    const { container } = render(<SubPanel side="home" />)
    expect(banner(container)).toContain('교체 인원 5명을 모두 사용했습니다')
    expect(banner(container)).toContain('더 이상 선수를 바꿀 수 없습니다')
    expect(container.querySelector('.cs-sub__count--hot')).toBeTruthy()
  })

  it('기회 3/3 소진: 배너가 이유를 말한다(하프타임 전이면 풀리는 조건까지)', () => {
    atBreak({ subWindowsUsed: 3, lastSubMinute: 25 }, 30)
    const { container } = render(<SubPanel side="home" />)
    expect(banner(container)).toContain('교체 기회 3회를 모두 사용했습니다')
    expect(banner(container)).toContain('하프타임에는 기회 소모 없이')
  })

  it('인원과 기회가 동시에 소진되면 두 사유가 함께 열거된다', () => {
    atBreak({ subsUsed: 5, subWindowsUsed: 3, lastSubMinute: 50 })
    const { container } = render(<SubPanel side="home" />)
    const items = container.querySelectorAll('.cs-sub__reasons li')
    expect(items).toHaveLength(2)
    const all = banner(container)
    expect(all).toContain('교체 인원 5명')
    expect(all).toContain('교체 기회 3회')
  })

  it('벤치 전원이 부적격이면 그 사실을 말한다', () => {
    store().startMatch(home, away, 42)
    const st = store().engine!.home
    const starters = new Set(st.tactics.lineup.map(l => l.playerId))
    const benchIds = st.team.squad.filter(p => !starters.has(p.id)).map(p => p.id)
    store().startMatch(home, away, 42, { discipline: { suspendedIds: benchIds, cautions: {} } })
    useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
    const { container } = render(<SubPanel side="home" />)
    expect(banner(container)).toContain('투입할 수 있는 벤치 선수가 없습니다')
  })

  // ★ 2026-08-02 계약 변경 — 개입 창이 닫힌 것은 **배너로 자발적으로 말하지 않는다**.
  //   SubPanel은 작전판 안에서만 살고 작전판은 정지 국면에서만 열리므로, !open이 참이
  //   되는 실제 순간은 [전술 확정] 직후 오버레이가 역연출로 남아 있는 700ms뿐이었다.
  //   그 사이 빨간 role="alert"가 번쩍여 "확정하면 경고창이 뜨며 넘어간다"로 보였다.
  //   경고는 유저의 시도에 대한 응답이어야 한다 → 눌렀을 때만, 그것도 조용한 슬롯에.
  it('개입 창이 아니면 배너 대신 조용한 잠금 표시만 둔다', () => {
    store().startMatch(home, away, 42)
    store().kickoff()
    const { container, getByText } = render(<SubPanel side="home" />)
    expect(container.querySelector('.cs-sub__locked')).toBeNull()
    expect(getByText('다음 브레이크까지 잠김')).toBeTruthy()
  })

  it('개입 창이 아닐 때 눌러 보면 언제 열리는지까지 말한다', () => {
    store().startMatch(home, away, 42)
    store().kickoff()
    const { container, getByRole } = render(<SubPanel side="home" />)
    fireEvent.click(lineupCard(container))
    expect(errorText(container)).toContain('지금은 개입할 수 없는 시점입니다')
    expect(errorText(container)).toContain('하이드레이션 브레이크')
    // 여전히 배너는 뜨지 않는다 — 사유는 안내 슬롯 한 곳에서만 말한다.
    expect(container.querySelector('.cs-sub__locked')).toBeNull()
    // [교체 확정]도 같은 사유를 말하고 아무것도 바꾸지 않는다.
    fireEvent.click(getByRole('button', { name: '교체 확정' }))
    expect(errorText(container)).toContain('지금은 개입할 수 없는 시점입니다')
    expect(store().engine!.home.subsUsed).toBe(0)
  })

  it('막힌 상태에서 카드는 눌린다(disabled 아님) — 클릭이 배너를 다시 가리킨다', () => {
    atBreak({ subsUsed: 5 })
    const { container } = render(<SubPanel side="home" />)
    const card = lineupCard(container)
    expect(card.disabled).toBe(false)
    expect(card.getAttribute('aria-disabled')).toBe('true')
    // 사유는 카드 자신도 들고 있다(툴팁·스크린리더).
    expect(card.title).toContain('교체 인원 5명을 모두 사용했습니다')
    fireEvent.click(card)
    // 같은 문장을 아래에 또 적지 않는다 — 대신 배너를 흔들어 재고지한다(role="alert" 재읽기).
    expect(container.querySelector('.cs-sub__locked')?.getAttribute('data-nudge')).toBe('1')
    expect(errorText(container)).toBe('')
    fireEvent.click(benchCard(container))
    expect(container.querySelector('.cs-sub__locked')?.getAttribute('data-nudge')).toBe('2')
    // 선택은 성립하지 않는다.
    expect(card.getAttribute('aria-pressed')).toBe('false')
  })

  it('[교체 확정]을 눌러도 배너가 다시 고지되고 교체는 일어나지 않는다', () => {
    atBreak({ subsUsed: 5 })
    const { container, getByRole } = render(<SubPanel side="home" />)
    const confirm = getByRole('button', { name: '교체 확정' })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(confirm)
    expect(container.querySelector('.cs-sub__locked')?.getAttribute('data-nudge')).toBe('1')
    expect(store().engine!.home.subsUsed).toBe(5)
  })

  it('퇴장 선수는 OUT으로 고를 수 없고 눌렀을 때 규정 사유가 뜬다', () => {
    store().startMatch(home, away, 42)
    const sent = store().engine!.home.tactics.lineup[4].playerId
    atBreak({ sentOff: [sent] })
    const { container } = render(<SubPanel side="home" />)
    const cards = [...container.querySelectorAll<HTMLButtonElement>('.cs-sub__lineup .cs-card')]
    const name = home.squad.find(p => p.id === sent)!.name.ko
    const card = cards.find(el => el.querySelector('.cs-card__name')?.textContent === name)!
    expect(card.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(card)
    expect(errorText(container)).toContain('퇴장당한 선수는 교체로 뺄 수 없습니다')
    // 선택 자체가 성립하지 않으므로 다음 단계로 넘어가지 않는다.
    expect(card.getAttribute('aria-pressed')).toBe('false')
  })

  it('제어 모드에서 퇴장 선수를 강제로 OUT에 넣어도 [교체 확정]이 거부한다', () => {
    store().startMatch(home, away, 42)
    const eng0 = store().engine!.home
    const sent = eng0.tactics.lineup[4].playerId
    const starters = new Set(eng0.tactics.lineup.map(l => l.playerId))
    const benchFirst = eng0.team.squad.find(p => !starters.has(p.id))!.id
    atBreak({ sentOff: [sent] })
    const { container, getByText } = render(
      <SubPanel side="home" outId={sent} inId={benchFirst} onSelectOut={() => {}} onSelectIn={() => {}} />,
    )
    fireEvent.click(getByText('교체 확정'))
    expect(errorText(container)).toContain('퇴장당한 선수는 교체로 뺄 수 없습니다')
    expect(store().engine!.home.tactics.lineup.map(l => l.playerId)).toContain(sent)
  })

  it('나갈 선수를 고르기 전 벤치 카드를 누르면 순서를 알려 준다', () => {
    atBreak()
    const { container } = render(<SubPanel side="home" />)
    expect(container.querySelector('.cs-sub__locked')).toBeNull()
    fireEvent.click(benchCard(container))
    expect(errorText(container)).toContain('먼저 나갈 선수를 고르세요')
  })

  it('막히지 않은 상태에서는 배너도 경고 카운터도 뜨지 않는다', () => {
    atBreak()
    const { container, getByRole } = render(<SubPanel side="home" />)
    expect(container.querySelector('.cs-sub__locked')).toBeNull()
    expect(container.querySelector('.cs-sub__count--hot')).toBeNull()
    fireEvent.click(lineupCard(container))
    fireEvent.click(benchCard(container))
    expect(getByRole('button', { name: '교체 확정' }).getAttribute('aria-disabled')).toBe('false')
  })
})
