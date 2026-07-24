import { describe, it, expect, beforeEach } from 'vitest'
import { useCampaignStore } from '../campaignStore'

const store = () => useCampaignStore.getState()
const win = (a = 1, b = 0) => store().recordResult([a, b], {})

beforeEach(() => store().reset())

describe('startCampaign / 초기 상태', () => {
  it('조별 1경기(group1)는 체코가 상대다', () => {
    store().startCampaign(7)
    expect(store().stage).toBe('group1')
    expect(store().currentOpponent()).toBe('cze')
    expect(store().groupRank).toBeNull()
    expect(store().path).toBeNull()
    expect(store().ending).toBeNull()
  })
  it('조별 상대 순서는 cze→mex→rsa', () => {
    store().startCampaign(7)
    expect(store().currentOpponent()).toBe('cze'); win()
    expect(store().currentOpponent()).toBe('mex'); win()
    expect(store().currentOpponent()).toBe('rsa')
  })
})

describe('matchSeed 결정론', () => {
  it('seed*31 + matchIndex(진행 순 0부터)', () => {
    store().startCampaign(42)
    expect(store().matchSeed()).toBe(42 * 31 + 0)
    win()
    expect(store().matchSeed()).toBe(42 * 31 + 1)
    win()
    expect(store().matchSeed()).toBe(42 * 31 + 2)
  })
})

describe('전승 캠페인 → 1위 경로·우승', () => {
  it('조 전승이면 1위, 이후 상대는 ecu→eng→nor→arg→esp이며 우승', () => {
    store().startCampaign(1)
    win(2, 1) // vs cze
    win(1, 0) // vs mex
    win(1, 0) // vs rsa
    expect(store().groupRank).toBe(1)
    expect(store().path).toBe('first')
    expect(store().stage).toBe('r32')

    const seq: string[] = []
    for (const _ of ['r32', 'r16', 'qf', 'sf', 'final']) {
      seq.push(store().currentOpponent())
      win(2, 0)
    }
    expect(seq).toEqual(['ecu', 'eng', 'nor', 'arg', 'esp'])
    expect(store().stage).toBe('ended')
    expect(store().ending).toEqual({ reached: 'final', champion: true })
  })
})

describe('조별 1승2패(cze 승, mex·rsa 패) → 3위 탈락', () => {
  it('3위 이하이면 즉시 탈락 엔딩', () => {
    store().startCampaign(3)
    win(2, 1) // cze 승
    store().recordResult([0, 1], {}) // mex 패
    store().recordResult([0, 1], {}) // rsa 패
    expect(store().groupRank).toBe(3)
    expect(store().path).toBeNull()
    expect(store().stage).toBe('ended')
    expect(store().ending).toEqual({ reached: 'group3', champion: false })
  })
})

describe('조 2위 → can 경로', () => {
  it('2위이면 second 경로(can 시작)', () => {
    store().startCampaign(5)
    win(2, 0) // cze 승
    store().recordResult([0, 1], {}) // mex 패
    win(1, 0) // rsa 승
    expect(store().groupRank).toBe(2)
    expect(store().path).toBe('second')
    expect(store().stage).toBe('r32')
    expect(store().currentOpponent()).toBe('can')
  })
})

describe('토너먼트 무승부 shootout', () => {
  it('shootout 누락 시 throw', () => {
    store().startCampaign(9)
    win(1, 0); win(1, 0); win(1, 0) // 조 1위
    expect(store().stage).toBe('r32')
    expect(() => store().recordResult([1, 1], {})).toThrow()
  })
  it('shootout 승자로 판정: 승리 시 전진', () => {
    store().startCampaign(9)
    win(1, 0); win(1, 0); win(1, 0)
    store().recordResult([1, 1], {}, [4, 3]) // 승부차기 승
    expect(store().stage).toBe('r16')
    expect(store().ending).toBeNull()
  })
  it('shootout 패배 시 즉시 엔딩(reached=현 스테이지)', () => {
    store().startCampaign(9)
    win(1, 0); win(1, 0); win(1, 0)
    store().recordResult([1, 1], {}, [2, 4]) // 승부차기 패
    expect(store().stage).toBe('ended')
    expect(store().ending).toEqual({ reached: 'r32', champion: false })
  })
})

describe('토너먼트 정규시간 패배 → 즉시 엔딩', () => {
  it('r32 패배면 reached=r32', () => {
    store().startCampaign(9)
    win(1, 0); win(1, 0); win(1, 0)
    store().recordResult([0, 2], {})
    expect(store().stage).toBe('ended')
    expect(store().ending).toEqual({ reached: 'r32', champion: false })
  })
})

describe('체력 이월 70% 회복', () => {
  it('첫 경기는 100', () => {
    store().startCampaign(1)
    expect(store().startingStamina('p1')).toBe(100)
  })
  it('이월값 40 → 다음 시작 82 (40 + 60*0.7)', () => {
    store().startCampaign(1)
    store().recordResult([1, 0], { p1: 40 })
    expect(store().startingStamina('p1')).toBeCloseTo(82)
  })
  it('기록되지 않은 선수는 100', () => {
    store().startCampaign(1)
    store().recordResult([1, 0], { p1: 40 })
    expect(store().startingStamina('other')).toBe(100)
  })
})

describe('recordResult decisions 보존', () => {
  it('전달한 decisions가 MatchRecord에 저장된다', () => {
    store().startCampaign(1)
    const decisions = [
      { minute: 60, kind: 'instructions' as const, summary: "60' 지시 변경: 압박 55→90" },
      { minute: 45, kind: 'teamtalk' as const, summary: 'HT 팀토크: 격려' },
    ]
    store().recordResult([2, 0], {}, undefined, decisions)
    expect(store().records[0].decisions).toEqual(decisions)
  })
  it('decisions 미전달 시 빈 배열(기본값)', () => {
    store().startCampaign(1)
    store().recordResult([1, 0], {})
    expect(store().records[0].decisions).toEqual([])
  })
})

describe('lastTeamTalkTone (반복 감쇠)', () => {
  const talk = (tone: string) => [{ minute: 45, kind: 'teamtalk' as const, summary: `HT 팀토크: ${tone}`, detail: { tone } }]

  it('recordResult가 decisions의 HT 팀토크 톤을 캠페인에 저장한다', () => {
    store().startCampaign(1)
    expect(store().lastTeamTalkTone).toBeNull()
    store().recordResult([1, 0], {}, undefined, talk('rage'))
    expect(store().lastTeamTalkTone).toBe('rage')
  })
  it('팀토크 없는 경기는 직전 톤을 유지한다', () => {
    store().startCampaign(1)
    store().recordResult([1, 0], {}, undefined, talk('calm'))
    store().recordResult([1, 0], {}) // 팀토크 없음
    expect(store().lastTeamTalkTone).toBe('calm')
  })
  it('외침(kind:teamtalk·tone 없음)은 무시한다', () => {
    store().startCampaign(1)
    const shout = [{ minute: 60, kind: 'teamtalk' as const, summary: "60' 외침: 독려", detail: { shout: 'urge' } }]
    store().recordResult([1, 0], {}, undefined, shout)
    expect(store().lastTeamTalkTone).toBeNull()
  })
  it('reset은 lastTeamTalkTone도 초기화한다', () => {
    store().startCampaign(1)
    store().recordResult([1, 0], {}, undefined, talk('trust'))
    store().reset()
    expect(store().lastTeamTalkTone).toBeNull()
  })
})

describe('reset', () => {
  it('초기 상태로 되돌린다', () => {
    store().startCampaign(1)
    win(); win(); win()
    store().reset()
    expect(store().stage).toBe('group1')
    expect(store().records).toEqual([])
    expect(store().ending).toBeNull()
  })
})
