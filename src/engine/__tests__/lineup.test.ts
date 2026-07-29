// src/engine/__tests__/lineup.test.ts
// Phase 3 Task 6: 상대 AI가 자기 시그니처 포메이션으로 출전하는지 검증.
import { describe, it, expect } from 'vitest'
import { pickBestXI } from '../lineup'
import { XI_SLOTS, mapFormation } from '../formations'
import { makeTestTeam } from '../fixtures/testTeams'
import { createMatch } from '../simulate'
import { loadTeam, TEAM_IDS } from '../../data/loader'
import { positionFitness } from '../fitness'
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

  // pickBestXI는 슬롯 순서 그리디라, 앞 슬롯이 뒤 슬롯의 유일한 적임자를 선점하면
  // 최전방에 풀백이 서는 식의 배치가 나올 수 있다(UI autoFill에서 실제로 났던 버그).
  // 12팀 전수 실측에서는 최소 적합도 0.85(대체 포지션) 미만이 하나도 없어 엔진 쪽은
  // 그리디를 그대로 둔다 — 그 전제를 여기서 고정한다. 깨지면 autoFill과 같은
  // (희소 슬롯 우선 + 2-opt 수리) 처방을 엔진에도 옮겨야 한다는 신호다.
  it('12팀 × 6포메이션 전수 — 적합도 0.85 미만 배치가 없다', () => {
    for (const id of TEAM_IDS) {
      const team = loadTeam(id)
      for (const f of FORMATIONS) {
        for (const l of pickBestXI(team, f).lineup) {
          const p = team.squad.find(q => q.id === l.playerId)!
          expect(positionFitness(p, l.slot)).toBeGreaterThanOrEqual(0.85)
        }
      }
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
