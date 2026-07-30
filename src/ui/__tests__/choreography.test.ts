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

// 장면 = 빌드업 스테이션 3개(attackPattern) + 마무리(결과별 1~2개).
//
// ★ 2026-07-30: 스텝 수 계약이 "스테이션 수"에서 "키프레임 수"로 갈라졌다. 저술 단위는
//   여전히 스테이션이지만, 구간 사이에 **컨트롤 정지**(TOUCH_MS)를 넣기 위해 도착·출발
//   키프레임을 한 쌍으로 낸다(같은 볼 좌표를 두 번). 예전 공은 90분 하이라이트 내내
//   한 번도 멈추지 않았고 그것이 "쉼 없이 빠르다"의 정체였다
//   (docs/research/football-sim-physics.md §1.2).
//   그래서 여기서는 **볼이 실제로 이동하는 구간 수**를 센다 — 그게 저술 단위다.
describe('buildSequence — 스텝 수(볼 이동 구간 = 스테이션 - 1)', () => {
  /** 볼이 실제로 움직이는 구간 수(정지 키프레임 쌍은 세지 않는다). */
  function moves(s: ChoreoStep[]): number {
    let n = 0
    for (let i = 0; i + 1 < s.length; i++) {
      if (Math.hypot(s[i + 1].ball.x - s[i].ball.x, s[i + 1].ball.y - s[i].ball.y) > 0.5) n++
    }
    return n
  }
  it('goal·miss·save·shot은 빌드업 2 + 배달 1 + 슛 1 = 4구간', () => {
    for (const t of ['goal', 'miss', 'save', 'shot'] as MatchEventType[]) {
      expect(moves(seq(t)), t).toBe(4)
    }
  })
  it('chance는 마무리가 없다 — 슛 구간이 없다', () => {
    expect(seq('chance').some(s => s.arc === 'shot')).toBe(false)
    expect(moves(seq('chance'))).toBeGreaterThanOrEqual(2)
  })
  it('corner는 세트피스 — 빌드업 없이 2구간', () => {
    expect(moves(seq('corner'))).toBe(2)
  })
  it('foul은 정지 근사(2 키프레임)', () => {
    expect(seq('foul')).toHaveLength(2)
  })
  it('모든 타입이 2~10 키프레임 범위', () => {
    for (const t of ['goal', 'shot', 'save', 'miss', 'corner', 'foul', 'yellow', 'chance'] as MatchEventType[]) {
      const n = seq(t).length
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(10)
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

// ── 안무 없는 타입은 빈 시퀀스(Phase B-1) ────────────────────
// 예전엔 default가 슛 궤적을 돌려줘서 교체·하프타임이 주인공으로 뽑히면
// "말은 교체인데 화면은 슛"이 됐다. 이제 안무가 정의된 타입만 시퀀스를 낸다.
describe('buildSequence — 안무 유무', () => {
  it('kickoff·sub·halftime·fulltime은 빈 배열', () => {
    for (const t of ['kickoff', 'sub', 'halftime', 'fulltime'] as MatchEventType[]) {
      expect(seq(t), `${t}`).toEqual([])
    }
  })

  it('shot·chance는 안무가 있다', () => {
    expect(seq('shot').length).toBeGreaterThanOrEqual(4)
    expect(seq('chance').length).toBeGreaterThanOrEqual(3)
  })

  it('shot은 골문 앞에서 멈춘다(골처럼 네트에 닿지 않는다)', () => {
    const s = seq('shot')
    const g = seq('goal')
    const last = s[s.length - 1].ball.x
    expect(last).toBeGreaterThan(90)
    expect(last).toBeLessThan(g[g.length - 1].ball.x)
  })

  it('chance는 마무리가 없다 — 슛 계열보다 골문에서 멀리 끝난다', () => {
    const c = seq('chance')
    const s = seq('shot')
    expect(c[c.length - 1].ball.x).toBeLessThan(s[s.length - 1].ball.x)
  })

  it('shot·chance도 away면 x가 미러된다', () => {
    for (const t of ['shot', 'chance'] as MatchEventType[]) {
      const h = buildSequence(ev(t, { teamId: home.id }), state.home, state.away)
      const a = buildSequence(ev(t, { teamId: away.id }), state.home, state.away)
      expect(h[h.length - 1].ball.x + a[a.length - 1].ball.x).toBeCloseTo(100, 5)
      expect(a[a.length - 1].ball.x).toBeLessThan(a[0].ball.x)
    }
  })
})
