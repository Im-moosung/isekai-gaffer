import { describe, it, expect } from 'vitest'
import { breakSchedule, detectMoment } from '../matchSession'
import type { MatchEvent } from '../../engine/types'

const IDS = { homeId: 'H', awayId: 'A' }
const noEvents: MatchEvent[] = []

describe('breakSchedule', () => {
  it('시드 결정론 — 같은 시드는 같은 스케줄', () => {
    expect(breakSchedule(42)).toEqual(breakSchedule(42))
    expect(breakSchedule(7)).toEqual(breakSchedule(7))
  })
  it('범위: 첫 브레이크 30±2(28~32), 둘째 75±2(73~77)', () => {
    for (const seed of [0, 1, 42, 7, 20260724, 999999, 123456]) {
      const s = breakSchedule(seed)
      expect(s.firstHydration).toBeGreaterThanOrEqual(28)
      expect(s.firstHydration).toBeLessThanOrEqual(32)
      expect(s.secondHydration).toBeGreaterThanOrEqual(73)
      expect(s.secondHydration).toBeLessThanOrEqual(77)
    }
  })
  it('시드에 따라 값이 갈린다(모두 동일하지 않음)', () => {
    const firsts = new Set([0, 1, 2, 3, 4, 5].map(s => breakSchedule(s).firstHydration))
    expect(firsts.size).toBeGreaterThan(1)
  })
})

describe('detectMoment 유형별 트리거', () => {
  it('conceded: away 득점(실점 직후)', () => {
    const m = detectMoment(noEvents, 50, [0, 1], [0, 0], 100, IDS)
    expect(m?.kind).toBe('conceded')
    expect(m?.minute).toBe(50)
  })
  it('scored: home 득점(득점 직후)', () => {
    const m = detectMoment(noEvents, 50, [1, 0], [0, 0], 100, IDS)
    expect(m?.kind).toBe('scored')
  })
  it('momentum-lost: 최근 10분 상대 슛 3+ (away miss/goal + home save)', () => {
    const ev: MatchEvent[] = [
      { minute: 42, type: 'miss', teamId: 'A' },
      { minute: 45, type: 'save', teamId: 'H' }, // home GK가 away 슛 막음
      { minute: 48, type: 'miss', teamId: 'A' },
      { minute: 30, type: 'miss', teamId: 'A' }, // 창 밖(minute-10 이하)
    ]
    const m = detectMoment(ev, 50, [0, 0], [0, 0], 100, IDS)
    expect(m?.kind).toBe('momentum-lost')
  })
  it('momentum-lost: 창 내 상대 슛 2개면 트리거 안 함', () => {
    const ev: MatchEvent[] = [
      { minute: 45, type: 'miss', teamId: 'A' },
      { minute: 48, type: 'save', teamId: 'H' },
    ]
    expect(detectMoment(ev, 50, [0, 0], [0, 0], 100, IDS)).toBeNull()
  })
  it('momentum-lost: 홈 슛(우리 공격)은 세지 않는다', () => {
    const ev: MatchEvent[] = [
      { minute: 45, type: 'miss', teamId: 'H' },
      { minute: 46, type: 'miss', teamId: 'H' },
      { minute: 47, type: 'save', teamId: 'A' }, // away GK가 우리 슛 막음
    ]
    expect(detectMoment(ev, 50, [0, 0], [0, 0], 100, IDS)).toBeNull()
  })
  it('clutch: 80분+ 스코어차 ≤ 1', () => {
    expect(detectMoment(noEvents, 82, [1, 1], [1, 1], 100, IDS)?.kind).toBe('clutch')
    expect(detectMoment(noEvents, 85, [2, 1], [2, 1], 100, IDS)?.kind).toBe('clutch')
  })
  it('clutch: 80분 미만이면 트리거 안 함', () => {
    expect(detectMoment(noEvents, 79, [1, 1], [1, 1], 100, IDS)).toBeNull()
  })
  it('clutch: 스코어차 2 이상이면 트리거 안 함', () => {
    expect(detectMoment(noEvents, 85, [3, 1], [3, 1], 100, IDS)).toBeNull()
  })
  it('fatigue: 주력 최저 스태미나 35 미만', () => {
    expect(detectMoment(noEvents, 60, [0, 0], [0, 0], 34, IDS)?.kind).toBe('fatigue')
    expect(detectMoment(noEvents, 60, [0, 0], [0, 0], 35, IDS)).toBeNull()
  })
  it('아무 조건도 없으면 null', () => {
    expect(detectMoment(noEvents, 50, [0, 0], [0, 0], 100, IDS)).toBeNull()
  })
  it('우선순위: 실점 직후가 클러치보다 우선', () => {
    // 85분, 실점하며 스코어차 1 (clutch 조건도 참) → conceded가 우선
    const m = detectMoment(noEvents, 85, [1, 2], [1, 1], 100, IDS)
    expect(m?.kind).toBe('conceded')
  })
})
