import { describe, it, expect } from 'vitest'
import {
  validateNarrateRequest,
  firstForwardedIp,
  rateLimitCheck,
  MAX_BODY_CHARS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '../requestGuard'

describe('validateNarrateRequest', () => {
  it('정상 요청은 task/context를 파싱해 통과시킨다', () => {
    const r = validateNarrateRequest(JSON.stringify({ task: 'pressq', context: { score: '2-1' } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.task).toBe('pressq')
      expect(r.context).toEqual({ score: '2-1' })
    }
  })

  it('원문 길이가 상한 초과면 413', () => {
    const raw = JSON.stringify({ task: 'pressq', context: { pad: 'x'.repeat(MAX_BODY_CHARS) } })
    expect(raw.length).toBeGreaterThan(MAX_BODY_CHARS)
    const r = validateNarrateRequest(raw)
    expect(r).toMatchObject({ ok: false, status: 413 })
  })

  it('JSON 파싱 실패면 400', () => {
    expect(validateNarrateRequest('{ not json')).toMatchObject({ ok: false, status: 400 })
  })

  it('허용되지 않은 task면 400', () => {
    const r = validateNarrateRequest(JSON.stringify({ task: 'evil', context: {} }))
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid task' })
  })

  it('context가 object가 아니면 400', () => {
    expect(
      validateNarrateRequest(JSON.stringify({ task: 'pressq', context: 'nope' })),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid context' })
    expect(
      validateNarrateRequest(JSON.stringify({ task: 'pressq', context: [1, 2] })),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid context' })
    expect(validateNarrateRequest(JSON.stringify({ task: 'pressq' }))).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid context',
    })
  })
})

describe('firstForwardedIp', () => {
  it('x-forwarded-for 첫 항목을 트림해 반환한다', () => {
    expect(firstForwardedIp('203.0.113.7, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.7')
    expect(firstForwardedIp('  198.51.100.5  ')).toBe('198.51.100.5')
  })
  it('없으면 unknown', () => {
    expect(firstForwardedIp(null)).toBe('unknown')
    expect(firstForwardedIp('')).toBe('unknown')
    expect(firstForwardedIp(undefined)).toBe('unknown')
  })
})

describe('rateLimitCheck', () => {
  it('윈도 내 한도 이하면 허용하고 now를 기록한다', () => {
    const r = rateLimitCheck([1000, 2000], 3000)
    expect(r.allowed).toBe(true)
    expect(r.timestamps).toEqual([1000, 2000, 3000])
  })

  it('윈도 내 한도 도달 시 차단하고 now를 기록하지 않는다', () => {
    const now = 100_000
    const ts = Array.from({ length: RATE_LIMIT_MAX }, (_, i) => now - i * 100)
    const r = rateLimitCheck(ts, now)
    expect(r.allowed).toBe(false)
    expect(r.timestamps.length).toBe(RATE_LIMIT_MAX)
  })

  it('윈도 밖 오래된 타임스탬프는 정리한다(메모리 누수 방지)', () => {
    const now = 1_000_000
    const stale = now - RATE_LIMIT_WINDOW_MS - 1
    const r = rateLimitCheck([stale, stale, now - 1000], now)
    expect(r.allowed).toBe(true)
    expect(r.timestamps).toEqual([now - 1000, now])
  })

  it('정리 후 한도 미만이면 다시 허용된다', () => {
    const now = 500_000
    const stale = Array.from({ length: RATE_LIMIT_MAX }, () => now - RATE_LIMIT_WINDOW_MS - 1)
    const r = rateLimitCheck(stale, now)
    expect(r.allowed).toBe(true)
    expect(r.timestamps).toEqual([now])
  })
})
