// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore } from '../../../game/matchStore'

// PixiPitch 청크 로드 실패(네트워크 오류·배포 중 404)를 시뮬레이션한다.
// dynamic import가 reject되면 React.lazy는 렌더 중 에러를 throw하는데,
// 에러 바운더리가 없으면 이 에러가 위로 전파되어 앱 전체가 백지가 된다.
// 이 경로는 PixiPitch 내부 WebGL 폴백으로 못 막는다(컴포넌트가 로드된 뒤에만 작동).
vi.mock('../../pitch/pixi/PixiPitch', () => ({
  PixiPitch: () => { throw new Error('chunk load failed (simulated 404)') },
}))

afterEach(() => { cleanup(); useMatchStore.getState().reset() })

describe('MatchScreen — PixiPitch 청크 로드 실패 에러 바운더리', () => {
  it('청크 로드 실패 시 SVG PitchView 폴백을 렌더한다(백지 금지·피치 상시 노출)', async () => {
    const home = makeTestTeam('kor', 80)
    const away = makeTestTeam('esp', 82)
    const { container } = render(<MatchScreen home={home} away={away} seed={7} />)
    // lazy reject가 마이크로태스크로 전파되도록 플러시.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // 바운더리가 SVG 폴백을 렌더 → 피치(.pv-root)는 남고 앱은 백지가 되지 않는다.
    expect(container.querySelector('.pv-root')).toBeTruthy()
    // 킥오프 버튼도 여전히 존재(트리가 언마운트되지 않음).
    expect(container.querySelector('.ms-root')).toBeTruthy()
  })
})
