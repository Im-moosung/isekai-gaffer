import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore } from '../matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

describe('matchStore 상태 머신', () => {
  it('startMatch → pre에서 playing 준비, engine 생성', () => {
    store().startMatch(a, b, 42)
    expect(store().engine).not.toBeNull()
    expect(store().phase).toBe('pre')
  })
  it('playTo(45) → halftime, engine.minute=45', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    expect(store().phase).toBe('halftime')
    expect(store().engine!.minute).toBe(45)
  })
  it('후반 진행 중 결정 트리거에서 decision으로 멈춘다 (결정론)', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    store().playTo(90)
    const stopped1 = store().engine!.minute
    expect(store().phase).toBe('decision')
    expect(store().pendingDecision).not.toBeNull()
    expect(stopped1).toBeGreaterThan(45); expect(stopped1).toBeLessThan(90)
    // 같은 시드 재실행 = 같은 정지 분
    store().reset(); store().startMatch(a, b, 42); store().playTo(45); store().playTo(90)
    expect(store().engine!.minute).toBe(stopped1)
  })
  it('resumeFromDecision 후 계속 → 두 번째 결정 → 최종 fulltime', () => {
    store().startMatch(a, b, 42)
    store().playTo(45); store().playTo(90)
    store().resumeFromDecision(); store().playTo(90)
    if (store().phase === 'decision') { store().resumeFromDecision(); store().playTo(90) }
    expect(store().phase).toBe('fulltime')
    expect(store().engine!.minute).toBe(90)
  })
  it('halftime에 submitCommand(지시 변경)가 엔진에 반영된다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const before = store().engine!.home.tactics.instructions.pressing
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(90)
    expect(before).not.toBe(90)
  })
  it('halftime 상태에서 resumeFromDecision은 throw', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    expect(store().phase).toBe('halftime')
    expect(() => store().resumeFromDecision()).toThrow()
  })
  it('playing 중 submitCommand는 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })).toThrow()
  })
  it('tickDisplay는 engine.minute을 넘지 않는다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    for (let i = 0; i < 60; i++) store().tickDisplay()
    expect(store().displayMinute).toBe(45)
  })
})
