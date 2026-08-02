import { describe, it, expect } from 'vitest'
import { buildQuestions, buildHeadline, buildEpilogue, describeMatch, describeCampaign, contradictsScore, ANSWER_POOLS } from '../pressconf'
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

/** 계획(킥오프 플랜) 추궁 3분기 중 하나인가 — 문안이 바뀌어도 한곳만 고치면 되게 모은다. */
function isPlanQuestion(q: { text: string }): boolean {
  return ['처음 준비한 대로 밀고 가셨습니다', '전반과 후반이 완전히 다른 팀이었습니다', '준비한 것을 접은 판단이']
    .some(s => q.text.includes(s))
}

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
    expect(ri.some(q => q.text.includes('60분에 압박을 한층 끌어올리셨습니다'))).toBe(true)
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

  it('planDeviation 미지정이면 계획 추궁 질문이 생기지 않는다(기존 호출부 불변)', () => {
    const r = rec('group1', 'cze', [2, 1])
    expect(buildQuestions(r, [])).toEqual(buildQuestions(r, [], undefined))
    expect(buildQuestions(r, []).some(isPlanQuestion)).toBe(false)
  })

  it('변경 없음 + 승리 → 계획 유지 추궁이 1번 질문으로 나온다', () => {
    const qs = buildQuestions(rec('group1', 'cze', [2, 1]), [], 0)
    expect(qs[0].text).toContain('처음 준비한 대로 밀고 가셨습니다')
    expect(qs).toHaveLength(3)
  })

  it('크게 바꿈 + 승리 → 처음 준비가 틀렸던 것인지 추궁한다', () => {
    const qs = buildQuestions(rec('r16', 'eng', [3, 1]), [], 5)
    expect(qs[0].text).toContain('전반과 후반이 완전히 다른 팀이었습니다')
    expect(qs[0].text).toContain('처음 준비가 틀렸던')
  })

  // 사용자 지적(2026-08-01): 기자는 "N개 축"이라고 말하지 않는다. 바꾼 항목 수는 질문을
  // **고르는 데만** 쓰고 문장에는 넣지 않는다 — 화면의 배지가 없어도 질문이 혼자 서야 한다.
  it('계획 추궁 문장에 변경 항목 수가 새어 나오지 않는다', () => {
    for (const dev of [0, 4, 5, 6, 9]) {
      for (const r of [rec('group1', 'cze', [2, 1]), rec('r16', 'eng', [0, 2])]) {
        const q = buildQuestions(r, [], dev)[0]
        expect(q.text).not.toMatch(/개 축|\d+\s*개|축을/)
      }
    }
  })

  it('크게 바꿈 + 승리 아님(무·패) → 패인 추궁으로 갈린다', () => {
    for (const r of [rec('group2', 'mex', [1, 1]), rec('r16', 'eng', [0, 2])]) {
      const qs = buildQuestions(r, [], 4)
      expect(qs[0].text).toContain('준비한 것을 접은 판단이')
    }
  })

  it('변경이 있지만 임계 미만이면 추궁 질문이 없다(미세 조정 면제)', () => {
    const qs = buildQuestions(rec('group1', 'cze', [2, 1]), [], 2)
    expect(qs.some(isPlanQuestion)).toBe(false)
  })

  it('변경이 없어도 패하면 유지 추궁을 하지 않는다', () => {
    const qs = buildQuestions(rec('r16', 'eng', [0, 2]), [], 0)
    expect(qs.some(q => q.text.includes('밀고 가셨습니다'))).toBe(false)
  })

  it('계획 추궁도 실제 한국어 답변 3개를 가진다(자리표시자 금지)', () => {
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

  it('계획 추궁이 들어가도 로그 질문이 1개는 남는다(3문항 예산)', () => {
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

describe('전술 변경 질문의 한국어 — 작전판 용어를 기자의 말로', () => {
  // 사용자 지적(2026-08-01): 기자는 "축"도 "멘탈리티"도 말하지 않고, 0~100 슬라이더 값을
  // 읽어 오지도 않는다. 아래는 matchStore.tacticsDiff가 실제로 남기는 조각 전종이다.
  function askAbout(...changed: string[]): string[] {
    const log: DecisionEntry[] = [{
      minute: 47, kind: 'instructions', summary: `47' 지시 변경: ${changed.join(', ')}`, detail: { changed },
    }]
    return buildQuestions(rec('qf', 'fra', [1, 0], { decisions: log }), log).map(q => q.text)
  }

  const CASES: [string, string][] = [
    ['라인 40→70', '47분에 수비 라인을 끌어올리셨습니다.'],
    ['라인 70→40', '47분에 수비 라인을 끌어내리셨습니다.'],
    ['압박 55→90', '47분에 압박을 한층 끌어올리셨습니다.'],
    ['압박 62→47', '47분에 압박을 늦추셨습니다.'],
    ['템포 50→70', '47분에 경기 템포를 끌어올리셨습니다.'],
    ['템포 70→50', '47분에 템포를 늦추셨습니다.'],
    ['공격 균형→좌', '47분에 공격을 왼쪽으로 몰아가셨습니다.'],
    ['공격 좌→우', '47분에 공격을 오른쪽으로 몰아가셨습니다.'],
    ['공격 우→중앙', '47분에 공격을 가운데로 모으셨습니다.'],
    ['공격 중앙→균형', '47분에 공격을 양쪽으로 고르게 펴셨습니다.'],
    ['포메이션 4-2-3-1→4-4-2', '47분에 진형을 4-2-3-1에서 4-4-2로 바꾸셨습니다.'],
    ['멘탈리티 균형→공격적', '47분에 팀을 더 공격적으로 돌리셨습니다.'],
    ['멘탈리티 공격적→매우 수비적', '47분에 팀을 더 단단하게 잠그셨습니다.'],
    ['공격 적극성 기본→적극', '47분에 최전방에 더 적극적으로 나서라고 주문하셨습니다.'],
    ['미드필드 적극성 기본→자제', '47분에 중원에 힘을 아끼라고 주문하셨습니다.'],
    ['수비 적극성 자제→기본', '47분에 수비진에 더 적극적으로 나서라고 주문하셨습니다.'],
    ['공격 패턴 균형→크로스', '47분에 공격을 측면 크로스 위주로 돌리셨습니다.'],
    ['공격 패턴 크로스→중앙 침투', '47분에 공격을 중앙 침투 쪽으로 돌리셨습니다.'],
    ['공격 패턴 중앙 침투→중거리', '47분에 공격을 중거리 슛 위주로 돌리셨습니다.'],
    ['공격 패턴 중거리→균형', '47분에 공격 방식을 다시 고르게 가져가셨습니다.'],
    ['GK 파워플레이 ON', '47분에 골키퍼까지 상대 진영으로 올려보내셨습니다.'],
    ['GK 파워플레이 OFF', '47분에 골키퍼를 다시 골문으로 돌려보내셨습니다.'],
    ['코너 루트 파→니어', '47분에 코너킥을 니어포스트로 올리셨습니다.'],
    ['코너 루트 니어→짧게', '47분에 코너킥을 짧게 가져가셨습니다.'],
    ['코너 루트 짧게→파', '47분에 코너킥을 먼 쪽으로 올리셨습니다.'],
    ['박스 인원 표준→많이', '47분에 코너에서 문전에 사람을 더 채우셨습니다.'],
    ['박스 인원 많이→적게', '47분에 코너에서 문전 인원을 줄이셨습니다.'],
    ['박스 인원 적게→표준', '47분에 코너에서 문전 인원을 원래대로 되돌리셨습니다.'],
    ['수비 마킹 존→맨투맨', '47분에 수비를 대인 방어로 돌리셨습니다.'],
    ['수비 마킹 맨투맨→존', '47분에 수비를 지역 방어로 돌리셨습니다.'],
  ]
  it.each(CASES)('%s → %s', (piece, sentence) => {
    expect(askAbout(piece).some(t => t.includes(sentence))).toBe(true)
  })

  it('여러 가지를 한꺼번에 바꾸면 "…고, …셨습니다"로 이어진다', () => {
    const texts = askAbout('압박 55→90', '템포 70→50', '멘탈리티 균형→공격적')
    expect(texts.some(t => t.includes(
      '47분에 압박을 한층 끌어올리고, 템포를 늦추고, 팀을 더 공격적으로 돌리셨습니다.',
    ))).toBe(true)
  })

  it('두 낱말짜리 축 이름을 잘라 먹지 않는다(옛 파서 회귀)', () => {
    // 예전 정규식은 "공격 적극성 기본→적극"을 「공격을 적극성 기본에서…」로 망가뜨렸다.
    for (const p of ['공격 적극성 기본→적극', '공격 패턴 균형→크로스', '박스 인원 표준→많이', '코너 루트 파→니어']) {
      for (const t of askAbout(p)) expect(t).not.toMatch(/적극성 |패턴 |인원 표준|루트 니어/)
    }
  })

  it('모르는 축은 질문을 만들지 않는다(원문 노출 금지)', () => {
    const texts = askAbout('새로운축 가→나')
    expect(texts.some(t => t.includes('새로운축') || t.includes('→'))).toBe(false)
    expect(texts).toHaveLength(3)
  })

  it('슬라이더 수치가 문장에 새어 나오지 않는다', () => {
    for (const [piece] of CASES) {
      for (const t of askAbout(piece)) {
        // 허용되는 숫자는 분("47분")과 진형 표기("4-2-3-1")뿐이다.
        const rest = t.replace(/\d+분/g, '').replace(/\d(?:-\d)+/g, '')
        expect(rest).not.toMatch(/\d/)
      }
    }
  })

  it('포메이션 변경은 구조화 detail로도 진형 문장이 된다', () => {
    const log: DecisionEntry[] = [{
      minute: 60, kind: 'instructions', summary: "60' 포메이션: 4-2-3-1→4-4-2",
      detail: { before: '4-2-3-1', after: '4-4-2' },
    }]
    const qs = buildQuestions(rec('qf', 'fra', [1, 0], { decisions: log }), log)
    expect(qs.some(q => q.text.includes('60분에 진형을 4-2-3-1에서 4-4-2로 바꾸셨습니다'))).toBe(true)
  })
})

// 기자회견 문안은 화면에 뜨는 동시에 낭독될 수 있는 문자열이다(§5.2 speech 규약).
// 라틴 문자는 ko-KR 보이스가 철자로 읽고, 슬라이더 수치는 애초에 사람이 하는 말이 아니다.
describe('기자회견 문안의 발화 안전성', () => {
  it('질문·답변 전 분기에 라틴 문자와 내부 기호가 없다', () => {
    const logs: DecisionEntry[] = [
      { minute: 45, kind: 'teamtalk', summary: 'HT 팀토크: 격노', detail: { tone: 'rage' } },
      { minute: 58, kind: 'teamtalk', summary: "58' 외침: 독려", detail: { shout: 'urge' } },
      { minute: 72, kind: 'sub', summary: "72' 교체: 오현규 IN, 조규성 OUT" },
      { minute: 47, kind: 'instructions', summary: "47' 지시 변경: 압박 55→90, 멘탈리티 균형→공격적",
        detail: { changed: ['압박 55→90', '멘탈리티 균형→공격적'] } },
      { minute: 80, kind: 'instructions', summary: "80' 지시 변경: GK 파워플레이 ON",
        detail: { changed: ['GK 파워플레이 ON'] } },
      { minute: 90, kind: 'shootout-setup', summary: 'PK: 키커 순서 확정' },
    ]
    const records: MatchRecord[] = [
      rec('group1', 'cze', [4, 0]), rec('group2', 'mex', [1, 1]), rec('group3', 'rsa', [0, 0]),
      rec('r16', 'eng', [0, 2]), rec('qf', 'fra', [2, 1]),
      rec('final', 'esp', [1, 1], { shootout: [4, 3] }),
    ]
    for (const r of records) for (const dev of [undefined, 0, 2, 4, 9]) {
      for (const one of logs) for (const q of buildQuestions(r, [one], dev)) {
        for (const text of [q.text, ...q.options]) {
          expect(text).not.toMatch(/[A-Za-z]/)
          expect(text).not.toMatch(/[→…]|\.\.\./)
          // 숫자는 분·진형에서만 허용한다(그 밖의 숫자는 내부 수치가 샌 것이다).
          expect(text.replace(/\d+분/g, '').replace(/\d(?:-\d)+/g, '')).not.toMatch(/\d/)
        }
      }
    }
  })
})

// detail 필드가 없던 시절의 로그(저장된 캠페인)도 사람의 말로 나가야 한다 —
// 해석에 실패해 질문이 통째로 사라지면 로그 기반 서사가 조용히 비어버린다.
describe('detail 없는 옛 로그 폴백', () => {
  it('팀토크 요약의 한국어 라벨로 톤을 되짚는다', () => {
    const log: DecisionEntry[] = [{ minute: 45, kind: 'teamtalk', summary: 'HT 팀토크: 격려' }]
    const qs = buildQuestions(rec('r16', 'eng', [2, 1], { decisions: log }), log)
    expect(qs.some(q => q.text.includes('선수들을 북돋우셨다고 합니다'))).toBe(true)
  })
  it('외침 요약도 마찬가지', () => {
    const log: DecisionEntry[] = [{ minute: 58, kind: 'teamtalk', summary: "58' 외침: 독려" }]
    const qs = buildQuestions(rec('r16', 'eng', [2, 1], { decisions: log }), log)
    expect(qs.some(q => q.text.includes('더 밀어붙이라고 외치셨습니다'))).toBe(true)
  })
})

// AI에 넘기는 사실 카드 — 배열 인덱스가 아니라 이름 붙은 필드로 승패를 못 박는다.
// (2026-08-02 결함: 2-5 패배 경기의 헤드라인이 "5-2 대승"으로 뒤집혀 나왔다.)
describe('describeMatch', () => {
  it('패배 경기는 어느 필드를 읽어도 패배로 읽힌다', () => {
    const f = describeMatch(rec('group2', 'mex', [2, 5]), '대한민국')
    expect(f.우리_팀).toBe('대한민국')
    expect(f.우리_팀_득점).toBe(2)
    expect(f.상대_팀).toBe('멕시코')
    expect(f.상대_팀_득점).toBe(5)
    expect(f.정규시간_결과).toBe('패배')
    expect(f.최종_결과).toBe('패배')
    expect(f.점수차).toBe(3)
    expect(f.최종_스코어).toBe('대한민국 2-5 멕시코')
    expect(f.한줄_사실).toContain('졌다')
  })
  it('승부차기는 정규시간과 분리해 최종 결과를 따로 못 박는다', () => {
    const win = describeMatch(rec('sf', 'esp', [1, 1], { shootout: [4, 3] }))
    expect(win.정규시간_결과).toBe('무승부')
    expect(win.최종_결과).toBe('승부차기 승리')
    const lose = describeMatch(rec('sf', 'esp', [1, 1], { shootout: [3, 4] }))
    expect(lose.최종_결과).toBe('승부차기 패배')
    expect(lose.한줄_사실).toContain('졌다')
  })
})

describe('describeCampaign', () => {
  it('경기별 승패를 판정하고 통산 전적·도달 단계를 명시한다', () => {
    const c = describeCampaign(
      [rec('group1', 'cze', [3, 0]), rec('group2', 'mex', [2, 5]), rec('r16', 'esp', [1, 1], { shootout: [3, 4] })],
      { reached: 'r16', champion: false },
    )
    expect(c.통산_전적).toBe('1승 0무 2패') // 승부차기 패배는 패로 센다(진출 기준)
    expect(c.총_득점).toBe(6)
    expect(c.총_실점).toBe(6)
    expect(c.우승_여부).toBe(false)
    expect(c.도달_단계).toBe('16강')
    expect(String(c.한줄_사실)).toContain('우승하지 못했다')
    expect((c.경기별_결과 as unknown[]).length).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════
// 답변이 결과를 아는가 (2026-08-02 실플레이 결함의 회귀선)
// ═══════════════════════════════════════════════════════════
// 사고: 2-5 대패 회견에 "이 정도는 예상했던 그림입니다."가 떴다. 답변 풀이 톤 3종 × 4문장
// 하나뿐이었고 셋을 같은 인덱스로 뽑아, 실질 4종이 승패와 무관하게 돌았기 때문이다.
describe('답변 풀은 경기 결과를 안다', () => {
  /** 결과 칸별 대표 레코드. outcomeOf의 여섯 분기를 전부 덮는다. */
  const BY_OUTCOME: [string, MatchRecord][] = [
    ['bigwin', rec('group1', 'cze', [4, 0])],
    ['win', rec('group2', 'mex', [2, 0])],
    ['narrow', rec('group3', 'rsa', [2, 1])],
    ['shootoutWin', rec('final', 'esp', [1, 1], { shootout: [4, 3] })],
    ['draw', rec('r32', 'ecu', [1, 1])],
    ['loss', rec('r16', 'eng', [0, 3])],
    ['loss(승부차기)', rec('sf', 'arg', [0, 0], { shootout: [2, 4] })],
  ]

  /** 개입 기록이 없을 때 나오는 질문("손댈 필요가 없다고 보셨습니까?" 계열).
   *  이 질문의 답변은 **일부러 결과와 무관하다** — 결과가 아니라 "건드리지 않았다"는
   *  결정에 답하기 때문이다. 결과별 답변 풀을 비교하는 검사에서는 빼야 한다. */
  const HANDS_OFF_Q = /손댈 필요가|개입하지 않은 것도|작전판이 조용/

  /** 여러 시드로 같은 결과의 회견을 돌려, 그 **결과 칸**에서 나올 수 있는 답변을 모은다.
   *  (시드는 상대·단계·로그 수로 갈리므로 상대를 바꿔 회전시킨다.) */
  function answersOf(make: (opp: string, stage: CampaignStage) => MatchRecord): Set<string> {
    const out = new Set<string>()
    const opps = ['cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar', 'fra']
    const stages: CampaignStage[] = ['group1', 'group2', 'group3', 'r32', 'r16', 'qf', 'sf', 'final']
    for (const o of opps) for (const s of stages) {
      for (const q of buildQuestions(make(o, s), [])) {
        if (HANDS_OFF_Q.test(q.text)) continue
        for (const a of q.options) out.add(a)
      }
    }
    return out
  }

  it.each(BY_OUTCOME)('%s: 모든 질문이 비어 있지 않은 답변 3개를 가진다', (_name, r) => {
    const qs = buildQuestions(r, r.decisions)
    expect(qs).toHaveLength(3)
    for (const q of qs) {
      expect(q.options).toHaveLength(3)
      expect(new Set(q.options).size).toBe(3)
      for (const o of q.options) {
        expect(o.trim().length).toBeGreaterThan(8)
        expect(o.endsWith('.')).toBe(true)
      }
    }
  })

  // ★ 이번 사고의 핵심 회귀 테스트 — 진 경기의 답변에 이긴 사람의 어휘가 있으면 안 된다.
  it('패배 회견의 답변 어디에도 승리 어휘가 없다', () => {
    const WIN_WORDS = [
      '대승', '완승', '완파', '제압', '증명', '무너뜨', '꺾', '눌렀',
      '이겼습니다', '승리', '통했습니다', '발 뻗고', '예상했던 그림', '두렵지 않',
    ]
    const pools = [
      answersOf((o, s) => rec(s, o, [0, 3])),
      answersOf((o, s) => rec(s, o, [1, 2])),
      answersOf((o, s) => rec(s, o, [0, 0], { shootout: [2, 4] })),
    ]
    for (const pool of pools) {
      expect(pool.size).toBeGreaterThanOrEqual(12) // 회전이 실제로 도는지(칸당 톤 4문장 × 3톤)
      for (const a of pool) for (const w of WIN_WORDS) expect(a).not.toContain(w)
    }
  })

  it('무승부 회견의 답변도 승리를 주장하지 않는다', () => {
    const pool = answersOf((o, s) => rec(s, o, [1, 1]))
    for (const a of pool) for (const w of ['대승', '완승', '완파', '제압', '이겼습니다']) {
      expect(a).not.toContain(w)
    }
  })

  it('결과가 다르면 답변 풀도 다르다(같은 세트를 돌려쓰지 않는다)', () => {
    const win = answersOf((o, s) => rec(s, o, [4, 0]))
    const loss = answersOf((o, s) => rec(s, o, [0, 3]))
    for (const a of loss) expect(win.has(a)).toBe(false)
  })

  it('개입 없는 경기 질문은 승패와 상관없이 같은 답변을 쓴다(의도된 동작)', () => {
    // 위 검사에서 이 질문을 뺀 것이 "빠뜨림"이 아니라 "설계"임을 못 박는다.
    // 뽑히는 문장은 시드(상대·단계·스코어)마다 다르지만, **풀 자체가 같아야** 한다.
    const poolOf = (score: [number, number]) => {
      const out = new Set<string>()
      for (const o of ['cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp']) {
        for (const s of ['group1', 'group2', 'r16', 'qf', 'sf', 'final'] as CampaignStage[]) {
          const q = buildQuestions(rec(s, o, score), []).find(x => HANDS_OFF_Q.test(x.text))
          expect(q).toBeDefined()
          for (const a of q!.options) out.add(a)
        }
      }
      return [...out].sort()
    }
    expect(poolOf([4, 0])).toEqual(poolOf([0, 3]))
    expect(poolOf([4, 0]).length).toBeGreaterThanOrEqual(9)   // 회전이 실제로 돈다
  })

  it('결정론: 같은 입력 두 번 → 같은 답변', () => {
    for (const [, r] of BY_OUTCOME) {
      expect(buildQuestions(r, r.decisions).map(q => q.options))
        .toEqual(buildQuestions(r, r.decisions).map(q => q.options))
    }
  })

  it('답변 세트의 종류가 결과별로 충분히 갈린다(예전에는 전체 4종이었다)', () => {
    const sets = new Set<string>()
    const scores: [number, number][] = [[4, 0], [3, 1], [2, 0], [2, 1], [1, 1], [0, 3], [1, 2]]
    const stages: CampaignStage[] = ['group1', 'group2', 'group3', 'r32', 'r16', 'qf', 'sf']
    for (const o of ['cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar']) {
      for (const s of stages) for (const sc of scores) for (const dev of [undefined, 0, 5]) {
        for (const q of buildQuestions(rec(s, o, sc), [], dev)) sets.add(q.options.join('|'))
      }
    }
    expect(sets.size).toBeGreaterThan(40)
  })
})

// 헤드라인 톤은 **마지막 답변의 톤**으로 정해진다(answerTone). 새 문안이 톤 풀에 등록되지
// 않으면 해시 폴백으로 떨어져 헤드라인이 답변과 반대로 나간다 — 그걸 밖에서 관측한다:
// 같은 톤의 문장은 같은 레코드에서 반드시 같은 제목을 낳아야 한다.
describe('답변 톤 역분류(headline과의 계약)', () => {
  const REFS: MatchRecord[] = [
    rec('group1', 'cze', [4, 0]), rec('group2', 'mex', [2, 1]), rec('group3', 'rsa', [1, 1]),
    rec('r16', 'eng', [0, 3]), rec('final', 'esp', [1, 1], { shootout: [4, 3] }),
  ]
  const GROUPS: [string, readonly string[]][] = [
    ['공격적', ANSWER_POOLS.aggressive], ['겸손', ANSWER_POOLS.humble], ['유머', ANSWER_POOLS.humor],
  ]

  it.each(GROUPS)('%s 풀의 모든 문안이 같은 톤으로 분류된다(해시 폴백 없음)', (_n, pool) => {
    for (const r of REFS) {
      const titles = new Set(pool.map(a => buildHeadline(r, [a], '대한민국').title))
      expect(titles.size).toBe(1)
    }
  })

  it('세 톤은 서로 다른 제목으로 갈린다(톤 순서가 살아 있다)', () => {
    for (const r of REFS) {
      const t = GROUPS.map(([, pool]) => buildHeadline(r, [pool[0]], '대한민국').title)
      expect(new Set(t).size).toBe(3)
    }
  })

  it('한 문안이 두 톤에 동시에 들어 있지 않다', () => {
    const [a, h, j] = GROUPS.map(([, p]) => new Set(p))
    for (const s of a) { expect(h.has(s)).toBe(false); expect(j.has(s)).toBe(false) }
    for (const s of h) expect(j.has(s)).toBe(false)
  })

  it('전 결과 × 전 답변에 금지어·라틴 문자·내부 수치가 없다', () => {
    for (const [, pool] of GROUPS) for (const a of pool) {
      for (const w of DEROGATORY_WORDS) expect(a).not.toContain(w)
      expect(a).not.toMatch(/[A-Za-z0-9]/)
      expect(a).not.toMatch(/[→…]|\.\.\./)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 답변이 질문에 대답하는가 (2026-08-03 배포본 지적의 회귀선)
// ═══════════════════════════════════════════════════════════
// 사고: 질문은 감독의 결정 로그에서 나오는데 답변은 경기 결과만 보고 뽑혀서,
// 「…황희찬을 투입하셨습니다. 계획된 승부수였습니까?」에 「커피를 몇 잔 마셨는지…」가 붙었다.
describe('답변 풀은 질문 종류를 안다', () => {
  /** 로그 1건 종류별 대표 픽스처와, 그 질문을 알아보는 표식. */
  const KINDS: [string, DecisionEntry, string][] = [
    ['하프타임 팀토크', teamTalkLog[0], '하프타임 라커룸 이야기가 나옵니다'],
    ['터치라인 외침', shoutLog[0], '터치라인에서'],
    ['교체', subLog[0], '투입하셨습니다'],
    ['지시 변경', instrLog[0], '어떤 의도였는지'],
    ['승부차기 키커', pkLog[0], '키커 순서를 직접 정하셨습니다'],
  ]

  /** 여러 시드로 회견을 돌려, 그 종류의 질문에 붙은 답변만 모은다.
   *  (시드는 상대·단계·스코어로 갈리므로 셋을 회전시킨다.) */
  function answersFor(entry: DecisionEntry, marker: string): Set<string> {
    const out = new Set<string>()
    const scores: [number, number][] = [[4, 0], [2, 0], [2, 1], [1, 1], [0, 3], [1, 2]]
    for (const o of ['cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar', 'fra']) {
      for (const s of ['group1', 'group2', 'group3', 'r32', 'r16', 'qf', 'sf'] as CampaignStage[]) {
        for (const sc of scores) {
          const r = rec(s, o, sc, { decisions: [entry] })
          for (const q of buildQuestions(r, r.decisions)) {
            if (q.text.includes(marker)) for (const a of q.options) out.add(a)
          }
        }
      }
    }
    return out
  }

  const POOLS = new Map(KINDS.map(([name, e, m]) => [name, answersFor(e, m)]))

  it.each(KINDS)('%s 질문은 전용 답변 세트를 가진다(톤 3종 × 4문장)', name => {
    expect(POOLS.get(name)!.size).toBe(12)
  })

  it('종류가 다르면 답변이 하나도 겹치지 않는다', () => {
    const names = KINDS.map(([n]) => n)
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      for (const a of POOLS.get(names[i])!) expect(POOLS.get(names[j])!.has(a)).toBe(false)
    }
  })

  it('결과 기반 답변이 로그 질문에 붙지 않는다(사고 재현: 교체 질문 + 커피 이야기)', () => {
    const r = rec('r16', 'eng', [2, 1], { decisions: subLog })
    const qs = buildQuestions(r, r.decisions)
    const subQ = qs.find(q => q.text.includes('투입하셨습니다'))!
    const resultQs = qs.filter(q => !q.text.includes('투입하셨습니다'))
    expect(resultQs.length).toBe(2)
    for (const o of subQ.options) {
      for (const rq of resultQs) expect(rq.options).not.toContain(o)
    }
    // 결과 칸의 대표 문안이 로그 질문에 흘러들지 않는다.
    for (const [, pool] of POOLS) {
      for (const bad of ['커피를 몇 잔 마셨는지 세지도 못했네요.', '선수들이 모든 걸 쏟아부은 덕분입니다.']) {
        expect(pool.has(bad)).toBe(false)
      }
    }
  })

  it('로그 질문의 답변은 그 질문의 낱말로 대답한다', () => {
    // 완전한 의미 검증은 불가능하지만, 최소한 화제가 맞는지는 표본으로 붙잡는다.
    const TOPIC: [string, RegExp][] = [
      ['하프타임 팀토크', /라커룸|하프타임|말|후반|목|짚어/],
      ['터치라인 외침', /외|목소리|한마디|소리|터치라인|팔|마이크|자리|들렸|말/],
      ['교체', /교체|선수|벤치|자리|카드|번호판|다리|뺄지/],
      ['지시 변경', /바꾸|바꿔|맞춰|손대|작전판|노린|판단|방법|반영|손짓|수첩/],
      ['승부차기 키커', /순서|순번|키커|서겠|자리|서는|심장|눈|종이|일은|훈련장|기준/],
    ]
    for (const [name, re] of TOPIC) {
      for (const a of POOLS.get(name)!) expect(a).toMatch(re)
    }
  })

  it('로그 질문의 답변은 승패를 단정하지 않는다(승패 무관하게 붙는 문안이다)', () => {
    const WIN_WORDS = ['대승', '완승', '완파', '제압', '무너뜨', '이겼습니다', '승리했', '패배했']
    for (const [, pool] of POOLS) for (const a of pool) {
      for (const w of WIN_WORDS) expect(a).not.toContain(w)
    }
  })

  it('결정론: 같은 (record, log) → 같은 답변', () => {
    for (const [, e] of KINDS.map(([n, e]) => [n, e] as const)) {
      for (const r of [rec('qf', 'nor', [3, 1], { decisions: [e] }), rec('r16', 'eng', [0, 2], { decisions: [e] })]) {
        expect(buildQuestions(r, r.decisions).map(q => q.options))
          .toEqual(buildQuestions(r, r.decisions).map(q => q.options))
      }
    }
  })

  it('톤 순서 계약: 로그 질문의 답변도 [공격적, 겸손, 유머] 자리에 맞게 등록돼 있다', () => {
    // 등록되지 않으면 answerTone이 해시 폴백으로 떨어져 헤드라인 톤이 답변과 어긋난다.
    for (const [, e, marker] of KINDS) {
      const r = rec('sf', 'arg', [1, 0], { decisions: [e] })
      const q = buildQuestions(r, r.decisions).find(x => x.text.includes(marker))!
      expect(ANSWER_POOLS.aggressive).toContain(q.options[0])
      expect(ANSWER_POOLS.humble).toContain(q.options[1])
      expect(ANSWER_POOLS.humor).toContain(q.options[2])
    }
  })

  // 결과 칸끼리는 같은 문안을 공유해도 된다("팬들의 응원이 큰 힘이 됐습니다."는 여러 승리 칸에
  // 어울린다). 하지만 종류 칸의 문안은 서로도, 결과 칸과도 겹치면 안 된다 — 겹치는 순간
  // "질문에 대답한다"는 성질이 무너진다.
  it('종류 칸의 문안은 서로도, 결과 칸과도 겹치지 않는다', () => {
    const kindAll = [...POOLS.values()].flatMap(p => [...p])
    expect(new Set(kindAll).size).toBe(kindAll.length)
    // 로그가 없는 회견 = 결과 기반 질문뿐이다. 그 답변과 한 줄도 겹쳐서는 안 된다.
    const resultAll = new Set<string>()
    for (const o of ['cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar', 'fra']) {
      for (const s of ['group1', 'group2', 'group3', 'r32', 'r16', 'qf', 'sf', 'final'] as CampaignStage[]) {
        for (const sc of [[4, 0], [2, 0], [2, 1], [1, 1], [0, 3], [1, 2]] as [number, number][]) {
          for (const q of buildQuestions(rec(s, o, sc), [])) for (const a of q.options) resultAll.add(a)
        }
      }
    }
    for (const a of kindAll) expect(resultAll.has(a)).toBe(false)
  })

  it('새 문안도 발화 안전 규약을 지킨다(금지어·라틴 문자·숫자 없음, 한 문장)', () => {
    for (const [, pool] of POOLS) for (const a of pool) {
      for (const w of DEROGATORY_WORDS) expect(a).not.toContain(w)
      expect(a).not.toMatch(/[A-Za-z0-9]/)
      expect(a).not.toMatch(/[→…]|\.\.\./)
      expect(a.endsWith('.')).toBe(true)
      expect(a.length).toBeGreaterThan(8)
      expect(a.length).toBeLessThanOrEqual(35)
    }
  })
})

describe('contradictsScore(3층 방어선)', () => {
  const r = rec('group2', 'mex', [2, 5])
  it('없는 스코어를 지어낸 헤드라인을 걸러낸다', () => {
    expect(contradictsScore("대한민국, 멕시코에 2-0에서 5-2로 대승", r)).toBe(true)
    expect(contradictsScore('대한민국, 멕시코 5-2로 제압', r)).toBe(true) // 뒤집힌 표기
  })
  it('정상 헤드라인은 통과시킨다', () => {
    expect(contradictsScore('대한민국, 멕시코전 아쉬운 패배', r)).toBe(false) // 스코어 미언급
    expect(contradictsScore('2-5 완패... 대한민국, 숙제를 안고 돌아서다', r)).toBe(false)
    expect(contradictsScore('4-2-3-1로 맞선 대한민국, 멕시코에 무릎 꿇다', r)).toBe(false) // 포메이션
  })
  it('승부차기 스코어도 허용값이다', () => {
    const pk = rec('sf', 'esp', [1, 1], { shootout: [4, 3] })
    expect(contradictsScore('승부차기 4-3, 1-1 혈투 끝에 웃은 대한민국', pk)).toBe(false)
    expect(contradictsScore('승부차기 5-4로 웃은 대한민국', pk)).toBe(true)
  })
})
