import { describe, it, expect } from 'vitest'
import { commentate } from '../commentary'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import type { MatchEvent } from '../../engine/types'

const home = makeTestTeam('kor', 78), away = makeTestTeam('opp', 78)
const goal: MatchEvent = { minute: 67, type: 'goal', teamId: 'kor', playerId: home.squad[15].id, xg: 0.3 }

describe('commentate', () => {
  it('골 이벤트에 선수 한글 이름과 분이 들어간다', () => {
    const line = commentate(goal, home, away)
    expect(line).toContain(home.squad[15].name.ko)
    expect(line).toContain('67')
  })
  it('결정론: 같은 이벤트 = 같은 문장', () => {
    expect(commentate(goal, home, away)).toBe(commentate(goal, home, away))
  })
  it('모든 이벤트 타입에 대해 비어있지 않은 문장을 낸다', () => {
    const types: MatchEvent['type'][] = ['kickoff','goal','save','miss','foul','yellow','corner','sub','halftime','fulltime']
    for (const type of types) {
      const line = commentate({ minute: 10, type, teamId: 'kor', playerId: home.squad[3].id }, home, away)
      expect(line.length).toBeGreaterThan(3)
    }
  })
  it('금지 표현이 없다 (세이프가드 스모크)', () => {
    const banned = ['최악', '한심', '형편없', '멍청']
    const types: MatchEvent['type'][] = ['goal','save','miss','foul','yellow','corner']
    for (const type of types) for (let m = 1; m <= 90; m += 7) {
      const line = commentate({ minute: m, type, teamId: 'opp', playerId: away.squad[m % 18].id }, home, away)
      for (const w of banned) expect(line).not.toContain(w)
    }
  })
})
