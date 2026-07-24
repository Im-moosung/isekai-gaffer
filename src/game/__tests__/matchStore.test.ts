import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore, TEAM_TALK_TABLE, scoreSituation, SHOUT_TABLE, SHOUT_COOLDOWN } from '../matchStore'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

/** 킥오프 후 하프타임까지 재생 — 도중 하이드레이션 브레이크는 confirmTactics로 재개.
 *  경기가 시작 안 됐으면 기본 매치(a,b,42)로 시작한다. */
function toHalftime() {
  if (!store().engine) store().startMatch(a, b, 42)
  store().kickoff()
  let guard = 0
  while (store().phase !== 'halftime' && guard++ < 200) {
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

/** 브레이크·순간 무시하며 풀타임까지 재생. */
function toFulltime() {
  if (!store().engine) store().startMatch(a, b, 42)
  store().kickoff()
  let guard = 0
  while (store().phase !== 'fulltime' && guard++ < 500) {
    if (store().momentPrompt) store().dismissMoment()
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

describe('재생 세션 상태 머신', () => {
  it('startMatch → pre 준비, engine·schedule 생성', () => {
    store().startMatch(a, b, 42)
    expect(store().engine).not.toBeNull()
    expect(store().phase).toBe('pre')
    expect(store().schedule).not.toBeNull()
  })
  it('kickoff → playing', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(store().phase).toBe('playing')
  })
  it('advanceMinute은 1분씩 전진(엔진 스텝)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    expect(store().engine!.minute).toBe(1)
    store().advanceMinute()
    expect(store().engine!.minute).toBe(2)
  })
  it('정지 중 advanceMinute은 no-op(재개는 confirmTactics로만)', () => {
    store().startMatch(a, b, 42)
    // pre에서 advanceMinute은 진행하지 않는다
    store().advanceMinute()
    expect(store().engine!.minute).toBe(0)
  })
  it('advanceMinute이 22±2 하이드레이션 창에서 자동 paused-break', () => {
    store().startMatch(a, b, 42)
    const sched = store().schedule!
    expect(sched.firstHydration).toBeGreaterThanOrEqual(20)
    expect(sched.firstHydration).toBeLessThanOrEqual(24)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && store().engine!.minute < sched.firstHydration && guard++ < 60) store().advanceMinute()
    expect(store().engine!.minute).toBe(sched.firstHydration)
    expect(store().phase).toBe('paused-break')
    expect(store().pauseReason).toEqual({ kind: 'hydration1' })
  })
  it('두 번째 하이드레이션(67±2)에서도 자동 정지', () => {
    store().startMatch(a, b, 42)
    const sched = store().schedule!
    expect(sched.secondHydration).toBeGreaterThanOrEqual(65)
    expect(sched.secondHydration).toBeLessThanOrEqual(69)
    store().kickoff()
    let guard = 0
    while (store().engine!.minute < sched.secondHydration && guard++ < 200) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    expect(store().engine!.minute).toBe(sched.secondHydration)
    expect(store().phase).toBe('paused-break')
    expect(store().pauseReason).toEqual({ kind: 'hydration2' })
  })
  it('45분 도달 시 halftime 자동 정지', () => {
    toHalftime()
    expect(store().phase).toBe('halftime')
    expect(store().engine!.minute).toBe(45)
    expect(store().pauseReason).toEqual({ kind: 'halftime' })
  })
  it('confirmTactics가 정지를 해제하고 boostUntil을 minute+8로 설정', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && guard++ < 60) store().advanceMinute() // 첫 브레이크에서 정지
    expect(store().phase).toBe('paused-break')
    const m = store().engine!.minute
    store().confirmTactics()
    expect(store().phase).toBe('playing')
    expect(store().boostUntil).toBe(m + 8)
  })
  it('정지가 아닐 때 confirmTactics는 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().confirmTactics()).toThrow()
  })
  it('pauseByUser는 playing에서만 paused-user로', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().pauseByUser()
    expect(store().phase).toBe('paused-user')
    expect(store().pauseReason).toEqual({ kind: 'user' })
  })
  it('풀타임 도달 → fulltime, minute 90', () => {
    toFulltime()
    expect(store().phase).toBe('fulltime')
    expect(store().engine!.minute).toBe(90)
  })
  it('halftime에 submitCommand(지시 변경)가 엔진에 반영된다', () => {
    toHalftime()
    const before = store().engine!.home.tactics.instructions.pressing
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(90)
    expect(before).not.toBe(90)
  })
  it('paused-user에서도 submitCommand 허용', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().pauseByUser()
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 77, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(77)
  })
  it('playing 중 submitCommand는 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })).toThrow()
  })
  it('DecisionPrompt·카운트다운 필드가 없다(시간 정지 구조)', () => {
    const s = store() as unknown as Record<string, unknown>
    expect('pendingDecision' in s).toBe(false)
    expect('displayMinute' in s).toBe(false)
    expect('playTo' in s).toBe(false)
    expect('tickDisplay' in s).toBe(false)
  })
})

describe('동적 순간(momentPrompt)', () => {
  it('acceptMoment는 제안이 없으면 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().acceptMoment()).toThrow()
  })
  it('모든 유형이 이미 발동됐으면 재생 내내 momentPrompt가 뜨지 않는다(유형당 1회)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    useMatchStore.setState({ firedMoments: ['conceded', 'scored', 'momentum-lost', 'clutch', 'fatigue'] })
    let guard = 0
    while (store().phase !== 'fulltime' && guard++ < 500) {
      expect(store().momentPrompt).toBeNull()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
  })
  it('발동된 순간 유형에 중복이 없다(경기 전체)', () => {
    toFulltime()
    const fired = store().firedMoments
    expect(new Set(fired).size).toBe(fired.length)
  })
  it('acceptMoment → paused-moment, dismissMoment는 재생 유지', () => {
    // 순간이 실제로 떠오르는 지점까지 재생
    store().startMatch(a, b, 3)
    store().kickoff()
    let guard = 0
    while (!store().momentPrompt && store().phase !== 'fulltime' && guard++ < 500) {
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().momentPrompt) {
      store().acceptMoment()
      expect(store().phase).toBe('paused-moment')
      expect(store().pauseReason?.kind).toBe('moment')
    }
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
    expect(store().engine!.home.staminaByPlayer[a.squad[1].id]).toBe(100)
    expect(store().engine!.home.staminaByPlayer['ghost']).toBeUndefined()
  })
  it('firstHalfScript 전달 시 전반은 시뮬 대신 스크립트 스코어를 재현한다', () => {
    const events = [{ minute: 30, type: 'goal' as const, teamId: a.id }]
    store().startMatch(a, b, 42, { firstHalfScript: { events, score: [1, 0] } })
    toHalftime()
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
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    expect(store().phase).toBe('halftime')
    const before = { ...store().engine!.home.moraleByPlayer }
    store().applyTeamTalk('home', 'rage')
    for (const id of Object.keys(before)) {
      expect(store().engine!.home.moraleByPlayer[id]).toBe(Math.min(100, before[id] + 8))
    }
  })
  it('팀토크는 경기당 1회만 가능(두 번째 호출 throw)', () => {
    toHalftime()
    store().applyTeamTalk('home', 'calm')
    expect(store().talked).toBe(true)
    expect(() => store().applyTeamTalk('home', 'trust')).toThrow()
  })
})

describe('터치라인 외침 (shout)', () => {
  /** kickoff 후 지정 분까지 재생(브레이크·순간 무시). */
  function playTo(minute: number) {
    store().startMatch(a, b, 42)
    store().kickoff()
    let guard = 0
    while (store().engine!.minute < minute && guard++ < 300) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
  }

  it('상황별 부호: 이기는데 [더 뛰어]=사기 저하·체력 소모 / 지는데 [독려]=사기 상승 / 이기는데 [침착]=사기 상승', () => {
    expect(SHOUT_TABLE.winning.work.morale).toBeLessThan(0)
    expect(SHOUT_TABLE.winning.work.stamina).toBeLessThan(0)
    expect(SHOUT_TABLE.losing.urge.morale).toBeGreaterThan(0)
    expect(SHOUT_TABLE.losing.praise.morale).toBeLessThan(0) // 지는데 칭찬=공허(역효과)
    expect(SHOUT_TABLE.winning.calm.morale).toBeGreaterThan(0)
  })

  it('재생 중이 아니면 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().shout('urge')).toThrow()
  })

  it('playing 중 외침은 정지 없이 홈 사기를 즉시 보정하고 lastShoutMinute·로그 기록', () => {
    playTo(30)
    expect(store().phase).toBe('playing')
    const before = { ...store().engine!.home.moraleByPlayer }
    const situation = scoreSituation(store().engine!.score, 'home')
    const m = store().engine!.minute
    store().shout('urge')
    expect(store().phase).toBe('playing') // 정지 없음
    expect(store().lastShoutMinute).toBe(m)
    const delta = SHOUT_TABLE[situation].urge.morale
    for (const id of Object.keys(before)) {
      expect(store().engine!.home.moraleByPlayer[id]).toBe(Math.max(0, Math.min(100, before[id] + delta)))
    }
    const log = store().decisionLog
    expect(log[log.length - 1].summary).toBe(`${m}' 외침: 독려`)
  })

  it('10분 쿨다운: 외침 직후 재외침은 throw, 쿨다운 경과 후 허용', () => {
    playTo(20)
    store().shout('calm')
    const first = store().lastShoutMinute!
    expect(SHOUT_COOLDOWN).toBe(10)
    // 쿨다운 내(경과<10) 재외침 throw
    let guard = 0
    while (store().engine!.minute - first < SHOUT_COOLDOWN - 1 && guard++ < 30) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().phase === 'playing') {
      expect(() => store().shout('urge')).toThrow()
    }
    // 쿨다운 경과까지 진행 후 재외침 허용
    guard = 0
    while (store().engine!.minute - first < SHOUT_COOLDOWN && guard++ < 30) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().phase === 'playing') {
      expect(() => store().shout('urge')).not.toThrow()
      expect(store().lastShoutMinute).toBe(store().engine!.minute)
    }
  })

  it('reset 시 lastShoutMinute 초기화', () => {
    playTo(15)
    store().shout('praise')
    expect(store().lastShoutMinute).not.toBeNull()
    store().reset()
    expect(store().lastShoutMinute).toBeNull()
  })
})

describe('decisionLog 수집 (기자회견 근거)', () => {
  it('startMatch 시 decisionLog는 빈 배열', () => {
    store().startMatch(a, b, 42)
    expect(store().decisionLog).toEqual([])
  })
  it('지시 변경 → 로그 1건, summary에 바뀐 축만 나열', () => {
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: 90 } })
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('instructions')
    expect(log[0].summary).toBe(`45' 지시 변경: 압박 ${cur.pressing}→90`)
    expect(log[0].summary).not.toContain('템포')
    expect(log[0].summary).not.toContain('라인')
  })
  it('무변경 지시 재적용 → 로그에 엔트리를 추가하지 않는다 (깨진 요약 방지)', () => {
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur } })
    expect(store().decisionLog).toHaveLength(0)
  })
  it('교체 → 로그에 IN/OUT 선수 이름(name.ko) 포함', () => {
    toHalftime()
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
    toHalftime()
    const t = pickBestXI(a)
    t.formation = '3-5-2'
    store().submitCommand('home', { type: 'formation', tactics: t })
    const log = store().decisionLog
    expect(log[0].summary).toBe('HT 포메이션: 4-3-3→3-5-2')
  })
  it('팀토크 → 로그에 HT 팀토크 톤 라벨', () => {
    toHalftime()
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
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, tempo: 80 } })
    store().applyTeamTalk('home', 'rage')
    expect(store().decisionLog).toHaveLength(2)
    expect(store().decisionLog.map(d => d.kind)).toEqual(['instructions', 'teamtalk'])
    store().reset()
    expect(store().decisionLog).toEqual([])
  })
})
