import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment, applyCommand } from '../simulate'
import { makeTestTeam, pickBestXI } from '../fixtures/testTeams'
import { loadTeam } from '../../data/loader'

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

describe('firstHalfScript (조별 실제 전반 재현)', () => {
  const script = {
    events: [
      { minute: 44, type: 'goal', teamId: even1.id, playerId: 'p_ev1_20', xg: 0.3 },
      { minute: 12, type: 'foul', teamId: even2.id, playerId: 'p_ev2_02' },
    ] as any,
    score: [1, 0] as [number, number],
  }

  it('simulateSegment(45)는 스크립트를 적용한다: score·events·minute 고정, 시뮬 이벤트 미발생', () => {
    const st = simulateSegment(createMatch(even1, even2, { seed: 7, firstHalfScript: script }), 45)
    expect(st.minute).toBe(45)
    expect(st.score).toEqual([1, 0])
    // 스크립트 이벤트가 분 순서로 포함
    expect(st.events.some(e => e.type === 'goal' && e.minute === 44)).toBe(true)
    expect(st.events.some(e => e.type === 'foul' && e.minute === 12)).toBe(true)
    // 이벤트는 kickoff + 스크립트(분순) + halftime 만 존재 (시뮬 shot/save/miss 등 없음)
    const types = st.events.map(e => e.type)
    expect(types).toEqual(['kickoff', 'foul', 'goal', 'halftime'])
    // stats: baseline 절반 근사 (xG = 골 수 × 0.35)
    expect(st.stats[0].xg).toBeCloseTo(0.35, 5)
    expect(st.stats[1].xg).toBe(0)
    expect(st.stats[0].shots).toBe(Math.round(even1.statBaseline.shotsPerGame * 0.5))
  })

  it('후반 결정론: 같은 시드·스크립트 → 같은 후반 결과', () => {
    const run = () => simulateSegment(createMatch(even1, even2, { seed: 42, firstHalfScript: script }), 90)
    const a = run(), b = run()
    expect(a.score).toEqual(b.score)
    expect(a.events).toEqual(b.events)
    expect(a.stats).toEqual(b.stats)
  })

  it('45 분할: (30→45)과 (직접 45)이 동일한 전반 결과', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 7, firstHalfScript: script }), 45)
    let split = createMatch(even1, even2, { seed: 7, firstHalfScript: script })
    split = simulateSegment(split, 30)
    expect(split.minute).toBe(30)
    expect(split.events.map(e => e.type)).toEqual(['kickoff']) // 30분 시점엔 스크립트 미적용
    split = simulateSegment(split, 45)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
    expect(split.stats).toEqual(whole.stats)
  })

  it('30→90 분할이 직접 90과 동일 (전·후반 통합 결정론)', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 99, firstHalfScript: script }), 90)
    let split = createMatch(even1, even2, { seed: 99, firstHalfScript: script })
    split = simulateSegment(split, 30)
    split = simulateSegment(split, 90)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
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

// ── 개입 부스트는 지시값과 무관하게 항상 유리해야 한다 ──────────────
// 구 설계 amp(v)=1+(v−1)×1.3은 지시가 중립이면 무효과였고, 저압박·저라인 플랜에서는
// 1.0 미만 편차까지 증폭해 오히려 손해였다(감사 실측: 스페인전 −3.0pp).
// 실팀 데이터로 두 결함을 회귀 고정한다.
describe('개입 부스트는 지시값과 무관하게 항상 유리하다', () => {
  it('중립 지시에서도 부스트가 득점을 늘린다', () => {
    const home = loadTeam('kor'), away = loadTeam('cze')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }
    let boosted = 0, plain = 0
    for (let s = 0; s < 120; s++) {
      let a = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      plain += a.score[0]
      let b = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      boosted += b.score[0]
    }
    expect(boosted).toBeGreaterThan(plain)
  }, 120_000)

  it('저압박·저라인 플랜에서도 부스트가 역효과를 내지 않는다', () => {
    const home = loadTeam('kor'), away = loadTeam('esp')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' }
    let bw = 0, pw = 0
    for (let s = 0; s < 150; s++) {
      let a = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      if (a.score[0] > a.score[1]) pw++
      let b = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      if (b.score[0] > b.score[1]) bw++
    }
    expect(bw).toBeGreaterThanOrEqual(pw)
  }, 150_000)
})

// ── 플랜 유지 보너스 / 구조 변경 적응 지연 (Task 7) ────────────────
// 킥오프 전 설계에 게임 이론적 의미를 주는 두 축이다. 유지에 보상, 구조 변경에 비용.
describe('planIntact / adaptLag', () => {
  it('opts 미지정이면 기존 결과와 비트 단위로 동일(회귀 불변)', () => {
    for (const seed of [11, 222, 3333]) {
      const a = simulateSegment(createMatch(even1, even2, { seed }), 90)
      const b = simulateSegment(createMatch(even1, even2, { seed }), 90, {})
      expect(b.score).toEqual(a.score)
      expect(b.stats).toEqual(a.stats)
    }
  })

  it('planIntact는 지정한 쪽의 xG를 올린다(찬스 퀄리티 ×1.03)', () => {
    let plain = 0, intact = 0
    for (let s = 0; s < 200; s++) {
      plain += simulateSegment(createMatch(even1, even2, { seed: 7000 + s }), 90).stats[0].xg
      intact += simulateSegment(createMatch(even1, even2, { seed: 7000 + s }), 90, { planIntact: 'home' }).stats[0].xg
    }
    expect(intact).toBeGreaterThan(plain)
  })

  it('adaptLag는 만료 분까지만 걸린다 — 만료 후 분에는 영향이 없다', () => {
    // 45분까지 이미 만료된 지연(until=3)은 46~90분 세그먼트 결과를 바꾸지 않아야 한다.
    const base = simulateSegment(createMatch(even1, even2, { seed: 4242 }), 45)
    const a = simulateSegment(base, 90)
    const b = simulateSegment(base, 90, { adaptLag: { side: 'home', until: 3 } })
    expect(b.score).toEqual(a.score)
    expect(b.stats).toEqual(a.stats)
  })

  it('adaptLag는 지정한 쪽의 슛 수를 줄인다(찬스 빈도 ×0.94)', () => {
    let plain = 0, lagged = 0
    for (let s = 0; s < 200; s++) {
      plain += simulateSegment(createMatch(even1, even2, { seed: 8000 + s }), 90).stats[0].shots
      lagged += simulateSegment(createMatch(even1, even2, { seed: 8000 + s }), 90, { adaptLag: { side: 'home', until: 90 } }).stats[0].shots
    }
    expect(lagged).toBeLessThan(plain)
  })
})
