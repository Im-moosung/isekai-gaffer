// @vitest-environment jsdom
// 2D 하이라이트의 실측 계약 — 4라운드 지시 ④⑤ + 감사 ⑨.
//
//  ⑤ 안무가 지목한 선수의 **진짜 도트**가 그 좌표로 간다. 번호 없는 고스트 원(.pv-mover)은 없다.
//  ④ 이름표는 **장면에 관여한 선수에게만** 붙고, 서로도 도트도 덮지 않는다.
//  ⑨ 어떤 도트도 다른 팀 도트에 완전히 가려지지 않는다(팀 간 포함).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { PitchView } from '../PitchView'
import { buildSequence } from '../choreography'
import { dotOverlapRatio, MIN_DOT_SEP } from '../shape'
import { LABEL_H_RATIO, textWidth, type Box } from '../labels'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import type { MatchEvent } from '../../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const NAME_FS = 2.5
/** viewBox(105×68) → m 환산. shape.ts의 VB_X/VB_Y와 같은 값. */
const VB = { x: 1, y: 1 } // viewBox 단위가 곧 m다(105×68).

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function match(seed = 42) {
  return createMatch(home, away, { seed })
}

const EVENTS: MatchEvent['type'][] = ['goal', 'shot', 'save', 'miss', 'chance', 'corner']

function dotsOf(container: HTMLElement) {
  return [...container.querySelectorAll('.pv-dot')].map(n => ({
    x: Number(n.getAttribute('cx')),
    y: Number(n.getAttribute('cy')),
  }))
}

function namesOf(container: HTMLElement) {
  return [...container.querySelectorAll('.pv-name')].map(n => ({
    text: n.textContent ?? '',
    x: Number(n.getAttribute('x')),
    y: Number(n.getAttribute('y')),
  }))
}

function boxOf(t: { text: string; x: number; y: number }): Box {
  const w = textWidth(t.text, NAME_FS) + 1
  const h = NAME_FS * LABEL_H_RATIO
  return { x: t.x - w / 2, y: t.y - h / 2, w, h }
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** rAF를 수동으로 돌린다(라이브 클럭이 rAF에 물려 있다 — board-labels.test와 같은 이유). */
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

describe('★ ⑤ 진짜 도트가 움직인다 — 고스트 무버는 없다', () => {
  it('고스트 원(.pv-mover)이 한 개도 그려지지 않는다(전 이벤트 타입)', () => {
    for (const type of EVENTS) {
      for (const side of ['home', 'away'] as const) {
        const st = match()
        const ev: MatchEvent = { minute: 30, type, teamId: (side === 'home' ? home : away).id }
        const seq = buildSequence(ev, st.home, st.away)
        if (seq.length === 0) continue
        const { container, unmount } = render(
          <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide={side} />,
        )
        expect(container.querySelectorAll('.pv-mover'), `${type}/${side}`).toHaveLength(0)
        expect(container.querySelectorAll('.pv-dot'), `${type}/${side}`).toHaveLength(22)
        unmount()
      }
    }
  })

  it('무버로 지목된 선수의 도트가 실제로 그 좌표에 있다(분리 오프셋 허용치 내)', () => {
    for (const type of EVENTS) {
      const st = match()
      const ev: MatchEvent = { minute: 30, type, teamId: home.id }
      const seq = buildSequence(ev, st.home, st.away)
      if (seq.length === 0) continue
      const { container, unmount } = render(
        <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide="home" />,
      )
      const dots = dotsOf(container)
      // 첫 스텝(t=0)에서 보간 진행도는 1이므로 도트는 정확히 그 키프레임 좌표에 있어야 한다.
      for (const m of seq[0].movers) {
        const tx = (m.x / 100) * 105
        const ty = (m.y / 100) * 68
        const near = Math.min(...dots.map(d => Math.hypot(d.x - tx, d.y - ty)))
        // 가독성 분리(최대 1.8m)만큼은 밀릴 수 있다.
        expect(near, `${type} mover ${m.playerId}`).toBeLessThanOrEqual(1.85)
      }
      unmount()
    }
  })

  it('공은 캐리어 도트의 발밑에 있다(패스를 주고받는 것으로 읽힌다)', () => {
    const st = match()
    const ev: MatchEvent = { minute: 30, type: 'goal', teamId: home.id }
    const seq = buildSequence(ev, st.home, st.away)
    const step = seq.find(s => s.carrier)
    expect(step, '캐리어를 명시한 스텝이 있어야 한다').toBeTruthy()
    const { container } = render(
      <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide="home" />,
    )
    // 캐리어 링이 그려지고, 그 자리에 도트가 있다.
    const ring = container.querySelector('.pv-carrier')
    expect(ring).toBeTruthy()
    const rx = Number(ring!.getAttribute('cx'))
    const ry = Number(ring!.getAttribute('cy'))
    const near = Math.min(...dotsOf(container).map(d => Math.hypot(d.x - rx, d.y - ry)))
    expect(near).toBeLessThan(0.01)
  })

  it('스텝이 넘어가는 동안 도트 좌표가 프레임마다 바뀐다(정지 도트 금지)', () => {
    // ★ rAF까지 가짜로 바꾸면 installRaf 스텁이 덮여 클럭이 안 돈다 — setTimeout만 가짜로.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tick = installRaf()
    try {
      const st = match()
      const ev: MatchEvent = { minute: 30, type: 'goal', teamId: home.id }
      const seq = buildSequence(ev, st.home, st.away)
      const { container } = render(
        <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide="home" />,
      )
      // 스텝 1로 진입시킨다(useChoreoStep의 setTimeout).
      act(() => { vi.advanceTimersByTime(Math.ceil(seq[0].t * 4000) + 20) })
      const a = dotsOf(container).map(d => `${d.x},${d.y}`)
      tick(9) // 3틱(≈0.15초)
      const b = dotsOf(container).map(d => `${d.x},${d.y}`)
      expect(a.filter((v, i) => v !== b[i]).length, '움직인 도트 수').toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('★ ④ 이름표는 장면에 관여한 선수에게만', () => {
  it('무버·캐리어 이름만 뜨고, 22명 전원이 뜨지 않는다', () => {
    for (const type of EVENTS) {
      for (const side of ['home', 'away'] as const) {
        const st = match()
        const ev: MatchEvent = { minute: 30, type, teamId: (side === 'home' ? home : away).id }
        const seq = buildSequence(ev, st.home, st.away)
        if (seq.length === 0) continue
        const { container, unmount } = render(
          <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide={side} />,
        )
        const names = namesOf(container)
        const cast = new Set(seq[0].movers.map(m => m.playerId))
        if (seq[0].carrier) cast.add(seq[0].carrier)
        expect(names.length, `${type}/${side} 이름표 수`).toBeGreaterThan(0)
        expect(names.length, `${type}/${side} 이름표 수`).toBeLessThanOrEqual(cast.size)
        // 전부 **실제 공격 팀**(save는 teamId의 반대편이다 — cast.sequenceOwner) 선수 이름이다.
        const castNames = new Set(
          [...cast].map(id =>
            st.home.team.squad.find(p => p.id === id)?.name.ko
            ?? st.away.team.squad.find(p => p.id === id)?.name.ko),
        )
        for (const n of names) expect(castNames.has(n.text), `${type}/${side} "${n.text}"`).toBe(true)
        unmount()
      }
    }
  })

  it('이름표끼리도, 이름표와 도트도 겹치지 않는다', () => {
    for (const type of EVENTS) {
      for (const seed of [42, 7, 2026]) {
        const st = match(seed)
        const ev: MatchEvent = { minute: 30, type, teamId: home.id }
        const seq = buildSequence(ev, st.home, st.away)
        if (seq.length === 0) continue
        const { container, unmount } = render(
          <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide="home" />,
        )
        const boxes = namesOf(container).map(boxOf)
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            expect(overlaps(boxes[i], boxes[j]), `${type}/${seed} 이름표끼리`).toBe(false)
          }
        }
        // 도트(장애물 반경 2.95)와도 겹치지 않는다.
        for (const d of dotsOf(container)) {
          const db: Box = { x: d.x - 2.95, y: d.y - 2.95, w: 5.9, h: 5.9 }
          for (const b of boxes) expect(overlaps(b, db), `${type}/${seed} 이름표↔도트`).toBe(false)
        }
        unmount()
      }
    }
  })
})

describe('★ ⑨ 어떤 도트도 상대 도트에 완전히 가려지지 않는다', () => {
  it('렌더된 DOM의 모든 쌍(팀 간 포함)이 50% 넘게 겹치지 않는다', () => {
    // 하이라이트 · 전술판(이름표) · 작전판 세 가지 모드 전부.
    const st = match()
    const ev: MatchEvent = { minute: 30, type: 'goal', teamId: home.id }
    const seq = buildSequence(ev, st.home, st.away)
    const modes = [
      { label: '하이라이트', node: <PitchView state={st} lastEvent={ev} sequence={seq} dwellMs={4000} sequenceSide="home" /> },
      { label: '전술판', node: <PitchView state={st} variant="tactics" nameLabels /> },
      { label: '방송 정지', node: <PitchView state={st} /> },
    ]
    for (const m of modes) {
      const { container, unmount } = render(m.node)
      const dots = dotsOf(container)
      expect(dots).toHaveLength(22)
      let worst = 0
      let minD = Infinity
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          // viewBox 좌표가 곧 m다 — dotOverlapRatio는 0~100 좌표를 받으므로 되돌린다.
          const a = { x: (dots[i].x / 105) * 100, y: (dots[i].y / 68) * 100 }
          const b = { x: (dots[j].x / 105) * 100, y: (dots[j].y / 68) * 100 }
          worst = Math.max(worst, dotOverlapRatio(a, b))
          minD = Math.min(minD, Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y) * VB.x)
        }
      }
      expect(worst, `${m.label} 최대 겹침`).toBeLessThan(0.5)
      expect(minD, `${m.label} 최소 중심 거리`).toBeGreaterThanOrEqual(MIN_DOT_SEP - 0.01)
      unmount()
    }
  })
})
