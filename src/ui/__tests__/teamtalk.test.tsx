// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { TeamTalk } from '../match/TeamTalk'
import { useMatchStore } from '../../game/matchStore'
import { useCampaignStore } from '../../game/campaignStore'
import { getLine } from '../../game/teamTalkLines'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => { store().reset(); useCampaignStore.getState().reset() })
afterEach(() => cleanup())

/** 킥오프→하프타임 재생(하이드레이션 브레이크는 재개). */
function toHalftime() {
  store().kickoff()
  let guard = 0
  while (store().phase !== 'halftime' && guard++ < 200) {
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

describe('TeamTalk 컴포넌트', () => {
  it('4톤 문장형 버튼(톤 라벨 + 상황별 문장)을 렌더한다', () => {
    // 시드 37: 전반 0-0(=drawing). 세트피스·퇴장 배선으로 기존 시드 42의 전반이 0-0이 아니게 되어
    // **상황이 drawing인 시드**로 갈아끼운다. 테스트 의도(상황별 문장·보정치)는 그대로다.
    store().startMatch(a, b, 37) // 0-0 → drawing
    toHalftime()
    const { getByRole } = render(<TeamTalk side="home" />)
    for (const label of ['격노', '격려', '침착', '신뢰']) {
      expect(getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }
    // 상황(비기는 중)에 맞는 문장이 노출된다.
    const rageLine = getLine('rage', 'drawing', 37)
    expect((getByRole('button', { name: new RegExp('격노') }).textContent ?? '')).toContain(rageLine)
  })

  it('사기 게이지 사전 정보를 노출한다', () => {
    store().startMatch(a, b, 37)
    toHalftime()
    const { container } = render(<TeamTalk side="home" />)
    expect(container.querySelector('.tt-morale')).toBeTruthy()
    expect(container.querySelector('.tt-morale__status')?.textContent).toContain('사기')
  })

  it('선택 시 즉시 효과 배너(+/사기 상승)와 선수 반응 아이콘을 크게 표시', () => {
    // 비기는 중(0-0) → 침착 +4(even)
    store().startMatch(a, b, 37)
    toHalftime()
    const { getByRole, container } = render(<TeamTalk side="home" />)
    fireEvent.click(getByRole('button', { name: new RegExp('침착') }))

    const banner = container.querySelector('.tt-banner--up')
    expect(banner).toBeTruthy()
    expect(banner?.textContent).toContain('선수단 사기 상승 (+4)')
    // 선수별 반응 2~3명
    const reactions = container.querySelectorAll('.tt-reactions__item')
    expect(reactions.length).toBeGreaterThanOrEqual(2)
    expect(reactions.length).toBeLessThanOrEqual(3)
    // 버튼 비활성
    for (const label of ['격노', '격려', '침착', '신뢰']) {
      expect((getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('역효과(이기는 중 격노) → 저하 배너(-)', () => {
    // 이기는 중(1-0) → 격노 -4(even)
    store().startMatch(a, b, 37, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: a.id }], score: [1, 0] } })
    toHalftime()
    const { getByRole, container } = render(<TeamTalk side="home" />)
    fireEvent.click(getByRole('button', { name: new RegExp('격노') }))
    const banner = container.querySelector('.tt-banner--down')
    expect(banner).toBeTruthy()
    expect(banner?.textContent).toContain('역효과')
    expect(banner?.textContent).toContain('-4')
  })

  it('코치 추천 뱃지가 최대 보정 톤 버튼에 붙는다', () => {
    // 지는 중(0-1, even) → 추천 격노(+8)
    store().startMatch(a, b, 37, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    const { getByRole, container } = render(<TeamTalk side="home" />)
    const badges = container.querySelectorAll('.tt-btn__badge')
    expect(badges.length).toBe(1)
    expect(getByRole('button', { name: new RegExp('격노') }).className).toContain('tt-btn--rec')
  })

  it('반복 감쇠: 지난 경기와 같은 톤이면 효과 반감 + 안내 문구', () => {
    useCampaignStore.getState().setLastTeamTalkTone('calm')
    store().startMatch(a, b, 37) // drawing, calm even = 4
    toHalftime()
    const { getByRole, container } = render(<TeamTalk side="home" />)
    fireEvent.click(getByRole('button', { name: new RegExp('침착') }))
    const banner = container.querySelector('.tt-banner')
    expect(banner?.textContent).toContain('+2') // 4 → 반감 2
    expect(banner?.textContent).toContain('울림이 덜합니다')
  })
})
