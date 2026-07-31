// @vitest-environment jsdom
// 입장 오버레이 DOM 계약 — 건너뛰기(클릭·키), 자체 클럭, 언마운트 후 rAF 0,
// 컷3·컷4의 포메이션 도해 + 선수 명단 + 하이라이트, 비트 콜백(발화 트리거).
// rAF는 스텁으로 갈아끼워 시간 흐름을 테스트가 소유한다(실제 타이머 대기 금지).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EntranceOverlay } from '../EntranceOverlay'
import { buildEntranceCast, entranceScript } from '../entrance'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = buildEntranceCast(state)
const script = entranceScript(cast, 'full')
const TOTAL = script.totalMs

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
    render(<EntranceOverlay script={script} onDone={() => {}} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('심판진 입장')
  })

  it('건너뛰기 버튼 클릭 → onSkip·onDone 각각 한 번', () => {
    const onDone = vi.fn()
    const onSkip = vi.fn()
    render(<EntranceOverlay script={script} onDone={onDone} onSkip={onSkip} />)
    const btn = screen.getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' })
    fireEvent.click(btn)
    fireEvent.click(btn) // 두 번 눌러도 한 번만 끝난다.
    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Esc(및 아무 키)로 건너뛴다', () => {
    const onDone = vi.fn()
    render(<EntranceOverlay script={script} onDone={onDone} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('자체 클럭이 경과 ms를 onProgress로 흘려보낸다(첫 rAF now가 t0)', () => {
    const onProgress = vi.fn()
    render(<EntranceOverlay script={script} onDone={() => {}} onProgress={onProgress} />)
    frame(1000)
    frame(1500)
    expect(onProgress.mock.calls.map(c => c[0])).toEqual([0, 500])
  })

  it('총 길이에 도달하면 스스로 onDone하고 더 이상 프레임을 예약하지 않는다', () => {
    const onDone = vi.fn()
    render(<EntranceOverlay script={script} onDone={onDone} />)
    frame(0)
    frame(TOTAL)
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
        <EntranceOverlay script={script} onDone={onDone} onProgress={onProgress} />
      </StrictMode>,
    )
    // StrictMode는 마운트 시 이펙트를 정리→재실행한다. 그 뒤에도 프레임이 흘러야 한다.
    frame(1000)
    frame(1400)
    expect(onProgress.mock.calls.map(c => c[0])).toEqual([0, 400])
    // 총 길이에 도달하면 여전히 정확히 한 번만 끝난다.
    frame(1000 + TOTAL)
    expect(onDone).toHaveBeenCalledTimes(1)
    rerender(<StrictMode />)
  })

  it('언마운트하면 rAF가 취소되고, 남아 있던 콜백을 억지로 돌려도 아무 일이 없다', () => {
    const onProgress = vi.fn()
    const onDone = vi.fn()
    const { unmount } = render(<EntranceOverlay script={script} onDone={onDone} onProgress={onProgress} />)
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

  // ── 컷3·컷4 ────────────────────────────────────────────────────
  it('컷1·컷2에는 소개 패널이 없다(피치를 가리지 않는다)', () => {
    const { container } = render(<EntranceOverlay script={script} onDone={() => {}} />)
    expect(container.querySelector('.ent__close')).toBeNull()
    expect(container.querySelector('.ent__map')).toBeNull()
  })

  it('컷3 — 우리 팀 포메이션 도해(11 도트) + 선수 명단(11행)을 나란히 띄운다', () => {
    const gkBeat = script.beats.find(b => b.side === 'home' && b.playerId)!
    render(<EntranceOverlay script={script} onDone={() => {}} startMs={gkBeat.start + 10} />)
    // 도해: 11 도트, 그중 호명 중인 하나만 강조.
    expect(document.querySelectorAll('.ent__dot')).toHaveLength(11)
    expect(document.querySelectorAll('.ent__dot--on')).toHaveLength(1)
    // 명단: 11행, 그중 하나만 강조. 등번호·이름·포지션이 전부 있다.
    const rows = document.querySelectorAll('.ent__row')
    expect(rows).toHaveLength(11)
    expect(document.querySelectorAll('.ent__row--on')).toHaveLength(1)
    const gk = cast.home[0]
    expect(rows[0].textContent).toContain(String(gk.number))
    expect(rows[0].textContent).toContain(gk.nameKo)
    expect(rows[0].textContent).toContain('골키퍼')
    // 지금 강조된 행이 곧 호명 중인 선수다.
    expect(document.querySelector('.ent__row--on')!.textContent).toContain(gk.nameKo)
  })

  it('컷4 — 상대 팀 차례가 되면 같은 구성이 상대 명단으로 갈린다', () => {
    const awayBeat = script.beats.find(b => b.side === 'away' && b.playerId)!
    const { container } = render(
      <EntranceOverlay script={script} onDone={() => {}} startMs={awayBeat.start + 10} />,
    )
    expect(container.querySelector('.ent')!.getAttribute('data-side')).toBe('away')
    const rows = document.querySelectorAll('.ent__row')
    expect(rows).toHaveLength(11)
    expect(rows[0].textContent).toContain(cast.away[0].nameKo)
    // 우리 팀 이름은 이 패널에 없다(컷이 넘어갔다).
    expect(container.querySelector('.ent__close')!.textContent).not.toContain(cast.home[0].nameKo)
  })

  it('이름이 불릴 때마다 하이라이트가 다음 선수로 옮겨 간다', () => {
    const beats = script.beats.filter(b => b.side === 'home' && b.playerId)
    const first = beats[0]
    const second = beats[1]
    render(<EntranceOverlay script={script} onDone={() => {}} startMs={first.start + 10} />)
    expect(document.querySelector('.ent__row--on')!.textContent).toContain(cast.home[0].nameKo)
    frame(0)
    frame(second.start - first.start + 20)
    const on = document.querySelector('.ent__row--on')!
    expect(on.textContent).toContain(
      cast.home.find(m => m.id === second.playerId)!.nameKo,
    )
  })

  // ── 비트 콜백(부모가 이걸로 발화한다) ────────────────────────────
  it('비트가 시작될 때 onBeat를 정확히 한 번 부른다', () => {
    const onBeat = vi.fn()
    const b0 = script.beats[0]
    const b1 = script.beats[1]
    render(
      <EntranceOverlay script={script} onDone={() => {}} onBeat={onBeat} startMs={b0.start - 30} />,
    )
    frame(0)
    expect(onBeat).not.toHaveBeenCalled() // 아직 첫 비트 전
    frame(40) // b0 진입
    expect(onBeat).toHaveBeenCalledTimes(1)
    expect(onBeat.mock.calls[0][0].speech).toBe(b0.speech)
    frame(45) // 같은 비트 안 — 다시 부르지 않는다
    expect(onBeat).toHaveBeenCalledTimes(1)
    frame(30 + (b1.start - b0.start) + 10) // b1 진입
    expect(onBeat).toHaveBeenCalledTimes(2)
    expect(onBeat.mock.calls[1][0].speech).toBe(b1.speech)
  })

  it('중계 문장을 화자 배지와 함께 자막으로 보여 준다(TTS 없이도 읽힌다)', () => {
    const b0 = script.beats[0]
    render(<EntranceOverlay script={script} onDone={() => {}} startMs={b0.start + 10} />)
    const line = screen.getByTestId('entrance-line')
    expect(line.textContent).toContain('캐스터')
    expect(line.textContent).toContain(b0.text)
  })

  // ── 짧은 판 ─────────────────────────────────────────────────────
  it('short 모드는 소개 컷이 없고, onExpand가 있으면 전체 보기 버튼이 뜬다', () => {
    const shortScript = entranceScript(cast, 'short')
    const onExpand = vi.fn()
    const { container } = render(
      <EntranceOverlay script={shortScript} onDone={() => {}} onExpand={onExpand} />,
    )
    expect(container.querySelector('.ent__close')).toBeNull()
    const btn = screen.getByRole('button', { name: '선수 소개 보기' })
    fireEvent.click(btn)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})
