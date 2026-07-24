// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ShootoutPanel } from '../match/ShootoutPanel'
import { topPenaltyIds, bestGk, autoAwayKickers, buildShootoutParams } from '../match/shootout-setup'
import { simulateShootout } from '../../engine/shootout'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 78)
const away = makeTestTeam('esp', 86)

afterEach(() => cleanup())

describe('ShootoutPanel 로직(순수 함수)', () => {
  it('topPenaltyIds: penalty 상위 5인, GK 제외, 결정론', () => {
    const ids = topPenaltyIds(home)
    expect(ids).toHaveLength(5)
    const field = home.squad.filter(p => p.position !== 'GK')
    const top = [...field].sort((a, b) => b.penalty - a.penalty || a.id.localeCompare(b.id)).slice(0, 5).map(p => p.id)
    expect(ids).toEqual(top)
    // GK 미포함
    const gkIds = new Set(home.squad.filter(p => p.position === 'GK').map(p => p.id))
    expect(ids.some(id => gkIds.has(id))).toBe(false)
  })

  it('bestGk: saving 최상위 골키퍼', () => {
    const gk = bestGk(home)
    expect(gk.position).toBe('GK')
    const maxSaving = Math.max(...home.squad.filter(p => p.position === 'GK').map(p => p.gkStats!.saving))
    expect(gk.gkStats!.saving).toBe(maxSaving)
  })

  it('buildShootoutParams: UI 선택을 simulateShootout 파라미터로 조립', () => {
    const kickerIds = topPenaltyIds(home)
    const dirs = ['left', 'center', 'right', 'left', 'center'] as const
    const params = buildShootoutParams({ home, away, seed: 5, kickerIds, dirs: [...dirs] })
    expect(params.seed).toBe(5)
    expect(params.homeKickers.map(k => k.player.id)).toEqual(kickerIds)
    expect(params.homeKickers.map(k => k.direction)).toEqual([...dirs])
    expect(params.awayKickers).toEqual(autoAwayKickers(away))
    expect(params.homeGk).toEqual(bestGk(home))
    expect(params.awayGk).toEqual(bestGk(away))
    // 조립된 파라미터가 simulateShootout에서 결정론적으로 승자를 낸다
    const r = simulateShootout(params)
    expect(['home', 'away']).toContain(r.winner)
    expect(r.homeScore).not.toBe(r.awayScore)
  })
})

describe('ShootoutPanel 렌더 스모크', () => {
  it('키커 5슬롯 + 시작 버튼을 렌더한다', () => {
    const { container, getByRole } = render(
      <ShootoutPanel home={home} away={away} seed={3} onDone={() => {}} />,
    )
    expect(container.querySelectorAll('.so-slot')).toHaveLength(5)
    expect(getByRole('button', { name: '승부차기 시작' })).toBeTruthy()
  })
})
