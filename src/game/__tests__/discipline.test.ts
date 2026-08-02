// src/game/__tests__/discipline.test.ts
// 경고 누적·출장정지 규정 대응 테스트. 규정 근거와 출처는 docs/research/2026-discipline-rules.md.
// 표의 각 행이 여기 최소 한 개의 케이스로 고정돼 있어야 한다 — 규정을 바꾸면 테스트가 먼저 깨진다.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyDiscipline, useCampaignStore, CAUTION_THRESHOLD, CAUTION_WIPE_AFTER, MORALE_BASELINE,
  type MatchCardTally,
} from '../campaignStore'
import { teamCardTally } from '../playerStats'
import type { MatchEvent } from '../../engine/types'

const y = (n: number): MatchCardTally => ({ yellows: n, reds: 0 })
const red = (yellows: number): MatchCardTally => ({ yellows, reds: 1 })

describe('applyDiscipline — 규정 대응', () => {
  it('경고 1장은 정지가 아니다(누적만 쌓인다)', () => {
    const r = applyDiscipline({}, {}, { p1: y(1) }, 'group1')
    expect(r.cautions.p1).toBe(1)
    expect(r.bans.p1).toBeUndefined()
  })

  it('서로 다른 경기에서 2장 누적 → 다음 경기 출장정지, 누적은 0으로 소멸', () => {
    const a = applyDiscipline({}, {}, { p1: y(1) }, 'group1')
    const b = applyDiscipline(a.cautions, a.bans, { p1: y(1) }, 'group2')
    expect(b.bans.p1).toBe(1)
    expect(b.cautions.p1).toBeUndefined()
  })

  it('정지는 다음 경기를 치르면 소화된다(누적 재발 없음)', () => {
    const banned = applyDiscipline({}, {}, { p1: y(2) }, 'r32') // 한 경기 2옐로는 퇴장 경로지만
    // 여기서는 순수 함수에 퇴장 없이 2장을 넣어 임계 전환만 본다.
    expect(banned.bans.p1).toBe(1)
    const served = applyDiscipline(banned.cautions, banned.bans, {}, 'r16')
    expect(served.bans.p1).toBeUndefined()
  })

  it('퇴장(직접 레드)은 1경기 정지이고, 같은 경기의 기존 경고는 유지된다 [FDC 67.4]', () => {
    const r = applyDiscipline({}, {}, { p1: red(1) }, 'r32')
    expect(r.bans.p1).toBe(1)
    expect(r.cautions.p1).toBe(1) // 살아남은 경고 1장
  })

  it('2옐로 퇴장의 두 경고는 누적에 합산되지 않는다', () => {
    const r = applyDiscipline({}, {}, { p1: red(2) }, 'r32')
    expect(r.bans.p1).toBe(1)
    expect(r.cautions.p1).toBeUndefined()
  })

  it('경고 1장 보유 상태에서 2옐로 퇴장 → 정지 1경기, 기존 1장은 그대로 남는다', () => {
    const r = applyDiscipline({ p1: 1 }, {}, { p1: red(2) }, 'r32')
    expect(r.bans.p1).toBe(1)
    expect(r.cautions.p1).toBe(1)
  })

  it('2026: 조별리그 종료 후 미소멸 경고가 소멸한다 (2022에서 바뀐 지점)', () => {
    expect(CAUTION_WIPE_AFTER).toContain('group3')
    const r = applyDiscipline({ p1: 1 }, {}, {}, 'group3')
    expect(r.cautions.p1).toBeUndefined()
  })

  it('2026: 8강 종료 후에도 한 번 더 소멸한다', () => {
    expect(CAUTION_WIPE_AFTER).toContain('qf')
    const r = applyDiscipline({ p1: 1 }, {}, {}, 'qf')
    expect(r.cautions.p1).toBeUndefined()
  })

  it('소멸은 미소멸 경고만 지운다 — 확정된 정지는 남는다', () => {
    // 8강에서 2장째를 받아 정지가 확정되면, 같은 시점의 소멸이 그 정지를 지우면 안 된다.
    const r = applyDiscipline({ p1: 1 }, {}, { p1: y(1) }, 'qf')
    expect(r.bans.p1).toBe(1)
    expect(r.cautions.p1).toBeUndefined()
  })

  it('cards 미지정(데모·구 호출자)이면 새 징계 없이 기존 정지만 소화된다', () => {
    const r = applyDiscipline({ p1: 1 }, { p2: 1 }, undefined, 'r32')
    expect(r.cautions.p1).toBe(1)
    expect(r.bans.p2).toBeUndefined()
  })

  it('순수 함수다 — 입력 객체를 변형하지 않는다', () => {
    const cautions = { p1: 1 }
    const bans = { p2: 2 }
    applyDiscipline(cautions, bans, { p1: y(1) }, 'r32')
    expect(cautions).toEqual({ p1: 1 })
    expect(bans).toEqual({ p2: 2 })
  })

  it('임계는 2장이다', () => {
    expect(CAUTION_THRESHOLD).toBe(2)
  })
})

describe('teamCardTally — 이벤트에서 카드 집계', () => {
  const ev = (type: MatchEvent['type'], teamId: string, playerId: string): MatchEvent =>
    ({ minute: 10, type, teamId, playerId })

  it('우리 팀 카드만 센다(상대 카드는 무시)', () => {
    const events = [ev('yellow', 'kor', 'p1'), ev('yellow', 'esp', 'p1'), ev('red', 'esp', 'x9')]
    expect(teamCardTally(events, 'kor')).toEqual({ p1: { yellows: 1, reds: 0 } })
  })

  it('2옐로 퇴장은 yellows 2 + reds 1로 남는다', () => {
    const events = [ev('yellow', 'kor', 'p1'), ev('yellow', 'kor', 'p1'), ev('red', 'kor', 'p1')]
    expect(teamCardTally(events, 'kor')).toEqual({ p1: { yellows: 2, reds: 1 } })
  })

  it('카드가 없는 선수는 키를 만들지 않는다', () => {
    expect(teamCardTally([ev('goal', 'kor', 'p1'), ev('foul', 'kor', 'p2')], 'kor')).toEqual({})
  })
})

describe('campaignStore — 캠페인을 통과하는 징계 흐름', () => {
  beforeEach(() => {
    useCampaignStore.getState().reset()
    useCampaignStore.getState().startCampaign(1)
  })

  it('조별 1·2차전 경고 → 3차전 출장정지', () => {
    const s = () => useCampaignStore.getState()
    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(1) } })
    expect(s().cautionCount('p1')).toBe(1)
    expect(s().isSuspended('p1')).toBe(false)

    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(1) } })
    expect(s().isSuspended('p1')).toBe(true)
    expect(s().suspendedIds()).toEqual(['p1'])
  })

  it('3차전을 결장하면 정지가 풀린다', () => {
    const s = () => useCampaignStore.getState()
    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(1) } })
    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(1) } })
    expect(s().isSuspended('p1')).toBe(true)
    s().recordResult([1, 0], {}, undefined, [], { cards: {} }) // group3 결장
    expect(s().isSuspended('p1')).toBe(false)
  })

  it('조별 3차전을 마치면 미소멸 경고가 32강으로 넘어가지 않는다', () => {
    const s = () => useCampaignStore.getState()
    s().recordResult([1, 0], {}, undefined, [], { cards: {} })
    s().recordResult([1, 0], {}, undefined, [], { cards: {} })
    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(1) } })
    expect(s().stage).toBe('r32')
    expect(s().cautionCount('p1')).toBe(0)
  })

  it('사기는 기준선 70으로 70% 회귀해 이월된다', () => {
    const s = () => useCampaignStore.getState()
    // 미기록 선수는 기준선.
    expect(s().startingMorale('none')).toBe(MORALE_BASELINE)
    s().recordResult([1, 0], {}, undefined, [], { moraleByPlayer: { hi: 100, lo: 40 } })
    // 100 → 70 + 30*0.3 = 79 / 40 → 70 - 30*0.3 = 61
    expect(s().startingMorale('hi')).toBe(79)
    expect(s().startingMorale('lo')).toBe(61)
  })

  // 감사 결함 ④: ×0.3이 만든 소수가 저장값에 눌어붙어 "사기가 4.999999999999 올랐습니다"로 샜다.
  it('이월 사기는 언제나 정수다 — ×0.3이 소수를 남기지 않는다', () => {
    const s = () => useCampaignStore.getState()
    s().recordResult([1, 0], {}, undefined, [], {
      moraleByPlayer: { a: 71, b: 73, c: 88, d: 33, e: 0, f: 100 },
    })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(Number.isInteger(s().startingMorale(id))).toBe(true)
    }
    // 71 → 70 + 0.3 = 70.3 → 70 (반올림 규약: Math.round)
    expect(s().startingMorale('a')).toBe(70)
    // 73 → 70 + 0.9 = 70.9 → 71
    expect(s().startingMorale('b')).toBe(71)
  })

  it('reset은 징계·사기 이월을 함께 지운다', () => {
    const s = () => useCampaignStore.getState()
    s().recordResult([1, 0], {}, undefined, [], { cards: { p1: y(2) }, moraleByPlayer: { p1: 30 } })
    s().reset()
    expect(s().isSuspended('p1')).toBe(false)
    expect(s().cautionCount('p1')).toBe(0)
    expect(s().startingMorale('p1')).toBe(MORALE_BASELINE)
  })
})
