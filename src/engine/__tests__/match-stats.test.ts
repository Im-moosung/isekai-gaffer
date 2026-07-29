// src/engine/__tests__/match-stats.test.ts
// 표시 스탯의 두 계약을 고정한다.
//  (1) xG는 '찬스 퀄 지수'가 아니라 **모델 자신의 P(골|슛)** 이다 → 슛당 현실 스케일이고,
//      경기당 xG가 경기당 실제 득점과 붙는다.
//  (2) 패스 성공률은 엔진이 실제로 집계하며, 기본 지시에서는 팀 실측 베이스라인에 수렴하고
//      템포·상대 압박에 반응한다.
import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment } from '../simulate'
import { loadTeam, type TeamId } from '../../data/loader'
import type { Instructions, MatchState } from '../types'

const MATCHUPS: [TeamId, TeamId][] = [
  ['kor', 'esp'], ['esp', 'kor'], ['kor', 'rsa'], ['esp', 'arg'], ['kor', 'cze'],
]

/** n경기 배치 후 [홈, 원정]의 합계 스탯. */
function batch(h: TeamId, a: TeamId, n: number, mutate?: (st: MatchState) => void) {
  const home = loadTeam(h), away = loadTeam(a)
  const acc = [0, 1].map(() => ({ shots: 0, xg: 0, goals: 0, pa: 0, pc: 0 }))
  for (let i = 0; i < n; i++) {
    let st = createMatch(home, away, { seed: 1000 + i })
    mutate?.(st)
    st = simulateSegment(st, 90)
    for (const idx of [0, 1] as const) {
      acc[idx].shots += st.stats[idx].shots
      acc[idx].xg += st.stats[idx].xg
      acc[idx].goals += st.score[idx]
      acc[idx].pa += st.stats[idx].passesAttempted
      acc[idx].pc += st.stats[idx].passesCompleted
    }
  }
  return acc.map(s => ({
    xgPerShot: s.xg / s.shots,
    xgPerGame: s.xg / n,
    goalsPerGame: s.goals / n,
    passAccuracy: (100 * s.pc) / s.pa,
  }))
}

describe('xG 현실성', () => {
  it.each(MATCHUPS)('%s-%s: 슛당 xG가 실제 축구 범위(0.06~0.15)에 든다', (h, a) => {
    const r = batch(h, a, 120)
    for (const side of r) {
      expect(side.xgPerShot, `${h}-${a} ${side.xgPerShot.toFixed(3)}`).toBeGreaterThan(0.06)
      expect(side.xgPerShot, `${h}-${a} ${side.xgPerShot.toFixed(3)}`).toBeLessThan(0.15)
    }
  })

  // 이것이 xG를 P(골|슛)으로 정의한 진짜 이유다 — 상수배 변환으로는 얻을 수 없는 성질.
  it.each(MATCHUPS)('%s-%s: 경기당 xG가 경기당 득점의 ±0.3 안에 있다', (h, a) => {
    const r = batch(h, a, 200)
    for (const side of r) {
      expect(Math.abs(side.xgPerGame - side.goalsPerGame),
        `xG ${side.xgPerGame.toFixed(2)} vs 골 ${side.goalsPerGame.toFixed(2)}`).toBeLessThan(0.3)
    }
  })

  it('슛별 xG가 골 확률 서열을 지킨다 — 이벤트 xG는 항상 0 초과, 1 미만', () => {
    const st = simulateSegment(createMatch(loadTeam('esp'), loadTeam('kor'), { seed: 4242 }), 90)
    const xgs = st.events.filter(e => e.xg != null).map(e => e.xg!)
    expect(xgs.length).toBeGreaterThan(5)
    for (const v of xgs) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1) }
  })
})

describe('패스 성공률 추적', () => {
  it.each(MATCHUPS)('%s-%s: 기본 지시에서 팀 실측 베이스라인 ±1.5%%p로 수렴', (h, a) => {
    const r = batch(h, a, 120)
    const base = [loadTeam(h).statBaseline.passAccuracy, loadTeam(a).statBaseline.passAccuracy]
    for (const idx of [0, 1] as const) {
      expect(Math.abs(r[idx].passAccuracy - base[idx]),
        `${idx === 0 ? h : a} ${r[idx].passAccuracy.toFixed(1)} vs ${base[idx]}`).toBeLessThan(1.5)
    }
  })

  const withInstr = (hi?: Partial<Instructions>, ai?: Partial<Instructions>) =>
    batch('kor', 'esp', 60, st => {
      st.home.tactics.instructions = { ...st.home.tactics.instructions, ...hi }
      st.away.tactics.instructions = { ...st.away.tactics.instructions, ...ai }
    })[0].passAccuracy

  it('템포를 올리면 성공률이 떨어지고 내리면 오른다', () => {
    const korTempo = loadTeam('kor').profile.style.tempo
    const fast = withInstr({ tempo: korTempo + 30 })
    const slow = withInstr({ tempo: korTempo - 30 })
    const base = withInstr()
    expect(fast).toBeLessThan(base - 2)
    expect(slow).toBeGreaterThan(base + 2)
  })

  it('상대 압박이 높아지면 성공률이 떨어진다', () => {
    const espPress = loadTeam('esp').profile.style.pressing
    const pressed = withInstr(undefined, { pressing: espPress + 30 })
    const free = withInstr(undefined, { pressing: espPress - 30 })
    expect(pressed).toBeLessThan(free - 4)
  })

  it('시도 수가 실제 경기 총 패스 범위(팀당 400~700)에 든다', () => {
    const st = simulateSegment(createMatch(loadTeam('kor'), loadTeam('esp'), { seed: 77 }), 90)
    for (const idx of [0, 1] as const) {
      expect(st.stats[idx].passesAttempted).toBeGreaterThan(400)
      expect(st.stats[idx].passesAttempted).toBeLessThan(700)
      expect(st.stats[idx].passesCompleted).toBeLessThanOrEqual(st.stats[idx].passesAttempted)
    }
  })
})
