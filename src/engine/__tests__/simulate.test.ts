import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment, applyCommand } from '../simulate'
import { makeTestTeam } from '../fixtures/testTeams'

const strong = makeTestTeam('str', 88), weak = makeTestTeam('wea', 62)
const even1 = makeTestTeam('ev1', 78), even2 = makeTestTeam('ev2', 78)

describe('simulateSegment', () => {
  it('결정론: 같은 시드는 같은 결과', () => {
    const run = () => simulateSegment(createMatch(even1, even2, { seed: 123 }), 90)
    const a = run(), b = run()
    expect(a.score).toEqual(b.score)
    expect(a.events).toEqual(b.events)
    expect(a.stats).toEqual(b.stats)
  })
  it('다른 시드는 (대부분) 다른 이벤트 흐름', () => {
    const a = simulateSegment(createMatch(even1, even2, { seed: 1 }), 90)
    const b = simulateSegment(createMatch(even1, even2, { seed: 2 }), 90)
    expect(a.events).not.toEqual(b.events)
  })
  it('스코어는 현실적 범위 (100경기에서 팀당 0~8골)', () => {
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      expect(r.score[0]).toBeLessThanOrEqual(8)
      expect(r.score[1]).toBeLessThanOrEqual(8)
    }
  })
  it('강팀은 약팀에 100경기 중 60승 이상', () => {
    let wins = 0
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(strong, weak, { seed: s }), 90)
      if (r.score[0] > r.score[1]) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(60)
  })
  it('세그먼트 분할과 일괄 진행은 같은 결과 (45+45 = 90)', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 55 }), 90)
    let split = createMatch(even1, even2, { seed: 55 })
    split = simulateSegment(split, 45)
    split = simulateSegment(split, 90)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
  })
  it('체력은 경기 진행에 따라 감소', () => {
    const r = simulateSegment(createMatch(even1, even2, { seed: 9 }), 90)
    const anyStarter = r.home.tactics.lineup[5].playerId
    expect(r.home.staminaByPlayer[anyStarter]).toBeLessThan(85)
  })
})

describe('applyCommand', () => {
  it('교체: out 선수가 라인업에서 빠지고 in 선수가 들어온다', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    const out = st.home.tactics.lineup.find(l => l.slot === 'ST')!.playerId
    const benchIn = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id) && p.position === 'ST')!.id
    st = applyCommand(st, 'home', { type: 'sub', out, in: benchIn })
    expect(st.home.tactics.lineup.some(l => l.playerId === benchIn)).toBe(true)
    expect(st.home.tactics.lineup.some(l => l.playerId === out)).toBe(false)
    expect(st.home.subsUsed).toBe(1)
    expect(st.events.at(-1)).toMatchObject({ type: 'sub', teamId: even1.id })
  })
  it('교체 5회 초과는 에러', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    st = { ...st, home: { ...st.home, subsUsed: 5 } }
    const out = st.home.tactics.lineup[10].playerId
    const sub = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id))!.id
    expect(() => applyCommand(st, 'home', { type: 'sub', out, in: sub })).toThrow()
  })
  it('지시 변경이 이후 시뮬에 반영된다 (맹렬압박 → 파울 증가 경향, 50시드 평균)', () => {
    let foulsHigh = 0, foulsBase = 0
    for (let s = 0; s < 50; s++) {
      const base = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      let pressed = createMatch(even1, even2, { seed: s })
      pressed = applyCommand(pressed, 'home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 95, tempo: 50, attackFocus: 'balanced' } })
      const r = simulateSegment(pressed, 90)
      foulsHigh += r.stats[0].fouls; foulsBase += base.stats[0].fouls
    }
    expect(foulsHigh).toBeGreaterThan(foulsBase * 1.1)
  })
})
