// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useCampaignStore } from '../../game/campaignStore'
import { SEED_MIN, SEED_MAX } from '../../game/seed'
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

  // 첫인상 화면의 훅 문안. 심사 1차가 이 화면으로 갈리므로 개발 빌드 흔적이 되살아나면 실패시킨다.
  it('대체역사 훅 문안이 보이고 "개발 빌드"·"Phase" 표기는 없다', () => {
    const { container } = render(<App />)
    const text = container.textContent ?? ''
    expect(text).toContain('대체역사 축구 감독 시뮬레이션')
    expect(text).toContain('2026년 6월, 대한민국은 1승 2패로 조별리그를 마쳤다.')
    expect(text).toContain('당신에게 90분과 다섯 번의 개입이 주어진다.')
    expect(text).toContain('실제 대회 데이터 기반 · 12개국 312명 · 시드 재현 시뮬레이션')
    expect(text).not.toContain('개발 빌드')
    expect(text).not.toContain('Phase')
    // 데모 배너 문구는 랜딩에 노출되지 않는다(데모 화면 전용).
    expect(text).not.toContain('리더보드 미반영')
  })

  it('[캠페인 시작] → 허브 렌더(여정 조별 3칸 + 접힌 토너먼트 + 첫 상대 체코)', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))

    // 토너먼트 5칸은 기본 접힘 — 조별 3칸 + .jl-fold 1행
    expect(container.querySelectorAll('.jl-row')).toHaveLength(3)
    expect(container.querySelector('.jl-fold')).toBeTruthy()
    expect(container.querySelector('.hub-hero__opp')!.textContent).toBe('체코')
    expect(useCampaignStore.getState().stage).toBe('group1')
  })

  it('허브 → [경기 준비] → 라인업 단독 화면 없이 곧바로 경기(전술 센터)로 진입', () => {
    const { getByRole, queryByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '체코전 준비하기' }))
    // 라인업 단독 화면(확정 버튼)은 더 이상 라우팅에 없다 — 전술 센터가 흡수했다.
    expect(queryByRole('button', { name: '라인업 확정' })).toBeNull()
    // MatchScreen이 목이므로 경기 종료 버튼이 곧바로 보인다.
    expect(getByRole('button', { name: '경기 종료(목)' })).toBeTruthy()
  })
})

// 시드 발급 — 예전에는 App.tsx 상수 20260724가 모든 플레이어의 1경기를 같은 판으로 묶었다.
// 이제는 판마다 새로 뽑고, 주소에 ?seed=가 있으면 그 판을 그대로 다시 연다.
describe('App 캠페인 시드 발급', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('[캠페인 시작]마다 6자리 시드를 새로 뽑는다(상수 20260724가 아니다)', () => {
    const { getByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    const seed = useCampaignStore.getState().seed
    expect(seed).toBeGreaterThanOrEqual(SEED_MIN)
    expect(seed).toBeLessThanOrEqual(SEED_MAX)
    expect(seed).not.toBe(20260724)
  })

  it('주소에 ?seed=가 있으면 그 판으로 시작한다(친구와 같은 판 = 링크 하나)', () => {
    window.history.replaceState({}, '', '/?seed=246810')
    const { getByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    expect(useCampaignStore.getState().seed).toBe(246810)
  })

  it('?seed=가 잘못됐으면 조용히 새 판을 뽑는다', () => {
    window.history.replaceState({}, '', '/?seed=nope')
    const { getByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    const seed = useCampaignStore.getState().seed
    expect(seed).toBeGreaterThanOrEqual(SEED_MIN)
    expect(seed).toBeLessThanOrEqual(SEED_MAX)
  })
})

describe('App 데모 플로우 스모크', () => {
  it('[바로 지휘하기] → 곧바로 경기 진입 + "리더보드 미반영" 표기', () => {
    const { getByRole, queryByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '바로 지휘하기' }))
    // 데모도 라인업 단독 화면을 거치지 않는다(캠페인과 동일).
    expect(queryByRole('button', { name: '라인업 확정' })).toBeNull()
    expect(container.textContent).toContain('리더보드 미반영')
    // 목 MatchScreen이 onMatchEnd를 받아 경기 종료 버튼을 노출(데모도 조립됨)
    expect(getByRole('button', { name: '경기 종료(목)' })).toBeTruthy()
  })

  it('데모: 경기 종료 → 기자회견 3답변 → 신문(FICTION) → [다음] → 랜딩 복귀', async () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '바로 지휘하기' }))
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
    fireEvent.click(getByRole('button', { name: '체코전 준비하기' }))

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
    expect(container.querySelector('.hub-hero__opp')!.textContent).toBe('멕시코')
  })
})
