// @vitest-environment jsdom
//
// 작전판 헤더의 **경기 상황(스코어·시계)** 계약.
// 파일을 tactics-board.test.tsx와 나눈 이유: 그쪽은 터치라인 쿨다운 개편과 동시에
// 수정되는 중이다(2026-08-01 병렬 작업). 서로 다른 관심사이므로 파일을 나눠 둔다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { canIntervene, useMatchStore } from '../../../game/matchStore'
import { TacticsBoard } from '../TacticsBoard'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

function mountAt(phase: 'paused-user' | 'paused-break' | 'halftime') {
  store().reset()
  store().startMatch(home, away, 20260724)
  act(() => { store().kickoff() })
  act(() => { store().advanceMinute() })
  act(() => {
    useMatchStore.setState({
      phase,
      pauseReason: phase === 'halftime' ? { kind: 'halftime' }
        : phase === 'paused-break' ? { kind: 'hydration1' as const }
        : { kind: 'user' as const },
    })
  })
  return render(<TacticsBoard />)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

describe('TacticsBoard — 경기 상황(스코어·시계)', () => {
  it('헤더에 지금 몇 분에 몇 대 몇인지가 있다 — 전술을 바꾸는 판단의 첫 입력', () => {
    const { getByRole } = mountAt('paused-user')
    // 엔진 상태를 못 박고(1-0, 67분) 그대로 읽히는지 본다.
    act(() => {
      const e = store().engine!
      useMatchStore.setState({ engine: { ...e, minute: 67, score: [1, 0] } })
    })
    const box = getByRole('status', { name: '경기 상황' })
    // 방송 스코어버그와 같은 문법: 킷 스트립 + FIFA 코드 + 스코어 + 시계.
    expect(box.textContent).toContain('KOR')
    expect(box.textContent).toContain('ESP')
    expect(box.querySelector('.tb-head__clock')!.textContent).toBe("67'")
    const nums = Array.from(box.querySelectorAll('.tb-head__num')).map(n => n.textContent)
    expect(nums).toEqual(['1', '0'])
  })

  it("하프타임 시계는 45'가 아니라 HT다 — 45'는 시계가 도는 중으로 읽힌다", () => {
    const { getByRole } = mountAt('halftime')
    expect(getByRole('status', { name: '경기 상황' }).querySelector('.tb-head__clock')!.textContent)
      .toBe('HT')
  })

  it('작전판이 열리는 phase는 전부 정지 phase다 — 그래서 engine.score를 그대로 써도 노출 게이트를 어기지 않는다', () => {
    // 이 계약이 깨지면(= 재생 중에도 작전판이 열리면) 위 스코어는 아직 화면에 보이지
    // 않은 골을 먼저 띄우게 된다(커밋 56cb691의 "예지력"). 판정을 store 정본으로 못 박는다.
    for (const p of ['paused-break', 'paused-user', 'paused-moment', 'halftime'] as const) {
      expect(canIntervene(p)).toBe(true)
    }
    expect(canIntervene('playing')).toBe(false)
  })
})
