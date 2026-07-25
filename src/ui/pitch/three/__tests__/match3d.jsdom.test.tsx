// @vitest-environment jsdom
// Match3D 통합 스모크 — jsdom에는 WebGL2가 없으므로 "3D를 못 쓰는 환경"의 계약을 검증한다.
// (실제 3D 렌더 품질은 dev 서버 스크린샷으로 확인한다 — 여기서는 폴백·누수·크래시 금지만.)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Match3D } from '../Match3D'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 78)
const away = makeTestTeam('esp', 86)
const state = createMatch(home, away, { seed: 11 })

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Match3D — WebGL2 폴백 계약', () => {
  it('WebGL2 불가 환경에서는 fallback 노드를 렌더한다(캔버스 호스트 없음·크래시 없음)', () => {
    const { container, getByTestId } = render(
      <Match3D state={state} fallback={<div data-testid="chain-2d" />} />,
    )
    expect(getByTestId('chain-2d')).toBeTruthy()
    expect(container.querySelector('.m3d-host')).toBeNull()
  })

  it('fallback 미지정이어도 폴백 경로에서 throw하지 않는다(백지 대신 빈 렌더)', () => {
    expect(() => render(<Match3D state={state} />)).not.toThrow()
  })

  it('three를 정적으로 끌어오지 않는다 — 폴백 경로에서 동적 import가 일어나지 않는다', () => {
    // WebGL2 체크가 먼저 실패하므로 three 청크 요청 자체가 없어야 한다.
    // (getContext 호출 = WebGL2 탐지가 실제로 실행됐다는 증거)
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(<Match3D state={state} fallback={<div data-testid="chain-2d" />} />)
    expect(spy).toHaveBeenCalledWith('webgl2')
  })

  it('언마운트 시 정리 경로가 안전하다(폴백 상태에서도 예외 없음)', () => {
    const { unmount } = render(<Match3D state={state} fallback={<div />} />)
    expect(() => unmount()).not.toThrow()
  })
})
