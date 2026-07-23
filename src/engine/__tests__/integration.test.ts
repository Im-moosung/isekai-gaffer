// src/engine/__tests__/integration.test.ts
import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment, applyCommand } from '../simulate'
import { simulateShootout } from '../shootout'
import { makeTestTeam } from '../fixtures/testTeams'

describe('풀 매치 플로우 (하프타임 개입 포함)', () => {
  it('전반 관람 → 하프타임 교체+지시 변경 → 후반 → (무승부 시) 승부차기까지 결정론 유지', () => {
    const run = () => {
      const kor = makeTestTeam('kor', 76), opp = makeTestTeam('opp', 80)
      let st = simulateSegment(createMatch(kor, opp, { seed: 777 }), 45)
      const out = st.home.tactics.lineup.find(l => l.slot === 'CM')!.playerId
      const benchIn = st.home.team.squad.find(p => p.position === 'CM' && !st.home.tactics.lineup.some(l => l.playerId === p.id))!.id
      st = applyCommand(st, 'home', { type: 'sub', out, in: benchIn })
      st = applyCommand(st, 'home', { type: 'instructions', instructions: { lineHeight: 70, pressing: 75, tempo: 65, attackFocus: 'right' } })
      st = simulateSegment(st, 90)
      if (st.score[0] === st.score[1]) {
        const kickers = (t: typeof kor) => t.squad.filter(p => p.position !== 'GK').slice(0, 5).map(p => ({ player: p, direction: 'left' as const }))
        const so = simulateShootout({ seed: 777, homeKickers: kickers(kor), awayKickers: kickers(opp), homeGk: kor.squad.find(p => p.position === 'GK')!, awayGk: opp.squad.find(p => p.position === 'GK')! })
        return { score: st.score, events: st.events.length, so: so.winner }
      }
      return { score: st.score, events: st.events.length, so: null }
    }
    expect(run()).toEqual(run())
  })
})
