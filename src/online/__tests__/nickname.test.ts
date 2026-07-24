import { describe, it, expect } from 'vitest'
import { sanitizeNickname, DEFAULT_NICKNAME, BANNED_WORDS } from '../nickname'
import { DEROGATORY_WORDS } from '../../ai/safeguard'

describe('sanitizeNickname', () => {
  it('정상 닉네임은 trim 후 그대로 반환한다', () => {
    expect(sanitizeNickname('  히딩크  ')).toBe('히딩크')
    expect(sanitizeNickname('Coach Kim')).toBe('Coach Kim')
    expect(sanitizeNickname('열두글자꽉채운닉네임임')).toBe('열두글자꽉채운닉네임임') // 12자
  })

  it('2자 미만이면 기본값', () => {
    expect(sanitizeNickname('가')).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname('')).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname('   ')).toBe(DEFAULT_NICKNAME)
  })

  it('12자 초과면 기본값', () => {
    expect(sanitizeNickname('열세글자를넘겨버린닉네임임다')).toBe(DEFAULT_NICKNAME)
  })

  it('금칙어(비하)를 포함하면 기본값', () => {
    expect(sanitizeNickname('한심한감독')).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname('멍청이')).toBe(DEFAULT_NICKNAME)
  })

  it('금칙어(욕설)를 포함하면 기본값 (대소문자 무시)', () => {
    expect(sanitizeNickname('씨발감독')).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname('FUCKer')).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname('shithead')).toBe(DEFAULT_NICKNAME)
  })

  it('문자열이 아니면 기본값', () => {
    expect(sanitizeNickname(null)).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname(undefined)).toBe(DEFAULT_NICKNAME)
    expect(sanitizeNickname(123)).toBe(DEFAULT_NICKNAME)
  })

  it('금칙어 목록은 15개 이상이며 DEROGATORY_WORDS를 재사용한다', () => {
    expect(BANNED_WORDS.length).toBeGreaterThanOrEqual(15)
    for (const w of DEROGATORY_WORDS) expect(BANNED_WORDS).toContain(w)
  })
})
