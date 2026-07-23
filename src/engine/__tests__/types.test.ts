// src/engine/__tests__/types.test.ts
import { describe, it, expect } from 'vitest'
import { makeTestTeam } from '../fixtures/testTeams'

describe('makeTestTeam', () => {
  it('18인 스쿼드, GK 2명, 필드 스탯/GK 스탯 분리', () => {
    const t = makeTestTeam('alpha', 80)
    expect(t.squad).toHaveLength(18)
    const gks = t.squad.filter(p => p.position === 'GK')
    expect(gks).toHaveLength(2)
    gks.forEach(gk => { expect(gk.gkStats).toBeDefined(); expect(gk.stats).toBeUndefined() })
    t.squad.filter(p => p.position !== 'GK').forEach(p => expect(p.stats).toBeDefined())
  })
  it('tierPower가 능력치에 반영된다', () => {
    const strong = makeTestTeam('s', 88), weak = makeTestTeam('w', 62)
    const avg = (t: ReturnType<typeof makeTestTeam>) => {
      const fs = t.squad.filter(p => p.stats).map(p => p.stats!)
      return fs.reduce((s, x) => s + x.shooting + x.passing + x.defending, 0) / fs.length
    }
    expect(avg(strong)).toBeGreaterThan(avg(weak) + 30)
  })
  it('4-3-3 선발 11인을 구성할 수 있는 포지션 분포', () => {
    const t = makeTestTeam('alpha', 80)
    const need: Array<[string, number]> = [['GK',1],['CB',2],['LB',1],['RB',1],['CM',2],['DM',1],['LW',1],['RW',1],['ST',1]]
    for (const [pos, n] of need) {
      const have = t.squad.filter(p => p.position === pos || p.altPositions.includes(pos as never)).length
      expect(have).toBeGreaterThanOrEqual(n)
    }
  })
})
