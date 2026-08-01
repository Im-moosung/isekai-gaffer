// 선택 하이라이트 계약 — **CSS 파일 자체**를 읽어 못을 박는다.
//
// 왜 CSS를 읽는가: 이 회귀는 JS로는 잡히지 않았다(사용자 지적 2026-08-01 ②).
// 도트 그룹은 <g tabindex="0">라 클릭·탭하면 포커스를 받고, 크롬은 `outline: auto 5px`를
// 얹는다. **SVG 안에서는 CSS px가 사용자 단위**라, viewBox 배율(작전판 실측 ≈ 7.4배)만큼
// 부풀어 5px 링이 화면에서 37px 검은 덩어리가 됐다. 게다가 outline은 그룹 bbox를 따라가고
// 그 bbox 안에 맥동하는 .pv-ring이 들어 있어 덩어리까지 함께 뛰었다.
// jsdom은 outline을 그리지 않으므로 렌더 테스트로는 영영 잡히지 않는다 — 그래서 텍스트로 고정한다.
import { describe, expect, it } from 'vitest'

// 파일을 왜 이렇게 읽는가: vitest는 CSS 임포트를 기본으로 비활성화해 `?raw`조차 빈 문자열을
// 준다(실측). 그래서 런타임(=node)에서 직접 읽는다. 앱 tsconfig의 types에는 node가 없으므로
// 타입만 없다고 표시한다 — 실행 환경에는 있다.
// @ts-expect-error node 타입은 앱 tsconfig(types: vite/client)에 없다. 런타임에는 존재한다.
const { readFileSync } = await import('node:fs')
const css: string = readFileSync(new URL('../pitch.css', import.meta.url), 'utf8')

describe('작전판 도트 선택 표시', () => {
  it('클릭 가능 도트의 브라우저 기본 포커스 아웃라인을 끈다', () => {
    expect(css).toMatch(/\.pv-dotg--click:focus\s*\{\s*outline:\s*none/)
    expect(css).toMatch(/\.pv-dotg--click:focus-visible\s*\{\s*outline:\s*none/)
  })

  it('끈 대신 **같은 정보를 직접 그린다** — 키보드 포커스는 도트 테두리로 보인다', () => {
    // 사용자 단위(stroke-width)로 그리므로 viewBox 배율에 부풀지 않는다.
    expect(css).toMatch(/:focus-visible\s+\.pv-dot\s*\{[^}]*stroke:\s*#fff/)
  })

  it('선택 링은 도트(r 2.4) 곁에 머문다 — 이웃을 덮던 r 5.2로 되돌아가지 않는다', () => {
    const kf = /@keyframes pv-ring\s*\{([\s\S]*?)\}\s*\n/.exec(css)?.[1] ?? ''
    const radii = [...kf.matchAll(/r:\s*([\d.]+)/g)].map(m => Number(m[1]))
    expect(radii.length).toBeGreaterThan(0)
    expect(Math.max(...radii)).toBeLessThanOrEqual(4.5)
  })

  it('선택된 도트 테두리는 작전판 어두운 테두리 규칙을 특이성으로 이긴다', () => {
    // 이걸 놓치면 .pv-root--analysis .pv-dot(2클래스)가 .pv-dot--hl(1클래스)를 덮어
    // 선택 표시가 통째로 사라진다.
    expect(css).toMatch(/\.pv-root--analysis \.pv-dot\.pv-dot--hl/)
  })

  it('모션 최소화 계약은 그대로다 — 링 애니메이션을 끈다', () => {
    const mq = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(mq).toMatch(/\.pv-ring\s*\{\s*animation:\s*none/)
  })
})
