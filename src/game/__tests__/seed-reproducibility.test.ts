// 시드 재현성 계약 — (가)안의 핵심.
//
// 캠페인 시드를 매 판 새로 뽑기로 했으므로(2026-08-01), "시드가 정해지면 결과가 하나"라는
// 설계 §99의 계약이 여전히 참인지를 여기서 못박는다. 이게 깨지면 엔딩 화면에 적어 주는 시드도,
// 리더보드의 리플레이 검증도 전부 의미를 잃는다.
import { describe, it, expect, beforeEach } from 'vitest'
import { useCampaignStore } from '../campaignStore'
import { newCampaignSeed } from '../seed'
import { loadAllTeams } from '../../data/loader'
import { createMatch, simulateSegment } from '../../engine/simulate'
import type { MatchState } from '../../engine/types'

const store = () => useCampaignStore.getState()
const TEAMS = loadAllTeams()

/** 한 캠페인의 1경기(체코전)를 90분 완주하고 비교용 지문을 만든다. */
function playFirstMatch(campaignSeed: number): { seed: number; score: [number, number]; log: string } {
  store().reset()
  store().startCampaign(campaignSeed)
  const seed = store().matchSeed()
  const done: MatchState = simulateSegment(
    createMatch(TEAMS.kor, TEAMS[store().currentOpponent()], { seed }),
    90,
  )
  return {
    seed,
    score: [done.score[0], done.score[1]],
    // 사건 하나까지 비교한다 — 스코어만 같고 전개가 다르면 "재현"이 아니다.
    log: done.events.map(e => `${e.minute}'${e.type}:${e.teamId}:${e.playerId ?? ''}`).join('|'),
  }
}

beforeEach(() => store().reset())

describe('같은 시드로 두 번 시작하면 완전히 같은 결과다', () => {
  it('1경기 90분이 스코어·사건 순서까지 동일하다', () => {
    const a = playFirstMatch(424242)
    const b = playFirstMatch(424242)
    expect(b.seed).toBe(a.seed)
    expect(b.score).toEqual(a.score)
    expect(b.log).toBe(a.log)
    expect(a.log.length).toBeGreaterThan(0)
  })

  it('경기 시드 수열(seed*31 + 진행 순)도 그대로 재현된다', () => {
    const seedsOf = () => {
      store().reset()
      store().startCampaign(777_777)
      const out: number[] = []
      for (let i = 0; i < 3; i++) {
        out.push(store().matchSeed())
        store().recordResult([1, 0], {})
      }
      return out
    }
    expect(seedsOf()).toEqual(seedsOf())
  })
})

describe('다른 시드는 다른 판이다', () => {
  it('시드가 다르면 1경기 전개가 갈린다(상수 시드 시절엔 전원이 같은 대본이었다)', () => {
    const logs = new Set([101_101, 202_202, 303_303, 404_404, 505_505].map(s => playFirstMatch(s).log))
    expect(logs.size).toBeGreaterThan(1)
  })

  it('발급기가 준 시드도 그대로 재현된다(발급 → 저장 → 재생의 왕복)', () => {
    const issued = newCampaignSeed(() => 987_654_321)
    expect(playFirstMatch(issued).log).toBe(playFirstMatch(issued).log)
  })
})
