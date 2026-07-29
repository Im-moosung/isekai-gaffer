// @vitest-environment jsdom
// jsdom: document는 있지만 canvas 패키지가 없어 getContext('2d')가 null(또는 throw).
// 절차 텍스처 생성기는 이 경우에도 크래시 없이 null을 돌려줘야 한다(호출부가 단색 폴백).
import { describe, it, expect } from 'vitest'
import {
  makeAdBoardCanvas,
  makeCanvas,
  makeConcreteCanvas,
  makeNetCanvas,
  makeNoiseCanvas,
  makePitchCanvas,
} from '../textures'

describe('jsdom(2d 컨텍스트 없음)', () => {
  it('document는 있지만 makeCanvas는 null', () => {
    expect(typeof document).toBe('object')
    expect(makeCanvas(32, 32)).toBeNull()
  })

  it('모든 생성기가 throw 없이 null', () => {
    for (const make of [
      () => makePitchCanvas(2),
      () => makeNetCanvas(),
      () => makeNoiseCanvas(),
      () => makeConcreteCanvas(),
      () => makeAdBoardCanvas(),
    ]) {
      let out: unknown = 'unset'
      expect(() => {
        out = make()
      }).not.toThrow()
      expect(out).toBeNull()
    }
  })
})
