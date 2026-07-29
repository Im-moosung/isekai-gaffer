// 3D 하이라이트 ↔ 2D 작전판 배분과 **반복 측정**.
//
// 장면 라이브러리는 유한하다. 모든 이벤트를 3D로 돌리면 같은 그림이 금방 눈에 띈다.
// 이 테스트는 실엔진 90분에서 (1) 3D 비중이 과하지 않고 (2) 한 경기 안에서 같은 장면이
// 몇 번 나오는지를 **수치로** 고정한다. 회귀하면 여기서 잡힌다.
import { describe, it, expect } from 'vitest'
import type { AttackPattern } from '../../../engine/types'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch, simulateSegment } from '../../../engine/simulate'
import { sceneKeyFor, buildSequence } from '../../pitch/choreography'
import { DRAMA_PRIORITY, HIGHLIGHT_TYPES, isHighlightEvent, pickDramaEvent } from '../playback'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const SEEDS = [1000, 1003, 1005, 1009, 1011]
const PATTERNS: AttackPattern[] = ['balanced', 'cross', 'through', 'longshot']

function play(seed: number, pattern: AttackPattern) {
  let st = createMatch(home, away, { seed })
  st.home.tactics.attackPattern = pattern
  for (let m = 1; m <= 90; m++) st = simulateSegment(st, m)
  return st
}

describe('하이라이트 선택자 — Phase C 중계와 같은 규칙 위에 있다', () => {
  it('HIGHLIGHT_TYPES는 DRAMA_PRIORITY의 부분집합이다(안무 없는 타입 금지)', () => {
    for (const t of HIGHLIGHT_TYPES) expect(DRAMA_PRIORITY).toContain(t)
  })
  it('하이라이트로 뽑힌 이벤트는 반드시 안무가 있다', () => {
    const st = play(1003, 'cross')
    for (let m = 1; m <= 90; m++) {
      const d = pickDramaEvent(st.events.filter(e => e.minute === m))
      if (!d || !isHighlightEvent(d)) continue
      expect(buildSequence(d, st.home, st.away).length).toBeGreaterThan(0)
    }
  })
})

describe('3D/2D 배분', () => {
  it('3D는 전체 분의 15~40%만 차지한다 — 나머지는 2D 작전판', () => {
    for (const pattern of PATTERNS) {
      let live3d = 0
      let total = 0
      for (const seed of SEEDS) {
        const st = play(seed, pattern)
        for (let m = 1; m <= 90; m++) {
          total++
          const d = pickDramaEvent(st.events.filter(e => e.minute === m))
          if (d && isHighlightEvent(d)) live3d++
        }
      }
      const share = live3d / total
      expect(share, `${pattern} 3D 비중 ${(share * 100).toFixed(0)}%`).toBeGreaterThan(0.15)
      expect(share, `${pattern} 3D 비중 ${(share * 100).toFixed(0)}%`).toBeLessThan(0.4)
    }
  })
})

describe('★ 반복 측정 — 한 경기에서 같은 장면이 몇 번 나오는가', () => {
  it('경기당 같은 장면 최다 반복 ≤ 3, 고유 장면 ≥ 10', () => {
    for (const pattern of PATTERNS) {
      for (const seed of SEEDS) {
        const st = play(seed, pattern)
        const counts = new Map<string, number>()
        for (let m = 1; m <= 90; m++) {
          const d = pickDramaEvent(st.events.filter(e => e.minute === m))
          if (!d || !isHighlightEvent(d)) continue
          const k = sceneKeyFor(d, st.home, st.away)!
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        const played = [...counts.values()].reduce((a, b) => a + b, 0)
        const maxRepeat = Math.max(...counts.values())
        expect(played, `${pattern}/${seed} 3D 장면 수`).toBeGreaterThan(10)
        expect(counts.size, `${pattern}/${seed} 고유 장면 ${counts.size}`).toBeGreaterThanOrEqual(10)
        expect(maxRepeat, `${pattern}/${seed} 최다 반복 ${maxRepeat}`).toBeLessThanOrEqual(3)
      }
    }
  })
})
