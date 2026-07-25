// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { MatchRecord } from '../../game/campaignStore'
import type { Headline } from '../../game/pressconf'

// aiClient.narrate 를 mock 하여 null(폴백) 을 반환 → 템플릿 헤드라인이 유지되는지 검증한다.
const narrateMock = vi.fn<(...a: unknown[]) => Promise<string | null>>()
vi.mock('../../ai/aiClient', () => ({ narrate: (...a: unknown[]) => narrateMock(...a) }))

import { PressConference } from '../press/PressConference'
import { NewspaperCard } from '../press/NewspaperCard'
import { useMatchStore } from '../../game/matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const RECORD: MatchRecord = {
  stage: 'r16',
  opponentId: 'eng',
  score: [2, 1],
  decisions: [
    { minute: 46, kind: 'teamtalk', summary: 'HT 팀토크: 격려' },
    { minute: 72, kind: 'sub', summary: "72' 교체: 오현규 IN, 조규성 OUT" },
  ],
}

beforeEach(() => { narrateMock.mockReset(); narrateMock.mockResolvedValue(null) })
afterEach(() => cleanup())

describe('PressConference', () => {
  it('질문 3개를 순차로 렌더하고 답변 3회 클릭 후 onDone(headline) 을 호출한다', async () => {
    const onDone = vi.fn()
    const { container } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={onDone} />,
    )
    // 첫 질문 표시
    expect(container.querySelector('.pc-question')).toBeTruthy()

    // 3문항: 매번 첫 번째(공격적) 답변 버튼 클릭
    for (let i = 0; i < 3; i++) {
      const btns = container.querySelectorAll<HTMLButtonElement>('.pc-answer')
      expect(btns.length).toBe(3)
      fireEvent.click(btns[0])
    }

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    const headline = onDone.mock.calls[0][0] as Headline
    expect(typeof headline.title).toBe('string')
    expect(headline.title.length).toBeGreaterThan(0)
    expect(typeof headline.sub).toBe('string')
    expect(typeof headline.quote).toBe('string')
  })

  it('narrate 가 null 이면 템플릿 헤드라인 그대로 onDone 에 전달한다(폴백)', async () => {
    const onDone = vi.fn()
    const { container } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={onDone} />,
    )
    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.pc-answer')[0])
    }
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const headline = onDone.mock.calls[0][0] as Headline
    // 템플릿 제목은 팀명을 포함한다(pressconf titleTemplates).
    expect(headline.title).toContain('대한민국')
    expect(narrateMock).toHaveBeenCalledWith('headline', expect.any(Object))
  })

  it('narrate 지연 중 onDone prop 참조가 바뀌어도 정확히 1회 호출된다', async () => {
    // narrate를 수동 resolve 가능한 pending promise로 둔다.
    let resolveNarrate!: (v: string | null) => void
    narrateMock.mockReturnValue(new Promise(r => { resolveNarrate = r }))

    const first = vi.fn()
    const second = vi.fn()
    const { container, rerender } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={first} />,
    )
    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.pc-answer')[0])
    }
    // narrate 아직 pending — 부모가 새 인라인 콜백 참조로 rerender(MatchScreen 실제 패턴)
    rerender(<PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={second} />)
    // 이제 narrate resolve
    resolveNarrate(null)
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(second).not.toHaveBeenCalled()
    expect(first.mock.calls[0][0]).toBeTruthy()
  })

  it('narrate 가 텍스트를 반환하면 그 텍스트가 title 을 대체한다', async () => {
    narrateMock.mockResolvedValue('AI가 쓴 헤드라인')
    const onDone = vi.fn()
    const { container } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={onDone} />,
    )
    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.pc-answer')[0])
    }
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const headline = onDone.mock.calls[0][0] as Headline
    expect(headline.title).toBe('AI가 쓴 헤드라인')
  })
})

describe('NewspaperCard', () => {
  const HEADLINE: Headline = {
    title: '대한민국, 잉글랜드를 넘다',
    sub: '16강 · 대한민국 2-1 잉글랜드',
    quote: '"끝까지 최선을 다했습니다." — 대한민국 감독',
  }

  it('제호·헤드라인 title·FICTION 워터마크를 렌더한다', () => {
    const { container, getByText } = render(
      <NewspaperCard headline={HEADLINE} record={RECORD} teamName="대한민국" />,
    )
    expect(getByText('리매치 타임스')).toBeTruthy()
    expect(getByText(HEADLINE.title)).toBeTruthy()
    // 워터마크에 FICTION 문자열 존재
    expect(container.textContent).toContain('FICTION')
    // 가상 날짜 고정(Date 미사용)
    expect(container.textContent).toContain('2026년 여름')
  })

  it('[이미지 저장] 버튼이 있다', () => {
    const { getByRole } = render(
      <NewspaperCard headline={HEADLINE} record={RECORD} teamName="대한민국" />,
    )
    expect(getByRole('button', { name: '이미지 저장' })).toBeTruthy()
  })

  it('[다음] 2연타 시 onNext는 1회만 호출된다(중복 기록 방지)', () => {
    const onNext = vi.fn()
    const { getByRole } = render(
      <NewspaperCard headline={HEADLINE} record={RECORD} teamName="대한민국" onNext={onNext} />,
    )
    const next = getByRole('button', { name: '다음' })
    fireEvent.click(next)
    fireEvent.click(next)
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})

describe('PressConference — 플랜 이탈 연결', () => {
  it('matchPlan이 없으면(플랜 미수립) 추궁 질문이 없다', () => {
    useMatchStore.getState().reset()
    const { container } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={vi.fn()} />,
    )
    expect(container.querySelector('.pc-question')!.textContent).not.toContain('계획')
  })

  it('store의 planDeviation이 첫 질문을 이탈 추궁으로 바꾼다', () => {
    useMatchStore.getState().reset()
    useMatchStore.getState().startMatch(makeTestTeam('kor', 76), makeTestTeam('esp', 88), 20260724)
    act(() => { useMatchStore.getState().kickoff() })
    act(() => { useMatchStore.setState({ planDeviation: 5 }) })
    // RECORD는 2-1 승리 → 'pivot-win' 분기.
    const { container } = render(
      <PressConference record={RECORD} log={RECORD.decisions} teamName="대한민국" onDone={vi.fn()} />,
    )
    const q = container.querySelector('.pc-question')!.textContent!
    expect(q).toContain('5개 축')
    expect(q).toContain('원래 계획이 틀렸던')
    expect(container.querySelectorAll('.pc-answer')).toHaveLength(3)
  })
})
