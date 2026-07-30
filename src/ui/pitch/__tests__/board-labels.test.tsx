// @vitest-environment jsdom
// 2D 작전판의 **실측** 계약 두 가지.
//  ① 라벨 겹침 0 — 라인 태그와 선수 이름이 서로도, 도트와도 겹치지 않는다(감사 A-2/A-3).
//  ② 선수가 움직인다 — 공만 왔다갔다 하던 화면의 회귀 방지.
//
// 왜 뷰포트별로 재지 않는가: SVG가 고정 viewBox(105×68) + preserveAspectRatio="xMidYMid meet"
// 라 화면 크기는 **균일 스케일**일 뿐이다. viewBox 좌표에서 겹치지 않으면 어떤 뷰포트에서도
// 겹치지 않는다(브라우저 실주행으로 별도 확인).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { PitchView } from '../PitchView'
import { DOT_BLOCK_R, LABEL_H_RATIO, textWidth, type Box } from '../labels'
import { TAG_FS } from '../AnalysisLayer'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import type { FormationId } from '../../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NAME_FS = 2.5

function boxesOf(container: HTMLElement): { box: Box; label: string }[] {
  return [...container.querySelectorAll('.pv-labels text')].map(n => {
    const tag = n.classList.contains('an-line__tag')
    const fs = tag ? TAG_FS : NAME_FS
    const padX = tag ? 0.9 : 0.5
    const text = n.textContent ?? ''
    const w = textWidth(text, fs) + padX * 2
    const h = fs * LABEL_H_RATIO
    const x = Number(n.getAttribute('x'))
    const y = Number(n.getAttribute('y'))
    return { label: text, box: { x: x - w / 2, y: y - h / 2, w, h } }
  })
}

function firstOverlap(items: { box: Box; label: string }[]): string | null {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].box, b = items[j].box
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        return `${items[i].label} ↔ ${items[j].label}`
      }
    }
  }
  return null
}

function board(lineHeight: number, pressing = 50, formation?: FormationId) {
  const st = createMatch(home, away, { seed: 42 })
  st.home.tactics.instructions = { ...st.home.tactics.instructions, lineHeight, pressing }
  st.away.tactics.instructions = { ...st.away.tactics.instructions, lineHeight: 100 - lineHeight, pressing }
  if (formation) st.home.tactics.formation = formation
  return render(<PitchView state={st} variant="tactics" analysis nameLabels />)
}

describe('★ 라벨 겹침 0 — 라인 10~90 전 구간', () => {
  it('라인 태그와 선수 이름이 서로 겹치지 않는다', () => {
    for (let L = 10; L <= 90; L += 5) {
      const { container, unmount } = board(L)
      const items = boxesOf(container)
      expect(items.length, `라인 ${L}`).toBeGreaterThan(4)
      expect(firstOverlap(items), `라인 ${L}`).toBeNull()
      unmount()
    }
  })

  it('압박 전 구간 · 전 포메이션에서도 겹치지 않는다', () => {
    const forms: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
    for (const f of forms) {
      for (const P of [0, 50, 100]) {
        const { container, unmount } = board(50, P, f)
        expect(firstOverlap(boxesOf(container)), `${f} 압박 ${P}`).toBeNull()
        unmount()
      }
    }
  })

  it('라벨이 도트를 덮지 않는다(도트는 장애물로 등록된다)', () => {
    const { container } = board(50)
    const dots = [...container.querySelectorAll('.pv-dot')].map(n => ({
      label: 'dot',
      box: {
        x: Number(n.getAttribute('cx')) - DOT_BLOCK_R, y: Number(n.getAttribute('cy')) - DOT_BLOCK_R,
        w: DOT_BLOCK_R * 2, h: DOT_BLOCK_R * 2,
      },
    }))
    // 도트끼리의 겹침은 여기서 따지지 않는다(별건 A-7) — 라벨 ↔ 도트만 본다.
    for (const l of boxesOf(container)) {
      for (const d of dots) expect(firstOverlap([l, d]), l.label).toBeNull()
    }
  })

  it('라벨이 뷰박스 밖으로 나가지 않는다', () => {
    for (let L = 10; L <= 90; L += 20) {
      const { container, unmount } = board(L)
      for (const { box, label } of boxesOf(container)) {
        expect(box.x, label).toBeGreaterThanOrEqual(0)
        expect(box.y, label).toBeGreaterThanOrEqual(0)
        expect(box.x + box.w, label).toBeLessThanOrEqual(105)
        expect(box.y + box.h, label).toBeLessThanOrEqual(68)
      }
      unmount()
    }
  })

  it('라인 태그 2개는 서로 다른 띠(상단/하단)에 앉는다 — mirror ? 99 : 99 no-op 회귀 방지', () => {
    const { container } = board(50)
    const tags = [...container.querySelectorAll('.an-line__tag')]
    expect(tags).toHaveLength(2)
    const ys = tags.map(n => Number(n.getAttribute('y')))
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(40)
  })

  it('선수 이름은 최소 8명 이상 표시된다(회피가 라벨을 다 지워버리지 않는다)', () => {
    for (let L = 10; L <= 90; L += 10) {
      const { container, unmount } = board(L)
      const names = container.querySelectorAll('.pv-name').length
      expect(names, `라인 ${L}`).toBeGreaterThanOrEqual(8)
      unmount()
    }
  })

  it('가장 혼잡한 포메이션(5-4-1 로우블록)에서도 7명 이상은 남는다', () => {
    const forms: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
    for (const f of forms) {
      for (const P of [0, 50, 100]) {
        for (const L of [10, 50, 90]) {
          const { container, unmount } = board(L, P, f)
          expect(container.querySelectorAll('.pv-name').length, `${f} L${L} P${P}`).toBeGreaterThanOrEqual(7)
          unmount()
        }
      }
    }
  })
})

/** rAF를 수동으로 돌린다 — 라이브 클럭이 setInterval이 아니라 rAF에 물려 있다
 *  (그래야 MatchScreen 재생 체인의 "다음 타이머"를 가로채지 않는다). */
function installRaf() {
  let cbs: FrameRequestCallback[] = []
  let n = 1
  const map = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = n++; map.set(id, cb); cbs.push(cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { const cb = map.get(id); map.delete(id); cbs = cbs.filter(c => c !== cb) })
  return (frames: number) => {
    for (let i = 0; i < frames; i++) {
      const run = cbs
      cbs = []
      act(() => { run.forEach(cb => cb(0)) })
    }
  }
}

describe('★ 선수가 움직인다 — 공만 왔다갔다 하지 않는다', () => {
  it('작전판에서는 프레임이 흐르면 도트 좌표가 바뀐다', () => {
    const tick = installRaf()
    const st = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={st} variant="tactics" analysis />)
    const snap = () => [...container.querySelectorAll('.pv-dot')].map(n => `${n.getAttribute('cx')},${n.getAttribute('cy')}`)
    const a = snap()
    tick(36) // 0.6초분
    const b = snap()
    expect(b).not.toEqual(a)
    // 22명 중 대부분이 움직였다(한두 명만 떠는 게 아니다).
    expect(a.filter((v, i) => v !== b[i]).length).toBeGreaterThan(18)
  })

  it('작전판이 아니면(방송 2D·전술판) 도트는 정지해 있다 — 3D와 좌표가 같아야 한다', () => {
    const tick = installRaf()
    const st = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={st} />)
    const snap = () => [...container.querySelectorAll('.pv-dot')].map(n => n.getAttribute('cx')).join()
    const a = snap()
    tick(60)
    expect(snap()).toBe(a)
  })

  it('움직이는 동안에도 라벨 겹침은 0을 유지한다(프레임 60개 연속 검사)', () => {
    const tick = installRaf()
    const st = createMatch(home, away, { seed: 42 })
    const { container } = render(<PitchView state={st} variant="tactics" analysis nameLabels />)
    for (let i = 0; i < 60; i++) {
      expect(firstOverlap(boxesOf(container)), `frame ${i * 3}`).toBeNull()
      tick(3)
    }
  })
})
