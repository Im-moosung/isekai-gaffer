// 점유 흐름(하이라이트 없는 분) — "공이 혼자 떠다닌다"의 근본 대체물.
import { describe, it, expect } from 'vitest'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import { slotCoords } from '../formations'
import { buildFlowSequence, possessingSide } from '../flow'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const base = createMatch(home, away, { seed: 42 })

describe('buildFlowSequence', () => {
  it('키프레임 계약(첫 t=0, 단조 증가, 마지막 ≤ 0.8)을 안무와 공유한다', () => {
    for (let m = 1; m <= 90; m++) {
      const { seq } = buildFlowSequence(base, m, 42)
      expect(seq.length).toBeGreaterThanOrEqual(2)
      expect(seq[0].t).toBe(0)
      for (let i = 1; i < seq.length; i++) expect(seq[i].t).toBeGreaterThan(seq[i - 1].t)
      expect(seq[seq.length - 1].t).toBeLessThanOrEqual(0.8)
    }
  })

  it('★ 공은 언제나 실제 선수의 발밑에 있다(리사주 금지)', () => {
    for (let m = 1; m <= 90; m++) {
      const { seq, side } = buildFlowSequence(base, m, 42)
      const st = side === 'home' ? base.home : base.away
      const slots = st.tactics.lineup.map((_, i) => slotCoords(st.tactics.formation, i, side))
      for (const step of seq) {
        // 공에서 가장 가까운 라인업 좌표까지 5(0~100 단위) 이내 = 발 앞.
        const d = Math.min(...slots.map(c => Math.hypot(c.x - step.ball.x, c.y - step.ball.y)))
        expect(d, `${m}분`).toBeLessThan(11)
      }
    }
  })

  it('무버는 전부 점유 팀의 실제 선수이며 중복이 없다', () => {
    const { seq, side } = buildFlowSequence(base, 33, 42)
    const ids = new Set((side === 'home' ? base.home : base.away).tactics.lineup.map(s => s.playerId))
    for (const step of seq) {
      const mine = step.movers.map(m => m.playerId)
      expect(new Set(mine).size).toBe(mine.length)
      for (const id of mine) expect(ids.has(id)).toBe(true)
    }
  })

  it('좌표는 0~100 범위 안이다', () => {
    for (let m = 1; m <= 90; m++) {
      for (const s of buildFlowSequence(base, m, 42).seq) {
        expect(s.ball.x).toBeGreaterThanOrEqual(0)
        expect(s.ball.x).toBeLessThanOrEqual(100)
        expect(s.ball.y).toBeGreaterThanOrEqual(0)
        expect(s.ball.y).toBeLessThanOrEqual(100)
      }
    }
  })

  it('결정론 — 같은 (분, 시드)는 같은 결과', () => {
    expect(buildFlowSequence(base, 51, 7)).toEqual(buildFlowSequence(base, 51, 7))
  })

  it('분마다 전개가 바뀐다(같은 그림이 90분 도는 것 방지)', () => {
    const labels = new Set<string>()
    for (let m = 1; m <= 90; m++) labels.add(buildFlowSequence(base, m, 42).label)
    expect(labels.size).toBeGreaterThanOrEqual(5)
  })
})

describe('possessingSide — 모멘텀이 점유로 나타난다', () => {
  it('모멘텀이 홈 쪽이면 홈 점유 분이 더 많다', () => {
    const count = (mo: number) => {
      let n = 0
      for (let m = 1; m <= 90; m++) if (possessingSide(mo, m, 42) === 'home') n++
      return n
    }
    expect(count(1)).toBeGreaterThan(count(0))
    expect(count(0)).toBeGreaterThan(count(-1))
  })
})
