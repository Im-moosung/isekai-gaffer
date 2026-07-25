// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { HubScreen } from '../campaign/HubScreen'
import { EndingScreen } from '../campaign/EndingScreen'
import { useCampaignStore } from '../../game/campaignStore'

const store = () => useCampaignStore.getState()
const win = (a = 2, b = 0) => store().recordResult([a, b], {})

const BANNED = ['최악', '한심', '형편없', '멍청']

beforeEach(() => store().reset())
afterEach(() => cleanup())

describe('HubScreen 스모크', () => {
  it('캠페인 시작 상태에서 cze 상대 카드·진행 바(8칸)를 렌더하고 버튼이 onProceed를 호출한다', () => {
    store().startCampaign(7)
    const onProceed = vi.fn()
    const { container, getByRole } = render(<HubScreen onProceed={onProceed} />)

    // 진행 바 8칸
    expect(container.querySelectorAll('.hub-step')).toHaveLength(8)
    // 현 위치(group1) 하이라이트
    expect(container.querySelector('.hub-step--current')).toBeTruthy()
    // 다음 상대 카드 = 체코
    expect(container.querySelector('.hub-oppcard__name')!.textContent).toBe('체코')
    // 선호 포메이션 원문 노출
    expect(container.querySelector('.hub-oppcard__meta dd')!.textContent).toContain('3-4-2-1')

    fireEvent.click(getByRole('button', { name: '경기 준비' }))
    expect(onProceed).toHaveBeenCalledTimes(1)
  })

  it('ended 상태에서는 null을 반환한다', () => {
    store().startCampaign(1)
    win(); win(); win() // 조 전승 → r32
    for (let i = 0; i < 5; i++) win() // r32~final 전승 → ended
    const { container } = render(<HubScreen onProceed={() => {}} />)
    expect(container.querySelector('.hub-root')).toBeNull()
  })
})

describe('EndingScreen 스모크', () => {
  it('전승 조작 후 champion 엔딩에서 우승 헤드라인을 렌더한다', () => {
    store().startCampaign(1)
    win(); win(); win()
    for (let i = 0; i < 5; i++) win()
    expect(store().ending).toEqual({ reached: 'final', champion: true })

    const { container } = render(<EndingScreen onRestart={() => {}} />)
    const headline = container.querySelector('.end-headline')!.textContent!
    expect(headline).toContain('세계를 제패')
    // 기록 요약 존재
    expect(container.querySelector('.end-summary')).toBeTruthy()
  })

  it('[처음부터] 클릭 → onRestart 호출', () => {
    store().startCampaign(1)
    win(); win(); win()
    for (let i = 0; i < 5; i++) win()
    const onRestart = vi.fn()
    const { getByRole } = render(<EndingScreen onRestart={onRestart} />)
    fireEvent.click(getByRole('button', { name: '처음부터' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('모든 라운드 헤드라인에 금지어(최악·한심·형편없·멍청)가 없다', () => {
    // group3 탈락
    store().startCampaign(3)
    win(2, 1)
    store().recordResult([0, 1], {})
    store().recordResult([0, 1], {})
    expect(store().ending!.reached).toBe('group3')
    const { container, unmount } = render(<EndingScreen onRestart={() => {}} />)
    const groupText = container.querySelector('.end-card')!.textContent!
    for (const w of BANNED) expect(groupText).not.toContain(w)
    expect(container.querySelector('.end-headline')!.textContent).toContain('조별리그 탈락')
    unmount()

    // 각 토너먼트 패배 라운드(r32·r16·qf·sf) + 준우승(final) 헤드라인 금지어 검사
    const rounds: [number, string][] = [
      [0, 'r32'], [1, 'r16'], [2, 'qf'], [3, 'sf'], [4, 'final'],
    ]
    for (const [lossAt] of rounds) {
      store().reset()
      store().startCampaign(1)
      win(); win(); win() // 조 전승 → r32
      for (let i = 0; i < lossAt; i++) win() // 해당 라운드 전까지 전승
      store().recordResult([0, 1], {}) // 해당 라운드 패배
      expect(store().stage).toBe('ended')
      const { container: c, unmount: u } = render(<EndingScreen onRestart={() => {}} />)
      const text = c.querySelector('.end-card')!.textContent!
      for (const w of BANNED) expect(text).not.toContain(w)
      u()
    }
  })
})
