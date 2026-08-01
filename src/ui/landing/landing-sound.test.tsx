// @vitest-environment jsdom
// 랜딩 소리 안내 계약 — "왜 소리가 안 나지"라고 생각할 틈을 없앤다.
//
// 배경(사용자 지적 2026-08-01): 첫인상 화면에 BGM이 없다. 원인은 버그가 아니라 브라우저
// 자동재생 정책이고(오디오 컨텍스트는 유저 제스처 뒤에만 열린다), 우회하지 않는다.
// 대신 **정책을 말하고 제스처를 받아낸다.** 이 파일이 못 박는 것:
//   1. 컨텍스트가 없으면 안내가 뜬다 — 그리고 그것이 왜인지 문장으로 말한다
//   2. 안내를 누르면 sfx.init()(= 정책이 요구하는 그 경로)이 불린다
//   3. **음소거를 골라 둔 유저에게는 뜨지 않는다** — 랜딩이 그 선택을 뒤집지 않는다
//   4. 이미 열려 있으면(캠페인 후 복귀) 뜨지 않는다
//   5. 안내 밖의 첫 제스처로 열려도 같은 확인을 주고, 스스로 사라진다(토글이 아니다)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const state = vi.hoisted(() => ({
  bus: null as unknown,
  muted: false,
  initCalls: 0,
  listeners: new Set<() => void>(),
}))

vi.mock('../../audio/sfx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../audio/sfx')>()
  return {
    ...actual,
    audioBus: () => state.bus,
    isMuted: () => state.muted,
    init: () => { state.initCalls++ },
    onAudioUnlock: (fn: () => void) => {
      state.listeners.add(fn)
      return () => state.listeners.delete(fn)
    },
  }
})

import { LandingScreen } from './LandingScreen'

/** 실제 sfx.init()이 하는 일(컨텍스트 개방 통지)을 흉내 낸다. */
function unlockAudio(): void {
  state.bus = { ctx: {}, master: {} }
  act(() => { for (const fn of [...state.listeners]) fn() })
}

beforeEach(() => {
  state.bus = null
  state.muted = false
  state.initCalls = 0
  state.listeners.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const noop = (): void => {}

describe('랜딩 소리 안내', () => {
  it('오디오 컨텍스트가 없으면 이유와 함께 안내가 뜬다', () => {
    render(<LandingScreen onCampaign={noop} onDemo={noop} />)
    const btn = screen.getByRole('button', { name: /음악 켜기/ })
    expect(btn.textContent).toContain('브라우저 정책상')
  })

  it('안내를 누르면 sfx.init()이 불린다 — 정책이 요구하는 제스처 경로 그대로다', () => {
    render(<LandingScreen onCampaign={noop} onDemo={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /음악 켜기/ }))
    expect(state.initCalls).toBe(1)
  })

  it('음소거를 골라 둔 유저에게는 뜨지 않는다', () => {
    state.muted = true
    render(<LandingScreen onCampaign={noop} onDemo={noop} />)
    expect(screen.queryByRole('button', { name: /음악 켜기/ })).toBeNull()
  })

  it('이미 컨텍스트가 열려 있으면(캠페인 후 복귀) 뜨지 않는다', () => {
    state.bus = { ctx: {}, master: {} }
    render(<LandingScreen onCampaign={noop} onDemo={noop} />)
    expect(screen.queryByRole('button', { name: /음악 켜기/ })).toBeNull()
  })

  it('안내가 아닌 곳의 제스처로 열려도 확인을 주고, 스스로 사라진다(토글이 아니다)', () => {
    render(<LandingScreen onCampaign={noop} onDemo={noop} />)
    unlockAudio()
    expect(screen.getByRole('status').textContent).toContain('테마가 재생됩니다')
    // 확인 문구는 남지 않는다 — 남으면 그 자리가 두 번째 오디오 컨트롤이 된다.
    act(() => { vi.advanceTimersByTime(2700) })
    expect(screen.queryByText(/테마가 재생됩니다/)).toBeNull()
    expect(screen.queryByRole('button', { name: /음악 켜기/ })).toBeNull()
  })
})
