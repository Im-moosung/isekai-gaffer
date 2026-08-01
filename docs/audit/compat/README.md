# 브라우저 호환성 감사 — Safari · Firefox · Chrome

**왜 했나.** 해커톤 심사는 배포 URL로 진행되고, 규정은 "주요 브라우저 환경에서 정상 실행",
"동적 인터랙션이 실제로 작동하지 않는 경우 해당 기능은 평가에서 제외"를 명시한다.
그런데 이 프로젝트의 하니스는 전부 `channel:'chrome'`이었다 — Chrome 밖은 한 번도 본 적이 없었다.

**결론(2026-08-01): 세 브라우저 모두 전 구간 완주. 심사에 치명적인 결함 0건.**

## 무엇으로 쟀나

| 도구 | 대상 | 무엇을 증명하나 |
|---|---|---|
| `tools/compat/drive.mjs` | playwright **webkit · firefox · chrome** (headed) | 랜딩→신문 전 구간 자동 주행 + 콘솔 전수 수집 |
| `tools/compat/probe.html` | **실제 Safari.app** | 기능 지원·한국어 TTS 음성·앱 콘솔 에러(같은 출처 iframe 후킹) |
| `tools/compat/safari-drive.html` | **실제 Safari.app** | 전 구간 자동 주행(부모가 iframe DOM을 직접 눌러 진행) |

실제 Safari.app을 밖에서 조종하려면 개발자 메뉴 + Apple Events 자동화 권한이 필요하고,
그건 사용자의 macOS 설정을 건드리는 일이다. 그래서 **같은 출처 iframe** 안에 앱을 띄우고
부모 페이지가 DOM으로 눌러 진행시키고 콘솔을 가로챈다. 스크린샷 한 장이 증거가 된다.

**rAF 함정 대응**: 세 엔진 모두 `headless:false`로 띄우고, 판정 전에 캔버스 **픽셀 diff + rAF 카운트**로
프레임 진행을 먼저 증명한다. 정지 화면에서 잰 수치는 전부 무의미하기 때문이다.

## 결과

산출물: `docs/audit/compat/{webkit,firefox,chromium}.json`, 캡처 `docs/audit/shots/compat-*`.

| 구간 | 실제 Safari 26.5.2 | playwright webkit | Firefox 153 | Chrome(기준) |
|---|---|---|---|---|
| 랜딩(three 배경) | ○ | ○ | ○ | ○ |
| 캠페인 허브 | ○ | ○ | ○ | ○ |
| 전술 센터(라인업·전술) | ○ | ○ | ○ | ○ |
| 입장 연출 | ○ | ○ | ○ | ○ |
| 경기 3D(three, WebGL2) | ○ | ○ | ○ | ○ |
| 배속 2x | ○ | ○ | ○ | ○ |
| 90분 완주 | ○ | ○ | ○ | ○ |
| 하프타임 작전판·교체 탭 | ○ | ○ | ○ | ○ |
| 풀타임 → 기자회견 → 신문 | ○ | ○ | ○ | ○ |
| 콘솔 **에러**(미처리 예외) | 0 | 0 | 0 | 0 |

**폴백으로 떨어진 것 없음** — 세 엔진 모두 `canvas.m3d-canvas`(three/WebGL2)로 그렸다.
Pixi·SVG 폴백은 한 번도 발동하지 않았다.

### 기능 지원 실측

| | 실제 Safari 26.5.2 | Firefox 153 | Chrome |
|---|---|---|---|
| `color-mix()` (51곳) | YES | YES | YES |
| `:has()` (8곳) | YES | YES | YES |
| `@container` (2곳) | YES | YES | YES |
| `backdrop-filter` / `-webkit-` | YES / YES | YES | YES |
| `oklch()` · `100dvh` · `text-wrap:balance` | YES | YES | YES |
| `structuredClone` (41곳) | YES | YES | YES |
| `crypto.getRandomValues` (2곳) | YES | YES | YES |
| `Promise.withResolvers` · `Array.toSorted` · RegExp `/v` | YES | YES | YES |
| WebGL / **WebGL2** | YES / YES | YES / YES | YES / YES |
| 한국어 TTS 음성 | **1개**(유나 ko-KR, local) | 9개 | 9개 |
| 제스처 없이 `speechSynthesis.speak` | **작동함** | 작동함 | 작동함 |

한국어 음성이 Safari에서 1개뿐인 것은 결함이 아니다 — `commentary-tts.ts`는 `lang`이 `ko`로
시작하는 **아무 음성이나** 잡고, 못 찾으면 `voiceschanged`로 재탐색한다. 실제 Safari에서
유나가 즉시 잡혔고 **제스처 없이도 발화가 시작**됐다(재생 루프가 타이머에서 `speak`를 부르므로
이게 막혔다면 중계가 통째로 침묵했을 것이다).

### 콘솔 전문

최종 주행(엔진당 단독, 2026-08-01): webkit 222s · firefox 212s · chromium 236s, 셋 다 신문 1면까지.

- **Firefox**: 경고 7건. 전부 `"WebGL context was lost."` — `three/host.ts`의 `webgl2Available()`가
  **탐지용 컨텍스트를 일부러 반납**할 때 Firefox가 남기는 알림이다(컨텍스트 상한 누수를 막는
  의도된 동작). 그 외 `WEBGL_debug_renderer_info is deprecated` 1건은 감사 도구가 부른 것.
- **Chrome**: `console.error` 1건 — `/api/narrate` **404**. AI 엔딩 서술의 키 없는 폴백
  경로이며 앱이 템플릿으로 정상 진행한다(브라우저와 무관, dev 서버에 `/api`가 없어서 나는 것).
- **WebKit**: `console.error` 0건. 앞선 주행에서 4건이 잡힌 적이 있는데 전부 주행 **끝난 뒤**
  개발 서버가 내려가서 난 HMR 웹소켓·리소스 실패였다(앱 결함 아님).
- **미처리 예외(pageerror)**: 세 엔진 모두 **0건**. 실제 Safari도 0건.

### 성능(경기 화면, 1440×900)

| | rAF/500ms | 3D 캔버스 |
|---|---|---|
| Chrome | 51 | 1440×900 |
| playwright webkit | 52 | 1440×900 |
| Firefox 153 | 51 | 1440×900 |

한 번은 Firefox만 18 rAF/500ms에 캔버스가 921×576으로 내려간 적이 있는데, 세 엔진을
동시에 돌리던 순간이었고 단독·재측정에서는 셋이 같았다. 브라우저 차이가 아니라 CPU 경합이며,
적응형 픽셀 스케일러가 제대로 반응한 결과다 — 해상도를 내려서라도 프레임을 지킨다.

### 소유권 밖에서 잡힌 것(HUD 정리 갈래)

주행 도중 `ReferenceError: mp3 is not defined @ src/ui/match/MatchScreen.tsx:251`가
**세 브라우저 모두**에서 났고 `<MatchScreen>`이 통째로 언마운트됐다. 다른 갈래가 그 파일을
편집하던 중(HMR)의 순간 상태이고 브라우저와 무관하다 — 직후 확인에서 해당 심볼은 정상
import돼 있었다. 그 갈래에서 커밋 전에 한 번 더 확인할 것.

## 빌드 단계 처방 — `color-mix()` 51곳을 손대지 않은 이유

Vite 8은 `build.cssTarget`(기본 `build.target` = `baseline-widely-available`)으로
**lightningcss를 돌려 CSS를 다운레벨**한다. 즉 이미 빌드 단계 처방이 걸려 있었다.
실측 증거: 소스에 `-webkit-backdrop-filter`가 **0곳**인데 `dist`에는 **13곳** 있다.

`baseline-widely-available`이 가리키는 하한선은 Chrome 111 · Edge 111 · Firefox 114 ·
Safari 16.4 · iOS 16.4다. 이 하한선이 `color-mix()`(Safari 16.2+ / FF 113+ / Chrome 111+)를
**전부 지원**하므로 lightningcss는 그대로 통과시킨다 — 그리고 그 판단이 옳다는 것을
실제 Safari 26.5.2 · Firefox 153 실측이 확인했다. 51곳을 손으로 고칠 이유가 없었다.

다만 그 하한선이 **암묵**이었다. Vite를 올리는 순간 소리 없이 움직인다. 그래서
`vite.config.ts`에 **같은 값을 그대로 명시**했다. 빌드 산출물 해시가 변경 전후 동일함을
확인했다(`index-BVYTRUJl.css` / `index-D2Oht3lD.js` — 회귀 위험 0).

**더 낮추지 않은 근거**: 경기 3D(three)가 WebGL2를, 코드가 `structuredClone`·
`Promise.withResolvers`를 요구한다. 하한선을 내려도 그 브라우저에서 게임이 돌아가지 않으니
번들만 커진다. 반대로 올릴 이유도 없다 — 지금 하한선에서 이미 전부 통과한다.

## 재현

```sh
npx vite --port 5199 --strictPort           # 개발 서버
node tools/compat/drive.mjs                  # webkit·firefox·chrome 전부
ENGINES=firefox node tools/compat/drive.mjs  # 하나만
open -a Safari http://localhost:5199/tools/compat/probe.html        # 실제 Safari 기능·음성·콘솔
open -a Safari http://localhost:5199/tools/compat/safari-drive.html # 실제 Safari 전 구간 주행
```
