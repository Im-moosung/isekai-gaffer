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

`BASE` 환경변수로 서버 주소를 바꿀 수 있다. **전/후 비교의 정석**은 `git worktree`로 비교 대상
커밋을 따로 띄우고 두 서버를 같은 하니스로 재는 것이다 — 작업 트리를 되돌리지 않아도 된다.
```sh
git worktree add /tmp/before HEAD && ln -s "$PWD/node_modules" /tmp/before/node_modules
(cd /tmp/before && npx vite --port 5199 --strictPort) &
BASE=http://localhost:5199 VPS='[[1440,900]]' node docs/audit/drive.mjs   # before
```

## 경기 화면 전용 하니스 (`tools/match-layout/`)
정적 스냅샷으로는 못 재는 두 가지 — **캔버스 실측 크기**와 **캔버스 위 텍스트의 대비**.
```sh
node tools/match-layout/live.mjs --tag before   # 뷰포트별 캔버스 px·화면 점유율·오버레이 대비비
node tools/match-layout/pause.mjs               # 일시정지 실주행 증명(프레임 diff·분·외침 잠금)
```
둘 다 **실제 Chrome 창**(`channel:'chrome', headless:false`)을 띄우고, 계측 전에 연속 프레임
픽셀 diff로 rAF가 살아 있음을 먼저 확인한다. 헤드리스/백그라운드 탭에서는 rAF가 스로틀되어
캔버스가 얼어붙고, 그러면 "3D가 멈췄다"는 오진을 하게 된다.

## 주의
- `SCHEME=light`로 돌려야 한다. 전역 라이트 테마 누출(문서 R1)은 다크 OS 테마에서 발현하지 않는다.
- 회귀 게이트로 쓸 때의 기준: **모든 뷰포트에서 `overlaps` 0건 / `hidScroll` 0건 / `lowContrast` 0건.**
- 알려진 오탐 1건: `14-second-half`의 `div.bc-ticker__stack` 하드클립 ~50%. 티커의 **나가는 줄**을
  자르는 의도된 클립이다(자르지 않으면 애니메이션 도중 외침 버튼 위로 삐져나온다).
