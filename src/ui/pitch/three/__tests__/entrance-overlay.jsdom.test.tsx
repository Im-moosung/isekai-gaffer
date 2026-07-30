// @vitest-environment jsdom
// 입장 오버레이 DOM 계약 — 건너뛰기(클릭·키), 자체 클럭, 언마운트 후 rAF 0, 소개 카드.
// rAF는 스텁으로 갈아끼워 시간 흐름을 테스트가 소유한다(실제 타이머 대기 금지).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EntranceOverlay } from '../EntranceOverlay'
import { ENTRANCE_PHASES, ENTRANCE_TOTAL_MS, buildEntranceCast } from '../entrance'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = buildEntranceCast(state)

/** 예약된 rAF 콜백들(테스트가 직접 돌린다). */
let pending: Map<number, FrameRequestCallback>
let nextId: number

beforeEach(() => {
  pending = new Map()
  nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    pending.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pending.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 예약된 콜백을 now 시각으로 한 번씩 실행한다. */
function frame(now: number): void {
  const batch = [...pending.entries()]
  pending.clear()
  act(() => {
    for (const [, cb] of batch) cb(now)
  })
}

describe('EntranceOverlay', () => {
  it('첫 단계 자막을 role="status"로 알린다', () => {
    render(<EntranceOverlay cast={cast} onDone={() => {}} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('심판진 입장')
  })

  it('건너뛰기 버튼 클릭 → onSkip·onDone 각각 한 번', () => {
    const onDone = vi.fn()
    const onSkip = vi.fn()
    render(<EntranceOverlay cast={cast} onDone={onDone} onSkip={onSkip} />)
    const btn = screen.getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' })
    fireEvent.click(btn)
    fireEvent.click(btn) // 두 번 눌러도 한 번만 끝난다.
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Esc(및 아무 키)로 건너뛴다', () => {
    const onDone = vi.fn()
    render(<EntranceOverlay cast={cast} onDone={onDone} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('자체 클럭이 경과 ms를 onProgress로 흘려보낸다(첫 rAF now가 t0)', () => {
    const onProgress = vi.fn()
    render(<EntranceOverlay cast={cast} onDone={() => {}} onProgress={onProgress} />)
    frame(1000)
    frame(1500)
    expect(onProgress.mock.calls.map(c => c[0])).toEqual([0, 500])
  })

  it('총 길이에 도달하면 스스로 onDone하고 더 이상 프레임을 예약하지 않는다', () => {
    const onDone = vi.fn()
    render(<EntranceOverlay cast={cast} onDone={onDone} />)
    frame(0)
    frame(ENTRANCE_TOTAL_MS)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(pending.size).toBe(0)
  })

  // ⚠ 회귀 방지: 정리 후 이펙트가 다시 도는 경우(React StrictMode dev의 마운트 이중 실행,
  //   또는 cast 교체) 클럭이 되살아나야 한다. 예전엔 finishedRef가 세워진 채로 남아
  //   두 번째 loop가 첫 줄에서 리턴했고, 개발 모드에서 입장 연출이 영구 정지했다.
  it('이펙트가 재실행되면 클럭이 되살아난다(StrictMode 이중 마운트)', () => {
    const onProgress = vi.fn()
    const onDone = vi.fn()
    const { rerender } = render(
      <StrictMode>
        <EntranceOverlay cast={cast} onDone={onDone} onProgress={onProgress} />
      </StrictMode>,
    )
    // StrictMode는 마운트 시 이펙트를 정리→재실행한다. 그 뒤에도 프레임이 흘러야 한다.
    frame(1000)
    frame(1400)
    expect(onProgress.mock.calls.map(c => c[0])).toEqual([0, 400])
    // 총 길이에 도달하면 여전히 정확히 한 번만 끝난다.
    frame(1000 + ENTRANCE_TOTAL_MS)
    expect(onDone).toHaveBeenCalledTimes(1)
    rerender(<StrictMode />)
  })

  it('언마운트하면 rAF가 취소되고, 남아 있던 콜백을 억지로 돌려도 아무 일이 없다', () => {
    const onProgress = vi.fn()
    const onDone = vi.fn()
    const { unmount } = render(<EntranceOverlay cast={cast} onDone={onDone} onProgress={onProgress} />)
    frame(0)
    const stale = [...pending.values()]
    expect(stale.length).toBe(1)
    unmount()
    expect(pending.size).toBe(0)
    onProgress.mockClear()
    act(() => {
      for (const cb of stale) cb(9999)
    })
    expect(onProgress).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('소개 카드에 등번호·한국어 이름·포지션이 나온다', () => {
    const introStart = ENTRANCE_PHASES[3].start
    render(<EntranceOverlay cast={cast} onDone={() => {}} startMs={introStart + 100} />)
    const card = screen.getByTestId('entrance-card')
    const gk = cast.home[0]
    expect(card.textContent).toContain(String(gk.number))
    expect(card.textContent).toContain(gk.nameKo)
    expect(card.textContent).toContain('골키퍼')
    expect(card.textContent).toContain('1 / 11')
  })

  it('소개가 진행되면 다음 선수 카드로 교체된다', () => {
    const introStart = ENTRANCE_PHASES[3].start
    render(<EntranceOverlay cast={cast} onDone={() => {}} startMs={introStart + 100} />)
    frame(0)
    frame(600) // 카드 슬롯(500ms)을 하나 넘긴 시점
    const card = screen.getByTestId('entrance-card')
    expect(card.textContent).toContain(cast.home[1].nameKo)
    expect(card.textContent).not.toContain(cast.home[0].nameKo)
  })

  it('라인업 시트는 정렬 이후에만 뜨고 호명 중인 선수를 강조한다', () => {
    const { container } = render(<EntranceOverlay cast={cast} onDone={() => {}} />)
    expect(container.querySelector('.ent__sheet')).toBeNull()
    cleanup()
    render(<EntranceOverlay cast={cast} onDone={() => {}} startMs={ENTRANCE_PHASES[3].start + 100} />)
    const chips = document.querySelectorAll('.ent__chip')
    expect(chips).toHaveLength(11)
    expect(document.querySelectorAll('.ent__chip--on')).toHaveLength(1)
  })
})
