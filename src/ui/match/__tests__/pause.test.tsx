// @vitest-environment jsdom
// 일시정지 계약 — **감독 타임과 다른 조작이다.**
//
// 감독 타임(pauseByUser)은 정지 + 작전판 진입이고, 정지 사유에 따라 개입 권한을
// 발급한다(matchStore.interventionLevel). 여기서 검증하는 일시정지는 그 반대다:
//   · 시계만 멈춘다 — phase는 'playing' 그대로다
//   · 개입 권한을 **하나도** 주지 않는다(canIntervene false 유지 + 외침 차단)
//   · 재개하면 **남은 dwell**부터 이어 간다 — 분이 튀지도, 두 번 재생되지도 않는다
//   · TTS는 cancel이 아니라 pause/resume(문장 중간에 잘리면 그 분 해설이 사라진다)
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

// TTS 호출을 가로챈다(실제 구현은 jsdom에 speechSynthesis가 없어 no-op).
const ttsCalls: string[] = []
vi.mock('../../../audio/commentary-tts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../audio/commentary-tts')>()
  return {
    ...actual,
    pauseSpeech: () => { ttsCalls.push('pause') },
    resumeSpeech: () => { ttsCalls.push('resume') },
    stopAll: () => { ttsCalls.push('stop') },
  }
})

import { MatchScreen } from '../MatchScreen'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { useMatchStore, canIntervene } from '../../../game/matchStore'

const home = makeTestTeam('kor', 80)
const away = makeTestTeam('esp', 82)

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

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  ls = installLocalStorage()
  ttsCalls.length = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useMatchStore.getState().reset()
  ls.clear()
})

/** 킥오프 → 입장 연출 건너뛰기 → 재생 중. */
function kickoff(getByRole: (role: string, opts: { name: string }) => HTMLElement) {
  fireEvent.click(getByRole('button', { name: '킥오프' }))
  fireEvent.click(getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' }))
}

describe('MatchScreen — 일시정지', () => {
  it('정지하면 시계가 멈춘다(타이머를 아무리 돌려도 분이 늘지 않는다)', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    // 몇 분 흘려 보내 재생이 실제로 돌고 있음을 확인한다.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    const running = useMatchStore.getState().engine!.minute
    expect(running).toBeGreaterThan(0)

    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    const atPause = useMatchStore.getState().engine!.minute
    await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
    expect(useMatchStore.getState().engine!.minute).toBe(atPause)
  })

  it('정지는 개입 권한을 주지 않는다 — phase는 playing 그대로다', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    const phase = useMatchStore.getState().phase
    expect(phase).toBe('playing')
    expect(canIntervene(phase)).toBe(false)
  })

  it('정지 중에는 터치라인 외침이 잠긴다(정지가 자원이 되지 않게)', async () => {
    const { getByRole, queryByText } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    const shout = getByRole('button', { name: '독려' }) as HTMLButtonElement
    expect(shout.disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    expect((getByRole('button', { name: '독려' }) as HTMLButtonElement).disabled).toBe(true)
    expect(queryByText('일시정지 중')).not.toBeNull()
    // 클릭해도 기록이 남지 않는다(disabled를 우회한 프로그램적 클릭까지 막는다).
    const before = useMatchStore.getState().decisionLog.length
    fireEvent.click(getByRole('button', { name: '독려' }))
    expect(useMatchStore.getState().decisionLog.length).toBe(before)
  })

  it('재개하면 남은 dwell부터 이어 간다 — 분이 튀지 않는다', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    const atPause = useMatchStore.getState().engine!.minute

    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(useMatchStore.getState().engine!.minute).toBe(atPause)

    // 재개 직후에는 아직 그 분이다(정지한 순간이 곧 재개 순간).
    fireEvent.click(getByRole('button', { name: '재생' }))
    await flush()
    expect(useMatchStore.getState().engine!.minute).toBe(atPause)
    // 남은 시간이 지나면 **딱 1분** 넘어간다(정지 동안 밀린 분이 몰아서 튀지 않는다).
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    const after = useMatchStore.getState().engine!.minute
    expect(after - atPause).toBeLessThanOrEqual(1)
  })

  it('TTS는 취소가 아니라 정지/재개다(문장이 중간에 사라지지 않는다)', async () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    ttsCalls.length = 0
    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    expect(ttsCalls).toContain('pause')
    expect(ttsCalls).not.toContain('stop')

    ttsCalls.length = 0
    fireEvent.click(getByRole('button', { name: '재생' }))
    await flush()
    expect(ttsCalls).toContain('resume')
  })

  it('스페이스로 토글된다(영상 플레이어 관습). 버튼 포커스 중에는 넘긴다', async () => {
    const { getByRole, queryByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()

    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }) })
    await flush()
    expect(queryByRole('button', { name: '재생' })).not.toBeNull()

    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }) })
    await flush()
    expect(queryByRole('button', { name: '일시정지' })).not.toBeNull()

    // 버튼에 포커스가 있으면 브라우저가 그 버튼을 눌러 준다 — 여기서 또 처리하면 2번 토글된다.
    // (음소거는 설정 팝업 안으로 옮겨 갔다 — 아무 버튼이나 하나면 되므로 톱니를 쓴다.)
    const btn = getByRole('button', { name: '설정' })
    act(() => { fireEvent.keyDown(btn, { code: 'Space', key: ' ' }) })
    await flush()
    expect(queryByRole('button', { name: '일시정지' })).not.toBeNull()
  })

  it('감독 타임으로 들어가면 일시정지는 자동 해제된다(조작 두 개가 겹치지 않게)', async () => {
    const { getByRole, queryByRole } = render(<MatchScreen home={home} away={away} seed={11} />)
    kickoff(getByRole)
    await flush()
    fireEvent.click(getByRole('button', { name: '일시정지' }))
    await flush()
    fireEvent.click(getByRole('button', { name: '감독 타임' }))
    await flush()
    expect(useMatchStore.getState().phase).toBe('paused-user')

    // 작전판을 닫으면 정지 상태가 남아 있지 않고 그대로 재생된다.
    act(() => { useMatchStore.getState().confirmTactics() })
    await flush()
    // 작전판 이탈 역연출(MODE_TRANSITION_MS)이 끝나야 방송 furniture가 다시 마운트된다.
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(useMatchStore.getState().phase).toBe('playing')
    expect(queryByRole('button', { name: '일시정지' })).not.toBeNull()
    const m0 = useMatchStore.getState().engine!.minute
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(useMatchStore.getState().engine!.minute).toBeGreaterThan(m0)
  })
})
