import { describe, it, expect } from 'vitest'
import {
  createMatch, simulateSegment, applyCommand, scoreMoraleShift,
  normalizeMorale, moraleDecaySteps, moraleDecayAmount, moraleFloor,
  MORALE_BASELINE, MORALE_FLOOR, MORALE_TOTAL_DECAY,
} from '../simulate'
import { makeTestTeam, pickBestXI } from '../fixtures/testTeams'
import { loadTeam } from '../../data/loader'

const strong = makeTestTeam('str', 88), weak = makeTestTeam('wea', 62)
const even1 = makeTestTeam('ev1', 78), even2 = makeTestTeam('ev2', 78)

describe('simulateSegment', () => {
  it('결정론: 같은 시드는 같은 결과', () => {
    const run = () => simulateSegment(createMatch(even1, even2, { seed: 123 }), 90)
    const a = run(), b = run()
    expect(a.score).toEqual(b.score)
    expect(a.events).toEqual(b.events)
    expect(a.stats).toEqual(b.stats)
  })
  it('다른 시드는 (대부분) 다른 이벤트 흐름', () => {
    const a = simulateSegment(createMatch(even1, even2, { seed: 1 }), 90)
    const b = simulateSegment(createMatch(even1, even2, { seed: 2 }), 90)
    expect(a.events).not.toEqual(b.events)
  })
  it('스코어는 현실적 범위 (100경기에서 팀당 0~8골)', () => {
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      expect(r.score[0]).toBeLessThanOrEqual(8)
      expect(r.score[1]).toBeLessThanOrEqual(8)
    }
  })
  it('강팀은 약팀에 100경기 중 60승 이상', () => {
    let wins = 0
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(strong, weak, { seed: s }), 90)
      if (r.score[0] > r.score[1]) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(60)
  })
  it('세그먼트 분할과 일괄 진행은 같은 결과 (45+45 = 90)', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 55 }), 90)
    let split = createMatch(even1, even2, { seed: 55 })
    split = simulateSegment(split, 45)
    split = simulateSegment(split, 90)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
  })
  it('체력은 경기 진행에 따라 감소', () => {
    const r = simulateSegment(createMatch(even1, even2, { seed: 9 }), 90)
    const anyStarter = r.home.tactics.lineup[5].playerId
    expect(r.home.staminaByPlayer[anyStarter]).toBeLessThan(85)
  })
})

describe('firstHalfScript (조별 실제 전반 재현)', () => {
  const script = {
    events: [
      { minute: 44, type: 'goal', teamId: even1.id, playerId: 'p_ev1_20', xg: 0.3 },
      { minute: 12, type: 'foul', teamId: even2.id, playerId: 'p_ev2_02' },
    ] as any,
    score: [1, 0] as [number, number],
  }

  it('simulateSegment(45)는 스크립트를 적용한다: score·events·minute 고정, 시뮬 이벤트 미발생', () => {
    const st = simulateSegment(createMatch(even1, even2, { seed: 7, firstHalfScript: script }), 45)
    expect(st.minute).toBe(45)
    expect(st.score).toEqual([1, 0])
    // 스크립트 이벤트가 분 순서로 포함
    expect(st.events.some(e => e.type === 'goal' && e.minute === 44)).toBe(true)
    expect(st.events.some(e => e.type === 'foul' && e.minute === 12)).toBe(true)
    // 이벤트는 kickoff + 스크립트(분순) + halftime 만 존재 (시뮬 shot/save/miss 등 없음)
    const types = st.events.map(e => e.type)
    expect(types).toEqual(['kickoff', 'foul', 'goal', 'halftime'])
    // stats: baseline 절반 근사 (xG = 골 수 × 0.35)
    expect(st.stats[0].xg).toBeCloseTo(0.35, 5)
    expect(st.stats[1].xg).toBe(0)
    expect(st.stats[0].shots).toBe(Math.round(even1.statBaseline.shotsPerGame * 0.5))
  })

  it('후반 결정론: 같은 시드·스크립트 → 같은 후반 결과', () => {
    const run = () => simulateSegment(createMatch(even1, even2, { seed: 42, firstHalfScript: script }), 90)
    const a = run(), b = run()
    expect(a.score).toEqual(b.score)
    expect(a.events).toEqual(b.events)
    expect(a.stats).toEqual(b.stats)
  })

  it('45 분할: (30→45)과 (직접 45)이 동일한 전반 결과', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 7, firstHalfScript: script }), 45)
    let split = createMatch(even1, even2, { seed: 7, firstHalfScript: script })
    split = simulateSegment(split, 30)
    expect(split.minute).toBe(30)
    expect(split.events.map(e => e.type)).toEqual(['kickoff']) // 30분 시점엔 스크립트 미적용
    split = simulateSegment(split, 45)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
    expect(split.stats).toEqual(whole.stats)
  })

  it('30→90 분할이 직접 90과 동일 (전·후반 통합 결정론)', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 99, firstHalfScript: script }), 90)
    let split = createMatch(even1, even2, { seed: 99, firstHalfScript: script })
    split = simulateSegment(split, 30)
    split = simulateSegment(split, 90)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
  })
})

describe('applyCommand', () => {
  it('교체: out 선수가 라인업에서 빠지고 in 선수가 들어온다', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    const out = st.home.tactics.lineup.find(l => l.slot === 'ST')!.playerId
    const benchIn = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id) && p.position === 'ST')!.id
    st = applyCommand(st, 'home', { type: 'sub', out, in: benchIn })
    expect(st.home.tactics.lineup.some(l => l.playerId === benchIn)).toBe(true)
    expect(st.home.tactics.lineup.some(l => l.playerId === out)).toBe(false)
    expect(st.home.subsUsed).toBe(1)
    expect(st.events.at(-1)).toMatchObject({ type: 'sub', teamId: even1.id })
  })
  it('교체 5회 초과는 에러', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    st = { ...st, home: { ...st.home, subsUsed: 5 } }
    const out = st.home.tactics.lineup[10].playerId
    const sub = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id))!.id
    expect(() => applyCommand(st, 'home', { type: 'sub', out, in: sub })).toThrow()
  })
  it('지시 변경이 이후 시뮬에 반영된다 (맹렬압박 → 파울 증가 경향, 50시드 평균)', () => {
    let foulsHigh = 0, foulsBase = 0
    for (let s = 0; s < 50; s++) {
      const base = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      let pressed = createMatch(even1, even2, { seed: s })
      pressed = applyCommand(pressed, 'home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 95, tempo: 50, attackFocus: 'balanced' } })
      const r = simulateSegment(pressed, 90)
      foulsHigh += r.stats[0].fouls; foulsBase += base.stats[0].fouls
    }
    expect(foulsHigh).toBeGreaterThan(foulsBase * 1.1)
  })
})

// ── 개입 부스트는 지시값과 무관하게 항상 유리해야 한다 ──────────────
// 구 설계 amp(v)=1+(v−1)×1.3은 지시가 중립이면 무효과였고, 저압박·저라인 플랜에서는
// 1.0 미만 편차까지 증폭해 오히려 손해였다(감사 실측: 스페인전 −3.0pp).
// 실팀 데이터로 두 결함을 회귀 고정한다.
describe('개입 부스트는 지시값과 무관하게 항상 유리하다', () => {
  it('중립 지시에서도 부스트가 득점을 늘린다', () => {
    const home = loadTeam('kor'), away = loadTeam('cze')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }
    let boosted = 0, plain = 0
    for (let s = 0; s < 120; s++) {
      let a = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      plain += a.score[0]
      let b = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      boosted += b.score[0]
    }
    expect(boosted).toBeGreaterThan(plain)
  }, 120_000)

  it('저압박·저라인 플랜에서도 부스트가 역효과를 내지 않는다', () => {
    const home = loadTeam('kor'), away = loadTeam('esp')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' }
    let bw = 0, pw = 0
    for (let s = 0; s < 150; s++) {
      let a = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      if (a.score[0] > a.score[1]) pw++
      let b = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      if (b.score[0] > b.score[1]) bw++
    }
    expect(bw).toBeGreaterThanOrEqual(pw)
  }, 150_000)
})

// ── 플랜 유지 보너스 / 구조 변경 적응 지연 (Task 7) ────────────────
// 킥오프 전 설계에 게임 이론적 의미를 주는 두 축이다. 유지에 보상, 구조 변경에 비용.
describe('planIntact / adaptLag', () => {
  it('opts 미지정이면 기존 결과와 비트 단위로 동일(회귀 불변)', () => {
    for (const seed of [11, 222, 3333]) {
      const a = simulateSegment(createMatch(even1, even2, { seed }), 90)
      const b = simulateSegment(createMatch(even1, even2, { seed }), 90, {})
      expect(b.score).toEqual(a.score)
      expect(b.stats).toEqual(a.stats)
    }
  })

  it('planIntact는 지정한 쪽의 xG를 올린다(찬스 퀄리티 ×1.03)', () => {
    let plain = 0, intact = 0
    for (let s = 0; s < 200; s++) {
      plain += simulateSegment(createMatch(even1, even2, { seed: 7000 + s }), 90).stats[0].xg
      intact += simulateSegment(createMatch(even1, even2, { seed: 7000 + s }), 90, { planIntact: 'home' }).stats[0].xg
    }
    expect(intact).toBeGreaterThan(plain)
  })

  it('adaptLag는 만료 분까지만 걸린다 — 만료 후 분에는 영향이 없다', () => {
    // 45분까지 이미 만료된 지연(until=3)은 46~90분 세그먼트 결과를 바꾸지 않아야 한다.
    const base = simulateSegment(createMatch(even1, even2, { seed: 4242 }), 45)
    const a = simulateSegment(base, 90)
    const b = simulateSegment(base, 90, { adaptLag: { side: 'home', until: 3 } })
    expect(b.score).toEqual(a.score)
    expect(b.stats).toEqual(a.stats)
  })

  it('adaptLag는 지정한 쪽의 슛 수를 줄인다(찬스 빈도 ×0.94)', () => {
    let plain = 0, lagged = 0
    for (let s = 0; s < 200; s++) {
      plain += simulateSegment(createMatch(even1, even2, { seed: 8000 + s }), 90).stats[0].shots
      lagged += simulateSegment(createMatch(even1, even2, { seed: 8000 + s }), 90, { adaptLag: { side: 'home', until: 90 } }).stats[0].shots
    }
    expect(lagged).toBeLessThan(plain)
  })
})

describe('교체 기회(IFAB Law 3: 경기당 3회)', () => {
  /** 라인업에 없는 벤치 선수를 순서대로 뽑는다(결정론 — Math.random 금지). */
  const benchIds = (st: ReturnType<typeof createMatch>, n: number) =>
    st.home.team.squad
      .filter(p => !st.home.tactics.lineup.some(l => l.playerId === p.id))
      .slice(0, n)
      .map(p => p.id)

  /** 지정 분으로 시계를 옮긴다(시뮬 없이) — 교체 기회 판정만 보려는 테스트용. */
  const at = (st: ReturnType<typeof createMatch>, minute: number) => ({ ...st, minute })

  it('서로 다른 분의 교체는 각각 기회를 소모하고, 4번째는 거부된다', () => {
    let st = at(createMatch(even1, even2, { seed: 3 }), 50)
    const ins = benchIds(st, 4)
    const outs = [0, 1, 2, 3].map(i => st.home.tactics.lineup[10 - i].playerId)
    for (let i = 0; i < 3; i++) {
      st = at(st, 50 + i * 5)
      st = applyCommand(st, 'home', { type: 'sub', out: outs[i], in: ins[i] })
      expect(st.home.subWindowsUsed).toBe(i + 1)
    }
    st = at(st, 70)
    expect(() => applyCommand(st, 'home', { type: 'sub', out: outs[3], in: ins[3] }))
      .toThrow('교체 기회(3회) 모두 사용')
    // 거부는 상태를 건드리지 않는다(반쪽 교체 금지).
    expect(st.home.subsUsed).toBe(3)
  })

  it('같은 분의 복수 교체는 한 번의 기회로 묶인다', () => {
    let st = at(createMatch(even1, even2, { seed: 3 }), 60)
    const ins = benchIds(st, 3)
    const outs = [0, 1, 2].map(i => st.home.tactics.lineup[10 - i].playerId)
    for (let i = 0; i < 3; i++) {
      st = applyCommand(st, 'home', { type: 'sub', out: outs[i], in: ins[i] })
    }
    expect(st.home.subsUsed).toBe(3)
    expect(st.home.subWindowsUsed).toBe(1)
  })

  it('하프타임(45분) 교체는 기회를 소모하지 않는다', () => {
    let st = at(createMatch(even1, even2, { seed: 3 }), 45)
    const ins = benchIds(st, 2)
    const outs = [0, 1].map(i => st.home.tactics.lineup[10 - i].playerId)
    st = applyCommand(st, 'home', { type: 'sub', out: outs[0], in: ins[0] })
    st = applyCommand(st, 'home', { type: 'sub', out: outs[1], in: ins[1] })
    expect(st.home.subsUsed).toBe(2)
    expect(st.home.subWindowsUsed ?? 0).toBe(0)
  })

  it('하프타임에 기회를 다 쓴 상태여도 하프타임 교체는 통과한다', () => {
    let st = at(createMatch(even1, even2, { seed: 3 }), 45)
    st = { ...st, home: { ...st.home, subWindowsUsed: 3 } }
    const [inId] = benchIds(st, 1)
    const out = st.home.tactics.lineup[10].playerId
    st = applyCommand(st, 'home', { type: 'sub', out, in: inId })
    expect(st.home.subsUsed).toBe(1)
    expect(st.home.subWindowsUsed).toBe(3)
  })

  it('하프타임 교체 직후 46분 교체는 새 기회를 연다', () => {
    let st = at(createMatch(even1, even2, { seed: 3 }), 45)
    const ins = benchIds(st, 2)
    const outs = [0, 1].map(i => st.home.tactics.lineup[10 - i].playerId)
    st = applyCommand(st, 'home', { type: 'sub', out: outs[0], in: ins[0] })
    st = at(st, 46)
    st = applyCommand(st, 'home', { type: 'sub', out: outs[1], in: ins[1] })
    expect(st.home.subWindowsUsed).toBe(1)
  })
})

// 감사 결함 ④: 골키퍼가 필드 플레이어와 같은 비율로 지쳐, 스태미나 능력치가 팀 최저인 GK가
// 매 경기·매 시점 "가장 지친 선수" 1위로 고정됐다. 포지션 부하를 넣어 그 고정을 푼다.
describe('포지션별 체력 소모 (GK는 필드 플레이어만큼 뛰지 않는다)', () => {
  it('90분 뒤 GK 체력이 모든 필드 플레이어보다 높다', () => {
    const kor = loadTeam('kor')
    const st = simulateSegment(createMatch(kor, loadTeam('cze'), { seed: 4242 }), 90)
    const byId = (id: string) => st.home.staminaByPlayer[id]
    const gkId = st.home.tactics.lineup.find(l => l.slot === 'GK')!.playerId
    const field = st.home.tactics.lineup.filter(l => l.slot !== 'GK').map(l => byId(l.playerId))
    expect(byId(gkId)).toBeGreaterThan(Math.max(...field))
  })

  it('중앙 미드필더가 센터백보다 더 지친다(주행거리 차)', () => {
    const kor = loadTeam('kor')
    const st = simulateSegment(createMatch(kor, loadTeam('cze'), { seed: 4242 }), 90)
    const slotAvg = (slots: string[]) => {
      const v = st.home.tactics.lineup
        .filter(l => slots.includes(l.slot))
        .map(l => st.home.staminaByPlayer[l.playerId])
      return v.reduce((a, b) => a + b, 0) / v.length
    }
    expect(slotAvg(['CM', 'DM'])).toBeLessThan(slotAvg(['CB']))
  })
})

// 감사 결함 ⑤: 1-2로 뒤진 하프타임에도 팀토크 헤더가 "차분하게 준비돼 있습니다 · 사기 70"이었다.
describe('scoreMoraleShift — 라커룸 표시 사기는 스코어를 안다', () => {
  it('동점이면 0, 뒤지면 음수, 앞서면 양수', () => {
    expect(scoreMoraleShift(1, 1)).toBe(0)
    expect(scoreMoraleShift(1, 2)).toBeLessThan(0)
    expect(scoreMoraleShift(2, 1)).toBeGreaterThan(0)
  })
  it('골차 2를 넘으면 더 움직이지 않는다(라커룸 공기는 이미 정해졌다)', () => {
    expect(scoreMoraleShift(5, 0)).toBe(scoreMoraleShift(2, 0))
    expect(scoreMoraleShift(0, 5)).toBe(scoreMoraleShift(0, 2))
  })
  it('따라잡으면 변위가 정확히 되돌아온다', () => {
    expect(scoreMoraleShift(1, 1)).toBe(0)
  })
  // ★ 전력 경로(zoneStrength)에는 태우지 않는다 — momentum이 이미 같은 일을 한다.
  //   태웠더니 esp-arg 슛이 +27%가 되어 실팀 캘리브레이션(±25%)이 깨졌다.
  // 감쇠(applyMoraleDecay) 도입 후: 득점에 관여하지 않은 선수의 사기는 **하한 50까지 내려간다**.
  // 90분 풀타임이면 감쇠 총량이 정확히 20이라 70 → 50이다.
  it('득점자·도움만 개인 사기가 오르고 팀 전체 사기는 스코어로 움직이지 않는다', () => {
    const kor = loadTeam('kor')
    const st = simulateSegment(createMatch(kor, loadTeam('rsa'), { seed: 909 }), 90)
    const scorers = new Set(
      st.events.filter(e => e.type === 'goal' && e.teamId === kor.id).flatMap(e => [e.playerId, e.assistId]),
    )
    for (const l of st.home.tactics.lineup) {
      if (scorers.has(l.playerId)) continue
      const m = st.home.moraleByPlayer[l.playerId]
      expect(m).toBeLessThanOrEqual(70)
      expect(m).toBeGreaterThanOrEqual(moraleFloor(st.home.staminaByPlayer[l.playerId]))
    }
  })
})

// ── 감사 결함 ③④: 사기가 올라가기만 하고, 소수로 샜다 ─────────────
describe('사기 감쇠 — 단조 감소', () => {
  it('개입이 없으면 올랐던 사기가 90분에 걸쳐 식는다', () => {
    const kor = loadTeam('kor')
    const base = createMatch(kor, loadTeam('rsa'), { seed: 4242 })
    // 팀토크로 전원 +10을 준 직후 상태를 흉내낸다(하프타임 최대치 근처).
    for (const id of Object.keys(base.home.moraleByPlayer)) base.home.moraleByPlayer[id] = 80
    const st = simulateSegment(base, 90)
    const on = st.home.tactics.lineup.map(l => st.home.moraleByPlayer[l.playerId])
    // 90분 감쇠 총량이 20(체력이 남은 선수 기준)이므로 80은 60 이하로 내려간다. 득점·도움
    // (+3/+2)이 붙은 선수만 조금 높게 끝나므로 상한은 63으로 둔다(80에서 반드시 내려왔다는 판정).
    for (const m of on) expect(m).toBeLessThanOrEqual(63)
    // 🔥 문턱(80)에 걸린 채로 끝나는 선수가 없다 — 결함 ③의 판정 기준.
    expect(on.filter(m => m >= 80)).toHaveLength(0)
  })

  // ★ 계약이 뒤집힌 자리다. 예전 제목은 "가라앉은 사기는 시간이 약이다(회귀는 양방향)"였고,
  //   목표(70)보다 낮은 사기가 시간만으로 **올라가는** 것을 검증했다. 사용자의 요구가
  //   "사기는 시간 경과에 따라 조금씩 계속 내려가는 시스템"이므로 그 회복 경로는 사라졌다.
  //   테스트를 지우지 않고 반대 방향으로 고쳐 둔다 — 언젠가 회귀를 다시 넣고 싶어지면
  //   여기가 먼저 빨개져서 "그건 이미 한 번 되돌린 결정"이라는 걸 알려 준다.
  it('가라앉은 사기는 시간이 지나도 저절로 회복되지 않는다', () => {
    const kor = loadTeam('kor')
    const base = createMatch(kor, loadTeam('rsa'), { seed: 4242 })
    for (const id of Object.keys(base.home.moraleByPlayer)) base.home.moraleByPlayer[id] = 40
    const st = simulateSegment(base, 90)
    const scorers = new Set(
      st.events.filter(e => e.type === 'goal' && e.teamId === kor.id).flatMap(e => [e.playerId, e.assistId]),
    )
    for (const l of st.home.tactics.lineup) {
      if (scorers.has(l.playerId)) continue // 득점·도움은 감독의 레버가 아닌 경기 사건이라 올려도 된다
      // 하한(50)보다 낮게 시작한 선수는 하한까지 **끌어올려지지도** 않는다.
      expect(st.home.moraleByPlayer[l.playerId]).toBe(40)
    }
  })

  // 새 회귀 테스트: 시간 경과는 **오직 내리는 방향으로만** 작동한다.
  it('시간만으로는 어느 선수의 사기도 시작값을 넘지 않는다', () => {
    const kor = loadTeam('kor')
    const base = createMatch(kor, loadTeam('rsa'), { seed: 909 })
    const before = { ...base.home.moraleByPlayer }
    const st = simulateSegment(base, 90)
    const scorers = new Set(
      st.events.filter(e => e.type === 'goal' && e.teamId === kor.id).flatMap(e => [e.playerId, e.assistId]),
    )
    for (const l of st.home.tactics.lineup) {
      if (scorers.has(l.playerId)) continue
      expect(st.home.moraleByPlayer[l.playerId]).toBeLessThanOrEqual(before[l.playerId])
    }
  })

  it('개입이 없으면 90분에 정확히 20 내려간다 — 70에서 출발해 하한 50에 닿는다', () => {
    expect(moraleDecaySteps(0)).toBe(0)
    expect(moraleDecaySteps(45)).toBe(MORALE_TOTAL_DECAY / 2)
    expect(moraleDecaySteps(90)).toBe(MORALE_TOTAL_DECAY)
    expect(MORALE_BASELINE - MORALE_TOTAL_DECAY).toBe(MORALE_FLOOR)
    // 누적 스텝은 단조 증가하고 한 분에 2 이상 뛰지 않는다(정수 계약을 유지하는 근거).
    for (let m = 1; m <= 120; m++) {
      const d = moraleDecaySteps(m) - moraleDecaySteps(m - 1)
      expect(d === 0 || d === 1).toBe(true)
    }
  })

  // 사용자 지시: "지치면 사기가 더 빨리 떨어지고, 체력이 50 미만이면 하한선 밑으로도
  // 떨어질 수 있게". 하한 50은 **체력이 남은 선수의** 하한이다.
  it('체력이 임계 아래면 감쇠가 2배로 빨라진다', () => {
    expect(moraleDecayAmount(100)).toBe(1)
    expect(moraleDecayAmount(50)).toBe(1)
    expect(moraleDecayAmount(49)).toBe(2)
    expect(moraleDecayAmount(0)).toBe(2)
  })

  it('체력 50 미만이면 하한이 50 밑으로 내려간다 — 절대 하한은 40', () => {
    expect(moraleFloor(100)).toBe(MORALE_FLOOR)
    expect(moraleFloor(50)).toBe(MORALE_FLOOR)
    expect(moraleFloor(46)).toBe(MORALE_FLOOR - 1)
    expect(moraleFloor(30)).toBe(MORALE_FLOOR - 5)
    expect(moraleFloor(10)).toBe(MORALE_FLOOR - 10)
    expect(moraleFloor(0)).toBe(MORALE_FLOOR - 10) // 40에서 멈춘다(밸런스 근거는 주석)
  })

  it('어떤 선수도 자기 체력이 정한 하한 아래로는 내려가지 않는다', () => {
    const kor = loadTeam('kor')
    const base = createMatch(kor, loadTeam('rsa'), { seed: 4242 })
    for (const id of Object.keys(base.home.moraleByPlayer)) base.home.moraleByPlayer[id] = 55
    const st = simulateSegment(base, 90)
    for (const l of st.home.tactics.lineup) {
      const m = st.home.moraleByPlayer[l.playerId]
      expect(m).toBeGreaterThanOrEqual(moraleFloor(st.home.staminaByPlayer[l.playerId]))
      expect(m).toBeGreaterThanOrEqual(MORALE_FLOOR - 10) // 절대 하한 40
    }
  })

  it('벤치는 감쇠하지 않는다 — 뛰지 않은 선수가 시간만으로 식을 이유가 없다', () => {
    const kor = loadTeam('kor')
    const base = createMatch(kor, loadTeam('rsa'), { seed: 4242 })
    const onIds = new Set(base.home.tactics.lineup.map(l => l.playerId))
    for (const id of Object.keys(base.home.moraleByPlayer)) base.home.moraleByPlayer[id] = 85
    const st = simulateSegment(base, 90)
    for (const id of Object.keys(st.home.moraleByPlayer)) {
      if (onIds.has(id)) continue
      expect(st.home.moraleByPlayer[id]).toBe(85)
    }
  })

  // ★ 뒤집힌 계약: 예전엔 "체력이 바닥나면 **회귀 목표**가 기준선 아래로 내려간다"(moraleTarget)였다.
  //   회귀가 사라지면서 목표라는 개념도 사라졌고, 체력은 이제 감쇠의 **속도와 하한**을 움직인다
  //   (바로 위 두 테스트). 같은 의도("지치면 가라앉는다")를 단조 감소 위에서 다시 표현한 것이다.
})

describe('사기 정수화 규약', () => {
  it('normalizeMorale은 정수로 자르고 0~100으로 가둔다', () => {
    expect(normalizeMorale(74.999999999999)).toBe(75)
    expect(normalizeMorale(70.3)).toBe(70)
    expect(normalizeMorale(-5)).toBe(0)
    expect(normalizeMorale(140)).toBe(100)
  })

  it('90분 시뮬 후 저장된 사기가 전부 정수다 — 소수로 새는 경로가 없다', () => {
    const st = simulateSegment(createMatch(loadTeam('kor'), loadTeam('rsa'), { seed: 909 }), 90)
    for (const side of [st.home, st.away]) {
      for (const v of Object.values(side.moraleByPlayer)) expect(Number.isInteger(v)).toBe(true)
    }
  })
})
