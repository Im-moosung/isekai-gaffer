// @vitest-environment jsdom
// P4A Task 10: App 레벨 캠페인 경기 스모크 — 매치데이 2.0 스토어 변경 후 캠페인 경로 정합 확인.
// 실 MatchScreen(목 아님)을 통해 캠페인 시작 → 허브 → 경기 진입(킥오프 전 전술 센터)까지
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
  it('캠페인 시작 → 경기 준비 → 곧바로 전술 센터(킥오프 버튼 + pre phase)', () => {
    const { getByRole, container } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '체코전 준비하기' }))

    // 라인업 단독 화면 없이 곧바로 전술 센터가 뜬다(사용자 지적 해소).
    expect(container.querySelector('.tc-root')).toBeTruthy()
    // 실 MatchScreen 진입 — 킥오프 버튼 + 피치 SVG 존재, 아직 킥오프 전(pre).
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    expect(container.querySelector('svg.pv-root')).toBeTruthy()
    expect(useMatchStore.getState().phase).toBe('pre')
    // 소리 제어는 제어 pod의 **설정 팝업** 안에 있다(2026-08-01 ①). 킥오프 전에도
    // 음소거는 살아 있어야 한다 — 워룸에서 이미 BGM(M03 워룸)이 돌고 있기 때문이다.
    fireEvent.click(getByRole('button', { name: '설정' }))
    expect(getByRole('button', { name: '음소거' })).toBeTruthy()
  })
})

// [F1 B안 · 2026-07-26] 새 계약. 예전 계약("조별 전반은 실제 역사 스코어를 재현한다")을 대체한다.
// 폐기 이유: 전반을 스크립트로 덮으면 1~44분에 simulateMinute이 한 번도 돌지 않아
// 하이드레이션(≈22') 시점에 체력 100·슛 0·xG 0·이벤트 0이었고, 유저 플랜이 무력화됐다.
describe('조별 경기도 전반부터 시뮬된다 (전반 스크립트 배선 해제)', () => {
  it('1차전(체코)에 firstHalfScript가 걸리지 않고, 하이드레이션 시점에 체력·슛·이벤트가 움직여 있다', () => {
    const { getByRole } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '체코전 준비하기' }))

    const ms = () => useMatchStore.getState()
    // 조별 1차전인데도 엔진에 전반 스크립트가 실려 있지 않다 — 배선 해제의 직접 단언.
    expect(ms().engine!.firstHalfScript).toBeUndefined()
    expect(useCampaignStore.getState().stage).toBe('group1')

    ms().kickoff()
    const hydration = ms().schedule!.firstHydration
    expect(hydration).toBeGreaterThanOrEqual(20)
    expect(hydration).toBeLessThanOrEqual(24)
    // 하이드레이션 브레이크에서 자동 정지할 때까지 분을 진행한다.
    while (ms().phase === 'playing' && ms().engine!.minute < hydration) ms().advanceMinute()

    const eng = ms().engine!
    expect(eng.minute).toBe(hydration)
    // (1) 체력이 소모됐다 — 스크립트 시절엔 전원 100이었다.
    const stamina = eng.home.tactics.lineup.map(l => eng.home.staminaByPlayer[l.playerId])
    expect(Math.max(...stamina)).toBeLessThan(100)
    // (2) 스탯이 쌓였다 — 슛은 양 팀 합계로 본다(한쪽이 0인 것은 정상적인 경기 전개다).
    expect(eng.stats[0].shots + eng.stats[1].shots).toBeGreaterThan(0)
    // (3) 점유율이 초기값 50 고정에서 벗어나 실제 분당 누적으로 갱신된다.
    expect(eng.stats[0].possession + eng.stats[1].possession).toBeCloseTo(100, 5)
    // (4) 티커에 킥오프 말고도 전반 이벤트가 쌓인다.
    expect(eng.events.filter(e => e.type !== 'kickoff' && e.minute <= hydration).length).toBeGreaterThan(0)
  })
})

// referenceScore는 '결과'가 아니라 '표시용 기준선'이라는 계약.
describe('realScore는 표시용 기준선으로만 쓰인다', () => {
  it('전술 센터에 "참고 · 실제 역사 2-1"이 뜨지만 경기 결과를 고정하지 않는다', () => {
    const { getByRole, getByText } = render(<App />)
    fireEvent.click(getByRole('button', { name: '캠페인 시작' }))
    fireEvent.click(getByRole('button', { name: '체코전 준비하기' }))
    // 1차전 체코전 실제 역사 2-1이 참고 표기로 노출된다.
    expect(getByText('참고 · 실제 역사 2-1')).toBeTruthy()
    // 그러나 엔진 스코어는 0-0에서 시작해 시뮬로만 움직인다.
    expect(useMatchStore.getState().engine!.score).toEqual([0, 0])
  })
})
