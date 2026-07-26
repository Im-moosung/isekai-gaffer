// @vitest-environment jsdom
// F4: 워룸·작전판 공용 팀 경기 스탯 패널.
// 고정하는 계약은 두 가지 정직성이다:
//  (1) 진행 전에는 0을 늘어놓지 않고 "경기 전"이라고 말한다
//  (2) 엔진이 추적하지 않는 패스 성공률을 경기 기록인 척하지 않는다(각주로 출처를 밝힌다)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { MatchStatsPanel } from '../StatsTable'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

describe('MatchStatsPanel', () => {
  it('엔진이 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<MatchStatsPanel />)
    expect(container.querySelector('.mst')).toBeNull()
  })

  it('킥오프 전(0분)에는 수치 대신 "경기 전" 안내만 보인다', () => {
    store().startMatch(home, away, 20260726)
    const { container } = render(<MatchStatsPanel />)
    expect(container.querySelector('.mst__minute')!.textContent).toBe('경기 전')
    expect(container.querySelector('.mst__empty')).toBeTruthy()
    expect(container.querySelectorAll('.mst__row')).toHaveLength(0)
  })

  it('경기가 진행되면 분·팀 코드·스탯 행을 그린다', () => {
    store().startMatch(home, away, 20260726)
    act(() => { store().kickoff() })
    for (let i = 0; i < 10; i++) act(() => { store().advanceMinute() })
    const { container } = render(<MatchStatsPanel />)
    expect(container.querySelector('.mst__empty')).toBeNull()
    expect(container.querySelector('.mst__minute')!.textContent).toBe("10'")
    const labels = [...container.querySelectorAll('.mst__label')].map(e => e.textContent)
    expect(labels).toEqual(['점유율', '패스 성공률*', '슛', '유효슛', 'xG', '코너', '파울'])
  })

  it('패스 성공률이 0이면 팀 시즌 평균으로 채우고 각주로 출처를 밝힌다', () => {
    // 엔진은 경기 중 패스를 추적하지 않으므로 시뮬 경기에서 passAccuracy는 0으로 남는다.
    store().startMatch(home, away, 20260726)
    act(() => { store().kickoff() })
    act(() => { store().advanceMinute() })
    expect(useMatchStore.getState().engine!.stats[0].passAccuracy).toBe(0)
    const { container } = render(<MatchStatsPanel />)
    const pass = [...container.querySelectorAll('.mst__row')].find(r => r.textContent!.includes('패스 성공률'))!
    const vals = [...pass.querySelectorAll('.mst__val')].map(e => e.textContent)
    expect(vals).toEqual([
      `${Math.round(home.statBaseline.passAccuracy)}%`,
      `${Math.round(away.statBaseline.passAccuracy)}%`,
    ])
    expect(container.querySelector('.mst__note')!.textContent).toContain('팀 시즌 평균')
  })
})
