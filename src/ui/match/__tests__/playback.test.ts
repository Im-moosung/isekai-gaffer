import { describe, it, expect } from 'vitest'
import type { MatchEvent, MatchEventType } from '../../../engine/types'
import {
  minuteDwellMs,
  minuteDwellWithSpeech,
  minuteSpeechMs,
  pickDramaEvent,
  isImportantEvent,
  DRAMA_PRIORITY,
  MAX_DWELL_MS,
  EVENT_DWELL_MS,
  NO_EVENT_DWELL_MS,
  CLUTCH_MULTIPLIER,
  BLOWOUT_DIFF,
  BLOWOUT_MULTIPLIER,
} from '../playback'
import { createMatch, simulateSegment } from '../../../engine/simulate'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { commentateAt } from '../../../game/commentary'
import { casterRole, estimatePairMs, estimateSpeechMs } from '../../../audio/commentary-tts'
import { buildSequence } from '../../pitch/choreography'
import { SCENE_DWELL_MS } from '../../pitch/scenes'
import { FLOW_DWELL_MS } from '../../pitch/flow'

/** dwell 상수의 정본은 scenes.SCENE_DWELL_MS다 — 테스트도 리터럴 대신 상수를 참조한다.
 *  (장면 소요가 실제 볼 속도에서 역산되므로 리터럴을 박으면 저술을 손댈 때마다 깨진다.) */
const GOAL_DWELL = EVENT_DWELL_MS.goal!
const SHOT_DWELL = EVENT_DWELL_MS.shot!
const FOUL_DWELL = EVENT_DWELL_MS.foul!

// 테스트용 이벤트(분/타입만 유효하면 됨).
function ev(type: MatchEventType, minute = 10): MatchEvent {
  return { minute, type, teamId: 'kor' }
}

describe('minuteDwellMs — 이벤트별 수치', () => {
  it('goal이 가장 오래 머문다', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1, false)).toBe(GOAL_DWELL)
  })
  it('shot·save·miss는 동일 dwell', () => {
    expect(minuteDwellMs(10, [ev('shot')], 1, false)).toBe(SHOT_DWELL)
    expect(minuteDwellMs(10, [ev('save')], 1, false)).toBe(SHOT_DWELL)
    expect(minuteDwellMs(10, [ev('miss')], 1, false)).toBe(SHOT_DWELL)
  })
  it('foul·corner는 세트피스 dwell(파울 < 코너 — 코너는 안무가 더 길다)', () => {
    expect(minuteDwellMs(10, [ev('foul')], 1, false)).toBe(FOUL_DWELL)
    expect(minuteDwellMs(10, [ev('corner')], 1, false)).toBe(EVENT_DWELL_MS.corner!)
  })
  it('무사건 분은 무사건 dwell', () => {
    expect(minuteDwellMs(10, [], 1, false)).toBe(NO_EVENT_DWELL_MS)
  })
  it('목록에 없는 이벤트(kickoff·yellow)만 있으면 무사건과 동일', () => {
    expect(minuteDwellMs(10, [ev('kickoff'), ev('yellow')], 1, false)).toBe(NO_EVENT_DWELL_MS)
  })
  it('여러 이벤트가 겹치면 최고 가중을 채택(골+파울 → 골)', () => {
    expect(minuteDwellMs(10, [ev('foul'), ev('goal'), ev('corner')], 1, false)).toBe(GOAL_DWELL)
  })
  it('드라마 순서: goal > shot > foul > 무사건', () => {
    const g = minuteDwellMs(10, [ev('goal')], 1, false)
    const s = minuteDwellMs(10, [ev('shot')], 1, false)
    const f = minuteDwellMs(10, [ev('foul')], 1, false)
    const n = minuteDwellMs(10, [], 1, false)
    expect(g).toBeGreaterThan(s)
    expect(s).toBeGreaterThan(f)
    expect(f).toBeGreaterThan(n)
  })
})

describe('minuteDwellMs — speed 나눗셈', () => {
  it('1.5x는 dwell을 1.5로 나눈다', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1.5, false)).toBe(Math.round(GOAL_DWELL / 1.5))
    expect(minuteDwellMs(10, [], 1.5, false)).toBe(Math.round(NO_EVENT_DWELL_MS / 1.5))
  })
  it('2x는 dwell을 절반으로', () => {
    expect(minuteDwellMs(10, [ev('goal')], 2, false)).toBe(Math.round(GOAL_DWELL / 2))
    expect(minuteDwellMs(10, [ev('shot')], 2, false)).toBe(Math.round(SHOT_DWELL / 2))
  })
  it('속도가 빠를수록 dwell이 짧다', () => {
    const a = minuteDwellMs(10, [ev('goal')], 1, false)
    const b = minuteDwellMs(10, [ev('goal')], 1.5, false)
    const c = minuteDwellMs(10, [ev('goal')], 2, false)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
})

describe('minuteDwellMs — clutch 배수', () => {
  it('clutch면 무사건 dwell이 ×2', () => {
    expect(minuteDwellMs(85, [], 1, true)).toBe(NO_EVENT_DWELL_MS * CLUTCH_MULTIPLIER)
  })
  it('clutch는 이벤트 분에는 영향 없음(이미 충분히 김)', () => {
    expect(minuteDwellMs(85, [ev('goal', 85)], 1, true)).toBe(GOAL_DWELL)
    expect(minuteDwellMs(85, [ev('foul', 85)], 1, true)).toBe(FOUL_DWELL)
  })
  it('clutch + speed 동시 적용', () => {
    expect(minuteDwellMs(85, [], 2, true)).toBe(Math.round((NO_EVENT_DWELL_MS * 2) / 2))
  })
})

describe('minuteDwellMs — 블로우아웃 가속(scoreDiff)', () => {
  it('scoreDiff 기본(0)은 가속 미적용 — 기존 계약 유지', () => {
    expect(minuteDwellMs(50, [ev('goal')], 1, false)).toBe(GOAL_DWELL)
    expect(minuteDwellMs(50, [ev('goal')], 1, false, 0)).toBe(GOAL_DWELL)
  })
  it('scoreDiff가 임계 미만(≤2)이면 가속 없음', () => {
    expect(minuteDwellMs(50, [ev('goal')], 1, false, 2)).toBe(GOAL_DWELL)
  })
  it('scoreDiff ≥ BLOWOUT_DIFF(3)이면 이벤트 dwell ×0.6', () => {
    expect(minuteDwellMs(50, [ev('goal')], 1, false, BLOWOUT_DIFF))
      .toBe(Math.round(GOAL_DWELL * BLOWOUT_MULTIPLIER))
    expect(minuteDwellMs(50, [ev('shot')], 1, false, 4))
      .toBe(Math.round(SHOT_DWELL * BLOWOUT_MULTIPLIER))
  })
  it('블로우아웃은 무사건 dwell도 압축', () => {
    expect(minuteDwellMs(50, [], 1, false, 5))
      .toBe(Math.round(NO_EVENT_DWELL_MS * BLOWOUT_MULTIPLIER))
  })
  it('블로우아웃 + speed 동시 적용', () => {
    expect(minuteDwellMs(50, [ev('goal')], 2, false, 3))
      .toBe(Math.round((GOAL_DWELL * BLOWOUT_MULTIPLIER) / 2))
  })
  it('블로우아웃이면 같은 이벤트라도 더 짧다', () => {
    const normal = minuteDwellMs(50, [ev('goal')], 1, false, 1)
    const blowout = minuteDwellMs(50, [ev('goal')], 1, false, 3)
    expect(blowout).toBeLessThan(normal)
  })
})

// ── 1x 총합 검증 ─────────────────────────────────────────────────────────
// ★ 2026-07-30 재캘리브레이션: [180k, 300k] → [200k, 380k].
//   하이라이트 장면의 소요가 **실제 볼 속도에서 역산**되면서(슛 25 · 크로스 20 · 패스
//   15 · 지면 13 m/s + 컨트롤 정지 380 ms) 장면 하나가 6~7초가 됐다. 예전 4.3초는 그
//   안에 20 m 패스 3번과 슛을 밀어 넣어 공이 22~25 m/s로 날아가던 값이다.
//   무사건 분을 1800 → 1100으로 더 과감히 넘겨 상쇄했지만, 실엔진 12시드 실측 총합은
//   236~354초(평균 288초)로 올라갔다. 사용자가 "시간보다 완성도"를 명시했고 2x 토글이
//   있으므로 게이트를 그 실측에 여유를 두어 다시 잡는다.
// 합성 이벤트 분포 3종(sparse/medium/dense)으로 상수 캘리브레이션을 고정한다.
// 각 이벤트를 서로 다른 분에 배치(분당 최대 1개) → 나머지는 무사건 분.
function distribution(spec: Partial<Record<MatchEventType, number>>): MatchEvent[] {
  const events: MatchEvent[] = []
  let minute = 2
  for (const [type, count] of Object.entries(spec)) {
    for (let i = 0; i < (count ?? 0); i++) {
      events.push(ev(type as MatchEventType, minute))
      minute += 1
    }
  }
  return events
}

// 무사건 분은 clutch=false로 계산(기본 페이스 캘리브레이션 검증).
function total1x(events: MatchEvent[]): number {
  let sum = 0
  for (let m = 1; m <= 90; m++) {
    const atMinute = events.filter(e => e.minute === m)
    sum += minuteDwellMs(m, atMinute, 1, false)
  }
  return sum
}

describe('minuteDwellMs — 1x 90분 총합 범위(200k~380k)', () => {
  const cases: { name: string; events: MatchEvent[] }[] = [
    { name: 'sparse(25 이벤트)', events: distribution({ goal: 2, save: 6, miss: 5, corner: 4, foul: 8 }) },
    { name: 'medium(33 이벤트)', events: distribution({ goal: 3, save: 9, miss: 8, corner: 6, foul: 7 }) },
    { name: 'dense(40 이벤트)', events: distribution({ goal: 4, save: 12, miss: 11, corner: 9, foul: 4 }) },
  ]
  for (const { name, events } of cases) {
    it(`${name} → 총합이 200,000~380,000ms`, () => {
      const total = total1x(events)
      expect(total).toBeGreaterThanOrEqual(200_000)
      expect(total).toBeLessThanOrEqual(380_000)
    })
  }

  it('EVENT_DWELL_MS 상수가 노출되어 있다(회귀 고정)', () => {
    // ★ 값의 정본은 scenes.SCENE_DWELL_MS다(장면 소요에서 역산). 여기서는 재수출만 고정한다.
    expect(EVENT_DWELL_MS.goal).toBe(SCENE_DWELL_MS.goal)
    expect(EVENT_DWELL_MS.save).toBe(SCENE_DWELL_MS.save)
    expect(EVENT_DWELL_MS.corner).toBe(SCENE_DWELL_MS.corner)
    expect(NO_EVENT_DWELL_MS).toBe(FLOW_DWELL_MS)
  })
})

// ── 실엔진 회귀 가드 ──────────────────────────────────────
// 합성 분포(25~40 이벤트)만으론 상한 여유가 얇다 — 실엔진은 유의미 이벤트가 ~2배라
// 상수 변경 시 실경기가 300k를 넘겨도 합성 테스트는 못 잡는다. 실제 full-match를
// 여러 시드로 시뮬해 실경기 총합이 [180k, 300k]에 있는지 직접 어서션한다(클러치 포함).
describe('minuteDwellMs — 실엔진 90분 총합 가드(12시드)', () => {
  const home = makeTestTeam('kor', 76)
  const away = makeTestTeam('esp', 88)

  // 재생 루프(MatchScreen)와 동일한 방식으로 1x 총합을 계산: 분별 이벤트 + 클러치 판정.
  function realTotal1x(seed: number): number {
    const final = simulateSegment(createMatch(home, away, { seed }), 90)
    let sum = 0
    for (let m = 1; m <= 90; m++) {
      const atMinute = final.events.filter(e => e.minute === m)
      const clutch = m >= 80 && Math.abs(final.score[0] - final.score[1]) <= 1
      sum += minuteDwellMs(m, atMinute, 1, clutch)
    }
    return sum
  }

  for (let seed = 1000; seed <= 1011; seed++) {
    it(`seed=${seed} → 실경기 총합이 200,000~380,000ms`, () => {
      const total = realTotal1x(seed)
      expect(total).toBeGreaterThanOrEqual(200_000)
      expect(total).toBeLessThanOrEqual(380_000)
    })
  }
})

// ─────────────────────────────────────────────────────────────
// 주인공 이벤트 선택자 — 음성·안무가 공유하는 단일 규칙
// ─────────────────────────────────────────────────────────────
describe('pickDramaEvent — 우선순위와 결정론', () => {
  it('결과(goal>save>miss) > 시도(shot>chance) > 징계(red>yellow) > 코너 > 파울', () => {
    expect(pickDramaEvent([ev('foul'), ev('corner'), ev('goal')])?.type).toBe('goal')
    expect(pickDramaEvent([ev('miss'), ev('save')])?.type).toBe('save')
    expect(pickDramaEvent([ev('corner'), ev('miss')])?.type).toBe('miss')
    expect(pickDramaEvent([ev('chance'), ev('shot')])?.type).toBe('shot')
    expect(pickDramaEvent([ev('corner'), ev('chance')])?.type).toBe('chance')
    expect(pickDramaEvent([ev('yellow'), ev('red')])?.type).toBe('red')
    expect(pickDramaEvent([ev('foul'), ev('yellow')])?.type).toBe('yellow')
    expect(pickDramaEvent([ev('foul'), ev('corner')])?.type).toBe('corner')
    expect(pickDramaEvent([ev('foul')])?.type).toBe('foul')
  })

  it('안무 없는 타입(kickoff·sub·halftime·fulltime)만 있으면 null', () => {
    expect(pickDramaEvent([ev('kickoff'), ev('sub')])).toBeNull()
    expect(pickDramaEvent([ev('halftime'), ev('fulltime')])).toBeNull()
    expect(pickDramaEvent([])).toBeNull()
  })

  it('안무 없는 타입이 섞여 있어도 안무 가능한 이벤트를 고른다(halftime+goal → goal)', () => {
    expect(pickDramaEvent([ev('halftime'), ev('goal')])?.type).toBe('goal')
    expect(pickDramaEvent([ev('foul'), ev('fulltime')])?.type).toBe('foul')
  })

  it('결정론 — 같은 배열은 항상 같은 선택, 배열 순서를 바꿔도 규칙이 이긴다', () => {
    const a = [ev('corner'), ev('foul'), ev('save')]
    const b = [ev('save'), ev('corner'), ev('foul')]
    expect(pickDramaEvent(a)).toBe(a[2])
    expect(pickDramaEvent(a)).toBe(pickDramaEvent(a))
    expect(pickDramaEvent(b)?.type).toBe(pickDramaEvent(a)?.type)
  })

  it('같은 타입이 둘이면 배열 앞쪽(먼저 발생)을 택한다', () => {
    const first = ev('goal')
    const second = ev('goal')
    expect(pickDramaEvent([first, second])).toBe(first)
  })

  it('important는 goal·save만(강조 발화 대상)', () => {
    expect(isImportantEvent(ev('goal'))).toBe(true)
    expect(isImportantEvent(ev('save'))).toBe(true)
    expect(isImportantEvent(ev('miss'))).toBe(false)
    expect(isImportantEvent(ev('corner'))).toBe(false)
  })
})

// ★ 이 작업(Phase B-1)의 핵심 계약: 말한 것과 그린 것이 같다.
// 예전엔 음성은 commentary-tts.SPOKEN_PRIORITY, 안무는 EVENT_DWELL_MS 최댓값으로
// 서로 다르게 골랐다. 이제 두 계층 모두 pickDramaEvent 하나만 쓴다.
describe('R2 계약 — 음성이 고른 이벤트 === 안무가 고른 이벤트', () => {
  const dramaTypes = [...DRAMA_PRIORITY]
  const noise: MatchEventType[] = ['kickoff', 'sub', 'halftime', 'fulltime']

  it('모든 2종 조합(+무안무 노이즈)에서 두 계층의 선택이 동일하다', () => {
    let combos = 0
    for (const a of dramaTypes) {
      for (const b of dramaTypes) {
        for (const n of noise) {
          const events = [ev(a, 33), ev(b, 33), ev(n, 33)]
          // 음성 계층(MatchScreen TTS 효과)과 안무 계층(highlight useMemo)이 부르는 함수.
          const voice = pickDramaEvent(events)
          const choreo = pickDramaEvent(events)
          expect(voice).not.toBeNull()
          expect(voice).toBe(choreo) // 동일 객체 — 다른 이벤트를 고를 여지가 없다
          combos++
        }
      }
    }
    expect(combos).toBe(dramaTypes.length * dramaTypes.length * noise.length)
  })

  it('주인공으로 뽑힐 수 있는 모든 타입은 안무가 있다(빈 시퀀스 금지)', () => {
    const st = createMatch(makeTestTeam('kor', 76), makeTestTeam('esp', 88), { seed: 5 })
    for (const t of DRAMA_PRIORITY) {
      const seq = buildSequence({ minute: 30, type: t, teamId: 'kor' }, st.home, st.away)
      expect(seq.length, `${t}에 안무가 없다`).toBeGreaterThanOrEqual(2)
    }
  })

  it('안무가 있는 타입은 모두 후보 목록에 있다(역방향 — 목록 누락 금지)', () => {
    const st = createMatch(makeTestTeam('kor', 76), makeTestTeam('esp', 88), { seed: 5 })
    const all: MatchEventType[] = [
      'kickoff', 'chance', 'shot', 'goal', 'save', 'miss',
      'foul', 'yellow', 'red', 'corner', 'sub', 'halftime', 'fulltime',
    ]
    for (const t of all) {
      const hasChoreo = buildSequence({ minute: 30, type: t, teamId: 'kor' }, st.home, st.away).length > 0
      expect(hasChoreo, `${t}: 안무 유무와 후보 목록이 어긋난다`).toBe(DRAMA_PRIORITY.includes(t))
    }
  })

  it('실엔진 12시드 전 분: 주인공이 있으면 안무가 반드시 나온다', () => {
    const h = makeTestTeam('kor', 76)
    const a = makeTestTeam('esp', 88)
    let picked = 0
    for (let seed = 1000; seed <= 1011; seed++) {
      const st = createMatch(h, a, { seed })
      const final = simulateSegment(st, 90)
      for (let m = 1; m <= 90; m++) {
        const atMinute = final.events.filter(e => e.minute === m)
        const drama = pickDramaEvent(atMinute)
        if (!drama) continue
        picked++
        expect(atMinute).toContain(drama)
        expect(buildSequence(drama, final.home, final.away).length).toBeGreaterThanOrEqual(2)
      }
    }
    expect(picked).toBeGreaterThan(200) // 실경기에서 충분히 자주 발동한다
  })
})

// ─────────────────────────────────────────────────────────────
// 발화 길이 ↔ 체류 시간 정합(R3)
// ─────────────────────────────────────────────────────────────
describe('minuteDwellMs — 발화 길이 하한(speechMs)', () => {
  it('speechMs 미지정은 기존 동작 그대로', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1, false, 0)).toBe(GOAL_DWELL)
    expect(minuteDwellMs(10, [ev('goal')], 1, false, 0, 0)).toBe(GOAL_DWELL)
  })
  it('리듬 dwell이 발화보다 길면 리듬이 이긴다', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1, false, 0, 2000)).toBe(GOAL_DWELL)
  })
  it('리듬 dwell이 발화보다 짧으면 발화 길이까지 늘린다(말 잘림 방지)', () => {
    expect(minuteDwellMs(10, [ev('foul')], 2, false, 0, 2500)).toBe(2500)
  })
  it('발화 하한은 speed로 나눈 뒤 적용된다 — TTS는 재생 속도를 따르지 않는다', () => {
    // 2x에서 리듬은 절반이 되지만 발화 길이는 그대로다.
    expect(minuteDwellMs(10, [ev('goal')], 2, false, 0, 4000)).toBe(Math.round(GOAL_DWELL / 2))
    expect(minuteDwellMs(10, [ev('goal')], 1, false, 0, 4000)).toBe(GOAL_DWELL)
  })
  it('상한 MAX_DWELL_MS를 넘지 않는다(긴 문장이 화면을 붙잡지 못한다)', () => {
    expect(minuteDwellMs(10, [ev('goal')], 1, false, 0, 60_000)).toBe(MAX_DWELL_MS)
  })
})

describe('minuteSpeechMs / minuteDwellWithSpeech', () => {
  const h = makeTestTeam('kor', 76)
  const a = makeTestTeam('esp', 88)

  it('주인공이 없으면 0(무사건 분은 보정 없음)', () => {
    expect(minuteSpeechMs([], h, a)).toBe(0)
    expect(minuteSpeechMs([ev('kickoff')], h, a)).toBe(0)
  })

  it('주인공 문장의 추정 길이와 정확히 일치한다(같은 선택자·같은 문장)', () => {
    const events = [ev('foul', 40), ev('save', 40), ev('corner', 40)]
    const drama = pickDramaEvent(events)!
    expect(drama.type).toBe('save')
    // Phase C 4단계: 한 이벤트의 발화는 캐스터 + (있으면) 해설위원 둘이다.
    const line = commentateAt(events, events.indexOf(drama), h, a)
    expect(minuteSpeechMs(events, h, a))
      .toBe(estimatePairMs(line.speech, casterRole(true, line.intensity), line.follow?.speech))
  })

  it('해설이 붙은 이벤트는 캐스터만 있을 때보다 체류 하한이 길다(화자 2인 보정)', () => {
    // 골은 해설이 항상 붙는다 — 두 화자의 발화를 합쳐야 말이 잘리지 않는다.
    const events = [ev('goal', 40)]
    const line = commentateAt(events, 0, h, a)
    expect(line.follow).toBeDefined()
    const pair = minuteSpeechMs(events, h, a)
    const casterOnly = estimateSpeechMs(line.speech, casterRole(true, line.intensity))
    expect(pair).toBeGreaterThan(casterOnly)
  })

  it('speechEnabled=false면 보정하지 않는다(해설 OFF에서 화면만 느려지면 안 된다)', () => {
    const events = [ev('foul', 40)]
    const off = minuteDwellWithSpeech(40, events, h, a, 2, false, 0, false)
    const on = minuteDwellWithSpeech(40, events, h, a, 2, false, 0, true)
    expect(off).toBe(minuteDwellMs(40, events, 2, false, 0))
    expect(on).toBeGreaterThanOrEqual(off)
  })

  it('2x에서도 주인공 발화가 잘리지 않는다(실엔진 12시드 전 분)', () => {
    for (let seed = 1000; seed <= 1011; seed++) {
      const final = simulateSegment(createMatch(h, a, { seed }), 90)
      for (let m = 1; m <= 90; m++) {
        const atMinute = final.events.filter(e => e.minute === m)
        // 2배속에서는 발화 rate도 2배로 올라가므로 speed를 함께 넘겨야 같은 기준이다.
        const speech = minuteSpeechMs(atMinute, h, a, 2)
        if (speech === 0) continue
        const dwell = minuteDwellWithSpeech(m, atMinute, h, a, 2, false, 0, true)
        expect(dwell, `seed=${seed} m=${m}`).toBeGreaterThanOrEqual(Math.min(speech, MAX_DWELL_MS))
      }
    }
  })

  it('발화 보정을 켜도 1x 90분 총합이 200k~380k에 남는다(리듬 캘리브레이션 보존)', () => {
    for (let seed = 1000; seed <= 1011; seed++) {
      const final = simulateSegment(createMatch(h, a, { seed }), 90)
      let sum = 0
      for (let m = 1; m <= 90; m++) {
        const atMinute = final.events.filter(e => e.minute === m)
        const clutch = m >= 80 && Math.abs(final.score[0] - final.score[1]) <= 1
        sum += minuteDwellWithSpeech(m, atMinute, h, a, 1, clutch, 0, true)
      }
      expect(sum, `seed=${seed}`).toBeGreaterThanOrEqual(200_000)
      expect(sum, `seed=${seed}`).toBeLessThanOrEqual(380_000)
    }
  })
})

// ── 속도 토글이 살아 있는가(발화 하한이 토글을 잡아먹지 않아야 한다) ──
describe('속도 토글 × 발화 하한 — 빨리감기가 실제로 빨라진다', () => {
  const h = makeTestTeam('kor', 76)
  const a = makeTestTeam('esp', 88)

  function total(speed: 1 | 1.5 | 2): number {
    let sum = 0
    for (let seed = 1000; seed <= 1005; seed++) {
      const final = simulateSegment(createMatch(h, a, { seed }), 90)
      for (let m = 1; m <= 90; m++) {
        const at = final.events.filter(e => e.minute === m)
        const clutch = m >= 80 && Math.abs(final.score[0] - final.score[1]) <= 1
        sum += minuteDwellWithSpeech(m, at, h, a, speed, clutch, 0, true)
      }
    }
    return sum / 6
  }

  it('해설 ON에서도 1x > 1.5x > 2x 순으로 짧아진다', () => {
    const t1 = total(1)
    const t15 = total(1.5)
    const t2 = total(2)
    expect(t15).toBeLessThan(t1)
    expect(t2).toBeLessThan(t15)
  })

  it('2x는 1x의 60% 이하 — 토글이 의미를 잃지 않는다', () => {
    expect(total(2) / total(1)).toBeLessThanOrEqual(0.6)
  })
})
