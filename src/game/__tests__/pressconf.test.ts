import { describe, it, expect } from 'vitest'
import { buildQuestions, buildHeadline, buildEpilogue } from '../pressconf'
import { DEROGATORY_WORDS } from '../../ai/safeguard'
import type { MatchRecord, CampaignStage } from '../campaignStore'
import type { DecisionEntry } from '../../engine/types'

// --- 픽스처 헬퍼 ---
function rec(
  stage: CampaignStage,
  opponentId: string,
  score: [number, number],
  extra: Partial<MatchRecord> = {},
): MatchRecord {
  return { stage, opponentId: opponentId as MatchRecord['opponentId'], score, decisions: [], ...extra }
}

const teamTalkLog: DecisionEntry[] = [
  { minute: 45, kind: 'teamtalk', summary: 'HT 팀토크: 격노', detail: { tone: 'rage' } },
]
const subLog: DecisionEntry[] = [
  { minute: 72, kind: 'sub', summary: "72' 교체: 오현규 IN, 조규성 OUT", detail: { in: 'x', out: 'y' } },
]
const instrLog: DecisionEntry[] = [
  { minute: 60, kind: 'instructions', summary: "60' 지시 변경: 압박 55→90", detail: { changed: ['압박 55→90'] } },
]
const shoutLog: DecisionEntry[] = [
  { minute: 58, kind: 'teamtalk', summary: "58' 외침: 더 뛰어", detail: { shout: 'work' } },
]
const pkLog: DecisionEntry[] = [
  { minute: 90, kind: 'shootout-setup', summary: 'PK: 키커 순서 확정' },
]

// 모든 텍스트를 훑어 금지어가 없는지 확인하는 스모크 헬퍼.
function assertClean(texts: string[]) {
  for (const t of texts) for (const w of DEROGATORY_WORDS) expect(t).not.toContain(w)
}

describe('buildQuestions', () => {
  it('로그가 0건이어도 정확히 3문항을 낸다', () => {
    const qs = buildQuestions(rec('group1', 'cze', [2, 1]), [])
    expect(qs).toHaveLength(3)
  })

  it('모든 질문은 정확히 3개의 옵션을 가진다', () => {
    const cases: MatchRecord[] = [
      rec('group1', 'cze', [2, 1], { decisions: teamTalkLog }),
      rec('final', 'esp', [0, 0], { shootout: [4, 3], decisions: subLog }),
      rec('r16', 'eng', [0, 3]),
    ]
    for (const r of cases) {
      for (const q of buildQuestions(r, r.decisions)) {
        expect(q.options).toHaveLength(3)
        expect(q.options.every(o => typeof o === 'string' && o.length > 0)).toBe(true)
      }
    }
  })

  it('결정론: 같은 (record, log) → 같은 질문', () => {
    const r = rec('qf', 'nor', [3, 1], { decisions: teamTalkLog })
    expect(buildQuestions(r, r.decisions)).toEqual(buildQuestions(r, r.decisions))
  })

  it('팀토크 로그가 있으면 그 로그를 반영한 질문이 존재한다', () => {
    const r = rec('sf', 'arg', [1, 0], { decisions: teamTalkLog })
    const qs = buildQuestions(r, r.decisions)
    expect(qs.some(q => q.text.includes('선수들을 강하게 몰아세우셨다고 합니다'))).toBe(true)
  })

  it('교체·전술 로그도 질문에 반영된다', () => {
    const rs = buildQuestions(rec('r32', 'ecu', [2, 0], { decisions: subLog }), subLog)
    expect(rs.some(q => q.text.includes('72분에 조규성을 빼고 오현규를 투입하셨습니다'))).toBe(true)
    const ri = buildQuestions(rec('r32', 'ecu', [2, 0], { decisions: instrLog }), instrLog)
    expect(ri.some(q => q.text.includes('60분에 압박을 55에서 90까지 올리셨습니다'))).toBe(true)
  })

  // 감사 결함 ⑦의 회귀 방지선: 기자는 우리 내부 로그의 문법으로 말하지 않는다.
  it('질문 문안에 결정 로그 원문(summary)이 그대로 들어가지 않는다', () => {
    const log = [...teamTalkLog, ...subLog, ...instrLog, ...shoutLog, ...pkLog]
    const qs = buildQuestions(rec('r16', 'eng', [1, 1], { shootout: [4, 3], decisions: log }), log)
    for (const e of log) expect(qs.some(q => q.text.includes(e.summary))).toBe(false)
    for (const q of qs) {
      expect(q.text).not.toMatch(/팀토크:|교체:|지시 변경:|포메이션:|IN,|OUT|PK:/)
    }
  })

  it('터치라인 외침도 사람의 말로 나간다', () => {
    const qs = buildQuestions(rec('qf', 'nor', [1, 0], { decisions: shoutLog }), shoutLog)
    expect(qs.some(q => q.text.includes("58분에 터치라인에서 더 뛰라고 다그치셨습니다"))).toBe(true)
  })

  it('해석할 수 없는 로그는 질문을 만들지 않는다(원문 노출 대신 결과 질문으로 채운다)', () => {
    const junk: DecisionEntry[] = [{ minute: 30, kind: 'sub', summary: '알 수 없는 형식', detail: {} }]
    const qs = buildQuestions(rec('group2', 'mex', [1, 1], { decisions: junk }), junk)
    expect(qs).toHaveLength(3)
    expect(qs.some(q => q.text.includes('알 수 없는 형식'))).toBe(false)
  })

  it('planDeviation 미지정이면 플랜 추궁 질문이 생기지 않는다(기존 호출부 불변)', () => {
    const r = rec('group1', 'cze', [2, 1])
    expect(buildQuestions(r, [])).toEqual(buildQuestions(r, [], undefined))
    expect(buildQuestions(r, []).some(q => q.text.includes('계획'))).toBe(false)
  })

  it('이탈 0 + 승리 → 계획 유지 추궁이 1번 질문으로 나온다', () => {
    const qs = buildQuestions(rec('group1', 'cze', [2, 1]), [], 0)
    expect(qs[0].text).toContain('한 번도 흔들지 않으셨습니다')
    expect(qs).toHaveLength(3)
  })

  it('이탈 4 이상 + 승리 → 계획이 틀렸던 것인지 추궁하고 축 수를 언급한다', () => {
    const qs = buildQuestions(rec('r16', 'eng', [3, 1]), [], 5)
    expect(qs[0].text).toContain('5개 축')
    expect(qs[0].text).toContain('원래 계획이 틀렸던')
  })

  it('이탈 4 이상 + 승리 아님(무·패) → 패인 추궁으로 갈린다', () => {
    for (const r of [rec('group2', 'mex', [1, 1]), rec('r16', 'eng', [0, 2])]) {
      const qs = buildQuestions(r, [], 4)
      expect(qs[0].text).toContain('계획을 버린 것이')
    }
  })

  it('이탈이 있지만 임계 미만이면 추궁 질문이 없다(미세 조정 면제)', () => {
    const qs = buildQuestions(rec('group1', 'cze', [2, 1]), [], 2)
    expect(qs.some(q => q.text.includes('계획'))).toBe(false)
  })

  it('이탈 0이어도 패하면 유지 추궁을 하지 않는다', () => {
    const qs = buildQuestions(rec('r16', 'eng', [0, 2]), [], 0)
    expect(qs.some(q => q.text.includes('흔들지 않으셨습니다'))).toBe(false)
  })

  it('플랜 추궁도 실제 한국어 답변 3개를 가진다(자리표시자 금지)', () => {
    for (const dev of [0, 4, 6]) {
      for (const r of [rec('group1', 'cze', [2, 1]), rec('r16', 'eng', [0, 2])]) {
        const q = buildQuestions(r, [], dev)[0]
        expect(q.options).toHaveLength(3)
        for (const o of q.options) {
          expect(o.length).toBeGreaterThan(8)
          expect(o.endsWith('.') || o.endsWith('다.')).toBe(true)
        }
        expect(new Set(q.options).size).toBe(3)
      }
    }
  })

  it('결정론: 같은 planDeviation → 같은 질문', () => {
    const r = rec('qf', 'nor', [3, 1], { decisions: teamTalkLog })
    expect(buildQuestions(r, r.decisions, 5)).toEqual(buildQuestions(r, r.decisions, 5))
  })

  it('플랜 추궁이 들어가도 로그 질문이 1개는 남는다(3문항 예산)', () => {
    const log = [...teamTalkLog, ...subLog, ...instrLog]
    const qs = buildQuestions(rec('r16', 'eng', [4, 0], { decisions: log }), log, 5)
    expect(qs).toHaveLength(3)
    expect(qs.some(q => q.text.includes('선수들을 강하게 몰아세우셨다고 합니다'))).toBe(true)
  })

  it('질문 문안에 금지어가 없다 (세이프가드 스모크)', () => {
    const cases: MatchRecord[] = [
      rec('group1', 'cze', [2, 1]),
      rec('group2', 'mex', [0, 0]),
      rec('group3', 'rsa', [0, 2]),
      rec('final', 'esp', [1, 1], { shootout: [5, 4] }),
      rec('r16', 'eng', [4, 0], { decisions: [...teamTalkLog, ...subLog, ...instrLog] }),
    ]
    const texts: string[] = []
    for (const r of cases) for (const dev of [undefined, 0, 2, 4, 7]) {
      for (const q of buildQuestions(r, r.decisions, dev)) texts.push(q.text, ...q.options)
    }
    assertClean(texts)
  })
})

describe('buildHeadline', () => {
  const tones = [
    '우리 준비가 옳았습니다. 결과가 증명하죠.', // 공격적
    '선수들이 모든 걸 쏟아부은 덕분입니다.', // 겸손
    '오늘 밤은 발 뻗고 자겠습니다.', // 유머
  ]

  it('결정론: 같은 입력 → 같은 헤드라인', () => {
    const r = rec('qf', 'nor', [3, 0])
    expect(buildHeadline(r, tones, '대한민국')).toEqual(buildHeadline(r, tones, '대한민국'))
  })

  it('title/sub/quote가 모두 비어있지 않고 팀명을 포함한다', () => {
    const h = buildHeadline(rec('group1', 'cze', [2, 1]), tones, '대한민국')
    expect(h.title.length).toBeGreaterThan(2)
    expect(h.sub.length).toBeGreaterThan(2)
    expect(h.quote).toContain('대한민국')
  })

  it('quote는 전달된 답변 중 하나를 인용한다', () => {
    const h = buildHeadline(rec('r16', 'eng', [1, 0]), tones, '대한민국')
    expect(tones.some(a => h.quote.includes(a))).toBe(true)
  })

  it('금지어 스모크: 승/패/무/승부차기 × 답변 3톤 전 조합 순회', () => {
    const results: MatchRecord[] = [
      rec('group1', 'cze', [4, 0]), // 대승
      rec('group2', 'mex', [2, 1]), // 신승
      rec('group3', 'rsa', [1, 1]), // 무승부
      rec('r16', 'eng', [0, 3]), // 패배
      rec('final', 'esp', [1, 1], { shootout: [4, 3] }), // 승부차기 승
      rec('sf', 'arg', [0, 0], { shootout: [2, 4] }), // 승부차기 패
    ]
    const texts: string[] = []
    for (const r of results) for (const t of tones) {
      const h = buildHeadline(r, [t, t, t], '대한민국')
      texts.push(h.title, h.sub, h.quote)
    }
    assertClean(texts)
  })
})

describe('buildEpilogue', () => {
  const groupRecs: MatchRecord[] = [
    rec('group1', 'cze', [2, 1]),
    rec('group2', 'mex', [1, 3]),
    rec('group3', 'rsa', [0, 2]),
  ]

  it('조별 탈락 분기: 3~5문장, 조별리그 서술 포함', () => {
    const ep = buildEpilogue(groupRecs, { reached: 'group3', champion: false })
    expect(ep.length).toBeGreaterThanOrEqual(3)
    expect(ep.length).toBeLessThanOrEqual(5)
    expect(ep.some(s => s.includes('조별'))).toBe(true)
    assertClean(ep)
  })

  it('우승 분기: 우승 서술과 3~5문장', () => {
    const full: MatchRecord[] = [
      ...[rec('group1', 'cze', [2, 0]), rec('group2', 'mex', [3, 1]), rec('group3', 'rsa', [1, 0])],
      rec('r32', 'ecu', [2, 1]),
      rec('r16', 'eng', [1, 1], { shootout: [4, 2] }),
      rec('qf', 'nor', [3, 2]),
      rec('sf', 'arg', [2, 1]),
      rec('final', 'esp', [1, 0]),
    ]
    const ep = buildEpilogue(full, { reached: 'final', champion: true })
    expect(ep.length).toBeGreaterThanOrEqual(3)
    expect(ep.length).toBeLessThanOrEqual(5)
    expect(ep.some(s => s.includes('우승') || s.includes('정상'))).toBe(true)
    assertClean(ep)
  })

  it('결정론: 같은 입력 → 같은 에필로그', () => {
    expect(buildEpilogue(groupRecs, { reached: 'group3', champion: false }))
      .toEqual(buildEpilogue(groupRecs, { reached: 'group3', champion: false }))
  })

  it('승부차기로 **졌으면** "살아남았다"고 쓰지 않는다', () => {
    const recs: MatchRecord[] = [
      rec('group1', 'cze', [2, 0]), rec('group2', 'mex', [1, 0]), rec('group3', 'rsa', [1, 0]),
      rec('r32', 'ecu', [2, 1]),
      rec('r16', 'eng', [1, 1], { shootout: [3, 4] }), // 승부차기 패배 → 탈락
    ]
    const ep = buildEpilogue(recs, { reached: 'r16', champion: false })
    expect(ep.some(s => s.includes('살아남았다'))).toBe(false)
    expect(ep.some(s => s.includes('승부차기'))).toBe(true)
    assertClean(ep)
  })

  it('승부차기를 이긴 경기가 있으면 그 경기를 하이라이트로 쓴다', () => {
    const recs: MatchRecord[] = [
      rec('group1', 'cze', [2, 0]), rec('group2', 'mex', [1, 0]), rec('group3', 'rsa', [1, 0]),
      rec('r32', 'ecu', [1, 1], { shootout: [5, 4] }),
      rec('r16', 'eng', [0, 2]),
    ]
    const ep = buildEpilogue(recs, { reached: 'r16', champion: false })
    expect(ep.some(s => s.includes('살아남았다'))).toBe(true)
  })

  it('대패를 "가장 인상적인 경기"로 소개하지 않는다 — 결과가 좋은 경기를 고른다', () => {
    const recs: MatchRecord[] = [
      rec('group1', 'cze', [0, 2]),
      rec('group2', 'mex', [0, 3]), // 최다 득점 합계 경기 = 최악의 패배
      rec('group3', 'rsa', [1, 1]),
    ]
    const ep = buildEpilogue(recs, { reached: 'group3', champion: false })
    const line = ep.find(s => s.includes('경기는'))!
    expect(line).toContain('1-1')
    expect(line).not.toContain('0-3')
    assertClean(ep)
  })

  it('전패 조별리그에서는 상찬("가장 인상적인") 대신 중립 서술을 쓴다', () => {
    const recs: MatchRecord[] = [
      rec('group1', 'cze', [0, 1]),
      rec('group2', 'mex', [0, 3]),
      rec('group3', 'rsa', [1, 2]),
    ]
    const ep = buildEpilogue(recs, { reached: 'group3', champion: false })
    const line = ep.find(s => s.includes('경기는'))!
    expect(line).not.toContain('가장 인상적인')
    expect(line).toContain('1-2') // 가장 근접했던 경기
    assertClean(ep)
  })

  it('토너먼트에서 한 번도 못 이겼으면 "0번의 승리"라고 쓰지 않는다', () => {
    const recs: MatchRecord[] = [
      rec('group1', 'cze', [2, 0]), rec('group2', 'mex', [1, 0]), rec('group3', 'rsa', [1, 0]),
      rec('r32', 'ecu', [0, 1]),
    ]
    const ep = buildEpilogue(recs, { reached: 'r32', champion: false })
    expect(ep.some(s => s.includes('0번의 승리'))).toBe(false)
    assertClean(ep)
  })
})
