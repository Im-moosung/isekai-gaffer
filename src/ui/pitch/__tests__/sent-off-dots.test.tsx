// @vitest-environment jsdom
// 퇴장이 **작전판에 반영되는가** — 사용자 실플레이 제보(2026-08-01):
//   "분명 상대가 퇴장이라고 해설에서 나왔는데 경기에 반영이 안 된 것 같아."
//
// 사용자가 옳았다. 엔진은 이미 10명으로 돌고 있었고(choreography·flow·three/movement가
// 전부 `sentOff`를 거른다) 3D도 프레임에 없는 리그를 숨겼는데, **SVG 작전판과 Pixi 도트만**
// 라인업을 그대로 그려 퇴장 선수 도트가 남아 있었다. 화면에서 세면 11명, 시뮬레이션은 10명.
//
// 여기서 못박는 계약: 퇴장 선수는 **지운다**(회색으로 남기지 않는다). 이 보드의 첫 번째
// 일은 "지금 몇 대 몇인가"를 셀 수 있게 하는 것이고, 무슨 색이든 원이 하나 더 있으면 11로
// 세인다. 누가 빠졌는지는 중계·이벤트 피드·교체 패널의 '퇴장' 칩이 말한다.
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PitchView } from '../PitchView'
import { PixiPitch } from '../pixi/PixiPitch'
import { onPitchMask } from '../cast'
import { separateDots, blockMetrics } from '../shape'
import { buildSequence } from '../choreography'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch, simulateSegment } from '../../../engine/simulate'
import type { MatchState } from '../../../engine/types'

afterEach(cleanup)

/**
 * ★ 실제로 퇴장이 나오는 경기다 — 시드 52는 어웨이가 40분·68분에 두 장을 받는다
 *   (전수 탐색으로 고른 시드). 손으로 sentOff에 id를 꽂아 넣지 않는 이유: 엔진이
 *   퇴장을 어떻게 기록하는지까지 같이 고정해야 이 테스트가 회귀를 잡는다.
 */
const RED_SEED = 52

function played(toMinute: number): MatchState {
  return simulateSegment(createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: RED_SEED }), toMinute)
}

const dotCount = (c: HTMLElement) => c.querySelectorAll('.pv-dot').length
/** 한쪽 팀 도트에 찍힌 등번호만 모은다 — 번호는 팀 간에 겹치므로 반드시 갈라서 세야 한다. */
const numbersOf = (c: HTMLElement, which: 'home' | 'away') =>
  [...c.querySelectorAll('.pv-dotg')]
    .filter(g => g.querySelector(`.pv-dot--${which}`))
    .map(g => g.querySelector('.pv-num')?.textContent ?? '')

describe('시드 52 — 어웨이가 두 번 퇴장당하는 실제 경기', () => {
  it('엔진이 40분·68분에 레드카드를 기록한다(이 테스트의 전제)', () => {
    const st = played(90)
    const reds = st.events.filter(e => e.type === 'red')
    expect(reds.map(r => r.minute)).toEqual([40, 68])
    expect(st.away.sentOff).toHaveLength(2)
    expect(st.home.sentOff).toHaveLength(0)
    // 라인업 슬롯은 남아 있다 — 그래서 표시 쪽이 직접 걸러야 한다.
    expect(st.away.tactics.lineup).toHaveLength(11)
  })

  it('SVG 작전판 도트가 22 → 21 → 20으로 줄어든다', () => {
    const at = (m: number) => {
      const { container } = render(<PitchView state={played(m)} />)
      return dotCount(container)
    }
    expect(at(39)).toBe(22)
    expect(at(41)).toBe(21)
    expect(at(69)).toBe(20)
  })

  it('퇴장 선수의 등번호가 보드에서 사라진다(회색으로도 남지 않는다)', () => {
    const st = played(69)
    const off = st.away.sentOff
    expect(off).toHaveLength(2)
    const gone = off.map(id => String(st.away.team.squad.find(p => p.id === id)!.number))
    const { container } = render(<PitchView state={st} />)
    const shown = numbersOf(container, 'away')
    for (const n of gone) expect(shown).not.toContain(n)
    // 남은 9명은 그대로 있다.
    const stay = st.away.tactics.lineup
      .filter(s => !off.includes(s.playerId))
      .map(s => String(st.away.team.squad.find(p => p.id === s.playerId)!.number))
    for (const n of stay) expect(shown).toContain(n)
  })

  it('이름표도 함께 사라진다 — 도트 없는 이름이 잔디에 떠 있으면 안 된다', () => {
    const st = played(69)
    const offNames = st.away.sentOff.map(id => st.away.team.squad.find(p => p.id === id)!.name.ko)
    // 하이라이트 이름표는 안무 참여자에게만 붙는다 → 어웨이 시퀀스로 재생해 본다.
    const seq = buildSequence({ minute: 69, type: 'goal', teamId: st.away.team.id }, st.home, st.away)
    const { container } = render(<PitchView state={st} sequence={seq} sequenceSide="away" nameLabels />)
    const shown = [...container.querySelectorAll('.pv-name')].map(n => n.textContent)
    for (const nm of offNames) expect(shown).not.toContain(nm)
  })

  it('Pixi 폴백 경로도 같은 수를 그린다(세 렌더러 일관)', () => {
    // jsdom엔 WebGL이 없어 PixiPitch는 SVG로 폴백한다 — 그래도 같은 state·같은 계약이다.
    // WebGL 경로의 도트 루프는 같은 onPitchMask를 쓰고, 실 브라우저 캡처로 따로 확인했다.
    const { container } = render(<PixiPitch state={played(69)} />)
    expect(dotCount(container)).toBe(20)
  })
})

describe('onPitchMask — 세 렌더러가 공유하는 정본', () => {
  it('퇴장 슬롯만 false이고 인덱스 정렬은 유지된다', () => {
    const st = played(69)
    const mask = onPitchMask(st.away)
    expect(mask).toHaveLength(st.away.tactics.lineup.length)
    st.away.tactics.lineup.forEach((slot, i) => {
      expect(mask[i]).toBe(!st.away.sentOff.includes(slot.playerId))
    })
    expect(onPitchMask(st.home).every(Boolean)).toBe(true)
  })
})

describe('유령 도트가 계산에도 끼지 않는다', () => {
  it('separateDots는 비활성 슬롯을 밀지도, 밀리지도 않는다', () => {
    // 같은 자리에 세 점: 0·1은 활성, 2는 비활성(퇴장).
    const coords = [{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }]
    const masked = separateDots(coords, [true, true, false])
    // 비활성은 입력 그대로.
    expect(masked[2]).toEqual({ x: 50, y: 50 })
    // 활성 둘은 서로만 보고 갈라진다 — 마스크 없이 세 점을 푼 결과와 달라야 한다.
    const all = separateDots(coords)
    expect(masked[0]).not.toEqual(all[0])
    // 활성 둘의 결과는 "그 둘만 넘긴 것"과 같아야 한다(유령의 영향 0).
    const only2 = separateDots([coords[0], coords[1]])
    expect(masked[0]).toEqual(only2[0])
    expect(masked[1]).toEqual(only2[1])
  })

  it('blockMetrics는 GK가 퇴장해도 필드 플레이어를 잘라 내지 않는다', () => {
    // 슬롯 0 = GK. 마스크로 걸러야 하며, 배열에서 먼저 빼면 slice(1)이 한 명을 더 먹는다.
    const coords = [{ x: 5, y: 50 }, { x: 20, y: 20 }, { x: 60, y: 80 }]
    const gkOut = blockMetrics(coords, [false, true, true])
    expect(gkOut).toEqual(blockMetrics(coords))
    // 필드 플레이어 하나가 퇴장하면 스팬이 실제로 줄어든다.
    const oneOut = blockMetrics(coords, [true, true, false])
    expect(oneOut.lengthM).toBeLessThan(gkOut.lengthM)
    expect(oneOut.widthM).toBeLessThan(gkOut.widthM)
  })
})
