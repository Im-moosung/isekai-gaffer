// @vitest-environment jsdom
// 폴백 3단의 막내(SVG PitchView)도 일시정지를 지킨다.
//
// 왜 이 테스트가 필요한가: 정지는 MatchScreen이 3D·Pixi·SVG **세 렌더러 모두**에
// 같은 prop으로 내려보내는 계약이다. 3D만 얼고 SVG는 계속 굴러가면, WebGL을 못 쓰는
// 환경(심사자의 구형 브라우저)에서 "정지를 눌렀는데 공이 계속 간다"가 된다.
// 3D·Pixi는 실브라우저 주행으로, SVG는 여기서 고정한다.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { PitchView } from '../PitchView'
import { buildSequence } from '../choreography'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import type { MatchEvent } from '../../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup() })

/** 렌더된 공의 x좌표(viewBox 단위). 안무 스텝이 진행하면 이 값이 바뀐다. */
function ballX(c: HTMLElement): number {
  const el = c.querySelector('.pv-ball')
  return el ? Number(el.getAttribute('cx')) : NaN
}

describe('PitchView — 일시정지', () => {
  const state = createMatch(home, away, { seed: 5 })
  const shot: MatchEvent = { minute: 20, type: 'shot', teamId: home.id, playerId: home.squad[9].id }
  const seq = buildSequence(shot, state.home, state.away)

  it('정지 중에는 안무 스텝이 전진하지 않는다', () => {
    const { container, rerender } = render(
      <PitchView state={state} lastEvent={shot} sequence={seq} dwellMs={4000} sequenceSide="home" />,
    )
    const start = ballX(container)
    act(() => { vi.advanceTimersByTime(1500) })
    const moved = ballX(container)
    expect(moved).not.toBe(start) // 대조군: 그냥 두면 움직인다

    rerender(
      <PitchView state={state} lastEvent={shot} sequence={seq} dwellMs={4000} sequenceSide="home" paused />,
    )
    act(() => { vi.advanceTimersByTime(4000) })
    expect(ballX(container)).toBe(moved)
  })

  it('재개하면 처음으로 되감기지 않고 멈춘 스텝에서 이어 간다', () => {
    const { container, rerender } = render(
      <PitchView state={state} lastEvent={shot} sequence={seq} dwellMs={4000} sequenceSide="home" />,
    )
    const start = ballX(container)
    act(() => { vi.advanceTimersByTime(1500) })
    const atPause = ballX(container)
    rerender(
      <PitchView state={state} lastEvent={shot} sequence={seq} dwellMs={4000} sequenceSide="home" paused />,
    )
    act(() => { vi.advanceTimersByTime(3000) })
    rerender(
      <PitchView state={state} lastEvent={shot} sequence={seq} dwellMs={4000} sequenceSide="home" />,
    )
    // 재개 직후에는 멈춘 그 자리 — 0번 스텝으로 되감기지 않는다.
    expect(ballX(container)).toBe(atPause)
    expect(ballX(container)).not.toBe(start)
    // 그리고 다시 흐른다.
    act(() => { vi.advanceTimersByTime(2500) })
    expect(ballX(container)).not.toBe(atPause)
  })
})
