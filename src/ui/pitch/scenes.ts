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

/** 빌드업 정의. */
interface Buildup {
  id: BuildupId
  /** 한국어 설명(스크린샷·디버그 라벨). */
  label: string
  points: ScenePoint[]
  /** 역할 슬롯 3개의 원형 좌표 — 실제 선수를 뽑을 때 이 지점에 가장 가까운 XI를 쓴다. */
  roles: [number, number][]
}

// ── 유저의 attackPattern → 빌드업 ────────────────────────────────────────
export const BUILDUP_BY_PATTERN: Record<AttackPattern, BuildupId> = {
  balanced: 'central',
  cross: 'wing',
  through: 'through',
  longshot: 'outside',
}

/**
 * 빌드업 4종. 전부 t 0 → 0.32에 3스텝으로 끝난다(마무리에 0.52~0.74를 남긴다).
 * FM 교훈대로 t=0에서 이미 공이 중원 이상에 있다 — 자기 진영에서 시작하는 긴 빌드업은
 * 하이라이트가 아니라 데드타임이다.
 */
const BUILDUPS: Record<BuildupId, Buildup> = {
  // 균형 — 중앙에서 짧게 주고받으며 하프스페이스로 밀고 들어간다.
  central: {
    id: 'central',
    label: '중앙 짧은 연결',
    roles: [[60, 50], [80, 50], [72, 26]],
    points: [
      { t: 0, ball: [36, 58], movers: [[30, 50], [48, 72], [52, 44]], arc: 'pass' },
      { t: 0.16, ball: [50, 44], movers: [[42, 56], [62, 70], [66, 48]], arc: 'pass' },
      { t: 0.32, ball: [66, 54], movers: [[58, 44], [76, 70], [80, 50]], arc: 'pass' },
    ],
  },
  // 크로스 — 측면을 타고 엔드라인까지 내려간 뒤 문전으로 올린다.
  wing: {
    id: 'wing',
    label: '측면 돌파 → 크로스',
    roles: [[74, 84], [80, 50], [72, 18]],
    points: [
      { t: 0, ball: [42, 66], movers: [[36, 54], [58, 80], [62, 48]], arc: 'pass' },
      // 터치라인 드리블은 지면(공중 패스가 아니다).
      { t: 0.16, ball: [60, 82], movers: [[50, 64], [72, 74], [74, 46]], arc: 'ground' },
      { t: 0.32, ball: [80, 88], movers: [[64, 70], [86, 62], [88, 42]], arc: 'ground' },
    ],
  },
  // 중앙 침투 — 하프스페이스 스루패스로 수비 뒷공간을 짼다.
  through: {
    id: 'through',
    label: '스루패스 뒷공간 침투',
    roles: [[64, 64], [80, 50], [72, 20]],
    points: [
      { t: 0, ball: [44, 50], movers: [[38, 60], [60, 64], [64, 40]], arc: 'pass' },
      // 스루패스는 뜨지 않는다 — 뜨면 수비가 따라붙는다.
      { t: 0.16, ball: [56, 62], movers: [[50, 52], [74, 72], [70, 42]], arc: 'ground' },
      { t: 0.32, ball: [78, 72], movers: [[62, 58], [84, 64], [80, 44]], arc: 'ground' },
    ],
  },
  // 중거리 — 박스 밖에서 좌우로 순환시켜 슈팅 각을 만든다.
  outside: {
    id: 'outside',
    label: '외곽 순환 → 중거리',
    roles: [[56, 50], [80, 50], [70, 78]],
    points: [
      { t: 0, ball: [40, 68], movers: [[34, 56], [56, 76], [60, 44]], arc: 'pass' },
      { t: 0.16, ball: [54, 36], movers: [[46, 60], [68, 70], [72, 46]], arc: 'pass' },
      { t: 0.32, ball: [68, 56], movers: [[58, 40], [80, 70], [84, 50]], arc: 'ground' },
    ],
  },
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/**
 * 마무리 — 빌드업의 마지막 점(launch)에서 이어 붙인다.
 * launch가 다르면 같은 마무리도 다른 그림이 된다: 중거리는 68에서, 크로스는 88에서 뜬다.
 */
function finishPoints(finish: FinishId, launch: [number, number]): ScenePoint[] {
  const [lx, ly] = launch
  // 마무리 접점 — launch에서 골문 쪽으로 55% 전진(중거리는 멀리서, 크로스는 문전에서).
  const dx = clamp(lx + (95 - lx) * 0.55, 78, 92)
  // 마무리 y는 골문 쪽으로 수렴한다(측면 전개도 결국 골문을 향한다).
  const my = ly + (50 - ly) * 0.65
  // 측면 전개는 크로스로 배달된다 — 그 구간만 높은 아크.
  const deliverArc: BallArc = lx >= 78 && Math.abs(ly - 50) > 25 ? 'cross' : 'shot'
  const boxMovers: [number, number][] = [[clamp(dx - 8), ly], [clamp(dx + 3), 58], [clamp(dx + 1), 42]]
  const netMovers: [number, number][] = [[clamp(dx - 4), ly], [96, 56], [96, 44]]

  switch (finish) {
    case 'goal': {
      const netY = clamp(50 + (my - 50) * 0.35, 44, 56)
      return [
        { t: 0.52, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: 0.74, ball: [99, netY], movers: netMovers },
      ]
    }
    case 'save': {
      // GK가 쳐낸다 — 골라인 앞에서 멈춘다.
      const gkY = clamp(50 + (my - 50) * 0.45, 43, 57)
      return [
        { t: 0.52, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: 0.74, ball: [93.5, gkY], movers: netMovers },
      ]
    }
    case 'miss': {
      // 골문 밖 — 전개한 쪽 바깥으로 벗어난다.
      const wideY = ly > 50 ? 84 : 16
      return [
        { t: 0.52, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: 0.74, ball: [99, wideY], movers: netMovers },
      ]
    }
    case 'shot': {
      // 블록·굴절 — 골문 바로 앞에서 멈춘다(세이브보다 얕고 미스처럼 벗어나지 않는다).
      const blockY = clamp(50 + (my - 50) * 0.3, 45, 55)
      return [
        { t: 0.52, ball: [dx, my], movers: boxMovers, arc: deliverArc },
        { t: 0.74, ball: [95, blockY], movers: netMovers },
      ]
    }
    case 'chance':
      // 마무리 없이 박스까지만 — 골문에 닿지 않는다.
      return [{ t: 0.58, ball: [dx, my], movers: boxMovers, arc: 'pass' }]
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
  /** 반복 측정·디버그용 키. 예: `wing/goal/L1`. */
  key: string
}

/** 이 이벤트에 붙일 마무리(없으면 세트피스·반칙 전용 장면). */
export type SceneFinish = FinishId | 'corner' | 'foul'

/**
 * 장면을 조립한다 — 빌드업(attackPattern) + 마무리(엔진 결과) + 레인.
 *
 * @param pattern 공격 팀이 고른 공격 패턴(워룸 4택). 미지정은 'balanced'.
 * @param finish  엔진이 이미 정한 결과.
 * @param lane    레인 변형 0~3(결정론 해시로 고른다).
 */
export function buildScene(pattern: AttackPattern, finish: SceneFinish, lane: number): Scene {
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
  const b = BUILDUPS[BUILDUP_BY_PATTERN[pattern]]
  const launch = b.points[b.points.length - 1].ball
  const points = [...b.points, ...finishPoints(finish, launch)]
  return {
    points: mapLane(points, lane),
    roles: b.roles.map(([x, y]) => [x, laneY(y, lane)] as [number, number]),
    key: `${b.id}/${finish}/L${((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT}`,
  }
}

function mapLane(points: ScenePoint[], lane: number): ScenePoint[] {
  return points.map(p => ({
    t: p.t,
    ball: [clamp(p.ball[0]), laneY(p.ball[1], lane)] as [number, number],
    movers: p.movers.map(([x, y]) => [clamp(x), laneY(y, lane)] as [number, number]),
    ...(p.arc ? { arc: p.arc } : {}),
  }))
}

/** 빌드업 라벨(스크린샷·디버그 HUD). */
export function buildupLabel(pattern: AttackPattern): string {
  return BUILDUPS[BUILDUP_BY_PATTERN[pattern]].label
}

/** 라이브러리 총 조합 수 — 빌드업×마무리×레인 + 세트피스. 테스트가 이 수를 고정한다. */
export function sceneLibrarySize(): { open: number; setPiece: number; total: number } {
  const finishes: FinishId[] = ['goal', 'save', 'miss', 'shot', 'chance']
  const open = Object.keys(BUILDUPS).length * finishes.length * LANE_COUNT
  const setPiece = 2 + 2 // corner 좌/우 + foul 위/아래
  return { open, setPiece, total: open + setPiece }
}
