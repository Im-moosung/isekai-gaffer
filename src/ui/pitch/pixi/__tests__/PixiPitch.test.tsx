// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PixiPitch } from '../PixiPitch'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'
import { createMatch } from '../../../../engine/simulate'
import { buildSequence } from '../../choreography'

// jsdom엔 WebGL 컨텍스트가 없다 → PixiPitch가 SVG PitchView(.pv-root)로 자동 폴백해야 한다.
// (실제 브라우저 WebGL 렌더는 dev 스크린샷으로 검증 — 이 스모크는 폴백 계약만 확인)
describe('PixiPitch — WebGL 불가 폴백', () => {
  it('WebGL 없으면 SVG PitchView로 폴백한다(크래시 금지)', () => {
    const home = makeTestTeam('kor', 82)
    const away = makeTestTeam('esp', 84)
    const state = createMatch(home, away, { seed: 42 })
    const { container } = render(<PixiPitch state={state} />)
    // 폴백 SVG 루트 + 양팀 22 도트가 그대로 렌더.
    expect(container.querySelector('.pv-root')).toBeTruthy()
    expect(container.querySelectorAll('.pv-dot')).toHaveLength(22)
  })

  it('폴백 시 sequence/lastEvent props를 SVG PitchView로 전달한다', () => {
    const home = makeTestTeam('kor', 82)
    const away = makeTestTeam('esp', 84)
    const state = createMatch(home, away, { seed: 42 })
    const seq = buildSequence({ minute: 30, type: 'goal', teamId: home.id }, state.home, state.away)
    const { container } = render(
      <PixiPitch state={state} lastEvent={{ minute: 30, type: 'goal', teamId: home.id }} sequence={seq} dwellMs={4000} sequenceSide="home" />,
    )
    // 시퀀스 전달 → 공(.pv-ball) 재생.
    expect(container.querySelector('.pv-ball')).toBeTruthy()
  })
})
