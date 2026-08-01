// 비교 뷰 CSS 본문 계약.
//
// ★ 왜 CSS를 문자열로 재는가: 이 규칙의 위반은 **레이아웃으로만** 드러나는데 jsdom에는
//   레이아웃이 없다. `svg-focus-ring.test.ts`가 같은 이유로 index.css 본문을 잰다.
//
// 잠긴 규칙 — `.cmp`를 container query 컨테이너로 만들지 않는다.
//   `container-type: inline-size`는 인라인 축 containment를 켜므로 **내용이 자기 폭에
//   기여하지 못한다.** 이 컴포넌트가 사는 작전판 팝오버(`.tb-pop--cmp`)는 절대배치 +
//   `max-width: 420px`짜리 shrink-to-fit 상자라, 컨테이너로 지정하는 순간 폭 계산이
//   0으로 무너져 팝업 전체가 44px로 접혔다(실측 docs/audit/shots/r10-hud-*).
//   좁은 상자 대응은 컨테이너 쿼리가 아니라 **구조**가 맡는다(compare-layout.test.tsx).
import { describe, expect, it } from 'vitest'

// @ts-expect-error node 타입은 앱 tsconfig(types: vite/client)에 없다. 런타임에는 존재한다.
const { readFileSync } = await import('node:fs')
// 주석은 걷어 내고 본문만 본다 — 위 주석이 기각된 속성 이름을 그대로 인용한다.
const css: string = readFileSync(new URL('../PlayerCompare.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

describe('PlayerCompare.css — 컨테이너 쿼리 금지', () => {
  it('container-type 선언이 없다', () => {
    expect(css).not.toMatch(/container-type\s*:/)
  })
  it('@container 규칙이 없다', () => {
    expect(css).not.toMatch(/@container/)
  })
  it('좁은 화면 대응은 뷰포트 미디어 쿼리로 남아 있다(대응 자체를 지우지 않았다)', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*719px\)/)
  })
})
