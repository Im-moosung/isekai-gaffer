// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useCampaignStore } from '../../game/campaignStore'
import type { DecisionEntry } from '../../engine/types'

// MatchScreen을 경량 목으로 대체 — 경기 재생(타이머·결정 오버레이) 대신 즉시 onMatchEnd를
// 호출하는 버튼만 노출한다. 이렇게 하면 Task 7의 실제 조립분(경기 후 기자회견→신문→복귀)을
// MatchScreen 내부 동작 재검증 없이 스모크할 수 있다.
const matchEndArgs: {
  score: [number, number]
  shootout: [number, number] | undefined
  decisions: DecisionEntry[]
} = { score: [2, 0], shootout: undefined, decisions: [] }

vi.mock('../match/MatchScreen', () => ({
  MatchScreen: ({ onMatchEnd }: {
    onMatchEnd?: (
      score: [number, number],
      stamina: Record<string, number>,
      shootout: [number, number] | undefined,
      decisions: DecisionEntry[],
    ) => void
  }) => (
    <div className="ms-mock">
      {onMatchEnd ? (
        <button
          type="button"
          onClick={() => onMatchEnd(matchEndArgs.score, {}, matchEndArgs.shootout, matchEndArgs.decisions)}
        >
          경기 종료(목)
        </button>
      ) : (
        <span>데모(목)</span>
      )}
    </div>
  ),
}))

// aiClient.narrate → null 고정(폴백). 기자회견이 템플릿 헤드라인으로 즉시 완료된다.
vi.mock('../../ai/aiClient', () => ({ narrate: () => Promise.resolve(null) }))

import App from '../../App'

beforeEach(() => {
  useCampaignStore.getState().reset()
  matchEndArgs.score = [2, 0]
  matchEndArgs.shootout = undefined
  matchEndArgs.decisions = []
})
afterEach(() => cleanup())

describe('App 랜딩 스모크', () => {
  it('랜딩에 [캠페인 시작]과 [바로 지휘하기] 버튼이 있다', () => {
    const { getByRole } = render(<App />)
    expect(getByRole('button', { name: '캠페인 시작' })).toBeTruthy()
    expect(getByRole('button', { name: '바로 지휘하기' })).toBeTruthy()
  })

  it('[캠페인 시작] → 허브 렌더(진행 바 8칸 + 첫 상대 체코)', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))

    expect(container.querySelectorAll('.hub-step')).toHaveLength(8)
    expect(container.querySelector('.hub-oppcard__name')!.textContent).toBe('체코')
    expect(useCampaignStore.getState().stage).toBe('group1')
  })

  it('허브 → [라인업 짜기] → 라인업 화면(포메이션·확정 버튼) 진입', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '라인업 짜기' }))
    expect(container.querySelector('.lu-root')).toBeTruthy()
    expect(getByRole('button', { name: '라인업 확정' })).toBeTruthy()
  })
})

describe('App 데모 플로우 스모크', () => {
  it('[바로 지휘하기] → 라인업 선행(확정 버튼) → 경기 진입 + "리더보드 미반영" 표기', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '바로 지휘하기' }))
    // 데모도 라인업 화면이 먼저 등장한다(캠페인과 동일).
    expect(container.querySelector('.lu-root')).toBeTruthy()
    expect(getByRole('button', { name: '라인업 확정' })).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '라인업 확정' }))
    expect(container.textContent).toContain('리더보드 미반영')
    // 라인업 확정 후 목 MatchScreen이 onMatchEnd를 받아 경기 종료 버튼을 노출(데모도 조립됨)
    expect(getByRole('button', { name: '경기 종료(목)' })).toBeTruthy()
  })

  it('데모: 라인업 → 경기 종료 → 기자회견 3답변 → 신문(FICTION) → [다음] → 랜딩 복귀', async () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '바로 지휘하기' }))
    fireEvent.click(getByRole('button', { name: '라인업 확정' }))
    fireEvent.click(getByRole('button', { name: '경기 종료(목)' }))

    // 기자회견 렌더(질문 존재)
    await waitFor(() => expect(container.querySelector('.pc-question')).toBeTruthy())
    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.pc-answer')[0])
    }

    // 신문 카드(FICTION 워터마크)
    await waitFor(() => expect(container.querySelector('.np-card')).toBeTruthy())
    expect(container.textContent).toContain('FICTION')

    // [다음] → 랜딩 복귀
    fireEvent.click(getByRole('button', { name: '다음' }))
    await waitFor(() => expect(getByRole('button', { name: '바로 지휘하기' })).toBeTruthy())
  })
})

describe('App 캠페인 경기 후 플로우 스모크', () => {
  it('경기 결과 → 기자회견(질문) → 3답변 → 신문(FICTION) → [다음] → 허브(다음 상대)', async () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '라인업 짜기' }))
    fireEvent.click(getByRole('button', { name: '라인업 확정' }))

    // 목 MatchScreen에서 경기 종료
    fireEvent.click(getByRole('button', { name: '경기 종료(목)' }))

    // 기자회견 — 질문 존재
    await waitFor(() => expect(container.querySelector('.pc-question')).toBeTruthy())
    for (let i = 0; i < 3; i++) {
      fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.pc-answer')[0])
    }

    // 신문 1면 — FICTION
    await waitFor(() => expect(container.querySelector('.np-card')).toBeTruthy())
    expect(container.textContent).toContain('FICTION')

    // [다음] → recordResult로 group2 전진 + 허브 복귀
    fireEvent.click(getByRole('button', { name: '다음' }))
    await waitFor(() => expect(container.querySelector('.hub-root')).toBeTruthy())
    expect(useCampaignStore.getState().stage).toBe('group2')
    // 다음 상대는 멕시코
    expect(container.querySelector('.hub-oppcard__name')!.textContent).toBe('멕시코')
  })
})
