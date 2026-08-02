// 바디랭귀지 미니 배지의 **문턱 정본**.
//
// 문턱이 SVG 작전판(PitchView)과 Pixi 렌더러(PixiPitch) 두 곳에 각각 하드코딩돼 있었다.
// 그래서 "🔥는 80부터"로 올리라는 요구가 왔을 때 한 곳만 고치면 같은 경기의 같은 선수가
// 렌더러에 따라 다른 얼굴을 하는 사고가 난다. 값 하나를 여기 두고 둘 다 여기서 읽는다.
//
// 🔥 문턱 80의 근거: 사기 초기값은 70이고 감쇠(engine/simulate.ts)는 90분에 걸쳐 50까지
// 내린다. 즉 **아무 개입도 없으면 🔥는 절대 뜨지 않는다.** 팀토크·외침·득점으로 감독이
// 10 이상을 밀어 올려야 붙는 배지다 — "모든 경기에서 전원 🔥"이던 화면(감사 결함 ③)의
// 반대편이 여기서 선다. 75였을 때는 팀토크 한 번이면 필드가 통째로 불붙었다.
//
// ※ 3D 이름표(three/nameplates.ts)에는 사기 칩이 **의도적으로 없다** — 누락이 아니라 판단이다.
//   그쪽 주석을 참조하고 여기 값을 가져다 붙이지 마라.
/** 이 사기 이상이면 자신감(🔥). */
export const MOOD_FIRE_MIN = 80
/** 이 사기 이하면 위축(😰). */
export const MOOD_WORRY_MAX = 35

/** 사기값 → 바디랭귀지 배지. 해당 없거나 사기를 모르면 null. 결정론(사기값만 참조). */
export function moodBadge(morale: number | undefined | null): string | null {
  if (morale == null) return null
  if (morale >= MOOD_FIRE_MIN) return '🔥'
  if (morale <= MOOD_WORRY_MAX) return '😰'
  return null
}
