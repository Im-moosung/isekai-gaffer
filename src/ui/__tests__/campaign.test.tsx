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
  it('캠페인 시작 상태에서 cze 상대 카드·여정 사다리(8칸)를 렌더하고 버튼이 onProceed를 호출한다', () => {
    store().startCampaign(7)
    const onProceed = vi.fn()
    const { container, getByRole } = render(<HubScreen onProceed={onProceed} />)

    // 여정 사다리 8칸
    expect(container.querySelectorAll('.jl-row')).toHaveLength(8)
    // 현 위치(group1) 하이라이트
    expect(container.querySelector('.jl-row--current')).toBeTruthy()
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

describe('여정 사다리(JourneyLadder)', () => {
  it('시작 직후: 조별 3칸은 대진 확정, 토너먼트 5칸은 상대 미정, 관문은 대기', () => {
    store().startCampaign(7)
    const { container } = render(<HubScreen onProceed={() => {}} />)
    const opps = [...container.querySelectorAll('.jl-row__opp')].map(e => e.textContent)
    expect(opps.slice(0, 3)).toEqual(['체코', '멕시코', '남아프리카공화국'])
    expect(opps.slice(3)).toEqual(Array(5).fill('상대 미정'))
    expect(container.querySelector('.jl-gate--pending')).toBeTruthy()
    // 실제 역사 기준선은 조별 3칸에만 붙는다
    expect(container.querySelectorAll('.jl-row__hist')).toHaveLength(3)
  })

  it('조별 2경기 후: 지나온 칸에 스코어와 실제 역사 대비 판정이 남는다', () => {
    store().startCampaign(7)
    win(3, 0)            // 실제 역사 2-1 승 → 승패는 같고 점수차가 크다
    store().recordResult([2, 0], {}) // 실제 역사 0-1 패 → 역사를 넘었다
    const { container } = render(<HubScreen onProceed={() => {}} />)
    const rows = container.querySelectorAll('.jl-row')
    expect(rows[0].className).toContain('jl-row--w')
    expect(rows[0].querySelector('.jl-row__score')!.textContent).toBe('3-0')
    expect(rows[0].querySelector('.jl-row__verdict')!.textContent).toBe('역사보다 나은 결과')
    expect(rows[1].querySelector('.jl-row__verdict')!.textContent).toBe('역사를 넘었다')
    // 3차전이 현재 칸
    expect(rows[2].className).toContain('jl-row--current')
  })

  it('승패가 같고 점수차가 나쁘면 강등하지 않는다 — 판정은 올리기만 한다', () => {
    store().startCampaign(7)
    win(3, 0)
    store().recordResult([0, 2], {}) // 실제 역사 0-1 패보다 더 크게 졌다
    const { container } = render(<HubScreen onProceed={() => {}} />)
    const rows = container.querySelectorAll('.jl-row')
    // 같은 패배에 "미치지 못했다"를 또 붙이면 이중으로 나무라는 셈이다
    expect(rows[1].querySelector('.jl-row__verdict')!.textContent).toBe('역사와 같은 결과')
  })

  it('토너먼트 진출 후: 관문이 통과로 바뀌고 32강이 현재 칸이 된다', () => {
    store().startCampaign(7)
    win(); win(); win()
    const { container } = render(<HubScreen onProceed={() => {}} />)
    expect(container.querySelector('.jl-gate--pass')!.textContent).toContain('토너먼트 진출')
    const rows = container.querySelectorAll('.jl-row')
    expect(rows[3].className).toContain('jl-row--current')
    expect(rows[3].querySelector('.jl-row__opp')!.textContent).toBe('에콰도르')
  })

  it('탈락 엔딩: 사다리가 끊기고 남은 칸이 빈 채로 남는다', () => {
    store().startCampaign(7)
    win(); win(); win()                // 조 통과 → r32
    store().recordResult([0, 1], {})   // 32강 탈락
    const { container } = render(<EndingScreen onRestart={() => {}} />)
    // 32강 뒤 4칸(16강~결승)이 끊긴 칸
    expect(container.querySelectorAll('.jl-row--cut')).toHaveLength(4)
    expect(container.querySelector('.jl__cutnote')!.textContent).toContain('32강에서 여정이 멈췄다')
    // 현재 칸은 없다(엔딩)
    expect(container.querySelector('.jl-row--current')).toBeNull()
  })

  it('조별 탈락 엔딩: 관문이 실패로 표시되고 토너먼트 5칸이 모두 끊긴다', () => {
    store().startCampaign(3)
    win(2, 1)
    store().recordResult([0, 1], {})
    store().recordResult([0, 1], {})
    expect(store().ending!.reached).toBe('group3')
    const { container } = render(<EndingScreen onRestart={() => {}} />)
    expect(container.querySelector('.jl-gate--fail')).toBeTruthy()
    expect(container.querySelectorAll('.jl-row--cut')).toHaveLength(5)
  })

  it('우승 엔딩: 끊긴 칸이 없고 완주 문구가 붙는다', () => {
    store().startCampaign(1)
    win(); win(); win()
    for (let i = 0; i < 5; i++) win()
    const { container } = render(<EndingScreen onRestart={() => {}} />)
    expect(container.querySelectorAll('.jl-row--cut')).toHaveLength(0)
    expect(container.querySelector('.jl__cutnote--champion')).toBeTruthy()
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
