// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { OppPanel, matchupHint, briefingRoster } from '../OppPanel'
import { loadTeam } from '../../../data/loader'
import { pickBestXI } from '../../../engine/lineup'
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

  it('상대 카드는 실시간 체력·사기 게이지를 노출하지 않는다(기본 스탯만)', () => {
    const { container } = mount()
    fireEvent.click(container.querySelector('.op__row') as HTMLElement)
    expect(container.querySelector('.op__card .pc')).toBeTruthy() // 카드는 뜨되
    expect(container.querySelector('.op__card .pc-gauge')).toBeNull() // 게이지는 없음
    expect(container.querySelector('.op__card .pc__gauges')).toBeNull()
  })

  it('매치업 힌트 노트가 내 포메이션 vs 상대 포메이션을 보여준다', () => {
    const { getByLabelText } = mount()
    const note = getByLabelText('매치업 힌트')
    const my = store().engine!.home.tactics.formation
    const opp = store().engine!.away.tactics.formation
    expect(note.textContent).toContain(`${my} vs ${opp}`)
  })
})

// 감사 결함 ⑧: 고정 브리핑 문안이 오늘의 XI와 어긋난다.
// 체코 styleNotes는 "소우체크·시크·호리 등 … 슐츠 외 중앙 창의성이 부족해…"인데
// 그때는 실제 선발 XI에 소우체크도 슐츠도 없었다. 문안을 다시 쓰지 않고 사실만 정정한다.
//
// ★ 2026-08-01 정정: 이 테스트의 옛 기대값(`bench`에 소우체크)은 **버그를 인코딩하고
//   있었다.** `positionFitness`가 자질을 안 보고 슬롯/포지션만 맞으면 1.0을 주는 탓에
//   `pickBestXI`의 정렬이 동점투성이가 되고, 안정 정렬이 **squad 배열 순서**를 그대로
//   따랐다. 12개 팀 JSON이 전부 등번호순이라 12팀 전부가 뎁스 차트가 아니라 등번호로
//   XI를 짜고 있었다(`9992bca`). 소우체크는 styleNotes가 강점으로 지목한 선수인데
//   등번호 때문에 벤치였던 것이다. 배열을 signatureXI 순서로 고치니 선발이 됐다.
//   즉 "브리핑이 부른 이름과 XI가 어긋난다"는 이 감사 결함의 절반은 데이터 정렬 문제였다.
describe('briefingRoster — 브리핑 이름 × 오늘의 XI', () => {
  it('체코 브리핑이 부른 이름을 선발/벤치로 정확히 가른다', () => {
    const cze = loadTeam('cze')
    const xi = pickBestXI(cze)
    const notes = (cze.profile as { styleNotes?: string }).styleNotes
    const { starters, bench } = briefingRoster(notes, cze.squad, xi.lineup.map(l => l.playerId))
    // 문안이 부른 네 명이 빠짐없이 분류된다.
    expect([...starters, ...bench].sort()).toEqual(['소우체크', '슐츠', '시크', '호리'].sort())
    // styleNotes가 강점으로 지목한 소우체크는 이제 선발이다(위 정정 참조).
    expect(starters).toContain('소우체크')
    // 슐츠는 여전히 벤치 — 문안이 "슐츠 외 중앙 창의성이 부족"이라 부른 대조군이다.
    expect(bench).toContain('슐츠')
  })

  it('문안이 없으면 아무것도 만들지 않는다', () => {
    expect(briefingRoster(undefined, [], [])).toEqual({ starters: [], bench: [] })
  })
})
