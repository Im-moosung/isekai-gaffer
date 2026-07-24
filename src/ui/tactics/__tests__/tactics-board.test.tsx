// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act, within } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { TacticsBoard } from '../TacticsBoard'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// 작전판을 특정 정지 phase에 놓고 렌더한다. 엔진은 kickoff 후 1분 전진시켜 준비.
function mountAt(phase: 'paused-user' | 'halftime') {
  store().reset()
  store().startMatch(home, away, 20260724)
  act(() => { store().kickoff() })
  act(() => { store().advanceMinute() })
  act(() => {
    useMatchStore.setState({
      phase,
      pauseReason: phase === 'halftime' ? { kind: 'halftime' } : { kind: 'user' },
    })
  })
  return render(<TacticsBoard />)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

const homeCxs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.pv-dot--home')).map(d => d.getAttribute('cx'))

describe('TacticsBoard — 실시간 보드 반영(포메이션 변경)', () => {
  it('포메이션 셀렉터 변경 → 엔진 formation 갱신 + 보드 도트 좌표 변화', () => {
    const { getByRole, container } = mountAt('paused-user')
    // 기본 4-3-3 (테스트팀 preferredFormations[0]).
    expect(store().engine!.home.tactics.formation).toBe('4-3-3')
    const before = homeCxs(container as HTMLElement)
    expect(before.length).toBe(11)

    // 3-5-2로 변경 → autoFill 재배치 + submitCommand(type:'formation').
    fireEvent.click(getByRole('button', { name: '3-5-2' }))
    expect(store().engine!.home.tactics.formation).toBe('3-5-2')

    // 보드 도트 좌표가 새 slotCoords로 바뀐다(변경→시각 피드백 루프).
    const after = homeCxs(container as HTMLElement)
    expect(after).not.toEqual(before)
  })

  it('같은 포메이션 재클릭은 무변경(no-op)', () => {
    const { getByRole, container } = mountAt('paused-user')
    const before = homeCxs(container as HTMLElement)
    fireEvent.click(getByRole('button', { name: '4-3-3' }))
    expect(store().engine!.home.tactics.formation).toBe('4-3-3')
    expect(homeCxs(container as HTMLElement)).toEqual(before)
  })
})

describe('TacticsBoard — 확장 전술 지시(Task 5)', () => {
  it('멘탈리티 5버튼 + 클릭 시 엔진 tactics.mentality 갱신', () => {
    const { getByRole } = mountAt('paused-user')
    expect(store().engine!.home.tactics.mentality ?? 'balanced').toBe('balanced')
    fireEvent.click(getByRole('button', { name: '공격적', pressed: false }))
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
  })

  it('그룹 적극성: 공격 라인 [적극] → groupIntensity.attack=1', () => {
    const { getByRole } = mountAt('paused-user')
    const grp = getByRole('group', { name: '공격 적극성' })
    fireEvent.click(within(grp).getByRole('button', { name: '적극' }))
    expect(store().engine!.home.tactics.groupIntensity!.attack).toBe(1)
    expect(store().engine!.home.tactics.groupIntensity!.midfield).toBe(0)
  })

  it('공격 패턴 4택: [중거리] 선택 → attackPattern=longshot', () => {
    const { getByRole } = mountAt('paused-user')
    fireEvent.click(getByRole('button', { name: '중거리' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('longshot')
  })

  it('GK 파워플레이: 조건 미충족(1분·비지는중)엔 잠금+사유', () => {
    const { getByRole, getByText } = mountAt('paused-user')
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(getByText(/85' 이후에만 가능/)).toBeTruthy()
  })

  it('GK 파워플레이: 85\'+ & 지는 중이면 해제 → 토글 반영', () => {
    const { getByRole } = mountAt('paused-user')
    act(() => {
      const eng = structuredClone(store().engine!)
      eng.minute = 87; eng.score = [0, 1] // 홈 지는 중
      useMatchStore.setState({ engine: eng })
    })
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(store().engine!.home.tactics.gkPowerplay).toBe(true)
  })

  it('페이즈 포메이션: 공격 시 3-5-2 선택 → phaseFormations.attack', () => {
    const { getByLabelText } = mountAt('paused-user')
    fireEvent.change(getByLabelText('공격 시 포메이션'), { target: { value: '3-5-2' } })
    expect(store().engine!.home.tactics.phaseFormations!.attack).toBe('3-5-2')
  })

  it('압박 슬라이더 옆 체력 소모 트레이드오프(⚡) 표시', () => {
    const { getByText } = mountAt('paused-user')
    expect(getByText(/체력 소모 \+40%/)).toBeTruthy()
    expect(getByText(/뒷공간 노출/)).toBeTruthy()
  })
})

describe('TacticsBoard — 코치 회의 (멀티 코치)', () => {
  it('작전판 상단에 코치 회의 카드들 + [감독 판단대로 간다] 노출', () => {
    const { container, getByRole } = mountAt('halftime')
    const coach = container.querySelector('.tb-coach')!
    expect(coach).toBeTruthy()
    expect(coach.querySelectorAll('.tb-coach__card').length).toBeGreaterThanOrEqual(2)
    // 코치 회의가 tb-main(작전판 본체)보다 먼저 온다(상단·진입 시 가장 먼저).
    const root = container.querySelector('.tb-root')!
    const kids = Array.from(root.children)
    const coachIdx = kids.findIndex(k => k.classList.contains('tb-coach'))
    const mainIdx = kids.findIndex(k => k.classList.contains('tb-main'))
    expect(coachIdx).toBeGreaterThanOrEqual(0)
    expect(coachIdx).toBeLessThan(mainIdx)
    expect(getByRole('button', { name: '감독 판단대로 간다' })).toBeTruthy()
  })

  it('[채택] → 부분 전술이 draft(엔진 tactics)에 병합된다', () => {
    const { container } = mountAt('halftime')
    const before = store().engine!.home.tactics
    const beforeLine = before.instructions.lineHeight
    const beforePress = before.instructions.pressing
    // 수비 코치 카드(첫 카드) 채택 → 라인 하향.
    const cards = container.querySelectorAll('.tb-coach__card')
    const defCard = Array.from(cards).find(c => c.querySelector('.tb-coach__role')!.textContent === '수비 코치')!
    fireEvent.click(defCard.querySelector('.tb-coach__adopt') as HTMLElement)
    expect(store().engine!.home.tactics.instructions.lineHeight).toBeLessThan(beforeLine)
    // 압박은 수비 코치 패치 대상이 아니므로 불변.
    expect(store().engine!.home.tactics.instructions.pressing).toBe(beforePress)
    expect(store().engine!.home.tactics.groupIntensity!.defense).toBe(-1)
  })

  it('[감독 판단대로 간다] → 카드 접힘', () => {
    const { container, getByRole } = mountAt('paused-user')
    expect(container.querySelector('.tb-coach')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '감독 판단대로 간다' }))
    expect(container.querySelector('.tb-coach')).toBeNull()
  })
})

describe('TacticsBoard — 하프타임 팀토크 + 사유', () => {
  it('halftime → 팀토크 카드 + [후반 시작] 라벨 + 사유(전반 종료)', () => {
    const { getByRole, container } = mountAt('halftime')
    expect(container.querySelector('.tt-root')).toBeTruthy()
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('전반 종료')
  })

  it('정지(감독 타임)엔 팀토크 없음 + [전술 확정] 라벨', () => {
    const { getByRole, container } = mountAt('paused-user')
    expect(container.querySelector('.tt-root')).toBeNull()
    expect(getByRole('button', { name: '전술 확정' })).toBeTruthy()
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('감독 타임')
  })
})
