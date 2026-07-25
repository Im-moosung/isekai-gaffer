// @vitest-environment jsdom
// Phase A Task 4: 킥오프 전 전술 센터 — 'pre'가 개입 phase로 승격되면서
// 기존 store 바인딩 패널(ConsolePanel·TacticsExtras·OppPanel)이 무수정으로 동작하는지 검증한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { TacticsCenter } from '../TacticsCenter'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

function mountPre() {
  store().reset()
  store().startMatch(home, away, 20260724)
  return render(<TacticsCenter onKickoff={() => {}} referenceScore={[1, 2]} />)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

describe('TacticsCenter — 킥오프 전 워룸', () => {
  it("'pre'에서 상대 리포트·2탭·검토 요약·킥오프 버튼을 렌더한다", () => {
    const { container, getByRole } = mountPre()
    expect(store().phase).toBe('pre')
    // 좌측 상대 리포트는 탭과 무관하게 상시 노출.
    expect(container.querySelector('.tc-war .op')).toBeTruthy()
    expect(container.querySelector('.tc-summary')).toBeTruthy()
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    // 참고 스코어(조별 실제 역사) 표기.
    expect(container.textContent).toContain('1-2')
  })

  it('① 선발 탭이 기본이며 포메이션 변경이 엔진 tactics에 즉시 커밋된다', () => {
    const { getByRole, container } = mountPre()
    expect(container.querySelector('.lu-root')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '4-4-2' }))
    expect(store().engine!.home.tactics.formation).toBe('4-4-2')
    // 하단 검토 요약이 즉시 갱신된다.
    expect(container.querySelector('.tc-summary')!.textContent).toContain('4-4-2')
  })

  it('② 팀 전술 탭: 멘탈리티·공격 패턴이 활성이고 요약이 즉시 갱신된다', () => {
    const { getByRole, container } = mountPre()
    fireEvent.click(getByRole('tab', { name: '② 팀 전술' }))

    const attacking = getByRole('button', { name: '공격적' }) as HTMLButtonElement
    expect(attacking.disabled).toBe(false)
    fireEvent.click(attacking)
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('공격')

    fireEvent.click(getByRole('button', { name: '크로스' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('cross')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('크로스')
  })

  it('② 팀 전술 탭: 4축 슬라이더 [지시 적용]이 엔진에 반영되고 요약에 나타난다', () => {
    const { getByRole, getByLabelText, container } = mountPre()
    fireEvent.click(getByRole('tab', { name: '② 팀 전술' }))
    fireEvent.change(getByLabelText('압박') as HTMLInputElement, { target: { value: '85' } })
    fireEvent.click(getByRole('button', { name: '지시 적용' }))
    expect(store().engine!.home.tactics.instructions.pressing).toBe(85)
    expect(container.querySelector('.tc-summary')!.textContent).toContain('압박 85')
  })

  it('② 팀 전술 탭: 페이즈 포메이션(공격 시) 선택이 요약에 반영된다', () => {
    const { getByRole, getByLabelText, container } = mountPre()
    fireEvent.click(getByRole('tab', { name: '② 팀 전술' }))
    fireEvent.change(getByLabelText('공격 시 포메이션') as HTMLSelectElement, { target: { value: '3-5-2' } })
    expect(store().engine!.home.tactics.phaseFormations?.attack).toBe('3-5-2')
    expect(container.querySelector('.tc-summary')!.textContent).toContain('공격 3-5-2')
  })

  it('킥오프 전 설정이 킥오프 이후에도 그대로 유지된다(리셋 없음)', () => {
    const { getByRole } = mountPre()
    fireEvent.click(getByRole('tab', { name: '② 팀 전술' }))
    fireEvent.click(getByRole('button', { name: '매우 수비적' }))
    fireEvent.change(getByRole('slider', { name: '라인' }) as HTMLInputElement, { target: { value: '20' } })
    fireEvent.click(getByRole('button', { name: '지시 적용' }))

    store().kickoff()
    store().advanceMinute()
    const t = store().engine!.home.tactics
    expect(t.mentality).toBe('very-defensive')
    expect(t.instructions.lineHeight).toBe(20)
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
