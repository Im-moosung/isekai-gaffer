// 전술 수치 → 팀 블록 형태(shape.ts). "슬라이더를 만지면 도트가 움직인다"의 계약 고정.
import { describe, it, expect } from 'vitest'
import type { FormationId, Instructions } from '../../../engine/types'
import { XI_SLOTS, slotCoords } from '../formations'
import { backlineIndices, lineDepth, pressReach, tacticalCoords } from '../shape'

const FORMATIONS = Object.keys(XI_SLOTS) as FormationId[]
const ins = (o: Partial<Instructions> = {}): Instructions =>
  ({ lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced', ...o })

/** home 프레임 전체 좌표. */
const xi = (f: FormationId, i: Instructions) =>
  XI_SLOTS[f].map((_, k) => tacticalCoords(f, k, 'home', i))

/** GK를 뺀 최후방 4명의 평균 x — 작전판에서 "수비진이 서 있는 곳"으로 읽히는 값. */
function rearFourMeanX(f: FormationId, i: Instructions): number {
  const xs = xi(f, i).slice(1).map(c => c.x).sort((a, b) => a - b)
  return xs.slice(0, 4).reduce((s, v) => s + v, 0) / 4
}

describe('lineDepth·pressReach', () => {
  it('단조 증가하며 피치 안에 머문다', () => {
    expect(lineDepth(0)).toBeLessThan(lineDepth(100))
    expect(lineDepth(100)).toBeLessThan(50)
    expect(pressReach(0)).toBeLessThan(pressReach(100))
  })
})

describe('★ R4 — 수비 라인 마커가 실제 수비진 도트 위를 지난다', () => {
  it('백라인 평균 x가 lineDepth(lineHeight)와 정확히 같다(전 포메이션·전 구간)', () => {
    for (const f of FORMATIONS) {
      const idx = backlineIndices(f)
      expect(idx.length, f).toBeGreaterThanOrEqual(3)
      for (let L = 0; L <= 100; L += 5) {
        for (const p of [0, 50, 100]) {
          const i = ins({ lineHeight: L, pressing: p })
          const mean = idx.reduce((s, k) => s + tacticalCoords(f, k, 'home', i).x, 0) / idx.length
          expect(mean, `${f} L=${L} P=${p}`).toBeCloseTo(lineDepth(L), 6)
        }
      }
    }
  })

  it('4백 포메이션은 최후방 4명 평균 = 마커(오차 0.01 이내)', () => {
    for (const f of FORMATIONS) {
      if (backlineIndices(f).length !== 4) continue
      for (let L = 10; L <= 90; L += 10) {
        expect(rearFourMeanX(f, ins({ lineHeight: L })), `${f} L=${L}`).toBeCloseTo(lineDepth(L), 2)
      }
    }
  })

  it('3백·5백도 최후방 4명 평균이 마커에서 6 이내(수비형 MF가 4번째로 끼는 경우)', () => {
    for (const f of FORMATIONS) {
      for (let L = 10; L <= 90; L += 10) {
        const d = Math.abs(rearFourMeanX(f, ins({ lineHeight: L })) - lineDepth(L))
        expect(d, `${f} L=${L}`).toBeLessThan(6)
      }
    }
  })
})

describe('★ R1 — 팀 블록이 lineHeight를 따라간다', () => {
  it('라인을 올리면 모든 라인이 전진하지만 수비진이 가장 많이 올라간다(블록 압축)', () => {
    for (const f of FORMATIONS) {
      const lo = xi(f, ins({ lineHeight: 10 }))
      const hi = xi(f, ins({ lineHeight: 90 }))
      for (let k = 0; k < lo.length; k++) expect(hi[k].x, `${f}[${k}]`).toBeGreaterThan(lo[k].x)
      const dDef = hi[1].x - lo[1].x            // CB
      const dAtt = hi[10].x - lo[10].x          // 최전방 슬롯
      expect(dDef, f).toBeGreaterThan(dAtt * 2) // 통짜 평행이동 금지
      // 블록 길이(최후방~최전방)는 하이 라인에서 짧아진다.
      const span = (cs: { x: number }[]) => Math.max(...cs.map(c => c.x)) - Math.min(...cs.slice(1).map(c => c.x))
      expect(span(hi), f).toBeLessThan(span(lo))
    }
  })

  it('슬라이더 전 구간이 화면에서 유의미하다(수비진이 20 이상 이동)', () => {
    const d = tacticalCoords('4-3-3', 1, 'home', ins({ lineHeight: 100 })).x
      - tacticalCoords('4-3-3', 1, 'home', ins({ lineHeight: 0 })).x
    expect(d).toBeGreaterThan(20)
  })
})

describe('★ R3 — pressing이 형태를 바꾼다', () => {
  it('압박을 올리면 중원이 앞으로 기울고(백라인은 라인 슬라이더 전용) 폭이 좁아진다', () => {
    const f: FormationId = '4-3-3'
    const lo = xi(f, ins({ pressing: 10 }))
    const hi = xi(f, ins({ pressing: 90 }))
    // 백라인 x는 불변 — 마커-도트 일치 계약을 압박이 깨뜨리면 안 된다.
    for (const k of backlineIndices(f)) expect(hi[k].x).toBeCloseTo(lo[k].x, 6)
    // 중원은 전진.
    expect(hi[5].x).toBeGreaterThan(lo[5].x + 2)
    // 좌우 폭 축소.
    const width = (cs: { y: number }[]) => Math.max(...cs.map(c => c.y)) - Math.min(...cs.map(c => c.y))
    expect(width(hi)).toBeLessThan(width(lo) - 3)
  })
})

describe('좌표 계약', () => {
  it('away는 x 미러, y는 동일하고 극단값에서도 피치 안이다', () => {
    for (const f of FORMATIONS) {
      for (const L of [0, 50, 100]) {
        for (const p of [0, 50, 100]) {
          const i = ins({ lineHeight: L, pressing: p })
          for (let k = 0; k < 11; k++) {
            const h = tacticalCoords(f, k, 'home', i)
            const a = tacticalCoords(f, k, 'away', i)
            expect(a.x).toBeCloseTo(100 - h.x, 6)
            expect(a.y).toBe(h.y)
            expect(h.x).toBeGreaterThanOrEqual(0)
            expect(h.x).toBeLessThanOrEqual(100)
            expect(h.y).toBeGreaterThanOrEqual(0)
            expect(h.y).toBeLessThanOrEqual(100)
          }
        }
      }
    }
  })

  it('중립값(라인 50·압박 50)에서는 포메이션 원형에서 크게 벗어나지 않는다(3D 장면과의 연속성)', () => {
    for (const f of FORMATIONS) {
      for (let k = 0; k < 11; k++) {
        const base = slotCoords(f, k, 'home')
        const t = tacticalCoords(f, k, 'home', ins())
        expect(Math.hypot(t.x - base.x, t.y - base.y), `${f}[${k}]`).toBeLessThan(5)
      }
    }
  })
})
