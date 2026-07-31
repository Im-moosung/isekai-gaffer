// @vitest-environment jsdom
// 3D 선수 이름표 — "그 크기에서 읽히면서 화면을 덮지 않는다"의 계약.
//
// 두 층을 따로 고정한다.
//  · 순수 배치(plateFontPx·layoutPlates) — 겹침·상한·표시 여부. three도 DOM도 필요 없다.
//  · DOM 레이어(createNameplateLayer) — 풀링·숨김·정리.
import { describe, it, expect } from 'vitest'
import { LABEL_H_RATIO } from '../../labels'
import {
  FONT_MAX_PX, FONT_MIN_PX, MAX_PLATES, MIN_PLAYER_PX,
  createNameplateLayer, layoutPlates, plateFontPx, plateWidthPx,
  type PlateItem,
} from '../nameplates'

const W = 1600
const H = 900

function item(over: Partial<PlateItem> & { id: string }): PlateItem {
  return {
    side: 'home', text: '김민재', sx: 800, sy: 450, playerPx: 46, inFront: true, rank: 0,
    ...over,
  }
}

/** 배치된 라벨의 화면 박스 — labels.ts의 boxAt과 같은 규칙. */
function boxOf(p: { x: number; y: number; text: string; fontPx: number }) {
  const w = plateWidthPx(p.text, p.fontPx)
  const h = p.fontPx * LABEL_H_RATIO
  return { x: p.x - w / 2, y: p.y - h / 2, w, h }
}
const overlaps = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('plateFontPx — 화면 크기가 표시 여부와 글자 크기를 정한다', () => {
  it('와이드 샷(선수가 작다)에서는 이름표를 달지 않는다', () => {
    expect(plateFontPx(MIN_PLAYER_PX - 1)).toBeNull()
    expect(plateFontPx(12)).toBeNull()
    expect(plateFontPx(0)).toBeNull()
    expect(plateFontPx(Number.NaN)).toBeNull()
  })

  it('방송 타이트 샷(선수 40~52 px)에서 글자가 11~14 px이다', () => {
    for (const px of [40, 44, 48, 52]) {
      const f = plateFontPx(px)!
      expect(f, `${px}px 선수`).toBeGreaterThanOrEqual(11)
      expect(f, `${px}px 선수`).toBeLessThanOrEqual(14)
    }
  })

  it('아무리 가까워도 상한, 아무리 멀어도(표시되는 한) 하한을 지킨다', () => {
    expect(plateFontPx(400)).toBe(FONT_MAX_PX)
    expect(plateFontPx(MIN_PLAYER_PX)).toBeGreaterThanOrEqual(FONT_MIN_PX)
  })

  it('선수가 클수록 글자도 크다(단조)', () => {
    let prev = 0
    for (let px = MIN_PLAYER_PX; px <= 120; px += 4) {
      const f = plateFontPx(px)!
      expect(f).toBeGreaterThanOrEqual(prev)
      prev = f
    }
  })
})

describe('layoutPlates — 겹치지 않고, 화면을 덮지 않는다', () => {
  it('★ 22명을 한 점에 몰아넣어도 배치된 이름표는 서로 겹치지 않는다', () => {
    const items = Array.from({ length: 22 }, (_, i) =>
      item({ id: `p${i}`, sx: 800 + (i % 3) * 6, sy: 450 + Math.floor(i / 3) * 4, rank: i }))
    const { placed } = layoutPlates(items, W, H)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(boxOf(placed[i]), boxOf(placed[j])), `${placed[i].id}↔${placed[j].id}`).toBe(false)
      }
    }
  })

  it('★ 한 프레임에 MAX_PLATES를 넘지 않는다 — 22개가 다 뜨면 잔디가 안 보인다', () => {
    // 서로 멀리 떨어뜨려 겹침으로는 안 잘리게 두고, 상한만 검사한다.
    const items = Array.from({ length: 22 }, (_, i) =>
      item({ id: `p${i}`, sx: 60 + (i % 6) * 250, sy: 80 + Math.floor(i / 6) * 200, rank: i }))
    const { placed } = layoutPlates(items, W, H)
    expect(placed.length).toBeLessThanOrEqual(MAX_PLATES)
    expect(placed.length).toBeGreaterThan(6)
  })

  it('상한에 걸리면 볼에서 먼 선수부터 잘린다', () => {
    const items = Array.from({ length: 22 }, (_, i) =>
      item({ id: `p${i}`, sx: 60 + (i % 6) * 250, sy: 80 + Math.floor(i / 6) * 200, rank: i }))
    const kept = new Set(layoutPlates(items, W, H).placed.map(p => p.id))
    expect(kept.has('p0')).toBe(true)
    expect(kept.has('p21')).toBe(false)
  })

  it('카메라 뒤·화면 밖·이름 없음은 아예 후보가 아니다', () => {
    const { placed } = layoutPlates([
      item({ id: 'behind', inFront: false }),
      item({ id: 'offLeft', sx: -300 }),
      item({ id: 'offRight', sx: W + 300 }),
      item({ id: 'noName', text: '', sx: 400 }),
      item({ id: 'ok', sx: 400 }),
    ], W, H)
    expect(placed.map(p => p.id)).toEqual(['ok'])
  })

  it('와이드 샷에서는 하나도 달지 않는다', () => {
    const items = Array.from({ length: 22 }, (_, i) =>
      item({ id: `p${i}`, sx: 100 + i * 60, sy: 400, playerPx: 18, rank: i }))
    expect(layoutPlates(items, W, H).placed).toHaveLength(0)
  })

  it('이름표는 선수 머리 위에 뜬다(1순위 자리)', () => {
    const { placed } = layoutPlates([item({ id: 'solo', sy: 450 })], W, H)
    expect(placed).toHaveLength(1)
    expect(placed[0].y).toBeLessThan(450)
  })

  it('전부 화면 안에 들어온다(가장자리 선수 이름이 잘리지 않는다)', () => {
    const items = [
      item({ id: 'edgeL', sx: 6, sy: 30 }),
      item({ id: 'edgeR', sx: W - 6, sy: H - 20 }),
    ]
    for (const p of layoutPlates(items, W, H).placed) {
      const b = boxOf(p)
      expect(b.x).toBeGreaterThanOrEqual(-0.001)
      expect(b.y).toBeGreaterThanOrEqual(-0.001)
      expect(b.x + b.w).toBeLessThanOrEqual(W + 0.001)
      expect(b.y + b.h).toBeLessThanOrEqual(H + 0.001)
    }
  })

  it('같은 입력이면 같은 결과다(결정론)', () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({ id: `p${i}`, sx: 700 + (i % 4) * 20, sy: 400 + Math.floor(i / 4) * 18, rank: i }))
    expect(layoutPlates(items, W, H).placed).toEqual(layoutPlates(items, W, H).placed)
  })

  it('sticky가 있으면 같은 자리를 유지한다 — 라벨이 매 프레임 위아래로 튀지 않는다', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item({ id: `p${i}`, sx: 700 + (i % 2) * 14, sy: 400 + Math.floor(i / 2) * 12, rank: i }))
    const first = layoutPlates(items, W, H)
    // 아주 조금 움직인 다음 프레임.
    const moved = items.map(p => ({ ...p, sx: p.sx + 0.7, sy: p.sy - 0.4 }))
    const second = layoutPlates(moved, W, H, first.slots)
    for (const [id, slot] of first.slots) {
      if (second.slots.has(id)) expect(second.slots.get(id), id).toBe(slot)
    }
  })
})

describe('createNameplateLayer — DOM 오버레이', () => {
  const mount = () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return { host, layer: createNameplateLayer(host) }
  }

  it('호스트에 오버레이를 붙이고 dispose로 되돌린다', () => {
    const { host, layer } = mount()
    expect(host.querySelector('.m3d-plates')).not.toBeNull()
    layer.dispose()
    expect(host.querySelector('.m3d-plates')).toBeNull()
    host.remove()
  })

  it('오버레이는 포인터를 먹지 않고 스크린리더에서도 숨는다', () => {
    const { host, layer } = mount()
    const root = host.querySelector('.m3d-plates')!
    // 이름표는 캔버스 위 장식이다 — 같은 정보를 스코어보드·라인업이 텍스트로 제공한다.
    expect(root.getAttribute('aria-hidden')).toBe('true')
    layer.dispose()
    host.remove()
  })

  it('★ div를 풀링한다 — 프레임마다 만들고 지우지 않는다', () => {
    const { host, layer } = mount()
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ id: `p${i}`, sx: 100 + i * 130, sy: 300, rank: i }))
    layer.update(items, W, H)
    const after1 = host.querySelectorAll('.m3d-plate').length
    for (let k = 0; k < 30; k++) layer.update(items.map(p => ({ ...p, sx: p.sx + k * 0.3 })), W, H)
    expect(host.querySelectorAll('.m3d-plate').length).toBe(after1)
    layer.dispose()
    host.remove()
  })

  it('사라진 선수의 이름표는 숨는다(엘리먼트는 남긴다 — 재등장 대비)', () => {
    const { host, layer } = mount()
    layer.update([item({ id: 'a', sx: 300 }), item({ id: 'b', sx: 900 })], W, H)
    expect(layer.count).toBe(2)
    layer.update([item({ id: 'a', sx: 300 })], W, H)
    expect(layer.count).toBe(1)
    const els = [...host.querySelectorAll<HTMLElement>('.m3d-plate')]
    expect(els).toHaveLength(2)
    expect(els.filter(e => e.style.opacity === '0')).toHaveLength(1)
    layer.dispose()
    host.remove()
  })

  it('clear는 전부 숨긴다(입장 연출·성능 강등)', () => {
    const { host, layer } = mount()
    layer.update([item({ id: 'a', sx: 300 }), item({ id: 'b', sx: 900 })], W, H)
    layer.clear()
    expect(layer.count).toBe(0)
    for (const e of host.querySelectorAll<HTMLElement>('.m3d-plate')) expect(e.style.opacity).toBe('0')
    layer.dispose()
    host.remove()
  })

  it('양 팀 모두 이름표를 달고 팀색 모디파이어가 붙는다', () => {
    const { host, layer } = mount()
    layer.update([
      item({ id: 'h', side: 'home', sx: 400 }),
      item({ id: 'a', side: 'away', sx: 1000, text: '페드리' }),
    ], W, H)
    expect(host.querySelector('.m3d-plate--home')).not.toBeNull()
    expect(host.querySelector('.m3d-plate--away')).not.toBeNull()
    layer.dispose()
    host.remove()
  })

  it('레이아웃을 유발하는 속성을 매 프레임 건드리지 않는다(transform·opacity·font-size만)', () => {
    const { host, layer } = mount()
    layer.update([item({ id: 'a', sx: 400 })], W, H)
    const el = host.querySelector<HTMLElement>('.m3d-plate')!
    expect([...el.style].sort()).toEqual(['font-size', 'opacity', 'transform'])
    expect(el.style.transform).toMatch(/translate3d\(/)
    layer.dispose()
    host.remove()
  })

  it('크기가 0인 캔버스에서는 아무것도 하지 않는다(초기 마운트·숨김 탭)', () => {
    const { host, layer } = mount()
    layer.update([item({ id: 'a' })], 0, 0)
    expect(layer.count).toBe(0)
    layer.dispose()
    host.remove()
  })
})
