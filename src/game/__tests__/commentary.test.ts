import { describe, it, expect } from 'vitest'
import {
  commentate, commentateAll, commentateAt, commentateTimeline,
  classifyGoal, hasBatchim, josaIGa, josaEunNeun, josaEulReul, josaEuRo,
  scoreKo, ordKo, minuteLabel, sanitizeSpeech, fnv1a,
  flattenLines, flowLineAt, flowStateAt, readTacticalNotes, TACTIC_LINES,
} from '../commentary'
import { safeguardFilter, DEROGATORY_WORDS } from '../../ai/safeguard'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { createMatch, simulateSegment } from '../../engine/simulate'
import { loadTeam, TEAM_IDS } from '../../data/loader'
import type { MatchEvent, MatchEventType } from '../../engine/types'

const home = makeTestTeam('kor', 78), away = makeTestTeam('opp', 78)
const goal: MatchEvent = { minute: 67, type: 'goal', teamId: 'kor', playerId: home.squad[15].id, xg: 0.3 }

const ALL_TYPES: MatchEventType[] = [
  'kickoff', 'chance', 'shot', 'goal', 'save', 'miss', 'foul', 'yellow', 'red', 'corner', 'sub', 'halftime', 'fulltime',
]

/** 실엔진 한 경기의 라인 전체(회귀 지표 측정용). */
function realMatchLines(seed: number) {
  const h = loadTeam('kor'), a = loadTeam('esp')
  const st = simulateSegment(createMatch(h, a, { seed }), 90)
  return { events: st.events, lines: commentateAll(st.events, h, a, st.seed) }
}

describe('commentate — 기본 계약', () => {
  it('골 이벤트에 선수 한글 이름과 분이 들어간다', () => {
    const line = commentate(goal, home, away)
    expect(line.text).toContain(home.squad[15].name.ko)
    expect(line.text).toContain('67')
  })
  it('결정론: 같은 이벤트 = 같은 라인', () => {
    expect(commentate(goal, home, away)).toEqual(commentate(goal, home, away))
  })
  it('모든 이벤트 타입에 대해 비어있지 않은 text와 speech를 낸다', () => {
    for (const type of ALL_TYPES) {
      const line = commentate({ minute: 10, type, teamId: 'kor', playerId: home.squad[3].id }, home, away)
      expect(line.text.length, type).toBeGreaterThan(3)
      expect(line.speech.length, type).toBeGreaterThan(3)
      expect(line.speaker).toBe('caster')
      expect(line.minute).toBe(10)
    }
  })
  it('금지 표현이 없다 (세이프가드 스모크)', () => {
    for (const type of ALL_TYPES) for (let m = 1; m <= 90; m += 7) {
      const line = commentate({ minute: m, type, teamId: 'opp', playerId: away.squad[m % 18].id }, home, away)
      for (const w of DEROGATORY_WORDS) {
        expect(line.text, `${type}@${m}`).not.toContain(w)
        expect(line.speech, `${type}@${m}`).not.toContain(w)
      }
      expect(safeguardFilter(line.text)).toBe(true)
      expect(safeguardFilter(line.speech)).toBe(true)
    }
  })
  it('1인칭 편파 표현(우리·대~한민국)을 쓰지 않는다 — 세이프가드 방침', () => {
    for (const seed of [11, 22, 33]) {
      for (const l of realMatchLines(seed).lines) {
        expect(l.text).not.toMatch(/우리|대~한민국/)
      }
    }
  })
})

describe('commentateAll — 결정론과 접두 안정성', () => {
  it('같은 시드·같은 이벤트면 같은 라인 배열', () => {
    const { events } = realMatchLines(2026)
    const h = loadTeam('kor'), a = loadTeam('esp')
    expect(commentateAll(events, h, a, 7)).toEqual(commentateAll(events, h, a, 7))
  })
  it('시드가 다르면 문장 구성이 달라진다(시드 결정론이 실효한다)', () => {
    const { events } = realMatchLines(2026)
    const h = loadTeam('kor'), a = loadTeam('esp')
    const A = commentateAll(events, h, a, 1).map(l => l.text).join('|')
    const B = commentateAll(events, h, a, 2).map(l => l.text).join('|')
    expect(A).not.toBe(B)
  })
  it('접두 안정성: slice로 부른 결과의 앞부분은 전체 결과의 앞부분과 같다', () => {
    const { events } = realMatchLines(2026)
    const h = loadTeam('kor'), a = loadTeam('esp')
    const full = commentateAll(events, h, a, 5)
    for (const k of [1, 7, 20, events.length - 1]) {
      expect(commentateAll(events.slice(0, k), h, a, 5)).toEqual(full.slice(0, k))
    }
  })
  it('commentateAt은 commentateAll의 같은 인덱스와 일치한다', () => {
    const { events } = realMatchLines(2026)
    const h = loadTeam('kor'), a = loadTeam('esp')
    const full = commentateAll(events, h, a, 5)
    for (const i of [0, 3, 11, events.length - 1]) {
      expect(commentateAt(events, i, h, a, 5)).toEqual(full[i])
    }
  })
})

describe('분 접두 — 규칙대로만 나온다 (§4.1 #1)', () => {
  const ALWAYS: MatchEventType[] = ['goal', 'yellow', 'red', 'halftime', 'fulltime']
  it('골·카드·전후반 경계는 항상 분을 말한다', () => {
    for (const seed of [2026, 7, 99]) {
      const { events, lines } = realMatchLines(seed)
      lines.forEach((l, i) => {
        if (ALWAYS.includes(events[i].type)) {
          expect(l.hasMinutePrefix, `${events[i].type}@${events[i].minute}`).toBe(true)
          expect(l.text).toContain(minuteLabel(events[i].minute))
        }
      })
    }
  })
  it('킥오프는 분을 말하지 않는다(0분·1분은 정보가 없다)', () => {
    for (const seed of [2026, 7, 99]) {
      const { events, lines } = realMatchLines(seed)
      lines.forEach((l, i) => {
        if (events[i].type === 'kickoff') expect(l.hasMinutePrefix).toBe(false)
      })
    }
  })
  it('그 외 이벤트의 분 언급은 소수다 — 전체 비율 35% 미만 (예전 100%)', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { lines } = realMatchLines(seed)
      const pct = lines.filter(l => l.hasMinutePrefix).length / lines.length
      expect(pct, `seed=${seed}`).toBeLessThan(0.35)
    }
  })
  it('분을 말할 때는 전반/후반 라벨을 붙인다 — TTS가 어포스트로피를 이상하게 읽는다', () => {
    expect(minuteLabel(27)).toBe('전반 27분')
    expect(minuteLabel(45)).toBe('전반 45분')
    expect(minuteLabel(63)).toBe('후반 63분')
    expect(minuteLabel(93)).toBe('후반 추가시간')
    for (const seed of [2026, 7]) {
      for (const l of realMatchLines(seed).lines) expect(l.speech).not.toMatch(/\d'/)
    }
  })
})

describe('변형 선택자 — 주기적이지 않다 (§4.1 #4)', () => {
  it('연속 라인에서 같은 변형이 곧바로 반복되지 않는다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { lines } = realMatchLines(seed)
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i].id, `seed=${seed} #${i}`).not.toBe(lines[i - 1].id)
      }
    }
  })
  it('같은 타입 이벤트가 연달아 와도 짝/홀 교대가 되지 않는다', () => {
    // 예전 선택자는 `minute % n` 이라 2변형 풀에서 분의 짝/홀로 엄격 교대했다.
    const events: MatchEvent[] = Array.from({ length: 20 }, (_, i) => ({
      minute: i + 1, type: 'yellow' as const, teamId: 'kor', playerId: home.squad[i % 11].id,
    }))
    const ids = commentateAll(events, home, away, 3).map(l => l.id)
    // 교대(ABABAB…)라면 ids[i] === ids[i+2]가 전부 성립한다. 그렇지 않아야 한다.
    const alternating = ids.every((id, i) => i + 2 >= ids.length || id === ids[i + 2])
    expect(alternating).toBe(false)
  })
  it('한 경기 안에서 충분히 다양한 변형이 쓰인다', () => {
    const { lines } = realMatchLines(2026)
    expect(new Set(lines.map(l => l.id)).size).toBeGreaterThanOrEqual(25)
    expect(new Set(lines.map(l => l.text)).size / lines.length).toBeGreaterThan(0.7)
  })
  it('fnv1a는 인접 입력을 흩는다', () => {
    const a = fnv1a('a1'), b = fnv1a('a2')
    expect(a).not.toBe(b)
    expect(Math.abs((a % 8) - (b % 8))).not.toBe(0)
  })
})

describe('맥락 인지 — 골 종류 (§3.1)', () => {
  it('classifyGoal 판정표', () => {
    expect(classifyGoal(0, 0, false, 20)).toBe('opener')       // 0-0에서 선제
    expect(classifyGoal(-1, 1, false, 20)).toBe('equalizer')   // 0-1에서 동점
    expect(classifyGoal(0, 2, true, 60)).toBe('comeback')      // 1-1(뒤진 적 있음)에서 역전
    expect(classifyGoal(0, 2, false, 60)).toBe('restore')      // 1-1(뒤진 적 없음)에서 다시 리드
    expect(classifyGoal(1, 1, false, 20)).toBe('extra')        // 1-0에서 추가골(이른 시간)
    expect(classifyGoal(1, 1, false, 80)).toBe('clincher')     // 1-0에서 늦은 시간 → 쐐기
    expect(classifyGoal(2, 2, false, 40)).toBe('clincher')     // 2-0 후반 → 쐐기
    expect(classifyGoal(2, 2, false, 12)).toBe('extra')        // 2-0 전반 12분은 쐐기가 아니다
    expect(classifyGoal(-2, 2, false, 50)).toBe('chase')       // 0-2에서 추격
    expect(classifyGoal(-3, 3, false, 85)).toBe('consolation') // 0-3 늦은 시간 → 만회
  })
  it('선제골에는 선제/선취 표현이 들어간다', () => {
    const ev: MatchEvent[] = [{ minute: 20, type: 'goal', teamId: 'kor', playerId: home.squad[9].id }]
    expect(commentateAll(ev, home, away, 1)[0].text).toMatch(/선제|선취|먼저|균형|첫 골/)
  })
  it('동점골·역전골을 구분해 말한다', () => {
    const ev: MatchEvent[] = [
      { minute: 10, type: 'goal', teamId: 'opp', playerId: away.squad[9].id },
      { minute: 40, type: 'goal', teamId: 'kor', playerId: home.squad[9].id },
      { minute: 70, type: 'goal', teamId: 'kor', playerId: home.squad[10].id },
    ]
    const lines = commentateAll(ev, home, away, 1)
    expect(lines[1].text).toMatch(/동점|원점|따라붙|새 경기/)
    expect(lines[2].text).toMatch(/역전|뒤집|앞서/)
  })
  it('멀티골·해트트릭을 센다', () => {
    const p = home.squad[9].id
    const ev: MatchEvent[] = [10, 30, 60].map(minute => ({ minute, type: 'goal' as const, teamId: 'kor', playerId: p }))
    const lines = commentateAll(ev, home, away, 1)
    expect(lines[1].text).toMatch(/멀티골|두 번째 골|두 골째/)
    expect(lines[2].text).toContain('해트트릭')
  })
  it('극장골은 88분 이후 동점·역전에만 쓴다(남발 금지)', () => {
    const ev: MatchEvent[] = [
      { minute: 10, type: 'goal', teamId: 'opp', playerId: away.squad[9].id },
      { minute: 89, type: 'goal', teamId: 'kor', playerId: home.squad[9].id },
    ]
    expect(commentateAll(ev, home, away, 1)[1].id).toContain('lateDrama')
    // 60분 동점골은 극장골이 아니다.
    const early: MatchEvent[] = [ev[0], { ...ev[1], minute: 60 }]
    expect(commentateAll(early, home, away, 1)[1].id).not.toContain('lateDrama')
  })
})

describe('맥락 인지 — streak 4단어 (§3.3)', () => {
  it('같은 선수의 연속 슛에 또·이번에도·벌써가 붙는다', () => {
    const p = home.squad[9].id
    const ev: MatchEvent[] = [5, 9].map(minute => ({ minute, type: 'shot' as const, teamId: 'kor', playerId: p }))
    expect(commentateAll(ev, home, away, 1)[1].text).toMatch(/또|이번에도|벌써|계속/)
  })
  it('연속 선방에 연속·또가 붙는다', () => {
    const gk = away.squad[0].id
    const ev: MatchEvent[] = [20, 26].map(minute => ({ minute, type: 'save' as const, teamId: 'opp', playerId: gk }))
    expect(commentateAll(ev, home, away, 1)[1].text).toMatch(/또|이번에도|연속|번째/)
  })
  it('연속 코너킥을 인지한다', () => {
    const ev: MatchEvent[] = [30, 31].map(minute => ({ minute, type: 'corner' as const, teamId: 'kor' }))
    expect(commentateAll(ev, home, away, 1)[1].text).toMatch(/연속|또|계속|번째/)
  })
  it('같은 선수 3번째 파울을 기억한다', () => {
    const p = home.squad[5].id
    const ev: MatchEvent[] = [10, 30, 50].map(minute => ({ minute, type: 'foul' as const, teamId: 'kor', playerId: p }))
    expect(commentateAll(ev, home, away, 1)[2].text).toMatch(/또|벌써|번째/)
  })
  it('연속 실점을 인지한다', () => {
    const ev: MatchEvent[] = [
      { minute: 30, type: 'goal', teamId: 'opp', playerId: away.squad[9].id },
      { minute: 34, type: 'goal', teamId: 'opp', playerId: away.squad[10].id },
    ]
    expect(commentateAll(ev, home, away, 1)[1].text).toMatch(/또 들어갔|연속 실점|순식간에/)
  })
  it('실엔진 한 경기에서 streak 단어가 실제로 등장한다', () => {
    for (const seed of [2026, 7, 99]) {
      const { lines } = realMatchLines(seed)
      const n = lines.filter(l => /또|이번에도|벌써|연속/.test(l.text)).length
      expect(n, `seed=${seed}`).toBeGreaterThan(2)
    }
  })
})

describe('조사 자동 선택 (§5.5)', () => {
  it('hasBatchim', () => {
    expect(hasBatchim('손흥민')).toBe(true)
    expect(hasBatchim('이강인')).toBe(true)
    expect(hasBatchim('조규성')).toBe(true)
    expect(hasBatchim('메시')).toBe(false)
    expect(hasBatchim('호나우두')).toBe(false)
  })
  it('이/가, 은/는, 을/를, 으로/로', () => {
    expect(josaIGa('손흥민')).toBe('손흥민이')
    expect(josaIGa('메시')).toBe('메시가')
    expect(josaEunNeun('김민재')).toBe('김민재는')
    expect(josaEunNeun('황희찬')).toBe('황희찬은')
    expect(josaEulReul('손흥민')).toBe('손흥민을')
    expect(josaEulReul('메시')).toBe('메시를')
    expect(josaEuRo('서울')).toBe('서울로')   // ㄹ 받침 예외
    expect(josaEuRo('부산')).toBe('부산으로')
    expect(josaEuRo('제주')).toBe('제주로')
  })
  it('생성된 문장에 받침 틀린 조사가 없다', () => {
    // 선수·팀 이름 **바로 뒤**의 조사만 검사한다(동사 어간의 '는'을 조사로 오인하지 않게).
    const h = loadTeam('kor'), a = loadTeam('esp')
    const names = [...h.squad, ...a.squad].map(p => p.name.ko).concat(h.name.ko, a.name.ko)
    for (const seed of [2026, 7, 99, 1234]) {
      const st = simulateSegment(createMatch(h, a, { seed }), 90)
      for (const l of commentateAll(st.events, h, a, st.seed)) {
        for (const s2 of [l.text, l.speech]) {
          for (const name of names) {
            let from = 0
            for (;;) {
              const at = s2.indexOf(name, from)
              if (at < 0) break
              from = at + name.length
              const j = s2[from]
              const batchim = hasBatchim(name)
              if (batchim) expect(['가', '는', '를'], `"${s2}" ← ${name}${j}`).not.toContain(j)
              else expect(['이', '은', '을'], `"${s2}" ← ${name}${j}`).not.toContain(j)
            }
          }
        }
      }
    }
  })
})

describe('TTS 안전성 — text/speech 분리 (§5)', () => {
  it('scoreKo / ordKo 한글화 테이블', () => {
    expect(scoreKo(1, 0)).toBe('일 대 영')
    expect(scoreKo(2, 2)).toBe('이 대 이')
    expect(ordKo(1)).toBe('첫')
    expect(ordKo(3)).toBe('세')
    expect(ordKo(4)).toBe('네')
  })
  it('sanitizeSpeech: 말줄임·중복 느낌표·라틴 문자를 제거한다', () => {
    expect(sanitizeSpeech('아… 아쉽습니다')).toBe('아, 아쉽습니다')
    expect(sanitizeSpeech('골!!! 골!!')).toBe('골! 골!')
    expect(sanitizeSpeech('KOR 대 BRA')).toBe('대')
  })
  it('speech에는 라틴 문자·말줄임·중복 느낌표·이모지가 없다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      for (const l of realMatchLines(seed).lines) {
        expect(l.speech, l.speech).not.toMatch(/[A-Za-z]/)
        expect(l.speech, l.speech).not.toMatch(/…|\.{3}/)
        expect(l.speech, l.speech).not.toMatch(/!{2}/)
      }
    }
  })
  it('speech의 숫자는 분에만 남는다 — 스코어는 한글화된다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      for (const l of realMatchLines(seed).lines) {
        // 숫자 뒤가 '분'이 아니면 TTS 오독 위험(2-1 → "이 마이너스 일").
        for (const m of l.speech.matchAll(/\d+(.?)/g)) {
          expect(m[1], `"${l.speech}"`).toBe('분')
        }
        expect(l.speech, l.speech).not.toMatch(/\d-\d/)
      }
    }
  })
  it('화면 문장은 늘임말을 쓰고, 발화는 정규화된 형태를 쓴다', () => {
    const ev: MatchEvent[] = [{ minute: 20, type: 'goal', teamId: 'kor', playerId: home.squad[9].id }]
    // 선제골 풀 0번이 `고오오올`을 쓴다 — 시드를 돌려 그 변형을 찾는다.
    let found = false
    for (let s = 0; s < 40 && !found; s++) {
      const l = commentateAll(ev, home, away, s)[0]
      if (l.text.includes('고오오올')) {
        found = true
        expect(l.speech).not.toContain('고오오올')
        expect(l.speech).toContain('골')
      }
    }
    expect(found, '고오오올 변형이 선택되는 시드가 있어야 한다').toBe(true)
  })
})

describe('필러 (§2.x)', () => {
  it('필러가 연달아 붙지 않고, 감탄사로 시작하는 문장에 겹쳐 붙지 않는다', () => {
    const FILLER = /^(자,|아,|네,|그런데,|여기서,)/
    for (const seed of [2026, 7, 99, 1234]) {
      const { lines } = realMatchLines(seed)
      let prev = false
      for (const l of lines) {
        const has = FILLER.test(l.text)
        if (has && prev) expect.unreachable(`필러 연속: "${l.text}"`)
        // `그런데, 아, 이재성…` 처럼 감탄사가 겹치면 안 된다.
        expect(l.text, l.text).not.toMatch(/^(자,|아,|네,|그런데,|여기서,)\s*(아…|아,|자,|네,)/)
        prev = has
      }
      // 그래도 실제로 쓰이긴 해야 한다(문두 필러 부재가 로봇 신호였다).
      expect(lines.filter(l => FILLER.test(l.text)).length, `seed=${seed}`).toBeGreaterThan(3)
    }
  })
})

describe('데이터 검증 (§5.4)', () => {
  it('모든 팀·선수에 한글 이름이 있다 — 하나라도 비면 TTS가 라틴 문자를 만난다', () => {
    for (const id of TEAM_IDS) {
      const t = loadTeam(id)
      expect(t.name.ko, id).toMatch(/^[가-힣·\s]+$/)
      for (const p of t.squad) {
        expect(p.name.ko, `${id}/${p.name.en}`).toBeTruthy()
        expect(p.name.ko, `${id}/${p.name.en}`).not.toMatch(/[A-Za-z]/)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────
// Phase C 4~5단계
// ─────────────────────────────────────────────────────────────

describe('해설위원 (§1)', () => {
  it('commentateAll의 배열은 여전히 이벤트와 1:1 캐스터 라인이다(계약 불변)', () => {
    const { events, lines } = realMatchLines(2026)
    expect(lines.length).toBe(events.length)
    expect(new Set(lines.map(l => l.speaker))).toEqual(new Set(['caster']))
    expect(lines.every(l => l.intensity >= 0 && l.intensity <= 3)).toBe(true)
  })

  it('해설은 캐스터 라인의 follow로만 달린다 — 화자가 정확히 analyst다', () => {
    for (const seed of [2026, 7, 99]) {
      const { lines } = realMatchLines(seed)
      for (const l of lines) {
        if (!l.follow) continue
        expect(l.follow.speaker).toBe('analyst')
        expect(l.follow.minute).toBe(l.minute)
        expect(l.follow.hasMinutePrefix).toBe(false)
        // 해설은 받아서 말한다 — 캐스터보다 강도가 높을 수 없다.
        expect(l.follow.intensity).toBeLessThanOrEqual(l.intensity)
      }
    }
  })

  it('해설 개입은 이벤트의 25~45%다 — 매번 붙으면 수다스럽다(§1.3)', () => {
    for (const seed of [2026, 7, 99, 1234, 1003]) {
      const { lines } = realMatchLines(seed)
      const pct = lines.filter(l => l.follow).length / lines.length
      expect(pct, `seed=${seed} → ${(pct * 100).toFixed(1)}%`).toBeGreaterThan(0.25)
      expect(pct, `seed=${seed} → ${(pct * 100).toFixed(1)}%`).toBeLessThan(0.45)
    }
  })

  it('골과 퇴장에는 해설이 반드시 붙는다(방송에서 예외가 없는 두 장면)', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { events, lines } = realMatchLines(seed)
      lines.forEach((l, i) => {
        if (events[i].type === 'goal' || events[i].type === 'red') {
          expect(l.follow, `${events[i].type}@${events[i].minute} seed=${seed}`).toBeDefined()
        }
      })
    }
  })

  it('해설이 두 이벤트 연달아 말하지 않는다(피크·전술 제외) — 캐스터가 사라지면 안 된다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { events, lines } = realMatchLines(seed)
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].follow || !lines[i - 1].follow) continue
        // 연속이 허용되는 경우: 이번이 항상 개입 대상이거나, 전술 해설이거나.
        const always = ['goal', 'red', 'halftime', 'fulltime'].includes(events[i].type)
        const tactic = lines[i].follow!.id.startsWith('an.tactic.')
        expect(always || tactic, `연속 해설: "${lines[i - 1].follow!.text}" → "${lines[i].follow!.text}"`).toBe(true)
      }
    }
  })

  it('해설 문장도 세이프가드를 통과하고 1인칭 편파를 쓰지 않는다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { lines } = realMatchLines(seed)
      for (const l of flattenLines(lines)) {
        expect(safeguardFilter(l.text), l.text).toBe(true)
        expect(l.text, l.text).not.toMatch(/우리|대~한민국/)
        for (const w of DEROGATORY_WORDS) expect(l.text).not.toContain(w)
      }
    }
  })

  it('해설 speech도 TTS 규칙을 지킨다(라틴 문자·말줄임·숫자 금지)', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      for (const l of flattenLines(realMatchLines(seed).lines)) {
        if (l.speaker !== 'analyst') continue
        expect(l.speech, l.speech).not.toMatch(/[A-Za-z]/)
        expect(l.speech, l.speech).not.toMatch(/…|\.{3}/)
        expect(l.speech, l.speech).not.toMatch(/!{2}/)
        for (const m of l.speech.matchAll(/\d+(.?)/g)) expect(m[1], `"${l.speech}"`).toBe('분')
      }
    }
  })

  it('해설 문장은 30음절 이내다 (§5.8 — 긴 유터런스 절단 회피)', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      for (const l of flattenLines(realMatchLines(seed).lines)) {
        if (l.speaker !== 'analyst') continue
        const syllables = [...l.speech].filter(c => c >= '가' && c <= '힣').length
        expect(syllables, l.speech).toBeLessThanOrEqual(30)
      }
    }
  })

  it('해설 변형도 반복되지 않는다(전용 링버퍼)', () => {
    const { lines } = realMatchLines(2026)
    const an = flattenLines(lines).filter(l => l.speaker === 'analyst')
    expect(an.length).toBeGreaterThan(15)
    for (let i = 1; i < an.length; i++) expect(an[i].id).not.toBe(an[i - 1].id)
    expect(new Set(an.map(l => l.text)).size / an.length).toBeGreaterThan(0.6)
  })

  it('결정론: 해설까지 포함해 같은 시드면 같은 결과', () => {
    const { events } = realMatchLines(2026)
    const h = loadTeam('kor'), a = loadTeam('esp')
    expect(commentateAll(events, h, a, 7)).toEqual(commentateAll(events, h, a, 7))
  })
})

describe('소강 구간 라인 (§3.4)', () => {
  const h = loadTeam('kor'), a = loadTeam('esp')

  it('flowStateAt: 한쪽만 두드리면 dominant, 양쪽이면 endToEnd, 비면 lull', () => {
    const atk = (minute: number, teamId: string): MatchEvent => ({ minute, type: 'shot', teamId })
    expect(flowStateAt([], 30, h.id).kind).toBe('lull')
    expect(flowStateAt([atk(28, h.id)], 30, h.id).kind).toBe('lull') // 1개는 아직 흐름이 아니다
    const dom = flowStateAt([25, 26, 27, 28].map(m => atk(m, h.id)), 30, h.id)
    expect(dom.kind).toBe('dominant')
    expect(dom.side).toBe('home')
    const e2e = flowStateAt(
      [atk(24, h.id), atk(25, h.id), atk(26, h.id), atk(27, a.id), atk(28, a.id), atk(29, a.id)], 30, h.id,
    )
    expect(e2e.kind).toBe('endToEnd')
  })

  it('flowStateAt: 몰아붙이는 쪽이 지고 있으면 상대가 잠근 것(lowBlock)', () => {
    const events: MatchEvent[] = [
      { minute: 10, type: 'goal', teamId: a.id },
      ...[25, 26, 27, 28].map(m => ({ minute: m, type: 'shot' as const, teamId: h.id })),
    ]
    const flow = flowStateAt(events, 30, h.id)
    expect(flow.kind).toBe('lowBlock')
    expect(flow.side).toBe('away') // 내려선 쪽 = 이기고 있는 원정팀
  })

  it('이벤트가 있는 분에는 흐름 라인이 나오지 않는다', () => {
    const events: MatchEvent[] = [{ minute: 20, type: 'shot', teamId: h.id }]
    expect(flowLineAt(events, 20, h, a, 1)).toBeNull()
    expect(flowLineAt(events, 21, h, a, 1)).toBeNull() // 1분 정적은 정적이 아니다
    expect(flowLineAt(events, 22, h, a, 1)).toBeNull()
  })

  it('3분 이상 정적이 이어져야 나오고, 그 뒤로는 4분 간격으로만 나온다', () => {
    const events: MatchEvent[] = [{ minute: 20, type: 'shot', teamId: h.id }]
    const fired = []
    for (let m = 21; m <= 40; m++) if (flowLineAt(events, m, h, a, 1)) fired.push(m)
    expect(fired).toEqual([23, 27, 31, 35, 39])
  })

  it('초반·종료 직전에는 나오지 않는다(판단 재료 없음 / 캐스터의 시간)', () => {
    const events: MatchEvent[] = [{ minute: 1, type: 'kickoff', teamId: h.id }]
    expect(flowLineAt(events, 4, h, a, 1)).toBeNull() // 6분 이전
    const late: MatchEvent[] = [{ minute: 80, type: 'shot', teamId: h.id }]
    expect(flowLineAt(late, 83, h, a, 1)).not.toBeNull()
    expect(flowLineAt(late, 91, h, a, 1)).toBeNull() // 88분 이후
  })

  it('실경기 빈도: 경기당 1~8회 — 침묵을 메우되 수다스럽지 않다', () => {
    for (const seed of [2026, 7, 99, 1234, 1003]) {
      const { events } = realMatchLines(seed)
      let n = 0
      for (let m = 1; m <= 90; m++) if (flowLineAt(events, m, h, a, seed)) n++
      expect(n, `seed=${seed} → ${n}회`).toBeGreaterThanOrEqual(1)
      expect(n, `seed=${seed} → ${n}회`).toBeLessThanOrEqual(8)
    }
  })

  it('흐름 라인도 세이프가드·TTS 규칙을 지킨다', () => {
    for (const seed of [2026, 7, 99, 1234]) {
      const { events } = realMatchLines(seed)
      for (let m = 1; m <= 90; m++) {
        const l = flowLineAt(events, m, h, a, seed)
        if (!l) continue
        expect(safeguardFilter(l.text), l.text).toBe(true)
        expect(l.text, l.text).not.toMatch(/우리|대~한민국/)
        expect(l.speech, l.speech).not.toMatch(/[A-Za-z]/)
        expect(['caster', 'analyst']).toContain(l.speaker)
      }
    }
  })

  it('commentateTimeline: 캐스터·해설·흐름이 시간순으로 한 배열이 된다', () => {
    const { events } = realMatchLines(2026)
    const tl = commentateTimeline(events, h, a, 2026, {}, 90)
    // 시간순 정렬
    for (let i = 1; i < tl.length; i++) expect(tl[i].minute).toBeGreaterThanOrEqual(tl[i - 1].minute)
    // 세 종류가 모두 들어 있다
    expect(tl.some(l => l.id.startsWith('flow.'))).toBe(true)
    expect(tl.some(l => l.speaker === 'analyst')).toBe(true)
    expect(tl.filter(l => l.speaker === 'caster').length).toBeGreaterThan(events.length / 2)
    // 접두 안정성 — 재생 중 매 분 다시 계산해도 앞부분이 바뀌지 않는다.
    for (const until of [20, 45, 70]) {
      const partial = commentateTimeline(events.filter(e => e.minute <= until), h, a, 2026, {}, until)
      expect(tl.slice(0, partial.length)).toEqual(partial)
    }
  })
})

describe('전술 반영 해설 (§3.5)', () => {
  const h = loadTeam('kor'), a = loadTeam('esp')

  it('readTacticalNotes: decisionLog의 실제 형식을 읽는다', () => {
    const notes = readTacticalNotes([
      { minute: 20, kind: 'instructions', summary: '', detail: { changed: ['압박 55→85', '라인 65→35'] } },
      { minute: 30, kind: 'instructions', summary: '', detail: { changed: ['템포 70→40', '공격 균형→좌'] } },
      { minute: 45, kind: 'instructions', summary: '', detail: { before: '4-3-3', after: '3-5-2' } },
      { minute: 60, kind: 'instructions', summary: '', detail: { before: '3-5-2', after: '4-2-3-1' } },
      { minute: 70, kind: 'sub', summary: '', detail: { in: 'x', out: 'y' } },
      { minute: 75, kind: 'teamtalk', summary: '외침' },       // 전술이 아니다 — 버린다
      { minute: 80, kind: 'instructions', summary: '', detail: { changed: ['알 수 없는 축 1→2'] } },
    ])
    expect(notes).toEqual([
      { minute: 20, kind: 'pressUp' }, { minute: 20, kind: 'lineDown' },
      { minute: 30, kind: 'tempoDown' }, { minute: 30, kind: 'focusWing' },
      { minute: 45, kind: 'backThree' }, { minute: 60, kind: 'backFour' },
      { minute: 70, kind: 'sub' },
    ])
  })

  it('지시 뒤 장면에 해설이 그 지시를 언급한다', () => {
    const events: MatchEvent[] = [
      { minute: 30, type: 'shot', teamId: h.id, playerId: h.squad[9].id },
      { minute: 33, type: 'chance', teamId: h.id, playerId: h.squad[10].id },
    ]
    const ctx = {
      decisions: [{ minute: 31, kind: 'instructions' as const, summary: '', detail: { changed: ['압박 50→85'] } }],
    }
    const lines = commentateAll(events, h, a, 1, ctx)
    expect(lines[0].follow?.id ?? '').not.toContain('tactic') // 지시 전 장면엔 붙지 않는다
    expect(lines[1].follow?.id).toBe('an.tactic.pressUp.mine')
    expect(lines[1].follow?.text).toMatch(/압박(을 올린| 강도를 올리고)/)
  })

  it('같은 지시를 두 번 말하지 않는다', () => {
    const events: MatchEvent[] = [32, 34, 36].map(minute => ({
      minute, type: 'shot' as const, teamId: h.id, playerId: h.squad[9].id,
    }))
    const ctx = {
      decisions: [{ minute: 31, kind: 'instructions' as const, summary: '', detail: { changed: ['압박 50→85'] } }],
    }
    const tactical = commentateAll(events, h, a, 1, ctx).filter(l => l.follow?.id.startsWith('an.tactic.'))
    expect(tactical.length).toBe(1)
  })

  it('유효 기간(10분)을 넘긴 지시는 언급하지 않는다 — "그 뒤로"가 성립하지 않는다', () => {
    const events: MatchEvent[] = [{ minute: 45, type: 'shot', teamId: h.id, playerId: h.squad[9].id }]
    const ctx = {
      decisions: [{ minute: 31, kind: 'instructions' as const, summary: '', detail: { changed: ['압박 50→85'] } }],
    }
    expect(commentateAll(events, h, a, 1, ctx)[0].follow?.id ?? '').not.toContain('tactic')
  })

  it('내 장면인지 상대 장면인지에 따라 문장이 갈린다', () => {
    const ctx = {
      decisions: [{ minute: 31, kind: 'instructions' as const, summary: '', detail: { changed: ['라인 65→35'] } }],
    }
    const mine = commentateAll([{ minute: 34, type: 'shot', teamId: h.id, playerId: h.squad[9].id }], h, a, 1, ctx)
    const theirs = commentateAll([{ minute: 34, type: 'shot', teamId: a.id, playerId: a.squad[9].id }], h, a, 1, ctx)
    expect(mine[0].follow?.id).toBe('an.tactic.lineDown.mine')
    expect(theirs[0].follow?.id).toBe('an.tactic.lineDown.theirs')
    expect(mine[0].follow?.text).not.toBe(theirs[0].follow?.text)
  })

  it('세이브는 **공격한 쪽** 관점으로 본다 — 우리 선방에 "전개가 빨라졌다"가 붙으면 안 된다', () => {
    const ctx = {
      decisions: [{ minute: 31, kind: 'instructions' as const, summary: '', detail: { changed: ['템포 40→80'] } }],
    }
    // 홈 골키퍼의 선방 = 상대가 공격한 장면.
    const save = commentateAll([{ minute: 34, type: 'save', teamId: h.id, playerId: h.squad[0].id }], h, a, 1, ctx)
    expect(save[0].follow?.id).toBe('an.tactic.tempoUp.theirs')
  })

  it('인과를 단정하지 않는다 — 모든 전술 문장이 시간 서술이다', () => {
    // "때문에"·"덕분에"·"효과입니다" 같은 인과 단정은 엔진이 보증할 수 없다.
    for (const set of Object.values(TACTIC_LINES)) {
      for (const s of [...set.mine, ...set.theirs]) {
        expect(s, s).not.toMatch(/때문|덕분|효과입니다|적중/)
      }
    }
  })

  it('전술 해설도 세이프가드를 통과한다', () => {
    const { events } = realMatchLines(2026)
    const ctx = {
      decisions: [
        { minute: 23, kind: 'instructions' as const, summary: '', detail: { changed: ['압박 55→85'] } },
        { minute: 45, kind: 'instructions' as const, summary: '', detail: { before: '4-3-3', after: '3-5-2' } },
        { minute: 58, kind: 'sub' as const, summary: '', detail: { in: 'x', out: 'y' } },
        { minute: 70, kind: 'instructions' as const, summary: '', detail: { changed: ['라인 65→35', '템포 50→70'] } },
      ],
    }
    const tactical = flattenLines(commentateAll(events, h, a, 2026, ctx))
      .filter(l => l.id.startsWith('an.tactic.'))
    expect(tactical.length).toBeGreaterThan(2) // 실제로 발동한다
    for (const l of tactical) {
      expect(safeguardFilter(l.text), l.text).toBe(true)
      expect(l.speech, l.speech).not.toMatch(/[A-Za-z\d]/) // 포메이션 표기(3-5-2)가 새면 TTS가 오독한다
    }
  })
})
