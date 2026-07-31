// @vitest-environment jsdom
// 출장정지가 워룸에서 실제로 잠기는가. "규정은 구현했는데 화면에서 여전히 세울 수 있다"가
// 이 기능의 유일한 실패 모드라, 자동 경로(autoFill·pickBestXI·enforceUnavailable)와
// 수동 경로(클릭)를 함께 고정한다.
import { describe, it, expect, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { LineupEditor } from '../lineup/LineupScreen'
import { autoFill, enforceUnavailable } from '../lineup/swap'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'
import type { TacticState } from '../../engine/types'

const team = makeTestTeam('kor', 80)
const initial: TacticState = pickBestXI(team)

afterEach(() => cleanup())

describe('자동 배치 경로 — 정지 선수를 세우지 않는다', () => {
  it('pickBestXI가 제외 목록의 선수를 뽑지 않는다', () => {
    const banned = initial.lineup.slice(0, 3).map(l => l.playerId)
    const xi = pickBestXI(team, undefined, banned)
    expect(xi.lineup).toHaveLength(11)
    expect(xi.lineup.some(l => banned.includes(l.playerId))).toBe(false)
  })

  it('autoFill이 제외 목록의 선수를 배치하지 않는다(포메이션 6종 전부)', () => {
    const banned = initial.lineup.slice(0, 4).map(l => l.playerId)
    for (const f of ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1'] as const) {
      const lineup = autoFill(team, f, initial.lineup.map(l => l.playerId), 'squad', banned)
      expect(lineup).toHaveLength(11)
      expect(lineup.some(l => banned.includes(l.playerId))).toBe(false)
    }
  })

  it('enforceUnavailable이 이월 XI의 정지 선수를 갈아끼운다', () => {
    const banned = [initial.lineup[5].playerId]
    const fixed = enforceUnavailable(team, initial, banned)
    expect(fixed.lineup).toHaveLength(11)
    expect(fixed.lineup.some(l => banned.includes(l.playerId))).toBe(false)
  })

  it('정지자가 없으면 원본 참조를 그대로 돌려준다(MatchScreen 재초기화 방지)', () => {
    expect(enforceUnavailable(team, initial, [])).toBe(initial)
    // XI 밖의 선수가 정지여도 XI는 손대지 않는다.
    const benchId = team.squad.find(p => !initial.lineup.some(l => l.playerId === p.id))!.id
    expect(enforceUnavailable(team, initial, [benchId])).toBe(initial)
  })

  it('제외가 과해 11명을 못 채우면 제외를 포기하고 11명을 채운다(빈 라인업 금지)', () => {
    const banned = team.squad.slice(0, team.squad.length - 3).map(p => p.id)
    expect(autoFill(team, '4-3-3', undefined, 'squad', banned)).toHaveLength(11)
    expect(pickBestXI(team, '4-3-3', banned).lineup).toHaveLength(11)
  })
})

describe('워룸 UI — 정지 선수 잠금과 경고 보유자 식별', () => {
  const benchOf = (t: TacticState) =>
    team.squad.find(p => !t.lineup.some(l => l.playerId === p.id))!

  it('정지 선수의 벤치 행이 비활성화되고 사유가 붙는다', () => {
    const banned = benchOf(initial)
    const { container } = render(
      <LineupEditor team={team} tactics={initial} onChange={() => {}} unavailableIds={[banned.id]} />,
    )
    const row = container.querySelector('.lu-card--susp') as HTMLButtonElement
    expect(row).toBeTruthy()
    expect(row.disabled).toBe(true)
    expect(row.getAttribute('aria-label')).toContain('출장정지')
    expect(row.querySelector('.sx__chip[data-kind="susp"]')).toBeTruthy()
  })

  it('벤치 헤더가 정지 인원과 이름을 먼저 말한다', () => {
    const banned = benchOf(initial)
    const { container } = render(
      <LineupEditor team={team} tactics={initial} onChange={() => {}} unavailableIds={[banned.id]} />,
    )
    const head = container.querySelector('.lu-bench__susp')!
    expect(head.textContent).toContain('출장정지')
    expect(head.textContent).toContain(banned.name.ko)
  })

  it('정지 선수를 클릭해 선발과 교환할 수 없다', () => {
    const banned = benchOf(initial)
    let current = initial
    const { container, rerender } = render(
      <LineupEditor
        team={team} tactics={current} onChange={t => { current = t }} unavailableIds={[banned.id]}
      />,
    )
    // 선발 하나를 고른 뒤 정지 선수를 눌러도 교체가 일어나지 않는다.
    fireEvent.click(container.querySelectorAll('.lu-chip')[3])
    const row = container.querySelector('.lu-card--susp') as HTMLButtonElement
    fireEvent.click(row)
    rerender(<LineupEditor team={team} tactics={current} onChange={() => {}} unavailableIds={[banned.id]} />)
    expect(current.lineup.some(l => l.playerId === banned.id)).toBe(false)
  })

  it('포메이션을 바꿔도 정지 선수가 자동으로 들어오지 않는다', () => {
    const banned = benchOf(initial)
    let current = initial
    const { getByRole } = render(
      <LineupEditor
        team={team} tactics={current} onChange={t => { current = t }} unavailableIds={[banned.id]}
      />,
    )
    fireEvent.click(getByRole('button', { name: '3-5-2' }))
    expect(current.lineup).toHaveLength(11)
    expect(current.lineup.some(l => l.playerId === banned.id)).toBe(false)
  })

  it('경고 1장 보유 선발이 칩으로 구분된다 — 핵심 결정 축', () => {
    const booked = initial.lineup[4].playerId
    const { container } = render(
      <LineupEditor
        team={team} tactics={initial} onChange={() => {}} cautionByPlayer={{ [booked]: 1 }}
      />,
    )
    const chips = container.querySelectorAll('.lu-chip .sx__chip[data-kind="caution"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].getAttribute('aria-label')).toContain('누적 경고 1장')
  })

  it('경고가 없는 선수에게는 칩이 붙지 않는다(전원에게 붙으면 정보량 0)', () => {
    const { container } = render(<LineupEditor team={team} tactics={initial} onChange={() => {}} />)
    expect(container.querySelectorAll('.sx__chip')).toHaveLength(0)
  })
})
