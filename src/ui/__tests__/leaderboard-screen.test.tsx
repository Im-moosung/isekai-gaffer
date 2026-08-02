// @vitest-environment jsdom
// 독립 리더보드 페이지 — 네 상태(로딩/목록/비어있음/실패)와 [타이틀로 돌아가기].
//
// 이 화면의 계약은 "Supabase가 죽어도 하얀 화면이 되지 않는다"이다. 그래서 실패·빈 목록을
// 테스트로 못 박는다 — 조회 코드는 엔딩 화면과 공유되므로 여기서 깨지면 엔딩도 함께 깨진다.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { LeaderboardRow } from '../../online/leaderboard'

const topMock = vi.fn<(...a: unknown[]) => Promise<{ rows: LeaderboardRow[]; mode: 'supabase' | 'local' }>>()
vi.mock('../../online/leaderboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../online/leaderboard')>()
  return { ...actual, topScores: (...a: unknown[]) => topMock(...a) }
})

import { LeaderboardScreen } from '../leaderboard/LeaderboardScreen'

beforeEach(() => topMock.mockReset())
afterEach(() => cleanup())

describe('LeaderboardScreen', () => {
  it('상위 50위를 요청하고 순위·닉네임·도달·점수를 렌더한다', async () => {
    topMock.mockResolvedValue({
      rows: [
        { nickname: '일등', total: 3000, reached: 'final', champion: true },
        { nickname: '이등', total: 900, reached: 'sf', champion: false },
        { nickname: '삼등', total: 400, reached: 'qf', champion: false },
        { nickname: '사등', total: 100, reached: 'r32', champion: false },
      ],
      mode: 'supabase',
    })
    const { container, getByText } = render(<LeaderboardScreen onBackToTitle={() => {}} />)

    await waitFor(() => expect(topMock).toHaveBeenCalledWith(50))
    await waitFor(() => expect(container.querySelectorAll('.lb-row')).toHaveLength(4))

    expect(getByText('일등')).toBeTruthy()
    expect(getByText('우승')).toBeTruthy()   // champion은 라운드 이름 대신 '우승'
    expect(getByText('4강')).toBeTruthy()
    // 1~3위는 시각적으로 구분된다.
    const rows = container.querySelectorAll('.lb-row')
    expect(rows[0].className).toContain('lb-row--gold')
    expect(rows[1].className).toContain('lb-row--silver')
    expect(rows[2].className).toContain('lb-row--bronze')
    expect(rows[3].className).not.toContain('lb-row--')
  })

  it('빈 리더보드에서도 깨지지 않고 안내 문장을 남긴다', async () => {
    topMock.mockResolvedValue({ rows: [], mode: 'local' })
    const { container } = render(<LeaderboardScreen onBackToTitle={() => {}} />)

    await waitFor(() => expect(container.querySelector('.lb-note')).toBeTruthy())
    expect(container.querySelector('.lb-list')).toBeNull()
    expect(container.textContent).toContain('아직 등록된 기록이 없습니다')
    // 페이지 자체는 살아 있다 — 돌아갈 길이 남아야 한다.
    expect(container.textContent).toContain('타이틀로 돌아가기')
  })

  it('조회가 실패해도 하얀 화면이 되지 않고 [다시 시도]로 재조회한다', async () => {
    topMock.mockRejectedValueOnce(new Error('boom'))
    const { container, getByRole } = render(<LeaderboardScreen onBackToTitle={() => {}} />)

    await waitFor(() => expect(container.querySelector('.lb-note--error')).toBeTruthy())
    expect(container.textContent).toContain('순위를 불러오지 못했습니다')

    topMock.mockResolvedValue({
      rows: [{ nickname: '복구', total: 50, reached: 'group3', champion: false }],
      mode: 'local',
    })
    fireEvent.click(getByRole('button', { name: '다시 시도' }))
    await waitFor(() => expect(container.querySelector('.lb-list')).toBeTruthy())
    expect(container.textContent).toContain('복구')
  })

  it('[타이틀로 돌아가기]가 콜백을 부른다', async () => {
    topMock.mockResolvedValue({ rows: [], mode: 'local' })
    const back = vi.fn()
    const { getByRole } = render(<LeaderboardScreen onBackToTitle={back} />)
    fireEvent.click(getByRole('button', { name: '타이틀로 돌아가기' }))
    expect(back).toHaveBeenCalledTimes(1)
  })
})
