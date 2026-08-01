// 순간 제안 × 개입 자원 — 사용자 지적(2026-08-01):
//
//   *"감독 타임이 5회 개입에 포함되고 쿨타임이 있는데 '상대에게 흐름 넘어갔습니다.
//     개입하시겠습니까?' 이런 버튼이 떠. 근데 나는 이미 감독 개입을 다 썼거나,
//     감독 개입 쿨타임일 때도 떠."*
//
// 결함 셋이 겹쳐 있었다:
//  1. 감지가 자원을 전혀 보지 않아, 쓸 수 없는 상태에서 "쓰시겠습니까?"라고 물었다.
//  2. 눌러도 store가 조용히 return해서 아무 일도 이유도 없었다.
//  3. firedMoments(유형당 1회)가 그 순간에 소진돼, 나중에 쓸 수 있게 돼도 다시 안 떴다.
//
// 처방의 원칙: **사실은 알리되 제안은 하지 않는다.** 순간 자체(`흐름을 내주고 있습니다`)는
// 감독 타임과 무관하게 유저가 알아야 할 경기 정보이므로 감지를 막지 않는다. 대신
//  · 제안/알림 판정은 **렌더 시점**(MatchScreen)이 freeInterventionState로 내리고,
//  · 유형 소비는 "이 제안이 제안으로 성립했는가"가 정한다(아래 테스트가 규칙을 고정).
import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore, freeInterventionState, MAX_FREE_INTERVENTIONS, INTERVENTION_COOLDOWN } from '../matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

/** 첫 순간이 뜰 때까지 재생. 뜬 분을 함께 돌려준다(뜨지 않으면 null). */
function playToFirstMoment(seed: number): number | null {
  store().startMatch(a, b, seed)
  store().kickoff()
  let guard = 0
  while (!store().momentPrompt && store().phase !== 'fulltime' && guard++ < 500) {
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
  return store().momentPrompt ? store().engine!.minute : null
}

describe('막히면 이유를 말한다 — store가 사유를 돌려준다', () => {
  it('pauseByUser: 횟수를 다 썼으면 blockedReason과 같은 문장을 돌려준다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    useMatchStore.setState({ freeInterventionsUsed: MAX_FREE_INTERVENTIONS })
    const minute = store().engine!.minute
    const expected = freeInterventionState(MAX_FREE_INTERVENTIONS, null, minute).blockedReason
    expect(store().pauseByUser()).toBe(expected)
    // 거절이므로 상태는 그대로다.
    expect(store().phase).toBe('playing')
  })

  it('pauseByUser: 쿨다운 중이면 남은 분이 담긴 사유를 돌려준다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    const minute = store().engine!.minute
    useMatchStore.setState({ lastInterventionMinute: minute })
    const reason = store().pauseByUser()
    expect(reason).toContain('쿨다운')
    expect(reason).toContain(String(INTERVENTION_COOLDOWN))
    expect(store().phase).toBe('playing')
  })

  it('pauseByUser: 성공하면 null을 돌려준다(알림을 띄우지 않는다)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    expect(store().pauseByUser()).toBeNull()
    expect(store().phase).toBe('paused-user')
  })

  it('acceptMoment: 자원이 없으면 조용히 삼키지 않고 사유를 돌려준다', () => {
    const minute = playToFirstMoment(3)
    expect(minute).not.toBeNull()
    useMatchStore.setState({ freeInterventionsUsed: MAX_FREE_INTERVENTIONS })
    const reason = store().acceptMoment()
    expect(reason).toBeTruthy()
    expect(reason).toBe(freeInterventionState(MAX_FREE_INTERVENTIONS, null, minute!).blockedReason)
    expect(store().phase).toBe('playing')
  })
})

describe('firedMoments 소비 규칙 — 손해가 겹치지 않는다', () => {
  /** 쿨다운을 건 채로 첫 순간까지 재생한다. 킥오프 직후 lastInterventionMinute을 0으로
   *  두면 0~9분은 쿨다운이고, 그 사이에 실점·흐름 상실이 잡히면 이 조건이 성립한다. */
  function playUnderCooldown(seed: number) {
    store().startMatch(a, b, seed)
    store().kickoff()
    useMatchStore.setState({ lastInterventionMinute: 0 })
    let guard = 0
    while (!store().momentPrompt && store().phase === 'playing' && guard++ < INTERVENTION_COOLDOWN - 1) {
      store().advanceMinute()
    }
    return store().momentPrompt
  }

  it('★ 쿨다운 중에 뜬 순간은 유형을 소비하지 않는다(자원이 돌아오면 다시 필요하다)', () => {
    // 쿨다운 중에 순간이 잡히는 시드를 찾는다 — 어느 시드든 규칙은 같아야 한다.
    let found = false
    for (const seed of [3, 7, 11, 42, 101, 2026, 777, 1234]) {
      store().reset()
      const prompt = playUnderCooldown(seed)
      if (!prompt) continue
      const fi = freeInterventionState(
        store().freeInterventionsUsed, store().lastInterventionMinute, store().engine!.minute,
      )
      if (fi.canPause) continue // 쿨다운이 이미 풀렸다 — 이 시드는 조건 밖이다
      found = true
      // 막힌 것은 **기다리면 풀리는** 쿨다운이므로 유형이 살아 있어야 한다.
      expect(fi.cooldownLeft).toBeGreaterThan(0)
      expect(store().firedMoments).not.toContain(prompt.kind)
      break
    }
    expect(found).toBe(true)
  })

  it('★ 횟수 소진 중에 뜬 순간은 유형을 소비한다(자원이 돌아올 길이 없어 반복은 소음이다)', () => {
    let found = false
    for (const seed of [3, 7, 11, 42, 101, 2026, 777, 1234]) {
      store().reset()
      store().startMatch(a, b, seed)
      store().kickoff()
      useMatchStore.setState({ freeInterventionsUsed: MAX_FREE_INTERVENTIONS })
      let guard = 0
      while (!store().momentPrompt && store().phase === 'playing' && guard++ < 60) store().advanceMinute()
      const prompt = store().momentPrompt
      if (!prompt) continue
      found = true
      expect(store().firedMoments).toContain(prompt.kind)
      break
    }
    expect(found).toBe(true)
  })

  it('쓸 수 있을 때 뜬 순간은 지금까지처럼 유형을 소비한다', () => {
    const minute = playToFirstMoment(3)
    expect(minute).not.toBeNull()
    const prompt = store().momentPrompt!
    const fi = freeInterventionState(
      store().freeInterventionsUsed, store().lastInterventionMinute, minute!,
    )
    expect(fi.canPause).toBe(true)
    expect(store().firedMoments).toContain(prompt.kind)
  })

  it('쿨다운이 풀리면 살아 있는 제안이 그때 유형을 소비한다(제안으로 승격한 시점)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    const minute = store().engine!.minute
    // 쿨다운 중에 뜬 제안을 직접 심는다 — 소비되지 않은 상태를 재현한다.
    useMatchStore.setState({
      lastInterventionMinute: minute,
      momentPrompt: { kind: 'conceded', minute, title: '실점 직후' },
      momentPromptScore: [store().engine!.score[0], store().engine!.score[1]],
      firedMoments: [],
    })
    expect(store().firedMoments).not.toContain('conceded')
    // 쿨다운을 풀면(자원 복귀) 다음 분에 유형이 소비된다.
    useMatchStore.setState({ lastInterventionMinute: null })
    store().advanceMinute()
    expect(store().firedMoments).toContain('conceded')
  })

  it('유형에 중복은 여전히 없다 — 소비 규칙이 바뀌어도 firedMoments 자체는 집합이다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    let guard = 0
    while (store().phase !== 'fulltime' && guard++ < 500) {
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    const fired = store().firedMoments
    expect(new Set(fired).size).toBe(fired.length)
  })
})
