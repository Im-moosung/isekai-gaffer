// 라이브 무브먼트(shape.liveTeamCoords) — "공만 왔다갔다 하고 선수는 정지" 회귀 방지.
// 계약: ① 실제로 움직인다 ② 과하지 않다 ③ 결정론 ④ 마커-도트 일치를 깨지 않는다.
import { describe, it, expect } from 'vitest'
import type { FormationId, Instructions } from '../../../engine/types'
import { XI_SLOTS } from '../formations'
import { backlineIndices, blockMetrics, liveBacklineX, liveTeamCoords, tacticalCoords } from '../shape'

const FORMATIONS = Object.keys(XI_SLOTS) as FormationId[]
const ins = (o: Partial<Instructions> = {}): Instructions =>
  ({ lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced', ...o })

/** 0~30초를 0.1초(=틱)로 훑는다. */
const TIMES = Array.from({ length: 301 }, (_, k) => k * 0.1)

describe('★ 선수가 움직인다 — 그러나 조금만', () => {
  it('모든 선수가 시간에 따라 실제로 위치를 바꾼다(정지 도트 금지)', () => {
    for (const f of FORMATIONS) {
      for (const side of ['home', 'away'] as const) {
        const track = TIMES.map(t => liveTeamCoords(f, side, ins(), { t }))
        for (let i = 0; i < track[0].length; i++) {
          const xs = track.map(c => c[i].x)
          const ys = track.map(c => c[i].y)
          const span = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)
          expect(span, `${f}/${side}[${i}]`).toBeGreaterThan(0.6)
        }
      }
    }
  })

  it('진폭 상한 — 전술 위치에서 최대 2.0(≈2m)을 넘지 않는다(공이 없을 때)', () => {
    for (const f of FORMATIONS) {
      for (const t of TIMES) {
        const live = liveTeamCoords(f, 'home', ins(), { t })
        for (let i = 0; i < live.length; i++) {
          const base = tacticalCoords(f, i, 'home', ins())
          expect(Math.abs(live[i].x - base.x), `${f}[${i}] x @${t}`).toBeLessThanOrEqual(2.0)
          expect(Math.abs(live[i].y - base.y), `${f}[${i}] y @${t}`).toBeLessThanOrEqual(2.0)
        }
      }
    }
  })

  it('블록 형태를 무너뜨리지 않는다 — 라인 순서(수비<중원<공격)가 유지된다', () => {
    for (const t of TIMES) {
      const c = liveTeamCoords('4-3-3', 'home', ins(), { t })
      const def = backlineIndices('4-3-3').reduce((s, i) => s + c[i].x, 0) / 4
      const att = (c[8].x + c[9].x + c[10].x) / 3
      expect(def).toBeLessThan(att)
    }
  })
})

describe('★ 공·점유에 따라 블록이 함께 이동한다', () => {
  const at = (ball: { x: number; y: number }, possess = 0) =>
    liveTeamCoords('4-3-3', 'home', ins(), { t: 0, ball, possess })
  const meanY = (cs: { y: number }[]) => cs.reduce((s, c) => s + c.y, 0) / cs.length
  const meanX = (cs: { x: number }[]) => cs.reduce((s, c) => s + c.x, 0) / cs.length

  it('공이 왼쪽에 있으면 팀이 왼쪽으로 쏠린다', () => {
    expect(meanY(at({ x: 50, y: 12 }))).toBeLessThan(meanY(at({ x: 50, y: 88 })) - 8)
  })

  it('공이 전방에 있으면 블록이 전진한다', () => {
    expect(meanX(at({ x: 85, y: 50 }))).toBeGreaterThan(meanX(at({ x: 15, y: 50 })) + 4)
  })

  it('점유 팀은 전진하고 비점유 팀은 물러선다', () => {
    const on = meanX(at({ x: 50, y: 50 }, 1))
    const off = meanX(at({ x: 50, y: 50 }, -1))
    expect(on).toBeGreaterThan(off + 2)
  })

  it('블록 이동을 다 합쳐도 피치 안이다', () => {
    for (const bx of [0, 25, 50, 75, 100]) {
      for (const by of [0, 50, 100]) {
        for (const L of [0, 50, 100]) {
          for (const side of ['home', 'away'] as const) {
            for (const c of liveTeamCoords('4-3-3', side, ins({ lineHeight: L }), { t: 7.3, ball: { x: bx, y: by }, possess: 1 })) {
              expect(c.x).toBeGreaterThanOrEqual(0)
              expect(c.x).toBeLessThanOrEqual(100)
              expect(c.y).toBeGreaterThanOrEqual(0)
              expect(c.y).toBeLessThanOrEqual(100)
            }
          }
        }
      }
    }
  })
})

describe('★ 결정론 — 같은 입력이면 같은 좌표', () => {
  it('Math.random 없이 재현된다', () => {
    const a = liveTeamCoords('4-2-3-1', 'home', ins(), { t: 12.7, ball: { x: 60, y: 30 }, possess: 1 })
    const b = liveTeamCoords('4-2-3-1', 'home', ins(), { t: 12.7, ball: { x: 60, y: 30 }, possess: 1 })
    expect(b).toEqual(a)
  })

  it('선수마다 위상이 달라 통짜로 흔들리지 않는다', () => {
    const c = liveTeamCoords('4-3-3', 'home', ins(), { t: 1.7 })
    const base = c.map((_, i) => tacticalCoords('4-3-3', i, 'home', ins()))
    const dys = c.map((p, i) => Number((p.y - base[i].y).toFixed(4)))
    expect(new Set(dys).size).toBeGreaterThan(8)
  })
})

describe('★ 마커-도트 일치 계약이 라이브에서도 유지된다', () => {
  it('liveBacklineX == 실제 백라인 도트 평균(전 포메이션·전 시각·공 있음)', () => {
    for (const f of FORMATIONS) {
      for (const side of ['home', 'away'] as const) {
        for (const t of [0, 1.3, 4.9, 11.1, 27.4]) {
          for (const L of [10, 50, 90]) {
            const live = { t, ball: { x: 70, y: 22 }, possess: 1 }
            const cs = liveTeamCoords(f, side, ins({ lineHeight: L }), live)
            const idx = backlineIndices(f)
            const mean = idx.reduce((s, i) => s + cs[i].x, 0) / idx.length
            expect(liveBacklineX(f, side, ins({ lineHeight: L }), live), `${f}/${side}`).toBeCloseTo(mean, 9)
          }
        }
      }
    }
  })

  // ★ 3D↔2D 전환 연속성. 3D(three/movement.planSide)도 같은 두 가지를 한다:
  //   ·볼 x에 따른 팀 라인 이동 `BALL_SHIFT = 8m`
  //   ·선수별 미세 흔들림 `cos(ph + clock*1.1) * 1.1m` (주기 5.7초·7.0초)
  // 2D의 envelope이 그보다 크면 전환 순간 선수가 튄다. 아래로 상한을 고정한다.
  it('라이브 이탈 폭이 3D의 이동 모델(볼 시프트 8m + 흔들림 1.1m)을 넘지 않는다', () => {
    let worstX = 0
    let worstY = 0
    for (const f of FORMATIONS) {
      for (const side of ['home', 'away'] as const) {
        for (const t of [0, 2.2, 5.7, 13.3]) {
          for (const bx of [0, 50, 100]) {
            for (const by of [0, 50, 100]) {
              const live = { t, ball: { x: bx, y: by }, possess: 1 }
              const cs = liveTeamCoords(f, side, ins(), live)
              for (let i = 0; i < cs.length; i++) {
                const base = tacticalCoords(f, i, side, ins())
                worstX = Math.max(worstX, Math.abs(cs[i].x - base.x) * 1.05) // 0~100 → m
                worstY = Math.max(worstY, Math.abs(cs[i].y - base.y) * 0.68)
              }
            }
          }
        }
      }
    }
    expect(worstX).toBeLessThanOrEqual(8.0) // 3D는 9.1(=8+1.1)까지 간다
    expect(worstY).toBeLessThanOrEqual(8.0)
  })

  it('t=0·공 없음이면 전술 좌표에서 2.3(≈2m) 이내다 — 2D↔3D 전환 시 위치가 튀지 않는다', () => {
    for (const f of FORMATIONS) {
      const cs = liveTeamCoords(f, 'home', ins(), { t: 0 })
      for (let i = 0; i < cs.length; i++) {
        const base = tacticalCoords(f, i, 'home', ins())
        expect(Math.hypot(cs[i].x - base.x, cs[i].y - base.y), `${f}[${i}]`).toBeLessThan(2.3)
      }
    }
  })
})

describe('blockMetrics', () => {
  it('라인을 올리면 블록이 짧아지고, 압박을 올리면 좁아진다', () => {
    const m = (L: number, P: number) => blockMetrics(liveTeamCoords('4-3-3', 'home', ins({ lineHeight: L, pressing: P })))
    expect(m(90, 50).lengthM).toBeLessThan(m(10, 50).lengthM)
    expect(m(50, 90).widthM).toBeLessThan(m(50, 10).widthM)
  })

  it('실제 축구의 범위(길이 25~78m, 폭 25~66m) 안이다', () => {
    for (const f of FORMATIONS) {
      for (const L of [0, 50, 100]) {
        for (const P of [0, 50, 100]) {
          const b = blockMetrics(liveTeamCoords(f, 'home', ins({ lineHeight: L, pressing: P }), { t: 3.3 }))
          expect(b.lengthM, `${f} L${L}`).toBeGreaterThan(25)
          expect(b.lengthM, `${f} L${L}`).toBeLessThan(78)
          expect(b.widthM, `${f} P${P}`).toBeGreaterThan(25)
          expect(b.widthM, `${f} P${P}`).toBeLessThan(66)
        }
      }
    }
  })
})
