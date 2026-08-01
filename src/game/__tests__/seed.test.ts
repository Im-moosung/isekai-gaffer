// 캠페인 시드 발급기. 이 모듈이 이 프로젝트의 **유일한 엔트로피 경계**라
// (1) 주입하면 완전 결정론 (2) 주입하지 않아도 크래시 없음 두 가지를 못박는다.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SEED_MIN, SEED_MAX, defaultEntropy, newCampaignSeed,
  parseSeed, seedFromLocation, shareUrlForSeed,
} from '../seed'

afterEach(() => vi.unstubAllGlobals())

describe('newCampaignSeed', () => {
  it('엔트로피를 주입하면 완전 결정론이다 — 테스트는 실행마다 같은 값을 본다', () => {
    const fixed = () => 12345
    expect(newCampaignSeed(fixed)).toBe(newCampaignSeed(fixed))
  })

  it('어떤 입력이 와도 6자리 범위(100000~999999)로 접는다', () => {
    for (const raw of [0, 1, 0xffff_ffff, 123, 999_999_999]) {
      const s = newCampaignSeed(() => raw)
      expect(s).toBeGreaterThanOrEqual(SEED_MIN)
      expect(s).toBeLessThanOrEqual(SEED_MAX)
      expect(Number.isInteger(s)).toBe(true)
    }
  })

  it('음수·NaN도 유효 시드로 접는다(엔트로피 폴백이 이상값을 줘도 판이 시작돼야 한다)', () => {
    expect(newCampaignSeed(() => -7)).toBeGreaterThanOrEqual(SEED_MIN)
    expect(newCampaignSeed(() => Number.NaN)).toBe(SEED_MIN)
  })

  it('기본 엔트로피로 20번 뽑으면 값이 갈린다 — 상수 시드 시절의 재발 방지', () => {
    const seeds = new Set(Array.from({ length: 20 }, () => newCampaignSeed()))
    expect(seeds.size).toBeGreaterThan(10)
  })
})

describe('defaultEntropy 폴백', () => {
  it('crypto.getRandomValues가 있으면 그것을 쓴다', () => {
    const spy = vi.fn((a: Uint32Array) => { a[0] = 42; return a })
    vi.stubGlobal('crypto', { getRandomValues: spy })
    expect(defaultEntropy()).toBe(42)
    expect(spy).toHaveBeenCalled()
  })

  it('crypto가 없어도(구형 브라우저·비보안 컨텍스트) 유한한 수를 돌려준다', () => {
    vi.stubGlobal('crypto', undefined)
    const v = defaultEntropy()
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(0)
  })

  it('crypto가 던져도 폴백으로 넘어간다', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('보안 컨텍스트 아님') } })
    expect(Number.isFinite(defaultEntropy())).toBe(true)
  })
})

describe('parseSeed', () => {
  it('유효한 6자리만 통과한다', () => {
    expect(parseSeed('123456')).toBe(123456)
    expect(parseSeed(' 999999 ')).toBe(999999)
  })
  it('범위 밖·비숫자·빈값은 null(잘못된 시드로 시작하느니 새 판을 뽑는다)', () => {
    for (const bad of ['99999', '1000000', 'abc', '12.3', '-5', '', null, undefined]) {
      expect(parseSeed(bad)).toBeNull()
    }
  })
})

describe('seedFromLocation', () => {
  it('?seed=가 유효하면 그 값을, 아니면 null', () => {
    expect(seedFromLocation('?seed=246810')).toBe(246810)
    expect(seedFromLocation('?seed=abc')).toBeNull()
    expect(seedFromLocation('?other=1')).toBeNull()
    expect(seedFromLocation('')).toBeNull()
  })
  it('location이 없는 환경(SSR)에서도 크래시하지 않는다', () => {
    vi.stubGlobal('location', undefined)
    expect(seedFromLocation()).toBeNull()
  })
})

describe('shareUrlForSeed', () => {
  it('location이 있으면 공유 주소를, 없으면 null(복사 UI를 숨긴다)', () => {
    vi.stubGlobal('location', { origin: 'https://example.com', pathname: '/play' })
    expect(shareUrlForSeed(123456)).toBe('https://example.com/play?seed=123456')
    vi.stubGlobal('location', undefined)
    expect(shareUrlForSeed(123456)).toBeNull()
  })
})
