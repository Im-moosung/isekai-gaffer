// src/engine/__tests__/lineup.test.ts
// Phase 3 Task 6: 상대 AI가 자기 시그니처 포메이션으로 출전하는지 검증.
import { describe, it, expect } from 'vitest'
import { pickBestXI } from '../lineup'
import { XI_SLOTS, mapFormation } from '../formations'
import { makeTestTeam } from '../fixtures/testTeams'
import { createMatch } from '../simulate'
import { loadTeam } from '../../data/loader'
import type { FormationId } from '../types'

const FORMATIONS = Object.keys(XI_SLOTS) as FormationId[]

describe('pickBestXI — 포메이션 프로필 반영', () => {
  it('formation 미지정 시 fixture 팀(preferredFormations ["4-3-3"])은 4-3-3', () => {
    const team = makeTestTeam('fix', 78)
    const t = pickBestXI(team)
    expect(t.formation).toBe('4-3-3')
    expect(t.lineup.map(s => s.slot)).toEqual(XI_SLOTS['4-3-3'])
  })

  it('전 포메이션에서 XI는 11인이며 슬롯 순서·선수 유일성이 유효', () => {
    const team = makeTestTeam('fix', 78)
    for (const f of FORMATIONS) {
      const t = pickBestXI(team, f)
      expect(t.formation).toBe(f)
      expect(t.lineup).toHaveLength(11)
      expect(t.lineup.map(s => s.slot)).toEqual(XI_SLOTS[f])
      expect(new Set(t.lineup.map(s => s.playerId)).size).toBe(11)
    }
  })

  it('esp defaultTactics.formation = esp 프로필 첫 포메이션의 매핑값(4-2-3-1)', () => {
    const esp = loadTeam('esp')
    const expected = mapFormation(esp.profile.preferredFormations[0])
    expect(expected).toBe('4-2-3-1')
    // createMatch가 tactics 미지정 시 defaultTactics(pickBestXI) 사용 → home/away 모두 프로필 반영
    const match = createMatch(esp, loadTeam('kor'), { seed: 1 })
    expect(match.home.tactics.formation).toBe(expected)
    expect(match.away.tactics.formation).toBe(mapFormation(loadTeam('kor').profile.preferredFormations[0]))
  })
})
