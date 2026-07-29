// src/ui/landing/camera.ts
// 랜딩 3D 배경 카메라 궤적 — three·React에 의존하지 않는 순수 모듈.
// StadiumBackdrop(렌더러)과 톤 계측 하네스, 회귀 테스트가 같은 정의를 공유한다.
// 왜 360° 풀 오빗을 버렸는가:
//   scene.ts의 조명탑 4기는 px = ±(59.5 + 26*0.85) = ±81.6, pz = ±(41 + 26*0.85) = ±63.1에
//   서 있다 → 원점 기준 방위각 ±37.7°·±142.3°(=atan2(63.1, 81.6) = 0.658rad), 원점 거리 103m.
//   반경 148m 풀 오빗은 한 바퀴에 이 4기를 전부 통과하고, 그때마다 마스트와 y=43의 발광
//   리그가 화면을 가로지르며 프레임의 1/6을 흰 덩어리로 태웠다(계측 스크린샷으로 확인).
//
// 새 구도: **골대 뒤 호(arc) 왕복**.
//   마스트 방위각 사이의 가장 넓은 빈 구간이 142.3°~217.7°(폭 75.4°)이고 그 중심이
//   골대 뒤 180°다. 여기서는 가까운 마스트 2기가 시야축에서 45° 이상 벗어나 절대 프레임에
//   들어오지 않고, 반대편 조명탑 2기는 200m 밖 프레임 상단에 halo로 남는다 —
//   "조명탑이 보이되 가리지는 않는" 유일한 각도다.

/** 오빗 기준 반경(m) — 골대 뒤 상단 관중석 눈높이. 가까운 조명탑이 프레임 밖으로 밀려나는 거리다. */
const ORBIT_R = 110
/** 카메라 높이(m) — 어퍼티어 눈높이. 잔디 mowing 줄무늬가 깔리고 반대편 스탠드가 다 보인다. */
const ORBIT_Y = 50
/**
 * 호의 중심 방위각(rad). 189.1°로, 마스트 없는 구간(142.3°~217.7°) 한복판에서 9° 비껴 있다.
 * 정면 대칭(180°)은 도면처럼 딱딱해서, 살짝 틀어 3/4 원근과 근경 스탠드 프레이밍을 얻는다.
 */
const ARC_CENTER = 3.3
/**
 * 왕복 진폭(rad ≈ 9.2°) — 호 범위는 180.8°~199.2°. 21:9 울트라와이드에서도 가까운 조명탑이
 * 프레임 폭의 1.29배 바깥에 남는다(landing-camera 회귀 테스트가 프러스텀으로 검증한다).
 */
const ARC_AMP = 0.16
/**
 * 왕복 각속도(rad/s) — 주기 약 121초. sin 왕복이라 끝점에서 속도가 0으로 수렴해
 * 급정거가 없고, 최대 각속도는 0.0083rad/s로 예전 풀 오빗(0.03)의 1/3.6이다(멀미 방지).
 */
const ARC_OMEGA = 0.052
/** 전후 달리(m)와 각속도 — 호와 다른 주기(약 170초)로 어긋나 궤적이 반복처럼 보이지 않는다. */
const DOLLY_AMP = 4
const DOLLY_OMEGA = 0.037
/** 상하 드리프트 진폭(m)과 각속도 — 손으로 든 카메라 느낌의 미세 호흡. */
const BOB_AMP = 1.2
const BOB_OMEGA = 0.11
/** 시야각. */
export const FOV = 38
/**
 * 시선 목표 높이(m). 피치 센터(6)가 아니라 스탠드 상단 높이를 본다 — 카메라를 위로 틀면
 * 반대편 조명탑 2기가 프레임 상단에 halo와 함께 들어오고(3D의 증거), 동시에 가까운
 * 조명탑은 시야축에서 더 멀어져 화면 밖으로 밀린다. 두 요구를 동시에 만족시키는 축이다.
 */
export const LOOK_AT_Y = 16


/** 랜딩 카메라 파라미터 묶음 — 계측 하네스(tools/tone-stats/harness.ts)와 테스트가 참조한다. */
export const LANDING_CAMERA = {
  fov: FOV,
  lookAt: { x: 0, y: LOOK_AT_Y, z: 0 },
  arcCenter: ARC_CENTER,
  arcAmp: ARC_AMP,
  arcOmega: ARC_OMEGA,
} as const

/**
 * 경과 시간 t(초)에서의 카메라 월드 좌표. three에 의존하지 않는 **순수 함수**라
 * 회귀 테스트가 궤적 전체를 샘플링해 "마스트를 관통하지 않는다"를 검증할 수 있다.
 * t=0은 호의 중심 = 정지 컷(prefers-reduced-motion에서 그리는 단 한 프레임)이다.
 */
export function landingCameraAt(t: number): { x: number; y: number; z: number } {
  const a = ARC_CENTER + ARC_AMP * Math.sin(t * ARC_OMEGA)
  const r = ORBIT_R + DOLLY_AMP * Math.sin(t * DOLLY_OMEGA)
  return {
    x: Math.cos(a) * r,
    y: ORBIT_Y + BOB_AMP * Math.sin(t * BOB_OMEGA),
    z: Math.sin(a) * r,
  }
}
