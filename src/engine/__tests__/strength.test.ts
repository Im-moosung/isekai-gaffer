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

describe('morale이 존 전력에 반영된다', () => {
  /** 주전 전원의 사기를 일괄 설정한 사이드. 픽스처 초기 사기는 70이다. */
  const sideWithMorale = (morale: number) => {
    const side = makeSideState(makeTestTeam('t', 80))
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = morale
    return side
  }

  it('사기 70(초기값)이면 배수가 정확히 1.0 — 회귀 불변', () => {
    // 픽스처 기본값이 이미 70이므로, 명시적으로 70을 다시 넣어도 값이 변하면 안 된다.
    const untouched = makeSideState(makeTestTeam('t', 80))
    const explicit70 = sideWithMorale(70)
    expect(zoneStrength(explicit70).attack).toBeCloseTo(zoneStrength(untouched).attack, 10)
    expect(zoneStrength(explicit70).midfield).toBeCloseTo(zoneStrength(untouched).midfield, 10)
    expect(zoneStrength(explicit70).defense).toBeCloseTo(zoneStrength(untouched).defense, 10)
  })

  it('사기가 높으면 존 전력이 오른다', () => {
    expect(zoneStrength(sideWithMorale(100)).attack)
      .toBeGreaterThan(zoneStrength(sideWithMorale(70)).attack)
  })

  it('사기 100은 사기 70 대비 정확히 6% 높다', () => {
    expect(zoneStrength(sideWithMorale(100)).attack / zoneStrength(sideWithMorale(70)).attack)
      .toBeCloseTo(1.06, 6)
  })

  it('사기 40은 사기 70 대비 6% 낮다', () => {
    expect(zoneStrength(sideWithMorale(40)).defense / zoneStrength(sideWithMorale(70)).defense)
      .toBeCloseTo(0.94, 6)
  })

  it('gk 존에는 사기가 적용되지 않는다 — 소비처가 없는 死데이터', () => {
    expect(zoneStrength(sideWithMorale(100)).gk).toBeCloseTo(zoneStrength(sideWithMorale(40)).gk, 10)
  })

  it('벤치·퇴장 선수의 사기는 평균에서 제외된다', () => {
    // 벤치 전원을 0으로 떨어뜨려도 주전만 보므로 전력이 변하지 않아야 한다.
    const side = sideWithMorale(70)
    const benchIds = side.team.squad
      .filter(p => !side.tactics.lineup.some(l => l.playerId === p.id))
      .map(p => p.id)
    const before = zoneStrength(side).midfield
    for (const id of benchIds) side.moraleByPlayer[id] = 0
    expect(zoneStrength(side).midfield).toBeCloseTo(before, 10)

    // 퇴장 선수도 마찬가지. 퇴장 자체가 shortage 페널티를 걸므로,
    // 동일하게 퇴장시킨 대조군(사기 70 유지)과 비교해야 사기 항만 분리된다.
    const control = sideWithMorale(70)
    const stId = side.tactics.lineup.find(l => l.slot === 'ST')!.playerId
    side.sentOff.push(stId); side.moraleByPlayer[stId] = 0
    control.sentOff.push(stId)
    expect(zoneStrength(side).midfield).toBeCloseTo(zoneStrength(control).midfield, 10)
  })
})
