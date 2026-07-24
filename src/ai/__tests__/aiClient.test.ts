import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { narrate } from '../aiClient'

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('narrate (aiClient)', () => {
  beforeEach(() => {
    // 폴백 경고는 조용해야 하므로 스파이로 억제 (콘솔 오염 방지)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('성공 응답의 안전한 텍스트를 반환한다', async () => {
    mockFetch(() => new Response(JSON.stringify({ text: '값진 승리를 거뒀습니다.' }), { status: 200 }))
    const out = await narrate('headline', { result: '승리' })
    expect(out).toBe('값진 승리를 거뒀습니다.')
  })

  it('503(키 부재)은 null 로 폴백한다', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'no key' }), { status: 503 }))
    expect(await narrate('pressq', {})).toBeNull()
  })

  it('네트워크/타임아웃(reject)은 null 로 폴백한다', async () => {
    mockFetch(() => Promise.reject(new Error('aborted')))
    expect(await narrate('epilogue', {})).toBeNull()
  })

  it('세이프가드 필터를 통과하지 못하면 null', async () => {
    mockFetch(() => new Response(JSON.stringify({ text: '정말 한심한 경기였다.' }), { status: 200 }))
    expect(await narrate('headline', {})).toBeNull()
  })

  it('text 필드가 없으면 null', async () => {
    mockFetch(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }))
    expect(await narrate('pressq', {})).toBeNull()
  })
})
