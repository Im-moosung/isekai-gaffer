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
  // IFAB 경기규칙 10.3의 절차를 킥 로그로 검증한다.
  // ① 홈이 먼저, 이후 교대 ② 정규는 팀당 최대 5발 ③ 수학적으로 확정되면 즉시 중단
  // ④ 서든데스는 반드시 짝(홈·어웨이 한 발씩)으로 돌고 그 라운드에서 갈리면 끝난다.
  it('정규 5키커 + 서든데스가 규정대로 돈다 (200시드 전수)', () => {
    for (let s = 0; s < 200; s++) {
      const r = simulateShootout({ seed: s, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
      // ① 교대 순서: 짝수 인덱스 home, 홀수 away
      r.kicks.forEach((k, i) => expect(k.side).toBe(i % 2 === 0 ? 'home' : 'away'))

      let hs = 0, as = 0, h = 0, aw = 0
      let stoppedAt = -1
      r.kicks.forEach((k, i) => {
        if (k.side === 'home') { h++; if (k.scored) hs++ } else { aw++; if (k.scored) as++ }
        if (stoppedAt >= 0) return
        // ③ 이 시점에 이미 확정됐는데 킥이 더 있었다면 규정 위반
        const remHome = Math.max(0, 5 - h), remAway = Math.max(0, 5 - aw)
        const decided = h <= 5 && aw <= 5 && (hs > as + remAway || as > hs + remHome)
        if (decided) stoppedAt = i
      })
      if (stoppedAt >= 0) expect(r.kicks).toHaveLength(stoppedAt + 1)

      // ② 정규 국면(양 팀 5발 이내)을 넘어선 킥은 서든데스뿐이다
      expect(h).toBeLessThanOrEqual(aw + 1)
      // ④ 서든데스에 들어갔다면 홈·어웨이 킥 수가 같고, 마지막 라운드에서 갈렸다
      if (h > 5) {
        expect(h).toBe(aw)
        const lastHome = r.kicks[r.kicks.length - 2]
        const lastAway = r.kicks[r.kicks.length - 1]
        expect(lastHome.side).toBe('home')
        expect(lastAway.side).toBe('away')
        expect(lastHome.scored).not.toBe(lastAway.scored)
      }
      // 정규에서 끝났다면 팀당 5발을 넘지 않는다
      if (h <= 5) { expect(aw).toBeLessThanOrEqual(5) }
      expect(r.homeScore).toBe(hs)
      expect(r.awayScore).toBe(as)
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
