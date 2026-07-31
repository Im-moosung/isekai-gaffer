// src/ui/pitch/three/entrance.ts
// 경기 시작 입장 연출 — 순수 로직(터널 → 워크아웃 → 정렬 → 선수 소개 → 흩어짐).
//
// 설계 원칙(Phase 4E Global Constraints를 그대로 따른다):
//  - **three 무의존**: 타입조차 three를 import하지 않는다. 이 모듈은 엔트리 번들에
//    정적으로 실려도 되는 순수 TS다(three가 새면 3D 코드 스플릿이 통째로 깨진다).
//    보폭 모델만 player3d에서 가져오는데, player3d는 three를 `import type`으로만
//    쓰므로 런타임 의존이 생기지 않는다(movement.ts와 같은 이유·같은 방식).
//  - **Math.random·Date 금지**: 시간은 호출부가 주는 ms 인자로만 흐르고, 개인차는
//    선수 id의 FNV-1a 해시로만 만든다. 같은 (cast, ms) → 완전히 같은 프레임.
//  - **표시 전용**: 엔진 상태를 읽기만 하고 절대 쓰지 않는다.
//
// 좌표계는 ./types.ts가 정본이다(피치 105×68m, 원점 센터서클, XZ 평면).
// 방송 카메라는 -Z 쪽 사이드라인에 있으므로(camera.ts BROADCAST_Z = -55)
// **-Z가 "카메라·메인스탠드 쪽"**이다. 실제 중계처럼 터널을 카메라 쪽 터치라인에 두고,
// 선수들은 피치 안쪽(+Z)으로 걸어나온 뒤 몸을 돌려 메인스탠드를 바라본다.
import type { FormationId, Instructions, MatchState, Position, SideState } from '../../../engine/types'
import { tacticalCoords } from '../shape'
import type { CameraMode } from './camera'
// 보폭 모델은 표시 계층 전체가 **하나**를 공유한다(player3d가 정본).
// 공유 보폭 모델은 순수 계층(pose.ts)에서 온다 — 리그 빌더(player3d)를 거치지 않는다.
import { MIN_GAIT_SPEED, strideLength } from './pose'
import { toWorld, type BallPose, type FrameState, type PlayerPose } from './types'

// ── 타임라인 ────────────────────────────────────────────────────────────────
// 총 13.5초. 실제 중계의 입장 의식은 2~3분이지만 여기서는 **첫인상 전용 압축본**이다.
// 배분 근거:
//  - tunnel 1.8s: "무언가 시작된다"를 알리는 정지→기동 구간. 이보다 짧으면 인지 전에 끝난다.
//  - walkout 3.6s: 두 줄이 대열을 유지한 채 하프라인 쪽으로 나오는 핵심 그림. 가장 길다.
//  - lineup 0.9s: 정렬 완료 후 숨. 소개 카드가 들어오기 전 "정적"이 있어야 카드가 산다.
//  - intro 5.5s: 홈 XI 11명 × 0.5s. 0.5s는 등번호·이름을 읽을 수 있는 최소 노출이며
//    (방송 로어서드도 통상 0.5~0.8s), 11명이 6초를 넘으면 지루해진다.
//  - disperse 2.0s: 킥오프 포지션으로 흩어지는 전환. 최장 이동(GK → 자기 골문 ≈ 60m)이
//    실제라면 10초는 걸리는 거리라 여기는 명백한 "배속 전환"이다. smoothstep으로
//    감속 착지시켜 순간이동으로 보이지 않게 하고, 2.0s 아래로 줄이면 한 프레임 보폭이
//    한 스트라이드를 넘어(위상 언랩 불가) 다리 애니메이션이 깨진다.
export const ENTRANCE_TUNNEL_MS = 1800
export const ENTRANCE_WALKOUT_MS = 3600
export const ENTRANCE_LINEUP_MS = 900
export const ENTRANCE_INTRO_MS = 5500
export const ENTRANCE_DISPERSE_MS = 2000

/** 입장 연출 전체 길이(ms). */
export const ENTRANCE_TOTAL_MS =
  ENTRANCE_TUNNEL_MS + ENTRANCE_WALKOUT_MS + ENTRANCE_LINEUP_MS + ENTRANCE_INTRO_MS + ENTRANCE_DISPERSE_MS

export type EntrancePhase = 'tunnel' | 'walkout' | 'lineup' | 'intro' | 'disperse' | 'done'

export interface EntrancePhaseWindow {
  phase: EntrancePhase
  /** 단계 시작 ms(‘done’은 총 길이). */
  start: number
  /** 단계 종료 ms(‘done’은 Infinity). */
  end: number
  /** 단계 내 진행도 0~1(‘done’은 1). */
  u: number
}

interface PhaseSpan {
  phase: EntrancePhase
  start: number
  end: number
}

/** 단계 구간표(누적). 테스트가 총합을 검증한다. */
export const ENTRANCE_PHASES: readonly PhaseSpan[] = (() => {
  const spans: PhaseSpan[] = []
  let at = 0
  const push = (phase: EntrancePhase, ms: number) => {
    spans.push({ phase, start: at, end: at + ms })
    at += ms
  }
  push('tunnel', ENTRANCE_TUNNEL_MS)
  push('walkout', ENTRANCE_WALKOUT_MS)
  push('lineup', ENTRANCE_LINEUP_MS)
  push('intro', ENTRANCE_INTRO_MS)
  push('disperse', ENTRANCE_DISPERSE_MS)
  return spans
})()

const TUNNEL_END = ENTRANCE_PHASES[0].end
const WALKOUT_END = ENTRANCE_PHASES[1].end
const LINEUP_START = ENTRANCE_PHASES[2].start
const LINEUP_END = ENTRANCE_PHASES[2].end
const INTRO_END = ENTRANCE_PHASES[3].end

// ── 무대 배치(월드 좌표, m) ─────────────────────────────────────────────────
/** 터널 열: 홈 파일의 Z(카메라 쪽 터치라인 바로 안쪽). */
const HOME_COL_Z = -33.2
/** 터널 열: 어웨이 파일의 Z(홈 파일 바깥 = 아직 라인 밖에서 따라 나온다). */
const AWAY_COL_Z = -35
/** 열의 선두 X. 열은 +X 쪽으로 꼬리를 늘어뜨리고 -X 쪽으로 행진한다. */
const COL_HEAD_X = -2
/** 열의 사람 간 간격(m). */
const COL_GAP = 1.6
/** 터널 안쪽으로 물러난 거리(m) — tunnel 단계에서 이만큼 걸어 나온다. */
const COL_BACK = 2.5

/** 정렬 줄: 홈은 앞줄(카메라에 가깝다). */
const HOME_ROW_Z = -30.5
/** 정렬 줄: 어웨이는 홈 줄 뒤. */
const AWAY_ROW_Z = -26.5
/** 정렬 줄의 사람 간 간격(m). */
const ROW_GAP = 1.8
/** 정렬 줄 왼쪽 끝 X(홈 기준). */
const ROW_LEFT_X = -9
/** 어웨이 줄의 X 오프셋 — 홈 선수 뒤에 정확히 겹치지 않고 사이로 보이게 한다. */
const AWAY_ROW_OFFSET_X = -0.9

/** 심판 — 열의 선두이자 두 줄 사이 끝자리에 선다. */
const REF_COL: Pt = { x: COL_HEAD_X - 1.8, z: (HOME_COL_Z + AWAY_COL_Z) / 2 }
const REF_LINE: Pt = { x: ROW_LEFT_X - 2.8, z: (HOME_ROW_Z + AWAY_ROW_Z) / 2 }
/** 심판의 킥오프 위치 — 센터서클 옆(공에 겹치지 않는다). */
const REF_KICKOFF: Pt = { x: -4, z: 6 }

/** 심판 포즈의 id. 실제 선수가 아니므로 리그 배선은 호출부가 결정한다. */
export const REFEREE_ID = 'referee'
/** 심판 포즈의 등번호(플레이스홀더 — 킷·번호 표시는 호출부가 정한다). */
export const REFEREE_NUMBER = 0

/** 소개 중인 선수가 한 걸음 앞으로 나오는 거리(m, 카메라 쪽 = -Z). */
const INTRO_STEP_M = 1.1

/** 공 높이(m) = 공 반지름. movement.BALL_RADIUS와 같은 값(중복 import를 피한 상수). */
const BALL_Y = 0.11

/** 정렬·소개 단계에서 바라보는 방향 — 메인스탠드(-Z) 정면. */
const FACE_CAMERA = -Math.PI / 2
/** 이 속도(m/s) 미만이면 진행 방향 대신 단계별 기본 방향을 본다. */
const YAW_MIN_SPEED = 0.35
/** 이 속도(m/s) 이상이면 run 자세로 넘어간다(movement.ts의 IDLE_SPEED와 같은 값). */
const IDLE_SPEED = 0.4
/** 보폭 위상 적분 간격(ms). 경로가 구간별로 매끄러워 이 정도면 충분하다. */
const GAIT_STEP_MS = 50
/** 속도 추정용 중앙차분 반폭(ms). */
const VEL_H_MS = 20

interface Pt {
  x: number
  z: number
}

// ── 캐스팅 ──────────────────────────────────────────────────────────────────

export interface EntranceCastMember {
  id: string
  number: number
  nameKo: string
  position: Position
  /** 포메이션 슬롯 인덱스(0 = GK). 킥오프 좌표를 뽑는 키다. */
  slotIndex: number
}

export interface EntranceCast {
  /** 홈 XI — 포메이션 슬롯 순서(GK → 수비 → 미드 → 공격). */
  home: EntranceCastMember[]
  /** 어웨이 XI — 같은 순서. */
  away: EntranceCastMember[]
  homeFormation: FormationId
  awayFormation: FormationId
  homeTeamKo: string
  awayTeamKo: string
  /** 흩어질 목표 좌표(tacticalCoords)를 라이브 무브먼트와 같은 값으로 만들기 위한 지시. */
  homeInstructions: Instructions
  awayInstructions: Instructions
}

const POSITION_KO: Record<Position, string> = {
  GK: '골키퍼',
  CB: '센터백',
  LB: '레프트백',
  RB: '라이트백',
  DM: '수비형 미드필더',
  CM: '중앙 미드필더',
  AM: '공격형 미드필더',
  LW: '레프트윙',
  RW: '라이트윙',
  ST: '스트라이커',
}

/** 포지션 코드 → 한국어 라벨(소개 카드용). */
export function positionLabelKo(position: Position): string {
  return POSITION_KO[position] ?? position
}

function castSide(st: SideState): EntranceCastMember[] {
  const byId = new Map(st.team.squad.map(p => [p.id, p]))
  // lineup은 이미 XI_SLOTS 순서로 정렬돼 있다(engine/formations). 그 순서가 곧 소개 순서다.
  return st.tactics.lineup.slice(0, 11).map((slot, slotIndex) => {
    const p = byId.get(slot.playerId)
    return {
      id: slot.playerId,
      number: p?.number ?? 0,
      // 스쿼드에서 못 찾는 id(데이터 사고)라도 연출이 죽지 않게 슬롯 이름으로 버틴다.
      nameKo: p?.name.ko ?? slot.slot,
      position: p?.position ?? slot.slot,
      slotIndex,
    }
  })
}

/**
 * 엔진 상태에서 입장 연출에 필요한 것만 뽑아낸다(결정론·읽기 전용).
 * 이후 모든 순수 함수는 MatchState가 아니라 이 캐스트만 본다 — 연출이 엔진 변화에
 * 흔들리지 않고, 테스트도 가벼운 리터럴로 돌릴 수 있다.
 */
export function buildEntranceCast(state: MatchState): EntranceCast {
  return {
    home: castSide(state.home),
    away: castSide(state.away),
    homeFormation: state.home.tactics.formation,
    awayFormation: state.away.tactics.formation,
    homeTeamKo: state.home.team.name.ko,
    awayTeamKo: state.away.team.name.ko,
    homeInstructions: state.home.tactics.instructions,
    awayInstructions: state.away.tactics.instructions,
  }
}

// ── 타임라인 조회 ───────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * smoothstep(0~1 밖은 클램프). **이징 선택은 곧 최고 속도 선택이다** —
 * 이 곡선의 최대 기울기는 1.5(평균의 1.5배)인 반면 easeInOutCubic은 3배라,
 * 같은 거리·같은 시간에도 후자를 쓰면 워크아웃이 전력질주가 되고 흩어질 때
 * 한 프레임 이동이 한 스트라이드를 넘어 다리 애니메이션이 깨진다.
 */
function smoothstep(u: number): number {
  const x = clamp(u, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 해당 시각의 단계. */
export function entrancePhaseAt(ms: number): EntrancePhase {
  return entrancePhaseWindow(ms).phase
}

/** 해당 시각의 단계 + 구간 + 진행도. */
export function entrancePhaseWindow(ms: number): EntrancePhaseWindow {
  const t = ms < 0 ? 0 : ms
  for (const span of ENTRANCE_PHASES) {
    if (t < span.end) {
      const len = span.end - span.start
      return { phase: span.phase, start: span.start, end: span.end, u: len > 0 ? (t - span.start) / len : 1 }
    }
  }
  return { phase: 'done', start: ENTRANCE_TOTAL_MS, end: Infinity, u: 1 }
}

/**
 * 단계별 카메라 모드. **연출이 자기 카메라 스크립트를 소유한다** — 예전엔 Match3D의
 * rAF 루프 안에 삼항 연산자로 박혀 있어서, 무대 배치를 고쳐도 프레이밍이 맞는지
 * 검증할 방법이 없었다(실제로 터널 단계가 아무도 안 비추는 채로 배포됐다).
 * 순수 함수로 빼 두면 `__tests__/entrance-framing.test.ts`가 실제 렌더와 **같은**
 * 모드로 월드→스크린 투영을 돌려 배역이 프레임 안에 있는지 전수 검사할 수 있다.
 *
 * 흩어짐만 경기 카메라(broadcast)를 미리 켠다 — 킥오프 휘슬과 동시에 카메라가 또
 * 움직이면 컷이 두 번 난 것처럼 보인다.
 */
export function entranceCameraMode(ms: number): CameraMode {
  const ph = entrancePhaseAt(ms)
  if (ph === 'lineup' || ph === 'intro') return 'entrance-close'
  if (ph === 'disperse' || ph === 'done') return 'broadcast'
  return 'entrance'
}

export interface EntranceIntroCard {
  player: EntranceCastMember
  /** 소개 순번(0 = GK). */
  index: number
  total: number
  /** 카드 진행도 0~1(등장 → 유지 → 퇴장 애니메이션용). */
  u: number
}

/**
 * 지금 호명 중인 홈 선수와 카드 진행도. intro 단계 밖이면 null.
 * 오버레이(DOM)와 3D 프레임이 **같은 함수**를 보므로 카드와 한 걸음 앞으로 나오는
 * 선수가 절대 어긋나지 않는다.
 */
export function introCardAt(cast: EntranceCast, ms: number): EntranceIntroCard | null {
  const total = cast.home.length
  if (total <= 0) return null
  if (ms < LINEUP_END || ms >= INTRO_END) return null
  const per = ENTRANCE_INTRO_MS / total
  const raw = (ms - LINEUP_END) / per
  const index = clamp(Math.floor(raw), 0, total - 1)
  return { player: cast.home[index], index, total, u: clamp(raw - index, 0, 1) }
}

/** 단계별 자막(한국어). 오버레이와 3D 자막이 같은 문구를 쓰도록 여기서 만든다. */
export function entranceSubtitle(cast: EntranceCast, ms: number): string {
  switch (entrancePhaseAt(ms)) {
    case 'tunnel':
      return '심판진 입장'
    case 'walkout':
      return '양 팀 선수 입장'
    case 'lineup':
      // 포메이션을 여기 넣지 않는다 — 오버레이 바가 이미 `ent__formation` 칩으로
      // 상시 표시하므로 문장에 또 넣으면 "대한민국 · 4-2-3-1  4-2-3-1"이 된다.
      return `${cast.homeTeamKo} 선발`
    case 'intro':
      return `${cast.homeTeamKo} 선발 라인업`
    case 'disperse':
      return '킥오프 준비'
    default:
      return '킥오프'
  }
}

// ── 트랙(사람별 경로) ───────────────────────────────────────────────────────

interface Track {
  id: string
  side: 'home' | 'away'
  number: number
  /** 홈 소개 순번(0~10). 소개 대상이 아니면 -1. */
  introIndex: number
  /** 터널 안쪽 시작점. */
  s: Pt
  /** 터널을 빠져나와 열이 완성된 지점. */
  c: Pt
  /** 하프라인 쪽 정렬 지점. */
  l: Pt
  /** 킥오프 포지션. */
  k: Pt
  /** 행진 기본 방향(속도가 0에 가까울 때의 폴백). */
  faceWalk: number
  /** 흩어진 뒤 바라보는 방향(홈 +X 공격, 어웨이 -X 공격). */
  faceEnd: number
}

/** FNV-1a — 표시 레이어의 Math.random 대체(movement.ts와 같은 해시). */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 선수별 초기 보폭 위상 — 22명이 한 몸처럼 걷지 않게 분산시킨다. */
const seedPhase = (id: string) => (hash(`entrance:${id}`) % 100000) / 100000

function kickoffPoint(
  formation: FormationId,
  slotIndex: number,
  side: 'home' | 'away',
  ins: Instructions,
): Pt {
  // 흩어진 뒤 서는 자리는 **라이브 무브먼트가 쓰는 좌표와 같아야 한다**(movement.ts도
  // tacticalCoords를 쓴다). 포메이션 원형(slotCoords)에 세우면 입장이 끝나는 순간
  // 라인 높이만큼 수비진이 통째로 미끄러진다.
  const c = tacticalCoords(formation, clamp(slotIndex, 0, 10), side, ins)
  return toWorld(c.x, c.y)
}

function makeTrack(
  id: string,
  side: 'home' | 'away',
  number: number,
  introIndex: number,
  c: Pt,
  l: Pt,
  k: Pt,
  faceEnd: number,
): Track {
  const s = { x: c.x + COL_BACK, z: c.z }
  return { id, side, number, introIndex, s, c, l, k, faceWalk: Math.atan2(c.z - s.z, c.x - s.x), faceEnd }
}

function buildTracks(cast: EntranceCast): Track[] {
  const out: Track[] = [
    // 심판이 열의 선두다 — 실제 입장도 주심·부심이 먼저 나온다.
    makeTrack(
      REFEREE_ID,
      'home',
      REFEREE_NUMBER,
      -1,
      REF_COL,
      REF_LINE,
      REF_KICKOFF,
      // 심판은 마지막에 센터서클을 향해 선다.
      Math.atan2(-REF_KICKOFF.z, -REF_KICKOFF.x),
    ),
  ]
  cast.home.forEach((m, i) => {
    out.push(
      makeTrack(
        m.id,
        'home',
        m.number,
        i,
        { x: COL_HEAD_X + COL_GAP * i, z: HOME_COL_Z },
        { x: ROW_LEFT_X + ROW_GAP * i, z: HOME_ROW_Z },
        kickoffPoint(cast.homeFormation, m.slotIndex, 'home', cast.homeInstructions),
        0,
      ),
    )
  })
  cast.away.forEach((m, i) => {
    out.push(
      makeTrack(
        m.id,
        'away',
        m.number,
        -1,
        { x: COL_HEAD_X + COL_GAP * i, z: AWAY_COL_Z },
        { x: ROW_LEFT_X + AWAY_ROW_OFFSET_X + ROW_GAP * i, z: AWAY_ROW_Z },
        kickoffPoint(cast.awayFormation, m.slotIndex, 'away', cast.awayInstructions),
        Math.PI,
      ),
    )
  })
  return out
}

// 트랙은 캐스트가 같으면 항상 같다 — 매 프레임 재생성을 피한다(연출은 60fps로 돈다).
const trackCache = new WeakMap<EntranceCast, Track[]>()

function tracksFor(cast: EntranceCast): Track[] {
  const hit = trackCache.get(cast)
  if (hit) return hit
  const made = buildTracks(cast)
  trackCache.set(cast, made)
  return made
}

/** 소개 중인 선수가 한 걸음 앞으로(-Z) 나왔다 돌아오는 오프셋(m). */
function introStep(track: Track, ms: number, total: number): number {
  if (track.introIndex < 0 || total <= 0) return 0
  if (ms < LINEUP_END || ms >= INTRO_END) return 0
  const per = ENTRANCE_INTRO_MS / total
  const raw = (ms - LINEUP_END) / per
  const index = clamp(Math.floor(raw), 0, total - 1)
  if (index !== track.introIndex) return 0
  // sin(πu)는 u=0·1에서 정확히 0이라 앞뒤 선수와 이어 붙어도 위치가 튀지 않는다.
  return INTRO_STEP_M * Math.sin(Math.PI * clamp(raw - index, 0, 1))
}

/**
 * 사람 한 명의 시각 ms 위치. 구간마다 smoothstep이라 각 경계에서 속도가 0이 된다 —
 * 터널 입구에서 한 번 멈췄다 신호를 받고 나오는 실제 의식과 같은 리듬이고,
 * 동시에 속도 불연속(발이 튀는 원인)도 없앤다.
 */
function posAt(track: Track, ms: number, total: number): Pt {
  const t = clamp(ms, 0, ENTRANCE_TOTAL_MS)
  let base: Pt
  if (t < TUNNEL_END) {
    const u = smoothstep(t / ENTRANCE_TUNNEL_MS)
    base = { x: track.s.x + (track.c.x - track.s.x) * u, z: track.s.z + (track.c.z - track.s.z) * u }
  } else if (t < WALKOUT_END) {
    const u = smoothstep((t - TUNNEL_END) / ENTRANCE_WALKOUT_MS)
    base = { x: track.c.x + (track.l.x - track.c.x) * u, z: track.c.z + (track.l.z - track.c.z) * u }
  } else if (t < INTRO_END) {
    base = { x: track.l.x, z: track.l.z - introStep(track, t, total) }
  } else {
    const u = smoothstep((t - INTRO_END) / ENTRANCE_DISPERSE_MS)
    base = { x: track.l.x + (track.k.x - track.l.x) * u, z: track.l.z + (track.k.z - track.l.z) * u }
  }
  return base
}

/**
 * 보폭 위상 — **이동거리 / 공유 보폭 모델**을 0부터 적분한다. 상태를 들고 다니지 않는
 * 순수 함수라 어느 시각으로 건너뛰어도 같은 값이 나오고(스킵·되감기 안전),
 * 렌더러가 소비하는 위상이 실제 이동거리와 정확히 정합해 발이 미끄러지지 않는다.
 */
function gaitPhaseAt(track: Track, ms: number, total: number): number {
  const end = clamp(ms, 0, ENTRANCE_TOTAL_MS)
  let phase = seedPhase(track.id)
  let prev = posAt(track, 0, total)
  let t = 0
  while (t < end) {
    const next = Math.min(t + GAIT_STEP_MS, end)
    const dt = (next - t) / 1000
    const p = posAt(track, next, total)
    const v = dt > 0 ? Math.hypot(p.x - prev.x, p.z - prev.z) / dt : 0
    // movement.computeFrame과 같은 식: 속도는 최소 보행 속도로 바닥을 깔고,
    // 보폭은 실제 속도로 정한다(정지에 가까워도 다리가 완전히 멈추지 않는다).
    phase += (Math.max(v, MIN_GAIT_SPEED) * dt) / strideLength(v)
    prev = p
    t = next
  }
  return phase
}

/** 최단 각도 보간(라디안). */
function shortLerpAngle(from: number, to: number, u: number): number {
  const TAU = Math.PI * 2
  let d = (to - from) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return from + d * clamp(u, 0, 1)
}

function poseFor(track: Track, ms: number, total: number): PlayerPose {
  const t = clamp(ms, 0, ENTRANCE_TOTAL_MS)
  const here = posAt(track, t, total)
  // 속도·진행 방향은 중앙차분으로 뽑는다 — 위치 함수 하나만 정본이면 되고,
  // 속도가 위치와 어긋날 수 없다.
  const a = posAt(track, t - VEL_H_MS, total)
  const b = posAt(track, t + VEL_H_MS, total)
  const dx = b.x - a.x
  const dz = b.z - a.z
  const speed = Math.hypot(dx, dz) / ((2 * VEL_H_MS) / 1000)
  const moveYaw = speed > YAW_MIN_SPEED ? Math.atan2(dz, dx) : track.faceWalk

  const w = entrancePhaseWindow(t)
  let yaw: number
  if (w.phase === 'tunnel') {
    yaw = moveYaw
  } else if (w.phase === 'walkout') {
    // 도착 직전에 몸을 돌려 메인스탠드를 본다(멈춘 뒤 홱 도는 것 방지).
    yaw = shortLerpAngle(moveYaw, FACE_CAMERA, smoothstep((w.u - 0.6) / 0.4))
  } else if (w.phase === 'disperse') {
    yaw = shortLerpAngle(moveYaw, track.faceEnd, smoothstep(w.u))
  } else if (w.phase === 'done') {
    yaw = track.faceEnd
  } else {
    yaw = FACE_CAMERA
  }

  const gaitPhase = ((gaitPhaseAt(track, t, total) % 1) + 1) % 1
  const running = speed >= IDLE_SPEED
  return {
    id: track.id,
    side: track.side,
    number: track.number,
    x: here.x,
    z: here.z,
    yaw,
    speed,
    action: running ? 'run' : 'idle',
    // run의 actionT는 곧 보폭 위상이다(movement.ts와 같은 계약).
    actionT: running ? gaitPhase : 0,
    gaitPhase,
  }
}

// ── 프레임 ──────────────────────────────────────────────────────────────────

/**
 * FrameState + 심판. 심판은 실제 선수가 아니므로 `players`에 섞지 않는다 —
 * 호출부가 별도 리그·킷으로 그리고, side·number는 배선 시 덮어쓸 수 있다.
 */
export interface EntranceFrame extends FrameState {
  referee: PlayerPose
}

/**
 * 카메라가 볼 지점 = **이 순간 배역의 무게중심**(소개 단계만 호명 선수 쪽으로 당긴다).
 *
 * 예전에는 단계마다 무대 좌표(터널 입구·줄 중앙)를 손으로 적어 두고 그 사이를 보간했다.
 * 그 값들은 무대 배치 상수와 따로 자라서 실제 배역 위치와 어긋났다 — 특히 터널 단계의
 * `mouth`는 심판 한 명의 좌표(x=-3.8)였는데 열의 실제 중심은 x≈+6이라, 열 꼬리 10 m가
 * 프레임 밖으로 나갔다. 실제 포즈에서 평균을 내면 무대 배치를 어떻게 바꿔도 카메라가
 * 따라오고, 흩어짐 끝에서는 킥오프 대형의 중심(≈ 원점)으로 저절로 수렴한다.
 */
function focusAt(cast: EntranceCast, tracks: Track[], poses: PlayerPose[], ms: number): Pt {
  let sx = 0
  let sz = 0
  for (const p of poses) {
    sx += p.x
    sz += p.z
  }
  const n = poses.length || 1
  const c: Pt = { x: sx / n, z: sz / n }
  const total = cast.home.length
  if (total <= 0 || ms < LINEUP_START || ms >= INTRO_END) return c

  // ── 정렬·소개: 호명 선수 쪽으로 당긴 팬 ──────────────────────────
  // 카드와 카메라가 같은 사람을 봐야 한다. 다만 **완전히 연속**이어야 한다:
  //  · 목표 x를 카드 인덱스에서 계단식으로 읽으면 0.5 s마다 카메라가 1 m씩 튄다
  //    (실측 0.99 m/20 ms = 49 m/s). 그래서 슬롯 사이를 smoothstep으로 잇고
  //    반 슬롯 앞서(lead) 움직이기 시작해, 카드가 뜨는 순간 이미 절반쯤 가 있게 한다.
  //  · 팬은 **정렬(lineup) 단계에서 미리 시작한다**. 소개 첫 슬롯에서 게인을 0부터
  //    올리면 1번 선수(줄 맨 왼쪽 x=-9)가 호명되는 동안 카메라가 아직 줄 한가운데라
  //    정작 카드의 주인공이 프레임 밖으로 나간다. 0.9 s의 "정적" 구간을 카메라가
  //    자리를 잡는 데 쓰면 연속성과 프레이밍을 동시에 얻는다.
  //  · 끝에서는 게인을 닫지 않는다 — 흩어짐에서 모드가 broadcast로 바뀌므로
  //    카메라 리그의 0.6 s 이징이 그 전환을 대신 흡수한다.
  const per = ENTRANCE_INTRO_MS / total
  const raw = (ms - LINEUP_END) / per
  const xAt = (i: number): number => {
    const tr = tracks.find(x => x.introIndex === clamp(i, 0, total - 1))
    return tr ? tr.l.x : c.x
  }
  const lead = clamp(raw - 0.5, 0, total - 1)
  const i0 = Math.floor(lead)
  const tx = xAt(i0) + (xAt(i0 + 1) - xAt(i0)) * smoothstep(lead - i0)
  // 완전히 그 선수에 꽂지 않고 0.55만 당긴다 — 양옆 동료가 프레임에 남아야 "줄"로
  // 읽힌다. 0.7이면 종횡비 1.544에서 프레임 내 인원이 11명까지 떨어지고, 0.45면
  // 호명 선수가 화면 중앙에서 너무 멀어져 카드와 눈이 따로 논다(둘 다 실측).
  const ramp = ENTRANCE_LINEUP_MS / per
  const gain = 0.55 * smoothstep((raw + ramp) / ramp)
  return { x: c.x + (tx - c.x) * gain, z: c.z }
}

/**
 * 입장 연출 한 프레임(순수 함수). 같은 (cast, ms)면 항상 같은 값을 돌려준다.
 *
 * @param cast {@link buildEntranceCast} 결과
 * @param ms   연출 시작으로부터 경과 ms(0 미만·총 길이 초과는 클램프)
 */
export function entranceFrame(cast: EntranceCast, ms: number): EntranceFrame {
  const tracks = tracksFor(cast)
  const t = clamp(ms, 0, ENTRANCE_TOTAL_MS)
  const total = cast.home.length
  const players: PlayerPose[] = []
  const all: PlayerPose[] = []
  let referee: PlayerPose | null = null
  for (const tr of tracks) {
    const pose = poseFor(tr, t, total)
    all.push(pose)
    if (tr.id === REFEREE_ID) referee = pose
    else players.push(pose)
  }
  const ball: BallPose = { x: 0, y: BALL_Y, z: 0, spin: 0 }
  return {
    players,
    ball,
    // 무게중심은 심판까지 포함한 **배역 전원**에서 낸다(심판도 화면에 있어야 한다).
    focus: focusAt(cast, tracks, all, t),
    // 심판 트랙은 항상 존재하므로 non-null이지만, 타입 안전을 위해 폴백을 둔다.
    referee: referee ?? poseFor(tracks[0], t, total),
    event: null,
  }
}
