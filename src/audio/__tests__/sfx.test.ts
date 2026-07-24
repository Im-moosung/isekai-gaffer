// @vitest-environment jsdom
// 사운드 로직 테스트 — jsdom엔 AudioContext가 없으므로 합성 함수는 no-op 경로를 탄다.
// 검증 대상: (1) 음소거 토글 상태·localStorage 기억, (2) 미지원 환경에서 절대 throw하지 않음.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isMuted,
  setMuted,
  toggleMuted,
  readStoredMute,
  init,
  crowdLoop,
  goalBurst,
  whistle,
  concedeMurmur,
} from '../sfx'

const MUTE_KEY = 'rematch-muted'

// 이 환경은 jsdom이라도 localStorage를 기본 노출하지 않는다(leaderboard 테스트와 동일 패턴).
// 인메모리 스텁을 주입해 음소거 기억 계약을 검증한다.
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  setMuted(false) // 각 테스트를 소리 ON(기본)으로 정규화
})
afterEach(() => vi.unstubAllGlobals())

describe('sfx 음소거 토글 + localStorage 기억', () => {
  it('기본값은 소리 ON(음소거 아님)', () => {
    expect(isMuted()).toBe(false)
  })

  it('setMuted(true)면 isMuted true + localStorage에 "1" 기록', () => {
    setMuted(true)
    expect(isMuted()).toBe(true)
    expect(localStorage.getItem(MUTE_KEY)).toBe('1')
  })

  it('setMuted(false)면 localStorage 키 제거', () => {
    setMuted(true)
    setMuted(false)
    expect(isMuted()).toBe(false)
    expect(localStorage.getItem(MUTE_KEY)).toBeNull()
  })

  it('toggleMuted는 상태를 뒤집고 새 상태를 반환', () => {
    expect(toggleMuted()).toBe(true)
    expect(isMuted()).toBe(true)
    expect(toggleMuted()).toBe(false)
    expect(isMuted()).toBe(false)
  })

  it('readStoredMute는 localStorage "1"을 읽는다(부재 시 false)', () => {
    expect(readStoredMute()).toBe(false)
    localStorage.setItem(MUTE_KEY, '1')
    expect(readStoredMute()).toBe(true)
  })
})

describe('sfx 미지원 환경 no-op — 크래시 금지', () => {
  it('AudioContext 부재(jsdom)에서 모든 합성 함수가 throw 없이 반환', () => {
    expect(() => init()).not.toThrow()
    expect(() => crowdLoop('start', 0.3)).not.toThrow()
    expect(() => crowdLoop('start', 0.8)).not.toThrow()
    expect(() => crowdLoop('stop')).not.toThrow()
    expect(() => goalBurst()).not.toThrow()
    expect(() => whistle('kickoff')).not.toThrow()
    expect(() => whistle('halftime')).not.toThrow()
    expect(() => whistle('fulltime')).not.toThrow()
    expect(() => whistle('break')).not.toThrow()
    expect(() => concedeMurmur()).not.toThrow()
  })

  it('음소거 상태에서도 합성 함수 호출이 안전하다', () => {
    setMuted(true)
    expect(() => {
      init()
      crowdLoop('start', 0.5)
      goalBurst()
      whistle('fulltime')
      concedeMurmur()
      crowdLoop('stop')
    }).not.toThrow()
  })
})
