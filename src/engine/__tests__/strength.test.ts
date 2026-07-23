// src/engine/__tests__/strength.test.ts
import { describe, it, expect } from 'vitest'
import { zoneStrength } from '../strength'
import { makeTestTeam } from '../fixtures/testTeams'
import { makeSideState } from '../fixtures/testTeams'

describe('zoneStrength', () => {
  it('강팀이 약팀보다 전 존에서 우세', () => {
    const s = makeSideState(makeTestTeam('s', 88)), w = makeSideState(makeTestTeam('w', 62))
    const zs = zoneStrength(s), zw = zoneStrength(w)
    expect(zs.attack).toBeGreaterThan(zw.attack)
    expect(zs.defense).toBeGreaterThan(zw.defense)
    expect(zs.gk).toBeGreaterThan(zw.gk)
  })
  it('공격수를 CB에 배치하면 defense가 유의하게 하락', () => {
    const team = makeTestTeam('t', 80)
    const normal = makeSideState(team)
    const swapped = makeSideState(team)
    const st = team.squad.find(p => p.position === 'ST')!
    const cbSlot = swapped.tactics.lineup.find(l => l.slot === 'CB')!
    cbSlot.playerId = st.id
    expect(zoneStrength(swapped).defense).toBeLessThan(zoneStrength(normal).defense * 0.9)
  })
  it('퇴장 선수는 전력에서 제외된다', () => {
    const side = makeSideState(makeTestTeam('t', 80))
    const stSlot = side.tactics.lineup.find(l => l.slot === 'ST')!
    const before = zoneStrength(side).attack
    side.sentOff.push(stSlot.playerId)
    expect(zoneStrength(side).attack).toBeLessThan(before)
  })
})
