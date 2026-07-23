// src/engine/__tests__/rng.test.ts
import { describe, it, expect } from 'vitest'
import { createRng } from '../rng'

describe('createRng', () => {
  it('같은 시드는 같은 수열을 낸다 (결정론)', () => {
    const a = createRng(42), b = createRng(42)
    const seqA = Array.from({ length: 100 }, () => a.next())
    const seqB = Array.from({ length: 100 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })
  it('다른 시드는 다른 수열', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next())
  })
  it('next()는 [0,1) 범위', () => {
    const r = createRng(7)
    for (let i = 0; i < 1000; i++) { const v = r.next(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
  it('int(1,10)은 1~10 정수', () => {
    const r = createRng(7)
    for (let i = 0; i < 500; i++) { const v = r.int(1, 10); expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(10); expect(Number.isInteger(v)).toBe(true) }
  })
  it('weighted는 가중치 0 항목을 뽑지 않는다', () => {
    const r = createRng(7)
    for (let i = 0; i < 200; i++) expect(r.weighted([{ item: 'a', w: 0 }, { item: 'b', w: 1 }])).toBe('b')
  })
})
