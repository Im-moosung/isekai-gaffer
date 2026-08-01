// 전역 포커스 링 계약 — **CSS 파일 자체**를 읽어 못을 박는다.
//
// 왜 여기(작전판 테스트 폴더)인가: 이 사고가 실제로 터진 화면이 작전판이다. 작전판은
// viewBox 배율이 실측 ≈7.4배라, 전역 `:focus-visible { outline: 2px }`가 화면에서 15px
// 띠가 되고 크롬 UA 기본값(outline: auto 5px)은 37px 검은 덩어리가 됐다
// (커밋 efb6158 — "선수를 누르면 검은 덩어리가 생긴다"). efb6158은 도트에서만 껐고
// 전역 규칙은 남아 있었다 — 포커스 가능한 SVG를 하나 더 만들면 그대로 재발한다.
//
// jsdom은 outline을 그리지 않으므로 렌더 테스트로는 영영 잡히지 않는다. 그래서
// select-highlight.test.ts와 같은 방식으로 텍스트를 고정한다.
import { describe, expect, it } from 'vitest'

// vitest는 CSS 임포트를 기본으로 비활성화해 `?raw`조차 빈 문자열을 준다 — 런타임에서 직접 읽는다.
// @ts-expect-error node 타입은 앱 tsconfig(types: vite/client)에 없다. 런타임에는 존재한다.
const { readFileSync } = await import('node:fs')
const css: string = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')

describe('SVG 안의 전역 포커스 링', () => {
  it('SVG 안에서는 전역 outline을 끈다 — px가 사용자 단위라 배율만큼 부풀기 때문이다', () => {
    expect(css).toMatch(/svg\s+:focus-visible\s*\{\s*outline:\s*none/)
  })

  it('끄기만 하지 않는다 — 도형에는 배율에 부풀지 않는 흰 테두리를 대신 그린다', () => {
    const rule = /svg\s+:is\(([^)]*)\):focus-visible\s*\{([\s\S]*?)\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('circle')
    expect(rule![2]).toMatch(/stroke:\s*#fff/)
    // 이 한 줄이 접근성 표시를 배율로부터 지킨다. 빠지면 stroke-width 2가 다시
    // 사용자 단위가 되어 7.4배 화면에서 15px 덩어리가 된다.
    expect(rule![2]).toMatch(/vector-effect:\s*non-scaling-stroke/)
  })

  it('컨테이너(<g>)에는 stroke를 걸지 않는다 — 상속되어 자식 글자까지 테두리를 뒤집어쓴다', () => {
    const rule = /svg\s+:is\(([^)]*)\):focus-visible/.exec(css)
    expect(rule![1]).not.toMatch(/\bg\b/)
  })

  it('SVG 밖의 전역 포커스 링은 그대로다 — 키보드 포커스는 어디서든 보여야 한다', () => {
    expect(css).toMatch(/^:focus-visible\s*\{\s*\n\s*outline:\s*2px solid var\(--brand\)/m)
  })
})
