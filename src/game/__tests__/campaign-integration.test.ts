// src/game/__tests__/campaign-integration.test.ts
// Phase 2B Task 8(자동): 캠페인 완주 통합 테스트.
// 스토어(campaignStore) + 실데이터(loadAllTeams) + 엔진(createMatch/simulateSegment/simulateShootout)을
// 직접 조합해 캠페인 전체를 자동 진행한다. (브라우저 E2E는 별도)
import { describe, it, expect, beforeEach } from 'vitest'
import { useCampaignStore } from '../campaignStore'
import { loadAllTeams, type TeamId } from '../../data/loader'
import { createMatch, simulateSegment } from '../../engine/simulate'
import { simulateShootout, type ShootoutKicker } from '../../engine/shootout'
import type { Team, Player } from '../../engine/types'

const store = () => useCampaignStore.getState()

const TEAMS = loadAllTeams()

const GROUP_STAGES = new Set(['group1', 'group2', 'group3'])

// 승부차기 키커: GK 제외, 페널티 성향 상위 5명(결정론 정렬), 방향은 인덱스 순환
const DIRS = ['left', 'center', 'right'] as const
function kickersOf(team: Team): ShootoutKicker[] {
  return [...team.squad]
    .filter(p => p.position !== 'GK')
    .sort((a, b) => b.penalty - a.penalty || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((p, i) => ({ player: p, direction: DIRS[i % DIRS.length] }))
}
function gkOf(team: Team): Player {
  return team.squad.find(p => p.position === 'GK')!
}

interface RunResult {
  steps: number
  reached: string
  champion: boolean
  records: { stage: string; opponentId: TeamId; score: [number, number]; shootout?: [number, number] }[]
}

// 한 캠페인을 엔진으로 끝까지 자동 진행한다.
function autoPlayCampaign(campaignSeed: number): RunResult {
  store().startCampaign(campaignSeed)
  const kor = TEAMS.kor
  let steps = 0
  const MAX_STEPS = 20 // 유한성 가드(정상은 ≤8)
  while (store().stage !== 'ended') {
    if (++steps > MAX_STEPS) throw new Error(`캠페인이 ${MAX_STEPS}스텝 내 종료되지 않음(무한 루프 의심)`)
    const stage = store().stage
    const oppId = store().currentOpponent()
    const mseed = store().matchSeed()
    const opp = TEAMS[oppId]
    const isGroup = GROUP_STAGES.has(stage)

    // [F1 B안 · 2026-07-26] 조별도 전반 스크립트 없이 1~90분 완전 시뮬한다.
    // isGroup은 이제 시뮬 방식이 아니라 승부차기 필요 여부(무승부 허용)만 가른다.
    const match = createMatch(kor, opp, { seed: mseed })
    const done = simulateSegment(match, 90)
    const score: [number, number] = [done.score[0], done.score[1]] // [kor, 상대]

    let shootout: [number, number] | undefined
    if (!isGroup && score[0] === score[1]) {
      const so = simulateShootout({
        seed: mseed,
        homeKickers: kickersOf(kor),
        awayKickers: kickersOf(opp),
        homeGk: gkOf(kor),
        awayGk: gkOf(opp),
      })
      shootout = [so.homeScore, so.awayScore] // [kor, 상대]
    }

    store().recordResult(score, done.home.staminaByPlayer, shootout)
  }
  return {
    steps,
    reached: store().ending!.reached,
    champion: store().ending!.champion,
    records: store().records.map(r => ({ ...r })),
  }
}

beforeEach(() => store().reset())

describe('실데이터 풀 캠페인 자동 완주 (스토어+엔진)', () => {
  it('유한 스텝(≤8경기) 내 종료하고 엔딩·정상 스코어를 남긴다', () => {
    const res = autoPlayCampaign(123)
    // (a) 유한 스텝 종료
    expect(res.steps).toBeLessThanOrEqual(8)
    expect(store().stage).toBe('ended')
    // (b) ending 존재
    expect(store().ending).not.toBeNull()
    // (c) records 스코어 전부 [0..8]
    expect(res.records.length).toBeGreaterThan(0)
    for (const r of res.records) {
      expect(r.score[0]).toBeGreaterThanOrEqual(0)
      expect(r.score[0]).toBeLessThanOrEqual(8)
      expect(r.score[1]).toBeGreaterThanOrEqual(0)
      expect(r.score[1]).toBeLessThanOrEqual(8)
    }
  })

  it('(d) 같은 campaignSeed로 2회 실행 시 records가 완전 동일하다(결정론)', () => {
    const a = autoPlayCampaign(123)
    const b = autoPlayCampaign(123)
    expect(b.records).toEqual(a.records)
    expect(b.reached).toBe(a.reached)
    expect(b.champion).toBe(a.champion)
  })

  it('시드 3개(111·222·333)로 반복해도 크래시 없이 완주한다', () => {
    for (const seed of [111, 222, 333]) {
      store().reset()
      const res = autoPlayCampaign(seed)
      expect(res.steps).toBeLessThanOrEqual(8)
      expect(res.steps).toBeGreaterThanOrEqual(3) // 최소 조별 3경기
      expect(store().stage).toBe('ended')
      expect(store().ending).not.toBeNull()
    }
  })
})

describe('강제 전승 경로 (스토어만, 엔진 없이 조작 스코어)', () => {
  it('조별 전승 → 1위, r32~final 상대 ecu→eng→nor→arg→esp, final 승리 시 champion', () => {
    store().startCampaign(1)
    store().recordResult([2, 0], {}) // vs cze
    store().recordResult([2, 0], {}) // vs mex
    store().recordResult([2, 0], {}) // vs rsa
    expect(store().groupRank).toBe(1)
    expect(store().path).toBe('first')
    expect(store().stage).toBe('r32')

    const seq: TeamId[] = []
    for (const _ of ['r32', 'r16', 'qf', 'sf', 'final']) {
      seq.push(store().currentOpponent())
      store().recordResult([2, 0], {})
    }
    expect(seq).toEqual(['ecu', 'eng', 'nor', 'arg', 'esp'])
    expect(store().stage).toBe('ended')
    expect(store().ending).toEqual({ reached: 'final', champion: true })
  })
})

describe('강제 2위 경로 (스토어만)', () => {
  it('cze 승·mex 패·rsa 승 → 2위, second 경로 can→mar→fra 순서', () => {
    store().startCampaign(1)
    store().recordResult([2, 0], {}) // cze 승
    store().recordResult([0, 1], {}) // mex 패
    store().recordResult([1, 0], {}) // rsa 승
    expect(store().groupRank).toBe(2)
    expect(store().path).toBe('second')
    expect(store().stage).toBe('r32')

    const seq: TeamId[] = []
    for (const _ of ['r32', 'r16', 'qf']) {
      seq.push(store().currentOpponent())
      store().recordResult([2, 0], {}) // 강제 승 전진
    }
    expect(seq).toEqual(['can', 'mar', 'fra'])
  })
})
