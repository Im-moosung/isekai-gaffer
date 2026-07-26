/**
 * Phase 4E 3D 매치 뷰 — 공유 좌표계·타입 계약 (정본).
 *
 * 월드: 피치 105×68m, 원점은 센터서클. XZ 평면에 눕고 Y가 높이(three 표준).
 * 홈은 +X 방향으로 공격, 어웨이는 -X 방향으로 공격한다.
 * 이 파일은 표시 전용 계층의 계약이며 엔진 로직에 영향을 주지 않는다.
 */

export const PITCH_W = 105
export const PITCH_H = 68

/** 엔진 slotCoords(0~100, 0~100) → 월드 XZ */
export function toWorld(x: number, y: number): { x: number; z: number } {
  return { x: (x / 100 - 0.5) * PITCH_W, z: (y / 100 - 0.5) * PITCH_H }
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export type PlayerAction = 'idle' | 'run' | 'kick' | 'celebrate' | 'dive' | 'down'

export interface PlayerPose {
  id: string
  side: 'home' | 'away'
  number: number
  /** 월드 X (-52.5 ~ +52.5) */
  x: number
  /** 월드 Z (-34 ~ +34) */
  z: number
  /** 바라보는 방향(rad, +X가 0) */
  yaw: number
  /** m/s — 러닝 사이클 속도·자세를 결정 */
  speed: number
  action: PlayerAction
  /** 액션 진행도 0~1 */
  actionT: number
  /**
   * 보폭 위상 0~1 (한 스트라이드 = 2보). 이동거리를 공유 보폭 모델
   * `strideLength(speed)`로 나눠 누적한 값이며, **액션과 무관하게 항상 진행**한다.
   * 렌더러(player3d)는 자체 위상을 적분하지 않고 이 값을 소비한다 —
   * 두 계층이 다른 보폭 모델을 쓰면 그 차이가 그대로 발 미끄러짐이 된다.
   * 선택 필드인 이유는 구버전 프레임·단위 테스트가 폴백 경로를 탈 수 있게 하기 위함이다.
   */
  gaitPhase?: number
}

export interface BallPose {
  x: number
  y: number
  z: number
  /** 회전 위상(rad) */
  spin: number
}

export type FrameEvent = 'goal-home' | 'goal-away' | 'shot' | 'save' | 'foul' | 'corner' | null

export interface FrameState {
  /** 22명 (홈 11 + 어웨이 11) */
  players: PlayerPose[]
  ball: BallPose
  /** 카메라가 바라볼 지점 */
  focus: { x: number; z: number }
  event?: FrameEvent
}
