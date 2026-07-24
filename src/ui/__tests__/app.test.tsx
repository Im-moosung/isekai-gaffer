// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import App from '../../App'
import { useCampaignStore } from '../../game/campaignStore'

beforeEach(() => useCampaignStore.getState().reset())
afterEach(() => cleanup())

describe('App 캠페인 전환 스모크', () => {
  it('랜딩에 [캠페인 시작]과 [데모 경기] 버튼이 있다', () => {
    const { getByRole } = render(<App />)
    expect(getByRole('button', { name: '캠페인 시작' })).toBeTruthy()
    expect(getByRole('button', { name: '데모 경기' })).toBeTruthy()
  })

  it('[캠페인 시작] → 허브 렌더(진행 바 8칸 + 첫 상대 체코)', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))

    expect(container.querySelectorAll('.hub-step')).toHaveLength(8)
    expect(container.querySelector('.hub-oppcard__name')!.textContent).toBe('체코')
    // 캠페인 store가 시작됨(group1)
    expect(useCampaignStore.getState().stage).toBe('group1')
  })

  it('허브 → [라인업 짜기] → 라인업 화면(포메이션·확정 버튼) 진입', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '라인업 짜기' }))
    expect(container.querySelector('.lu-root')).toBeTruthy()
    expect(getByRole('button', { name: '라인업 확정' })).toBeTruthy()
  })

  it('[데모 경기] → 데모 경기 화면(킥오프 버튼) 진입', () => {
    const { getByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '데모 경기' }))
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
  })
})
