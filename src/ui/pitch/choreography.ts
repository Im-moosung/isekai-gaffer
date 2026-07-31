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
import {
  BUILDUP_VARIANT_COUNT,
  FINISH_VARIANT_COUNT,
  LANE_COUNT,
  buildScene,
  type BallArc,
  type SceneFinish,
  type SceneVariants,
} from './scenes'

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
  /**
   * 이 스텝에서 **공을 소유한 선수**의 id. 없으면 공이 자유(비행 중/결과 지점).
   *
   * ★ 왜 필요한가: 예전 렌더러는 "구간 시작 볼에서 가장 가까운 아무나"에게 킥 모션을
   *   줬다. 실측에서 그 선수는 엔진이 정한 슈터도, 안무 무버도 아닌 **수렴 로직에 빨려온
   *   일반 선수**였다(docs/research/football-sim-physics.md §1.1). 소유자는 저술이 안다.
   */
  carrier?: string
  /**
   * 이 스텝의 **도착 높이**(m). 미지정이면 궤적 종류의 기본값. 크로스바를 넘겨 버리는
   * 미스처럼 "골라인 통과 높이"가 장면의 핵심일 때만 저술이 채운다(scenes.ScenePoint.endY).
   */
  endY?: number
  /**
   * 이 스텝이 **GK의 손이 공에 닿는 순간**인가(세이브 전용). movement가 다이브 최대
   * 신전 시각과 GK 몸통 목표를 이 스텝에서 역산한다 — "마지막 키프레임 = 접촉"이라는
   * 암묵 규약을 명시 계약으로 바꾼 것이다.
   */
  contact?: boolean
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/** FNV-1a + 애벌런치 마무리 — 장면 변형 선택용(Math.random 금지).
 *  ★ 마무리가 필요한 이유: 순수 FNV-1a는 하위 비트 확산이 약해, 한 글자만 다른 키
 *  (분만 다른 이벤트)를 작은 수로 나누면 잔여가 쏠린다. 실측에서 한 경기 최다 반복이
 *  6 → 3으로 떨어졌다.
 *  ★ 2026-07-30 재검증: 실제로 등장한 이벤트 키 542종의 레인 분포 χ²=2.4(자유도 5)로
 *  완전 균일이었다. 즉 남은 반복은 해시 편향이 아니라 **칸 수 부족**이었고, 처방은
 *  확산 강화가 아니라 변형 축을 늘리는 것이었다(scenes.ts 참조). */
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
 * 이 이벤트에서 **공격(=안무를 재생하는) 팀**은 어느 쪽인가.
 *
 * ★ 2026-07-31 발견한 거울상 버그. 엔진은 이벤트 대부분을 공격 팀 사건으로 기록하지만
 *   **`save`만 막은 팀(수비)의 사건**이다 — `simulate.ts` L649:
 *   `{ type: 'save', teamId: def.team.id, playerId: gk.id }`.
 *   그런데 안무는 `event.teamId`를 공격 팀으로 믿고 좌표를 미러했다. 그 결과 실제 재생된
 *   세이브 장면은 사건의 **완전한 거울상**이었다(실측, seed 42 / 10분):
 *     - 볼이 x 42 → 98로 **반대편 골문**을 향했다(실제 슛은 우리 골문 쪽이었다)
 *     - 역할 슬롯 0(=슈터)에 `event.playerId`, 즉 **골키퍼**가 꽂혔다
 *     - 몸을 던진 GK도 실제로 막은 GK가 아니라 반대편 GK였다
 *   사용자 캡처의 "GK 혼자 넘어져 있고 공은 딴 데"가 여기서도 나온다 — 화면에 그려진
 *   세이브는 애초에 그 사건이 아니었다.
 */
export function attackingSideOf(event: MatchEvent, homeTeamId: string): 'home' | 'away' {
  const owner: 'home' | 'away' = event.teamId === homeTeamId ? 'home' : 'away'
  // save = 수비 팀의 사건 → 공격은 그 반대. 나머지는 teamId가 곧 공격 팀이다.
  return event.type === 'save' ? (owner === 'home' ? 'away' : 'home') : owner
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
  const isHome = attackingSideOf(event, homeState.team.id) === 'home'
  const attacking = isHome ? homeState : awayState
  const pattern: AttackPattern = attacking.tactics.attackPattern ?? 'balanced'
  const scene = buildScene(pattern, finish, laneFor(event), variantsFor(event))
  // ★ 주인공을 슬롯 0에 꽂는 것은 그 선수가 **공격 팀의 필드 플레이어**일 때만이다.
  //   save의 playerId는 막은 팀의 GK다 — 넘기면 골키퍼가 슈터로 배정된다(실측).
  const ids = pickByRole(attacking, scene.roles, primaryOf(event, attacking))

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
    // 캐리어 슬롯 → 실제 선수 id. 슬롯보다 배정된 선수가 적으면(퇴장 등) 소유자 없음.
    ...(p.carrier != null && ids[p.carrier] ? { carrier: ids[p.carrier] } : {}),
    ...(p.endY != null ? { endY: p.endY } : {}),
    ...(p.contact ? { contact: true as const } : {}),
  }))
}

/**
 * 슬롯 0(슈터)에 강제로 꽂을 선수. 공격 팀의 **필드 플레이어**일 때만 유효하다.
 * GK(슬롯 0)와 다른 팀 선수는 걸러진다 — 그러면 역할 좌표로 정상 배정된다.
 */
function primaryOf(event: MatchEvent, attacking: SideState): string | undefined {
  const id = event.playerId
  if (!id) return undefined
  const i = attacking.tactics.lineup.findIndex(s => s.playerId === id)
  return i > 0 ? id : undefined
}

/**
 * 이벤트 → 레인 변형 인덱스(0~5). 분·타입·선수를 섞어 같은 분에 몰리지 않게 한다.
 *
 * ★ 2026-07-31: 키에서 **teamId를 뺐다.** 슛 지점을 "골문까지의 거리"로 저술하게 되면서
 *   깊이(x)가 좌우 오프셋(y)의 함수가 됐고(scenes.finishStations), 레인이 곧 y다.
 *   teamId가 레인을 가르면 같은 사건의 홈·원정 x가 서로 미러가 아니게 된다
 *   (실측: 홈 x + 원정 x = 92.99, 규약은 100 — `choreography.test.ts`의 미러 계약).
 *   실제 경기에서는 두 팀의 `playerId`가 다르므로 teamId 없이도 레인은 갈린다.
 */
function laneFor(event: MatchEvent): number {
  return hash(`lane|${event.minute}:${event.type}:${event.playerId ?? ''}`) % LANE_COUNT
}

/**
 * 이벤트 → 빌드업 실행·마무리 변형. 축마다 **다른 salt**를 써서 서로 독립이 되게 한다
 * (같은 해시를 나눠 쓰면 두 축이 붙어 다녀 칸 수가 늘지 않는다).
 *
 * ★ 키에 teamId를 넣지 않는 이유: 좌우 미러 계약 때문이다. 같은 사건을 홈이 하든 원정이
 *   하든 x는 서로 미러(합 100)여야 하는데, teamId가 변형을 가르면 슈팅 지점 x부터 달라져
 *   미러가 깨진다. 레인(y축)은 teamId를 포함해도 x에 영향이 없으므로 그대로 둔다.
 */
function variantsFor(event: MatchEvent): SceneVariants {
  const core = `${event.minute}:${event.type}:${event.playerId ?? ''}`
  return {
    buildup: hash(`bv|${core}`) % BUILDUP_VARIANT_COUNT,
    finish: hash(`fv|${core}`) % FINISH_VARIANT_COUNT,
  }
}

/**
 * 이 이벤트가 어떤 장면을 쓰는지의 식별자 — 반복 측정·디버그 전용(렌더에 쓰지 않는다).
 * 예: `H/wing.b/goal.c/L1`. 팀을 포함하는 이유는 좌우 미러가 사실상 다른 그림이기 때문이다.
 */
export function sceneKeyFor(event: MatchEvent, homeState: SideState, awayState: SideState): string | null {
  const finish = finishFor(event.type)
  if (!finish) return null
  const isHome = attackingSideOf(event, homeState.team.id) === 'home'
  const attacking = isHome ? homeState : awayState
  const pattern: AttackPattern = attacking.tactics.attackPattern ?? 'balanced'
  return `${isHome ? 'H' : 'A'}/${buildScene(pattern, finish, laneFor(event), variantsFor(event)).key}`
}
