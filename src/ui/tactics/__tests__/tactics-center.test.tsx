// @vitest-environment jsdom
// Phase A Task 4: 킥오프 전 전술 센터 — 'pre'가 개입 phase로 승격되면서
// 기존 store 바인딩 패널(ConsolePanel·TacticsExtras·OppPanel)이 무수정으로 동작하는지 검증한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { TacticsCenter } from '../TacticsCenter'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { loadTeam } from '../../../data/loader'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

function mountPre() {
  store().reset()
  store().startMatch(home, away, 20260724)
  return render(<TacticsCenter onKickoff={() => {}} referenceScore={[1, 2]} />)
}

/** 탭 전환 — 워룸은 작업 공간을 탭으로 나눈다(선발 / 팀 전술 / 상대 브리핑).
 *  플랜 요약과 [킥오프]는 탭 밖 고정이라 전환과 무관하다. */
function toTab(container: HTMLElement, label: string) {
  const tab = Array.from(container.querySelectorAll('[role="tab"]'))
    .find(el => el.textContent!.includes(label))
  if (!tab) throw new Error(`탭 없음: ${label}`)
  fireEvent.click(tab)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

describe('TacticsCenter — 킥오프 전 워룸', () => {
  // ★ 재설계(2026-07-31): 세로 한 페이지(실측 2133~2184px)를 탭 3장으로 나눴다.
  // 직전 판단("선발 → 팀 전술 → 검토는 순차 작업이지 배타 뷰가 아니다")은 **탭 밖
  // 고정 영역**이 지킨다 — 플랜 요약(형태·태도·리스크·상대 상성)과 [킥오프]는 어느
  // 탭에서도 보인다. 아래 테스트들이 그 두 성질을 함께 고정한다.
  it("'pre'에서 탭 3장이 뜨고 기본은 선발이다", () => {
    const { container, getByRole } = mountPre()
    expect(store().phase).toBe('pre')
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(e => e.textContent)
    expect(tabs.length).toBe(3)
    expect(tabs[0]).toContain('선발 라인업')
    // 기본 탭은 선발 — 화면에 들어오자마자 첫 작업을 할 수 있어야 한다.
    expect(container.querySelector('.lu-root')).toBeTruthy()
    expect(container.querySelector('.tx-panel')).toBeNull()
    expect(container.querySelector('.op')).toBeNull()
    // 검토 요약과 킥오프는 탭 밖 고정.
    expect(container.querySelector('.tc-summary')).toBeTruthy()
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    // 참고 스코어(조별 실제 역사) 표기.
    expect(container.textContent).toContain('1-2')
  })

  it('탭을 바꿔도 검토 요약과 [킥오프]는 그대로 남는다', () => {
    const { container, getByRole } = mountPre()
    for (const label of ['팀 전술', '상대 브리핑', '선발 라인업']) {
      toTab(container, label)
      expect(container.querySelector('.tc-summary')).toBeTruthy()
      expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
      expect(container.querySelector('.tc-actions')).toBeTruthy()
    }
  })

  it('탭이 실제로 배타 전환된다 — 팀 전술과 상대 브리핑', () => {
    const { container } = mountPre()
    toTab(container, '팀 전술')
    expect(container.querySelector('.tx-panel')).toBeTruthy()
    expect(container.querySelector('.lu-root')).toBeNull()
    toTab(container, '상대 브리핑')
    expect(container.querySelector('.op')).toBeTruthy()
    expect(container.querySelector('.tx-panel')).toBeNull()
  })

  // 상대 브리핑을 탭 뒤로 보냈으므로, 브리핑에서 실제로 판단에 쓰이는 한 줄
  // (상대 포메이션 + 상성)은 탭을 열지 않아도 보여야 한다.
  it('고정 요약이 상대 포메이션과 상성을 상시 노출한다', () => {
    const { container } = mountPre()
    const sum = container.querySelector('.tc-summary')!.textContent!
    expect(sum).toContain(away.name.ko)
    expect(sum).toContain(store().engine!.away.tactics.formation)
    expect(sum).toMatch(/상성|대등/)
  })

  it('포메이션 변경이 엔진 tactics에 즉시 커밋된다', () => {
    const { getByRole, container } = mountPre()
    expect(container.querySelector('.lu-root')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '4-4-2' }))
    expect(store().engine!.home.tactics.formation).toBe('4-4-2')
    // 하단 검토 요약이 즉시 갱신된다.
    expect(container.querySelector('.tc-summary')!.textContent).toContain('4-4-2')
  })

  it('멘탈리티·공격 패턴이 활성이고 요약이 즉시 갱신된다', () => {
    const { getByRole, container } = mountPre()
    toTab(container, '팀 전술')

    const attacking = getByRole('button', { name: '공격적' }) as HTMLButtonElement
    expect(attacking.disabled).toBe(false)
    fireEvent.click(attacking)
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('공격')

    fireEvent.click(getByRole('button', { name: '크로스' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('cross')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('크로스')
  })

  it('4축 슬라이더가 버튼 없이 즉시 요약에 반영된다', () => {
    const { getByLabelText, queryByRole, container } = mountPre()
    toTab(container, '팀 전술')
    expect(queryByRole('button', { name: '지시 적용' })).toBeNull()
    fireEvent.change(getByLabelText('압박') as HTMLInputElement, { target: { value: '85' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(85)
    expect(container.querySelector('.tc-summary')!.textContent).toContain('압박 85')
  })

  it('페이즈 포메이션(공격 시) 선택이 요약에 반영된다', () => {
    const { getByRole, container } = mountPre()
    toTab(container, '팀 전술')
    // 슬롯 이름이 겹치지 않도록 접근성 이름으로 구분한다.
    fireEvent.click(getByRole('button', { name: '공격 시 3-5-2' }))
    expect(store().engine!.home.tactics.phaseFormations?.attack).toBe('3-5-2')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('공격 3-5-2')
  })

  it('킥오프 전 설정이 킥오프 이후에도 그대로 유지된다(리셋 없음)', () => {
    const { getByRole, container } = mountPre()
    toTab(container, '팀 전술')
    fireEvent.click(getByRole('button', { name: '매우 수비적' }))
    fireEvent.change(getByRole('slider', { name: '라인' }) as HTMLInputElement, { target: { value: '20' } })

    store().kickoff()
    store().advanceMinute()
    const t = store().engine!.home.tactics
    expect(t.mentality).toBe('very-defensive')
    expect(t.instructions.lineHeight).toBe(20)
  })

  it('[추천 적용]이 컨트롤을 실제로 움직이고 근거를 노출한다', () => {
    const { getByRole, container } = mountPre()
    // 픽스처는 kor 76 vs esp 88 — 전력이 크게 밀리는 상대다. 따라서 무게중심을
    // 내린 5-4-1이 권고된다(실측 esp: 5-4-1 0.936 · 4-1-4-1 0.934 · 3-5-2 0.808).
    // 이전 기대값 '3-5-2'는 formationEdge argmax 규칙의 산물이었는데, 그 항은
    // 실측 기여가 ±0.004 승점(관측 격차의 1/15)인 죽은 레버로 판명됐다.
    expect(store().engine!.home.tactics.formation).not.toBe('5-4-1')
    fireEvent.click(getByRole('button', { name: /추천 적용/ }))
    expect(store().engine!.home.tactics.formation).toBe('5-4-1')
    expect(container.querySelector('.tc-reasons')!.textContent).toContain('상성')
    // 포메이션이 바뀌어도 선발 11인은 유지된다(슬롯만 재배치).
    expect(store().engine!.home.tactics.lineup.length).toBe(11)
    // 근거는 닫기 전까지 남는다.
    fireEvent.click(getByRole('button', { name: '권고 닫기' }))
    expect(container.querySelector('.tc-reasons')).toBeNull()
  })

  it('[추천 적용]이 4축 슬라이더 위치까지 실제로 옮긴다', () => {
    // 실팀(스페인 점유 78·라인 62·압박 68)이라야 지시 축 권고가 실제로 움직인다.
    // 라인 20 = 스페인의 후방 전개 지표 78(GK 빌드업 78·점유 78)에서 파생된 값이다
    // — 기준 72를 넘으면 압박이 벗겨지므로 추천이 라인·압박을 함께 하한(20)까지 내린다.
    store().reset()
    store().startMatch(loadTeam('kor'), loadTeam('esp'), 20260724)
    const { getByRole } = render(<TacticsCenter onKickoff={() => {}} />)
    fireEvent.click(getByRole('button', { name: /추천 적용/ }))
    expect((getByRole('slider', { name: '라인' }) as HTMLInputElement).value).toBe('20')
    expect(store().engine!.home.tactics.instructions.lineHeight).toBe(20)
    // 압박도 함께 내려간다 — 기존엔 우리 프로필(62) 그대로라 상대 무관이었다.
    expect(store().engine!.home.tactics.instructions.pressing).toBe(20)
  })

  // 태세는 FIFA 랭킹이 아니라 상대의 후방 전개 지표(trapFactor)가 정한다 — 랭킹으로 정하면
  // 축(라인·압박)과 어긋나 "수비적으로 가되 라인은 74까지"라는 모순이 나고, 실측에서도
  // 승률이 떨어졌다(scouting.ts 주석의 기각된 가설 참고).
  it('후방 전개가 강한 상대(스페인)에는 수비적 멘탈리티를 추천한다', () => {
    store().reset()
    store().startMatch(loadTeam('kor'), loadTeam('esp'), 20260724)
    const { getByRole, container } = render(<TacticsCenter onKickoff={() => {}} />)
    fireEvent.click(getByRole('button', { name: /추천 적용/ }))
    expect(store().engine!.home.tactics.mentality).toBe('defensive')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('수비')
  })

  it('후방 전개가 약한 상대(남아공)에는 공격적 멘탈리티를 추천한다', () => {
    store().reset()
    store().startMatch(loadTeam('kor'), loadTeam('rsa'), 20260724)
    const { getByRole } = render(<TacticsCenter onKickoff={() => {}} />)
    fireEvent.click(getByRole('button', { name: /추천 적용/ }))
    expect(store().engine!.home.tactics.mentality).toBe('very-attacking')
  })

  it('리스크 카드가 하이라인+하이프레스를 경고한다', () => {
    const { container } = mountPre()
    expect(container.querySelector('.tc-summary')!.textContent).toContain('특이사항 없음')
    const eng = store().engine!
    act(() => {
      store().submitCommand('home', {
        type: 'instructions',
        instructions: { ...eng.home.tactics.instructions, lineHeight: 80, pressing: 80 },
      })
    })
    expect(container.querySelector('.tc-risk--warn')!.textContent).toContain('역습')
  })

  it('킥오프 버튼이 onKickoff를 호출한다', () => {
    const onKickoff = vi.fn()
    store().reset()
    store().startMatch(home, away, 20260724)
    const { getByRole } = render(<TacticsCenter onKickoff={onKickoff} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    expect(onKickoff).toHaveBeenCalledTimes(1)
  })
})
