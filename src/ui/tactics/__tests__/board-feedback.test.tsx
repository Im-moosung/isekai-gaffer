// @vitest-environment jsdom
// 보드 피드백 — "전술을 바꿨을 때 보드가 무엇을 하는가".
//
// 두 경로를 나눠서 고정한다.
//  ① 도형이 있는 축(라인·압박·템포·공격방향·공격패턴) → AnalysisLayer 강조.
//     `13adeb8`의 규율(정착 후 1회 · 드래그 중 펄스 0)이 살아 있는지 본다.
//  ② 도형이 없는 축(멘탈리티·적극성·세트피스·페이즈 대형·GK·대형 이름) → 캡션 문장.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { TacticsBoard } from '../TacticsBoard'
import { captionOf } from '../boardFeedback'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import type { TacticState } from '../../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

function mountBreak() {
  store().reset()
  store().startMatch(home, away, 20260724)
  act(() => { store().kickoff() })
  act(() => { store().advanceMinute() })
  act(() => {
    useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
  })
  return render(<TacticsBoard />)
}
function openSubtab(container: HTMLElement, label: string) {
  const tab = Array.from(container.querySelectorAll('.tw-tab')).find(e => e.textContent!.includes(label))!
  fireEvent.click(tab)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('captionOf — 도형이 없는 축만 문장으로 말한다', () => {
  const base = (): TacticState => structuredClone(store().engine!.home.tactics)

  beforeEach(() => { store().reset(); store().startMatch(home, away, 20260724) })

  it('멘탈리티·그룹 적극성·세트피스·페이즈 대형·GK·대형 이름을 읽는다', () => {
    const a = base()
    expect(captionOf(a, { ...a, mentality: 'attacking' })).toBe('멘탈리티 균형 → 공격적')
    expect(captionOf(a, { ...a, groupIntensity: { attack: 1, midfield: 0, defense: 0 } }))
      .toBe('공격 적극성 기본 → 적극')
    expect(captionOf(a, { ...a, setPiece: { route: 'near' } })).toBe('코너 루트 파 → 니어')
    expect(captionOf(a, { ...a, phaseFormations: { attack: '3-5-2' } }))
      .toBe('공격 시 대형 기본 유지 → 3-5-2')
    expect(captionOf(a, { ...a, gkPowerplay: true })).toBe('GK 전진 켬')
    expect(captionOf(a, { ...a, formation: '5-4-1' })).toBe('대형 4-3-3 → 5-4-1')
  })

  it('도형이 있는 축(라인·압박·템포·공격방향·공격패턴)은 말하지 않는다 — 보드가 이미 그린다', () => {
    const a = base()
    expect(captionOf(a, { ...a, instructions: { ...a.instructions, lineHeight: 90 } })).toBeNull()
    expect(captionOf(a, { ...a, instructions: { ...a.instructions, pressing: 90 } })).toBeNull()
    expect(captionOf(a, { ...a, instructions: { ...a.instructions, tempo: 90 } })).toBeNull()
    expect(captionOf(a, { ...a, instructions: { ...a.instructions, attackFocus: 'left' } })).toBeNull()
    expect(captionOf(a, { ...a, attackPattern: 'cross' })).toBeNull()
  })

  it('한 번에 여러 축이 움직이면(코치 [채택]) 한 줄로 묶는다', () => {
    const a = base()
    const line = captionOf(a, {
      ...a, mentality: 'defensive', groupIntensity: { attack: 0, midfield: 0, defense: 1 },
    })
    expect(line).toBe('멘탈리티 균형 → 수비적 · 수비 적극성 기본 → 적극')
  })

  it('변화가 없으면 null이다(의미 없는 반짝임을 만들지 않는다)', () => {
    const a = base()
    expect(captionOf(a, { ...a })).toBeNull()
  })
})

describe('TacticsBoard — 캡션은 정착 후 한 번만 뜨고 스스로 사라진다', () => {
  it('멘탈리티를 바꾸면 260ms 뒤에 캡션이 뜬다', () => {
    vi.useFakeTimers()
    const { container, getByRole } = mountBreak()
    openSubtab(container, '태세')
    fireEvent.click(getByRole('button', { name: '공격적', pressed: false }))
    // 정착 전에는 아무것도 뜨지 않는다 — 연타 중 자막이 깜박이면 읽을 수 없다.
    act(() => { vi.advanceTimersByTime(200) })
    expect(container.querySelector('.tb-cap')).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect(container.querySelector('.tb-cap')!.textContent).toBe('멘탈리티 균형 → 공격적')
    // 상주하지 않는다.
    act(() => { vi.advanceTimersByTime(2400) })
    expect(container.querySelector('.tb-cap')).toBeNull()
  })

  it('정착 전 연속 조작은 한 줄로 합쳐진다(펄스 재시작 없음)', () => {
    vi.useFakeTimers()
    const { container, getByRole } = mountBreak()
    openSubtab(container, '태세')
    fireEvent.click(getByRole('button', { name: '공격적', pressed: false }))
    act(() => { vi.advanceTimersByTime(120) })
    fireEvent.click(getByRole('button', { name: '크로스' })) // 도형이 있는 축 — 캡션에 안 뜬다
    act(() => { vi.advanceTimersByTime(120) })
    fireEvent.click(getByRole('button', { name: '중거리' }))
    act(() => { vi.advanceTimersByTime(400) })
    // 캡션은 한 장뿐이고, 도형이 있는 축은 문장에 섞이지 않는다.
    expect(container.querySelectorAll('.tb-cap').length).toBe(1)
    expect(container.querySelector('.tb-cap')!.textContent).toBe('멘탈리티 균형 → 공격적')
  })

  it('도형이 있는 축은 보드가 직접 움직인다 — 캡션을 만들지 않는다', () => {
    vi.useFakeTimers()
    const { container, getByLabelText } = mountBreak()
    const before = (container.querySelector('.an-team--home .an-press') as SVGRectElement).getAttribute('width')
    const cur = store().engine!.home.tactics.instructions.pressing
    fireEvent.change(getByLabelText('압박'), { target: { value: String(cur + 25) } })
    // 도형은 그 프레임에 이미 움직였다(적용 전 미리보기).
    expect((container.querySelector('.an-team--home .an-press') as SVGRectElement).getAttribute('width'))
      .not.toBe(before)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(container.querySelector('.tb-cap')).toBeNull()
  })
})
