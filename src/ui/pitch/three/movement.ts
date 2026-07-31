// src/ui/pitch/three/movement.ts
// Phase 4E 3D 매치 뷰 — 포지셔널 무브먼트 레이어(순수 로직·표시 전용).
//
// 엔진이 만든 "분 단위 이벤트"를 22명의 연속 위치·자세로 번역한다. 이 파일은
// three를 import하지 않는 순수 TS이며, 엔진 상태를 읽기만 한다(쓰기 금지).
//
// 설계 원칙:
//  - **결정론**: Math.random·Date 금지. 미세 변형은 FNV-1a 시드 해시로만 만든다.
//    같은 (state, minute, t, prev, dt, seed) → 같은 FrameState.
//  - **표시 전용**: 여기서 나온 좌표는 렌더러만 소비한다. 엔진 결과에 영향 없음.
//  - **텔레포트 금지**: prev가 있으면 모든 선수는 속도 클램프를 통과한다(7.5 m/s,
//    GK 5.5 m/s). prev=null(첫 프레임)일 때만 목표 위치로 스냅한다.
//  - 좌표계·타입 계약은 ./types.ts가 정본이다.
import type { MatchEvent, MatchEventType, MatchState, SideState } from '../../../engine/types'
import { attackingSideOf, type BallArc, type ChoreoStep } from '../choreography'
import { possessingSide } from '../flow'
import { FOOT_OFFSET_M } from '../scenes'
// 정적 배치의 정본은 **전술이 반영된** 좌표다. slotCoords(포메이션 원형)를 쓰면
// 라인 높이를 올린 유저가 라이브(3D)→분석(2D) 디졸브에서 수비진이 최대 15m
// 미끄러지는 것을 본다 — 3D와 2D 작전판은 같은 숫자에서 파생돼야 한다.
import { tacticalCoords } from '../shape'
// 보폭 모델은 표시 계층 전체가 **하나**를 공유한다(player3d가 정본).
// player3d는 three를 정적 import하지 않으므로 이 import로 번들이 커지지 않는다.
// 공유 보폭 모델은 순수 계층(pose.ts)에서 온다 — 리그 빌더(player3d)를 거치지 않는다.
import { MIN_GAIT_SPEED, diveHandLocal, strideLength } from './pose'
import {
  PITCH_H, PITCH_W, toWorld,
  type BallPose, type FrameEvent, type FrameState, type PlayerAction, type PlayerPose,
} from './types'

// ── 튜닝 상수(전부 표시용) ───────────────────────────────────────────────
/** 필드 플레이어 최대 속도(m/s). */
export const MAX_SPEED = 7.5
/** GK 최대 속도(m/s). */
export const GK_MAX_SPEED = 5.5
/** 공 반지름(m) = 지면에 놓인 공의 중심 높이. */
export const BALL_RADIUS = 0.11
/** 볼 X 위치에 따른 팀 라인 전후 이동 최대치(m). */
export const BALL_SHIFT = 8
/** 볼에 수렴하는 인원(팀당). */
export const CONVERGE_COUNT = 3
/** 수렴 최대 당김(m). */
export const CONVERGE_MAX = 12
/** 이 거리(m)를 넘으면 수렴 당김이 0이 된다. */
export const CONVERGE_RANGE = 40
/**
 * 수렴 시 공에 이보다 가까이 붙지 않는다(m).
 * ★ 1.2 → 1.8: 예전엔 수렴한 **일반 선수**가 킥 판정 반경(3 m) 안으로 들어와, 엔진이 정한
 *   슈터도 안무 캐리어도 아닌 사람이 킥 모션을 받았다(실측: goal 장면에서 8→10→16번).
 *   지금은 킥 대상이 캐리어로 못 박혔지만, 수렴 인원이 공에 붙어 서 있으면 여전히 공이
 *   누구 발에 있는지 읽히지 않으므로 링을 넓힌다.
 */
export const STANDOFF = 1.8
/** 수렴 링: 순번마다 반경을 이만큼 벌린다(m). */
const RING_STEP = 0.45
/** 수렴 링: 순번별 각도 오프셋(rad) — 공 주위를 감싸듯 벌어진다. */
const RING_ANGLES = [0, 0.7, -0.7]
/** 선수 간 최소 간격(m) — 3D 휴머노이드 관통 방지(표시용 소프트 분리).
 *  목표가 갈라져도 속도 클램프로 뒤처진 실제 위치는 겹칠 수 있어, 프레임마다
 *  이동 예산 안에서 떼어낸다(클램프 불변식은 유지). */
export const MIN_POSE_SEPARATION = 1.3
/** 킥 판정 최대 거리(m) — 이보다 멀면 킥 모션을 주지 않는다(허공 슛 방지). */
export const KICK_REACH = 3
/** GK 박스: 골라인에서의 최대 깊이(m). */
export const GK_BOX_DEPTH = 6
/** GK 박스: 중앙에서의 최대 좌우 이동(m). */
export const GK_BOX_HALF_Z = 6
/** 목표 반경 안에서는 감속해 도착한다(m). */
export const ARRIVE_RADIUS = 1.5

// ── 관성(R6) — docs/research/football-sim-physics.md §5.3 ────────────────
// 리서치가 "여유" 순위로 미뤄 두었던 항목이다. 미구현 상태의 실측(90분, seed 42):
// 프레임 |Δv|/dt가 p50 15.7 · p99 320 · max 445 m/s²로, 문헌 상한(7~8)을 프레임의
// 70%가 넘었다. 위치만 상태로 들고 매 프레임 목표로 직진하니 목표가 바뀌는 순간
// 속도 벡터가 그대로 꺾인 것이다 — 그것이 "이상하게 움직이는 선수"의 정체다.
/**
 * 최대 가속(m/s²). 엘리트 축구선수의 정지 출발 첫 스텝이 7~8 m/s²
 * (§5.3, 1차 문헌 미확보 — 관례값). 하한을 택했다.
 */
export const A_ACCEL = 7
/** 최대 감속(m/s²). 문헌 −4~−6의 상한. 급정거가 가속보다 조금 빠른 것은 실제와 같다. */
export const A_BRAKE = 6
/**
 * 최대 **측방** 가속(m/s²) — 진행 방향에 수직인 성분에만 걸리는 별도 상한.
 *
 * 왜 따로 두나: 속도를 유지한 채 방향만 꺾는 것은 물리적으로 불가능하다(§5.3 — 90°
 * 전환에 최소 0.3~0.5 s). 크기 클램프만 두면 |v|가 같은 방향 반전은 공짜가 되므로,
 * 회전 반경을 만드는 것은 이 상한이다. v² / A_LATERAL = 7.5²/5 ≈ 11 m가 최대속도의
 * 최소 선회 반경이 된다.
 */
export const A_LATERAL = 5
/** GK는 좁은 박스 안에서 스텝을 밟는다 — 반응이 필드 플레이어보다 민첩하다. */
export const A_GK_SCALE = 1.35

/**
 * **다이브 중** GK의 가속 배율과 속도 상한(m/s).
 *
 * 왜 평시와 다른가: 다이브는 걷기가 아니라 **도약**이다. 두 다리로 지면을 밀어 몸을
 * 던지므로 몸통 중심의 병진은 한 걸음 안에 4~6 m/s에 도달한다(문헌: 완전 신전 다이브가
 * 550~700 ms에 2.5~3 m를 이동한다 — 평균 4.5~5.5 m/s, 즉 **가속 구간이 거의 없다**).
 * 평시 클램프(A_GK_SCALE 1.35, 7 m/s² × 1.35 ≈ 9.5 m/s²)로는 0.5 s에 1.2 m밖에 못 가고,
 * 그것이 곧 "GK가 몸을 던졌는데 손이 공에 0.5 m 못 미친다"였다(실측, 박스 안 슛 재저술 후).
 * 슛이 골라인 26.9 m에서 나가던 시절에는 비행이 930 ms라 이 근사로도 닿았다.
 */
export const A_GK_DIVE_SCALE = 3.2
/**
 * 스플릿 스텝 — GK가 임팩트 **직전**에 몸을 실을 방향으로 체중을 옮기는 시간(ms).
 *
 * 예지가 아니다: 실제 GK는 슈터의 백스윙(임팩트 260 ms 전)을 보고 스플릿 스텝을 밟아
 * 착지 순간 몸을 이미 한쪽으로 싣는다 — 이것이 골키핑 교본의 기본기다. 우리는 그 창을
 * 백스윙의 70%만 준다(180 ms ≈ 11프레임). 이 시간이 없으면 GK는 정지 상태에서 출발해
 * 박스 안 슛의 짧은 비행(0.5~0.6 s) 안에 접촉점까지 몸통을 옮기지 못한다.
 */
export const GK_SET_MS = 180
/** 다이브 중 GK 몸통 병진 상한(m/s) — 위 문헌 구간의 상단. */
export const GK_DIVE_SPEED = 6.5
/**
 * 겹침 분리(밀어내기)에 허용하는 가속(m/s²).
 *
 * 자력 가속({@link A_ACCEL})보다 훨씬 관대한 이유는 이것이 **접촉 충격**이기 때문이다 —
 * 부딪힌 사람은 자기 근력 한도와 무관하게 밀린다. 다만 무제한이면 분리 한 번에
 * |Δv|/dt가 450까지 튀어 "얼음판에서 튕겨 나가는" 그림이 된다(실측).
 *
 * 45로 정한 근거: 이보다 낮으면 겹침이 한 프레임에 다 풀리지 않아 최소 간격
 * (MIN_POSE_SEPARATION 1.3 m)이 정상상태로 0.97 m까지 눌린다(30 fps 실측, 관통 테스트
 * 하한 1.0 m 미달). 45에서 통과하고, 그 위로 올려도 간격은 더 좋아지지 않는다.
 */
export const A_SEPARATE = 45
/** 세리머니 지속(ms). */
export const CELEBRATE_MS = 2000
/** dwell 미지정 시 기본값(ms) — 세리머니 창을 t로 환산할 때 쓴다. */
export const DEFAULT_DWELL_MS = 3000
/**
 * 무버 목표를 앞서 읽는 폭(ms). 도착 감속이 남기는 정상상태 지연(약 1.4 m)을 상쇄한다.
 * ARRIVE_RADIUS / MAX_SPEED = 1.5 / 7.5 = 0.2 s가 이론값이다.
 */
export const MOVER_LOOKAHEAD_MS = 200
/** focus 스무딩 시상수(s). */
const FOCUS_TAU = 0.4
/**
 * 접촉(세이브 손-공 / 골 통과) 이후에도 **두 배역 프레임을 유지**하는 시간(ms).
 * 방송 편집 관행상 컷 하나가 3~5 s는 유지돼야 시청자가 공간을 파악한다
 * (docs/research/football-sim-physics.md §4.3). 접촉 직후 바로 볼로 붙으면
 * "무엇이 막았는지"를 확인할 프레임이 남지 않는다.
 */
const FRAME_HOLD_MS = 900
/**
 * 슛 임팩트보다 이만큼 **먼저** 두 배역 프레임을 잡기 시작한다(ms).
 *
 * 왜 백스윙(260 ms)으로 부족한가: focus·반경은 {@link FOCUS_TAU}(0.4 s)로 풀리므로
 * 260 ms에 잡으면 임팩트 순간 반경이 목표의 48%에 불과하다(실측 r 6.1 / 11.4).
 * 그러면 정작 "발이 공에 닿는" 프레임이 아직 타이트해서 골문 쪽이 안 보인다.
 * 900 ms ≈ 2.2 시상수라 임팩트 시점에 90%까지 열린다. 카메라가 슛을 미리 준비하는 것은
 * 실제 중계 오퍼레이터의 행동이기도 하다(표시 계층이므로 인과 위반이 아니다).
 */
const FRAME_LEAD_MS = 900
/** yaw 스무딩 시상수(s). */
const YAW_TAU = 0.12
/** 이 속도(m/s) 이상이면 run으로 진입한다. */
const IDLE_SPEED = 0.4
/**
 * run에서 idle로 빠지는 문턱(m/s) — 진입 문턱보다 낮게 두는 **히스테리시스**.
 * 분리 밀어내기·목표 흔들림 때문에 실측 속도는 문턱 근처에서 프레임마다 오르내리는데,
 * 단일 문턱이면 run↔idle이 깜빡이며 매번 0.3s 크로스페이드가 재시작돼 발이 떤다.
 */
const RUN_EXIT_SPEED = IDLE_SPEED * 0.6
/** 피치 밖으로 나가지 않게 두는 여유(m). */
const EDGE_MARGIN = 0.5

const TAU = Math.PI * 2
const HALF_W = PITCH_W / 2
const HALF_H = PITCH_H / 2

/** 볼 궤적 종류 — 안무 스텝이 지정하면 그것이 우선, 없으면 이벤트 타입과 구간 인덱스로 추론.
 *  정본 타입은 choreography(=scenes)에 있다 — 장면을 저술하는 쪽이 궤적도 안다. */
export type BallArcKind = BallArc

/**
 * 궤적별 최고 높이(m). ground는 공 반지름(=지면).
 *
 * ★ shot 2.5 → 2.0, cross 6 → 4.2 (docs/research/football-sim-physics.md §2.2)
 *  - 크로스: 발사 20 m/s 기준 최고점 6 m는 약 36°·도달 27 m다. 박스 안 15~20 m 크로스에는
 *    과하다. 문헌 역산 적정치가 3~4.5 m.
 *  - 슛: 예전 `sin(πu/2)` 곡선은 **끝에서 정점**이라 골라인 통과 높이가 항상 정확히
 *    2.50 m였다(전수 실측). 크로스바는 2.44 m다 — 모든 골이 크로스바 위로 들어갔다.
 */
export const BALL_PEAK: Record<BallArcKind, number> = {
  ground: BALL_RADIUS,
  pass: 1.2,
  shot: 2.0,
  cross: 4.2,
}

/**
 * 궤적별 **도착 높이**(m). 포물선의 끝점이며, 슛만 지면보다 높다(골문 안 1.05 m —
 * 크로스바 2.44 m 아래, 골라인 통과 높이가 여기서 결정된다).
 */
/**
 * 도착 높이가 명시된 궤적(크로스바를 넘기는 미스)에서 정점이 도착보다 이만큼은 높다(m).
 * 0이면 골라인 통과 시점이 정확히 정점이 되어 궤적이 평평하게 읽힌다.
 */
export const OVER_BAR_RISE = 0.6

/** 공중에서 출발하는 구간(헤더 슛)의 최소 상승분(m) — 0이면 포물선이 풀리지 않는다. */
export const HEAD_DIP_RISE = 0.15

export const BALL_END: Record<BallArcKind, number> = {
  ground: BALL_RADIUS,
  pass: BALL_RADIUS,
  shot: 1.05,
  cross: BALL_RADIUS,
}

// ── 볼 항력 상수 (Bray & Kerwin 2003, J Sports Sci 21:75–85) ──────────────
/** 공 질량(kg) — 규정 410~450 g의 중앙값. */
export const BALL_MASS = 0.43
/** 공기 밀도(kg/m³, 해면 15 °C). */
export const AIR_DENSITY = 1.225
/** 항력계수 — Bray & Kerwin 프리킥 10회 실측 평균(0.25~0.30). */
export const DRAG_CD = 0.275
/**
 * 공중 구간의 거리 감쇠 상수(m⁻¹) = ρ·A·C_d / 2m, A = π·0.11².
 * 항력만 받는 1D 운동은 v(s) = v₀·e^(−k·s)라는 닫힌 해를 가지며, 그 역함수가
 * {@link dragProgress}다. 25 m/s에서 감속 k·v² = 9.3 m/s² — 중력과 맞먹는다.
 */
export const K_DRAG = 0.01489
/**
 * 지면 구름 구간의 거리 감쇠 상수(m⁻¹).
 * 잔디 구름저항(μ_r ≈ 0.06)과 잔여 공기저항을 합친 **등가 지수 감쇠**로 근사한다.
 * 근사인 이유: 등감속 해는 구간 소요 시간 T를 알아야 하는데 sampleSequence는 t 비율만
 * 안다. 0.020 m⁻¹이면 20 m에서 15 → 10.1 m/s로 문헌 역산치(10.3)와 맞는다.
 */
export const K_ROLL = 0.02

export interface FrameInput {
  /** 엔진 상태(읽기 전용). */
  state: MatchState
  /** 현재 분. */
  minute: number
  /** 분 내 진행도 0~1(dwell 기준). */
  t: number
  /** 직전 프레임(보간·속도 계산용). null이면 목표 위치로 스냅. */
  prev: FrameState | null
  /** 초 단위 델타(내부에서 0~0.1로 클램프). */
  dt: number
  /** choreography.buildSequence 결과. 있으면 이벤트 안무가 우선한다. */
  sequence: ChoreoStep[] | null
  /** 안무를 재생하는 팀(공·무버 기준). */
  sequenceSide: 'home' | 'away' | null
  /** 결정론 시드(미세 변형용). */
  seed: number
  /** 선택 — 안무의 근거 이벤트. 미지정이면 state.events에서 minute으로 역추적한다. */
  event?: MatchEvent | null
  /** 선택 — 해당 분 dwell(ms). 세리머니 2초 창을 t로 환산할 때만 쓴다(기본 3000). */
  dwellMs?: number
  /**
   * 이 프레임이 **장면 전환의 첫 프레임**인가(시퀀스가 방금 바뀌었다).
   *
   * 왜 필요한가: 하이라이트는 몇 분씩 떨어진 별개의 사건이라 새 장면의 공은 직전 장면과
   * 무관한 자리에서 시작한다(실측: 하이라이트→하이라이트 전환 4회, 볼 이동 p50 51 m).
   * focus를 {@link FOCUS_TAU}로 부드럽게 풀면 카메라가 그 51 m를 **패닝으로 따라가고**,
   * 화면에는 아무도 차지 않은 공이 피치를 가로질러 날아가는 그림이 남는다.
   * 실제 중계는 하이라이트 사이를 **컷**으로 넘긴다 — 그 문법을 여기서 만든다.
   * focus를 스무딩 없이 새 장면에 꽂으면 카메라(cameraFor는 focus의 순수 함수)도 함께 컷된다.
   */
  cut?: boolean
}

/** 시퀀스 샘플링 결과(0~100 좌표계). */
export interface SeqSample {
  ball: { x: number; y: number }
  /** 현재 시각으로 보간된 무버 좌표. */
  movers: { playerId: string; x: number; y: number }[]
  /** 현재 구간(키프레임 k → k+1) 인덱스. */
  segIndex: number
  /** 구간 진행도 0~1. */
  u: number
  /** 마지막 키프레임을 지났는가. */
  finished: boolean
  /** 마지막 키프레임 이후 진행도 0~1(여운 구간). */
  after: number
  /** 현재 구간의 시작 키프레임(킥 판정용). */
  start: ChoreoStep
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** FNV-1a 결정론 해시 — 표시 레이어의 Math.random 대체. */
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 시드 문자열 → 0~1 실수. */
const unit = (s: string) => (hash(s) % 100000) / 100000

/** GK가 벗어날 수 없는 박스(월드 좌표). 홈은 -X 골문, 어웨이는 +X 골문을 지킨다. */
export function gkBox(side: 'home' | 'away'): { xMin: number; xMax: number; zMin: number; zMax: number } {
  const near = side === 'home' ? -HALF_W : HALF_W - GK_BOX_DEPTH
  return { xMin: near, xMax: near + GK_BOX_DEPTH, zMin: -GK_BOX_HALF_Z, zMax: GK_BOX_HALF_Z }
}

/** 이벤트 타입 + 구간 인덱스 → 볼 궤적 종류. */
export function arcKindFor(type: MatchEventType | undefined, segIndex: number, segCount: number): BallArcKind {
  if (segCount <= 0) return 'ground'
  switch (type) {
    case 'corner':
      // 0번 구간이 코너 깃발 → 박스 크로스(높은 아크), 이후는 문전 짧은 연결.
      return segIndex === 0 ? 'cross' : 'pass'
    case 'foul':
    case 'yellow':
    case 'red':
    case 'kickoff':
    case 'sub':
    case 'halftime':
    case 'fulltime':
      return 'ground'
    case 'goal':
    case 'shot':
    case 'save':
    case 'miss':
    case 'chance':
      // 마지막 구간이 슈팅(상승 궤적), 앞 구간은 패스.
      return segIndex >= segCount - 1 ? 'shot' : 'pass'
    default:
      // 근거 이벤트를 모르면 계획대로 "그 외 지면".
      return 'ground'
  }
}

/**
 * 궤적 종류·구간 진행도 → 공 높이(m).
 *
 * **중력 포물선**이다. (0, BALL_RADIUS)에서 출발해 (1, BALL_END)로 떨어지고 최고점이
 * 정확히 BALL_PEAK인 2차식을 닫힌 형태로 푼다:
 *   y(u) = R + b·u + c·u²,  b + c = D,  −b²/(4c) = P
 *   ⇒ b = 2P + 2√(P(P−D)),  c = D − b      (P = PEAK−R, D = END−R)
 * 패스·크로스는 D=0이라 정점이 u=0.5(대칭 포물선), 슛은 D>0이라 정점이 u≈0.59로
 * 뒤로 밀리고 **도착 높이가 1.05 m**가 된다 — 예전 `sin(πu/2)`가 만들던
 * "모든 골이 정확히 2.50 m로 통과"(크로스바 2.44 m 초과)를 이것이 없앤다.
 */
export function ballHeight(kind: BallArcKind, u: number, endY?: number, startY?: number): number {
  const p = clamp(u, 0, 1)
  const end = endY != null ? Math.max(BALL_RADIUS, endY) : BALL_END[kind]
  /**
   * 출발 높이 — 기본은 지면(공 반지름)이다.
   *
   * ★ 2026-08-01 신설. 헤더 마무리가 생기면서 **공중에서 출발하는 구간**이 필요해졌다:
   *   크로스가 머리 높이(scenes.HEADER_BALL_Y)로 도착하고, 그 다음 슛 구간은 그 높이에서
   *   시작해 골문으로 내려온다. 출발을 항상 지면으로 두면 헤더 임팩트 직후 공이 한 프레임에
   *   1.95 m를 뚝 떨어진다.
   */
  const start = startY != null ? Math.max(BALL_RADIUS, startY) : BALL_RADIUS
  /**
   * 정점은 출발·도착보다 반드시 높아야 포물선이 풀린다.
   *  · `end + OVER_BAR_RISE` — 크로스바를 넘기는 슛은 골라인 통과 시점에 아직 상승 중이다.
   *  · `start + HEAD_DIP_RISE` — 머리 높이에서 출발해 골문으로 **내리꽂는** 헤더는 거의
   *    상승하지 않는다. 0.15 m만 띄워 하강 포물선을 만든다(0이면 궤적이 풀리지 않는다).
   * 저술이 둘 다 비운 평범한 구간에서는 두 항이 모두 BALL_PEAK보다 작아 예전과 같다.
   */
  const peak = Math.max(
    BALL_PEAK[kind],
    endY != null ? end + OVER_BAR_RISE : end,
    startY != null ? start + HEAD_DIP_RISE : start,
  )
  const P = peak - start
  if (P <= 1e-9) return start
  const D = end - start
  const b = 2 * P + 2 * Math.sqrt(Math.max(0, P * (P - D)))
  const c = D - b
  return start + b * p + c * p * p
}

/**
 * 항력 감속을 반영한 구간 진행도 — `lerp(a, b, u)`의 u를 이 함수로 갈아끼우면
 * 구조를 하나도 바꾸지 않고 물리적 감속을 얻는다.
 *
 * 유도: 항력만 받는 1D 운동은 v = v₀/(1 + k·v₀·t), s = ln(1 + k·v₀·t)/k라는 닫힌 해를
 * 갖는다. 구간 거리 S와 소요 T가 주어지면 v₀ = (e^(kS) − 1)/(kT)이고
 *   u(τ) = ln(1 + (e^(kS) − 1)·τ) / (kS),  τ = t/T
 * 로 u(0)=0, u(1)=1이 정확히 성립한다. 즉 T를 몰라도 정규화 시간만으로 감속이 나온다.
 *
 * @param kind 궤적 종류(지면이면 구름저항 상수, 그 외 공기저항 상수).
 * @param distanceM 구간의 실제 거리(m). 0에 가까우면(컨트롤 정지) 선형으로 되돌린다.
 * @param tau 구간 정규화 시간 0~1.
 */
export function dragProgress(kind: BallArcKind, distanceM: number, tau: number): number {
  const p = clamp(tau, 0, 1)
  if (!(distanceM > 0.05)) return p
  const kS = (kind === 'ground' ? K_ROLL : K_DRAG) * distanceM
  if (kS < 1e-4) return p
  return clamp(Math.log1p(Math.expm1(kS) * p) / kS, 0, 1)
}

/** 0~100 좌표 두 점의 실제 거리(m) — 항력 곡선이 실거리를 알아야 한다. */
function ballMetres(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(((b.x - a.x) / 100) * PITCH_W, ((b.y - a.y) / 100) * PITCH_H)
}

/** 무버 좌표를 시각 tc에서 선형 보간한다(볼과 달리 감속 곡선을 쓰지 않는다). */
function moversAt(steps: ChoreoStep[], tc: number): { playerId: string; x: number; y: number }[] {
  const last = steps[steps.length - 1]
  if (steps.length === 1 || tc >= last.t) return last.movers.map(m => ({ ...m }))
  let k = 0
  for (let i = 0; i < steps.length - 1; i++) if (tc >= steps[i].t) k = i
  const a = steps[k]
  const b = steps[k + 1]
  const u = clamp((tc - a.t) / Math.max(1e-6, b.t - a.t), 0, 1)
  const nextById = new Map(b.movers.map(m => [m.playerId, m]))
  return a.movers.map(m => {
    const n = nextById.get(m.playerId) ?? m
    return { playerId: m.playerId, x: lerp(m.x, n.x, u), y: lerp(m.y, n.y, u) }
  })
}

/**
 * 안무 키프레임 배열을 시각 t(0~1)로 샘플링한다(0~100 좌표계 유지).
 *
 * 볼은 {@link dragProgress}로 **감속**하고, 무버는 선형 보간에 `lookahead`만큼 앞선
 * 시각을 쓴다.
 *
 * ★ lookahead가 필요한 이유: computeFrame의 도착 감속(ARRIVE_RADIUS=1.5 m)은 목표가
 *   움직이면 정상상태 지연 d ≈ ARRIVE_RADIUS·v/cap을 남긴다(v=7 m/s에서 약 1.4 m).
 *   그 1.4 m가 곧 "공이 발에서 떨어져 보인다"이므로, 목표를 그만큼 미리 읽어 상쇄한다.
 *
 * @param lookahead 무버 목표를 앞서 읽는 t 폭(0이면 기존 동작).
 */
export function sampleSequence(sequence: ChoreoStep[], t: number, lookahead = 0): SeqSample {
  const steps = sequence
  const last = steps[steps.length - 1]
  const tc = clamp(t, 0, 1)
  const tm = clamp(tc + lookahead, 0, Math.max(tc, last.t))
  if (steps.length === 1 || tc >= last.t) {
    const rest = Math.max(1e-6, 1 - last.t)
    return {
      ball: { ...last.ball },
      movers: last.movers.map(m => ({ ...m })),
      segIndex: Math.max(0, steps.length - 2),
      u: 1,
      finished: true,
      after: clamp((tc - last.t) / rest, 0, 1),
      start: steps[Math.max(0, steps.length - 2)],
    }
  }
  let k = 0
  for (let i = 0; i < steps.length - 1; i++) if (tc >= steps[i].t) k = i
  const a = steps[k]
  const b = steps[k + 1]
  const span = Math.max(1e-6, b.t - a.t)
  const u = clamp((tc - a.t) / span, 0, 1)
  // 볼만 항력 곡선을 탄다. 아크가 없으면 공중 패스로 본다(computeFrame이 타입으로 추론).
  const ub = dragProgress(a.arc ?? 'pass', ballMetres(a.ball, b.ball), u)
  return {
    ball: { x: lerp(a.ball.x, b.ball.x, ub), y: lerp(a.ball.y, b.ball.y, ub) },
    movers: moversAt(steps, tm),
    segIndex: k,
    u,
    finished: false,
    after: 0,
    start: a,
  }
}

// ── 볼 앵커링: 구간 끝점을 **화면에 실제로 있는 발**에 붙인다 ─────────────
/**
 * 한 구간 끝점의 월드 좌표를 구한다 — 그 스텝에 캐리어가 있으면 **직전 프레임의 실제
 * 선수 위치** 발 앞에, 없으면 저술 좌표에.
 *
 * ★ 왜 저술 좌표만으로 부족한가: `scenes.ts`는 공을 캐리어의 발 앞 0.45 m에 저술하지만,
 *   그것은 **무버가 저술 위치에 서 있을 때만** 성립한다. 실제로는 분이 바뀌어도
 *   `prev`가 유지되므로(Match3D가 의도적으로 그렇게 한다 — 리셋하면 22명이 순간이동한다)
 *   장면이 시작될 때 무버는 직전 분이 남긴 자리에 있다. 속도 클램프로 따라잡는 동안
 *   공은 저술 좌표를 그대로 달린다 — 실측: 장면 시작 t 0.1~0.2 구간에서 소유 중인데도
 *   볼-발 거리 **p50 11.76 m**(90분 실주행, seed 42).
 *
 *   그래서 방향을 뒤집는다: 선수를 공으로 끌어오는 대신 **공을 선수 발로 가져온다.**
 *   저술은 "경기가 어디로 흐르는가"를 계속 지배하고(무버 목표는 그대로), 공은 그 흐름을
 *   실제 발로 잇는다. 소유 구간에서 공이 발을 떠나는 것이 구조적으로 불가능해진다.
 *
 * 캐리어가 없는 스텝(슛 종점·세이브 접촉점·미스 종점)은 **결과**이므로 저술이 정본이다.
 *
 * @param step 대상 키프레임.
 * @param prevById 직전 프레임의 선수(없으면 저술 좌표를 그대로 쓴다).
 * @param aim 발 앞 오프셋의 방향 기준점(월드). 보통 반대쪽 끝점의 저술 좌표.
 */
function anchorPoint(
  step: ChoreoStep,
  prevById: Map<string, PlayerPose>,
  aim: { x: number; z: number },
): { x: number; z: number } {
  const authored = toWorld(step.ball.x, step.ball.y)
  if (!step.carrier) return authored
  const p = prevById.get(step.carrier)
  if (!p) return authored
  const dx = aim.x - p.x
  const dz = aim.z - p.z
  const len = Math.hypot(dx, dz)
  // 목표가 자기 자신이면(정지 구간) 저술 방향을 쓴다 — 발 앞이 어디인지는 알아야 한다.
  if (len < 1e-6) {
    const ax = authored.x - p.x
    const az = authored.z - p.z
    const al = Math.hypot(ax, az)
    if (al < 1e-6) return { x: p.x, z: p.z }
    return { x: p.x + (ax / al) * FOOT_OFFSET_M, z: p.z + (az / al) * FOOT_OFFSET_M }
  }
  return { x: p.x + (dx / len) * FOOT_OFFSET_M, z: p.z + (dz / len) * FOOT_OFFSET_M }
}

/** 앵커링된 볼의 월드 XZ. {@link sampleSequence}의 결과를 실제 선수 위치로 다시 맨다. */
function anchoredBallXZ(
  seq: ChoreoStep[],
  sample: SeqSample,
  prevById: Map<string, PlayerPose>,
): { x: number; z: number; arcDistance: number } {
  const last = seq[seq.length - 1]
  if (sample.finished) {
    const p = anchorPoint(last, prevById, toWorld(seq[Math.max(0, seq.length - 2)].ball.x, seq[Math.max(0, seq.length - 2)].ball.y))
    return { x: p.x, z: p.z, arcDistance: 0 }
  }
  const a = seq[sample.segIndex]
  const b = seq[sample.segIndex + 1]
  const wa = toWorld(a.ball.x, a.ball.y)
  const wb = toWorld(b.ball.x, b.ball.y)
  const pa = anchorPoint(a, prevById, wb)
  const pb = anchorPoint(b, prevById, wa)
  const dist = Math.hypot(pb.x - pa.x, pb.z - pa.z)
  const arc = a.arc ?? 'pass'
  const u = dragProgress(arc, dist, sample.u)
  return { x: lerp(pa.x, pb.x, u), z: lerp(pa.z, pb.z, u), arcDistance: dist }
}

/** 중력(m/s²). 여운 구간의 탄도 연장에만 쓴다. */
const GRAVITY = 9.81

/**
 * 골이 들어간 뒤 공이 **골망 안에서 멈추는 깊이**(m, 골라인 뒤).
 *
 * 왜 필요한가: 저술 좌표계는 0~100이라 골라인(100)까지밖에 못 쓴다. 그래서 골 종점은
 * 언제나 골라인 **위**이고, 여운 동안 공이 그 자리에 내려앉으면 화면에서는 골문 앞
 * 잔디에 굴러 멈춘 그림이 된다 — 블라인드 감사의 "골망은 비어 있고 공은 기둥 옆
 * 잔디에" 지적이 이것이다. 네트 깊이({@link props.NET_DEPTH})가 2.0 m이므로 1.35 m는
 * 네트를 뚫지 않으면서 확실히 "안쪽"이다.
 */
export const GOAL_NET_REST_M = 1.35
/** 골라인 통과 → 네트에 멈추기까지(ms). 25 m/s로 들어온 공이 그물에 잡히는 시간. */
export const GOAL_NET_MS = 260

/**
 * 골 여운 — 골라인 위의 종점에서 **골망 안으로** 밀어 넣고 잔디로 내려앉힌다.
 *
 * @param at    골 키프레임의 월드 XZ(골라인 위).
 * @param side  공격한 쪽. home은 +X 골문, away는 −X 골문으로 들어간다.
 * @param after 여운 진행도 0~1(SeqSample.after).
 * @param rest  여운 전체 길이(ms) — 네트 진입은 그중 앞 {@link GOAL_NET_MS}만 쓴다.
 * @param y0    골라인 통과 높이(m).
 */
export function goalNetRest(
  at: { x: number; z: number },
  side: 'home' | 'away',
  after: number,
  rest: number,
  y0: number,
): { x: number; y: number; z: number } {
  const u = clamp((after * rest) / GOAL_NET_MS, 0, 1)
  // 그물에 잡히는 감속 — 선형이 아니라 빠르게 들어갔다가 멎는다(ease-out).
  const e = 1 - (1 - u) * (1 - u)
  const sign = side === 'home' ? 1 : -1
  return {
    x: at.x + sign * GOAL_NET_REST_M * e,
    y: lerp(y0, BALL_RADIUS, e),
    z: at.z,
  }
}

/**
 * 마지막 키프레임 **이후**의 탄도 연장 — 크로스바를 넘긴 미스가 골문 뒤로 사라지게 한다.
 *
 * 마지막 구간의 수평 속도와, 포물선 y(u)의 u=1에서의 기울기를 초기 조건으로 삼아
 * 그대로 적분한다. 지면에 닿으면 그 자리에 멈춘다(구르는 연출은 하지 않는다 —
 * 이미 화면 밖 골문 뒤다).
 */
function ballisticAfter(
  seq: ChoreoStep[],
  sample: SeqSample,
  dwellMs: number,
  endY: number,
  arc: BallArcKind,
): { x: number; y: number; z: number } {
  const last = seq[seq.length - 1]
  const prevStep = seq[Math.max(0, seq.length - 2)]
  const wEnd = toWorld(last.ball.x, last.ball.y)
  const wPrev = toWorld(prevStep.ball.x, prevStep.ball.y)
  const segS = Math.max(1e-3, ((last.t - prevStep.t) * dwellMs) / 1000)
  const dx = wEnd.x - wPrev.x
  const dz = wEnd.z - wPrev.z
  const len = Math.hypot(dx, dz)
  const vh = len / segS
  // 도착 시점의 수직 속도 = dy/du × du/dt. u=1 근처 기울기를 수치로 잡는다.
  const h = 1e-3
  const vy = ((ballHeight(arc, 1, endY) - ballHeight(arc, 1 - h, endY)) / h) / segS
  // 여운 경과 시간(초).
  const ta = sample.after * Math.max(0, 1 - last.t) * (dwellMs / 1000)
  const y = endY + vy * ta - 0.5 * GRAVITY * ta * ta
  if (y <= BALL_RADIUS) {
    // 착지 시각을 풀어 그 지점에서 멈춘다(음수 판별식은 없다 — y0 > R이므로 항상 해가 있다).
    const tl = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * GRAVITY * (endY - BALL_RADIUS)))) / GRAVITY
    const k = len > 1e-6 ? vh * tl : 0
    return { x: wEnd.x + (len > 1e-6 ? (dx / len) * k : 0), y: BALL_RADIUS, z: wEnd.z + (len > 1e-6 ? (dz / len) * k : 0) }
  }
  const k = vh * ta
  return { x: wEnd.x + (len > 1e-6 ? (dx / len) * k : 0), y, z: wEnd.z + (len > 1e-6 ? (dz / len) * k : 0) }
}

/**
 * 쳐낸(펀칭·파링) 공의 궤적 — 접촉점에서 GK가 몸을 던진 쪽으로 걷어 낸 탄도.
 *
 * 방향: 슛이 온 방향으로 되돌리되 {@link PUNCH_DEFLECT}만큼 다이브 쪽으로 튼다.
 * 문전 정면으로 되돌리면 "막았는데 다시 위험해진다"가 되어 세이브로 읽히지 않는다 —
 * 실제 GK도 사이드로 걷어 낸다.
 *
 * @param ta 접촉 이후 경과(초).
 */
function punchAfter(
  contact: { x: number; z: number },
  shotFrom: { x: number; z: number } | null,
  dir: number,
  ta: number,
): { x: number; y: number; z: number } {
  const bx = shotFrom ? shotFrom.x - contact.x : 1
  const bz = shotFrom ? shotFrom.z - contact.z : 0
  const bl = Math.hypot(bx, bz) || 1
  // 슛이 온 방향(단위) → 다이브 쪽으로 회전.
  const a = Math.atan2(bz / bl, bx / bl) + dir * PUNCH_DEFLECT
  const vh = PUNCH_SPEED * Math.cos(PUNCH_LOFT)
  const vv = PUNCH_SPEED * Math.sin(PUNCH_LOFT)
  const y0 = GK_HAND_HEIGHT
  const disc = Math.sqrt(Math.max(0, vv * vv + 2 * GRAVITY * (y0 - BALL_RADIUS)))
  const tl = (vv + disc) / GRAVITY // 착지 시각
  const te = Math.min(Math.max(0, ta), tl)
  return {
    x: contact.x + Math.cos(a) * vh * te,
    y: Math.max(BALL_RADIUS, y0 + vv * te - 0.5 * GRAVITY * te * te),
    z: contact.z + Math.sin(a) * vh * te,
  }
}

// ── 킥 스케줄러: 물리가 애니메이션을 구동한다(역방향 스케줄링) ─────────────
/**
 * `pose.kickAngles`에서 발이 공에 닿는 진행도.
 * 백스윙 0~0.32, 임팩트 스윙 0.32~0.58이므로 접촉은 그 사이 0.45다.
 */
export const KICK_IMPACT_T = 0.45
/** 백스윙 소요(ms) — 스윙 다리 최대 후방 → 접촉. */
export const KICK_BACKSWING_MS = 260
/** 팔로스루 소요(ms). */
export const KICK_FOLLOW_MS = 340
/** 이 거리(m) 미만은 킥이 아니다 — 컨트롤 정지 구간(볼 좌표 동일)을 걸러낸다. */
const KICK_MIN_DISTANCE = 1

/**
 * 임팩트 순간 공이 이 높이(m) 이상이면 **발이 아니라 머리**다.
 *
 * 근거: 이 선수 모델의 골반은 0.94 m, 어깨 1.44 m, 머리 중심 약 1.74 m다(pose.ts).
 * 발로 닿을 수 있는 상한(하이킥)이 대략 허리~가슴이므로 1.5 m를 경계로 둔다. 저술은
 * 헤더 임팩트를 1.95 m로 쓴다(scenes.HEADER_BALL_Y) — 경계에서 0.45 m 여유다.
 */
export const HEADER_MIN_Y = 1.5

/** 한 번의 킥 — 누가, 언제(dwell 상대 t) 공을 찬다. */
export interface KickEvent {
  playerId: string
  /** 임팩트 시각(= 볼이 출발하는 키프레임의 t). */
  tImpact: number
  /** 임팩트 시점의 볼 좌표(0~100) — **저술값**. 실제 화면 좌표는 앵커링을 거친다. */
  ball: { x: number; y: number }
  /** 이 킥이 출발하는 키프레임 인덱스(앵커링된 임팩트 지점을 되찾는 데 쓴다). */
  stepIndex: number
}

/**
 * 시퀀스에서 킥 목록을 뽑는다 — **저술이 지정한 캐리어**가 찬다.
 *
 * 예전에는 "구간 시작 볼에서 가장 가까운 아무나"였다. 실측에서 그 선수는 수렴 로직에
 * 빨려온 일반 선수였고, 그래서 "패스가 선수를 거치지도 않고 휘어진다"가 됐다.
 */
export function kickEvents(sequence: ChoreoStep[]): KickEvent[] {
  const out: KickEvent[] = []
  for (let k = 0; k + 1 < sequence.length; k++) {
    const a = sequence[k]
    if (!a.carrier) continue
    if (ballMetres(a.ball, sequence[k + 1].ball) < KICK_MIN_DISTANCE) continue
    out.push({ playerId: a.carrier, tImpact: a.t, ball: { ...a.ball }, stepIndex: k })
  }
  return out
}

/**
 * 지금 이 시각에 재생 중인 킥과 그 진행도.
 *
 * **역방향 스케줄링**: 결과 시각(볼 출발)이 이미 정해져 있으므로 접촉 프레임 오프셋을
 * 빼서 클립 시작 시각을 역산한다. t=0에서 시작하는 첫 패스는 백스윙 시간이 없으므로
 * 클립을 중간부터 재생한다(football-match-viewer의 `pose.startFrom`과 같은 처방).
 */
export function kickAt(
  kicks: KickEvent[],
  t: number,
  dwellMs: number,
): { kick: KickEvent; actionT: number } | null {
  const back = KICK_BACKSWING_MS / dwellMs
  const fwd = KICK_FOLLOW_MS / dwellMs
  let best: { kick: KickEvent; actionT: number } | null = null
  let bestGap = Infinity
  for (const k of kicks) {
    if (t < k.tImpact - back || t > k.tImpact + fwd) continue
    const gap = Math.abs(t - k.tImpact)
    if (gap >= bestGap) continue
    const actionT = t <= k.tImpact
      ? KICK_IMPACT_T * (1 - (k.tImpact - t) / back)
      : KICK_IMPACT_T + (1 - KICK_IMPACT_T) * ((t - k.tImpact) / fwd)
    bestGap = gap
    best = { kick: k, actionT: clamp(actionT, 0, 1) }
  }
  return best
}

/**
 * 임팩트 **전에** 몸을 목표로 열기 시작하는 선행 시간(ms). 백스윙 창에 이만큼을 더한다.
 *
 * 왜 선행이 필요한가: yaw는 {@link YAW_TAU}=0.12 s 지수 스무딩이라 목표 각을 즉시
 * 따라가지 않는다. 백스윙 창(260 ms)만으로는 1−e^(−0.26/0.12) = 88.5%밖에 수렴하지
 * 않아, 180° 뒤를 보고 달려오던 선수는 임팩트 순간에도 20.7° 어긋난다. 260+240 = 500 ms를
 * 주면 98.5%가 되어 잔차가 2.7°로 떨어진다. GK 다이브에서 쓴 선행 보정과 같은 처방이다.
 *
 * 축구적으로도 이것이 맞다 — 슈터는 마지막 두세 걸음에서 디딤발을 심고 상체를 목표로 연다.
 */
export const KICK_YAW_LEAD_MS = 240

/**
 * 이 시각에 **몸을 목표로 열어야 하는** 킥. {@link kickAt}과 같은 창에
 * {@link KICK_YAW_LEAD_MS}만 앞으로 넓힌 것이다.
 *
 * {@link kickAt}과 분리한 이유: 킥 모션(actionT)은 창 밖에서 재생하면 안 되지만, 몸의
 * 방향은 창이 열리기 전부터 돌기 시작해야 제때 맞는다. 또 {@link KICK_REACH} 취소와도
 * 무관해야 한다 — 공으로 달려가는 중이라 아직 닿지 않은 선수야말로 몸을 열어야 한다.
 */
export function kickFacingAt(
  kicks: KickEvent[],
  t: number,
  dwellMs: number,
): KickEvent | null {
  const back = (KICK_BACKSWING_MS + KICK_YAW_LEAD_MS) / dwellMs
  const fwd = KICK_FOLLOW_MS / dwellMs
  let best: KickEvent | null = null
  let bestGap = Infinity
  for (const k of kicks) {
    if (t < k.tImpact - back || t > k.tImpact + fwd) continue
    const gap = Math.abs(t - k.tImpact)
    if (gap >= bestGap) continue
    bestGap = gap
    best = k
  }
  return best
}

// ── GK 다이브 인과 ────────────────────────────────────────────────────────
/** 시각 단서 → 근육 활성까지의 반응 지연(ms). 스포츠 과학 관례값 180~250의 중앙. */
export const GK_REACTION_MS = 200
/** 도약 → 최대 신전(=볼 접촉)까지(ms). 문헌 500~700의 하한. */
export const GK_DIVE_MS = 550
/** 접촉 이후 착지·정착(ms). */
export const GK_SETTLE_MS = 450
/** `pose.diveAngles`가 완전 측와가 되는 진행도 — 이 값이 볼 도착과 일치해야 한다.
 *  렌더러(Match3D)가 **접촉 프레임을 검출**하는 데도 쓰므로 공개한다. */
export const DIVE_LAY_U = 0.55
/**
 * 완전 신전 시 **뻗는 손의 몸통 로컬 위치**(x=정면, y=높이, z=오른쪽).
 *
 * ★ 예전에는 이것을 스칼라 반경 2.0 m로 근사했다. 실측(pose.diveHandLocal을 실제 three
 *   리그와 대조, 오차 0.0000 m)한 값은 **(−0.40, 1.01, ±1.80)** 이다 — 도달은 거의 전부
 *   **측방**이고 몸통보다 0.4 m 뒤이며 높이는 1.01 m다. 스칼라 반경은 이 세 가지를 전부
 *   버린다. 그래서 예전 `gkDiveAnchor`는 몸통을 "골문 중앙 방향으로 2.0 m" 물렸고,
 *   그 방향은 GK가 바라보는 방향과 아무 관계가 없었다. 결과: 90분 실주행에서
 *   **실측 손-공 최소 거리 1.42 ~ 3.46 m, 접촉 프레임 0개** — 한 번도 손에 닿지 않았다.
 *   사용자가 본 "공 따로 골키퍼 따로"가 이 숫자다.
 */
export const GK_HAND_LOCAL = diveHandLocal(DIVE_LAY_U, 1)
/** 완전 신전 시 손의 **수평** 도달 거리(m) — 위 벡터의 XZ 크기. 저술이 접촉 띠를 잡는 데 쓴다. */
export const GK_DIVE_REACH = Math.hypot(GK_HAND_LOCAL.x, GK_HAND_LOCAL.z)
/** 완전 신전 시 손의 높이(m) — 접촉점의 높이가 여기 맞아야 손과 공이 만난다. */
export const GK_HAND_HEIGHT = GK_HAND_LOCAL.y
/**
 * 잡는 세이브(캐치)의 비율(%). 나머지는 쳐내는 세이브(펀칭·파링).
 *
 * 왜 갈라야 하나: 실제 세이브는 둘이고 그림이 완전히 다르다 — 잡으면 공이 손에 붙어
 * 정지하고, 쳐내면 튕겨 나간다. 예전에는 구분이 없어 접촉 시각에 공이 **그 자리에
 * 멈춘 뒤 잔디로 가라앉았다** — 둘 중 어느 것도 아닌, "놓쳤다"로 읽히는 제3의 그림.
 * 엔진은 세이브의 종류를 알려주지 않으므로 이벤트 해시로 결정론적으로 가른다.
 */
export const CATCH_RATIO = 45
/** 쳐낸 공의 초기 속도(m/s). 강슛을 손목으로 막아 낸 공의 반발 — 원래 슛의 1/3 안팎. */
export const PUNCH_SPEED = 8.5
/** 쳐낸 공의 발사각(rad) — 위로 걷어 낸다. */
export const PUNCH_LOFT = 0.55
/** 쳐낸 공을 슛이 온 방향에서 다이브 쪽으로 트는 각(rad ≈ 43°). 문전 정면 반사 금지. */
export const PUNCH_DEFLECT = 0.75
/**
 * 골(=막지 못한 슛)에서 GK의 최대 신전이 볼 통과보다 이만큼 **늦다**(ms).
 *
 * 왜 필요한가: 예전엔 세이브에만 다이브를 붙여, 골 장면의 GK는 공이 옆으로 지나가는 동안
 * 가만히 서 있었다. 관객에게 그것은 "GK가 포기했다"로 읽힌다. 실제로는 몸을 던졌으나
 * 손끝이 스쳤을 뿐이므로, **닿지는 않되 던지기는 하는** 타이밍을 준다.
 */
export const GK_BEATEN_LATE_MS = 110

/**
 * 다이브 스케줄 — **최대 신전 순간이 볼 도착과 정확히 일치**하도록 역산한다.
 *
 * 예전에는 슛 임팩트와 동시에(반응 지연 0) 다이브가 시작되고 `smoothstep(u/0.55)`가
 * u=0.55에서 완전히 눕혔다. 실측 결과 GK는 볼이 오기 **473 ms 전**에 이미 잔디에
 * 누워 있었다. 지금은 시작 시각이 `도착 − 550 ms`이고(짧은 슛이면 반응 지연이 우선),
 * 진행도를 0.55에 맞춰 압축한 뒤 도착 후 나머지 0.45로 착지를 그린다.
 *
 * @returns t가 다이브 창 밖이면 null.
 */
export function diveScheduleAt(
  tImpact: number,
  tArrive: number,
  t: number,
  dwellMs: number,
): number | null {
  const start = Math.max(tImpact + GK_REACTION_MS / dwellMs, tArrive - GK_DIVE_MS / dwellMs)
  if (t < start) return null
  const span = Math.max(1e-6, tArrive - start)
  if (t <= tArrive) return DIVE_LAY_U * ((t - start) / span)
  const settle = Math.max(1e-6, GK_SETTLE_MS / dwellMs)
  return DIVE_LAY_U + (1 - DIVE_LAY_U) * clamp((t - tArrive) / settle, 0, 1)
}

/** 로컬 리그 좌표(x=정면, z=오른쪽)를 yaw로 돌려 월드 XZ 오프셋으로 만든다.
 *  player3d가 `root.rotation.y = -yaw`를 쓰므로 로컬 +X가 월드 (cos yaw, sin yaw)로 간다. */
function rotateByYaw(lx: number, lz: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw)
  const sn = Math.sin(yaw)
  return { x: lx * c - lz * sn, z: lx * sn + lz * c }
}

/** 완전 신전 상태에서 손이 놓이는 월드 위치 — 순기구학 그대로. */
export function gkHandWorld(
  root: { x: number; z: number },
  yaw: number,
  diveT: number,
  dir: number,
): { x: number; y: number; z: number } {
  const l = diveHandLocal(diveT, dir)
  const r = rotateByYaw(l.x, l.z, yaw)
  return { x: root.x + r.x, y: l.y, z: root.z + r.z }
}

/**
 * 접촉점(월드)에서 **손이 정확히 그 점에 닿는 GK 몸통 자리·yaw·다이브 방향**을 구한다.
 *
 * 순기구학을 뒤집는다: 손의 몸통 로컬 위치 {@link GK_HAND_LOCAL}을 yaw로 돌려 접촉점에서
 * 빼면 몸통이 있어야 할 자리가 나온다. 즉 `gkHandWorld(anchor, yaw, DIVE_LAY_U, dir)`가
 * 접촉점과 **정확히 일치**한다(높이는 포즈가 정하므로 XZ만).
 *
 * yaw는 **슛이 날아온 쪽**을 본다 — 실제 GK가 공을 마주보고 몸을 던지는 자세이고,
 * 이렇게 해야 손의 측방 도달(로컬 ±Z)이 슛 라인과 수직이 되어 "옆으로 날아 막는" 그림이 된다.
 * 다이브 방향(±1)은 두 후보 중 **몸통이 골문 중앙에 더 가까운 쪽**을 고른다 —
 * 그래야 GK가 중앙에서 볼 쪽으로 뻗는 그림이 되고 결과가 {@link gkBox} 안에 남는다.
 *
 * @param contact 손이 닿아야 할 점(월드 XZ).
 * @param shotFrom 슛이 출발한 지점(월드 XZ). yaw의 기준.
 */
export function gkDiveAnchor(
  side: 'home' | 'away',
  contact: { x: number; z: number },
  shotFrom?: { x: number; z: number },
): { x: number; z: number; yaw: number; dir: number } {
  const goalX = side === 'home' ? -HALF_W : HALF_W
  // 슛 출발점을 모르면 골문 바깥쪽(=필드 중앙 방향)을 본다.
  const from = shotFrom ?? { x: side === 'home' ? contact.x + 10 : contact.x - 10, z: contact.z }
  const yaw = Math.atan2(from.z - contact.z, from.x - contact.x)
  let best: { x: number; z: number; yaw: number; dir: number } | null = null
  let bestD = Infinity
  for (const dir of [1, -1]) {
    const l = diveHandLocal(DIVE_LAY_U, dir)
    const r = rotateByYaw(l.x, l.z, yaw)
    const root = { x: contact.x - r.x, z: contact.z - r.z }
    // 골문 중앙에 가까운 몸통 자리를 고른다.
    const d = Math.hypot(root.x - goalX, root.z)
    if (d < bestD) { bestD = d; best = { ...root, yaw, dir } }
  }
  return best!
}

/** 무사건 분의 패스 체인 단계 수(t를 4등분해 4명을 거친다). */
const IDLE_CHAIN = 4
/** 이 거리(0~100 좌표) 이상은 뜬 패스로 본다. */
const IDLE_LOFT_DIST = 22

/**
 * 안무가 없을 때의 볼 — **실제 선수의 발밑**을 옮겨 다닌다.
 *
 * ★ 예전에는 리사주 곡선(cos/sin 합성)이었다. 사람과 무관하게 8자를 그리니 "공이 혼자
 *   떠다닌다"로 보였다. 지금은 점유 팀의 라인업 좌표를 잇는 짧은 패스 체인이다 —
 *   공은 언제나 누군가의 발에 있고, 수렴 로직이 그 주위로 선수를 끌어당긴다.
 *
 * 참고: 정상 경로에서는 MatchScreen이 무사건 분에도 flow 시퀀스를 넘기므로 이 함수는
 * 폴백이다(시퀀스 없이 computeFrame을 직접 부르는 테스트·구버전 호출부).
 */
function idleBall(state: MatchState, minute: number, t: number, seed: number): { x: number; y: number; z: number } {
  const side = possessingSide(state.momentum, minute, seed)
  const st = side === 'home' ? state.home : state.away
  const chain = idleChain(st, side, minute, seed)
  if (chain.length === 0) return { x: 0, y: BALL_RADIUS, z: 0 }
  if (chain.length === 1) {
    const w = toWorld(chain[0].x, chain[0].y)
    return { x: w.x, y: BALL_RADIUS, z: w.z }
  }
  const segs = chain.length - 1
  const k = Math.min(segs - 1, Math.floor(t * segs))
  const u = clamp(t * segs - k, 0, 1)
  // smoothstep — 구간 경계에서 속도가 0이라 팀 라인(BALL_SHIFT)이 튀지 않는다.
  const e = u * u * (3 - 2 * u)
  const a = chain[k]
  const b = chain[k + 1]
  // ★ 볼에 별도의 모멘텀 드리프트를 더하지 않는다 — 그러면 공이 선수에게서 떨어진다.
  //   흐름은 이미 두 곳에서 표현된다: 누가 점유하는가(possessingSide)와 팀 라인 전진
  //   (planSide의 BALL_SHIFT). 공은 언제나 두 선수를 잇는 선분 위에 있어야 한다.
  const w = toWorld(clamp(lerp(a.x, b.x, e), 2, 98), clamp(lerp(a.y, b.y, e), 2, 98))
  const lofted = Math.hypot(b.x - a.x, b.y - a.y) > IDLE_LOFT_DIST
  return { x: w.x, y: lofted ? ballHeight('pass', e) : BALL_RADIUS, z: w.z }
}

/**
 * 무사건 분의 패스 체인 — 시드로 고른 출발 선수에서 **가장 가까운 미방문 동료**로
 * 이어 붙인다. 짧은 패스만 나오므로 공이 피치를 가로질러 튀지 않는다(팀 라인이 흔들리면
 * 22명이 한꺼번에 달리는 것처럼 보인다).
 */
function idleChain(st: SideState, side: 'home' | 'away', minute: number, seed: number): { x: number; y: number }[] {
  const lineup = st.tactics.lineup
  const sentOff = new Set(st.sentOff)
  const pts: { x: number; y: number }[] = []
  const pool: { x: number; y: number }[] = []
  for (let i = 1; i < lineup.length; i++) {
    if (sentOff.has(lineup[i].playerId)) continue
    pool.push(tacticalCoords(st.tactics.formation, i, side, st.tactics.instructions))
  }
  if (pool.length === 0) return pts
  let cur = pool.splice(hash(`idle:${seed}:${minute}`) % pool.length, 1)[0]
  pts.push(cur)
  while (pts.length < IDLE_CHAIN && pool.length > 0) {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < pool.length; i++) {
      const d = (pool[i].x - cur.x) ** 2 + (pool[i].y - cur.y) ** 2
      if (d < bd) { bd = d; bi = i }
    }
    cur = pool.splice(bi, 1)[0]
    pts.push(cur)
  }
  return pts
}

/** 프레임에 실을 이벤트 라벨.
 *  goal은 **공이 네트에 들어간 뒤(scored)** 부터만 'goal-*'를 방출한다. 그 전엔
 *  아직 슛 진행 중이므로 'shot' — 카메라·FX가 골보다 먼저 터지는 것을 막는다. */
function frameEvent(event: MatchEvent | null, homeTeamId: string, scored: boolean): FrameEvent {
  if (!event) return null
  switch (event.type) {
    case 'goal': return scored ? (event.teamId === homeTeamId ? 'goal-home' : 'goal-away') : 'shot'
    case 'save': return 'save'
    case 'corner': return 'corner'
    case 'foul': case 'yellow': case 'red': return 'foul'
    case 'shot': case 'miss': case 'chance': return 'shot'
    default: return null
  }
}

/** input.event 우선, 없으면 state.events에서 해당 분의 마지막 표시성 이벤트를 찾는다. */
function resolveEvent(input: FrameInput): MatchEvent | null {
  if (input.event !== undefined) return input.event
  const evs = input.state.events
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (e.minute !== input.minute) continue
    if (e.type === 'kickoff' || e.type === 'sub' || e.type === 'halftime' || e.type === 'fulltime') continue
    return e
  }
  return null
}

/** 최단 각도 보간(라디안). */
function approachAngle(from: number, to: number, alpha: number): number {
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return from + d * alpha
}

interface Plan {
  id: string
  side: 'home' | 'away'
  number: number
  index: number
  isGk: boolean
  mover: boolean
  /** 다이브 앵커를 향해 몸을 던지는 중인 GK인가 — 가속·속도 예산이 다르다. */
  diving?: boolean
  tx: number
  tz: number
}

/** 팀 한쪽의 목표 위치(수렴 전) 계산. */
function planSide(
  side: 'home' | 'away',
  st: SideState,
  ball: { x: number; z: number },
  moverById: Map<string, { x: number; y: number }>,
  minute: number,
  t: number,
  seed: number,
  /** 이 팀 GK를 보낼 자리(다이브 준비). null이면 평소의 {@link gkTarget}. */
  gkAnchor: { x: number; z: number } | null,
): Plan[] {
  const numberById = new Map(st.team.squad.map(p => [p.id, p.number]))
  const sentOff = new Set(st.sentOff)
  const shift = clamp(ball.x / HALF_W, -1, 1) * BALL_SHIFT
  const out: Plan[] = []
  st.tactics.lineup.forEach((slot, index) => {
    const id = slot.playerId
    if (sentOff.has(id)) return
    const isGk = index === 0
    const mv = moverById.get(id)
    let tx: number
    let tz: number
    let mover = false
    if (mv) {
      // 이벤트 참여자는 안무 좌표를 그대로 목표로 삼는다(포메이션보다 우선).
      const w = toWorld(mv.x, mv.y)
      tx = w.x
      tz = w.z
      mover = true
    } else if (isGk) {
      const g = gkAnchor ?? gkTarget(side, ball)
      tx = g.x
      tz = g.z
    } else {
      const c = tacticalCoords(st.tactics.formation, index, side, st.tactics.instructions)
      const a = toWorld(c.x, c.y)
      // 시드 해시 기반 미세 흔들림(로봇 대형 방지) — 분 경계에서 연속.
      const ph = unit(`${seed}:${id}`) * TAU
      const clock = minute + t
      tx = a.x + shift + Math.cos(ph + clock * 1.1) * 1.1
      tz = a.z + Math.sin(ph * 1.7 + clock * 0.9) * 1.1
    }
    out.push({
      id, side, number: numberById.get(id) ?? 0, index, isGk, mover, tx, tz,
      ...(isGk && gkAnchor ? { diving: true as const } : {}),
    })
  })
  return out
}

/** GK 목표 — 볼이 상대 진영으로 갈수록 전진(스위퍼), 좌우는 볼 Z를 약하게 추종. */
function gkTarget(side: 'home' | 'away', ball: { x: number; z: number }): { x: number; z: number } {
  const box = gkBox(side)
  const ownGoalX = side === 'home' ? -HALF_W : HALF_W
  const f = clamp(Math.abs(ball.x - ownGoalX) / PITCH_W, 0, 1)
  /**
   * 골라인에서 떨어진 거리(m). 하한 2.2 — **골라인에 붙어 서는 GK는 없다.**
   *
   * 왜 0.6에서 올렸나: 세이브 접촉점은 골라인 앞 2.2~3.2 m 띠에 있고(scenes.SAVE_CONTACT_M),
   * 손이 그 점에 닿으려면 몸통이 골라인 앞 약 3.1 m에 와야 한다(gkDiveAnchor). 0.6~1.4 m에
   * 서 있으면 슛이 떠난 뒤 2 m를 **전진**하며 동시에 옆으로 몸을 던져야 한다 — 박스 안
   * 슛의 비행(0.5~0.6 s)에는 물리적으로 불가능했다(실측 손-공 0.4~1.1 m 미달).
   * 실제 GK도 박스 안 슛을 앞두고는 골라인이 아니라 골 에어리어 선 근처에 선다.
   */
  const depth = lerp(2.2, GK_BOX_DEPTH - 0.3, f)
  const x = side === 'home' ? ownGoalX + depth : ownGoalX - depth
  return {
    x: clamp(x, box.xMin, box.xMax),
    z: clamp(ball.z * 0.55, box.zMin, box.zMax),
  }
}

/**
 * 볼에 가까운 CONVERGE_COUNT명을 볼 쪽으로 당긴다(거리 역비례).
 * 공 좌표에 정확히 겹치지 않도록 STANDOFF 반경을 남기고, 순번별 각도·반경
 * 오프셋으로 공 주위를 링처럼 감싼다(선수 관통 방지).
 */
function applyConvergence(
  plans: Plan[],
  ball: { x: number; z: number },
  side: 'home' | 'away',
  /** 지금 공을 가진 선수 — 수렴에서 제외한다. */
  carrierId?: string | null,
): void {
  const cand = plans
    // ★ 캐리어는 제외한다. 공은 캐리어의 발 앞 0.45 m에 앵커링돼 있는데, 수렴이 그를
    //   STANDOFF(1.8 m) 링으로 밀어내면 공과 캐리어가 서로를 쫓는 되먹임이 된다.
    //   무버가 없는 흐름(flow) 구간에서 캐리어는 일반 선수라 이 필터가 필요하다.
    .filter(p => !p.isGk && !p.mover && p.id !== carrierId)
    .map(p => ({ p, d: Math.hypot(p.tx - ball.x, p.tz - ball.z) }))
    .sort((a, b) => (a.d === b.d ? a.p.index - b.p.index : a.d - b.d))
    .slice(0, CONVERGE_COUNT)
  const fan = side === 'home' ? 1 : -1
  cand.forEach(({ p, d }, rank) => {
    if (d < 1e-6) return
    const pull = Math.min(Math.max(0, d - STANDOFF), CONVERGE_MAX * (1 - Math.min(d, CONVERGE_RANGE) / CONVERGE_RANGE))
    if (pull <= 0) return
    const angle = Math.atan2(p.tz - ball.z, p.tx - ball.x) + RING_ANGLES[rank] * fan
    const radius = Math.max(d - pull, STANDOFF + rank * RING_STEP)
    p.tx = ball.x + Math.cos(angle) * radius
    p.tz = ball.z + Math.sin(angle) * radius
  })
}

interface Posed {
  p: Plan
  pp: PlayerPose | undefined
  box: { xMin: number; xMax: number; zMin: number; zMax: number } | null
  /** 이 프레임의 최대 속도(m/s) — 분리 밀어내기도 이 예산을 넘지 않는다. */
  cap: number
  x: number
  z: number
  speed: number
  /** 이 프레임의 실제 속도 벡터(m/s) — 다음 프레임 관성의 출발점. */
  vx: number
  vz: number
  /**
   * 이 프레임에 **저술 위치로 컷된** 선수인가(장면 전환의 무버).
   * 분리 단계의 이동 예산 재투영에서 제외해야 한다 — 예산은 직전 프레임과의 연속성을
   * 강제하므로, 걸면 컷이 그대로 되돌려진다(실측: 되돌아가 슈터가 45 m 뒤에서 찼다).
   */
  snapped?: boolean
}

/**
 * 관성 스텝 — 목표 위치를 향한 seek/arrive 스티어링에 **가속도 클램프**를 건다.
 *
 * 1. 목표 속도 = 목표 방향 × cap × arrive(도착 반경 안에서 감속)
 * 2. Δv를 두 축으로 분해한다 — 현재 진행 방향 성분(가속/감속)과 수직 성분(선회)
 * 3. 각각 {@link A_ACCEL}/{@link A_BRAKE}·dt와 {@link A_LATERAL}·dt로 클램프
 * 4. 새 속도로 한 프레임 전진. 마지막에 속도 크기를 cap으로 잘라 기존 클램프 불변식을 지킨다.
 *
 * 정지 상태(|v| ≈ 0)에서는 진행 방향이 없으므로 크기 클램프만 건다.
 */
function inertialStep(
  px: number, pz: number, vx: number, vz: number,
  tx: number, tz: number, cap: number, aScale: number, dt: number,
): { x: number; z: number; vx: number; vz: number } {
  const dx = tx - px
  const dz = tz - pz
  const d = Math.hypot(dx, dz)
  const arrive = d < ARRIVE_RADIUS ? d / ARRIVE_RADIUS : 1
  // 목표 속도. 도착했으면 0(그 자리에 선다).
  const want = d > 1e-9 ? cap * arrive : 0
  const wx = d > 1e-9 ? (dx / d) * want : 0
  const wz = d > 1e-9 ? (dz / d) * want : 0

  const sp = Math.hypot(vx, vz)
  let ndx = wx - vx
  let ndz = wz - vz
  if (sp > 1e-6) {
    // 진행 방향 단위벡터로 Δv를 분해한다.
    const ux = vx / sp
    const uz = vz / sp
    const along = ndx * ux + ndz * uz
    const perpX = ndx - along * ux
    const perpZ = ndz - along * uz
    // 진행 방향 성분: 빨라지면 가속 한도, 느려지면 감속 한도.
    const aLong = along >= 0 ? A_ACCEL * aScale : A_BRAKE * aScale
    const cLong = clamp(along, -aLong * dt, aLong * dt)
    // 수직 성분: 선회 한도.
    const perp = Math.hypot(perpX, perpZ)
    const maxPerp = A_LATERAL * aScale * dt
    const f = perp > maxPerp && perp > 1e-9 ? maxPerp / perp : 1
    ndx = cLong * ux + perpX * f
    ndz = cLong * uz + perpZ * f
  } else {
    // 정지 출발 — 방향이 없으니 크기만 제한한다.
    const n = Math.hypot(ndx, ndz)
    const maxN = A_ACCEL * aScale * dt
    if (n > maxN && n > 1e-9) {
      ndx = (ndx / n) * maxN
      ndz = (ndz / n) * maxN
    }
  }
  let nvx = vx + ndx
  let nvz = vz + ndz
  // 속도 상한(기존 계약 — 필드 7.5 / GK 5.5 × 체력).
  const nsp = Math.hypot(nvx, nvz)
  if (nsp > cap && nsp > 1e-9) {
    nvx = (nvx / nsp) * cap
    nvz = (nvz / nsp) * cap
  }
  // 목표를 지나치지 않는다 — 도착 프레임에 진동이 생기지 않게 남은 거리로 자른다.
  const travel = Math.hypot(nvx, nvz) * dt
  if (travel > d && d > 1e-9) {
    const k = d / travel
    return { x: tx, z: tz, vx: nvx * k, vz: nvz * k }
  }
  return { x: px + nvx * dt, z: pz + nvz * dt, vx: nvx, vz: nvz }
}

/**
 * **목표 좌표**끼리 겹치면 미리 떼어낸다.
 *
 * 왜 사후 밀어내기(separatePoses)만으로 부족한가: 목표가 서로 안쪽에 있으면 선수들은
 * 매 프레임 서로를 향해 조종되고, 밀어내기는 그것을 매 프레임 되돌린다. 관성이 들어온
 * 뒤로는 그 되돌림이 가속도 상한({@link A_SEPARATE})에 걸려 한 프레임에 다 풀리지 않으므로,
 * 실제 간격이 목표치 아래에서 정상상태로 눌러앉는다(실측 0.96 m). 목표를 먼저 벌려 두면
 * 밀어내기는 과도 구간만 처리하면 된다.
 *
 * 목표 좌표에는 이동 예산이 없으므로(아직 아무도 움직이지 않았다) 반복만으로 수렴시킨다.
 */
function separateTargets(plans: Plan[]): void {
  for (let iter = 0; iter < 4; iter++) {
    let touched = false
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) {
        const a = plans[i]
        const b = plans[j]
        let dx = b.tx - a.tx
        let dz = b.tz - a.tz
        let d = Math.hypot(dx, dz)
        if (d >= MIN_POSE_SEPARATION) continue
        if (d < 1e-6) {
          const ang = ((hash(`t|${a.id}|${b.id}`) % 3600) / 3600) * TAU
          dx = Math.cos(ang)
          dz = Math.sin(ang)
          d = 1
        }
        const gap = MIN_POSE_SEPARATION - d
        const ux = dx / d
        const uz = dz / d
        // GK는 박스가 우선이라 밀리지 않는다(사후 밀어내기와 같은 규약).
        const aShare = a.isGk ? 0 : b.isGk ? 1 : 0.5
        const bShare = b.isGk ? 0 : a.isGk ? 1 : 0.5
        a.tx -= ux * gap * aShare
        a.tz -= uz * gap * aShare
        b.tx += ux * gap * bShare
        b.tz += uz * gap * bShare
        touched = true
      }
    }
    if (!touched) break
  }
}

/**
 * 실제 포즈끼리 MIN_POSE_SEPARATION 안으로 붙으면 떼어낸다.
 * 밀어낸 뒤 **직전 위치에서 cap*dt 원판 안으로 재투영**하므로 속도 클램프 불변식이
 * 깨지지 않는다(겹침은 프레임을 걸쳐 점진적으로 풀린다). GK는 박스가 우선.
 * 마지막에 실제 이동량으로 speed를 다시 계산한다.
 */
function separatePoses(posed: Posed[], dt: number): void {
  for (let iter = 0; iter < 3; iter++) {
    let touched = false
    for (let i = 0; i < posed.length; i++) {
      for (let j = i + 1; j < posed.length; j++) {
        const a = posed[i]
        const b = posed[j]
        let dx = b.x - a.x
        let dz = b.z - a.z
        let d = Math.hypot(dx, dz)
        if (d >= MIN_POSE_SEPARATION) continue
        if (d < 1e-6) {
          const ang = (hash(`${a.p.id}|${b.p.id}`) % 3600) / 3600 * TAU
          dx = Math.cos(ang)
          dz = Math.sin(ang)
          d = 1
        }
        const gap = MIN_POSE_SEPARATION - d
        const ux = dx / d
        const uz = dz / d
        const aShare = a.p.isGk ? 0 : b.p.isGk ? 1 : 0.5
        const bShare = b.p.isGk ? 0 : a.p.isGk ? 1 : 0.5
        a.x -= ux * gap * aShare
        a.z -= uz * gap * aShare
        b.x += ux * gap * bShare
        b.z += uz * gap * bShare
        touched = true
      }
    }
    if (!touched) break
  }
  for (const q of posed) {
    // 순서 주의: 경계·박스 클램프 → 이동 예산 재투영.
    // 예산을 먼저 걸면 박스 클램프가 예산을 넘겨 순간이동시킬 수 있다(박스 밖에서
    // 시작한 GK가 한 프레임에 27m 튐). 클램프 대상은 볼록 영역이라 pp와 클램프
    // 결과를 잇는 선분 위의 점도 항상 그 안에 있다.
    q.x = q.box ? clamp(q.x, q.box.xMin, q.box.xMax) : clamp(q.x, -HALF_W + EDGE_MARGIN, HALF_W - EDGE_MARGIN)
    q.z = q.box ? clamp(q.z, q.box.zMin, q.box.zMax) : clamp(q.z, -HALF_H + EDGE_MARGIN, HALF_H - EDGE_MARGIN)
    if (q.pp && dt > 0 && !q.snapped) {
      // 이동 예산 재적용 — 분리·클램프로 인한 순간이동 금지.
      // ★ 속도 상한만으로는 부족하다: 밀어내기는 한 프레임에 0 → cap을 만들 수 있어
      //   |Δv|/dt가 450 m/s²까지 튄다(실측). 그래서 **가속도**로도 제한한다.
      //   밀어내기는 외력(부딪힘)이라 자력 가속보다 관대한 A_SEPARATE를 쓴다.
      const pvx = q.pp.vx ?? 0
      const pvz = q.pp.vz ?? 0
      let wvx = (q.x - q.pp.x) / dt
      let wvz = (q.z - q.pp.z) / dt
      let dvx = wvx - pvx
      let dvz = wvz - pvz
      const dvn = Math.hypot(dvx, dvz)
      const maxDv = A_SEPARATE * dt
      if (dvn > maxDv && dvn > 1e-9) {
        dvx = (dvx / dvn) * maxDv
        dvz = (dvz / dvn) * maxDv
      }
      wvx = pvx + dvx
      wvz = pvz + dvz
      const wn = Math.hypot(wvx, wvz)
      if (wn > q.cap && wn > 1e-9) {
        wvx = (wvx / wn) * q.cap
        wvz = (wvz / wn) * q.cap
      }
      q.x = q.pp.x + wvx * dt
      q.z = q.pp.z + wvz * dt
    }
    // 분리·클램프로 위치가 바뀌었으면 **속도도 실제 이동량에서 다시 유도한다** —
    // 안 그러면 관성 상태가 화면의 움직임과 어긋나 다음 프레임이 엉뚱하게 가속한다.
    if (q.pp && dt > 0 && !q.snapped) {
      q.vx = (q.x - q.pp.x) / dt
      q.vz = (q.z - q.pp.z) / dt
    }
    // 컷된 무버의 속도는 0이다 — 컷 거리를 dt로 나누면 수백 m/s가 되어 다음 프레임의
    // 관성이 폭발한다(가속도 게이트도 함께 무너진다).
    q.speed = q.pp && dt > 0 && !q.snapped ? Math.hypot(q.x - q.pp.x, q.z - q.pp.z) / dt : 0
  }
}

/**
 * 한 프레임의 22명 + 볼 + 카메라 포커스를 계산한다(순수 함수).
 *
 * @param input 엔진 상태·시간·직전 프레임·안무 시퀀스.
 * @returns 렌더러가 그대로 소비하는 FrameState(엔진 상태는 변형하지 않는다).
 */
export function computeFrame(input: FrameInput): FrameState {
  const dt = clamp(input.dt, 0, 0.1)
  const t = clamp(input.t, 0, 1)
  const dwellMs = input.dwellMs != null && input.dwellMs > 0 ? input.dwellMs : DEFAULT_DWELL_MS
  const seq = input.sequence && input.sequence.length > 0 ? input.sequence : null
  const event = resolveEvent(input)
  const prev = input.prev
  const homeTeamId = input.state.home.team.id
  /**
   * 안무를 재생하는(= 공격) 팀. **이벤트가 있으면 이벤트가 정본이다.**
   *
   * 왜 prop을 그대로 믿지 않는가: `save`의 `event.teamId`는 막은 팀(수비)이라
   * 호출부가 `teamId === home ? 'home' : 'away'`로 계산하면 정확히 반대가 된다
   * (choreography.attackingSideOf 주석의 실측 참조). 그 반대값이 그대로
   * `divingSide`를 뒤집어 **엉뚱한 쪽 GK가 몸을 던졌다.**
   */
  const seqSide: 'home' | 'away' = event
    ? attackingSideOf(event, homeTeamId)
    : (input.sequenceSide ?? 'home')

  // ── 1) 볼 ────────────────────────────────────────────────────────────
  const prevById = new Map((prev?.players ?? []).map(p => [p.id, p]))
  const sample = seq ? sampleSequence(seq, t, MOVER_LOOKAHEAD_MS / dwellMs) : null
  const segCount = seq ? seq.length - 1 : 0
  // 궤적은 **장면이 저술한 값이 우선**한다(크로스는 크로스로 떠야 한다). 없으면 타입 추론.
  const arc: BallArcKind = sample
    ? (sample.start.arc ?? arcKindFor(event?.type, sample.segIndex, segCount))
    : 'ground'

  // ── 1.5) 슛·접촉 시간표 ───────────────────────────────────────────────
  // GK를 어디로 보낼지(목표 위치)와 **접촉 이후 공이 어떻게 되는지**가 여기서 나오므로
  // 볼 좌표(§1.9)와 planSide(§2)보다 **먼저** 계산한다.
  const kicks = seq ? kickEvents(seq) : []
  const tArrive = seq ? seq[seq.length - 1].t : 0
  const tShot = kicks.length > 0 ? kicks[kicks.length - 1].tImpact : tArrive
  /** 접촉 스텝(세이브). 없으면 마지막 스텝을 접촉으로 본다(기존 규약). */
  const contactStep = seq ? (seq.find(s => s.contact) ?? seq[seq.length - 1]) : null
  const contactWorld = contactStep ? toWorld(contactStep.ball.x, contactStep.ball.y) : null
  const tContact = contactStep ? contactStep.t : tArrive
  /** 슛이 출발한 지점(월드) — GK가 바라볼 방향의 기준. */
  const shotWorld = kicks.length > 0 ? toWorld(kicks[kicks.length - 1].ball.x, kicks[kicks.length - 1].ball.y) : null
  /** 슛을 받는 쪽(안무의 볼이 향하는 골문) GK. */
  const divingSide: 'home' | 'away' = seqSide === 'home' ? 'away' : 'home'
  /**
   * 다이브 종류 — 세이브는 **닿고**(접촉점으로 몸통을 보낸다), 골은 **닿지 않는다**
   * (제자리에서 던지되 최대 신전이 볼 통과보다 {@link GK_BEATEN_LATE_MS} 늦다).
   * 예전엔 세이브에만 다이브가 붙어 골 장면의 GK가 서서 구경했다.
   */
  const diveKind: 'save' | 'beaten' | null =
    seq && event?.type === 'save' ? 'save' : seq && event?.type === 'goal' ? 'beaten' : null
  const tLay = diveKind === 'beaten' ? tArrive + GK_BEATEN_LATE_MS / dwellMs : tContact
  const diveU = diveKind ? diveScheduleAt(tShot, tLay, t, dwellMs) : null
  const diving = diveU != null
  const diveT = diveU ?? 0
  /**
   * GK 몸통 목표·yaw·다이브 방향 — 세이브는 임팩트 순간부터 접촉점을 향해 **미리** 움직인다.
   *
   * 왜 다이브 창이 아니라 임팩트부터인가: 다이브 창은 550 ms뿐이고 GK 상한은 5.5 m/s라
   * 도착 감속까지 감안하면 2 m도 못 간다. 실제 GK도 슛이 떠난 순간 스텝을 밟아
   * 몸을 볼 라인에 맞춘다 — 인과(임팩트 이후)는 지켜지고 도달은 가능해진다.
   */
  const gkAnchor =
    diveKind === 'save' && contactWorld && t >= tShot - GK_SET_MS / dwellMs
      ? gkDiveAnchor(divingSide, contactWorld, shotWorld ?? undefined)
      : null
  /**
   * 이 세이브는 **잡는가 쳐내는가**. 엔진은 알려주지 않으므로 이벤트 해시로 가른다
   * (같은 사건은 항상 같은 종류 — 결정론).
   */
  const saveKind: 'catch' | 'punch' | null =
    diveKind === 'save'
      ? (hash(`save:${input.state.seed}:${input.minute}:${event?.playerId ?? ''}`) % 100 < CATCH_RATIO
        ? 'catch' : 'punch')
      : null

  // ── 1.9) 볼 ──────────────────────────────────────────────────────────
  let ballPos: { x: number; y: number; z: number }
  if (sample && seq) {
    // 구간 끝점을 **직전 프레임의 실제 발**에 맨다(장면 전환 첫 프레임은 저술 그대로 —
    // prev의 좌표는 아직 이전 장면의 것이라 앵커로 쓰면 공이 지난 장면에 붙는다).
    const w = input.cut ? toWorld(sample.ball.x, sample.ball.y) : anchoredBallXZ(seq, sample, prevById)
    // 도착 높이는 **장면이 저술할 수 있다**(크로스바 위로 뜨는 미스, 머리 높이로 오는 크로스).
    // ★ 2026-08-01: 마지막 구간 전용이던 것을 **구간별**로 일반화했다. 스텝 k의 `endY`는
    //   "공이 그 스텝에 도달하는 높이"이므로, 구간 [k, k+1]의 출발 높이는 seq[k].endY이고
    //   도착 높이는 seq[k+1].endY다. 헤더는 이 두 값이 모두 필요하다(1.95 m에서 출발해
    //   골문 1.05 m로 내려온다). 저술이 비워 두면 예전과 똑같이 지면에서 출발한다.
    const endY = seq[seq.length - 1].endY
    const segI = Math.min(sample.segIndex, seq.length - 2)
    const segStartY = seq[segI].endY
    const segEndY = seq[segI + 1].endY
    const saved = saveKind && contactWorld && t >= tContact
    if (saved && saveKind === 'catch') {
      // ★ 잡는 세이브 — 공이 **손에 붙어** 그대로 따라 내려온다. GK가 정착(diveT 0.55→1)
      //   하는 동안 손이 잔디 쪽으로 내려오므로 공도 함께 내려와 "가슴에 안았다"가 된다.
      const gkPrev = prevById.get(input.state[divingSide].tactics.lineup[0]?.playerId ?? '')
      const root = gkPrev ? { x: gkPrev.x, z: gkPrev.z } : (gkAnchor ?? contactWorld)
      const yaw = gkAnchor?.yaw ?? gkPrev?.yaw ?? 0
      const dir = gkAnchor?.dir ?? gkPrev?.actionDir ?? 1
      ballPos = gkHandWorld(root, yaw, Math.max(diveT, DIVE_LAY_U), dir)
    } else if (saved && saveKind === 'punch') {
      // ★ 쳐내는 세이브 — 접촉점에서 **튕겨 나간다**. 슛이 온 방향으로 되돌리되 GK가 몸을
      //   던진 쪽으로 각을 틀어 걷어 낸다(문전으로 되돌리지 않는 것이 세이브의 목적이다).
      ballPos = punchAfter(contactWorld, shotWorld, gkAnchor?.dir ?? 1,
        ((t - tContact) * dwellMs) / 1000)
    } else if (sample.finished && event?.type === 'goal') {
      // ★ 골은 골라인에서 멈추지 않는다 — 골망 안으로 들어가야 "골"로 읽힌다.
      const rest = Math.max(1e-6, (1 - seq[seq.length - 1].t) * dwellMs)
      ballPos = goalNetRest(w, seqSide, sample.after, rest, ballHeight(arc, 1, segEndY, segStartY))
    } else if (sample.finished && endY != null && endY > BALL_RADIUS + 0.5) {
      // ★ 크로스바를 넘긴 공은 **그 자리에 내려앉지 않는다.** 마지막 키프레임은 골라인
      //   1 m 앞이라, 여운 동안 높이만 0으로 줄이면 4.5 m 상공의 공이 골문 안으로
      //   가라앉아 "골대를 맞고 떨어졌다"로 읽힌다. 실제로는 골문 뒤로 넘어가 버린다.
      //   그래서 마지막 구간의 속도로 **탄도를 계속 적분한다**(포물선의 자연스러운 연장).
      ballPos = ballisticAfter(seq, sample, dwellMs, endY, arc)
    } else {
      const y = sample.finished
        ? lerp(ballHeight(arc, 1, segEndY, segStartY), BALL_RADIUS, sample.after) // 여운 구간엔 지면으로 안착
        : ballHeight(arc, sample.u, segEndY, segStartY)
      ballPos = { x: w.x, y, z: w.z }
    }
  } else {
    ballPos = idleBall(input.state, input.minute, t, input.seed)
  }
  const rolled = prev ? Math.hypot(ballPos.x - prev.ball.x, ballPos.z - prev.ball.z) : 0
  const spinRaw = (prev?.ball.spin ?? 0) + rolled / BALL_RADIUS
  const ball: BallPose = { ...ballPos, spin: ((spinRaw % TAU) + TAU) % TAU }

  // ── 2) 목표 위치 ─────────────────────────────────────────────────────
  const moverById = new Map<string, { x: number; y: number }>()
  if (sample) for (const m of sample.movers) moverById.set(m.playerId, { x: m.x, y: m.y })

  const homePlans = planSide('home', input.state.home, ball, moverById, input.minute, t, input.seed,
    divingSide === 'home' ? gkAnchor : null)
  const awayPlans = planSide('away', input.state.away, ball, moverById, input.minute, t, input.seed,
    divingSide === 'away' ? gkAnchor : null)
  /** 이 시각의 소유자 — 구간 시작 스텝(끝났으면 마지막 스텝)의 캐리어. */
  const nowCarrier = sample && seq
    ? (sample.finished ? (seq[seq.length - 1].carrier ?? null) : (seq[sample.segIndex].carrier ?? null))
    : null
  applyConvergence(homePlans, ball, 'home', nowCarrier)
  applyConvergence(awayPlans, ball, 'away', nowCarrier)
  const plans = [...homePlans, ...awayPlans]
  separateTargets(plans)

  // ── 3) 스텝(속도 클램프) + 포즈 분리 ─────────────────────────────────
  const posed = plans.map(p => {
    const box = p.isGk ? gkBox(p.side) : null
    const tx = box ? clamp(p.tx, box.xMin, box.xMax) : clamp(p.tx, -HALF_W + EDGE_MARGIN, HALF_W - EDGE_MARGIN)
    const tz = box ? clamp(p.tz, box.zMin, box.zMax) : clamp(p.tz, -HALF_H + EDGE_MARGIN, HALF_H - EDGE_MARGIN)
    const pp = prevById.get(p.id)
    const stamina = clamp((input.state[p.side].staminaByPlayer[p.id] ?? 100) / 100, 0, 1)
    const cap = (p.isGk ? (p.diving ? GK_DIVE_SPEED : GK_MAX_SPEED) : MAX_SPEED) * (0.78 + 0.22 * stamina)

    let x = tx
    let z = tz
    let vx = 0
    let vz = 0
    /**
     * 장면 전환 프레임에서는 **무버만** 저술 시작 위치로 컷한다(관성 무시).
     *
     * 왜 필요한가: `cut` 프레임에서 볼은 이미 저술 좌표로 순간이동하고 카메라도 컷한다
     * (§1.9·§6). 그런데 무버는 직전 분이 남긴 자리에서 속도 상한으로 걸어왔다. 배역이
     * 자기 진영에 있던 분(엔진이 고른 득점자가 풀백이면 60 m 뒤다)에는 장면이 끝날
     * 때까지 따라잡지 못한다 — 실측(90분 4시드, 97슛): 임팩트 시점 슈터-저술 슛지점
     * 어긋남 p90 8.9 m · **max 46.2 m**. 공은 그 선수의 발에 앵커링되므로 저술이
     * 12 m로 쓴 슛이 화면에서는 **58 m 하프라인 슛**이 됐다(사용자 지적 ①의 꼬리).
     *
     * 무버 3명만 컷하는 이유: 나머지 19명의 목표는 포메이션 좌표라 분이 바뀌어도
     * 연속이다. 컷하면 이유 없이 22명이 튄다.
     */
    if (input.cut && p.mover) {
      return { p, pp, box, cap, x: tx, z: tz, speed: 0, vx: 0, vz: 0, snapped: true }
    }
    if (pp && dt > 0) {
      const st = inertialStep(
        pp.x, pp.z, pp.vx ?? 0, pp.vz ?? 0, tx, tz, cap,
        p.diving ? A_GK_DIVE_SCALE : p.isGk ? A_GK_SCALE : 1, dt,
      )
      x = st.x
      z = st.z
      vx = st.vx
      vz = st.vz
    } else if (pp) {
      x = pp.x
      z = pp.z
    }
    return { p, pp, box, cap, x, z, speed: 0, vx, vz }
  })
  separatePoses(posed, dt)

  // ── 4) 액션 컨텍스트(실제 포즈 기준) ─────────────────────────────────
  // 킥: **저술이 지정한 캐리어**가 찬다. 임팩트 프레임(actionT ≈ 0.45)이 볼 출발 시각과
  // 정확히 일치하도록 백스윙 260 ms를 앞당겨 창을 연다(역방향 스케줄링).
  // KICK_REACH 밖이면 취소한다 — 속도 클램프로 뒤처졌다면 "허공 슛"이 되기 때문이다.
  const kickNow = seq ? kickAt(kicks, t, dwellMs) : null
  /**
   * 이 임팩트는 헤딩인가 — **저술이 그 스텝에 쓴 도착 높이**로 판정한다.
   * 화면의 실제 볼 높이와 같은 값에서 나오므로 포즈와 공이 어긋날 수 없다.
   */
  const kickIsHeader = !!(kickNow && seq && (seq[kickNow.kick.stepIndex].endY ?? 0) >= HEADER_MIN_Y)
  let kickerId: string | null = null
  let kickT = 0
  if (kickNow && seq) {
    const q = posed.find(o => o.p.id === kickNow.kick.playerId)
    if (q) {
      // 임팩트 지점은 **앵커링된 좌표**로 판정한다 — 저술 좌표로 재면, 앵커링 덕에 공이
      // 실제로 발밑에 있는데도 "무버가 저술 위치에 없다"는 이유로 킥이 취소된다.
      const si = kickNow.kick.stepIndex
      const nextW = toWorld(seq[Math.min(seq.length - 1, si + 1)].ball.x, seq[Math.min(seq.length - 1, si + 1)].ball.y)
      const kb = input.cut ? toWorld(kickNow.kick.ball.x, kickNow.kick.ball.y) : anchorPoint(seq[si], prevById, nextW)
      if (Math.hypot(q.x - kb.x, q.z - kb.z) < KICK_REACH) {
        kickerId = q.p.id
        kickT = kickNow.actionT
      }
    }
  }
  /**
   * 몸을 여는 킥과 그 **볼 출발 방향**(월드 각). 킥 모션 창보다 {@link KICK_YAW_LEAD_MS}
   * 먼저 열린다.
   *
   * 왜 저술 구간 방향이 아니라 **차는 사람 → 목표점**인가: 공은 캐리어의 발 앞에
   * 앵커링되므로(anchorPoint) 실제 비행은 언제나 "그 선수의 발 → 저술 도착점"이다.
   * 저술 구간의 방향을 쓰면 선수가 저술 위치에서 벗어난 만큼 몸이 엉뚱한 데를 본다.
   */
  const facingKick = seq ? kickFacingAt(kicks, t, dwellMs) : null
  let kickFace: { id: string; aim: number } | null = null
  if (facingKick && seq) {
    const q = posed.find(o => o.p.id === facingKick.playerId)
    if (q) {
      const si = facingKick.stepIndex
      const target = toWorld(seq[Math.min(seq.length - 1, si + 1)].ball.x, seq[Math.min(seq.length - 1, si + 1)].ball.y)
      const dx = target.x - q.x
      const dz = target.z - q.z
      // 목표가 발밑이면(0 거리) 방향이 정의되지 않는다 — 그때는 기존 규칙에 맡긴다.
      if (Math.hypot(dx, dz) > 0.2) kickFace = { id: q.p.id, aim: Math.atan2(dz, dx) }
    }
  }
  // 세리머니: 골 키프레임 이후 CELEBRATE_MS 동안 득점팀 전원.
  const goalT = seq ? seq[seq.length - 1].t : 0.4
  const celebrateSpan = Math.max(1e-6, CELEBRATE_MS / dwellMs)
  const scored = t >= goalT
  const celebrating = event?.type === 'goal' && scored && t <= goalT + celebrateSpan
  const scoringSide: 'home' | 'away' = event?.teamId === homeTeamId ? 'home' : 'away'
  const celebrateT = celebrating ? clamp((t - goalT) / celebrateSpan, 0, 1) : 0
  /**
   * 다이브 방향(로컬 ±Z) — **손이 접촉점에 닿는 쪽**. {@link gkDiveAnchor}가 순기구학으로
   * 푼 값이 정본이다. 앵커가 없는 경우(골 = 닿지 않는 다이브)만 접촉점의 월드 Z로 고른다.
   *
   * 예전에는 여기서 `side === 'home' ? -diveDir : diveDir`로 좌우를 뒤집었는데, 그것은
   * GK의 yaw를 통제하지 않던 시절의 근사였다. 지금은 yaw를 접촉 기하가 정하므로
   * 뒤집기는 오히려 손을 반대쪽으로 보낸다.
   */
  const beatenDir = contactWorld ? (contactWorld.z >= 0 ? 1 : -1) : 1
  // 다운: 파울 성립 후 볼에 가장 가까운 안무 팀 선수 1명.
  const fouled = !!sample && sample.finished && (event?.type === 'foul' || event?.type === 'yellow' || event?.type === 'red')
  let downId: string | null = null
  if (fouled) {
    let best = Infinity
    for (const q of posed) {
      if (q.p.side !== seqSide) continue
      const d = Math.hypot(q.x - ball.x, q.z - ball.z)
      if (d < best) { best = d; downId = q.p.id }
    }
  }

  // ── 5) 액션 ──────────────────────────────────────────────────────────
  const players: PlayerPose[] = posed.map(({ p, pp, x, z, speed, vx, vz }) => {
    // yaw: 이동 방향(정지 시 볼 방향)을 스무딩해 따라간다.
    const wasRun = pp?.action === 'run'
    const moving = speed >= (wasRun ? RUN_EXIT_SPEED : IDLE_SPEED)
    // ★ 다이브하는 GK는 **접촉 기하가 정한 방향**을 본다. yaw가 자유롭게 흔들리면
    //   손의 측방 도달(로컬 ±Z)이 접촉점을 빗나가고, 그것이 "공 따로 골키퍼 따로"가 된다.
    const facingDive = gkAnchor && p.isGk && p.side === divingSide && diving
    /**
     * ★ 차는 사람은 **공이 나갈 방향**을 본다(임팩트 전 선행 창부터).
     *
     * 왜 이동 방향으로는 안 되는가: 킥 순간 슈터는 공을 향해 달려가는 중이라 이동
     * 방향이 곧 주력 방향이고, 공은 목표로 나간다. 뒤로 흘려주는 패스면 "뒤를 보고
     * 차는데 공은 반대로"가 정확히 나온다 — 실측(90분 4시드 361킥): 임팩트 순간
     * |yaw − 볼 방향| **p50 83.3° · 90° 초과 46%**.
     * 다이브 GK는 접촉 기하가 우선한다(손이 공에 닿아야 한다).
     */
    const aim = facingDive
      ? gkAnchor.yaw
      : kickFace && kickFace.id === p.id
        ? kickFace.aim
        : moving
          ? Math.atan2(z - (pp?.z ?? z), x - (pp?.x ?? x))
          : Math.atan2(ball.z - z, ball.x - x)
    // ★ 장면 첫 프레임(cut)에 이미 차고 있는 선수는 스무딩을 건너뛴다. 빌드업 첫 패스와
    //   흐름(flow)의 첫 터치는 t=0이 곧 임팩트라 선행 창이 아예 없다 — 직전 장면이 남긴
    //   yaw에서 12%만 돌다가 차게 되고, 그것이 'ground'·'pass' 킥의 남은 오차였다.
    const cutFacing = input.cut && kickFace != null && kickFace.id === p.id
    const yaw = pp && !cutFacing ? approachAngle(pp.yaw, aim, dt > 0 ? 1 - Math.exp(-dt / YAW_TAU) : 0) : aim

    // 보폭 위상 — **이동거리 / 공유 보폭 모델**로 누적한다. 액션과 무관하게 항상 진행해야
    // 킥·세리머니 뒤 러닝으로 복귀할 때 다리가 튀지 않는다. 최초 프레임은 선수별 해시로
    // 분산시켜 22명이 한 몸처럼 걷지 않게 한다.
    const prevPhase = pp?.gaitPhase ?? unit(`gait:${p.id}`)
    const stepV = Math.max(speed, MIN_GAIT_SPEED)
    const gaitPhase = (((prevPhase + (stepV * dt) / strideLength(speed)) % 1) + 1) % 1

    let action: PlayerAction = moving ? 'run' : 'idle'
    // run의 actionT는 곧 보폭 위상이다(예전에는 별도 상수 보폭으로 계산돼 렌더러가 무시했다).
    let actionT = moving ? gaitPhase : (pp?.actionT ?? 0)
    let actionDir = 0
    if (kickerId === p.id) {
      action = kickIsHeader ? 'header' : 'kick'
      actionT = kickT
    }
    if (downId === p.id) {
      action = 'down'
      actionT = sample ? sample.after : 0
    }
    if (diving && p.isGk && p.side === divingSide) {
      action = 'dive'
      actionT = clamp(diveT, 0, 1)
      actionDir = gkAnchor ? gkAnchor.dir : (p.side === 'home' ? -beatenDir : beatenDir)
    }
    if (celebrating && p.side === scoringSide) {
      action = 'celebrate'
      actionT = celebrateT
    }

    return {
      id: p.id, side: p.side, number: p.number, x, z, yaw, speed, vx, vz, action, actionT, gaitPhase,
      ...(actionDir !== 0 ? { actionDir } : {}),
    }
  })

  // ── 6) focus·프레이밍 반경 스무딩 ────────────────────────────────────
  /**
   * 슛 국면에는 **볼이 아니라 슈터-접촉점 두 배역**을 프레임의 기준으로 삼는다.
   *
   * 실측(tools/scene-timing): 볼을 그대로 추종하면 볼 도착 시각에 슈터의 NDC x가
   * -1.29(세이브) · -2.26(골)로 프레임 밖이었다. 슛은 19 m를 날아가는데 highlight 타이트
   * 프리셋의 가시 폭이 16 m라 구조적으로 담기지 않는다. 방송 카메라는 이 국면에서
   * 공을 쫓지 않고 **슈터와 골문을 함께 문 채 정지**한다 — 그 문법을 반경으로 표현한다.
   */
  const strikeFrom = tShot - FRAME_LEAD_MS / dwellMs
  const strikeTo = tLay + FRAME_HOLD_MS / dwellMs
  const striking = seq != null && kicks.length > 0 && contactWorld != null && t >= strikeFrom && t <= strikeTo
  const focusTarget = striking && shotWorld && contactWorld
    ? { x: (shotWorld.x + contactWorld.x) / 2, z: (shotWorld.z + contactWorld.z) / 2 }
    : seq
      ? { x: ball.x, z: ball.z }
      : { x: ball.x * 0.3, z: ball.z * 0.3 } // 평시엔 중앙 근처에서 볼을 약하게 추종
  const radiusTarget = striking && shotWorld && contactWorld
    ? Math.hypot(contactWorld.x - shotWorld.x, contactWorld.z - shotWorld.z) / 2
    : 0
  // 장면 전환 프레임은 스무딩을 건너뛴다 — 카메라가 새 장면으로 **컷**된다.
  const fa = prev && !input.cut ? (dt > 0 ? 1 - Math.exp(-dt / FOCUS_TAU) : 0) : 1
  const focus = prev && !input.cut
    ? { x: lerp(prev.focus.x, focusTarget.x, fa), z: lerp(prev.focus.z, focusTarget.z, fa) }
    : focusTarget
  // 반경도 같은 시상수로 푼다 — 계단처럼 바뀌면 화각이 툭 튄다(줌 컷으로 읽힌다).
  const focusRadius = prev && !input.cut ? lerp(prev.focusRadius ?? 0, radiusTarget, fa) : radiusTarget

  return { players, ball, focus, focusRadius, event: frameEvent(event, homeTeamId, scored) }
}
