// src/ui/pitch/scenes.ts
// 하이라이트 장면 라이브러리 — "미리 만들어 둔 고도화된 장면"의 정본.
//
// 왜 라이브러리인가: 엔진은 공간을 모른다. 엔진이 아는 것은 "9번이 슛했고 GK가 막았다"
// 뿐이고, 그 사이의 축구(누가 어디서 어떻게 빌드업했나)는 어디에도 없다. 연속 축구를
// 시뮬레이션하려면 두 번째 엔진이 필요하므로, 대신 **손으로 짠 장면**을 돌려 쓰고
// 등번호·이름·역할만 갈아끼운다.
//
// 장면 = 빌드업(공유) + 마무리(결과별). 쪼갠 이유는 결과를 엔진이 이미 정했기 때문이다 —
// "슛 → 세이브"로 끝나야 하는 장면에 골 마무리를 붙일 수 없다. 빌드업만 갈아끼우면
// 같은 결과라도 전개가 달라진다.
//
// ★ 빌드업의 키는 **유저가 워룸에서 고른 attackPattern**이다. 슬라이더를 움직이면
//   화면이 달라진다 — 지금까지 전술은 숫자로만 존재했고 눈에 보이지 않았다.
//
// 좌표계: home-프레임(좌→우 공격) 0~100. y는 "아래 전개"(y>50)로 저술하고
// 레인 변형이 위/아래·중앙으로 접는다. away 미러(100-x)는 choreography가 마지막에 한다.
// 랜덤·시간 의존 없음(결정론).
import type { AttackPattern } from '../../engine/types'

/** 볼 궤적 종류(구간 시작 스텝에 붙는다). movement.BallArcKind가 이 타입을 재사용한다. */
export type BallArc = 'ground' | 'pass' | 'shot' | 'cross'

/** 장면 키프레임 한 점(lane 매핑 전 저술 좌표). */
export interface ScenePoint {
  t: number
  ball: [number, number]
  /** 역할 슬롯 3개의 위치(순서 = 역할 순서). 스텝마다 같은 길이여야 보간된다. */
  movers: [number, number][]
  /** 이 스텝에서 시작하는 구간의 볼 궤적. 미지정이면 이벤트 타입으로 추론한다. */
  arc?: BallArc
}

/** 빌드업 종류 — attackPattern 4택과 1:1. */
export type BuildupId = 'central' | 'wing' | 'through' | 'outside'

/** 마무리 종류 — 엔진이 이미 정한 결과. */
export type FinishId = 'goal' | 'save' | 'miss' | 'shot' | 'chance'

/** 빌드업 실행 변형 하나(같은 전술 아이디어의 다른 실행). */
interface BuildupVariant {
  /** 키 접미어 — 'a'는 기본 실행, 'b'는 두 번째 실행. */
  vid: string
  /** 한국어 설명(스크린샷·디버그 라벨). */
  label: string
  points: ScenePoint[]
  /** 역할 슬롯 3개의 원형 좌표 — 실제 선수를 뽑을 때 이 지점에 가장 가까운 XI를 쓴다. */
  roles: [number, number][]
}

/** 빌드업 계열 — attackPattern 하나에 대응하는 "전술 아이디어" + 그 실행 변형들. */
interface Buildup {
  id: BuildupId
  /** 계열 라벨(워룸·분석보드에 그대로 뜬다 — 변형이 달라도 이건 안 바뀐다). */
  label: string
  variants: BuildupVariant[]
}

// ── 유저의 attackPattern → 빌드업 ────────────────────────────────────────
export const BUILDUP_BY_PATTERN: Record<AttackPattern, BuildupId> = {
  balanced: 'central',
  cross: 'wing',
  through: 'through',
  longshot: 'outside',
}

/**
 * 빌드업 4계열 × 실행 변형 2종. 전부 t 0 → 0.32에 3스텝으로 끝난다(마무리에 0.5~0.76을 남긴다).
 * FM 교훈대로 t=0에서 이미 공이 중원 이상에 있다 — 자기 진영에서 시작하는 긴 빌드업은
 * 하이라이트가 아니라 데드타임이다.
 *
 * ★ 왜 계열마다 변형이 둘인가: attackPattern이 계열을 고정하므로 한 경기의 빌드업은
 *   사실상 1종이었다. 그래서 경기 안에서 도달 가능한 조합이 (마무리 × 레인)뿐이었고,
 *   하이라이트 24개를 그 좁은 칸에 던지면 같은 그림이 3~4번 나오는 게 산술적으로 강제됐다.
 *   변형은 **같은 전술 아이디어의 다른 실행**이라 가독성(내 슬라이더가 화면에 보인다)은
 *   유지하면서 칸 수만 2배로 늘린다. 라벨은 계열 라벨 하나로 유지하는 이유도 그것이다.
 */
const BUILDUPS: Record<BuildupId, Buildup> = {
  // 균형 — 중앙에서 짧게 주고받으며 하프스페이스로 밀고 들어간다.
  central: {
    id: 'central',
    label: '중앙 짧은 연결',
    variants: [
      {
        vid: 'a',
        label: '중앙 3자 연결',
        roles: [[60, 50], [80, 50], [72, 26]],
        points: [
          { t: 0, ball: [36, 58], movers: [[30, 50], [48, 72], [52, 44]], arc: 'pass' },
          { t: 0.16, ball: [50, 44], movers: [[42, 56], [62, 70], [66, 48]], arc: 'pass' },
          { t: 0.32, ball: [66, 54], movers: [[58, 44], [76, 70], [80, 50]], arc: 'pass' },
        ],
      },
      {
        vid: 'b',
        label: '중앙 원투 벽패스',
        roles: [[62, 42], [80, 52], [70, 70]],
        points: [
          { t: 0, ball: [34, 44], movers: [[28, 54], [46, 66], [50, 40]], arc: 'pass' },
          // 벽패스 리턴은 지면 — 원터치로 되돌리는 공은 뜨지 않는다.
          { t: 0.16, ball: [48, 64], movers: [[40, 48], [60, 62], [64, 44]], arc: 'ground' },
          { t: 0.32, ball: [64, 46], movers: [[56, 52], [74, 66], [78, 44]], arc: 'pass' },
        ],
      },
    ],
  },
  // 크로스 — 측면을 타고 엔드라인까지 내려간 뒤 문전으로 올린다.
  wing: {
    id: 'wing',
    label: '측면 돌파 → 크로스',
    variants: [
      {
        vid: 'a',
        label: '터치라인 돌파',
        roles: [[74, 84], [80, 50], [72, 18]],
        points: [
          { t: 0, ball: [42, 66], movers: [[36, 54], [58, 80], [62, 48]], arc: 'pass' },
          // 터치라인 드리블은 지면(공중 패스가 아니다).
          { t: 0.16, ball: [60, 82], movers: [[50, 64], [72, 74], [74, 46]], arc: 'ground' },
          { t: 0.32, ball: [80, 88], movers: [[64, 70], [86, 62], [88, 42]], arc: 'ground' },
        ],
      },
      {
        vid: 'b',
        label: '풀백 오버래핑',
        roles: [[76, 80], [80, 50], [70, 22]],
        points: [
          { t: 0, ball: [40, 74], movers: [[34, 62], [54, 84], [58, 52]], arc: 'ground' },
          // 안으로 한 번 접었다가(하프스페이스) 다시 측면으로 내준다 — 오버래핑의 그림.
          { t: 0.16, ball: [58, 62], movers: [[48, 78], [70, 86], [72, 48]], arc: 'pass' },
          { t: 0.32, ball: [78, 86], movers: [[62, 80], [84, 64], [86, 44]], arc: 'ground' },
        ],
      },
    ],
  },
  // 중앙 침투 — 하프스페이스 스루패스로 수비 뒷공간을 짼다.
  through: {
    id: 'through',
    label: '스루패스 뒷공간 침투',
    variants: [
      {
        vid: 'a',
        label: '하프스페이스 스루',
        roles: [[64, 64], [80, 50], [72, 20]],
        points: [
          { t: 0, ball: [44, 50], movers: [[38, 60], [60, 64], [64, 40]], arc: 'pass' },
          // 스루패스는 뜨지 않는다 — 뜨면 수비가 따라붙는다.
          { t: 0.16, ball: [56, 62], movers: [[50, 52], [74, 72], [70, 42]], arc: 'ground' },
          { t: 0.32, ball: [78, 72], movers: [[62, 58], [84, 64], [80, 44]], arc: 'ground' },
        ],
      },
      {
        vid: 'b',
        label: '내려받아 원터치 스루',
        roles: [[66, 40], [80, 50], [72, 74]],
        points: [
          { t: 0, ball: [46, 62], movers: [[40, 54], [62, 68], [66, 44]], arc: 'pass' },
          { t: 0.16, ball: [58, 42], movers: [[52, 58], [76, 64], [72, 40]], arc: 'ground' },
          { t: 0.32, ball: [80, 62], movers: [[64, 50], [86, 58], [82, 42]], arc: 'ground' },
        ],
      },
    ],
  },
  // 중거리 — 박스 밖에서 좌우로 순환시켜 슈팅 각을 만든다.
  outside: {
    id: 'outside',
    label: '외곽 순환 → 중거리',
    variants: [
      {
        vid: 'a',
        label: '좌우 순환',
        roles: [[56, 50], [80, 50], [70, 78]],
        points: [
          { t: 0, ball: [40, 68], movers: [[34, 56], [56, 76], [60, 44]], arc: 'pass' },
          { t: 0.16, ball: [54, 36], movers: [[46, 60], [68, 70], [72, 46]], arc: 'pass' },
          { t: 0.32, ball: [68, 56], movers: [[58, 40], [80, 70], [84, 50]], arc: 'ground' },
        ],
      },
      {
        vid: 'b',
        label: '뒤로 빼주고 때리기',
        roles: [[58, 44], [80, 52], [70, 74]],
        points: [
          { t: 0, ball: [44, 34], movers: [[36, 46], [58, 66], [62, 40]], arc: 'pass' },
          { t: 0.16, ball: [58, 66], movers: [[48, 50], [70, 72], [74, 44]], arc: 'pass' },
          // 박스 앞으로 되빼주는 공 — 뒤에서 달려드는 선수가 때린다.
          { t: 0.32, ball: [66, 44], movers: [[60, 48], [82, 66], [80, 40]], arc: 'ground' },
        ],
      },
    ],
  },
}

/** 빌드업 실행 변형 수(계열마다 동일). 해시 모듈러가 이 수를 쓴다. */
export const BUILDUP_VARIANT_COUNT = 2

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/**
 * 마무리 변형 — **같은 엔진 결과를 다른 그림으로** 끝낸다.
 *
 * 왜 필요한가: 한 경기의 하이라이트는 goal·save·miss 세 종류가 거의 전부다(엔진 실측:
 * 2802건 중 miss 1156 · save 1033 · goal 597 · red 16, `shot`·`chance`는 그 분의 주인공으로
 * 뽑히지 않는다). 마무리가 3종뿐이면 (마무리 × 레인) = 18칸에 하이라이트 12개(한 쪽)를
 * 던지는 셈이라 반복이 산술적으로 강제된다. 결과는 엔진이 정하지만 **어디서 어떻게
 * 때렸는지**는 비어 있으므로, 그 빈칸을 채워 칸 수를 3배로 늘린다.
 *
 * 스텝 수는 늘리지 않는다 — 마무리는 항상 2스텝(chance는 1). 안무 계약(빌드업 3 + 마무리 2,
 * 마지막 t ≤ 0.8)을 렌더러·테스트가 고정하고 있다.
 */
interface FinishVariant {
  /** 키 접미어. */
  vid: string
  label: string
  /** launch → 슈팅 지점 전진율(0.55가 기존 그림). */
  adv: number
  /** 슈팅 지점 y의 전개 폭 유지 계수. 음수면 **반대쪽**에서 잡는다(컷백). */
  w: number
  /** 결과 지점 좌우 — 0=기존(수렴), +1=니어포스트, -1=파포스트. */
  post: -1 | 0 | 1
  /** 배달 구간을 지면으로 강제하는가(컷백은 뜨지 않는다). */
  ground: boolean
  /** [배달 t, 결과 t] — 변형마다 리듬도 달라진다. 마지막은 항상 ≤ 0.8. */
  t: [number, number]
}

const FINISH_VARIANTS: FinishVariant[] = [
  // a — 정면. 기존 그림 그대로(회귀 기준선).
  { vid: 'a', label: '정면 마무리', adv: 0.55, w: 0.35, post: 0, ground: false, t: [0.52, 0.74] },
  // b — 문전 원터치. 한 발 더 들어가 니어포스트로 밀어 넣는다.
  { vid: 'b', label: '문전 원터치', adv: 0.72, w: 0.15, post: 1, ground: false, t: [0.56, 0.76] },
  // c — 컷백. 엔드라인 쪽에서 되돌린 공을 반대쪽에서 때린다(배달은 지면, 파포스트).
  { vid: 'c', label: '컷백 되돌림', adv: 0.3, w: -0.45, post: -1, ground: true, t: [0.5, 0.72] },
]
export const FINISH_VARIANT_COUNT = FINISH_VARIANTS.length

/**
 * 마무리 — 빌드업의 마지막 점(launch)에서 이어 붙인다.
 * launch가 다르면 같은 마무리도 다른 그림이 된다: 중거리는 68에서, 크로스는 88에서 뜬다.
 *
 * @param variant 마무리 변형 인덱스(0=정면). 결과 자체는 절대 바뀌지 않는다 —
 *                골은 네트(99), 세이브는 GK 앞, 미스는 골문 밖으로 끝난다.
 */
function finishPoints(finish: FinishId, launch: [number, number], variant: number): ScenePoint[] {
  const V = FINISH_VARIANTS[variant]
  const [lx, ly] = launch
  // 마무리 접점 — launch에서 골문 쪽으로 전진. 하한 74는 중거리 계열이 "중거리"로 남게 한다.
  const dx = clamp(lx + (95 - lx) * V.adv, 74, 92)
  // 슈팅 지점 y. w>0이면 전개 쪽을 유지한 채 골문으로 수렴, w<0이면 반대쪽(컷백).
  const my = clamp(50 + (ly - 50) * V.w)
  // 전개한 쪽 부호 — 니어/파포스트는 이걸 기준으로 정한다.
  const sideSign = ly > 50 ? 1 : -1
  // 측면 전개는 크로스로 배달된다 — 그 구간만 높은 아크. 컷백은 지면.
  const deliverArc: BallArc = V.ground ? 'ground' : lx >= 78 && Math.abs(ly - 50) > 25 ? 'cross' : 'shot'
  const boxMovers: [number, number][] = [[clamp(dx - 8), ly], [clamp(dx + 3), 58], [clamp(dx + 1), 42]]
  const netMovers: [number, number][] = [[clamp(dx - 4), ly], [96, 56], [96, 44]]
  const [t0, t1] = V.t
  /** 골문 안 착지 y — post가 0이면 기존(슈팅 지점에서 수렴), 아니면 니어/파포스트. */
  const mouth = (spread: number, lo: number, hi: number) =>
    V.post === 0 ? clamp(50 + (my - 50) * spread, lo, hi) : clamp(50 + V.post * sideSign * (hi - 50) * 0.85, lo, hi)

  switch (finish) {
    case 'goal':
      return [
        { t: t0, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: t1, ball: [99, mouth(0.35, 44, 56)], movers: netMovers },
      ]
    case 'save':
      // GK가 쳐낸다 — 골라인 앞에서 멈춘다. 문전 원터치는 더 가까이서 막힌다.
      return [
        { t: t0, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: t1, ball: [V.post === 1 ? 94.5 : V.post === -1 ? 92.5 : 93.5, mouth(0.45, 43, 57)], movers: netMovers },
      ]
    case 'miss': {
      // 골문 밖 — 어느 쪽으로 얼마나 벗어나는지가 변형이다(골문 안으로는 절대 안 간다).
      const wideY = V.post === 0 ? (ly > 50 ? 84 : 16) : clamp(50 + V.post * sideSign * (V.post === 1 ? 13 : 22), 8, 92)
      return [
        { t: t0, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: t1, ball: [99, wideY], movers: netMovers },
      ]
    }
    case 'shot':
      // 블록·굴절 — 골문 바로 앞에서 멈춘다(세이브보다 얕고 미스처럼 벗어나지 않는다).
      return [
        { t: t0, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: t1, ball: [V.post === 1 ? 96 : V.post === -1 ? 94 : 95, mouth(0.3, 45, 55)], movers: netMovers },
      ]
    case 'chance':
      // 마무리 없이 박스까지만 — 골문에 닿지 않는다.
      return [{ t: t0 + 0.06, ball: [dx, my], movers: boxMovers, arc: 'pass' }]
  }
}

// ── 세트피스·반칙: 빌드업이 없는 독립 장면 ───────────────────────────────
/** 코너 — 깃발에서 문전으로. 레인 미러가 곧 좌/우 코너다. */
const CORNER_SCENE: ScenePoint[] = [
  { t: 0, ball: [99, 94], movers: [[88, 74], [92, 52], [86, 60]], arc: 'cross' },
  { t: 0.42, ball: [86, 50], movers: [[90, 58], [92, 46], [84, 64]], arc: 'ground' },
  { t: 0.75, ball: [91, 58], movers: [[92, 56], [94, 48], [88, 62]] },
]
/** 코너 역할 원형 — 키 큰 중앙 수비·스트라이커·키커. */
const CORNER_ROLES: [number, number][] = [[80, 50], [22, 38], [70, 84]]

/** 반칙 — 중원 충돌 후 정지. */
const FOUL_SCENE: ScenePoint[] = [
  { t: 0, ball: [50, 60], movers: [[48, 58], [54, 64], [44, 54]], arc: 'ground' },
  { t: 0.5, ball: [52, 60], movers: [[50, 59], [53, 63], [46, 55]] },
]
const FOUL_ROLES: [number, number][] = [[52, 60], [64, 50], [40, 60]]

// ── 레인 변형: 같은 장면을 위/아래·중앙으로 접는다(공짜 4배) ─────────────
/** 레인 6종 — s=상하 부호(좌우 반전 = 공짜 2배), k=중앙 압축 계수(전개 폭). */
const LANES: { s: 1 | -1; k: number; label: string }[] = [
  { s: 1, k: 1, label: '아래' },
  { s: -1, k: 1, label: '위' },
  { s: 1, k: 0.65, label: '중간-아래' },
  { s: -1, k: 0.65, label: '중간-위' },
  { s: 1, k: 0.35, label: '중앙-아래' },
  { s: -1, k: 0.35, label: '중앙-위' },
]
export const LANE_COUNT = LANES.length

/** 저술 y(아래 전개 기준) → 레인 y. */
function laneY(y: number, lane: number): number {
  const L = LANES[((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT]
  return clamp(50 + (y - 50) * L.s * L.k)
}

/** 장면 한 벌 — 좌표는 아직 home-프레임(away 미러는 호출자가 한다). */
export interface Scene {
  points: ScenePoint[]
  /** 역할 슬롯 원형 좌표(레인 적용 완료). 실제 선수 배정에 쓴다. */
  roles: [number, number][]
  /** 반복 측정·디버그용 키. 예: `wing.a/goal.c/L1`. */
  key: string
}

/** 이 이벤트에 붙일 마무리(없으면 세트피스·반칙 전용 장면). */
export type SceneFinish = FinishId | 'corner' | 'foul'

/** 장면 변형 축 — 레인 말고 나머지 둘. 생략하면 기준 변형(a/a)이다. */
export interface SceneVariants {
  /** 빌드업 실행 변형 0~1. */
  buildup?: number
  /** 마무리 변형 0~2. */
  finish?: number
}

/**
 * 장면을 조립한다 — 빌드업(attackPattern × 실행 변형) + 마무리(엔진 결과 × 마무리 변형) + 레인.
 *
 * @param pattern  공격 팀이 고른 공격 패턴(워룸 4택). 미지정은 'balanced'.
 * @param finish   엔진이 이미 정한 결과.
 * @param lane     레인 변형 0~5(결정론 해시로 고른다).
 * @param variants 빌드업·마무리 변형(결정론 해시로 고른다). 세트피스는 무시한다.
 */
export function buildScene(
  pattern: AttackPattern,
  finish: SceneFinish,
  lane: number,
  variants: SceneVariants = {},
): Scene {
  if (finish === 'corner') {
    // 코너는 좌/우만 의미가 있다(중앙 압축 레인은 코너 깃발을 중앙으로 끌어와 말이 안 된다).
    const l = lane % 2
    return {
      points: mapLane(CORNER_SCENE, l),
      roles: CORNER_ROLES.map(([x, y]) => [x, laneY(y, l)] as [number, number]),
      key: `corner/L${l}`,
    }
  }
  if (finish === 'foul') {
    const l = lane % 2
    return {
      points: mapLane(FOUL_SCENE, l),
      roles: FOUL_ROLES.map(([x, y]) => [x, laneY(y, l)] as [number, number]),
      key: `foul/L${l}`,
    }
  }
  const family = BUILDUPS[BUILDUP_BY_PATTERN[pattern]]
  const bv = family.variants[mod(variants.buildup ?? 0, BUILDUP_VARIANT_COUNT)]
  const fv = mod(variants.finish ?? 0, FINISH_VARIANT_COUNT)
  const launch = bv.points[bv.points.length - 1].ball
  const points = [...bv.points, ...finishPoints(finish, launch, fv)]
  return {
    points: mapLane(points, lane),
    roles: bv.roles.map(([x, y]) => [x, laneY(y, lane)] as [number, number]),
    key: `${family.id}.${bv.vid}/${finish}.${FINISH_VARIANTS[fv].vid}/L${mod(lane, LANE_COUNT)}`,
  }
}

/** 음수·초과 인덱스를 접는다(해시 % 는 양수지만 호출부가 직접 넘길 수도 있다). */
const mod = (v: number, n: number) => ((Math.trunc(v) % n) + n) % n

function mapLane(points: ScenePoint[], lane: number): ScenePoint[] {
  return points.map(p => ({
    t: p.t,
    ball: [clamp(p.ball[0]), laneY(p.ball[1], lane)] as [number, number],
    movers: p.movers.map(([x, y]) => [clamp(x), laneY(y, lane)] as [number, number]),
    ...(p.arc ? { arc: p.arc } : {}),
  }))
}

/** 빌드업 계열 라벨(스크린샷·디버그 HUD). 실행 변형이 달라도 계열 라벨은 하나다. */
export function buildupLabel(pattern: AttackPattern): string {
  return BUILDUPS[BUILDUP_BY_PATTERN[pattern]].label
}

/**
 * 라이브러리 총 조합 수 — (빌드업 계열 × 실행 변형) × (마무리 × 마무리 변형) × 레인 + 세트피스.
 *
 * ★ `total`은 라이브러리 크기일 뿐 **한 경기에서 도달 가능한 수가 아니다.** 경기 안에서는
 *   attackPattern이 계열을 고정하고(팀당 1계열) 하이라이트로 뽑히는 결과도 3종(goal·save·miss)
 *   뿐이라, 실제 칸 수는 팀당 `2 × 3 × 3 × 6 = 108`, 양 팀 216이다. 반복 게이트를 읽을 때는
 *   total이 아니라 이 216을 기준으로 판단해야 한다(highlight-mix.test.ts 주석 참조).
 */
export function sceneLibrarySize(): { open: number; setPiece: number; total: number; reachablePerMatch: number } {
  const finishes: FinishId[] = ['goal', 'save', 'miss', 'shot', 'chance']
  const open = Object.keys(BUILDUPS).length * BUILDUP_VARIANT_COUNT * finishes.length * FINISH_VARIANT_COUNT * LANE_COUNT
  const setPiece = 2 + 2 // corner 좌/우 + foul 위/아래
  // 한 경기 도달 가능: 양 팀 × (계열 1 × 실행 2) × (하이라이트 결과 3) × 마무리 변형 × 레인.
  const reachablePerMatch = 2 * BUILDUP_VARIANT_COUNT * 3 * FINISH_VARIANT_COUNT * LANE_COUNT
  return { open, setPiece, total: open + setPiece, reachablePerMatch }
}
