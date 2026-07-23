// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { slotCoords, XI_SLOTS } from '../pitch/formations'
import { PitchView } from '../pitch/PitchView'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { createMatch } from '../../engine/simulate'
import type { FormationId } from '../../engine/types'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

describe('slotCoords', () => {
  it('6종 포메이션 × 11슬롯이 모두 0~100 좌표 내', () => {
    for (const f of FORMATIONS) {
      expect(XI_SLOTS[f]).toHaveLength(11)
      for (const side of ['home', 'away'] as const) {
        for (let i = 0; i < 11; i++) {
          const { x, y } = slotCoords(f, i, side)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(100)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(100)
        }
      }
    }
  })

  it('GK(슬롯0)가 홈은 x 최소·어웨이는 x 최대', () => {
    for (const f of FORMATIONS) {
      const gkHome = slotCoords(f, 0, 'home')
      const gkAway = slotCoords(f, 0, 'away')
      const homeXs = XI_SLOTS[f].map((_, i) => slotCoords(f, i, 'home').x)
      const awayXs = XI_SLOTS[f].map((_, i) => slotCoords(f, i, 'away').x)
      expect(gkHome.x).toBe(Math.min(...homeXs))
      expect(gkAway.x).toBe(Math.max(...awayXs))
      // 첫 슬롯은 GK여야 한다 (엔진 lineup 순서와 일치)
      expect(XI_SLOTS[f][0]).toBe('GK')
    }
  })

  it('홈·어웨이 x 미러 (away.x ≈ 100 - home.x)', () => {
    for (const f of FORMATIONS) {
      for (let i = 0; i < 11; i++) {
        const h = slotCoords(f, i, 'home')
        const a = slotCoords(f, i, 'away')
        expect(a.x).toBeCloseTo(100 - h.x, 5)
      }
    }
  })

  it('4-3-3 슬롯 순서가 엔진 lineup.ts와 동일', () => {
    expect(XI_SLOTS['4-3-3']).toEqual(['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST'])
  })
})

describe('PitchView', () => {
  it('양팀 lineup 22 도트를 렌더한다', () => {
    const home = makeTestTeam('kor', 82)
    const away = makeTestTeam('esp', 84)
    const state = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={state} />)
    expect(container.querySelectorAll('.pv-dot')).toHaveLength(22)
  })

  it('lastEvent 마커를 렌더한다 (goal)', () => {
    const home = makeTestTeam('kor', 82)
    const away = makeTestTeam('esp', 84)
    const state = createMatch(home, away, { seed: 42 })
    const { container } = render(
      <PitchView state={state} lastEvent={{ minute: 33, type: 'goal', teamId: home.id }} />
    )
    expect(container.querySelector('.pv-marker')).toBeTruthy()
  })
})
