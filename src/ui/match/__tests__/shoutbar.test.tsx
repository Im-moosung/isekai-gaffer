// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { ShoutBar } from '../ShoutBar'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

/** 재생 중(playing) 상태로 만들고 지정 분까지 전진. */
function playing(minute: number) {
  store().reset()
  store().startMatch(home, away, 42)
  act(() => { store().kickoff() })
  let guard = 0
  act(() => {
    while (store().engine!.minute < minute && guard++ < 120) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
  })
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

describe('ShoutBar — 터치라인 외침', () => {
  it('재생 중 4버튼 [독려][더 뛰어][침착][칭찬] 노출', () => {
    playing(20)
    const { getByRole } = render(<ShoutBar />)
    for (const label of ['독려', '더 뛰어', '침착', '칭찬']) {
      expect(getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('외침 클릭 → 사기 즉시 보정(정지 없음) + 쿨다운 진입으로 버튼 비활성', () => {
    playing(25)
    const { getByRole } = render(<ShoutBar />)
    expect(store().lastShoutMinute).toBeNull()
    fireEvent.click(getByRole('button', { name: '독려' }))
    expect(store().phase).toBe('playing') // 정지 없음
    expect(store().lastShoutMinute).toBe(store().engine!.minute)
    // 쿨다운 중이므로 모든 버튼 disabled.
    expect((getByRole('button', { name: '침착' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('쿨다운 진행 바(progressbar)를 노출한다', () => {
    playing(20)
    const { getByRole } = render(<ShoutBar />)
    expect(getByRole('progressbar', { name: '외침 재사용 대기' })).toBeTruthy()
  })

  it('재생 중이 아니면(halftime) 렌더하지 않는다', () => {
    playing(20)
    act(() => { useMatchStore.setState({ phase: 'halftime' }) })
    const { container } = render(<ShoutBar />)
    expect(container.querySelector('.sb-root')).toBeNull()
  })
})
