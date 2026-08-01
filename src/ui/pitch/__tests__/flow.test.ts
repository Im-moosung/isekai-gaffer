// 점유 흐름(하이라이트 없는 분) — "공이 혼자 떠다닌다"의 근본 대체물.
import { describe, it, expect } from 'vitest'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import { tacticalCoords } from '../shape'
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

  // ★ 도트 좌표는 전술 변환(shape.tacticalCoords)을 거친다 — 공이 발밑에 있는지 재려면
  //   포메이션 원형이 아니라 화면에 실제로 그려지는 좌표와 비교해야 한다.
  it('★ 공은 언제나 실제 선수의 발밑에 있다(리사주 금지)', () => {
    for (let m = 1; m <= 90; m++) {
      const { seq, side } = buildFlowSequence(base, m, 42)
      const st = side === 'home' ? base.home : base.away
      const slots = st.tactics.lineup.map((_, i) =>
        tacticalCoords(st.tactics.formation, i, side, st.tactics.instructions))
      for (const step of seq) {
        // 공에서 가장 가까운 라인업 좌표까지 5(0~100 단위) 이내 = 발 앞.
        const d = Math.min(...slots.map(c => Math.hypot(c.x - step.ball.x, c.y - step.ball.y)))
        expect(d, `${m}분`).toBeLessThan(11)
      }
    }
  })

  it('★ 라인을 극단으로 올려도 공은 도트를 따라간다(마커만 뜨는 일 금지)', () => {
    const st = createMatch(home, away, { seed: 42 })
    st.home.tactics.instructions = { ...st.home.tactics.instructions, lineHeight: 95, pressing: 90 }
    st.away.tactics.instructions = { ...st.away.tactics.instructions, lineHeight: 95, pressing: 90 }
    for (let m = 1; m <= 90; m++) {
      const { seq, side } = buildFlowSequence(st, m, 42)
      const s = side === 'home' ? st.home : st.away
      const slots = s.tactics.lineup.map((_, i) =>
        tacticalCoords(s.tactics.formation, i, side, s.tactics.instructions))
      for (const step of seq) {
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

// ─────────────────────────────────────────────────────────────────────────────
// ★ 공격 방향 (2026-08-01 7라운드 피드백 ②)
// 하이라이트는 20~30분뿐이고 나머지 50~60분이 이 점유 흐름이다. 여기가 지시를 무시하면
// "좌측으로 바꿨는데 화면은 그대로"가 경기 시간의 절반 이상 유지된다.
// 좌우의 정본: y가 작을수록 공격 팀의 왼쪽.
// ─────────────────────────────────────────────────────────────────────────────
describe('공격 방향이 점유 흐름에 나타난다', () => {
  const FOCI = ['left', 'center', 'right', 'balanced'] as const
  const SEEDS = [1, 7, 13, 42, 99, 123, 777, 2026]

  /** 홈 점유 분들의 **평균 볼 y 오프셋**(음수 = 왼쪽)과 표본 수. */
  function lateral(focus: (typeof FOCI)[number]) {
    const st = createMatch(home, away, { seed: 42 })
    st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
    const xs: number[] = []
    for (const seed of SEEDS) {
      for (let m = 1; m <= 90; m++) {
        const f = buildFlowSequence(st, m, seed)
        if (f.side !== 'home' || f.seq.length === 0) continue
        xs.push(f.seq.reduce((a, s) => a + s.ball.y - 50, 0) / f.seq.length)
      }
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
    return { mean, se: sd / Math.sqrt(xs.length), n: xs.length }
  }

  it('좌측 지시는 왼쪽으로, 우측 지시는 오른쪽으로 — 차이가 SE의 2배를 훨씬 넘는다', () => {
    const L = lateral('left')
    const R = lateral('right')
    expect(L.n).toBeGreaterThan(300)
    expect(L.mean).toBeLessThan(0)
    expect(R.mean).toBeGreaterThan(0)
    // 판정 가능 기준(프로젝트 규약): 차이 > 2 × 합성 SE.
    const se = Math.hypot(L.se, R.se)
    expect(R.mean - L.mean).toBeGreaterThan(2 * se)
  })

  it('★ 균형은 좌우 대칭이다 — 원형 집합의 기존 좌편향을 접기가 걷어낸다', () => {
    const B = lateral('balanced')
    // 개편 전에는 원형 6종 중 4종이 왼쪽이라 기본값에서도 왼쪽으로 쏠렸다.
    expect(Math.abs(B.mean)).toBeLessThan(2 * B.se + 1)
  })

  it('중앙 지시는 폭을 좁힌다 — 평균 |오프셋|이 좌·우보다 작다', () => {
    const spread = (focus: (typeof FOCI)[number]) => {
      const st = createMatch(home, away, { seed: 42 })
      st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
      let sum = 0
      let n = 0
      for (const seed of SEEDS) {
        for (let m = 1; m <= 90; m++) {
          const f = buildFlowSequence(st, m, seed)
          if (f.side !== 'home' || f.seq.length === 0) continue
          sum += Math.abs(f.seq.reduce((a, s) => a + s.ball.y - 50, 0) / f.seq.length)
          n++
        }
      }
      return sum / n
    }
    expect(spread('center')).toBeLessThan(spread('left'))
    expect(spread('center')).toBeLessThan(spread('right'))
  })

  it('라벨이 화면과 어긋나지 않는다 — 좌우가 접히면 방향 낱말도 따라 접힌다', () => {
    for (const focus of ['left', 'right'] as const) {
      const st = createMatch(home, away, { seed: 42 })
      st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
      for (let m = 1; m <= 90; m++) {
        const f = buildFlowSequence(st, m, 42)
        if (f.side !== 'home' || f.seq.length === 0) continue
        const side = f.seq.reduce((a, s) => a + s.ball.y - 50, 0) / f.seq.length
        if (f.label.startsWith('좌측')) expect(side, `${m}분 ${f.label}`).toBeLessThan(0)
        if (f.label.startsWith('우측')) expect(side, `${m}분 ${f.label}`).toBeGreaterThan(0)
      }
    }
  })

  it('여전히 분마다 전개가 바뀐다 — 지시를 걸어도 그림이 하나로 굳지 않는다', () => {
    for (const focus of FOCI) {
      const st = createMatch(home, away, { seed: 42 })
      st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
      const labels = new Set<string>()
      for (let m = 1; m <= 90; m++) labels.add(buildFlowSequence(st, m, 42).label)
      expect(labels.size, focus).toBeGreaterThanOrEqual(5)
    }
  })
})
