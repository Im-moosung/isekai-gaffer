// src/data/__tests__/loader.test.ts
import { describe, it, expect } from 'vitest'
import {
  loadTeam,
  loadAllTeams,
  mapFormation,
  playableFormations,
  TEAM_IDS,
} from '../loader'
import { GROUP_MATCHES } from '../groupStage'

const FORMATION_IDS = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1'] as const

describe('loader — 실데이터 로드/검증', () => {
  it('12개국 전체를 로드한다', () => {
    const all = loadAllTeams()
    expect(Object.keys(all)).toHaveLength(12)
    for (const id of TEAM_IDS) {
      expect(all[id]).toBeDefined()
      expect(all[id].id).toBe(id)
    }
  })

  it('선수 총원은 312명이다', () => {
    const all = loadAllTeams()
    const total = TEAM_IDS.reduce((s, id) => s + all[id].squad.length, 0)
    expect(total).toBe(312)
  })

  it('한국 스쿼드에 손흥민(#7)이 존재한다', () => {
    const kor = loadTeam('kor')
    const son = kor.squad.find(p => p.number === 7)
    expect(son).toBeDefined()
    expect(son!.name.ko).toBe('손흥민')
  })

  it('모든 팀은 스쿼드≥18, 등번호 유니크, GK≥1', () => {
    for (const id of TEAM_IDS) {
      const t = loadTeam(id)
      expect(t.squad.length).toBeGreaterThanOrEqual(18)
      const numbers = t.squad.map(p => p.number)
      expect(new Set(numbers).size).toBe(numbers.length)
      expect(t.squad.filter(p => p.position === 'GK').length).toBeGreaterThanOrEqual(1)
    }
  })

  it('JSON 능력치 필드명이 엔진 FieldStats/GkStats와 일치한다(무변형)', () => {
    const kor = loadTeam('kor')
    const field = kor.squad.find(p => p.stats)!
    expect(Object.keys(field.stats!).sort()).toEqual(
      ['defending', 'dribbling', 'pace', 'passing', 'physical', 'shooting'],
    )
    const gk = kor.squad.find(p => p.gkStats)!
    expect(Object.keys(gk.gkStats!).sort()).toEqual(['aerial', 'buildup', 'saving'])
  })
})

describe('mapFormation — 미지원 포메이션 매핑', () => {
  it('지원 6종은 그대로 유지한다', () => {
    for (const f of FORMATION_IDS) expect(mapFormation(f)).toBe(f)
  })
  it('미지원 포메이션을 가장 가까운 지원 포메이션으로 매핑한다', () => {
    expect(mapFormation('4-2-2-2')).toBe('4-4-2')
    expect(mapFormation('3-4-2-1')).toBe('3-5-2')
    expect(mapFormation('4-1-3-2')).toBe('4-4-2')
    expect(mapFormation('3-1-4-2')).toBe('3-5-2')
  })
  it('그 외 미지원은 4-4-2로 폴백한다', () => {
    expect(mapFormation('5-3-2')).toBe('4-4-2')
    expect(mapFormation('gegenpress')).toBe('4-4-2')
  })
})

describe('playableFormations — 파생(Team 타입 오염 없이 함수 제공)', () => {
  it('모든 팀의 playableFormations는 FormationId 유니온 내부다', () => {
    for (const id of TEAM_IDS) {
      const t = loadTeam(id)
      const pf = playableFormations(t)
      expect(pf.length).toBeGreaterThan(0)
      for (const f of pf) expect(FORMATION_IDS).toContain(f)
      // 중복 없음
      expect(new Set(pf).size).toBe(pf.length)
      // 원본 preferredFormations는 유지(무변형)
      expect(Array.isArray(t.profile.preferredFormations)).toBe(true)
    }
  })
})

describe('groupStage — 조별 역사 스크립트', () => {
  it('경기 순서는 cze → mex → rsa 이다', () => {
    expect(GROUP_MATCHES.map(m => m.opponent)).toEqual(['cze', 'mex', 'rsa'])
  })
  it('realScore는 한국 관점 [2,1]/[0,1]/[0,1] 이다', () => {
    expect(GROUP_MATCHES.map(m => m.realScore)).toEqual([[2, 1], [0, 1], [0, 1]])
  })
  it('firstHalfScript는 3경기 모두 빈 배열이다(실제 득점 전부 후반)', () => {
    for (const m of GROUP_MATCHES) expect(m.firstHalfScript).toEqual([])
  })
  it('koreaHome은 중립 개최지이므로 전부 true 고정이다', () => {
    for (const m of GROUP_MATCHES) expect(m.koreaHome).toBe(true)
  })
})
