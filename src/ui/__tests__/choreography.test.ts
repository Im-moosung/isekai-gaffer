import { describe, it, expect } from 'vitest'
import type { MatchEvent, MatchEventType } from '../../engine/types'
import { buildSequence, type ChoreoStep } from '../pitch/choreography'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { createMatch } from '../../engine/simulate'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const state = createMatch(home, away, { seed: 42 })

function ev(type: MatchEventType, opts: Partial<MatchEvent> = {}): MatchEvent {
  return { minute: 30, type, teamId: home.id, ...opts }
}

function seq(type: MatchEventType, opts: Partial<MatchEvent> = {}): ChoreoStep[] {
  return buildSequence(ev(type, opts), state.home, state.away)
}

const inRange = (v: number) => v >= 0 && v <= 100

describe('buildSequence — 스텝 수(타입별 2~4)', () => {
  it('goal은 4스텝(빌드업→전진→슛→네트)', () => {
    expect(seq('goal')).toHaveLength(4)
  })
  it('miss·save·shot은 3스텝', () => {
    expect(seq('miss')).toHaveLength(3)
    expect(seq('save')).toHaveLength(3)
    expect(seq('shot')).toHaveLength(3)
  })
  it('corner는 3스텝', () => {
    expect(seq('corner')).toHaveLength(3)
  })
  it('foul은 2스텝(정지 근사)', () => {
    expect(seq('foul')).toHaveLength(2)
  })
  it('모든 타입이 2~4스텝 범위', () => {
    for (const t of ['goal', 'shot', 'save', 'miss', 'corner', 'foul', 'yellow', 'chance'] as MatchEventType[]) {
      const n = seq(t).length
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(4)
    }
  })
})

describe('buildSequence — 데드타임 금지(첫 스텝 t=0, 마지막 t≤0.8)', () => {
  it('모든 타입: 첫 스텝 t=0, t 단조 증가, 마지막 ≤ 0.8', () => {
    for (const t of ['goal', 'shot', 'save', 'miss', 'corner', 'foul'] as MatchEventType[]) {
      const s = seq(t)
      expect(s[0].t).toBe(0)
      for (let i = 1; i < s.length; i++) expect(s[i].t).toBeGreaterThan(s[i - 1].t)
      expect(s[s.length - 1].t).toBeLessThanOrEqual(0.8)
    }
  })
})

describe('buildSequence — 좌표 0~100 내(공·무버)', () => {
  it('모든 타입·양팀: 공·무버 좌표가 범위 내', () => {
    for (const t of ['goal', 'shot', 'save', 'miss', 'corner', 'foul'] as MatchEventType[]) {
      for (const teamId of [home.id, away.id]) {
        for (const step of buildSequence(ev(t, { teamId }), state.home, state.away)) {
          expect(inRange(step.ball.x)).toBe(true)
          expect(inRange(step.ball.y)).toBe(true)
          for (const m of step.movers) {
            expect(inRange(m.x)).toBe(true)
            expect(inRange(m.y)).toBe(true)
          }
        }
      }
    }
  })
})

describe('buildSequence — 결정론(같은 입력 → 같은 출력)', () => {
  it('goal 두 번 호출 결과가 동일', () => {
    expect(seq('goal')).toEqual(seq('goal'))
  })
  it('minute 변형(2~3): 서로 다른 분은 레인이 달라질 수 있다', () => {
    const a = buildSequence(ev('goal', { minute: 30 }), state.home, state.away) // 30%3=0
    const b = buildSequence(ev('goal', { minute: 31 }), state.home, state.away) // 31%3=1
    // 첫 스텝 y(레인)가 변형별로 다르다.
    expect(a[0].ball.y).not.toBe(b[0].ball.y)
  })
})

describe('buildSequence — 공격 방향(home 좌→우, away 우→좌)', () => {
  it('home goal: 공 x가 전진할수록 커진다(→ 우측 골)', () => {
    const s = buildSequence(ev('goal', { teamId: home.id }), state.home, state.away)
    expect(s[s.length - 1].ball.x).toBeGreaterThan(s[0].ball.x)
  })
  it('away goal: 공 x가 전진할수록 작아진다(→ 좌측 골)', () => {
    const s = buildSequence(ev('goal', { teamId: away.id }), state.home, state.away)
    expect(s[s.length - 1].ball.x).toBeLessThan(s[0].ball.x)
  })
  it('home·away goal 네트 x는 서로 미러(합 ≈ 100)', () => {
    const h = buildSequence(ev('goal', { teamId: home.id }), state.home, state.away)
    const a = buildSequence(ev('goal', { teamId: away.id }), state.home, state.away)
    expect(h[3].ball.x + a[3].ball.x).toBeCloseTo(100, 5)
  })
})

describe('buildSequence — 무버 선정', () => {
  it('득점자(playerId)가 무버에 포함된다', () => {
    const scorer = state.home.tactics.lineup[10].playerId
    const s = buildSequence(ev('goal', { playerId: scorer }), state.home, state.away)
    const ids = s[0].movers.map(m => m.playerId)
    expect(ids).toContain(scorer)
  })
  it('무버는 1~3명', () => {
    const s = seq('goal')
    expect(s[0].movers.length).toBeGreaterThanOrEqual(1)
    expect(s[0].movers.length).toBeLessThanOrEqual(3)
  })
})
