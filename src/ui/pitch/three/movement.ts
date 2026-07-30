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
import type { BallArc, ChoreoStep } from '../choreography'
import { possessingSide } from '../flow'
// 정적 배치의 정본은 **전술이 반영된** 좌표다. slotCoords(포메이션 원형)를 쓰면
// 라인 높이를 올린 유저가 라이브(3D)→분석(2D) 디졸브에서 수비진이 최대 15m
// 미끄러지는 것을 본다 — 3D와 2D 작전판은 같은 숫자에서 파생돼야 한다.
import { tacticalCoords } from '../shape'
// 보폭 모델은 표시 계층 전체가 **하나**를 공유한다(player3d가 정본).
// player3d는 three를 정적 import하지 않으므로 이 import로 번들이 커지지 않는다.
// 공유 보폭 모델은 순수 계층(pose.ts)에서 온다 — 리그 빌더(player3d)를 거치지 않는다.
import { MIN_GAIT_SPEED, strideLength } from './pose'
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
export function ballHeight(kind: BallArcKind, u: number): number {
  const p = clamp(u, 0, 1)
  const P = BALL_PEAK[kind] - BALL_RADIUS
  if (P <= 1e-9) return BALL_RADIUS
  const D = BALL_END[kind] - BALL_RADIUS
  const b = 2 * P + 2 * Math.sqrt(Math.max(0, P * (P - D)))
  const c = D - b
  return BALL_RADIUS + b * p + c * p * p
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

/** 한 번의 킥 — 누가, 언제(dwell 상대 t) 공을 찬다. */
export interface KickEvent {
  playerId: string
  /** 임팩트 시각(= 볼이 출발하는 키프레임의 t). */
  tImpact: number
  /** 임팩트 시점의 볼 좌표(0~100). */
  ball: { x: number; y: number }
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
    out.push({ playerId: a.carrier, tImpact: a.t, ball: { ...a.ball } })
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

// ── GK 다이브 인과 ────────────────────────────────────────────────────────
/** 시각 단서 → 근육 활성까지의 반응 지연(ms). 스포츠 과학 관례값 180~250의 중앙. */
export const GK_REACTION_MS = 200
/** 도약 → 최대 신전(=볼 접촉)까지(ms). 문헌 500~700의 하한. */
export const GK_DIVE_MS = 550
/** 접촉 이후 착지·정착(ms). */
export const GK_SETTLE_MS = 450
/** `pose.diveAngles`가 완전 측와가 되는 진행도 — 이 값이 볼 도착과 일치해야 한다. */
const DIVE_LAY_U = 0.55

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
      const g = gkTarget(side, ball)
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
    out.push({ id, side, number: numberById.get(id) ?? 0, index, isGk, mover, tx, tz })
  })
  return out
}

/** GK 목표 — 볼이 상대 진영으로 갈수록 전진(스위퍼), 좌우는 볼 Z를 약하게 추종. */
function gkTarget(side: 'home' | 'away', ball: { x: number; z: number }): { x: number; z: number } {
  const box = gkBox(side)
  const ownGoalX = side === 'home' ? -HALF_W : HALF_W
  const f = clamp(Math.abs(ball.x - ownGoalX) / PITCH_W, 0, 1)
  const depth = lerp(0.6, GK_BOX_DEPTH - 0.3, f)
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
function applyConvergence(plans: Plan[], ball: { x: number; z: number }, side: 'home' | 'away'): void {
  const cand = plans
    .filter(p => !p.isGk && !p.mover)
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
    if (q.pp) {
      // 이동 예산(속도 클램프) 재적용 — 분리·클램프로 인한 순간이동 금지.
      const dx = q.x - q.pp.x
      const dz = q.z - q.pp.z
      const d = Math.hypot(dx, dz)
      const budget = q.cap * dt
      if (d > budget && d > 1e-9) {
        q.x = q.pp.x + (dx / d) * budget
        q.z = q.pp.z + (dz / d) * budget
      }
    }
    q.speed = q.pp && dt > 0 ? Math.hypot(q.x - q.pp.x, q.z - q.pp.z) / dt : 0
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
  const seqSide: 'home' | 'away' = input.sequenceSide ?? 'home'
  const event = resolveEvent(input)
  const prev = input.prev
  const homeTeamId = input.state.home.team.id

  // ── 1) 볼 ────────────────────────────────────────────────────────────
  const sample = seq ? sampleSequence(seq, t, MOVER_LOOKAHEAD_MS / dwellMs) : null
  const segCount = seq ? seq.length - 1 : 0
  // 궤적은 **장면이 저술한 값이 우선**한다(크로스는 크로스로 떠야 한다). 없으면 타입 추론.
  const arc: BallArcKind = sample
    ? (sample.start.arc ?? arcKindFor(event?.type, sample.segIndex, segCount))
    : 'ground'
  let ballPos: { x: number; y: number; z: number }
  if (sample) {
    const w = toWorld(sample.ball.x, sample.ball.y)
    const y = sample.finished
      ? lerp(ballHeight(arc, 1), BALL_RADIUS, sample.after) // 여운 구간엔 지면으로 안착
      : ballHeight(arc, sample.u)
    ballPos = { x: w.x, y, z: w.z }
  } else {
    ballPos = idleBall(input.state, input.minute, t, input.seed)
  }
  const rolled = prev ? Math.hypot(ballPos.x - prev.ball.x, ballPos.z - prev.ball.z) : 0
  const spinRaw = (prev?.ball.spin ?? 0) + rolled / BALL_RADIUS
  const ball: BallPose = { ...ballPos, spin: ((spinRaw % TAU) + TAU) % TAU }

  // ── 2) 목표 위치 ─────────────────────────────────────────────────────
  const moverById = new Map<string, { x: number; y: number }>()
  if (sample) for (const m of sample.movers) moverById.set(m.playerId, { x: m.x, y: m.y })

  const homePlans = planSide('home', input.state.home, ball, moverById, input.minute, t, input.seed)
  const awayPlans = planSide('away', input.state.away, ball, moverById, input.minute, t, input.seed)
  applyConvergence(homePlans, ball, 'home')
  applyConvergence(awayPlans, ball, 'away')
  const plans = [...homePlans, ...awayPlans]

  // ── 3) 스텝(속도 클램프) + 포즈 분리 ─────────────────────────────────
  const prevById = new Map((prev?.players ?? []).map(p => [p.id, p]))
  const posed = plans.map(p => {
    const box = p.isGk ? gkBox(p.side) : null
    const tx = box ? clamp(p.tx, box.xMin, box.xMax) : clamp(p.tx, -HALF_W + EDGE_MARGIN, HALF_W - EDGE_MARGIN)
    const tz = box ? clamp(p.tz, box.zMin, box.zMax) : clamp(p.tz, -HALF_H + EDGE_MARGIN, HALF_H - EDGE_MARGIN)
    const pp = prevById.get(p.id)
    const stamina = clamp((input.state[p.side].staminaByPlayer[p.id] ?? 100) / 100, 0, 1)
    const cap = (p.isGk ? GK_MAX_SPEED : MAX_SPEED) * (0.78 + 0.22 * stamina)

    let x = tx
    let z = tz
    if (pp && dt > 0) {
      const dx = tx - pp.x
      const dz = tz - pp.z
      const d = Math.hypot(dx, dz)
      const arrive = d < ARRIVE_RADIUS ? d / ARRIVE_RADIUS : 1
      const step = Math.min(d, cap * dt * arrive)
      x = d > 1e-9 ? pp.x + (dx / d) * step : pp.x
      z = d > 1e-9 ? pp.z + (dz / d) * step : pp.z
    } else if (pp) {
      x = pp.x
      z = pp.z
    }
    return { p, pp, box, cap, x, z, speed: 0 }
  })
  separatePoses(posed, dt)

  // ── 4) 액션 컨텍스트(실제 포즈 기준) ─────────────────────────────────
  // 킥: **저술이 지정한 캐리어**가 찬다. 임팩트 프레임(actionT ≈ 0.45)이 볼 출발 시각과
  // 정확히 일치하도록 백스윙 260 ms를 앞당겨 창을 연다(역방향 스케줄링).
  // KICK_REACH 밖이면 취소한다 — 속도 클램프로 뒤처졌다면 "허공 슛"이 되기 때문이다.
  const kicks = seq ? kickEvents(seq) : []
  const kickNow = seq ? kickAt(kicks, t, dwellMs) : null
  let kickerId: string | null = null
  let kickT = 0
  if (kickNow) {
    const q = posed.find(o => o.p.id === kickNow.kick.playerId)
    if (q) {
      const kb = toWorld(kickNow.kick.ball.x, kickNow.kick.ball.y)
      if (Math.hypot(q.x - kb.x, q.z - kb.z) < KICK_REACH) {
        kickerId = q.p.id
        kickT = kickNow.actionT
      }
    }
  }
  // 세리머니: 골 키프레임 이후 CELEBRATE_MS 동안 득점팀 전원.
  const goalT = seq ? seq[seq.length - 1].t : 0.4
  const celebrateSpan = Math.max(1e-6, CELEBRATE_MS / dwellMs)
  const scored = t >= goalT
  const celebrating = event?.type === 'goal' && scored && t <= goalT + celebrateSpan
  const scoringSide: 'home' | 'away' = event?.teamId === homeTeamId ? 'home' : 'away'
  const celebrateT = celebrating ? clamp((t - goalT) / celebrateSpan, 0, 1) : 0
  // 다이브: 슛을 받는 쪽(안무의 볼이 향하는 골문) GK.
  // **최대 신전 = 볼 도착**이 되도록 역산한다(§R4). 예전엔 슛 임팩트와 동시에 시작해
  // 볼보다 473 ms 먼저 잔디에 누웠다.
  const divingSide: 'home' | 'away' = seqSide === 'home' ? 'away' : 'home'
  const tArrive = seq ? seq[seq.length - 1].t : 0
  const tShot = kicks.length > 0 ? kicks[kicks.length - 1].tImpact : tArrive
  const diveU = seq && event?.type === 'save' ? diveScheduleAt(tShot, tArrive, t, dwellMs) : null
  const diving = diveU != null
  const diveT = diveU ?? 0
  // 다이브 방향 — 볼이 향하는 쪽(월드 Z)으로 눕는다. 예전엔 선수 id 해시로 좌우를
  // 아무렇게나 골랐다(볼과 반대로 뛰는 GK가 절반).
  const diveDir = seq ? (toWorld(seq[seq.length - 1].ball.x, seq[seq.length - 1].ball.y).z >= 0 ? 1 : -1) : 1
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
  const players: PlayerPose[] = posed.map(({ p, pp, x, z, speed }) => {
    // yaw: 이동 방향(정지 시 볼 방향)을 스무딩해 따라간다.
    const wasRun = pp?.action === 'run'
    const moving = speed >= (wasRun ? RUN_EXIT_SPEED : IDLE_SPEED)
    const aim = moving
      ? Math.atan2(z - (pp?.z ?? z), x - (pp?.x ?? x))
      : Math.atan2(ball.z - z, ball.x - x)
    const yaw = pp ? approachAngle(pp.yaw, aim, dt > 0 ? 1 - Math.exp(-dt / YAW_TAU) : 0) : aim

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
      action = 'kick'
      actionT = kickT
    }
    if (downId === p.id) {
      action = 'down'
      actionT = sample ? sample.after : 0
    }
    if (diving && p.isGk && p.side === divingSide) {
      action = 'dive'
      actionT = clamp(diveT, 0, 1)
      // 홈 GK는 -X 골문을 지키므로 로컬 +Z가 월드 +Z와 반대다(yaw 180°).
      actionDir = p.side === 'home' ? -diveDir : diveDir
    }
    if (celebrating && p.side === scoringSide) {
      action = 'celebrate'
      actionT = celebrateT
    }

    return {
      id: p.id, side: p.side, number: p.number, x, z, yaw, speed, action, actionT, gaitPhase,
      ...(actionDir !== 0 ? { actionDir } : {}),
    }
  })

  // ── 6) focus 스무딩 ──────────────────────────────────────────────────
  const focusTarget = seq
    ? { x: ball.x, z: ball.z }
    : { x: ball.x * 0.3, z: ball.z * 0.3 } // 평시엔 중앙 근처에서 볼을 약하게 추종
  const fa = prev ? (dt > 0 ? 1 - Math.exp(-dt / FOCUS_TAU) : 0) : 1
  const focus = prev
    ? { x: lerp(prev.focus.x, focusTarget.x, fa), z: lerp(prev.focus.z, focusTarget.z, fa) }
    : focusTarget

  return { players, ball, focus, event: frameEvent(event, homeTeamId, scored) }
}
