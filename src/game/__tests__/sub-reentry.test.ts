// IFAB 경기규칙 제3조 — 교체되어 나간 선수는 그 경기에 다시 출전할 수 없다.
// 감사 재현: 1차 브레이크에서 교체한 선수가 2차 브레이크 벤치에 그대로 돌아와 재투입됐고,
// 상대 AI는 60'에 뺀 선발 CB를 70'에 다시 넣었다. 우리 팀·상대 AI 양쪽을 여기서 잠근다.
import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore } from '../matchStore'
import { subbedOffIds } from '../playerStats'
import { decideAwayActions } from '../oppAi'
import { createMatch, applyCommand } from '../../engine/simulate'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { loadTeam } from '../../data/loader'
import type { MatchEvent } from '../../engine/types'

const home = makeTestTeam('kor', 82), away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

/** 하이드레이션 브레이크 등급 정지(교체·전술 모두 허용). */
function pauseAtBreak() {
  useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
}

/** 홈 벤치(선발 밖) 첫 선수 id. */
function benchId(): string {
  const st = store().engine!.home
  const starters = new Set(st.tactics.lineup.map(l => l.playerId))
  return st.team.squad.find(p => !starters.has(p.id))!.id
}

describe('subbedOffIds — events 파생', () => {
  it('sub 이벤트의 detail(out:)에서 나간 선수를 읽는다 — playerId는 들어온 선수다', () => {
    const events: MatchEvent[] = [
      { minute: 60, type: 'sub', teamId: 't1', playerId: 'in-1', detail: 'out:out-1' },
      { minute: 70, type: 'sub', teamId: 't2', playerId: 'in-x', detail: 'out:out-x' },
      { minute: 75, type: 'sub', teamId: 't1', playerId: 'in-2', detail: 'out:out-2' },
    ]
    expect(subbedOffIds(events, 't1')).toEqual(['out-1', 'out-2'])
    expect(subbedOffIds(events, 't2')).toEqual(['out-x'])
  })

  it('교체가 없으면 빈 배열, detail이 없는 sub는 무시한다', () => {
    expect(subbedOffIds([], 't1')).toEqual([])
    expect(subbedOffIds([{ minute: 1, type: 'sub', teamId: 't1', playerId: 'in' }], 't1')).toEqual([])
  })
})

describe('우리 팀 — 재투입 차단', () => {
  it('교체로 나간 선수를 다시 IN 하면 스토어가 거부한다', () => {
    store().startMatch(home, away, 42)
    pauseAtBreak()
    const outId = store().engine!.home.tactics.lineup[9].playerId
    const inId = benchId()
    store().submitCommand('home', { type: 'sub', out: outId, in: inId })
    expect(subbedOffIds(store().engine!.events, home.id)).toContain(outId)

    // 두 번째 브레이크 — 방금 나간 선수를 다시 넣으려 한다.
    pauseAtBreak()
    const stillOn = store().engine!.home.tactics.lineup[3].playerId
    expect(() => store().submitCommand('home', { type: 'sub', out: stillOn, in: outId }))
      .toThrow(/IFAB 제3조/)
    // 거부됐으므로 라인업은 그대로다.
    expect(store().engine!.home.tactics.lineup.map(l => l.playerId)).toContain(stillOn)
    expect(store().engine!.home.tactics.lineup.map(l => l.playerId)).not.toContain(outId)
  })

  it('교체로 들어온 선수는 나중에 다시 뺄 수 있다(OUT은 막지 않는다)', () => {
    store().startMatch(home, away, 42)
    pauseAtBreak()
    const outId = store().engine!.home.tactics.lineup[9].playerId
    const inId = benchId()
    store().submitCommand('home', { type: 'sub', out: outId, in: inId })
    pauseAtBreak()
    const other = store().engine!.home.team.squad
      .find(p => !store().engine!.home.tactics.lineup.some(l => l.playerId === p.id)
        && p.id !== outId)!.id
    expect(() => store().submitCommand('home', { type: 'sub', out: inId, in: other })).not.toThrow()
  })

  it('상대 팀에도 같은 규칙이 적용된다(submitCommand side=away)', () => {
    store().startMatch(home, away, 42)
    pauseAtBreak()
    const st = store().engine!.away
    const outId = st.tactics.lineup[9].playerId
    const starters = new Set(st.tactics.lineup.map(l => l.playerId))
    const inId = st.team.squad.find(p => !starters.has(p.id))!.id
    store().submitCommand('away', { type: 'sub', out: outId, in: inId })
    pauseAtBreak()
    const stillOn = store().engine!.away.tactics.lineup[3].playerId
    expect(() => store().submitCommand('away', { type: 'sub', out: stillOn, in: outId }))
      .toThrow(/IFAB 제3조/)
  })
})

describe('상대 AI — 재투입 차단', () => {
  it('bestBench 후보에서 이미 나간 선수를 제외한다', () => {
    const st = createMatch(loadTeam('kor'), loadTeam('cze'), { seed: 42 })
    st.minute = 60
    st.score = [1, 0] // 어웨이가 지고 있다 → 추격 교체
    const first = decideAwayActions(st, 60, []).filter(a => a.cmd.type === 'sub')
    expect(first.length).toBe(1)
    const cmd = first[0].cmd as { type: 'sub'; out: string; in: string }
    const after = applyCommand(st, 'away', cmd)
    after.minute = 70
    // 나간 선수가 70' 창에서 다시 IN 후보로 나오면 안 된다.
    for (const a of decideAwayActions(after, 70, [])) {
      if (a.cmd.type === 'sub') expect(a.cmd.in).not.toBe(cmd.out)
    }
  })

  it('여러 시드 풀 경기 — 상대·우리 양 팀 모두 재투입 0건', () => {
    // 실주행: 90분을 스토어로 돌리며 상대 AI가 매 창에서 교체하게 둔다.
    for (const seed of [1, 7, 13, 42, 99, 271, 512, 1024]) {
      for (const oppId of ['cze', 'esp', 'arg'] as const) {
        store().reset()
        store().startMatch(loadTeam('kor'), loadTeam(oppId), seed)
        store().kickoff()
        let guard = 0
        while (store().phase !== 'fulltime' && guard++ < 400) {
          if (store().phase === 'playing') store().advanceMinute()
          else store().confirmTactics()
        }
        const events = store().engine!.events
        for (const teamId of [store().engine!.home.team.id, store().engine!.away.team.id]) {
          const off = new Set<string>()
          for (const e of events) {
            if (e.type !== 'sub' || e.teamId !== teamId) continue
            expect(off.has(e.playerId!), `seed ${seed} ${oppId}: ${e.playerId} 재투입`).toBe(false)
            off.add(e.detail!.slice('out:'.length))
          }
        }
      }
    }
  })
})
