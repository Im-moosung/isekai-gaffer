# UI 레이아웃 감사 하니스

`docs/research/ui-redesign.md` 감사에 쓴 스크립트. 코드는 건드리지 않고 실행 중인 앱만 관찰한다.

## 구성
- `auditfn.mjs` — 페이지에 주입되는 측정 함수. 반환값:
  `overflowX` / `docH` / `lowContrast`(WCAG) / `hOverflow` / `hidScroll`(스크롤·클립 은닉률)
  / `clippedLH`(한글 글리프 잘림) / `tinyTap` / `overlaps`(면적 20% 초과 박스 교차)
- `drive.mjs` — 랜딩 → 허브 → 워룸 → 킥오프 → 입장 → 경기 → 감독 타임 주행
- `drive2.mjs` — 브레이크 → 하프타임 → 후반 → 종료 → 기자회견 → 신문 주행 (`setTimeout` 워프로 90분 압축)
- `ending-drive.mjs` — 엔딩 7결말(우승·준우승·4강/8강/16강/32강 탈락·조별 탈락) × 4뷰포트
- `shootout-drive.mjs` — 토너먼트 무승부 → 승부차기 전 과정 → 기자회견 → 캠페인 반영

## 실행
```sh
npm i playwright-core          # 시스템 Chrome을 쓰므로 브라우저 다운로드 불필요
npm run dev                    # http://localhost:5173

VPS='[[1440,900],[390,844]]' SCHEME=light node docs/audit/drive.mjs
W=1440 H=900 WARP=20            node docs/audit/drive2.mjs

# 엔딩: 결말 7종 × 뷰포트 4종 (ONLY=champion 으로 하나만)
node docs/audit/ending-drive.mjs
# 승부차기: 32강 무승부 → 세팅 → 킥 → 승패 확정 → (FULLFLOW=1이면) 캠페인 반영까지
FULLFLOW=1 W=1440 H=900 node docs/audit/shootout-drive.mjs
SEED=6 NOEDIT=1        node docs/audit/shootout-drive.mjs   # 서든데스까지 가는 시드
```

`ending-drive.mjs`/`shootout-drive.mjs`는 **소스에 디버그 훅을 심지 않는다.** Vite dev 서버가
앱과 같은 URL로 모듈을 서빙한다는 점을 이용해 페이지에서 `import('/src/game/campaignStore.ts')`로
같은 store 인스턴스를 잡아 상태만 주입한다. 승부차기 하니스가 조작하는 것은 두 가지뿐이다 —
캠페인 단계(32강)와 풀타임 동점. 승부차기 자체와 캠페인 반영은 실제 경로로 돈다.
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
