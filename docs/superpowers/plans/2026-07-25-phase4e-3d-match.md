# Phase 4E: 3D 매치 뷰 (FM 스타일 방송 화면) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> 사용자 확정 지시: "동그라미가 아니라 개개인의 선수가 3D로 움직이는 것". 목표 수준 = **FM 3D 매치뷰급 스타일라이즈 3D**(포토리얼 아님).

**Goal:** broadcast 경기 화면을 three.js 3D로 교체 — 22명의 3D 선수가 포메이션대로 움직이고, 달리고, 차고, 골에 세리머니한다.

**Architecture:** raw three.js(imperative, r3f 미사용 — 기존 PixiPitch 패턴 계승). 표시 전용 **포지셔널 무브먼트 레이어**가 엔진 이벤트를 연속 위치로 변환. 렌더러 체인: **Match3D(WebGL2) → PixiPitch(2D) → PitchView(SVG)**.

## Global Constraints (전 태스크 공통 — 위반 시 리뷰 반려)

- **엔진 결정론 불변**: 3D는 순수 표시. 엔진 상태/결과에 쓰기 금지. 기존 493 테스트 무손상
- **외부 에셋 다운로드 전면 금지**: 선수·스타디움·잔디·번호 전부 코드 생성(지오메트리 + canvas 절차 텍스처). 라이선스 리스크 0
- **Date/Math.random 금지**: 표시 레이어도 시드 결정론(관중 색·미세 흔들림까지 인덱스 해시). 애니메이션 시간은 three Clock 사용(표시 전용이므로 허용, 로직 분기에 사용 금지)
- **성능 목표**: 22선수+스타디움 60fps(중급 노트북). 지오메트리·머티리얼 공유, 관중은 InstancedMesh, 실시간 그림자맵 금지(발밑 페이크 컨택트 섀도우)
- **폴백 체인**: WebGL2 불가·컨텍스트 로스·청크 로드 실패 → PixiPitch. 기존 PitchBoundary 확장. 크래시 금지
- **reduced-motion**: 카메라 셰이크·파티클·관중 웨이브 생략(선수 이동은 유지)
- **코드 스플릿**: three 청크 lazy(엔트리 번들 유입 금지 — build 후 grep 검증)
- 기존 DOM 레이어(GOAL 타이포·득점자 배너·티커·스코어버그·외침바)와 sfx/TTS는 **그대로 유지**. 3D는 피치 영역만
- 커밋 트레일러 동일

## 좌표계·타입 계약 (T1·T2·T3이 공유 — 반드시 이대로)

`src/ui/pitch/three/types.ts` (T1이 생성, 나머지는 import):

```ts
// 월드: 피치 105×68m, 원점 중앙. XZ 평면에 눕고 Y가 높이(three 표준).
// 홈은 +X 방향으로 공격, 어웨이는 -X 방향.
export const PITCH_W = 105   // X: -52.5 .. +52.5
export const PITCH_H = 68    // Z: -34 .. +34

/** 엔진 slotCoords(0~100, 0~100) → 월드 XZ */
export function toWorld(x: number, y: number): { x: number; z: number }
//   x: (x/100 - 0.5) * PITCH_W ,  z: (y/100 - 0.5) * PITCH_H

export interface Vec3 { x: number; y: number; z: number }
export interface PlayerPose {
  id: string
  side: 'home' | 'away'
  number: number
  x: number; z: number      // 월드 위치
  yaw: number               // 바라보는 방향(rad, +X가 0)
  speed: number             // m/s (러닝 사이클 속도·자세 결정)
  action: 'idle' | 'run' | 'kick' | 'celebrate' | 'dive' | 'down'
  actionT: number           // 액션 진행도 0~1
}
export interface BallPose { x: number; y: number; z: number; spin: number }
export interface FrameState {
  players: PlayerPose[]     // 22명
  ball: BallPose
  focus: { x: number; z: number }   // 카메라가 봐야 할 지점
  event?: 'goal-home' | 'goal-away' | 'shot' | 'save' | 'foul' | 'corner' | null
}
```

## 섹션: A = T1·T2·T3 (병렬 — 파일 완전 분리) → T4 → T5 ✋플레이테스트

---

### Task 1: 포지셔널 무브먼트 레이어 (순수 로직·TDD)

**Files:** Create `src/ui/pitch/three/types.ts`, `src/ui/pitch/three/movement.ts` / Test `src/ui/pitch/three/__tests__/movement.test.ts`
**의존:** 없음 (three import 금지 — 순수 TS)

**계약:**
- `toWorld`, 상수, 타입 = 위 계약 블록 그대로
- `computeFrame(input): FrameState` — 매 프레임 호출되는 **순수 함수**:
  ```ts
  interface FrameInput {
    state: MatchState            // engine/types
    minute: number               // 현재 분
    t: number                    // 분 내 진행도 0~1 (dwell 기준)
    prev: FrameState | null      // 직전 프레임(보간·속도 계산용)
    dt: number                   // 초 단위 델타(클램프 0~0.1)
    sequence: ChoreoStep[] | null // 기존 choreography buildSequence 결과(있으면 이벤트 안무 우선)
    sequenceSide: 'home'|'away'|null
    seed: number
  }
  ```
- 계산 규칙:
  1. **볼**: sequence 있으면 그 키프레임을 3D로 승격 — XZ는 기존 보간, **Y(높이)** 추가: 패스=낮은 포물선(peak 1.2m), 슛=상승 궤적(peak 2.5m), 코너/크로스=높은 아크(peak 6m), 그 외 지면(0.11m). sequence 없으면 볼은 중원에서 완만히 순환(점유 팀 쪽으로 드리프트)
  2. **선수 목표 위치**: 각 팀 lineup의 `slotCoords(formation, i, side)` → toWorld = 기본 포메이션 앵커. 여기에 (a) **볼 시프트**: 볼 X 위치에 따라 팀 전체가 ±8m 전후 이동(공격 시 전진, 수비 시 후퇴) (b) **수렴**: 볼과 가까운 3명은 볼 쪽으로 최대 12m 당김(거리 역비례) (c) **라인 유지**: GK는 골문 앞 6m 박스 내에서만 볼 X 따라 좌우 이동
  3. **이벤트 참여자**: sequence.movers는 안무 좌표를 직접 사용(우선)
  4. **스텝**: `prev` 위치에서 목표로 이동, 속도 클램프(최대 7.5 m/s, GK 5.5), 도착 시 감속. yaw = 이동 방향(정지 시 볼 방향)
  5. **액션**: speed>4 → 'run', 0.4~4 → 'run'(느린 사이클), <0.4 → 'idle'. 슛/패스 키프레임의 kicker → 'kick'(actionT = 해당 스텝 진행도). 골 이벤트 후 2초간 득점팀 전원 'celebrate'. save 시 GK 'dive'
  6. **focus**: 볼 위치(하이라이트 시) 또는 중앙(평시), 프레임 간 스무딩
- **결정론**: 같은 (state, minute, t, prev, dt, seed) → 같은 출력. Math.random/Date 금지

**TDD (필수 케이스):**
- toWorld 변환 정확성(코너 4점 + 중앙)
- 22명 반환·전원 피치 경계 내(±2m 여유 허용)
- 속도 클램프: dt=0.016에서 이동량 ≤ 7.5*dt
- 볼 시프트: 볼이 +X 끝일 때 홈 수비진이 전진해 있는지(평상시 대비 X 증가)
- GK 박스 이탈 없음
- 결정론: 동일 입력 2회 `toEqual`
- sequence 있을 때 movers가 안무 좌표를 따르는지, 볼 Y가 타입별 피크 범위인지

커밋: `feat(3d): 포지셔널 무브먼트 레이어 (표시 전용 순수 로직)`

---

### Task 2: 3D 씬 셸 — 피치·스타디움·조명·렌더러

**Files:** Create `src/ui/pitch/three/scene.ts`(씬 빌더, 순수 three), `src/ui/pitch/three/textures.ts`(canvas 절차 텍스처) / Test `__tests__/textures.test.ts`(캔버스 없는 환경 no-op·크래시 금지 위주)
**의존:** T1의 types.ts 상수만 (movement 로직 불필요)

**계약:**
- `buildScene(THREE, opts): SceneBundle` — `{ scene, camera, renderer 미포함(호출부 소유), pitchGroup, stadiumGroup, dispose() }`
- **피치**: PlaneGeometry(105×68) + `makePitchTexture(canvas)` — 잔디 mowing 줄무늬(교차 밝기) + 흰 라인 마킹(터치라인·센터서클·페널티박스·골에어리어·페널티스팟·코너아크) 전부 canvas 2D로 그려 CanvasTexture. anisotropy 최대
- **골대 2개**: 원통(포스트·크로스바, 흰색) + 네트(반투명 흰 그리드 — PlaneGeometry + 절차 알파 텍스처 또는 LineSegments 격자)
- **스타디움**: 4면 관중석(경사진 BoxGeometry/ExtrudeGeometry, 어두운 콘크리트 톤) + **관중 InstancedMesh**(작은 박스 ~4000개, 시드 해시로 색상 변주(홈/어웨이 컬러 섞임)·높이 미세 변주). `crowdWave(t, intensity)` 훅으로 Y 오프셋 애니메이션(골 시 점프)
- **조명**: HemisphereLight(하늘/잔디) + DirectionalLight(야간 경기장 톤, **castShadow=false**) + 은은한 AmbientLight. 톤: 야간 조명 경기 느낌(약간 차가운 백색)
- **컨택트 섀도우 헬퍼**: `makeContactShadow(THREE)` — 반투명 검정 원형 Mesh(선수 발밑용, T3이 사용)
- `dispose()`가 모든 geometry/material/texture 해제
- three는 **인자로 주입**(`buildScene(THREE, ...)`)해 테스트에서 mock 가능하게 하고 정적 import 금지(코드 스플릿 보장)

**TDD:** textures의 canvas 미지원 환경 안전(no-op 반환·throw 금지) / buildScene을 최소 three 스텁으로 호출해 dispose 호출 시 해제 카운트 검증(스텁 기반) / 상수 경계

커밋: `feat(3d): 피치·스타디움·조명 씬 (절차 텍스처, 외부 에셋 0)`

---

### Task 3: 3D 선수 캐릭터 — 관절 리그 + 러닝 사이클

**Files:** Create `src/ui/pitch/three/player3d.ts` / Test `__tests__/player3d.test.ts`(포즈 수학 순수 함수 위주)
**의존:** T1의 types.ts(PlayerPose)만

**계약:**
- `createPlayer(THREE, opts: { kit: number; accent: number; number: number; isGk: boolean }): PlayerRig`
  - `PlayerRig = { root: Object3D; apply(pose: PlayerPose, clockT: number): void; dispose(): void }`
- **리그 구조**(전부 코드 지오메트리, 높이 총 ~1.8m, 7.5등신 근사):
  - 머리(SphereGeometry, 스킨톤) + 머리카락 캡
  - 몸통(BoxGeometry 라운드 or CapsuleGeometry, **킷 컬러**) + 등번호(canvas 텍스처 Plane, 등 뒤 부착, 고대비)
  - 팔 2개: 숄더 그룹 → 상완 → 엘보 그룹 → 하완(스킨톤 손)
  - 다리 2개: 힙 그룹 → 허벅지(쇼츠 컬러) → 무릎 그룹 → 정강이(양말 컬러 accent) → 신발(어두운 박스)
  - 발밑 컨택트 섀도우(반투명 원)
  - GK는 킷 컬러 다르게(형광 계열) + 장갑
- **애니메이션 (`apply`)**:
  - `run`: 위상 = 누적거리 기반(속도 비례 주기), 힙/무릎/숄더/엘보 사인 회전(다리 반대 위상, 팔은 다리와 교차), 몸통 상하 바운스·좌우 롤, 속도 클수록 진폭·전경 기울기 증가
  - `idle`: 미세 호흡 + 체중 이동
  - `kick`: actionT로 백스윙→임팩트→팔로스루 다리 스윙, 상체 반동
  - `celebrate`: 두 팔 위로 + 점프(Y 오프셋 사인)
  - `dive`(GK): 몸통 회전 + 옆으로 눕는 포즈
  - yaw는 root.rotation.y
- **성능**: 지오메트리·머티리얼을 모듈 스코프에서 **공유 캐시**(킷 컬러별 머티리얼만 분기), 22 리그 생성 시 지오메트리 재생성 금지
- **순수 포즈 수학 분리**: `gaitAngles(speed, phase)` → `{ hipL, hipR, kneeL, kneeR, shoulderL, shoulderR, bounce, lean }`, `kickAngles(t)`, `celebrateOffset(t)` — three 무의존 순수 함수로 export(TDD 대상)

**TDD:** gaitAngles 위상 대칭(왼/오른 반대 위상)·속도 비례 진폭·범위 클램프 / kickAngles 단조 스윙·t 경계 / celebrateOffset 주기 / 결정론

커밋: `feat(3d): 절차적 3D 선수 캐릭터 (관절 리그·러닝 사이클)`

---

### Task 4: 방송 카메라 + 볼 + 골 FX

**Files:** Create `src/ui/pitch/three/camera.ts`(순수 카메라 수학 + 적용), `src/ui/pitch/three/fx3d.ts` / Test
**의존:** T1 types, T2 scene(주입), T3(간접)

**계약:**
- `cameraFor(mode, focus, t, seed): { pos: Vec3; lookAt: Vec3; fov: number }` — 순수 함수
  - `broadcast`: 사이드라인 상단(z ≈ -55, y ≈ 28), focus.x 추종(스무딩·클램프), FOV 34
  - `highlight`: 액션 존으로 하강·근접(y ≈ 14, 거리 35), FOV 30
  - `goal-cam`: 골대 뒤 낮은 앵글(골 방향)
  - `celebrate`: 득점팀 주위 완만 오빗(결정론 각속도)
  - 전환은 호출부에서 easeInOutCubic 보간(0.6s)
- `shake(t, amp, seed)` — 골 순간 미세 흔들림(reduced-motion 시 0)
- `fx3d.ts`: `goalBurst(THREE, color, at)` — 팀 컬러 파티클(Points 또는 작은 박스 InstancedMesh 60개, 중력·페이드, 1.5s 수명), `flashQuad(THREE, color)` — 카메라 앞 풀스크린 쿼드 알파 페이드(득점=밝게, 실점=어둡게). `dispose()` 필수
- 볼: `createBall(THREE)` — 구체 + 절차 텍스처(오각/육각 패턴 근사) + 회전(이동 방향·속도 기반 spin) + 컨택트 섀도우 + 짧은 트레일(이전 N 위치 반투명 구체 or 리본)

**TDD:** cameraFor 모드별 위치가 피치 밖·아래로 내려가지 않음(y>3, |z|<80), focus 추종 클램프, 결정론 / shake 진폭 한계·reduced-motion 0 / 파티클 초기 분포 결정론

커밋: `feat(3d): 방송 카메라 워크·3D 볼·골 FX`

---

### Task 5: 통합 — Match3D 컴포넌트·렌더러 체인·성능·토글

**Files:** Create `src/ui/pitch/three/Match3D.tsx` / Modify `src/ui/match/MatchScreen.tsx`(체인·토글), `match.css` / deps `three` / Test
**계약:**
- `Match3D` props = **기존 PixiPitch와 동일 계약**(`state, lastEvent, sequence, dwellMs, sequenceSide`) — 교체 드롭인
- 내부: useEffect 마운트 → WebGL2 체크 → dynamic `import('three')` → buildScene/createPlayer×22/createBall → rAF 루프에서 `computeFrame` → 리그 `apply` → 카메라 적용 → render. 리사이즈 대응, 언마운트 시 renderer.dispose + 전체 dispose(누수 0), `webglcontextlost` 리스너 → 폴백 상태 전환
- **렌더러 체인**: MatchScreen에서 `Match3D`(lazy) → 실패/미지원 시 `PixiPitch` → 그 실패 시 `PitchView`. 기존 PitchBoundary 재사용·확장
- **2D/3D 토글**: 스코어버그 옆 [3D]/[2D] 버튼, localStorage `rematch-render3d`(기본 3D). 심사·저사양 배려
- **성능 가드**: dpr = min(devicePixelRatio, 2), 프레임 예산 초과(연속 30프레임 45fps 미만) 시 관중 인스턴스 절반·파티클 비활성 자동 강등(1회, 로그 없이 조용히)
- 기존 DOM 레이어·sfx·TTS 무변경 유지 확인
- **번들 검증**: build 후 엔트리 청크에 `three` 시그니처 부재 grep

**TDD:** jsdom(WebGL 없음)에서 Match3D → PixiPitch 폴백 렌더 스모크 / 토글 localStorage / 기존 493 무손상
**검증:** dev 서버 스크린샷 4장(평시 브로드캐스트·하이라이트 근접·골 세리머니·2D 토글) + 엔트리 번들 수치 보고

커밋: `feat(3d): 3D 매치 뷰 통합 (렌더러 체인·2D/3D 토글·성능 가드)`

### ✋ 사용자 플레이테스트 체크포인트 (dev 서버)

## Phase 4B(마감 트랙)와의 관계
3D는 여기서 종료. 이후 배포·시연영상·README·기획서 마감(7/27)은 Phase 4B에서 진행. 3D가 7/28까지 품질 미달이면 **2D 토글을 기본값으로 전환**하는 것이 컷 규칙(기존 3D go/no-go 게이트 정신 계승).
