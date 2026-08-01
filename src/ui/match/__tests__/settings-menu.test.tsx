// @vitest-environment jsdom
// 설정 팝업 계약 — 사용자 지시(2026-08-01 ①): *"자주 바꾸지 않는 건 설정 아이콘 만들어서
// 그거 누르면 팝업으로 뜨게 해. 음소거, 해설 끄기, 2D/3D 이런 거."*
//
// 여기서 고정하는 것은 두 가지다.
//  1. **무엇이 어디에 있는가** — 셋은 팝업 안, 경기 중 쓰는 것은 바에.
//     회귀하면 컨트롤 과밀이 그대로 돌아온다.
//  2. **팝업이 키보드로 다뤄지는가** — Esc·포커스 복귀·포커스 트랩.
//     팝업은 만들기 쉽고 접근성을 깨뜨리기도 쉽다.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore } from '../../../game/matchStore'

const home = makeTestTeam('kor', 80)
const away = makeTestTeam('esp', 82)

function kickoff(getByRole: (role: string, opts: { name: string }) => HTMLElement) {
  fireEvent.click(getByRole('button', { name: '킥오프' }))
  fireEvent.click(getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' }))
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup(); useMatchStore.getState().reset() })

/** 타이머를 가짜로 쓰면 await가 멈추므로, 이 파일은 동기 flush만 쓴다. */
function setup() {
  const r = render(<MatchScreen home={home} away={away} seed={7} />)
  kickoff(r.getByRole)
  act(() => { vi.advanceTimersByTime(0) })
  return r
}

describe('제어 pod — 무엇을 접고 무엇을 남기는가', () => {
  it('접힌 것: 2D/3D · 음소거 · 해설 음성은 열기 전에는 DOM에 없다', () => {
    const { queryByRole } = setup()
    expect(queryByRole('button', { name: '2D' })).toBeNull()
    expect(queryByRole('button', { name: '음소거' })).toBeNull()
    expect(queryByRole('button', { name: '해설 음성 끄기' })).toBeNull()
  })

  // 배속이 바에 남는 근거: 90분 재생에서 0-0 구간은 2x로 넘기고 80분 1골 차에서는 1x로
  // 내리는 것이 이 게임의 관전 방식이다. 재생/일시정지와 같은 가족이며, 영상 플레이어의
  // 배속이 설정 메뉴가 아니라 컨트롤 바에 있는 것과 같은 이유다.
  it('남은 것: 재생·배속·개입 잔량·감독 타임은 바에 그대로 있다', () => {
    const { container, getByRole } = setup()
    const pod = container.querySelector('.ms-controls')!
    expect(getByRole('button', { name: '1x' })).toBeTruthy()
    expect(getByRole('button', { name: '2x' })).toBeTruthy()
    expect(pod.textContent).toContain('일시정지')
    expect(pod.textContent).toContain('개입 5/5')
    expect(pod.textContent).toContain('감독 타임')
  })

  it('톱니에는 이모지가 없다 — SVG로 그린다(OS마다 모양이 달라지는 것을 막는다)', () => {
    const { getByRole } = setup()
    const btn = getByRole('button', { name: '설정' })
    expect(btn.querySelector('svg.ms-gear')).toBeTruthy()
    // 버튼 안에 글자가 없다 = 이모지도 없다.
    expect(btn.textContent).toBe('')
  })

  it('아이콘은 접근성 트리·탭 순서에서 빠진다(포커스는 항상 바깥 button이 받는다)', () => {
    const { getByRole } = setup()
    const svg = getByRole('button', { name: '설정' }).querySelector('svg.ms-gear')!
    // ★ SVG 안에 포커스가 들어가면 전역 :focus-visible이 사용자 단위로 해석돼
    //   viewBox 배율만큼 부푼다(297e74b가 고친 지뢰).
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
  })
})

describe('설정 팝업 — 열고 닫기와 키보드', () => {
  it('톱니를 누르면 dialog가 열리고 aria-expanded가 따라간다', () => {
    const { getByRole, queryByRole } = setup()
    const btn = getByRole('button', { name: '설정' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog')
    act(() => { fireEvent.click(btn) })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(queryByRole('dialog')).not.toBeNull()
    expect(getByRole('button', { name: '2D' })).toBeTruthy()
    expect(getByRole('button', { name: '음소거' })).toBeTruthy()
    expect(getByRole('button', { name: '해설 음성 끄기' })).toBeTruthy()
  })

  it('열면 시트 안 첫 컨트롤로 포커스가 간다', () => {
    const { getByRole } = setup()
    act(() => { fireEvent.click(getByRole('button', { name: '설정' })) })
    expect(document.activeElement).toBe(getByRole('button', { name: '2D' }))
  })

  it('Esc로 닫히고 **포커스가 톱니로 돌아온다**', () => {
    const { getByRole, queryByRole } = setup()
    const btn = getByRole('button', { name: '설정' })
    act(() => { fireEvent.click(btn) })
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  it('Tab이 시트 안에서 돈다(포커스 트랩) — 마지막에서 첫 번째로 감긴다', () => {
    const { getByRole, container } = setup()
    act(() => { fireEvent.click(getByRole('button', { name: '설정' })) })
    const sheet = container.querySelector('.ms-set__sheet')!
    const items = [...sheet.querySelectorAll('button')] as HTMLElement[]
    expect(items.length).toBeGreaterThan(2)
    const first = items[0]
    const last = items[items.length - 1]
    act(() => { last.focus() })
    act(() => { fireEvent.keyDown(window, { key: 'Tab' }) })
    expect(document.activeElement).toBe(first)
    // Shift+Tab은 반대로 감긴다.
    act(() => { fireEvent.keyDown(window, { key: 'Tab', shiftKey: true }) })
    expect(document.activeElement).toBe(last)
  })

  it('바깥을 누르면 닫힌다', () => {
    const { getByRole, queryByRole } = setup()
    act(() => { fireEvent.click(getByRole('button', { name: '설정' })) })
    act(() => { fireEvent.pointerDown(document.body) })
    expect(queryByRole('dialog')).toBeNull()
  })

  it('팝업 안의 토글이 실제로 동작한다(자리만 옮겼을 뿐 계약은 그대로)', () => {
    const { getByRole } = setup()
    act(() => { fireEvent.click(getByRole('button', { name: '설정' })) })
    expect(getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true')
    act(() => { fireEvent.click(getByRole('button', { name: '2D' })) })
    expect(getByRole('button', { name: '2D' }).getAttribute('aria-pressed')).toBe('true')
    // 시트는 닫히지 않는다 — 두 개를 연달아 바꾸는 것이 정상 사용이다.
    expect(getByRole('button', { name: '설정' }).getAttribute('aria-expanded')).toBe('true')
  })
})
