// 피치 라벨 배치 패스(labels.ts) — "겹침 0"은 규칙이 아니라 **계약**이다.
import { describe, it, expect } from 'vitest'
import { layoutLabels, textWidth, type Box, type LabelReq } from '../labels'

const BOUNDS: Box = { x: 0.6, y: 0.6, w: 105 - 1.2, h: 68 - 1.2 }

const req = (id: string, ax: number, ay: number, text = '김문환', rank = 1): LabelReq => ({
  id, text, ax, ay, fontSize: 2.5, rank,
  slots: [{ dx: 0, dy: 5.2 }, { dx: 0, dy: -5.2 }, { dx: 0, dy: 8.1 }, { dx: 0, dy: -8.1 }],
})

function anyOverlap(boxes: Box[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true
    }
  }
  return false
}

describe('textWidth', () => {
  it('한글은 전각, 숫자·라틴은 반각으로 잰다', () => {
    expect(textWidth('가나다', 2)).toBeCloseTo(6, 6)
    expect(textWidth('123', 2)).toBeCloseTo(3.36, 6)
    expect(textWidth('', 2)).toBe(0)
  })
})

describe('★ 배치 계약 — 반환된 라벨은 서로도, 장애물과도 겹치지 않는다', () => {
  it('같은 자리에 20개를 몰아넣어도 겹침 0(자리 못 잡으면 버린다)', () => {
    const reqs = Array.from({ length: 20 }, (_, i) => req(`p${i}`, 50, 34))
    const { placed, dropped } = layoutLabels(reqs, BOUNDS)
    expect(anyOverlap(placed.map(p => p.box))).toBe(false)
    expect(placed.length + dropped.length).toBe(20)
    // 후보 자리가 4개뿐이니 대부분 버려진다 — 겹쳐 그리느니 안 그린다.
    expect(placed.length).toBeLessThanOrEqual(4)
  })

  it('장애물(도트)을 피한다', () => {
    const blocker: Box = { x: 48, y: 36, w: 6, h: 6 }
    const { placed } = layoutLabels([req('a', 50, 34)], BOUNDS, [blocker])
    expect(placed).toHaveLength(1)
    expect(anyOverlap([...placed.map(p => p.box), blocker])).toBe(false)
    expect(placed[0].slot).not.toBe(0) // 1순위(아래)가 막혀 다른 자리로 갔다
  })

  it('뷰박스 밖으로 나가지 않는다(측면 선수 이름이 잘리던 문제)', () => {
    for (const [x, y] of [[1, 1], [104, 67], [1, 67], [104, 1]] as [number, number][]) {
      const { placed } = layoutLabels([req('e', x, y)], BOUNDS)
      const b = placed[0].box
      expect(b.x).toBeGreaterThanOrEqual(BOUNDS.x - 1e-9)
      expect(b.y).toBeGreaterThanOrEqual(BOUNDS.y - 1e-9)
      expect(b.x + b.w).toBeLessThanOrEqual(BOUNDS.x + BOUNDS.w + 1e-9)
      expect(b.y + b.h).toBeLessThanOrEqual(BOUNDS.y + BOUNDS.h + 1e-9)
    }
  })

  it('rank가 낮은 라벨이 먼저 자리를 잡는다(라인 태그가 이름에 밀리지 않는다)', () => {
    const tag = req('tag', 50, 34, '우리 라인 50', 0)
    const name = req('name', 50, 34, '손흥민', 1)
    const { placed } = layoutLabels([name, tag], BOUNDS)
    expect(placed[0].id).toBe('tag')
    expect(placed[0].slot).toBe(0)
  })

  it('결정론 — 입력 순서를 바꿔도 같은 결과', () => {
    const reqs = [req('a', 40, 30), req('b', 41, 33), req('c', 39, 36)]
    const one = layoutLabels(reqs, BOUNDS)
    const two = layoutLabels([...reqs].reverse(), BOUNDS)
    expect(two.placed).toEqual(one.placed)
  })

  it('sticky는 미세 진동에서 라벨이 위아래로 튀는 걸 막는다', () => {
    const blockers = [{ x: 48, y: 36, w: 6, h: 6 }]
    const first = layoutLabels([req('a', 50, 34)], BOUNDS, blockers)
    const sticky = new Map([['a', first.placed[0].slot]])
    // 장애물이 사라져도 직전 자리를 유지한다(막히지 않는 한).
    const second = layoutLabels([req('a', 50, 34)], BOUNDS, [], sticky)
    expect(second.placed[0].slot).toBe(first.placed[0].slot)
  })
})
