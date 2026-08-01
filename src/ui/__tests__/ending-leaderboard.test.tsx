// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { LeaderboardRow } from '../../online/leaderboard'

// submitScore/topScores 는 mock (computeScore 는 실제 사용).
const submitMock = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; mode: 'supabase' | 'local' }>>()
const topMock = vi.fn<(...a: unknown[]) => Promise<{ rows: LeaderboardRow[]; mode: 'supabase' | 'local' }>>()
vi.mock('../../online/leaderboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../online/leaderboard')>()
  return {
    ...actual,
    submitScore: (...a: unknown[]) => submitMock(...a),
    topScores: (...a: unknown[]) => topMock(...a),
  }
})

import { EndingScreen } from '../campaign/EndingScreen'
import { useCampaignStore } from '../../game/campaignStore'

const store = () => useCampaignStore.getState()
const win = (a = 2, b = 0) => store().recordResult([a, b], {})

beforeEach(() => {
  store().reset()
  submitMock.mockReset()
  topMock.mockReset()
  submitMock.mockResolvedValue({ ok: true, mode: 'local' })
})
afterEach(() => cleanup())

function playChampion() {
  store().startCampaign(1)
  win(); win(); win()
  for (let i = 0; i < 5; i++) win()
}

// 시드가 판마다 달라졌으므로(2026-08-01) 엔딩 화면이 시드를 유저에게 돌려줘야 한다.
// 이게 없으면 "매번 다른 랜덤"일 뿐이고, 결정론 엔진을 만든 의미가 사라진다.
describe('EndingScreen 시드 표시', () => {
  it('이 판의 시드를 숫자와 ?seed= 안내로 보여준다', () => {
    store().startCampaign(246810)
    win(); win(); win()
    for (let i = 0; i < 5; i++) win()
    const { container } = render(<EndingScreen onRestart={() => {}} />)
    const seedCard = container.querySelector('.end-seed')!
    expect(seedCard).toBeTruthy()
    expect(seedCard.querySelector('.end-seed__val')!.textContent).toBe('246810')
    expect(seedCard.textContent).toContain('?seed=246810')
  })

  it('클립보드가 없는 환경에서는 [링크 복사]를 그리지 않는다(눌러도 안 되는 버튼 금지)', () => {
    store().startCampaign(246810)
    win(); win(); win()
    for (let i = 0; i < 5; i++) win()
    // jsdom 기본에는 navigator.clipboard가 없다 — 비보안 컨텍스트와 같은 조건.
    const { container } = render(<EndingScreen onRestart={() => {}} />)
    if (!navigator.clipboard) {
      expect(container.querySelector('.end-seed__copy')).toBeNull()
    }
  })
})

describe('EndingScreen 리더보드 등록 플로우', () => {
  it('점수 브레이크다운 표와 합계를 렌더한다', () => {
    playChampion()
    const { container, getByText } = render(<EndingScreen onRestart={() => {}} />)
    expect(container.querySelector('.end-score')).toBeTruthy()
    expect(getByText('업셋 보너스')).toBeTruthy()
    expect(getByText('합계')).toBeTruthy()
  })

  it('닉네임 입력 후 [기록 등록] → submitScore/topScores 호출, 순위 렌더', async () => {
    topMock.mockResolvedValue({
      rows: [
        { nickname: '나야나', total: 5000, reached: 'final', champion: true },
        { nickname: '상대', total: 300, reached: 'r16', champion: false },
      ],
      mode: 'local',
    })
    playChampion()
    const { container, getByRole, getByText } = render(<EndingScreen onRestart={() => {}} />)

    fireEvent.change(container.querySelector('.end-nick')!, { target: { value: '나야나' } })
    fireEvent.click(getByRole('button', { name: '기록 등록' }))

    await waitFor(() => expect(topMock).toHaveBeenCalledWith(10))
    expect(submitMock).toHaveBeenCalledTimes(1)
    expect(submitMock.mock.calls[0][0]).toBe('나야나')

    // 순위 목록 렌더
    await waitFor(() => expect(container.querySelector('.end-board')).toBeTruthy())
    expect(getByText('나야나')).toBeTruthy()
    // local 모드 뱃지
    expect(getByText('이 기기 기록')).toBeTruthy()
  })

  it('빈 닉네임은 익명 감독으로 정제되어 제출된다', async () => {
    topMock.mockResolvedValue({ rows: [], mode: 'local' })
    playChampion()
    const { getByRole } = render(<EndingScreen onRestart={() => {}} />)
    fireEvent.click(getByRole('button', { name: '기록 등록' }))
    await waitFor(() => expect(submitMock).toHaveBeenCalled())
    expect(submitMock.mock.calls[0][0]).toBe('익명 감독')
  })

  it('supabase 모드면 "이 기기 기록" 뱃지가 없다', async () => {
    topMock.mockResolvedValue({
      rows: [{ nickname: '온라인', total: 100, reached: 'r32', champion: false }],
      mode: 'supabase',
    })
    playChampion()
    const { getByRole, queryByText } = render(<EndingScreen onRestart={() => {}} />)
    fireEvent.click(getByRole('button', { name: '기록 등록' }))
    await waitFor(() => expect(topMock).toHaveBeenCalled())
    await waitFor(() => expect(queryByText('리더보드 TOP 10')).toBeTruthy())
    expect(queryByText('이 기기 기록')).toBeNull()
  })
})
