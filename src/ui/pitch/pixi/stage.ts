// src/ui/pitch/pixi/stage.ts
// PixiJS 경기 렌더러의 "순수 수학" 계층 — pixi.js를 import하지 않는다(jsdom·노드에서
// 단위 테스트 가능). 안무 보간(bezier·easing)과 카메라 워크(줌 타깃·클램프·셰이크)의
// 결정론 수학만 담는다. 렌더 부수효과(캔버스·파티클 드로잉)는 PixiPitch/fx가 담당한다.
//
// 좌표계: choreography/slotCoords는 0~100 정규 좌표. 여기서는 실측 피치(105×68m)를
// "월드 좌표"로 삼고 toWorld()로 변환한다(카메라 클램프는 피치 실측 경계 기준).
import type { ChoreoStep } from '../choreography'

/** 실측 피치 크기(m) — 월드 좌표 단위. SVG PitchView와 동일 비율(105:68).
 *  정본은 ../geometry — 재수출해 기존 import 경로(`from './stage'`)를 유지한다. */
export { PITCH_W, PITCH_H } from '../geometry'
import { PITCH_W, PITCH_H } from '../geometry'

/** 하이라이트 카메라 줌 배율(액션 존 확대). */
export const ZOOM = 1.6

export interface Pt { x: number; y: number }

/** 안무 세그먼트별 이동 곡선 타입.
 *  pass=낮은 아크(부드러운 in-out) / shot=직선 가속(ease-in) /
 *  camera=줌 트윈(ease-out) / linear=등속 / ease=기본 in-out. */
export type EaseType = 'linear' | 'pass' | 'shot' | 'camera' | 'ease'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 0~100 정규 좌표 → 월드(105×68) 좌표. */
export function toWorld(p: Pt): Pt {
  return { x: (p.x / 100) * PITCH_W, y: (p.y / 100) * PITCH_H }
}

/** 타입별 easing 함수(입력·출력 모두 0~1). 결정론·순수. */
export function easeFor(type: EaseType): (t: number) => number {
  switch (type) {
    // 슛: 직선 가속(뒤로 갈수록 빨라짐) — 골문으로 꽂히는 느낌.
    case 'shot':
      return (t) => t * t
    // 패스: 부드럽게 출발·도착(낮은 아크의 시간축).
    case 'pass':
      return easeInOutQuad
    // 카메라: 빠르게 붙었다가 감속 정착.
    case 'camera':
      return (t) => 1 - Math.pow(1 - t, 3)
    case 'linear':
      return (t) => t
    default:
      return easeInOutCubic
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * 2차 베지에 곡선 위 점. p0=시작, p1=끝, ctrl=제어점, t∈[0,1].
 * B(t) = (1-t)²·p0 + 2(1-t)t·ctrl + t²·p1.
 */
export function bezierAt(p0: Pt, p1: Pt, ctrl: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u
  const b = 2 * u * t
  const c = t * t
  return {
    x: a * p0.x + b * ctrl.x + c * p1.x,
    y: a * p0.y + b * ctrl.y + c * p1.y,
  }
}

/**
 * 세그먼트 제어점. shot이면 직선(중점) — 가속감만으로 골문에 꽂힌다.
 * 그 외(pass 등)는 이동 방향 수직으로 살짝 휘어 "낮은 아크"를 만든다(결정론).
 * @param p0 시작점 @param p1 끝점 @param type 세그먼트 타입
 */
export function controlFor(p0: Pt, p1: Pt, type: EaseType): Pt {
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  if (type === 'shot' || type === 'linear') return mid
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1
  // 이동 방향에 수직인 단위벡터로 아크 높이(거리의 15%)만큼 휜다.
  const perp = { x: -dy / len, y: dx / len }
  const arc = len * 0.15
  return { x: mid.x + perp.x * arc, y: mid.y + perp.y * arc }
}

/**
 * 줌 상태에서 화면 밖(피치 경계 밖)이 보이지 않도록 초점을 클램프한다.
 * scale 배율에서 보이는 반폭 = (피치폭/2)/scale. 초점은 그 반폭만큼 경계에서 떨어져야
 * 한다 → [half, W-half] 범위로 클램프. scale=1이면 항상 중앙(클램프 무의미).
 * @returns 클램프된 월드 초점 좌표.
 */
export function clampFocus(x: number, y: number, scale: number): Pt {
  const halfW = PITCH_W / 2 / scale
  const halfH = PITCH_H / 2 / scale
  // 줌이 없으면(≤1) 피치 전체가 보이므로 중앙 고정.
  if (scale <= 1) return { x: PITCH_W / 2, y: PITCH_H / 2 }
  return {
    x: clamp(x, halfW, PITCH_W - halfW),
    y: clamp(y, halfH, PITCH_H - halfH),
  }
}

/**
 * 하이라이트 시퀀스의 특정 스텝을 향한 카메라 타깃(월드 좌표 + 배율).
 * 초점 = 해당 스텝 공 위치(월드), 배율 = zoom. 초점은 clampFocus로 경계 밖 줌 금지.
 * @param sequence  ChoreoStep 배열(0~100 좌표)
 * @param stepIndex 초점 대상 스텝(범위 밖이면 클램프)
 * @param zoom      줌 배율(기본 ZOOM)
 */
export function cameraTarget(
  sequence: ChoreoStep[],
  stepIndex: number,
  zoom: number = ZOOM,
): { x: number; y: number; scale: number } {
  if (!sequence || sequence.length === 0) {
    return { x: PITCH_W / 2, y: PITCH_H / 2, scale: 1 }
  }
  const i = clamp(Math.round(stepIndex), 0, sequence.length - 1)
  const w = toWorld(sequence[i].ball)
  const f = clampFocus(w.x, w.y, zoom)
  return { x: f.x, y: f.y, scale: zoom }
}

/**
 * 골 순간 카메라 셰이크 오프셋(월드 단위). progress 0→1로 진행하며 진폭이 감쇠한다
 * (0=최대 흔들림, 1=정지). sin/cos 결정론 — 테스트 가능.
 * @param progress01 셰이크 진행도(0~1)
 * @param amp        최대 진폭
 */
export function shakeOffset(progress01: number, amp: number): { dx: number; dy: number } {
  const p = clamp(progress01, 0, 1)
  const decay = 1 - p
  return {
    dx: Math.sin(p * Math.PI * 8) * amp * decay,
    dy: Math.cos(p * Math.PI * 6) * amp * decay,
  }
}
