import { describe, it, expect } from 'vitest'
import { spawnBurst, stepParticles, particleAlpha } from '../fx'

describe('spawnBurst', () => {
  it('기본 40+개 파티클(브리프 요구)', () => {
    expect(spawnBurst(50, 34, 0xff0000).length).toBeGreaterThanOrEqual(40)
  })

  it('개수 지정 가능', () => {
    expect(spawnBurst(0, 0, 0xffffff, { count: 60 })).toHaveLength(60)
  })

  it('모든 파티클이 원점에서 시작·색 상속·양의 수명', () => {
    const ps = spawnBurst(50, 34, 0x4895ef, { count: 20 })
    for (const p of ps) {
      expect(p.x).toBe(50)
      expect(p.y).toBe(34)
      expect(p.color).toBe(0x4895ef)
      expect(p.life).toBeGreaterThan(0)
      expect(p.life).toBe(p.maxLife)
    }
  })

  it('결정론 — 같은 입력 같은 출력(Math.random 없음)', () => {
    expect(spawnBurst(10, 20, 0x123456, { count: 30 }))
      .toEqual(spawnBurst(10, 20, 0x123456, { count: 30 }))
  })

  it('방사형 — 속도 벡터가 한 방향에 몰리지 않는다', () => {
    const ps = spawnBurst(0, 0, 0xffffff, { count: 40, upward: 0 })
    const left = ps.filter(p => p.vx < 0).length
    const right = ps.filter(p => p.vx > 0).length
    expect(left).toBeGreaterThan(5)
    expect(right).toBeGreaterThan(5)
  })
})

describe('stepParticles', () => {
  it('중력이 vy를 증가시키고 위치를 이동', () => {
    const ps = [{ x: 0, y: 0, vx: 10, vy: 0, life: 1, maxLife: 1, size: 1, color: 0 }]
    const after = stepParticles(ps, 0.1, 60)
    expect(after[0].vy).toBeCloseTo(6, 6) // 60*0.1
    expect(after[0].x).toBeCloseTo(1, 6)  // 10*0.1
    expect(after[0].life).toBeCloseTo(0.9, 6)
  })

  it('수명 소진 파티클은 제거', () => {
    const ps = [
      { x: 0, y: 0, vx: 0, vy: 0, life: 0.05, maxLife: 1, size: 1, color: 0 },
      { x: 0, y: 0, vx: 0, vy: 0, life: 0.5, maxLife: 1, size: 1, color: 0 },
    ]
    const after = stepParticles(ps, 0.1)
    expect(after).toHaveLength(1)
  })
})

describe('particleAlpha', () => {
  it('수명 비율(0~1)', () => {
    expect(particleAlpha({ x: 0, y: 0, vx: 0, vy: 0, life: 0.5, maxLife: 1, size: 1, color: 0 })).toBe(0.5)
    expect(particleAlpha({ x: 0, y: 0, vx: 0, vy: 0, life: 2, maxLife: 1, size: 1, color: 0 })).toBe(1)
    expect(particleAlpha({ x: 0, y: 0, vx: 0, vy: 0, life: -1, maxLife: 1, size: 1, color: 0 })).toBe(0)
  })
})
