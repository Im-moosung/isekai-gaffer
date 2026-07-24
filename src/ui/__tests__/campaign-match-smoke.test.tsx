// @vitest-environment jsdom
// P4A Task 10: App 레벨 캠페인 경기 스모크 — 매치데이 2.0 스토어 변경 후 캠페인 경로 정합 확인.
// 실 MatchScreen(목 아님)을 통해 캠페인 시작 → 허브 → 라인업 → 경기 진입(킥오프 버튼 존재)까지
// 크래시 없이 도달함을 검증한다. (자동 완주 회귀는 campaign-integration.test.ts가 담당)
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useCampaignStore } from '../../game/campaignStore'
import { useMatchStore } from '../../game/matchStore'
import App from '../../App'

beforeEach(() => {
  useCampaignStore.getState().reset()
  useMatchStore.getState().reset()
})
afterEach(() => cleanup())

describe('App 캠페인 경기 스모크 — 실 MatchScreen 진입', () => {
  it('캠페인 시작 → 라인업 짜기 → 라인업 확정 → 경기 화면(킥오프 버튼 + pre phase)', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '라인업 짜기' }))
    fireEvent.click(getByRole('button', { name: '라인업 확정' }))

    // 실 MatchScreen 진입 — 킥오프 버튼 + 피치 SVG 존재, 아직 킥오프 전(pre).
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    expect(container.querySelector('svg.pv-root')).toBeTruthy()
    expect(useMatchStore.getState().phase).toBe('pre')
    // 음소거 토글이 스코어버그 옆에 렌더된다(aria-label).
    expect(getByRole('button', { name: '음소거' })).toBeTruthy()
  })
})
