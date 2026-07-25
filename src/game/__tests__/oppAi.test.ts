import { describe, it, expect, beforeEach } from 'vitest'
import { decideAwayActions } from '../oppAi'
import { createMatch, applyCommand } from '../../engine/simulate'
import { loadTeam, type TeamId } from '../../data/loader'
import { useMatchStore } from '../matchStore'

function matchAt(minute: number, score: [number, number], away: TeamId = 'cze') {
  const st = createMatch(loadTeam('kor'), loadTeam(away), { seed: 42 })
  st.minute = minute
  st.score = score
  return st
}

describe('decideAwayActions', () => {
  it('46분 이전에는 아무 행동도 하지 않는다', () => {
    expect(decideAwayActions(matchAt(30, [0, 0]), 30, [])).toEqual([])
  })

  it('창(46/60/70/80)에서만 행동한다', () => {
    expect(decideAwayActions(matchAt(55, [0, 1]), 55, [])).toEqual([])
    expect(decideAwayActions(matchAt(60, [0, 1]), 60, []).length).toBeGreaterThan(0)
  })

  it('이미 발동한 키는 재발동하지 않는다', () => {
    const first = decideAwayActions(matchAt(60, [0, 1]), 60, [])
    const keys = first.map(a => a.notice)
    expect(decideAwayActions(matchAt(60, [0, 1]), 60, keys)).toEqual([])
  })

  it('결정론 — 같은 상태에 같은 결과', () => {
    const a = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    const b = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('지시 변경은 프로필 스타일 ±20을 벗어나지 않는다', () => {
    const st = matchAt(60, [2, 0])   // 어웨이가 지고 있다 → 공격적으로 전환
    const acts = decideAwayActions(st, 60, [])
    const style = st.away.team.profile.style
    for (const a of acts) {
      if (a.cmd.type !== 'instructions') continue
      const ins = a.cmd.instructions
      expect(Math.abs(ins.lineHeight - style.lineHeight)).toBeLessThanOrEqual(20)
      expect(Math.abs(ins.pressing - style.pressing)).toBeLessThanOrEqual(20)
      expect(Math.abs(ins.tempo - style.tempo)).toBeLessThanOrEqual(20)
    }
  })

  it('누적 변경이 ±20을 넘으려 하면 클램프가 실제로 막는다', () => {
    // can(chase-attack, tempo 68): 추격 전환(+15) 후 동점이 되어 후반 템포 상향(+8)이면
    // 누적 +23이라 style+20=88에서 잘려야 한다. 팀 정체성 유지 계약의 핵심 케이스.
    const st = matchAt(80, [1, 1], 'can')
    st.away.tactics.instructions = { ...st.away.tactics.instructions, tempo: 68 + 15 }
    const acts = decideAwayActions(st, 80, [])
    const ins = acts.find(a => a.cmd.type === 'instructions')
    expect(ins).toBeDefined()
    if (ins?.cmd.type === 'instructions') expect(ins.cmd.instructions.tempo).toBe(88)
  })

  it('마지막 창까지 뒤지면 총공세로 전환하되 스타일 ±20에서 잘린다', () => {
    const st = matchAt(80, [2, 1], 'esp')
    const style = st.away.team.profile.style   // lineHeight 62 / tempo 55
    // 이미 46'에 추격 전환(+10)을 한 상태 → 총공세 +20이면 누적 +30이라 클램프가 물린다.
    st.away.tactics.instructions = {
      ...st.away.tactics.instructions,
      lineHeight: style.lineHeight + 10, tempo: style.tempo + 10,
    }
    const a = decideAwayActions(st, 80, []).find(x => x.cmd.type === 'instructions')
    expect(a?.notice).toContain('총공세')
    if (a?.cmd.type === 'instructions') {
      expect(a.cmd.instructions.lineHeight).toBe(style.lineHeight + 20)
      expect(a.cmd.instructions.tempo).toBe(style.tempo + 20)
    }
  })

  it('프로필별 성향이 유지된다 — protect-lead는 더 깊이 내려앉는다', () => {
    // cze는 protect-lead, arg는 balanced. 같은 리드 상황에서 하향 폭이 달라야 한다.
    const drop = (teamId: TeamId) => {
      const st = matchAt(60, [0, 1], teamId)
      const acts = decideAwayActions(st, 60, [])
      const a = acts.find(x => x.cmd.type === 'instructions')
      if (a?.cmd.type !== 'instructions') throw new Error('지시 변경 없음')
      return st.away.tactics.instructions.lineHeight - a.cmd.instructions.lineHeight
    }
    expect(drop('cze')).toBeGreaterThan(drop('arg'))
  })

  it('모든 행동에 한국어 통보 문구가 있다', () => {
    const acts = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    expect(acts.length).toBeGreaterThan(0)
    expect(acts.every(a => a.notice.length > 0)).toBe(true)
  })

  it('교체 통보는 선수 이름을 포함해 매번 키가 달라진다(3장까지 가능)', () => {
    const first = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    const sub = first.find(a => a.cmd.type === 'sub')
    expect(sub).toBeDefined()
    expect(sub!.notice).toContain('교체')
    // 교체 통보 키가 이미 done에 있어도, 다른 선수를 대상으로 한 새 교체는 여전히 가능하다.
    expect(sub!.notice).not.toBe('📢 교체')
  })

  it('교체 명령은 applyCommand로 적용 가능하다(라인업 정합성)', () => {
    let st = matchAt(60, [1, 0])
    for (const a of decideAwayActions(st, 60, [])) {
      if (a.cmd.type === 'sub') st = applyCommand(st, 'away', a.cmd)
    }
    expect(st.away.tactics.lineup.length).toBe(11)
    const ids = st.away.tactics.lineup.map(l => l.playerId)
    expect(new Set(ids).size).toBe(11)
  })

  it('교체 한도(3장)를 넘기지 않는다', () => {
    const st = matchAt(80, [1, 0])
    st.away.subsUsed = 3
    expect(decideAwayActions(st, 80, []).some(a => a.cmd.type === 'sub')).toBe(false)
  })

  it('GK는 교체 대상이 되지 않는다', () => {
    const st = matchAt(60, [1, 0])
    const gkId = st.away.tactics.lineup.find(l => l.slot === 'GK')!.playerId
    // 골키퍼를 최저 체력으로 만들어도 교체 대상에서 제외돼야 한다.
    for (const id of Object.keys(st.away.staminaByPlayer)) st.away.staminaByPlayer[id] = 90
    st.away.staminaByPlayer[gkId] = 1
    const subs = decideAwayActions(st, 60, []).filter(a => a.cmd.type === 'sub')
    expect(subs.every(a => a.cmd.type === 'sub' && a.cmd.out !== gkId)).toBe(true)
  })
})

describe('상대 AI 실경기 통합', () => {
  beforeEach(() => useMatchStore.getState().reset())

  it('90분 실경기에서 상대가 교체 1회 이상·통보 2회 이상을 한다', () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 4242)
    s.kickoff()
    for (let i = 0; i < 200; i++) {
      const st = useMatchStore.getState()
      if (st.phase === 'fulltime') break
      if (st.momentPrompt) st.dismissMoment()
      if (st.phase !== 'playing') st.confirmTactics()
      else st.advanceMinute()
    }
    const eng = useMatchStore.getState().engine!
    expect(eng.away.subsUsed).toBeGreaterThanOrEqual(1)
    expect(eng.away.subsUsed).toBeLessThanOrEqual(3)
    expect(useMatchStore.getState().oppNotices.length).toBeGreaterThanOrEqual(2)
    // 통보는 발동 분과 함께 기록되고, 문구가 중복되지 않는다(유형당 1회 계약).
    const texts = useMatchStore.getState().oppNotices.map(n => n.text)
    expect(new Set(texts).size).toBe(texts.length)
  }, 60_000)

  it('통보 이력과 엔진 교체 이벤트 수가 일치한다', () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('esp'), 777)
    s.kickoff()
    for (let i = 0; i < 200; i++) {
      const st = useMatchStore.getState()
      if (st.phase === 'fulltime') break
      if (st.momentPrompt) st.dismissMoment()
      if (st.phase !== 'playing') st.confirmTactics()
      else st.advanceMinute()
    }
    const eng = useMatchStore.getState().engine!
    const awaySubEvents = eng.events.filter(e => e.type === 'sub' && e.teamId === eng.away.team.id)
    const subNotices = useMatchStore.getState().oppNotices.filter(n => n.text.includes('교체'))
    expect(awaySubEvents.length).toBe(subNotices.length)
    expect(awaySubEvents.length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
