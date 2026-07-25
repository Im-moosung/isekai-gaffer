// @vitest-environment jsdom
// 2D/3D 렌더러 토글 + 렌더러 체인(Match3D → PixiPitch → PitchView) 스모크.
// jsdom에는 WebGL이 없으므로 어떤 모드에서도 최종적으로 SVG PitchView가 보여야 한다
// (피치 상시 노출 원칙 — 3D 실패가 화면을 비우면 안 된다).
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore } from '../../../game/matchStore'

const home = makeTestTeam('kor', 80)
const away = makeTestTeam('esp', 82)

/** lazy 청크(Match3D·PixiPitch) 해석이 끝나도록 마이크로태스크를 비운다. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** 이 환경(node 24 + jsdom)에는 localStorage가 없다 — Map 기반 스텁을 심어 기억 동작을 검증한다. */
function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  return ls
}
let ls: ReturnType<typeof installLocalStorage>

beforeEach(() => { ls = installLocalStorage() })
afterEach(() => { cleanup(); useMatchStore.getState().reset(); ls.clear() })

describe('MatchScreen — 2D/3D 렌더러 토글', () => {
  it('기본값은 3D(저장값 없음) — 버튼이 [3D]·aria-pressed=true', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    const btn = getByRole('button', { name: '2D 화면으로 전환' })
    expect(btn.textContent).toBe('3D')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('토글 클릭 → 2D로 내려가고 localStorage에 기억된다', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    fireEvent.click(getByRole('button', { name: '2D 화면으로 전환' }))
    const btn = getByRole('button', { name: '3D 화면으로 전환' })
    expect(btn.textContent).toBe('2D')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(ls.getItem('rematch-render3d')).toBe('0')
  })

  it('저장값 0이면 마운트부터 2D로 시작한다', async () => {
    ls.setItem('rematch-render3d', '0')
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    expect(getByRole('button', { name: '3D 화면으로 전환' }).textContent).toBe('2D')
  })

  it('3D 모드에서도 WebGL 불가 환경이면 체인이 끝까지 내려가 SVG 피치가 보인다', async () => {
    const { container } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    expect(container.querySelector('.pv-root')).toBeTruthy()
    expect(container.querySelector('.m3d-host')).toBeNull()
  })

  it('2D로 토글해도 피치는 계속 보인다(전환 중 백지 금지)', async () => {
    const { container, getByRole } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    fireEvent.click(getByRole('button', { name: '2D 화면으로 전환' }))
    await flush()
    expect(container.querySelector('.pv-root')).toBeTruthy()
  })

  it('기존 방송 DOM 레이어(스코어버그·티커·음소거·TTS)는 3D 도입 후에도 그대로다', async () => {
    const { container, getByRole } = render(<MatchScreen home={home} away={away} seed={7} />)
    await flush()
    expect(getByRole('button', { name: '음소거' })).toBeTruthy()
    expect(getByRole('button', { name: '해설 음성 끄기' })).toBeTruthy()
    expect(container.querySelector('.ms-root')).toBeTruthy()
  })
})
