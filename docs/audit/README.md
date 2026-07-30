# UI 레이아웃 감사 하니스

`docs/research/ui-redesign.md` 감사에 쓴 스크립트. 코드는 건드리지 않고 실행 중인 앱만 관찰한다.

## 구성
- `auditfn.mjs` — 페이지에 주입되는 측정 함수. 반환값:
  `overflowX` / `docH` / `lowContrast`(WCAG) / `hOverflow` / `hidScroll`(스크롤·클립 은닉률)
  / `clippedLH`(한글 글리프 잘림) / `tinyTap` / `overlaps`(면적 20% 초과 박스 교차)
- `drive.mjs` — 랜딩 → 허브 → 워룸 → 킥오프 → 입장 → 경기 → 감독 타임 주행
- `drive2.mjs` — 브레이크 → 하프타임 → 후반 → 종료 → 기자회견 → 신문 주행 (`setTimeout` 워프로 90분 압축)

## 실행
```sh
npm i playwright-core          # 시스템 Chrome을 쓰므로 브라우저 다운로드 불필요
npm run dev                    # http://localhost:5173

VPS='[[1440,900],[390,844]]' SCHEME=light node docs/audit/drive.mjs
W=1440 H=900 WARP=20            node docs/audit/drive2.mjs
```
결과: 스크린샷 `docs/audit/shots/`, 측정 JSON `docs/audit/audit-*.json` (둘 다 gitignore).

## 주의
- `SCHEME=light`로 돌려야 한다. 전역 라이트 테마 누출(문서 R1)은 다크 OS 테마에서 발현하지 않는다.
- 회귀 게이트로 쓸 때의 기준: **모든 뷰포트에서 `overlaps` 0건 / `hidScroll` 0건 / `lowContrast` 0건.**
