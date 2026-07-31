// src/ui/pitch/ends.ts
// 진영(ends) — "이 분에 화면의 어느 쪽이 어느 팀의 골문인가"의 정본. 렌더러 3종 공용.
//
// 두 가지 문제를 한 규칙으로 푼다(2026-08-01 5라운드 피드백 ④⑤).
//
// ④ 2D와 3D의 공격 방향이 반대였다.
//    · 2D(SVG·Pixi): 엔진 x가 그대로 화면 x다 → 홈이 왼쪽 골문, **오른쪽으로 공격**한다.
//      방송 관례 그대로다.
//    · 3D: `toWorld`가 엔진 x를 월드 +X로 그대로 보내고 홈은 −X에서 +X로 공격하는데,
//      방송 카메라가 −Z 사이드라인(camera.BROADCAST_Z = −55)에 있다. three의
//      lookAt 규약에서 카메라 오른쪽 벡터는 cross(forward, up) = (0,0,1)×(0,1,0) = (−1,0,0),
//      즉 **화면 오른쪽이 −X**다. 그래서 3D만 홈이 왼쪽으로 공격하는 것처럼 보였다.
//    → 월드 데이터는 맞고 **화면에서만** 뒤집혀 보이는 문제이므로, 표시 직전에 피치를
//      Y축 기준 180° 돌린다. 미러가 아니라 **회전**이라는 점이 중요하다: 미러는 손잡이
//      (좌우 관계)를 뒤집어 왼쪽 윙어가 오른쪽에 서지만, 회전은 "반대편 터치라인에서 본
//      같은 경기"라 모든 상대 위치가 보존된다. 2D도 엔진 y가 아래로 커지고 3D는 +Z가
//      화면 위쪽이므로, x·y를 **함께** 뒤집어야 두 화면이 정확히 겹친다.
//
// ⑤ 후반에 진영을 바꾸지 않았다. 실제 축구는 하프타임에 좌우를 맞바꾼다. 물리적으로
//    이것도 **경기를 180° 돌리는 것**과 같으므로 같은 스위치를 한 번 더 토글하면 된다.
//
// 엔진은 이 파일을 모른다 — 순수 표시 계층이다(엔진 좌표계는 언제나 "홈이 +x로 공격").
import type { MatchState } from '../../engine/types'

/** 전반이 끝나는 분. 이 분까지가 전반이고 다음 분부터 진영이 바뀐다. */
export const HALF_MINUTE = 45

/**
 * 이 분에 진영이 바뀌었는가(= 후반인가).
 *
 * 45분 하프타임 이벤트까지는 전반으로 본다. 전환 순간에 화면이 튀지 않는 이유:
 * 하프타임에는 재생이 멈추고 작전판이 올라오므로, 다음 프레임이 그려질 때는 이미
 * 새 분(46분)이고 장면도 새로 컷된다.
 */
export function endsSwapped(minute: number): boolean {
  return minute > HALF_MINUTE
}

/** 상태에서 바로 — 호출부가 분을 따로 들고 다니지 않게. */
export function endsSwappedFor(state: Pick<MatchState, 'minute'>): boolean {
  return endsSwapped(state.minute)
}

/**
 * 엔진 0~100 좌표 → **표시 0~100 좌표**(2D SVG·Pixi 공용).
 * 진영이 바뀌면 피치를 180° 돌린다 — x·y를 함께 뒤집는다.
 */
export function displayCoord<T extends { x: number; y: number }>(c: T, swapped: boolean): { x: number; y: number } {
  return swapped ? { x: 100 - c.x, y: 100 - c.y } : { x: c.x, y: c.y }
}

/** 0~100 x 하나만. */
export const displayX = (x: number, swapped: boolean): number => (swapped ? 100 - x : x)
/** 0~100 y 하나만. */
export const displayY = (y: number, swapped: boolean): number => (swapped ? 100 - y : y)
