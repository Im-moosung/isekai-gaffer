import { describe, it, expect } from 'vitest'
import type { MatchEvent, MatchEventType } from '../../../engine/types'
import {
  minuteDwellMs,
  EVENT_DWELL_MS,
  NO_EVENT_DWELL_MS,
  CLUTCH_MULTIPLIER,
} from '../playback'

// 테스트용 이벤트(분/타입만 유효하면 됨).
function ev(type: MatchEventType, minute = 10): MatchEvent {
  return { minute, type, teamId: 'kor' }
}

describe('minuteDwellMs — 이벤트별 수치', () => {
  it('goal이 가장 오래 머문다', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1, false)).toBe(6500)
  })
  it('shot·save·miss는 동일 dwell', () => {
    expect(minuteDwellMs(10, [ev('shot')], 1, false)).toBe(4300)
    expect(minuteDwellMs(10, [ev('save')], 1, false)).toBe(4300)
    expect(minuteDwellMs(10, [ev('miss')], 1, false)).toBe(4300)
  })
  it('foul·corner는 동일 dwell', () => {
    expect(minuteDwellMs(10, [ev('foul')], 1, false)).toBe(2700)
    expect(minuteDwellMs(10, [ev('corner')], 1, false)).toBe(2700)
  })
  it('무사건 분은 무사건 dwell', () => {
    expect(minuteDwellMs(10, [], 1, false)).toBe(NO_EVENT_DWELL_MS)
  })
  it('목록에 없는 이벤트(kickoff·yellow)만 있으면 무사건과 동일', () => {
    expect(minuteDwellMs(10, [ev('kickoff'), ev('yellow')], 1, false)).toBe(NO_EVENT_DWELL_MS)
  })
  it('여러 이벤트가 겹치면 최고 가중을 채택(골+파울 → 골)', () => {
    expect(minuteDwellMs(10, [ev('foul'), ev('goal'), ev('corner')], 1, false)).toBe(6500)
  })
  it('드라마 순서: goal > shot > foul > 무사건', () => {
    const g = minuteDwellMs(10, [ev('goal')], 1, false)
    const s = minuteDwellMs(10, [ev('shot')], 1, false)
    const f = minuteDwellMs(10, [ev('foul')], 1, false)
    const n = minuteDwellMs(10, [], 1, false)
    expect(g).toBeGreaterThan(s)
    expect(s).toBeGreaterThan(f)
    expect(f).toBeGreaterThan(n)
  })
})

describe('minuteDwellMs — speed 나눗셈', () => {
  it('1.5x는 dwell을 1.5로 나눈다', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1.5, false)).toBe(Math.round(6500 / 1.5))
    expect(minuteDwellMs(10, [], 1.5, false)).toBe(Math.round(1800 / 1.5))
  })
  it('2x는 dwell을 절반으로', () => {
    expect(minuteDwellMs(10, [ev('goal')], 2, false)).toBe(3250)
    expect(minuteDwellMs(10, [ev('shot')], 2, false)).toBe(2150)
  })
  it('속도가 빠를수록 dwell이 짧다', () => {
    const a = minuteDwellMs(10, [ev('goal')], 1, false)
    const b = minuteDwellMs(10, [ev('goal')], 1.5, false)
    const c = minuteDwellMs(10, [ev('goal')], 2, false)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
})

describe('minuteDwellMs — clutch 배수', () => {
  it('clutch면 무사건 dwell이 ×2', () => {
    expect(minuteDwellMs(85, [], 1, true)).toBe(NO_EVENT_DWELL_MS * CLUTCH_MULTIPLIER)
  })
  it('clutch는 이벤트 분에는 영향 없음(이미 충분히 김)', () => {
    expect(minuteDwellMs(85, [ev('goal', 85)], 1, true)).toBe(6500)
    expect(minuteDwellMs(85, [ev('foul', 85)], 1, true)).toBe(2700)
  })
  it('clutch + speed 동시 적용', () => {
    expect(minuteDwellMs(85, [], 2, true)).toBe(Math.round((1800 * 2) / 2))
  })
})

// ── 1x 총합 검증: 90분 총합이 180,000~300,000ms(=3~5분) 범위에 들어오는지 ──
// 합성 이벤트 분포 3종(sparse/medium/dense)으로 상수 캘리브레이션을 고정한다.
// 각 이벤트를 서로 다른 분에 배치(분당 최대 1개) → 나머지는 무사건 분.
function distribution(spec: Partial<Record<MatchEventType, number>>): MatchEvent[] {
  const events: MatchEvent[] = []
  let minute = 2
  for (const [type, count] of Object.entries(spec)) {
    for (let i = 0; i < (count ?? 0); i++) {
      events.push(ev(type as MatchEventType, minute))
      minute += 1
    }
  }
  return events
}

// 무사건 분은 clutch=false로 계산(기본 페이스 캘리브레이션 검증).
function total1x(events: MatchEvent[]): number {
  let sum = 0
  for (let m = 1; m <= 90; m++) {
    const atMinute = events.filter(e => e.minute === m)
    sum += minuteDwellMs(m, atMinute, 1, false)
  }
  return sum
}

describe('minuteDwellMs — 1x 90분 총합 범위(180k~300k)', () => {
  const cases: { name: string; events: MatchEvent[] }[] = [
    { name: 'sparse(25 이벤트)', events: distribution({ goal: 2, save: 6, miss: 5, corner: 4, foul: 8 }) },
    { name: 'medium(33 이벤트)', events: distribution({ goal: 3, save: 9, miss: 8, corner: 6, foul: 7 }) },
    { name: 'dense(40 이벤트)', events: distribution({ goal: 4, save: 12, miss: 11, corner: 9, foul: 4 }) },
  ]
  for (const { name, events } of cases) {
    it(`${name} → 총합이 180,000~300,000ms`, () => {
      const total = total1x(events)
      expect(total).toBeGreaterThanOrEqual(180_000)
      expect(total).toBeLessThanOrEqual(300_000)
    })
  }

  it('EVENT_DWELL_MS 상수가 노출되어 있다(회귀 고정)', () => {
    expect(EVENT_DWELL_MS.goal).toBe(6500)
  })
})
