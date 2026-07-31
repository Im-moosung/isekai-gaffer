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
    // 서로 남의 자리로 가면 합계 적합도가 떨어지므로 "지금 배치가 낫다"고 말한다.
    expect(c.verdict).toContain('지금 배치가 낫습니다')
    // 자리 교환은 "누가 낫다"가 아니므로 방향은 없지만, 결론 자체는 단호하다.
    expect(c.verdictSide).toBe('tie')
    expect(c.decisive).toBe(true)
  })

  it('우열이 없을 때만 결론의 톤이 낮아진다(decisive=false)', () => {
    const c = buildCompare({ a: st0, aSlot: 'ST', b: st1 })
    expect(c.verdictSide).toBe('tie')
    expect(c.decisive).toBe(false)
  })

  it('선발+벤치 → 교체하기, 빠지는 선발의 자리가 기준이고 결론이 이름을 부른다', () => {
    const c = buildCompare({ a: cb, aSlot: 'ST', b: st0 })
    expect(c.kind).toBe('sub')
    expect(c.actionLabel).toBe('교체하기')
    expect(c.slots).toEqual(['ST'])
    expect(c.fitness!.label).toBe('ST 적합도')
    // ST 자리에는 ST가 맞다 — 벤치 쪽(b)이 이긴다.
    expect(c.verdictSide).toBe('b')
    expect(c.verdict).toContain(st0.name.ko)
  })

  it('벤치+벤치 → 기준 자리가 없고 적합도 줄도 없다', () => {
    const c = buildCompare({ a: st0, b: st1 })
    expect(c.kind).toBe('none')
    expect(c.fitness).toBeNull()
    expect(c.verdict).toContain('둘 다 벤치')
  })

  it('적합도가 같으면 체력이 결론을 가른다', () => {
    const c = buildCompare({
      a: st0, aSlot: 'ST', b: st1,
      stamina: { [st0.id]: 55, [st1.id]: 95 },
    })
    expect(c.verdictSide).toBe('b')
    expect(c.verdict).toContain('체력')
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
})
