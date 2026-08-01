import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 브라우저 하한선 — **명시**한다.
 *
 * 심사는 배포 URL로 진행되고 규정은 "주요 브라우저에서 정상 실행"을 요구한다. 그런데
 * 이 값이 암묵이면(= Vite 기본값 'baseline-widely-available') Vite를 올리는 순간 하한선이
 * 소리 없이 움직인다. 마감 이틀 전에 그런 일이 나면 알아챌 방법이 없다. 그래서 지금
 * 기본값과 **같은 값을 그대로 고정**한다(빌드 산출물 해시 동일 — 회귀 위험 0).
 *
 * 이 목록이 하는 일이 CSS 쪽에서 특히 중요하다: Vite는 이 타깃으로 lightningcss를 돌려
 * CSS를 다운레벨한다. 실측 결과 `backdrop-filter` 13곳에 `-webkit-` 접두어가 **자동으로**
 * 붙는다(소스에는 0곳). color-mix()·:has()·@container는 이 하한선이 전부 지원하므로
 * 그대로 통과시킨다 — 51곳을 손으로 고칠 이유가 없었다.
 *
 * 왜 더 낮추지 않나: 경기 3D(three)·2D(pixi)가 WebGL을 요구하고 코드가 structuredClone·
 * Promise.withResolvers 같은 최신 API를 쓴다. 하한선을 내려도 그 브라우저에서 게임이
 * 돌아가지 않으니 번들만 커진다. 실측으로 Safari 26.5.2·Firefox 153이 전부 지원함을
 * 확인했다(docs/audit/compat/).
 */
const BROWSER_TARGET = ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: { target: BROWSER_TARGET },
})
