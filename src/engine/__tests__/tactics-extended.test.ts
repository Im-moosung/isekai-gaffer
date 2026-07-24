import { describe, it, expect } from 'vitest'
import {
  mentalityEffects, attackPatternEffects,
  groupIntensityZoneFactor, groupIntensityStaminaFactor, phaseTilt,
} from '../tactics'
import { zoneStrength } from '../strength'
import { createMatch, simulateSegment } from '../simulate'
import { makeTestTeam, makeSideState } from '../fixtures/testTeams'
import type { MatchState, TacticState } from '../types'

const A = makeTestTeam('a', 78), B = makeTestTeam('b', 78)

// ── 순수 배수 헬퍼: 방향 + 기본값 항등 ────────────────────────────
describe('mentalityEffects', () => {
  it('balanced는 전 축 정확히 1.0 (회귀 항등)', () => {
    const m = mentalityEffects('balanced')
    expect(m.chanceRate).toBe(1.0)
    expect(m.chanceQuality).toBe(1.0)
    expect(m.counterVulnerability).toBe(1.0)
    expect(m.possessionBias).toBe(1.0)
  })
  it('공격적일수록 찬스 빈도·역습 취약성↑, 수비적일수록↓ (단조)', () => {
    const vd = mentalityEffects('very-defensive'), d = mentalityEffects('defensive')
    const b = mentalityEffects('balanced')
    const at = mentalityEffects('attacking'), va = mentalityEffects('very-attacking')
    expect(vd.chanceRate).toBeLessThan(d.chanceRate)
    expect(d.chanceRate).toBeLessThan(b.chanceRate)
    expect(b.chanceRate).toBeLessThan(at.chanceRate)
    expect(at.chanceRate).toBeLessThan(va.chanceRate)
    // 리스크: 공격적일수록 역습 취약성도 커진다
    expect(va.counterVulnerability).toBeGreaterThan(b.counterVulnerability)
    expect(vd.counterVulnerability).toBeLessThan(b.counterVulnerability)
  })
})

describe('attackPatternEffects', () => {
  it('balanced는 전 축 1.0 (회귀 항등)', () => {
    const p = attackPatternEffects('balanced')
    expect(p.chanceRate).toBe(1.0); expect(p.chanceQuality).toBe(1.0)
    expect(p.cornerBias).toBe(1.0); expect(p.onTargetBias).toBe(1.0)
  })
  it('중거리(longshot)=빈도↑ 퀄↓, 중앙침투(through)=퀄↑ 빈도↓, 크로스(cross)=코너↑', () => {
    const ls = attackPatternEffects('longshot')
    expect(ls.chanceRate).toBeGreaterThan(1.0)
    expect(ls.chanceQuality).toBeLessThan(1.0)
    const th = attackPatternEffects('through')
    expect(th.chanceQuality).toBeGreaterThan(1.0)
    expect(th.chanceRate).toBeLessThan(1.0)
    const cr = attackPatternEffects('cross')
    expect(cr.cornerBias).toBeGreaterThan(1.0)
    expect(cr.onTargetBias).toBeLessThan(1.0)
  })
})

describe('groupIntensity 배수', () => {
  it('존 전력: +1 > 0(=1.0) > -1', () => {
    const gi = { attack: 1, midfield: 0, defense: -1 } as const
    expect(groupIntensityZoneFactor(gi, 'attack')).toBeGreaterThan(1.0)
    expect(groupIntensityZoneFactor(gi, 'midfield')).toBe(1.0)
    expect(groupIntensityZoneFactor(gi, 'defense')).toBeLessThan(1.0)
    expect(groupIntensityZoneFactor(undefined, 'attack')).toBe(1.0)
  })
  it('체력 소모: 전부 0이면 1.0, 적극 라인이 많을수록 증가', () => {
    expect(groupIntensityStaminaFactor(undefined)).toBe(1.0)
    expect(groupIntensityStaminaFactor({ attack: 0, midfield: 0, defense: 0 })).toBe(1.0)
    expect(groupIntensityStaminaFactor({ attack: 1, midfield: 1, defense: 1 })).toBeGreaterThan(1.0)
    expect(groupIntensityStaminaFactor({ attack: 1, midfield: 1, defense: 1 }))
      .toBeGreaterThan(groupIntensityStaminaFactor({ attack: 1, midfield: 0, defense: 0 }))
  })
})

describe('phaseTilt (페이즈 포메이션)', () => {
  it('미지정 페이즈면 1.0 (회귀 항등)', () => {
    expect(phaseTilt(undefined, 'attack', 'attack')).toBe(1.0)
    expect(phaseTilt({}, 'attack', 'attack')).toBe(1.0)
    expect(phaseTilt({ defense: '5-4-1' }, 'attack', 'attack')).toBe(1.0) // attack 페이즈 미지정
  })
  it('공격 페이즈에 공격 포메이션 → attack↑ defense↓', () => {
    const pf = { attack: '3-5-2' as const }
    expect(phaseTilt(pf, 'attack', 'attack')).toBeGreaterThan(1.0)
    expect(phaseTilt(pf, 'attack', 'defense')).toBeLessThan(1.0)
  })
  it('수비 페이즈에 수비 포메이션 → defense↑ attack↓', () => {
    const pf = { defense: '5-4-1' as const }
    expect(phaseTilt(pf, 'defense', 'defense')).toBeGreaterThan(1.0)
    expect(phaseTilt(pf, 'defense', 'attack')).toBeLessThan(1.0)
  })
})

// ── zoneStrength 통합: phase·groupIntensity ───────────────────────
describe('zoneStrength(phase, groupIntensity)', () => {
  it('기본 전술은 phase 유무와 무관하게 동일 (회귀 불변)', () => {
    const side = makeSideState(makeTestTeam('t', 80))
    const neutral = zoneStrength(side)
    expect(zoneStrength(side, 'attack')).toEqual(neutral)
    expect(zoneStrength(side, 'defense')).toEqual(neutral)
  })
  it('groupIntensity 공격 +1이 공격 존 전력을 올린다', () => {
    const side = makeSideState(makeTestTeam('t', 80))
    const before = zoneStrength(side).attack
    side.tactics.groupIntensity = { attack: 1, midfield: 0, defense: 0 }
    expect(zoneStrength(side).attack).toBeGreaterThan(before)
  })
  it('공격 페이즈 포메이션(공격형)이 공격 존↑', () => {
    const side = makeSideState(makeTestTeam('t', 80))
    const before = zoneStrength(side, 'attack').attack
    side.tactics.phaseFormations = { attack: '3-5-2' }
    expect(zoneStrength(side, 'attack').attack).toBeGreaterThan(before)
  })
})

// ── 시드 회귀 불변: 기본값 명시 == 생략 ───────────────────────────
describe('기본값 시드 회귀 불변', () => {
  it('신규 필드를 기본값으로 명시해도 events·score·stats 완전 동일', () => {
    const plain = simulateSegment(createMatch(A, B, { seed: 12345 }), 90)
    // 홈 전술에 기본값을 전부 명시한 tactics로 재실행
    const base = createMatch(A, B, { seed: 12345 })
    const withDefaults: TacticState = {
      ...base.home.tactics,
      mentality: 'balanced',
      attackPattern: 'balanced',
      groupIntensity: { attack: 0, midfield: 0, defense: 0 },
      gkPowerplay: false,
      phaseFormations: {},
    }
    const explicit = simulateSegment(
      createMatch(A, B, { seed: 12345, homeTactics: withDefaults, awayTactics: { ...base.away.tactics, mentality: 'balanced', attackPattern: 'balanced', groupIntensity: { attack: 0, midfield: 0, defense: 0 }, gkPowerplay: false } }),
      90,
    )
    expect(explicit.score).toEqual(plain.score)
    expect(explicit.events).toEqual(plain.events)
    expect(explicit.stats).toEqual(plain.stats)
  })
  it('opts 없는 호출과 빈 opts 호출이 동일', () => {
    const a = simulateSegment(createMatch(A, B, { seed: 55 }), 90)
    const b = simulateSegment(createMatch(A, B, { seed: 55 }), 90, {})
    expect(a.events).toEqual(b.events)
    expect(a.score).toEqual(b.score)
  })
})

// ── 멘탈리티·공격패턴 시뮬 방향 ───────────────────────────────────
const withHome = (patch: Partial<TacticState>) => {
  const base = createMatch(A, B, { seed: 0 })
  return (seed: number) => {
    const m = createMatch(A, B, { seed, homeTactics: { ...base.home.tactics, ...patch } })
    return simulateSegment(m, 90)
  }
}

describe('멘탈리티 시뮬 효과 방향', () => {
  it('very-attacking 홈이 very-defensive 홈보다 슛이 많다 (60시드 합)', () => {
    const atk = withHome({ mentality: 'very-attacking' })
    const def = withHome({ mentality: 'very-defensive' })
    let atkShots = 0, defShots = 0
    for (let s = 0; s < 60; s++) { atkShots += atk(s).stats[0].shots; defShots += def(s).stats[0].shots }
    expect(atkShots).toBeGreaterThan(defShots)
  })
})

describe('공격 패턴 시뮬 효과 방향', () => {
  it('longshot는 balanced보다 슛↑ 이지만 슛당 xG↓', () => {
    const ls = withHome({ attackPattern: 'longshot' })
    const bal = withHome({ attackPattern: 'balanced' })
    let lsShots = 0, lsXg = 0, balShots = 0, balXg = 0
    for (let s = 0; s < 60; s++) {
      const r1 = ls(s), r2 = bal(s)
      lsShots += r1.stats[0].shots; lsXg += r1.stats[0].xg
      balShots += r2.stats[0].shots; balXg += r2.stats[0].xg
    }
    expect(lsShots).toBeGreaterThan(balShots)
    // 슛당 xG(효율)는 longshot이 더 낮다
    expect(lsXg / lsShots).toBeLessThan(balXg / balShots)
  })
  it('cross는 balanced보다 코너가 많다 (60시드 합)', () => {
    const cr = withHome({ attackPattern: 'cross' })
    const bal = withHome({ attackPattern: 'balanced' })
    let crC = 0, balC = 0
    for (let s = 0; s < 60; s++) { crC += cr(s).stats[0].corners; balC += bal(s).stats[0].corners }
    expect(crC).toBeGreaterThan(balC)
  })
})

// ── 지속 압박 페널티: 누적 + 저체력 반전 ──────────────────────────
describe('지속 압박 페널티', () => {
  it('압박 70+ 유지 시 sustainedPressMinutes가 누적되고, <70이면 0으로 리셋', () => {
    const base = createMatch(A, B, { seed: 7 })
    const high = createMatch(A, B, { seed: 7, homeTactics: { ...base.home.tactics, instructions: { ...base.home.tactics.instructions, pressing: 90 } } })
    const r = simulateSegment(high, 90)
    expect(r.home.sustainedPressMinutes!).toBeGreaterThan(40) // 후반 내내 누적
    // 압박 60(<70)이면 카운터는 0
    const low = createMatch(A, B, { seed: 7, homeTactics: { ...base.home.tactics, instructions: { ...base.home.tactics.instructions, pressing: 60 } } })
    expect(simulateSegment(low, 90).home.sustainedPressMinutes).toBe(0)
  })
  it('지속 압박(90)은 체력을 더 많이 소모한다 (10분 가중 누적)', () => {
    const base = createMatch(A, B, { seed: 7 })
    const line = base.home.tactics.lineup[5].playerId
    // 압박 90(지속 가중) vs 압박 69(임계 미만, 가중 없음)
    const high = simulateSegment(createMatch(A, B, { seed: 7, homeTactics: { ...base.home.tactics, instructions: { ...base.home.tactics.instructions, pressing: 90 } } }), 90)
    const justBelow = simulateSegment(createMatch(A, B, { seed: 7, homeTactics: { ...base.home.tactics, instructions: { ...base.home.tactics.instructions, pressing: 69 } } }), 90)
    expect(high.home.staminaByPlayer[line]).toBeLessThan(justBelow.home.staminaByPlayer[line])
  })
  it('저체력 반전: 지친 상태(체력<55)로 압박 70+면 파울이 늘어난다 (동일 압박, 체력만 대비)', () => {
    const drainTo = (st: MatchState, v: number) => {
      for (const l of st.home.tactics.lineup) st.home.staminaByPlayer[l.playerId] = v
    }
    let tiredFouls = 0, freshFouls = 0
    for (let s = 0; s < 40; s++) {
      const base = createMatch(A, B, { seed: s, homeTactics: undefined })
      const ins = { ...base.home.tactics.instructions, pressing: 80 }
      const tired = createMatch(A, B, { seed: s, homeTactics: { ...base.home.tactics, instructions: ins } })
      drainTo(tired, 40) // 지침(<55) → 실효 반감 + 파울 1.5배
      const fresh = createMatch(A, B, { seed: s, homeTactics: { ...base.home.tactics, instructions: ins } })
      drainTo(fresh, 100) // 팔팔함 → 페널티 없음
      // 짧은 구간(체력 회복 없음 가정)에서 파울 집계
      tiredFouls += simulateSegment(tired, 20).stats[0].fouls
      freshFouls += simulateSegment(fresh, 20).stats[0].fouls
    }
    expect(tiredFouls).toBeGreaterThan(freshFouls)
  })
})

// ── GK 파워플레이 양면 효과 ───────────────────────────────────────
describe('GK 파워플레이 (85\'+ & 지는 중)', () => {
  // 84분까지 진행 후 스코어를 강제로 [0,1](홈 지는 중)로 맞추고 마지막 6분을 대조.
  function lastStretch(seed: number, homePowerplay: boolean) {
    let st = simulateSegment(createMatch(A, B, { seed }), 84)
    st = structuredClone(st)
    st.score = [0, 1]; st.momentum = 0
    const homeXg84 = st.stats[0].xg
    st.home.tactics = { ...st.home.tactics, gkPowerplay: homePowerplay }
    const r = simulateSegment(st, 90)
    const late = r.events.filter(e => e.minute >= 85 && e.type === 'goal')
    return {
      homeXgDelta: r.stats[0].xg - homeXg84, // 홈 찬스 퀄(+40%) 신호
      awayGoals: late.filter(e => e.teamId === B.id).length,
    }
  }
  it('공격 측: 파워플레이 시 지는 홈의 막판 찬스 퀄(xG)이 커진다 (+40%)', () => {
    let on = 0, off = 0
    for (let s = 0; s < 80; s++) { on += lastStretch(s, true).homeXgDelta; off += lastStretch(s, false).homeXgDelta }
    expect(on).toBeGreaterThan(off)
  })
  it('수비 측(빈 골문): 파워플레이 시 상대의 막판 역습 득점도 늘어난다 (도박의 대가)', () => {
    let on = 0, off = 0
    for (let s = 0; s < 80; s++) { on += lastStretch(s, true).awayGoals; off += lastStretch(s, false).awayGoals }
    expect(on).toBeGreaterThan(off)
  })
  it('조건 미충족(지고 있지 않으면)이면 파워플레이 효과 없음', () => {
    // 홈이 크게 이기는 중([3,0]) → 막판 6분 어떤 결과에도 홈은 지지 않음 → 파워플레이 미발동.
    const winStretch = (seed: number, pp: boolean) => {
      let st = simulateSegment(createMatch(A, B, { seed }), 84)
      st = structuredClone(st)
      st.score = [3, 0]; st.momentum = 0
      st.home.tactics = { ...st.home.tactics, gkPowerplay: pp }
      return simulateSegment(st, 90)
    }
    for (let s = 0; s < 20; s++) {
      const on = winStretch(s, true), off = winStretch(s, false)
      expect(on.events).toEqual(off.events)
      expect(on.score).toEqual(off.score)
    }
  })
})

// ── 개입 부스트 (simulateSegment opts) ────────────────────────────
describe('개입 부스트 ×1.3', () => {
  const attackingHome = (seed: number, boost: boolean) => {
    const base = createMatch(A, B, { seed })
    const m = createMatch(A, B, { seed, homeTactics: { ...base.home.tactics, instructions: { ...base.home.tactics.instructions, tempo: 90, pressing: 65 } } })
    return simulateSegment(m, 90, boost ? { instructionBoost: { side: 'home', until: 90 } } : undefined)
  }
  it('부스트는 공격 지향 홈의 찬스 빈도를 키운다 (60시드 합)', () => {
    let on = 0, off = 0
    for (let s = 0; s < 60; s++) { on += attackingHome(s, true).stats[0].shots; off += attackingHome(s, false).stats[0].shots }
    expect(on).toBeGreaterThan(off)
  })
  it('until 이전 분만 부스트: 균형 지시(1.0)엔 부스트가 무영향 (증폭 대상 없음)', () => {
    const base = createMatch(A, B, { seed: 3 })
    const balanced = { ...base.home.tactics, instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' as const } }
    const on = simulateSegment(createMatch(A, B, { seed: 3, homeTactics: balanced }), 90, { instructionBoost: { side: 'home', until: 90 } })
    const off = simulateSegment(createMatch(A, B, { seed: 3, homeTactics: balanced }), 90)
    expect(on.events).toEqual(off.events)
  })
})
