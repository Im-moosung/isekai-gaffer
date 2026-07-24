// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { MatchRecord } from '../../game/campaignStore'
import type { Headline } from '../../game/pressconf'

// aiClient.narrate 를 mock 하여 null(폴백) 을 반환 → 템플릿 헤드라인이 유지되는지 검증한다.
const narrateMock = vi.fn<(...a: unknown[]) => Promise<string | null>>()
vi.mock('../../ai/aiClient', () => ({ narrate: (...a: unknown[]) => narrateMock(...a) }))

import { PressConference } from '../press/PressConference'
import { NewspaperCard } from '../press/NewspaperCard'

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
})
