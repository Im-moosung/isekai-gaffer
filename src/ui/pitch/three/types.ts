/**
 * Phase 4E 3D 매치 뷰 — 공유 좌표계·타입 계약 (정본).
 *
 * 월드: 피치 105×68m, 원점은 센터서클. XZ 평면에 눕고 Y가 높이(three 표준).
 * 홈은 +X 방향으로 공격, 어웨이는 -X 방향으로 공격한다.
 * 이 파일은 표시 전용 계층의 계약이며 엔진 로직에 영향을 주지 않는다.
 */

// 치수 정본은 ../geometry(렌더러 3종 공용). 여기서는 기존 import 경로를 지키기 위해
// 그대로 재수출한다 — 3D 계층은 계속 './types'에서 가져다 쓴다.
export { PITCH_W, PITCH_H } from '../geometry'
import { PITCH_W, PITCH_H } from '../geometry'

/** 엔진 slotCoords(0~100, 0~100) → 월드 XZ */
export function toWorld(x: number, y: number): { x: number; z: number } {
  return { x: (x / 100 - 0.5) * PITCH_W, z: (y / 100 - 0.5) * PITCH_H }
}

/**
 * **표시 진영 부호** — 월드 프레임을 Y축 기준 180° 돌릴지(−1) 그대로 둘지(+1).
 *
 * 왜 필요한가는 `../ends.ts` 헤더 참조(④ 2D·3D 좌우 불일치 / ⑤ 후반 진영 교대).
 * 무브먼트는 이 값을 모른다 — 계산은 언제나 엔진 프레임에서 하고, **화면에 올리기 직전**
 * 한 번만 돌린다. 180° 회전은 등거리 변환이라 속도·yaw·상대 위치가 전부 보존되므로
 * 물리·인과(발 앵커링, GK 접촉, 킥 방향)에 손댈 것이 없다.
 */
export type EndsSign = 1 | -1

/**
 * 전반의 기본 부호. −1인 이유: 방송 카메라가 −Z 사이드라인에 있어 화면 오른쪽이 월드
 * −X이므로, 홈(월드 −X 진영)이 화면에서 **왼쪽으로** 공격해 2D 작전판과 반대였다.
 * 180° 돌리면 홈이 +X 진영에 서서 −X(=화면 오른쪽)로 공격한다 — 2D와 같다.
 */
export const FIRST_HALF_ENDS: EndsSign = -1

/** 이 팀이 공격하는 방향의 월드 X 부호. 엔진 프레임에서 홈은 +x로 공격한다. */
export function attackDirX(side: 'home' | 'away', s: EndsSign = FIRST_HALF_ENDS): number {
  return (side === 'home' ? 1 : -1) * s
}

/**
 * 프레임 한 장을 표시 진영으로 돌린다(순수 함수, 입력 불변).
 * `s === 1`이면 입력을 그대로 돌려준다 — 회전 비용도, 부동소수 오차도 없다.
 */
export function rotateFrame(f: FrameState, s: EndsSign): FrameState {
  if (s === 1) return f
  return {
    ...f,
    players: f.players.map(p => ({
      ...p,
      x: -p.x,
      z: -p.z,
      // yaw는 +X를 0으로 재는 각이므로 180° 회전은 π를 더하는 것과 같다.
      yaw: p.yaw + Math.PI,
      ...(p.vx != null ? { vx: -p.vx } : {}),
      ...(p.vz != null ? { vz: -p.vz } : {}),
    })),
    ball: { ...f.ball, x: -f.ball.x, z: -f.ball.z },
    focus: { x: -f.focus.x, z: -f.focus.z },
  }
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * 선수 액션. `header`는 2026-08-01 추가(득점 루트 5종 중 "크로스 → 헤더") — 무브먼트가
 * **임팩트 순간 공의 높이**를 보고 kick과 갈라 준다(movement.HEADER_MIN_Y).
 */
export type PlayerAction = 'idle' | 'run' | 'kick' | 'header' | 'celebrate' | 'dive' | 'down'

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
  /**
   * 월드 속도 벡터(m/s). **관성의 상태**다 — 다음 프레임의 가속도 클램프가 이 값에서
   * 출발한다(movement.A_ACCEL / A_BRAKE / A_LATERAL).
   *
   * 왜 speed만으로 부족한가: speed는 크기라서 방향 전환을 막지 못한다. 예전 무브먼트는
   * 위치만 상태로 들고 매 프레임 목표를 향해 직선 이동했고, 목표가 바뀌면 속도 벡터가
   * **한 프레임에** 꺾였다(실측 |Δv|/dt p99 320 m/s², 문헌 상한은 7~8). 얼음판을
   * 미끄러지는 인상의 직접 원인이다.
   *
   * 선택 필드인 이유는 구버전 프레임·단위 테스트가 폴백(관성 없음)으로 진입할 수 있게
   * 하기 위함이다 — 미지정이면 정지 상태에서 출발한 것으로 본다.
   */
  vx?: number
  vz?: number
  action: PlayerAction
  /** 액션 진행도 0~1 */
  actionT: number
  /**
   * 액션의 좌우 방향(±1). 현재는 GK 다이브 전용 — **볼이 향하는 쪽**을 무브먼트 레이어가
   * 계산해 넘긴다. 예전에는 렌더러가 선수 id 해시로 골라서 절반의 GK가 볼 반대쪽으로
   * 몸을 던졌다. 미지정이면 렌더러가 기존 해시 폴백을 쓴다.
   */
  actionDir?: number
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
  /**
   * 카메라가 focus 주위로 **반드시 담아야 할 반경(m)**. 0이면 기존 동작(볼 근접).
   *
   * 왜 필요한가: 슛 국면의 배역은 슈터와 골문 앞 접촉점 둘이고 그 사이가 15~20 m다.
   * 카메라가 볼만 쫓으면(=반경 0) 타이트 프리셋의 가시 폭 16 m 안에 슈터가 남지 않아
   * "누가 찼는지"가 프레임에서 사라진다. 무브먼트가 배역의 외접 반경을 계산해 넘기고
   * 카메라가 화각·거리로 그것을 담는다(camera.highlightShot).
   * 선택 필드인 이유는 구버전 프레임·단위 테스트가 폴백 경로를 타게 하기 위함이다.
   */
  focusRadius?: number
  event?: FrameEvent
}
