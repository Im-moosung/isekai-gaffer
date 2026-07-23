// src/engine/__tests__/shootout.test.ts
import { describe, it, expect } from 'vitest'
import { simulateShootout, type ShootoutKicker } from '../shootout'
import { makeTestTeam } from '../fixtures/testTeams'

const a = makeTestTeam('a', 80), b = makeTestTeam('b', 80)
const kickers = (t: ReturnType<typeof makeTestTeam>): ShootoutKicker[] =>
  t.squad.filter(p => p.position !== 'GK').slice(0, 5).map((p, i) => ({ player: p, direction: (['left','center','right'] as const)[i % 3] }))
const gk = (t: ReturnType<typeof makeTestTeam>) => t.squad.find(p => p.position === 'GK')!

describe('simulateShootout', () => {
  it('결정론: 같은 시드 같은 결과', () => {
    const run = () => simulateShootout({ seed: 7, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
    expect(run()).toEqual(run())
  })
  it('승자가 반드시 결정된다 (동점 없음, 100시드)', () => {
    for (let s = 0; s < 100; s++) {
      const r = simulateShootout({ seed: s, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
      expect(r.homeScore).not.toBe(r.awayScore)
      expect(['home', 'away']).toContain(r.winner)
    }
  })
  it('GK가 키커 방향을 맞히면 세이브 확률이 크게 오른다 (통계 검증)', () => {
    let savedWhenGuessed = 0, savedWhenWrong = 0, guessed = 0, wrong = 0
    for (let s = 0; s < 300; s++) {
      const r = simulateShootout({ seed: s, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
      for (const k of r.kicks) {
        const kicker = [...kickers(a), ...kickers(b)].find(x => x.player.id === k.playerId)
        if (!kicker) continue
        if (k.gkDove === kicker.direction) { guessed++; if (!k.scored) savedWhenGuessed++ }
        else { wrong++; if (!k.scored) savedWhenWrong++ }
      }
    }
    expect(savedWhenGuessed / guessed).toBeGreaterThan((savedWhenWrong / wrong) * 2)
  })
})
