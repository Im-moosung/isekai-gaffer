import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore, TEAM_TALK_TABLE, scoreSituation } from '../matchStore'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'

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

describe('startMatch opts 확장', () => {
  it('homeTactics를 홈 진영 전술에 반영한다', () => {
    const t = pickBestXI(a)
    t.formation = '4-4-2'
    store().startMatch(a, b, 42, { homeTactics: t })
    expect(store().engine!.home.tactics.formation).toBe('4-4-2')
  })
  it('staminaOverride는 지정 선수만 홈 시작 스태미나를 덮어쓴다', () => {
    const id = a.squad[0].id
    store().startMatch(a, b, 42, { staminaOverride: { [id]: 55, ghost: 12 } })
    expect(store().engine!.home.staminaByPlayer[id]).toBe(55)
    // 지정 안 된 선수는 100 유지, 존재하지 않는 id는 무시
    expect(store().engine!.home.staminaByPlayer[a.squad[1].id]).toBe(100)
    expect(store().engine!.home.staminaByPlayer['ghost']).toBeUndefined()
  })
  it('firstHalfScript 전달 시 전반은 시뮬 대신 스크립트 스코어를 재현한다', () => {
    const events = [{ minute: 30, type: 'goal' as const, teamId: a.id }]
    store().startMatch(a, b, 42, { firstHalfScript: { events, score: [1, 0] } })
    store().playTo(45)
    expect(store().engine!.score).toEqual([1, 0])
  })
})

describe('applyTeamTalk (결정론 사기 보정)', () => {
  it('보정 테이블: 지는 중 격노 +8 / 이기는 중 격노 -4 / 비기는 중 격려 +5', () => {
    expect(TEAM_TALK_TABLE.losing.rage).toBe(8)
    expect(TEAM_TALK_TABLE.winning.rage).toBe(-4)
    expect(TEAM_TALK_TABLE.drawing.encourage).toBe(5)
  })
  it('scoreSituation은 팀 관점으로 판정한다', () => {
    expect(scoreSituation([0, 1], 'home')).toBe('losing')
    expect(scoreSituation([0, 1], 'away')).toBe('winning')
    expect(scoreSituation([2, 2], 'home')).toBe('drawing')
  })
  it('halftime이 아니면 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().applyTeamTalk('home', 'rage')).toThrow()
  })
  it('지는 중 격노 → 홈 전원 사기 +8 (0~100 클램프)', () => {
    // seed=6: 데모 픽스처 매치업에서 전반 실점 재현. 여기선 스크립트로 확정.
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    store().playTo(45)
    expect(store().phase).toBe('halftime')
    const before = { ...store().engine!.home.moraleByPlayer }
    store().applyTeamTalk('home', 'rage')
    for (const id of Object.keys(before)) {
      expect(store().engine!.home.moraleByPlayer[id]).toBe(Math.min(100, before[id] + 8))
    }
  })
  it('팀토크는 경기당 1회만 가능(두 번째 호출 throw)', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    store().applyTeamTalk('home', 'calm')
    expect(store().talked).toBe(true)
    expect(() => store().applyTeamTalk('home', 'trust')).toThrow()
  })
})

describe('decisionLog 수집 (기자회견 근거)', () => {
  it('startMatch 시 decisionLog는 빈 배열', () => {
    store().startMatch(a, b, 42)
    expect(store().decisionLog).toEqual([])
  })
  it('지시 변경 → 로그 1건, summary에 바뀐 축만 나열', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: 90 } })
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('instructions')
    expect(log[0].summary).toBe(`45' 지시 변경: 압박 ${cur.pressing}→90`)
    // 바뀌지 않은 축(템포·라인)은 요약에 없다
    expect(log[0].summary).not.toContain('템포')
    expect(log[0].summary).not.toContain('라인')
  })
  it('교체 → 로그에 IN/OUT 선수 이름(name.ko) 포함', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const lineupIds = store().engine!.home.tactics.lineup.map(l => l.playerId)
    const out = lineupIds[10]
    const inId = a.squad.find(p => !lineupIds.includes(p.id))!.id
    const outName = a.squad.find(p => p.id === out)!.name.ko
    const inName = a.squad.find(p => p.id === inId)!.name.ko
    store().submitCommand('home', { type: 'sub', out, in: inId })
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('sub')
    expect(log[0].summary).toBe(`45' 교체: ${inName} IN, ${outName} OUT`)
  })
  it('포메이션 변경 → HT 포메이션 로그', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const t = pickBestXI(a)
    t.formation = '3-5-2'
    store().submitCommand('home', { type: 'formation', tactics: t })
    const log = store().decisionLog
    expect(log[0].summary).toBe('HT 포메이션: 4-3-3→3-5-2')
  })
  it('팀토크 → 로그에 HT 팀토크 톤 라벨', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    store().applyTeamTalk('home', 'encourage')
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('teamtalk')
    expect(log[0].summary).toBe('HT 팀토크: 격려')
  })
  it('logShootoutSetup → shootout-setup 엔트리', () => {
    store().startMatch(a, b, 42)
    store().logShootoutSetup('PK: 키커 순서 확정')
    const log = store().decisionLog
    expect(log[0].kind).toBe('shootout-setup')
    expect(log[0].summary).toBe('PK: 키커 순서 확정')
  })
  it('여러 개입이 순서대로 누적되고, reset 시 초기화된다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, tempo: 80 } })
    store().applyTeamTalk('home', 'rage')
    expect(store().decisionLog).toHaveLength(2)
    expect(store().decisionLog.map(d => d.kind)).toEqual(['instructions', 'teamtalk'])
    store().reset()
    expect(store().decisionLog).toEqual([])
  })
})
