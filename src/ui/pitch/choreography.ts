// src/ui/pitch/choreography.ts
// 하이라이트 안무 — 이벤트 한 건을 "공·선수가 어떻게 움직였나"의 키프레임 시퀀스로
// 번역한다. PitchView/PixiPitch/Match3D가 이 좌표를 그대로 재생한다.
//
// ★ 구조(2026-07-30 개편): 좌표를 여기서 손으로 쓰지 않는다. `scenes.ts`의 장면
//   라이브러리(빌드업 × 마무리 × 레인)에서 한 벌을 꺼내 **역할 슬롯에 실제 선수를 꽂는**
//   것이 이 파일의 일이다. 빌드업은 유저가 고른 attackPattern이 정하고, 마무리는 엔진이
//   이미 정한 결과가 정한다 — 즉 화면은 "전술 × 결과"의 함수다.
//
// 설계 원칙(FM 교훈: 데드타임 금지):
//  - 첫 스텝(t=0)부터 공이 이미 중원 이상에 있다(자기 진영 롱빌드업 없음).
//  - 마지막 스텝 t ≤ 0.8 → dwell의 80% 안에 결과가 나오고, 남은 20%는 여운.
//  - 좌표는 home-프레임(좌→우 공격)으로 설계 후 away면 x를 미러(100-x)한다.
//  - 랜덤·시간 의존 없음. 변형은 이벤트 해시로만(결정론).
import type { AttackPattern, MatchEvent, SideState } from '../../engine/types'
import { slotCoords } from './formations'
import { LANE_COUNT, buildScene, type BallArc, type SceneFinish } from './scenes'

export type { BallArc } from './scenes'

/** 안무 키프레임 한 스텝. 좌표는 slotCoords와 동일한 0~100 피치 좌표. */
export interface ChoreoStep {
  /** dwell 내 상대 시각(0=시작, 1=dwell 끝). 첫 스텝 0, 마지막 ≤ 0.8. */
  t: number
  /** 공 위치(0~100). */
  ball: { x: number; y: number }
  /** 이 스텝에서 함께 달리는 선수 도트(공격 팀 2~3명). */
  movers: { playerId: string; x: number; y: number }[]
  /** 이 스텝에서 시작하는 구간의 볼 궤적. 미지정이면 렌더러가 이벤트 타입으로 추론한다. */
  arc?: BallArc
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/** FNV-1a + 애벌런치 마무리 — 레인 변형 선택용(Math.random 금지).
 *  ★ 마무리가 필요한 이유: 순수 FNV-1a는 하위 비트 확산이 약해, 한 글자만 다른 키
 *  (분만 다른 이벤트)를 작은 수로 나누면 잔여가 쏠린다. 실측에서 한 경기 최다 반복이
 *  6 → 3으로 떨어졌다. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  h = Math.imul(h, 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** 이벤트 타입 → 장면 마무리. 안무가 없는 타입은 null(빈 시퀀스). */
function finishFor(type: MatchEvent['type']): SceneFinish | null {
  switch (type) {
    case 'goal': return 'goal'
    case 'save': return 'save'
    case 'miss': return 'miss'
    case 'shot': return 'shot'
    case 'chance': return 'chance'
    case 'corner': return 'corner'
    case 'foul': case 'yellow': case 'red': return 'foul'
    // kickoff·sub·halftime·fulltime — 안무 없음.
    default: return null
  }
}

/**
 * 역할 슬롯(원형 좌표)에 가장 잘 맞는 실제 선수를 뽑는다.
 * GK(슬롯 0)는 제외 — 필드 장면의 무버는 GK가 아니다. 이미 뽑힌 선수는 건너뛴다.
 * 같은 거리면 슬롯 인덱스가 큰 쪽(더 공격적)을 택해 결정론을 유지한다.
 */
function pickByRole(side: SideState, roles: [number, number][], primary?: string): string[] {
  const { formation, lineup } = side.tactics
  const sentOff = new Set(side.sentOff)
  const taken = new Set<string>()
  const out: string[] = []
  // 이벤트 주인공(슈터·득점자)은 첫 역할 슬롯을 무조건 차지한다 — 엔진이 정한 배역이다.
  if (primary && lineup.some(s => s.playerId === primary)) {
    out.push(primary)
    taken.add(primary)
  }
  for (const [rx, ry] of roles) {
    if (out.length >= roles.length) break
    let bestId: string | null = null
    let bestD = Infinity
    for (let i = 1; i < lineup.length; i++) {
      const id = lineup[i].playerId
      if (taken.has(id) || sentOff.has(id)) continue
      const c = slotCoords(formation, i, 'home')
      const d = (c.x - rx) ** 2 + (c.y - ry) ** 2
      if (d <= bestD) { bestD = d; bestId = id }
    }
    if (!bestId) break
    out.push(bestId)
    taken.add(bestId)
  }
  return out.slice(0, roles.length)
}

/**
 * 이벤트 → 안무 키프레임 시퀀스. 안무가 없는 타입은 빈 배열.
 *
 * 안무가 있는 타입은 playback.DRAMA_PRIORITY(주인공 선택자의 후보 집합)와 정확히
 * 일치해야 한다 — 화면이 그릴 수 없는 이벤트를 음성이 주인공으로 고르면 안 된다.
 * 이 일치는 choreography.test.ts가 양방향으로 고정한다.
 *
 * @param event      연출할 이벤트(goal/shot/chance/save/miss/corner/foul 등).
 * @param homeState  홈 팀 상태(공격 방향·라인업·공격 패턴 판정).
 * @param awayState  어웨이 팀 상태.
 */
export function buildSequence(event: MatchEvent, homeState: SideState, awayState: SideState): ChoreoStep[] {
  const finish = finishFor(event.type)
  if (!finish) return []
  const isHome = event.teamId === homeState.team.id
  const attacking = isHome ? homeState : awayState
  const pattern: AttackPattern = attacking.tactics.attackPattern ?? 'balanced'
  const scene = buildScene(pattern, finish, laneFor(event))
  const ids = pickByRole(attacking, scene.roles, event.playerId)

  // away면 x 미러(100-x). y는 불변.
  const fx = (x: number) => (isHome ? x : 100 - x)
  return scene.points.map(p => ({
    t: p.t,
    ball: { x: clamp(fx(p.ball[0])), y: clamp(p.ball[1]) },
    movers: ids.map((playerId, i) => {
      const m = p.movers[i] ?? p.movers[p.movers.length - 1]
      return { playerId, x: clamp(fx(m[0])), y: clamp(m[1]) }
    }),
    ...(p.arc ? { arc: p.arc } : {}),
  }))
}

/** 이벤트 → 레인 변형 인덱스(0~3). 분·타입·선수를 섞어 같은 분에 몰리지 않게 한다. */
function laneFor(event: MatchEvent): number {
  return hash(`${event.minute}:${event.type}:${event.playerId ?? ''}:${event.teamId}`) % LANE_COUNT
}

/**
 * 이 이벤트가 어떤 장면을 쓰는지의 식별자 — 반복 측정·디버그 전용(렌더에 쓰지 않는다).
 * 예: `kor/wing/goal/L1`. 팀을 포함하는 이유는 좌우 미러가 사실상 다른 그림이기 때문이다.
 */
export function sceneKeyFor(event: MatchEvent, homeState: SideState, awayState: SideState): string | null {
  const finish = finishFor(event.type)
  if (!finish) return null
  const isHome = event.teamId === homeState.team.id
  const attacking = isHome ? homeState : awayState
  const pattern: AttackPattern = attacking.tactics.attackPattern ?? 'balanced'
  return `${isHome ? 'H' : 'A'}/${buildScene(pattern, finish, laneFor(event)).key}`
}
