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
import type { ChoreoStep } from '../choreography'
import { slotCoords } from '../formations'
// 보폭 모델은 표시 계층 전체가 **하나**를 공유한다(player3d가 정본).
// player3d는 three를 정적 import하지 않으므로 이 import로 번들이 커지지 않는다.
import { MIN_GAIT_SPEED, strideLength } from './player3d'
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
/** 수렴 시 공에 이보다 가까이 붙지 않는다(m) — 선수끼리 공 좌표에 겹치는 것 방지. */
export const STANDOFF = 1.2
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
/** 킥 모션이 유지되는 구간 진행도. */
const KICK_WINDOW = 0.3
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

/** 볼 궤적 종류 — 이벤트 타입과 구간 인덱스로 결정된다. */
export type BallArcKind = 'ground' | 'pass' | 'shot' | 'cross'

/** 궤적별 최고 높이(m). ground는 공 반지름(=지면). */
export const BALL_PEAK: Record<BallArcKind, number> = {
  ground: BALL_RADIUS,
  pass: 1.2,
  shot: 2.5,
  cross: 6,
}

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

/** 궤적 종류·구간 진행도 → 공 높이(m). 최고점은 BALL_PEAK와 정확히 일치한다. */
export function ballHeight(kind: BallArcKind, u: number): number {
  const p = clamp(u, 0, 1)
  const amp = BALL_PEAK[kind] - BALL_RADIUS
  if (amp <= 0) return BALL_RADIUS
  // 슛은 끝에서 정점(상승 궤적), 패스·크로스는 중간에서 정점(포물선).
  const shape = kind === 'shot' ? Math.sin((Math.PI / 2) * p) : Math.sin(Math.PI * p)
  return BALL_RADIUS + amp * shape
}

/** 안무 키프레임 배열을 시각 t(0~1)로 샘플링한다(0~100 좌표계 유지). */
export function sampleSequence(sequence: ChoreoStep[], t: number): SeqSample {
  const steps = sequence
  const last = steps[steps.length - 1]
  const tc = clamp(t, 0, 1)
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
  const nextById = new Map(b.movers.map(m => [m.playerId, m]))
  return {
    ball: { x: lerp(a.ball.x, b.ball.x, u), y: lerp(a.ball.y, b.ball.y, u) },
    movers: a.movers.map(m => {
      const n = nextById.get(m.playerId) ?? m
      return { playerId: m.playerId, x: lerp(m.x, n.x, u), y: lerp(m.y, n.y, u) }
    }),
    segIndex: k,
    u,
    finished: false,
    after: 0,
    start: a,
  }
}

/** 안무가 없을 때의 볼 — 중원을 완만히 순환하며 우세 팀(momentum) 쪽으로 드리프트. */
function idleBall(minute: number, t: number, momentum: number, seed: number): { x: number; y: number; z: number } {
  // 분 경계에서 끊기지 않도록 위상은 (minute + t)의 연속 함수, 시드는 상수 오프셋만.
  const phase = (minute + t) * 0.9 + unit(`ball:${seed}`) * TAU
  const drift = clamp(momentum, -1, 1) * 16
  return {
    x: clamp(drift + Math.cos(phase) * 14, -HALF_W + 2, HALF_W - 2),
    y: BALL_RADIUS,
    z: clamp(Math.sin(phase * 0.8) * 12, -HALF_H + 2, HALF_H - 2),
  }
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
      const c = slotCoords(st.tactics.formation, index, side)
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
  const sample = seq ? sampleSequence(seq, t) : null
  const segCount = seq ? seq.length - 1 : 0
  const arc = sample ? arcKindFor(event?.type, sample.segIndex, segCount) : 'ground'
  let ballPos: { x: number; y: number; z: number }
  if (sample) {
    const w = toWorld(sample.ball.x, sample.ball.y)
    const y = sample.finished
      ? lerp(ballHeight(arc, 1), BALL_RADIUS, sample.after) // 여운 구간엔 지면으로 안착
      : ballHeight(arc, sample.u)
    ballPos = { x: w.x, y, z: w.z }
  } else {
    ballPos = idleBall(input.minute, t, input.state.momentum, input.seed)
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
  // 킥: 구간 시작 볼에 가장 가까운 안무 팀 선수. KICK_REACH 밖이면 아무도 차지
  // 않는다(안무 무버는 속도 클램프로 뒤처질 수 있어 "허공 슛"이 되기 때문).
  let kickerId: string | null = null
  if (sample && !sample.finished && arc !== 'ground' && sample.u < KICK_WINDOW) {
    const sb = toWorld(sample.start.ball.x, sample.start.ball.y)
    let best = KICK_REACH
    for (const q of posed) {
      if (q.p.side !== seqSide) continue
      const d = Math.hypot(q.x - sb.x, q.z - sb.z)
      if (d < best) { best = d; kickerId = q.p.id }
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
  const divingSide: 'home' | 'away' = seqSide === 'home' ? 'away' : 'home'
  const diving = !!sample && event?.type === 'save' && (sample.finished || sample.segIndex >= segCount - 1)
  const diveT = sample ? (sample.finished ? 1 : sample.u) : 0
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
    if (kickerId === p.id) {
      action = 'kick'
      actionT = clamp((sample?.u ?? 0) / KICK_WINDOW, 0, 1)
    }
    if (downId === p.id) {
      action = 'down'
      actionT = sample ? sample.after : 0
    }
    if (diving && p.isGk && p.side === divingSide) {
      action = 'dive'
      actionT = clamp(diveT, 0, 1)
    }
    if (celebrating && p.side === scoringSide) {
      action = 'celebrate'
      actionT = celebrateT
    }

    return { id: p.id, side: p.side, number: p.number, x, z, yaw, speed, action, actionT, gaitPhase }
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
