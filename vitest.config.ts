import { defineConfig } from 'vitest/config'

// vitest 4.x에서 environmentMatchGlobs가 제거됨.
// .tsx 테스트는 파일 상단에 `// @vitest-environment jsdom` 주석으로 jsdom 환경을 지정한다.
// (ts 테스트는 기본 node 환경 유지)
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 90분 시뮬을 도는 테스트가 여럿 있고, 전체 병렬 실행에서 CPU 경합이 나면
    // 기본 5초를 넘긴다(단독 실행은 통과). 로직 문제가 아니라 스케줄링이라
    // 임계를 올린다 — 진짜 무한루프는 20초에서도 잡힌다.
    testTimeout: 20_000,
  },
})
