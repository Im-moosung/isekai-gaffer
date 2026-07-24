import { describe, it, expect } from 'vitest'
import { safeguardFilter, DEROGATORY_WORDS, MAX_TEXT_LENGTH } from '../safeguard'

const SAFE_SENTENCES = [
  '전반 압박을 55에서 90으로 끌어올린 선택이 흐름을 바꿨다.',
  '후반 72분 오현규 교체가 공격에 활력을 더했다.',
  '승부차기 끝에 값진 승리를 거뒀습니다.',
  '상대는 견고한 수비 조직을 유지했다.',
  '감독은 하프타임에 격려의 메시지를 전했다.',
  '이 경기는 대체역사 픽션 속 한 장면입니다.',
  '중원 싸움이 팽팽하게 이어졌다.',
  '세트피스에서 좋은 기회를 여러 차례 만들었다.',
  '선수들은 끝까지 집중력을 유지했다.',
  '다음 라운드를 향한 발판을 마련했다.',
]

const DEROGATORY_SENTENCES = [
  '오늘 경기력은 최악이었다.',
  '정말 한심한 수비였다.',
  '형편없는 전술이었다고 본다.',
  '멍청한 실수가 반복됐다.',
  '이건 쓰레기 같은 결과다.',
  '완전히 무능한 지휘였다.',
  '창피한 줄 알아야 한다.',
  '수치스러운 패배다.',
  '바보 같은 판단이었다.',
  '저능한 운영이 문제였다.',
]

describe('safeguardFilter', () => {
  it('안전 문장 10종을 모두 통과시킨다', () => {
    for (const s of SAFE_SENTENCES) expect(safeguardFilter(s)).toBe(true)
  })
  it('비하 문장 10종을 모두 차단한다', () => {
    for (const s of DEROGATORY_SENTENCES) expect(safeguardFilter(s)).toBe(false)
  })
  it('빈 문자열/공백은 차단한다', () => {
    expect(safeguardFilter('')).toBe(false)
    expect(safeguardFilter('   ')).toBe(false)
  })
  it('600자 초과는 차단하고 600자는 통과한다', () => {
    expect(safeguardFilter('가'.repeat(MAX_TEXT_LENGTH))).toBe(true)
    expect(safeguardFilter('가'.repeat(MAX_TEXT_LENGTH + 1))).toBe(false)
  })
  it('사전은 15개 이상의 비하 어휘를 export 한다', () => {
    expect(DEROGATORY_WORDS.length).toBeGreaterThanOrEqual(15)
    expect(DEROGATORY_WORDS).toContain('최악')
    expect(DEROGATORY_WORDS).toContain('무능')
  })
})
