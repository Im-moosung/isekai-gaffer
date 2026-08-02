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

// [2026-08-02] "EndingScreen 시드 표시" describe 2건을 제거했다.
// 시드 카드(숫자 · ?seed= 안내 · [링크 복사])를 UI에서 걷어냈기 때문이다 — 사용자 판단.
// 엔진의 시드는 그대로이므로 결정론 계약 테스트(src/game/__tests__/seed.test.ts,
// 밸런스 테스트 전체)는 손대지 않았다. 사라진 것은 화면 표시뿐이다.

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

    // 순위 목록 렌더 — 공용 컴포넌트(.lb-list)가 그린다.
    await waitFor(() => expect(container.querySelector('.lb-list')).toBeTruthy())
    expect(container.querySelector('.end-board')).toBeTruthy()
    expect(getByText('나야나')).toBeTruthy()
    // local 모드 뱃지는 조회가 끝난 뒤에만 나온다(로딩 중에 "이 기기 기록"이라 단정하지 않는다).
    await waitFor(() => expect(getByText('이 기기 기록')).toBeTruthy())
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
    expect(queryByText('리더보드 TOP 10')).toBeTruthy()
    // 조회가 끝나 행이 그려진 뒤에 판정해야 "아직 로딩 중이라 없었다"로 통과하지 않는다.
    await waitFor(() => expect(queryByText('온라인')).toBeTruthy())
    expect(queryByText('이 기기 기록')).toBeNull()
  })
})
