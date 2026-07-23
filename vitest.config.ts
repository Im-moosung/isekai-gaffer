import { defineConfig } from 'vitest/config'

// vitest 4.x에서 environmentMatchGlobs가 제거됨.
// .tsx 테스트는 파일 상단에 `// @vitest-environment jsdom` 주석으로 jsdom 환경을 지정한다.
// (ts 테스트는 기본 node 환경 유지)
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
})
