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
  { minute: 60, kind: 'instructions', summary: "60' 지시 변경: 압박 55→90", detail: {} },
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
    expect(qs.some(q => q.text.includes('HT 팀토크: 격노'))).toBe(true)
  })

  it('교체·전술 로그도 질문에 반영된다', () => {
    const rs = buildQuestions(rec('r32', 'ecu', [2, 0], { decisions: subLog }), subLog)
    expect(rs.some(q => q.text.includes("72' 교체: 오현규 IN, 조규성 OUT"))).toBe(true)
    const ri = buildQuestions(rec('r32', 'ecu', [2, 0], { decisions: instrLog }), instrLog)
    expect(ri.some(q => q.text.includes("60' 지시 변경: 압박 55→90"))).toBe(true)
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
    for (const r of cases) for (const q of buildQuestions(r, r.decisions)) {
      texts.push(q.text, ...q.options)
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
})
