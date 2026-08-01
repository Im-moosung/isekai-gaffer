// 순간 제안 배너의 만료. 감사 재현: 2'에 실점해 뜬 "실점 직후입니다"가 7' 동점골
// 이후에도 같은 문장으로 남았고(스코어 1:1), 다른 세션에서는 10'→22' 12분 지속했다.
// 화면이 실제 상황과 정반대를 말하는 것이 문제의 본질이라, 스코어 변화는 즉시 소거하고
// 그 외에는 유효 기간(MOMENT_PROMPT_TTL)으로 끊는다.
import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore, momentPromptAlive, MOMENT_PROMPT_TTL } from '../matchStore'
import type { DecisionMoment } from '../matchSession'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 82), away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

const prompt = (minute: number): DecisionMoment => ({ kind: 'conceded', minute, title: '실점 직후' })

describe('momentPromptAlive — 순수 판정', () => {
  it('제안이 없으면 죽어 있다', () => {
    expect(momentPromptAlive(null, null, 10, [0, 0])).toBe(false)
  })

  it('유효 기간 안이고 스코어가 그대로면 살아 있다', () => {
    expect(momentPromptAlive(prompt(2), [0, 1], 2 + MOMENT_PROMPT_TTL, [0, 1])).toBe(true)
  })

  it('유효 기간을 1분이라도 넘기면 죽는다', () => {
    expect(momentPromptAlive(prompt(2), [0, 1], 2 + MOMENT_PROMPT_TTL + 1, [0, 1])).toBe(false)
  })

  it('스코어가 바뀌면 기간과 무관하게 즉시 죽는다 — 문장이 거짓이 되기 때문', () => {
    expect(momentPromptAlive(prompt(2), [0, 1], 3, [1, 1])).toBe(false)
    expect(momentPromptAlive(prompt(2), [0, 1], 3, [0, 2])).toBe(false)
  })

  it('반응할 시간을 남긴다 — 노출 게이트 지연까지 흡수한다(최소 6분)', () => {
    // 1x 재생에서 사건 분 dwell은 최대 9.6 s, 무사건 분은 1.1 s다. 3분 미만이면
    // 2x에서 배너를 읽기도 전에 사라진다.
    // ★ 2026-08-01: MatchScreen이 배너에 `revealed` 노출 게이트를 걸었다(배너가 실점
    //   장면보다 먼저 뜨던 결함). 노출이 밀리면 **반응할 창도 함께 밀린다.** 지연의 상한은
    //   그 분의 dwell 하나(골 안무 8.6 s 중 reveal이 6~7 s 지점)이고, 이는 무사건 분
    //   여섯 개(1.1 s × 6)보다 크므로 경기 분 1분을 통째로 되돌려 준다 — 5 → 6.
    expect(MOMENT_PROMPT_TTL).toBeGreaterThanOrEqual(6)
  })

  it('그렇다고 브레이크 간격을 잠식하지 않는다 — 상한은 여전히 지킨다', () => {
    // 하이드레이션 브레이크 간격은 약 22분이다. 한 배너가 그 절반을 차지하면 다음 제안이
    // 뜰 자리가 사라진다(momentPrompt는 하나뿐이라 새 제안을 막는다).
    expect(MOMENT_PROMPT_TTL).toBeLessThan(11)
  })
})

describe('advanceMinute — 실주행 소거', () => {
  /** 제안이 떠 있는 상태를 강제로 만든다(감지 조건에 의존하지 않는 재현). */
  function seedPrompt(minute: number, score: [number, number]) {
    store().startMatch(home, away, 42)
    store().kickoff()
    const engine = structuredClone(store().engine!)
    engine.minute = minute
    engine.score = score
    useMatchStore.setState({
      engine, phase: 'playing',
      momentPrompt: prompt(minute), momentPromptScore: score,
      firedMoments: ['conceded'],
    })
  }

  it('스코어가 바뀐 다음 분에 배너가 사라진다', () => {
    seedPrompt(2, [0, 1])
    // 동점골이 들어간 상태를 만든 뒤 한 분 진행.
    const engine = structuredClone(store().engine!)
    engine.score = [1, 1]
    useMatchStore.setState({ engine })
    store().advanceMinute()
    expect(store().momentPrompt).toBeNull()
    expect(store().momentPromptScore).toBeNull()
  })

  it('스코어가 그대로여도 유효 기간이 지나면 사라진다', () => {
    seedPrompt(10, [0, 1])
    let guard = 0
    while (store().momentPrompt?.minute === 10 && guard++ < 30) {
      if (store().phase !== 'playing') useMatchStore.setState({ phase: 'playing' })
      store().advanceMinute()
    }
    // 10'에 뜬 제안은 늦어도 10+TTL+1분에는 없어진다(감사의 12분 지속과 대비).
    expect(store().engine!.minute).toBeLessThanOrEqual(10 + MOMENT_PROMPT_TTL + 1)
    expect(store().momentPrompt?.minute).not.toBe(10)
  })

  it('만료 전에는 유지된다 — 반응할 시간을 준다', () => {
    seedPrompt(10, [0, 1])
    // 스코어를 고정한 채 1분만 진행(득점 없는 분을 고르기 위해 엔진 스코어를 되돌린다).
    const before = store().engine!.score
    store().advanceMinute()
    if (store().engine!.score[0] === before[0] && store().engine!.score[1] === before[1]) {
      expect(store().momentPrompt?.minute).toBe(10)
    }
  })

  it('만료된 제안이 새 제안을 막지 않는다', () => {
    // 낡은 제안이 살아 있는 동안에는 감지가 건너뛰어진다. 만료되면 다시 열려야 한다.
    seedPrompt(10, [0, 0])
    useMatchStore.setState({ firedMoments: [] })
    let guard = 0
    while (guard++ < 40 && store().phase !== 'fulltime') {
      if (store().phase !== 'playing') useMatchStore.setState({ phase: 'playing' })
      store().advanceMinute()
      const p = store().momentPrompt
      if (p && p.minute > 10) return // 새 제안이 떴다 — 통과
      if (store().engine!.minute > 10 + MOMENT_PROMPT_TTL) {
        // 최소한 낡은 제안은 사라져 있어야 한다.
        expect(store().momentPrompt?.minute).not.toBe(10)
      }
    }
  })

  it('dismissMoment·confirmTactics는 스코어 스냅샷도 함께 지운다', () => {
    seedPrompt(10, [0, 1])
    store().dismissMoment()
    expect(store().momentPromptScore).toBeNull()

    seedPrompt(20, [0, 1])
    useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
    store().confirmTactics()
    expect(store().momentPrompt).toBeNull()
    expect(store().momentPromptScore).toBeNull()
  })
})
