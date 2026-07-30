// src/ui/pitch/geometry.ts
// 피치 실측 치수(m)의 **단일 출처**. SVG(PitchView) · Pixi(PixiPitch) · three(types/textures)
// 세 렌더러가 각자 같은 숫자를 리터럴로 들고 있었고, 그 사이에서 이미 미세 드리프트가
// 났다(페널티 폭 40.3 vs 40.32 — 아래 주석 참조). 한 렌더러의 마킹을 고치면 나머지가
// 조용히 어긋나므로 숫자를 여기 한 곳에 모은다.
//
// 이 파일은 **의존성이 0**이다(three·pixi·react 모두 무관). 엔트리 청크가 이 모듈을
// 가져가도 3D/2D 청크 분리에 영향이 없다 — 코드 스플릿 유지가 목적이다.

/** 실측 피치 크기(m). 월드 좌표 단위이자 SVG viewBox 비율(105:68). */
export const PITCH_W = 105
export const PITCH_H = 68

/** 센터서클 반지름 = 페널티 아크 반지름. */
export const CENTER_CIRCLE_R = 9.15

/** 페널티 에어리어 깊이: 골라인에서 16.5m. */
export const PENALTY_BOX_D = 16.5
/**
 * 페널티 에어리어 폭(경기 규칙 값 40.32m).
 * ⚠ 2D 렌더러(PitchView·PixiPitch)는 예전부터 40.3을 쓴다. 0.02m 차이라 화면상
 * 서브픽셀이지만 **값이 다른 것은 사실**이므로 통일하지 않고 남겨 보고한다
 * (리팩터링 커밋에 렌더 결과 변경을 섞지 않는다).
 */
export const PENALTY_BOX_W = 40.32

/** 골 에어리어 깊이: 골라인에서 5.5m. */
export const GOAL_AREA_D = 5.5
/** 골 에어리어 폭(경기 규칙 값 18.32m). 2D는 18.3 — PENALTY_BOX_W와 같은 사정. */
export const GOAL_AREA_W = 18.32
