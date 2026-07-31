// src/ui/pitch/three/camera.ts
// Phase 4E 3D 매치 뷰 — 방송 카메라 워크(순수 수학 + 적용 헬퍼).
//
// 설계 원칙(Phase 4E Global Constraints):
//  - **three 무의존**: 이 모듈은 three를 import하지 않는다(타입조차). 카메라 객체는
//    scene.ts 번들이 소유하므로 {@link applyCamera}가 구조적 인터페이스({@link CameraLike})로
//    주입받아 갱신한다 → 엔트리 번들에 three가 새지 않고, 테스트도 three 없이 돈다.
//  - **Math.random·Date 금지**: 오퍼레이터 호흡·오빗 위상·셰이크까지 전부 시드 해시(hash01).
//    같은 (mode, focus, t, seed) → 완전히 같은 샷.
//  - **불변식**: 카메라는 피치 아래로 꺼지지도, 관중석 슬래브 **안**에 박히지도, 조명탑
//    마스트를 뚫지도 않는다. 모든 샷은 {@link clampShot}를 통과하며
//    `__tests__/camera-bounds.test.ts`가 전 모드 × 피치 전역 그리드로 이를 전수 검사한다.
//  - **reduced-motion**: 셰이크 진폭 0이면 정확히 0을 돌려준다(리그는 amp를 0으로 강제).
//
// 시간 t는 three Clock의 경과 초(표시 전용). 모드 전환 보간은 {@link createCameraRig}가 맡는다.
import { hash01 } from './textures'
import { PITCH_H, PITCH_W, type Vec3 } from './types'

/**
 * 카메라 연출 모드.
 *
 * 중계 문법상의 역할:
 *  - `broadcast` 기본 사이드 하이앵글(빌드업은 넓게, 박스 근처는 좁게)
 *  - `highlight`  슈팅·세이브 근접 컷
 *  - `set-piece`  코너·프리킥 — 박스 전체가 들어오는 높은 대각선
 *  - `goal-cam`   골 직후 골대 뒤 로우앵글
 *  - `reaction`   골대 뒤 다음에 끼우는 득점자 리액션 클로즈
 *  - `celebrate`  와이드 세리머니 오빗
 *  - `entrance`   입장 연출 와이드(터널·워크아웃) — 배역 23명이 한 프레임에 들어온다
 *  - `entrance-close` 입장 연출 클로즈(정렬·선수 소개) — 줄을 사선으로 훑는다
 */
export type CameraMode =
  | 'broadcast'
  | 'highlight'
  | 'goal-cam'
  | 'celebrate'
  | 'reaction'
  | 'set-piece'
  | 'entrance'
  | 'entrance-close'

/** 한 프레임의 카메라 상태(순수 값). */
export interface CameraShot {
  pos: Vec3
  lookAt: Vec3
  fov: number
}

/** 카메라가 따라갈 지점(FrameState.focus와 같은 모양). */
export interface Focus {
  x: number
  z: number
  /**
   * focus 주위로 **반드시 프레임에 담아야 할 반경(m)**. 생략·0이면 기존 동작 그대로.
   * `highlight`만 소비한다(FrameState.focusRadius가 정본 — movement가 계산한다).
   */
  r?: number
}

// ── 경기장 지오메트리(scene.ts 실측 미러) ─────────────────────────
// camera.ts는 three를 import하지 않으므로 scene.ts에서 값을 가져올 수 없다(코드 스플릿 계약).
// 그래서 여기 **복제**해 두고, `__tests__/camera-bounds.test.ts`가 두 파일의 값이 어긋나지
// 않는지 상수로 못 박는다. scene.ts의 스타디움 치수를 바꾸면 여기도 같이 고쳐야 한다.
/** 터치라인 밖 러너프(잔디) 폭 — scene.ts `APRON`. */
const APRON = 7
/** 관중석 경사(rad) — scene.ts `RAKE`. */
const STAND_RAKE = 0.5
const STAND_RAKE_TAN = Math.tan(STAND_RAKE)
/** 관중석 첫 열 높이(m) — scene.ts `STAND_H0`. */
const STAND_H0 = 2.4
/** 관중석 수평 깊이(m) — scene.ts `STAND_DEPTH`. */
const STAND_DEPTH = 26
/** 롱사이드 관중석 안쪽 경계 |z| — scene.ts `SIDE_INNER`(41). */
export const SIDE_STAND_INNER_Z = PITCH_H / 2 + APRON
/**
 * 골 뒤 관중석 안쪽 경계 |x| — scene.ts `END_INNER`(59.5).
 * **골 뒤 카메라는 이 선을 넘으면 안 된다** — 넘는 순간 관중 인스턴스 사이에 박혀
 * 화면 절반이 거대한 색 상자로 덮인다.
 */
export const END_STAND_INNER_X = PITCH_W / 2 + APRON
/**
 * 스탠드 풋프린트 안에 들어갈 때 좌석 표면 위로 확보해야 할 최소 여유(m).
 * 관중 박스(높이 ≈0.9+@)와 그 위 시야까지 감안한 값 — 이보다 낮으면 관중 머리가 렌즈를 덮는다.
 */
export const STAND_CLEARANCE = 6
/** 슬래브 끝의 뒷벽(inner+DEPTH+0.8, 두께 1.6) 앞에서 멈추기 위한 침투 상한. */
const STAND_MAX_PENETRATION = STAND_DEPTH - 2
/** 조명탑 마스트 중심 |x| — scene.ts `END_INNER + STAND_DEPTH*0.85`(81.6). */
export const MAST_X = END_STAND_INNER_X + STAND_DEPTH * 0.85
/** 조명탑 마스트 중심 |z| — scene.ts `SIDE_INNER + STAND_DEPTH*0.85`(63.1). */
export const MAST_Z = SIDE_STAND_INNER_Z + STAND_DEPTH * 0.85
/** 마스트(반경 ≤0.9, 높이 0~44) 회피 반경(m). */
export const MAST_CLEAR_R = 3

// ── 불변식(피치 밖·아래 이탈 금지) ────────────────────────────────
/** 카메라 최소 높이(m) — 잔디 아래로 내려가지 않는다. */
export const CAM_MIN_Y = 4
/**
 * 카메라 |z| 한계(m).
 *
 * 78이던 시절엔 사이드 스탠드(41~67)를 관통해 뒷벽 밖 허공까지 나갈 수 있었다.
 * 58이면 관중석 안이라도 좌석 표면에서 한참 위이고(높이 제약은 {@link clampShot}가 따로 건다),
 * 무엇보다 조명탑 마스트(|z|=63.1)와 {@link MAST_CLEAR_R}의 곱절 가까이 떨어져
 * **마스트 충돌이 구조적으로 불가능**해진다.
 */
export const CAM_MAX_Z = 58
/** 카메라 |x| 한계(m) — 엔드 스탠드 슬래브(59.5~85.5) 중간에서 끊는다(118 → 76). */
export const CAM_MAX_X = 76

// ── 위험도(중계 문법의 축) ────────────────────────────────────────
// "빌드업은 넓게, 마무리는 좁게". 카메라 파라미터를 focus의 위험도(가까운 골문까지의 거리)로
// **연속 보간**한다 — 이벤트 플래그로 확 바꾸면 컷처럼 튀어서 중계가 아니라 게임 UI가 된다.
/** 이 거리(m) 이상이면 위험도 0(완전 와이드). */
export const DANGER_FAR = 46
/** 이 거리(m) 이하이면 위험도 1(완전 타이트). 페널티 박스 대각 폭 근처. */
export const DANGER_NEAR = 16

// ── broadcast(기본 방송 앵글) ─────────────────────────────────────
/** 사이드라인 상단 카메라의 z(터치라인 바깥 -z 쪽) — 빌드업(위험도 0). */
export const BROADCAST_Z = -55
/** 위험도 1에서의 z — 6m 앞으로 나와 붙는다. */
export const BROADCAST_Z_TIGHT = -49
/** 사이드라인 상단 카메라의 높이(m) — 빌드업. */
export const BROADCAST_Y = 28
/** 위험도 1에서의 높이 — 낮춰서 골문을 정면에 가깝게 본다. */
export const BROADCAST_Y_TIGHT = 21
export const BROADCAST_FOV = 34
/** 위험도 1에서의 FOV — 박스 안 상황을 크게 잡는다. */
export const BROADCAST_FOV_TIGHT = 25
/** focus.x 추종 게인(<1 = 공간적 스무딩 — 카메라는 공보다 덜 움직인다). */
export const BROADCAST_FOLLOW = 0.62
/** 위험도 1에서의 추종 게인 — 마무리 국면에선 더 바짝 따라간다. */
export const BROADCAST_FOLLOW_TIGHT = 0.78
/** 좌우 팬 한계(m) — 카메라 카트의 레일 길이. */
export const BROADCAST_MAX_PAN = 26
/** 오퍼레이터 호흡(수동 카메라 느낌) 진폭(m). */
const BROADCAST_DRIFT = 0.35

// ── highlight(액션 존 근접) ───────────────────────────────────────
/** 빌드업(위험도 0)에서의 높이·거리·화각 — 넓게 본다. */
export const HIGHLIGHT_Y = 17
export const HIGHLIGHT_DIST = 40
export const HIGHLIGHT_FOV = 34
/** 마무리(위험도 1)에서의 높이·거리·화각 — 붙어서 좁게 본다. */
export const HIGHLIGHT_Y_TIGHT = 11
export const HIGHLIGHT_DIST_TIGHT = 24
export const HIGHLIGHT_FOV_TIGHT = 24

// ── 프레이밍(배역을 담는 최소 조건) ───────────────────────────────
// **왜 필요한가**(실측, tools/scene-timing): 20 m짜리 슛의 배역은 슈터와 접촉점 둘인데
// 타이트 프리셋(24° @ 24 m)의 가시 폭이 약 16 m다. 볼만 쫓으면 볼 도착 시각에 슈터가
// 프레임 밖(NDC x = -1.29 ~ -2.26)으로 밀린다 — "누가 찼는지"가 사라진다.
/** 프레이밍 반경 계산에 쓰는 최소 종횡비. 실제 뷰포트가 이보다 넓으면 여유가 더 생긴다. */
export const FRAME_ASPECT = 1.5
/** 배역 외접원 바깥에 남기는 여백(m) — 딱 맞게 담으면 팔다리가 프레임 선에 붙는다. */
export const FRAME_MARGIN = 2.5
/** 프레이밍이 요구할 수 있는 최대 화각. 이보다 넓히면 원근이 과장돼 중계로 안 읽힌다. */
export const HIGHLIGHT_FOV_WIDE = 38
/** 프레이밍이 요구할 수 있는 최대 거리(m). 이보다 물러나면 선수가 점이 된다. */
export const HIGHLIGHT_DIST_MAX = 40
/** 프레이밍으로 물러날 때 높이를 함께 올리는 상한 배수(부감이 과해지지 않게). */
const FRAME_Y_GAIN_MAX = 1.45

// ── set-piece(코너·프리킥 전용 하이 대각) ─────────────────────────
/** 박스 전체를 담기 위한 높이(m) — 롱사이드 스탠드 상단보다 훨씬 위. */
export const SET_PIECE_Y = 30
/** 프레이밍 타깃까지의 수평 거리(m). */
export const SET_PIECE_DIST = 44
export const SET_PIECE_FOV = 32

// ── reaction(골 → 골대 뒤 다음의 득점자 리액션 클로즈) ────────────
/** 리액션 컷의 수평 거리(m) — 상반신이 크게 잡히는 거리. */
export const REACTION_DIST = 13
/** 로우앵글 높이(m) — 득점자를 올려다보듯 잡는다. */
export const REACTION_Y = 5
export const REACTION_FOV = 30

// ── goal-cam(골대 뒤 로우 앵글) ───────────────────────────────────
export const GOAL_CAM_Y = 5.5
/**
 * 골라인에서 뒤로 물러난 거리(m).
 *
 * 12였을 때 카메라 x가 ±64.5로 {@link END_STAND_INNER_X}를 5m 넘어가 **관중석 안**에
 * 들어가 있었다(톤 계측 스크린샷에서 발견 — 골 순간 화면의 절반이 관중 박스였다).
 * 6이면 x=±58.5로 러너프 위, 네트(골라인+2m) 뒤 4m 지점이다. 실제 중계의
 * "골 뒤 로우 카메라"가 놓이는 자리이기도 하다.
 */
export const GOAL_CAM_BEHIND = 6
export const GOAL_CAM_FOV = 38
/** 골 뒤 카메라의 좌우 이동 한계(m) — 골대 폭 근처를 벗어나지 않는다. */
const GOAL_CAM_MAX_Z = 9

// ── entrance(입장 연출 전용) ──────────────────────────────────────
// **왜 broadcast를 쓰면 안 되는가**(실주행에서 발견한 결함):
// broadcast의 lookAt.z는 `fz * 0.55`다. 인플레이 focus(|z| ≲ 20)에서는 "시선을 피치
// 중앙 쪽으로 당겨 사이드라인 근처 공도 화면 가운데에 두는" 올바른 보정이지만,
// 입장 연출의 무대는 터치라인 바로 안쪽(z ≈ -34 ~ -25)이다. 거기서 이 보정은 시선을
// 배역보다 **15 m 더 먼 곳**에 꽂아 23명 전원을 화면 맨 아래로 밀어낸다.
// 실측(1600×900, 캔버스 1568×576): 터널 단계 배역의 NDC y가 -0.86 ~ -1.14 —
// 즉 화면 하단 7 % 띠에 몰리고 절반은 아예 프레임 밖이었다(캡처: 텅 빈 미드필드).
// 그래서 입장은 **lookAt.z를 보정 없이 그대로 쓰는** 전용 프리셋을 갖는다.
/** 와이드: 카메라 z(메인스탠드 쪽). 22 m 뒤로 물러나 무대 전체를 담는다.
 *
 *  ★ 여기서 더 물러나면 안 된다(2026-08-01 실측). -58·y=22로 밀었더니 렌즈가 메인스탠드
 *  구조물 **안**으로 들어가 화면 위 2/3가 검은 슬래브가 됐다({@link clampShot}은 좌석
 *  표면만 보고 지붕·뒷벽을 모르므로 통과시킨다). 넓힐 여지는 거리가 아니라 **화각**에 있다. */
export const ENTRANCE_Z = -56
/**
 * 와이드 높이(m). {@link clampShot}의 스탠드 침투 규칙상 z=-56(침투 15 m)에 서려면
 * 좌석 표면(2.4 + 15·tan0.5 = 10.6 m) + {@link STAND_CLEARANCE} = 16.6 m 이상이어야 한다.
 * 18은 그 위 1.4 m — 클램프에 걸리지 않으면서 부감이 과하지 않은 최저값이고,
 * 실주행에서 스탠드 구조물에 가리지 않는 것이 확인된 유일한 값이다(위 ENTRANCE_Z 주석).
 */
export const ENTRANCE_Y = 18
/**
 * 와이드 화각.
 *
 * ★ 2026-08-01: 34 → 44. 스토리보드 컷2가 두 팀을 좌우로 ±19 m까지 벌려 놓으므로
 * 예전 값으로는 양 끝 선수가 프레임 밖으로 나간다(실측: 34°에서 가시 반폭 19.3 m 대
 * 필요 21 m). 카메라를 더 물리는 길은 막혀 있으므로(ENTRANCE_Z 주석) 화각으로 푼다.
 * 44°면 가장 좁은 뷰포트 종횡비(CSS 공칭 105/68 = 1.544)에서도 반수평화각이
 * atan(tan22°·1.544) = 31.9°라, 41 m 거리에서 가시 반폭이 25.6 m다 — 19 m 무대에 6 m 여유.
 * 이보다 넓히면 원근이 과장돼 중계가 아니라 어안 렌즈로 읽힌다.
 */
export const ENTRANCE_FOV = 44
/** 시선 높이(m) — 선수 가슴. 발밑을 보면 하늘이, 머리를 보면 잔디가 절반을 먹는다. */
const ENTRANCE_LOOK_Y = 1.3
/**
 * 와이드에서 시선을 focus보다 이만큼 **피치 안쪽(+Z)에** 둔다(m).
 *
 * 0으로 두면(= 배역을 정확히 화면 중앙에 두면) 카메라가 메인스탠드 슬래브 안(z=-56)에
 * 있으므로 배역과 카메라 사이의 **가까운 관중석이 화면 아래 절반을 통째로 먹는다**
 * (실측: 배역이 NDC y≈-0.09, 스탠드 앞단이 -0.51). 8 m 앞을 보면 축이 9°쯤 올라가
 * 배역이 하단 1/3(NDC y≈-0.5)로 내려앉고 스탠드 앞단은 -1.0 밖으로 빠진다. 그러면
 * 프레임은 "잔디 + 선수 + 먼 관중석"이 되고, 걸어 나오는 방향(피치 안쪽)이 화면에 남는다.
 * broadcast의 `fz * 0.55`와 달리 **비례가 아니라 고정 오프셋**인 것이 중요하다 —
 * 비례 보정은 |fz|가 클수록 커져서 애초에 이 사고를 일으켰다.
 */
const ENTRANCE_LOOK_AHEAD = 8
/** 오퍼레이터 호흡 진폭(m) — broadcast와 같은 취지, 절반 세기. */
const ENTRANCE_DRIFT = 0.18

/**
 * 클로즈(정렬·소개): 줄을 **사선으로** 훑는다. 정면에서 보면 22 m짜리 줄이 화면 폭을
 * 넘지만, 사선이면 원근으로 접혀 여러 명이 들어오면서도 앞줄 선수의 번호가 읽힌다.
 * 방위각을 focus.x 부호로 뒤집지 않는 것이 핵심이다 — `reaction`을 재사용하던 시절
 * 소개가 6번째 선수(focus.x가 0을 통과)에서 카메라가 19 m 순간이동했다(같은 모드라
 * 리그의 0.6 s 전환도 타지 않는다).
 */
/**
 * ★ 2026-08-01: 14 → 18 m, 화각 31 → 37°.
 * 스토리보드 컷3·컷4는 한 줄 11명(폭 13.5 m)을 배경에 두고 **DOM 명단 패널**이 주인공이다.
 * 예전 값(14 m·31°)은 가장 좁은 종횡비에서 가시 반폭이 7.7 m라 줄의 절반만 담겼고,
 * 호명 선수가 줄 끝(중심에서 6.75 m)일 때 카메라를 그쪽으로 당기면 **반대쪽 끝이
 * 프레임 밖으로 밀려났다**(전수 검사 실측: NDC x = 1.01, 프레임 내 6/11).
 * 18 m·37°면 가시 반폭이 11 m라 팬을 걸어도 줄 전체가 남는다.
 */
export const ENTRANCE_CLOSE_DIST = 18
export const ENTRANCE_CLOSE_Y = 5.2
export const ENTRANCE_CLOSE_FOV = 37
/** 고정 사선 방위각(rad) — -π/2가 메인스탠드 정면, +0.55가 줄을 따라 눕히는 각이다. */
const ENTRANCE_CLOSE_AZ = -Math.PI / 2 + 0.55

// ── celebrate(득점팀 주위 오빗) ───────────────────────────────────
/**
 * 오빗 반경(m). 22였을 때 코너 근처 득점이면 카메라가 x=80.5·z=60까지 나가
 * 관중석 슬래브 **안**을 지나갔다(높이 9m, 그 지점 좌석 표면 13.9m).
 * 20 + 피벗 끌어당김({@link CELEBRATE_PIVOT_X}·{@link CELEBRATE_PIVOT_Z})으로 볼 안쪽에 가둔다.
 */
export const CELEBRATE_RADIUS = 20
/** 오빗 중심을 focus에서 피치 중앙 쪽으로 당기는 비율(x·z). */
export const CELEBRATE_PIVOT_X = 0.7
export const CELEBRATE_PIVOT_Z = 0.45
export const CELEBRATE_Y = 10
export const CELEBRATE_FOV = 36
/** 기본 오빗 각속도(rad/s). 시드로 ±15% 변주된다. */
export const CELEBRATE_OMEGA = 0.42

// ── 전환·셰이크 ───────────────────────────────────────────────────
/** 모드 전환 시간(s) — easeInOutCubic. */
export const TRANSITION_S = 0.6
/** 셰이크 감쇠 시상수(s). */
export const SHAKE_DECAY_S = 0.45
/** 셰이크 진폭 상한(m) — 입력이 아무리 커도 화면이 뒤집히지 않는다. */
export const SHAKE_MAX = 1.5
/** 이 아래로 감쇠하면 셰이크를 완전히 끈다. */
const SHAKE_EPS = 1e-4

const TAU = Math.PI * 2
const HALF_W = PITCH_W / 2
const HALF_H = PITCH_H / 2

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** 시드+살트 → 0~2π 위상(결정론). */
function phase(seed: number, salt: number): number {
  return hash01(Math.imul(seed | 0, 2654435761) ^ Math.imul(salt | 0, 40503)) * TAU
}

/** 시드+살트 → 0~1(결정론). */
function unit(seed: number, salt: number): number {
  return hash01(Math.imul(seed | 0, 374761393) ^ Math.imul(salt | 0, 668265263))
}

/**
 * (x,z)에서 관중석 좌석 슬래브의 표면 높이(m). 스탠드 풋프린트 밖이면 0.
 * 네 면을 각각 검사하지 않고 두 축의 침투량 중 큰 값을 쓴다 — 코너에서 두 스탠드가
 * 겹치므로 이쪽이 항상 보수적(더 높은 표면)이다.
 */
export function standSurfaceY(x: number, z: number): number {
  const pen = Math.max(Math.abs(x) - END_STAND_INNER_X, Math.abs(z) - SIDE_STAND_INNER_Z)
  if (pen <= 0) return 0
  return STAND_H0 + Math.min(pen, STAND_DEPTH) * STAND_RAKE_TAN
}

/**
 * 주어진 높이에서 관중석 안으로 들어가도 좋은 최대 침투 깊이(m).
 * 좌석 표면 + {@link STAND_CLEARANCE} 아래로는 절대 못 들어가고, 슬래브 끝(뒷벽) 앞에서 멈춘다.
 */
function maxPenetration(y: number): number {
  return clamp((y - STAND_H0 - STAND_CLEARANCE) / STAND_RAKE_TAN, 0, STAND_MAX_PENETRATION)
}

/**
 * 모든 샷이 통과하는 안전 클램프 — 카메라가 잔디 아래로 꺼지거나(y<{@link CAM_MIN_Y})
 * **관중석 안에 박히는 것**을 막는다. 셰이크·보간 결과에도 적용된다.
 *
 * 핵심은 높이에 따라 수평 한계가 달라진다는 점이다: 낮게 나는 샷은 스탠드 안쪽 경계
 * (|x|≤59.5, |z|≤41)를 아예 못 넘고, 높이 올라갈수록 경사면 위 공중을 그만큼 더 쓸 수 있다.
 * 예전처럼 |z|≤78·|x|≤118 같은 고정 박스로는 highlight·celebrate가 관중 사이를 통과했다.
 */
export function clampShot(shot: CameraShot): CameraShot {
  const y = shot.pos.y < CAM_MIN_Y ? CAM_MIN_Y : shot.pos.y
  const pen = maxPenetration(y)
  const limX = Math.min(CAM_MAX_X, END_STAND_INNER_X + pen)
  const limZ = Math.min(CAM_MAX_Z, SIDE_STAND_INNER_Z + pen)
  return {
    pos: { x: clamp(shot.pos.x, -limX, limX), y, z: clamp(shot.pos.z, -limZ, limZ) },
    lookAt: { ...shot.lookAt },
    fov: clamp(shot.fov, 18, 70),
  }
}

/**
 * focus의 "위험도" 0~1 — 가까운 골문까지의 거리로 계산하는 연속·단조 함수(smoothstep).
 * {@link DANGER_FAR} 밖이면 0(빌드업), {@link DANGER_NEAR} 안이면 1(마무리).
 * x=0에서도 좌우 골문까지 거리가 같아 값이 튀지 않는다.
 */
export function danger(fx: number, fz: number): number {
  const gx = fx >= 0 ? HALF_W : -HALF_W
  const d = Math.hypot(gx - fx, fz)
  const u = clamp((DANGER_FAR - d) / (DANGER_FAR - DANGER_NEAR), 0, 1)
  return u * u * (3 - 2 * u)
}

/**
 * 모드별 카메라 샷(순수 함수). 같은 인자면 항상 같은 값을 돌려준다.
 *
 * @param mode  연출 모드
 * @param focus 카메라가 볼 지점(FrameState.focus — 월드 XZ)
 * @param t     경과 시간(s, three Clock) — 호흡·오빗 위상에만 쓴다
 * @param seed  결정론 시드
 */
export function cameraFor(mode: CameraMode, focus: Focus, t: number, seed: number): CameraShot {
  // 볼이 라인 밖으로 튀어도 카메라 기준점은 경기장 근처에 묶어둔다.
  const fx = clamp(focus.x, -HALF_W - 6, HALF_W + 6)
  const fz = clamp(focus.z, -HALF_H - 4, HALF_H + 4)
  switch (mode) {
    case 'highlight':
      return clampShot(highlightShot(fx, fz, t, seed, focus.r ?? 0))
    case 'goal-cam':
      return clampShot(goalCamShot(fx, fz, t, seed))
    case 'celebrate':
      return clampShot(celebrateShot(fx, fz, t, seed))
    case 'reaction':
      return clampShot(reactionShot(fx, fz, t, seed))
    case 'set-piece':
      return clampShot(setPieceShot(fx, fz, t, seed))
    case 'entrance':
      return clampShot(entranceWideShot(fx, fz, t, seed))
    case 'entrance-close':
      return clampShot(entranceCloseShot(fx, fz, t, seed))
    default:
      return clampShot(broadcastShot(fx, fz, t, seed))
  }
}

/**
 * 사이드라인 상단 방송 카메라 — 레일 위에서 focus.x를 부분 추종한다.
 * 위험도({@link danger})가 오르면 앞으로 나오고·낮아지고·화각이 좁아지고·더 바짝 따라간다.
 */
function broadcastShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const g = danger(fx, fz)
  const follow = lerp(BROADCAST_FOLLOW, BROADCAST_FOLLOW_TIGHT, g)
  const pan = clamp(fx * follow, -BROADCAST_MAX_PAN, BROADCAST_MAX_PAN)
  // 수동 카메라의 미세한 호흡(결정론) — 완전 고정된 CG 느낌을 없앤다.
  const driftX = BROADCAST_DRIFT * Math.sin(t * 0.23 + phase(seed, 1))
  const driftY = 0.25 * Math.sin(t * 0.17 + phase(seed, 2))
  return {
    pos: {
      x: pan + driftX,
      y: lerp(BROADCAST_Y, BROADCAST_Y_TIGHT, g) + driftY,
      z: lerp(BROADCAST_Z, BROADCAST_Z_TIGHT, g),
    },
    // 카메라는 덜 움직여도 시선은 공을 정확히 문다.
    lookAt: { x: fx, y: 1.2, z: fz * 0.55 },
    fov: lerp(BROADCAST_FOV, BROADCAST_FOV_TIGHT, g),
  }
}

/** 화각 f(°)·거리 d(m)에서 프레임이 담는 수평 반폭(m). {@link FRAME_ASPECT} 기준. */
export function frameHalfWidth(fov: number, dist: number): number {
  return Math.tan((fov * Math.PI) / 360) * FRAME_ASPECT * dist
}

/**
 * 액션 존 근접 컷 — focus 기준 사이드라인 쪽에 선다.
 * 위험도에 따라 거리 40→24m, 높이 17→11m, 화각 34→24°로 **연속** 변한다.
 *
 * @param r 프레임에 담아야 할 배역 외접 반경(m). 0이면 예전과 완전히 같은 샷이다.
 *          0보다 크면 **줌을 먼저 풀고**(화각 ≤ {@link HIGHLIGHT_FOV_WIDE}) 그래도
 *          모자랄 때만 물러난다(거리 ≤ {@link HIGHLIGHT_DIST_MAX}) — 카메라를 먼저
 *          물리면 인물이 작아지지만 줌을 푸는 것은 실제 방송 카메라의 첫 반응이다.
 */
function highlightShot(fx: number, fz: number, t: number, seed: number, r = 0): CameraShot {
  const g = danger(fx, fz)
  const dist0 = lerp(HIGHLIGHT_DIST, HIGHLIGHT_DIST_TIGHT, g)
  const y0 = lerp(HIGHLIGHT_Y, HIGHLIGHT_Y_TIGHT, g)
  let dist = dist0
  let fov = lerp(HIGHLIGHT_FOV, HIGHLIGHT_FOV_TIGHT, g)
  const need = r > 0 ? r + FRAME_MARGIN : 0
  if (need > 0 && frameHalfWidth(fov, dist) < need) {
    // 1) 화각을 넓혀 본다.
    fov = Math.min(HIGHLIGHT_FOV_WIDE, (360 / Math.PI) * Math.atan(need / (FRAME_ASPECT * dist)))
    // 2) 화각 상한에서도 모자라면 물러난다.
    if (frameHalfWidth(fov, dist) < need) {
      dist = Math.min(HIGHLIGHT_DIST_MAX, need / (Math.tan((fov * Math.PI) / 360) * FRAME_ASPECT))
    }
  }
  // 공이 골문 쪽일수록 대각선으로 붙어 "공격 방향"이 화면에 담긴다.
  const bias = clamp(fx / HALF_W, -1, 1) * 0.42
  // 각도만 흔들어 focus와의 방향각만 미세하게 살아 있게 한다.
  const wobble = 0.05 * Math.sin(t * 0.5 + phase(seed, 3))
  const az = -Math.PI / 2 - bias + wobble
  return {
    pos: {
      x: fx + Math.cos(az) * dist,
      // 물러난 만큼만 높이를 올린다 — 낮은 렌즈로 멀리서 보면 앞 선수에 뒤 선수가 가린다.
      y: y0 * Math.min(FRAME_Y_GAIN_MAX, dist / dist0),
      z: fz + Math.sin(az) * dist,
    },
    lookAt: { x: fx, y: 1.4, z: fz },
    fov,
  }
}

/**
 * 세트피스(코너·프리킥) 전용 하이 대각 — 키커와 박스 안 인원이 한 프레임에 들어와야
 * "무슨 상황인지"가 읽힌다. 그래서 focus 자체가 아니라 **가까운 골문 앞 박스 중심**을
 * 프레이밍 타깃으로 잡고, 골라인 쪽에서 비스듬히 내려다본다.
 */
function setPieceShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const side = fx >= 0 ? 1 : -1
  // 박스 중심(골라인에서 11m 안쪽)과 focus의 중간 — 키커가 프레임 밖으로 나가지 않게 섞는다.
  const tx = lerp(fx, side * (HALF_W - 11), 0.55)
  const tz = fz * 0.45
  // 흔들림도 side를 곱해 좌우 코너가 정확히 거울상이 되게 한다(한쪽만 어색해지는 걸 막는다).
  const sway = 0.04 * Math.sin(t * 0.31 + phase(seed, 9))
  const az = -Math.PI / 2 - side * (0.62 + sway)
  return {
    pos: {
      x: tx + Math.cos(az) * SET_PIECE_DIST,
      y: SET_PIECE_Y,
      z: tz + Math.sin(az) * SET_PIECE_DIST,
    },
    lookAt: { x: tx, y: 1.6, z: tz },
    fov: SET_PIECE_FOV,
  }
}

/**
 * 골 리액션 클로즈 — 실제 중계 문법의 "골 → 골대 뒤 → 득점자 → 와이드" 중 세 번째 컷.
 * 득점 지점을 13m 앞에서 낮게 올려다본다. 코너 근처 득점이면 {@link clampShot}가 카메라를
 * 볼 안쪽으로 밀어 넣는데, 이 방향의 클램프는 **더 가까워지는 쪽**이라 클로즈 컷의 성격이
 * 깨지지 않는다(멀어지는 클램프였다면 앵글이 아니라 사고가 된다).
 */
function reactionShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const side = fx >= 0 ? 1 : -1
  const sway = 0.08 * Math.sin(t * 0.45 + phase(seed, 7))
  // 득점자가 카메라를 향해 달려오도록 공격 방향 앞쪽·사이드라인 쪽에 선다.
  const ang = -Math.PI / 2 + side * (0.55 + sway)
  return {
    pos: {
      x: fx + Math.cos(ang) * REACTION_DIST,
      y: REACTION_Y + 0.3 * Math.sin(t * 0.7 + phase(seed, 8)),
      z: fz + Math.sin(ang) * REACTION_DIST,
    },
    lookAt: { x: fx, y: 1.7, z: fz },
    fov: REACTION_FOV,
  }
}

/**
 * 입장 와이드 — 메인스탠드 정면에서 배역 무게중심을 정통으로 본다.
 *
 * 카메라 x가 focus.x를 **1:1로** 따라가는 것이 broadcast(게인 0.62)와 결정적으로 다르다.
 * 입장 무대는 x로 20 m 넘게 뻗어 있고 열의 중심이 x≈+6, 줄의 중심이 x≈-1로 옮겨 간다.
 * 게인을 1보다 작게 두면 그 차이만큼 배역이 화면 한쪽으로 쏠려 가로가 잘린다.
 * 시선 z는 focus.z 그대로다(보정 없음 — 이 프리셋의 존재 이유).
 */
function entranceWideShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  return {
    pos: {
      x: fx + ENTRANCE_DRIFT * Math.sin(t * 0.21 + phase(seed, 21)),
      y: ENTRANCE_Y + 0.2 * Math.sin(t * 0.15 + phase(seed, 22)),
      z: ENTRANCE_Z,
    },
    lookAt: { x: fx, y: ENTRANCE_LOOK_Y, z: fz + ENTRANCE_LOOK_AHEAD },
    fov: ENTRANCE_FOV,
  }
}

/** 입장 클로즈 — 고정 사선(좌우 반전 없음)으로 정렬한 줄을 따라 눕혀 본다. */
function entranceCloseShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const sway = 0.03 * Math.sin(t * 0.33 + phase(seed, 23))
  const az = ENTRANCE_CLOSE_AZ + sway
  return {
    pos: {
      x: fx + Math.cos(az) * ENTRANCE_CLOSE_DIST,
      y: ENTRANCE_CLOSE_Y + 0.15 * Math.sin(t * 0.19 + phase(seed, 24)),
      z: fz + Math.sin(az) * ENTRANCE_CLOSE_DIST,
    },
    lookAt: { x: fx, y: ENTRANCE_LOOK_Y + 0.25, z: fz },
    fov: ENTRANCE_CLOSE_FOV,
  }
}

/** 골대 뒤 로우 앵글 — focus에 가까운 골문 뒤에서 피치 안쪽을 본다. */
function goalCamShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const side = fx >= 0 ? 1 : -1
  const sway = 0.4 * Math.sin(t * 0.6 + phase(seed, 4))
  return {
    pos: {
      x: side * (HALF_W + GOAL_CAM_BEHIND),
      y: GOAL_CAM_Y,
      z: clamp(fz * 0.35 + sway, -GOAL_CAM_MAX_Z, GOAL_CAM_MAX_Z),
    },
    lookAt: { x: fx, y: 1.4, z: fz },
    fov: GOAL_CAM_FOV,
  }
}

/**
 * 세리머니 오빗 — 득점 지점 주위를 결정론 각속도로 완만히 돈다.
 * 오빗 중심은 focus를 피치 중앙 쪽으로 당긴 피벗이다(코너 득점에서도 원이 볼 안에 남는다).
 */
function celebrateShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const omega = CELEBRATE_OMEGA * (0.85 + unit(seed, 5) * 0.3)
  const ang = phase(seed, 6) + t * omega
  const px = fx * CELEBRATE_PIVOT_X
  const pz = fz * CELEBRATE_PIVOT_Z
  return {
    pos: {
      x: px + Math.cos(ang) * CELEBRATE_RADIUS,
      y: CELEBRATE_Y + 1.2 * Math.sin(ang * 0.5),
      z: pz + Math.sin(ang) * CELEBRATE_RADIUS,
    },
    lookAt: { x: fx, y: 1.6, z: fz },
    fov: CELEBRATE_FOV,
  }
}

/**
 * 골 순간 카메라 미세 흔들림(결정론). 축마다 다른 두 주파수를 섞어 기계적 반복을 없앤다.
 * 각 성분의 절댓값은 amp를 절대 넘지 않으며(가중치 합 = 1), amp ≤ 0이면
 * **정확히 0**을 돌려준다(reduced-motion 경로).
 *
 * @param t   경과 시간(s)
 * @param amp 진폭(m). 0 이하 → 무진동. {@link SHAKE_MAX}에서 포화.
 * @param seed 결정론 시드
 */
export function shake(t: number, amp: number, seed: number): Vec3 {
  if (!(amp > 0)) return { x: 0, y: 0, z: 0 }
  const a = amp > SHAKE_MAX ? SHAKE_MAX : amp
  const mix = (salt: number, f1: number, f2: number) =>
    0.62 * Math.sin(t * f1 + phase(seed, salt)) + 0.38 * Math.sin(t * f2 + phase(seed, salt + 32))
  return {
    x: a * mix(11, 31.7, 19.3),
    y: a * mix(12, 27.1, 41.9),
    z: a * mix(13, 23.5, 37.1),
  }
}

/** 표준 easeInOutCubic(0~1 밖은 클램프). */
export function easeInOutCubic(u: number): number {
  const x = clamp(u, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** 두 샷을 선형 보간한다(u는 0~1로 클램프). */
export function lerpShot(a: CameraShot, b: CameraShot, u: number): CameraShot {
  const k = clamp(u, 0, 1)
  if (k <= 0) return { pos: { ...a.pos }, lookAt: { ...a.lookAt }, fov: a.fov }
  if (k >= 1) return { pos: { ...b.pos }, lookAt: { ...b.lookAt }, fov: b.fov }
  return {
    pos: {
      x: lerp(a.pos.x, b.pos.x, k),
      y: lerp(a.pos.y, b.pos.y, k),
      z: lerp(a.pos.z, b.pos.z, k),
    },
    lookAt: {
      x: lerp(a.lookAt.x, b.lookAt.x, k),
      y: lerp(a.lookAt.y, b.lookAt.y, k),
      z: lerp(a.lookAt.z, b.lookAt.z, k),
    },
    fov: lerp(a.fov, b.fov, k),
  }
}

/**
 * three.PerspectiveCamera의 구조적 최소 계약. scene.ts 번들이 소유한 카메라를
 * three 의존 없이 갱신하기 위한 인터페이스다(테스트는 스텁으로 검증).
 */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): void }
  fov: number
  lookAt(x: number, y: number, z: number): void
  updateProjectionMatrix(): void
  /** 뷰포트 종횡비(w/h). three PerspectiveCamera가 가진 값 그대로.
   *  주어지면 {@link fovForAspect}가 **가로 화각을 보존**하도록 fov를 보정한다. */
  aspect?: number
}

/**
 * 좁은 화면에서 **가로 화각을 지키는** 세로 fov 보정(Hor+ 프레이밍).
 *
 * 왜 필요한가: three의 fov는 **세로** 화각이다. 캔버스가 {@link FRAME_ASPECT}보다
 * 좁아지면(세로로 긴 폰) 세로 화각은 그대로인데 가로만 잘린다 — 모든 샷 프리셋과
 * 프레이밍 계산이 FRAME_ASPECT 기준으로 캘리브레이션되어 있으므로, 390px 세로
 * 화면에서는 "슈터가 프레임 밖으로 밀리는" 그 결함이 그대로 재발한다.
 * 그래서 좁아진 비율만큼 세로 fov를 넓혀 **가로로 담기는 폭을 일정하게** 유지한다.
 * 넓은 화면(aspect ≥ FRAME_ASPECT)에서는 아무것도 하지 않는다 — 여유는 그냥 여유다.
 */
export function fovForAspect(fov: number, aspect?: number): number {
  if (!aspect || !(aspect > 0) || aspect >= FRAME_ASPECT) return fov
  const halfTan = Math.tan((fov * Math.PI) / 360) * (FRAME_ASPECT / aspect)
  return clamp((360 / Math.PI) * Math.atan(halfTan), 18, 70)
}

/**
 * 샷을 실제 카메라에 적용한다. **위치 → lookAt** 순서를 지키며,
 * FOV가 바뀐 프레임에만 투영행렬을 다시 만든다(매 프레임 재계산 낭비 금지).
 */
export function applyCamera(camera: CameraLike, shot: CameraShot): void {
  camera.position.set(shot.pos.x, shot.pos.y, shot.pos.z)
  const fov = fovForAspect(shot.fov, camera.aspect)
  if (camera.fov !== fov) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }
  camera.lookAt(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z)
}

export interface CameraRigOptions {
  /** 결정론 시드. 기본 1. */
  seed?: number
  /** 시작 모드. 기본 'broadcast'. */
  mode?: CameraMode
  /** true면 셰이크를 완전히 끈다(런타임 토글은 setReducedMotion). */
  reducedMotion?: boolean
  /** 모드 전환 시간(s). 기본 {@link TRANSITION_S}. */
  transition?: number
}

export interface CameraRigInput {
  focus: Focus
  /** 경과 시간(s, three Clock). */
  t: number
  /** 프레임 델타(s) — 내부에서 0~0.1로 클램프한다(탭 복귀 폭주 방지). */
  dt: number
  /** 주면 그 자리에서 applyCamera까지 수행한다. */
  camera?: CameraLike | null
}

export interface CameraRig {
  readonly mode: CameraMode
  /** 마지막으로 계산된 샷(셰이크 포함). */
  readonly shot: CameraShot
  /** 현재 셰이크 진폭(m). reduced-motion이면 다음 update에서 0이 된다. */
  readonly shakeAmp: number
  /** 전환 진행도 0~1(1이면 전환 없음). */
  readonly transitionU: number
  /** 모드 변경. 같은 모드면 무시된다. */
  setMode(mode: CameraMode, opts?: { instant?: boolean }): void
  /**
   * 골 순간 등 충격 주입(m, {@link SHAKE_MAX}에서 포화).
   * reduced-motion 강제는 update가 하므로 화면은 흔들리지 않는다.
   */
  impulse(amp: number): void
  setReducedMotion(value: boolean): void
  update(input: CameraRigInput): CameraShot
}

/**
 * 모드 전환 보간(easeInOutCubic 0.6s) + 셰이크 감쇠를 관리하는 적용 헬퍼.
 * 순수 계산은 {@link cameraFor}·{@link shake}가 담당하고, 리그는 시간 상태만 갖는다.
 */
export function createCameraRig(opts: CameraRigOptions = {}): CameraRig {
  const seed = opts.seed ?? 1
  const transition = opts.transition ?? TRANSITION_S
  let mode: CameraMode = opts.mode ?? 'broadcast'
  let reducedMotion = opts.reducedMotion === true
  let current: CameraShot = cameraFor(mode, { x: 0, z: 0 }, 0, seed)
  let from: CameraShot | null = null
  let elapsed = 0
  let amp = 0

  function setMode(next: CameraMode, o: { instant?: boolean } = {}): void {
    if (next === mode) return
    mode = next
    if (o.instant) {
      from = null
      elapsed = 0
      return
    }
    // 전환 중 재전환이면 "지금 보이는 화면"에서 다시 출발한다(점프 금지).
    from = { pos: { ...current.pos }, lookAt: { ...current.lookAt }, fov: current.fov }
    elapsed = 0
  }

  function update(input: CameraRigInput): CameraShot {
    const dt = clamp(input.dt, 0, 0.1)
    const target = cameraFor(mode, input.focus, input.t, seed)

    let base = target
    if (from) {
      elapsed += dt
      const u = transition > 0 ? clamp(elapsed / transition, 0, 1) : 1
      if (u >= 1) {
        from = null
      } else {
        base = lerpShot(from, target, easeInOutCubic(u))
      }
    }

    // reduced-motion 강제는 여기 한 곳에서만 한다(impulse·setReducedMotion은 상태만 바꾼다).
    if (reducedMotion) {
      amp = 0
    } else if (amp > 0) {
      amp = dt > 0 ? amp * Math.exp(-dt / SHAKE_DECAY_S) : amp
      if (amp < SHAKE_EPS) amp = 0
    }

    const jitter = shake(input.t, amp, seed)
    current =
      amp > 0
        ? clampShot({
            pos: { x: base.pos.x + jitter.x, y: base.pos.y + jitter.y, z: base.pos.z + jitter.z },
            lookAt: base.lookAt,
            fov: base.fov,
          })
        : base
    if (input.camera) applyCamera(input.camera, current)
    return current
  }

  return {
    get mode() {
      return mode
    },
    get shot() {
      return current
    },
    get shakeAmp() {
      return amp
    },
    get transitionU() {
      return from ? clamp(transition > 0 ? elapsed / transition : 1, 0, 1) : 1
    },
    setMode,
    impulse(next: number) {
      if (!(next > 0)) return
      amp = Math.min(Math.max(amp, next), SHAKE_MAX)
    },
    setReducedMotion(value: boolean) {
      reducedMotion = value
    },
    update,
  }
}
