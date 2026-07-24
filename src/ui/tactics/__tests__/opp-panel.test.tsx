// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { OppPanel, matchupHint } from '../OppPanel'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

function mount() {
  store().reset()
  store().startMatch(home, away, 20260724)
  act(() => { store().kickoff() })
  act(() => { store().advanceMinute() })
  act(() => { useMatchStore.setState({ phase: 'paused-user', pauseReason: { kind: 'user' } }) })
  return render(<OppPanel />)
}

beforeEach(() => store().reset())
afterEach(() => cleanup())

describe('matchupHint (formationEdge 부호·크기)', () => {
  it('edge>0 → 우위 톤, edge<0 → 열세 톤, 0 → 대등', () => {
    expect(matchupHint(0.05).tone).toBe('up')
    expect(matchupHint(0.01).tone).toBe('up')
    expect(matchupHint(0).tone).toBe('even')
    expect(matchupHint(-0.01).tone).toBe('down')
    expect(matchupHint(-0.06).tone).toBe('down')
  })
  it('큰 우위/열세는 강한 문구', () => {
    expect(matchupHint(0.05).text).toContain('우위')
    expect(matchupHint(-0.05).text).toContain('주의')
  })
})

describe('OppPanel', () => {
  it('상대 포메이션 표기 + 선발 11 리스트', () => {
    const { getByLabelText, container } = mount()
    expect(getByLabelText('상대 포메이션').textContent).toBe(store().engine!.away.tactics.formation)
    expect(container.querySelectorAll('.op__row')).toHaveLength(11)
  })

  it('키 플레이어 ★ 강조', () => {
    const { container } = mount()
    const keyId = store().engine!.away.team.profile.keyPlayers[0].playerId
    const keyNum = String(away.squad.find(p => p.id === keyId)!.number)
    // 테스트팀 키 플레이어(p_esp_14)는 선발 XI에 포함 → ★ 강조 행 존재.
    const star = container.querySelector('.op__row-star')
    expect(star).toBeTruthy()
    const row = star!.closest('.op__row')!
    expect(row.classList.contains('op__row--key')).toBe(true)
    expect(row.querySelector('.op__row-num')!.textContent).toBe(keyNum)
  })

  it('선수 행 클릭 → PlayerCard(상대 스탯) 표시', () => {
    const { container } = mount()
    const row = container.querySelector('.op__row') as HTMLElement
    fireEvent.click(row)
    expect(container.querySelector('.op__card .pc')).toBeTruthy()
    expect(container.querySelector('.op__card .pc-radar__poly')).toBeTruthy()
  })

  it('매치업 힌트 노트가 내 포메이션 vs 상대 포메이션을 보여준다', () => {
    const { getByLabelText } = mount()
    const note = getByLabelText('매치업 힌트')
    const my = store().engine!.home.tactics.formation
    const opp = store().engine!.away.tactics.formation
    expect(note.textContent).toContain(`${my} vs ${opp}`)
  })
})
