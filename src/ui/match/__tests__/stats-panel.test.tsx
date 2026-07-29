// @vitest-environment jsdom
// F4: 워룸·작전판 공용 팀 경기 스탯 패널.
// 고정하는 계약은 두 가지 정직성이다:
//  (1) 진행 전에는 0을 늘어놓지 않고 "경기 전"이라고 말한다
//  (2) 패스 성공률은 엔진이 실제로 집계한 경기 기록이다 — 시즌 평균 폴백도 각주도 없다
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
    expect(labels).toEqual(['점유율', '패스 성공률', '슛', '유효슛', 'xG', '코너', '파울'])
  })

  it('패스 성공률은 엔진 집계값을 그대로 쓴다 — 시즌 평균 폴백도 각주도 없다', () => {
    store().startMatch(home, away, 20260726)
    act(() => { store().kickoff() })
    for (let i = 0; i < 30; i++) act(() => { store().advanceMinute() })
    const engine = useMatchStore.getState().engine!
    // 엔진이 실제로 패스를 굴렸다: 시도 수가 쌓이고 성공률이 0이 아니다.
    expect(engine.stats[0].passesAttempted).toBeGreaterThan(0)
    expect(engine.stats[0].passAccuracy).toBeGreaterThan(0)
    const { container } = render(<MatchStatsPanel />)
    const pass = [...container.querySelectorAll('.mst__row')].find(r => r.textContent!.includes('패스 성공률'))!
    const vals = [...pass.querySelectorAll('.mst__val')].map(e => e.textContent)
    expect(vals).toEqual([
      `${Math.round(engine.stats[0].passAccuracy)}%`,
      `${Math.round(engine.stats[1].passAccuracy)}%`,
    ])
    expect(container.querySelector('.mst__note')).toBeNull()
  })
})
