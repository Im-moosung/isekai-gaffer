// 2인 비교 뷰의 순수 계산. "차이를 강조하라"는 요구는 전부 이 계산에서 나오므로
// 승자 판정·델타·막대 정규화·결론 문장을 값으로 고정한다.
import { describe, it, expect } from 'vitest'
import { metricDiff, swapFitDelta, subFitDelta, sharesAxes, buildCompare, type CompareMetric } from '../lineup/compare'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import type { Player } from '../../engine/types'

const team = makeTestTeam('kor', 80)
const find = (pos: string, nth = 0): Player => team.squad.filter(p => p.position === pos)[nth]

const m = (over: Partial<CompareMetric>): CompareMetric => ({
  key: 'x', label: 'x', a: 0, b: 0, digits: 0, higherBetter: true, epsilon: 3, span: 30, ...over,
})

describe('metricDiff — 승자·델타·막대', () => {
  it('epsilon 미만 차이는 동일로 본다(잡음을 막대로 그리지 않는다)', () => {
    expect(metricDiff(m({ a: 80, b: 78 }))).toEqual({ winner: 'tie', delta: 0, ratio: 0 })
  })

  it('큰 쪽이 이기고 델타·막대 비율이 함께 나온다', () => {
    const d = metricDiff(m({ a: 90, b: 75 }))
    expect(d.winner).toBe('a')
    expect(d.delta).toBe(15)
    expect(d.ratio).toBeCloseTo(0.5) // span 30
  })

  it('span을 넘는 차이는 막대가 꽉 찬다(1을 넘지 않는다)', () => {
    expect(metricDiff(m({ a: 95, b: 30 })).ratio).toBe(1)
  })

  it('higherBetter=false(경고 장수)는 적은 쪽이 이긴다', () => {
    const d = metricDiff(m({ a: 2, b: 0, higherBetter: false, epsilon: 1, span: 2 }))
    expect(d.winner).toBe('b')
    expect(d.delta).toBe(2)
  })
})

describe('적합도 델타 — 교체 판단의 핵심 지표', () => {
  it('자리 교환 이득은 대칭이고, 제자리 교환이면 음수다', () => {
    const cb = find('CB')
    const st = find('ST')
    // CB를 ST 자리로, ST를 CB 자리로 보내면 둘 다 나빠진다.
    expect(swapFitDelta(cb, 'CB', st, 'ST')).toBeLessThan(0)
    // 인자를 뒤집어도 같은 값(교환은 대칭이다).
    expect(swapFitDelta(st, 'ST', cb, 'CB')).toBeCloseTo(swapFitDelta(cb, 'CB', st, 'ST'))
  })

  it('주 포지션 선수를 넣으면 양수, 엉뚱한 선수를 넣으면 음수다', () => {
    const st0 = find('ST', 0)
    const st1 = find('ST', 1)
    const cb = find('CB')
    expect(subFitDelta(st1, cb, 'ST')).toBeGreaterThan(0)
    expect(subFitDelta(cb, st0, 'ST')).toBeLessThan(0)
  })

  it('GK와 필드 선수는 축을 공유하지 않는다', () => {
    expect(sharesAxes(find('GK'), find('ST'))).toBe(false)
    expect(sharesAxes(find('ST', 0), find('ST', 1))).toBe(true)
  })
})

describe('buildCompare — 조합이 라벨·기준 자리·결론을 정한다', () => {
  const st0 = find('ST', 0)
  const st1 = find('ST', 1)
  const cb = find('CB')
  const gk = find('GK')

  it('선발+선발 → 자리 바꾸기, 두 슬롯이 기준', () => {
    const c = buildCompare({ a: cb, aSlot: 'CB', b: st0, bSlot: 'ST' })
    expect(c.kind).toBe('swap')
    expect(c.actionLabel).toBe('자리 바꾸기')
    expect(c.slots).toEqual(['CB', 'ST'])
    // 서로 남의 자리로 가면 합계 적합도가 떨어진다 — **수치만** 적는다.
    expect(c.readout).toMatch(/합계 적합도 -\d/)
  })

  // ── 결론은 유저가 낸다(사용자 지시 2026-08-01) ─────────────────────────
  // *"이런 거 너무 과도한 개입이야. 사용자가 판단해서 즐길 수 있게 해."*
  // 화자가 없는 UI가 단정하면 조언이 아니라 판정이다. 사실은 남기고 단정만 뺀다.
  // 이 테스트가 그 경계를 고정한다 — 문구를 되돌리려면 이 줄을 지워야 한다.
  it('★ 결론 문구가 없다 — 어떤 조합에서도 UI가 대신 판단하지 않는다', () => {
    const cases = [
      buildCompare({ a: cb, aSlot: 'CB', b: st0, bSlot: 'ST' }),          // swap 음수
      buildCompare({ a: st0, aSlot: 'CB', b: cb, bSlot: 'ST' }),          // swap 양수
      buildCompare({ a: st0, aSlot: 'ST', b: st1 }),                      // sub 대등
      buildCompare({ a: cb, aSlot: 'ST', b: st0 }),                       // sub 차이 큼
      buildCompare({ a: st0, b: st1 }),                                   // 둘 다 벤치
      buildCompare({ a: st0, aSlot: 'ST', b: st1, stamina: { [st0.id]: 55, [st1.id]: 95 } }),
    ]
    // "낫습니다"·"권합니다"·"좋습니다"는 결론이고, "하십시오"는 지시다.
    const VERDICT = /낫습니다|권합니다|좋습니다|하십시오|하세요|추천/
    for (const c of cases) expect(c.readout).not.toMatch(VERDICT)
  })

  it('선발+벤치 → 교체하기, 빠지는 선발의 자리가 기준이고 두 수치가 이름과 함께 적힌다', () => {
    const c = buildCompare({ a: cb, aSlot: 'ST', b: st0 })
    expect(c.kind).toBe('sub')
    expect(c.actionLabel).toBe('교체하기')
    expect(c.slots).toEqual(['ST'])
    expect(c.fitness!.label).toBe('ST 적합도')
    // 누가 낫다고 말하지 않는다 — 두 사람의 수치를 나란히 적고 차이를 밝힌다.
    expect(c.readout).toContain(st0.name.ko)
    expect(c.readout).toContain(cb.name.ko)
    expect(c.readout).toMatch(/차 \d\.\d\d/)
  })

  it('벤치+벤치 → 기준 자리가 없고 적합도 줄도 없다', () => {
    const c = buildCompare({ a: st0, b: st1 })
    expect(c.kind).toBe('none')
    expect(c.fitness).toBeNull()
    expect(c.readout).toContain('둘 다 벤치')
  })

  it('적합도가 대등하면 체력을 함께 적는다(어느 쪽인지는 말하지 않는다)', () => {
    const c = buildCompare({
      a: st0, aSlot: 'ST', b: st1,
      stamina: { [st0.id]: 55, [st1.id]: 95 },
    })
    expect(c.readout).toContain('체력')
    expect(c.readout).toContain('55%')
    expect(c.readout).toContain('95%')
  })

  it('GK와 필드 선수는 능력치를 겹치지 않고 이유를 말한다', () => {
    const c = buildCompare({ a: gk, aSlot: 'GK', b: st0 })
    expect(c.axes).toHaveLength(0)
    expect(c.note).toContain('축이 달라')
    // 적합도는 스탯이 아니라 포지션에서 나오므로 GK↔필드에서도 계산된다.
    expect(c.fitness).not.toBeNull()
  })

  it('컨디션·징계 줄은 값이 있을 때만 만들어진다', () => {
    const bare = buildCompare({ a: st0, aSlot: 'ST', b: st1 })
    expect(bare.condition).toHaveLength(0)
    const full = buildCompare({
      a: st0, aSlot: 'ST', b: st1,
      stamina: { [st0.id]: 60, [st1.id]: 90 },
      morale: { [st0.id]: 70, [st1.id]: 50 },
      cautions: { [st0.id]: 1 },
    })
    expect(full.condition.map(x => x.key)).toEqual(['stamina', 'morale', 'caution'])
    // 경고는 적을수록 좋다.
    expect(metricDiff(full.condition[2]).winner).toBe('b')
  })

  // ── 이 경기 기록 (작전판 전용 — 규약 문서 §작전판이 추가해야 할 것) ──
  const EMPTY_MS = { shots: 0, shotsOnTarget: 0, goals: 0, assists: 0, fouls: 0, yellows: 0, reds: 0, saves: 0 }

  it('matchStats 미지정이면 이 경기 줄이 없다(킥오프 전에는 전원 0이라 무의미하다)', () => {
    expect(buildCompare({ a: st0, aSlot: 'ST', b: st1 }).match).toHaveLength(0)
  })

  it('두 선수 다 0인 지표는 줄을 만들지 않는다', () => {
    const c = buildCompare({
      a: st0, aSlot: 'ST', b: st1,
      matchStats: { [st0.id]: { ...EMPTY_MS }, [st1.id]: { ...EMPTY_MS } },
    })
    expect(c.match).toHaveLength(0)
  })

  it('골·슛·파울은 실제 분포에 맞는 span으로 잰다(능력치 span 30을 쓰면 막대가 안 보인다)', () => {
    const c = buildCompare({
      a: st0, aSlot: 'ST', b: st1,
      matchStats: {
        [st0.id]: { ...EMPTY_MS, goals: 1, shots: 3, fouls: 0 },
        [st1.id]: { ...EMPTY_MS, goals: 0, shots: 1, fouls: 3 },
      },
    })
    expect(c.match.map(m => m.key)).toEqual(['m-goals', 'm-shots', 'm-fouls'])
    const goals = c.match[0]
    expect(goals.span).toBe(2)
    // 1골 차이면 막대가 절반은 차야 한다(30으로 재면 3%다).
    expect(metricDiff(goals).ratio).toBeCloseTo(0.5)
    // 파울은 적을수록 좋다 — 0개인 a가 이긴다.
    expect(metricDiff(c.match[2]).winner).toBe('a')
  })
})
