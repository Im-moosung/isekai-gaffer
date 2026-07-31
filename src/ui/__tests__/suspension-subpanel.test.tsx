// @vitest-environment jsdom
// 교체 탭(작전판)의 상태 칩과 정지 잠금. 사용자가 실제로 "누굴 뺄까"를 결정하는 화면이라
// 여기서 한눈에 안 보이면 기능이 없는 것과 같다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { SubPanel } from '../console/SubPanel'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

/** 벤치(선발 밖) 첫 선수 id. */
function benchId(): string {
  const st = store().engine!.home
  const starters = new Set(st.tactics.lineup.map(l => l.playerId))
  return st.team.squad.find(p => !starters.has(p.id))!.id
}

describe('교체 탭 — 징계·컨디션 칩', () => {
  it('징계가 없으면 칩이 붙지 않는다(체력 만재·사기 기준선)', () => {
    store().startMatch(home, away, 42)
    const { container } = render(<SubPanel side="home" />)
    expect(container.querySelectorAll('.sx__chip')).toHaveLength(0)
  })

  it('경고 1장 보유자만 카드 칩이 붙는다', () => {
    store().startMatch(home, away, 42)
    const id = store().engine!.home.tactics.lineup[3].playerId
    store().startMatch(home, away, 42, { discipline: { suspendedIds: [], cautions: { [id]: 1 } } })
    const { container } = render(<SubPanel side="home" />)
    const chips = container.querySelectorAll('.sx__chip[data-kind="caution"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].getAttribute('title')).toContain('누적 경고 1장')
  })

  it('출장정지 선수는 벤치에서 선택할 수 없고 사유가 붙는다', () => {
    store().startMatch(home, away, 42)
    const banned = benchId()
    store().startMatch(home, away, 42, { discipline: { suspendedIds: [banned], cautions: {} } })
    const { container } = render(<SubPanel side="home" />)
    const card = container.querySelector('.cs-card--susp') as HTMLButtonElement
    expect(card).toBeTruthy()
    expect(card.disabled).toBe(true)
    expect(card.querySelector('.sx__chip[data-kind="susp"]')?.getAttribute('title')).toContain('출장정지')
  })

  it('정지 칩은 단독으로 뜬다 — 뛰지 않는 선수의 체력·사기는 붙이지 않는다', () => {
    store().startMatch(home, away, 42)
    const banned = benchId()
    store().startMatch(home, away, 42, { discipline: { suspendedIds: [banned], cautions: { [banned]: 1 } } })
    const { container } = render(<SubPanel side="home" />)
    const card = container.querySelector('.cs-card--susp')!
    expect(card.querySelectorAll('.sx__chip')).toHaveLength(1)
  })

  it('체력이 떨어지면 체력 칩이 뜬다 — 하위 선수를 목록 스캔으로 찾을 수 있다', () => {
    store().startMatch(home, away, 42)
    const ids = store().engine!.home.tactics.lineup.slice(0, 3).map(l => l.playerId)
    const staminaOverride: Record<string, number> = {}
    ids.forEach((id, i) => { staminaOverride[id] = 35 + i * 10 }) // 35 / 45 / 55
    store().startMatch(home, away, 42, { staminaOverride })
    const { container } = render(<SubPanel side="home" />)
    const fit = container.querySelectorAll('.sx__chip[data-kind="fit"]')
    expect(fit).toHaveLength(3)
    // 40 미만은 danger, 이상은 warn — 색만이 아니라 수치도 칩에 찍힌다.
    expect(container.querySelectorAll('.sx__chip[data-kind="fit"].sx__chip--danger')).toHaveLength(1)
    expect(Array.from(fit).map(e => e.textContent)).toEqual(['35', '45', '55'])
  })

  it('사기가 밴드를 벗어나면 방향이 다른 도형으로 뜬다', () => {
    store().startMatch(home, away, 42)
    const [a, b] = store().engine!.home.tactics.lineup.slice(0, 2).map(l => l.playerId)
    store().startMatch(home, away, 42, { moraleOverride: { [a]: 30, [b]: 95 } })
    const { container } = render(<SubPanel side="home" />)
    expect(container.querySelectorAll('.sx__chip--tri-down')).toHaveLength(1)
    expect(container.querySelectorAll('.sx__chip--tri-up')).toHaveLength(1)
  })

  it('상대(away) 패널에는 우리 징계를 적용하지 않는다', () => {
    store().startMatch(home, away, 42)
    const banned = benchId()
    store().startMatch(home, away, 42, { discipline: { suspendedIds: [banned], cautions: {} } })
    const { container } = render(<SubPanel side="away" />)
    expect(container.querySelector('.cs-card--susp')).toBeNull()
  })
})

describe('matchStore — 징계·사기 이월 배선', () => {
  it('discipline 미지정이면 빈 상태(데모 호환)', () => {
    store().startMatch(home, away, 42)
    expect(store().discipline).toEqual({ suspendedIds: [], cautions: {} })
  })

  it('moraleOverride가 홈 시작 사기를 덮어쓴다', () => {
    store().startMatch(home, away, 42)
    const id = store().engine!.home.team.squad[0].id
    store().startMatch(home, away, 42, { moraleOverride: { [id]: 55 } })
    expect(store().engine!.home.moraleByPlayer[id]).toBe(55)
  })
})
