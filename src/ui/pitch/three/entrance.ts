// src/ui/pitch/three/entrance.ts
// 경기 시작 입장 연출 — 순수 로직. 사용자 스토리보드 4컷의 정본이다.
//
//   컷1 입장     양 팀 배너를 피치에 펼치고, 심판 3인이 중앙, 두 팀이 터널(하단)에서 올라온다
//   컷2 좌우 분리 심판은 중앙에 남고 양 팀이 각자 배너 쪽으로 갈라진다
//   컷3 우리 팀   포메이션 도해 + 선수 명단을 나란히, 선수 한 명씩 하이라이트하며 캐스터가 소개
//   컷4 상대 팀   같은 구성
//
// 설계 원칙(Phase 4E Global Constraints를 그대로 따른다):
//  - **three 무의존**: 타입조차 three를 import하지 않는다. 이 모듈은 엔트리 번들에
//    정적으로 실려도 되는 순수 TS다(three가 새면 3D 코드 스플릿이 통째로 깨진다).
//  - **Math.random·Date 금지**: 시간은 호출부가 주는 ms 인자로만 흐르고, 개인차는
//    선수 id의 FNV-1a 해시로만 만든다. 같은 (script, ms) → 완전히 같은 프레임.
//  - **표시 전용**: 엔진 상태를 읽기만 하고 절대 쓰지 않는다.
//
// ★ 타임라인이 **캐스트에 의존**하게 바뀌었다(예전엔 모듈 상수 13.8초). 22명을 이름으로
//   부르는 시간은 이름의 음절 수에 달렸고, 발화 길이를 추정해 비트 간격을 잡아야만
//   "이름이 불릴 때 그 선수가 하이라이트된다"가 성립한다. 그래서 길이의 정본은
//   {@link entranceScript}가 만드는 **스크립트 객체**이고, 모든 조회 함수는 그것을 받는다.
//
// 좌표계는 ./types.ts가 정본이다(피치 105×68m, 원점 센터서클, XZ 평면).
// 방송 카메라는 -Z 쪽 사이드라인에 있으므로(camera.ts BROADCAST_Z) **-Z가 "카메라·
// 메인스탠드 쪽"**이고, 화면 오른쪽은 **-X**다(three lookAt 규약: right = cross(fwd, up)).
// 스토리보드가 "우리 팀은 오른쪽"이라 했으므로 홈은 -X 쪽에 선다 — 마침 홈이 자기
// 진영(-X)을 등지고 서는 그림이라 실제 의식과도 맞는다.
import type { FormationId, Instructions, MatchState, Position, SideState } from '../../../engine/types'
import {
  lineupIntroBeats,
  type LineupBeat,
  type LineupMember,
  type Speaker,
} from '../../../game/commentary'
import { SPEECH_TAIL_MS, estimateSpeechMs, type SpeechRole } from '../../../audio/commentary-tts'
import { tacticalCoords } from '../shape'
import type { CameraMode } from './camera'
// 보폭 모델은 표시 계층 전체가 **하나**를 공유한다(player3d가 정본).
// 공유 보폭 모델은 순수 계층(pose.ts)에서 온다 — 리그 빌더(player3d)를 거치지 않는다.
import { MIN_GAIT_SPEED, strideLength } from './pose'
import { FIRST_HALF_ENDS, toWorld, type BallPose, type FrameState, type PlayerPose } from './types'

// ── 고정 단계 길이 ──────────────────────────────────────────────────────────
// 소개(intro) 두 컷만 캐스트에 따라 길이가 변하고, 나머지는 고정이다.
//  - tunnel 1.6s: "무언가 시작된다"를 알리는 정지→기동 구간. 이보다 짧으면 인지 전에 끝난다.
//  - walkout 4.6s: 두 줄이 대열을 유지한 채 터널에서 올라오는 핵심 그림(컷1).
//    최장 이동이 14 m라 4.6 s면 평균 3.0 m/s·최고 4.6 m/s — 빠른 걸음의 상단이다.
//    3.8 s로 줄이면 최고 5.5 m/s가 되어 "걸어 나온다"가 아니라 "뛰어나온다"가 된다.
//  - split 4.6s: 두 팀이 각자 배너 쪽으로 갈라지는 컷2. 최장 14 m를 걸어야 하므로
//    walkout과 같은 예산을 준다(평균 5 m/s를 넘으면 안 된다 — 테스트가 못 박는다).
//  - disperse 2.2s: 킥오프 포지션으로 흩어지는 전환. 최장 이동(GK → 자기 골문 ≈ 60m)이
//    실제라면 10초는 걸리는 거리라 여기는 명백한 "배속 전환"이다. smoothstep으로
//    감속 착지시켜 순간이동으로 보이지 않게 하고, 2.0s 아래로 줄이면 한 프레임 보폭이
//    한 스트라이드를 넘어(위상 언랩 불가) 다리 애니메이션이 깨진다.
export const ENTRANCE_TUNNEL_MS = 1600
export const ENTRANCE_WALKOUT_MS = 4600
export const ENTRANCE_SPLIT_MS = 4600
export const ENTRANCE_DISPERSE_MS = 2200

/**
 * 소개 발화에 쓰는 재생 속도 배율. **MatchScreen이 speak에 넘기는 값과 반드시 같아야
 * 한다** — 다른 rate로 추정하면 비트 간격과 실제 발화가 어긋나 하이라이트가 밀린다.
 * 1.25는 명단 낭독의 실제 템포(뉴스 앵커 상단)에 가까우면서 이름이 뭉개지지 않는 상한이다.
 */
export const ENTRANCE_SPEECH_SPEED = 1.25

/**
 * 비트 하나의 고정 여유(ms). {@link SPEECH_TAIL_MS}(650)는 **분 단위 체류**를 위한
 * 값이라 문말 여운 + 다음 분 전환 마진까지 들어 있다. 명단 낭독은 문장이 쉼표로
 * 이어지므로 그만큼 쉴 이유가 없다. 다만 0으로 두면 큐가 밀려 하이라이트가 소리보다
 * 앞서므로(발화는 취소하지 않고 큐에 쌓는다) 문두 묵음 몫은 남긴다.
 */
const BEAT_TAIL_MS = 420
/** 문장이 끝나는 비트(마침표로 끝남) 뒤의 숨. 그룹 경계가 귀에 들리게 한다. */
const BEAT_STOP_GAP_MS = 220
/** 비트 최소 길이(ms) — 아주 짧은 이름도 눈이 하이라이트를 따라올 시간은 있어야 한다. */
const BEAT_MIN_MS = 560

/**
 * 연출 길이 모드.
 *  - `full`  스토리보드 4컷 전부(선수 소개 포함).
 *  - `short` 컷1·컷2 + 킥오프. 캠페인 8경기를 매번 1분씩 붙잡지 않기 위한 기본값이다.
 */
export type EntranceMode = 'full' | 'short'

export type EntrancePhase =
  | 'tunnel'
  | 'walkout'
  | 'split'
  | 'home-intro'
  | 'away-intro'
  | 'disperse'
  | 'done'

export interface EntrancePhaseSpan {
  phase: EntrancePhase
  start: number
  end: number
}

export interface EntrancePhaseWindow extends EntrancePhaseSpan {
  /** 단계 내 진행도 0~1(‘done’은 1). */
  u: number
}

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

/** 컷1 집결: 홈 줄의 Z(카메라에 가깝다).
 *  ★ 센터서클(-0)까지 나오지 않는다. 터널(z=-35)에서 거기까지는 35 m라 어떤 예산을 줘도
 *  걷기 속도가 안 나온다(실측 10.1 m/s). 스토리보드 컷1도 두 팀이 **하단**에 있고
 *  심판이 그보다 위에 있는 그림이다. */
const CLUSTER_HOME_Z = -26
/** 컷1 집결: 어웨이 줄의 Z(홈 줄 뒤). */
const CLUSTER_AWAY_Z = -22.5
/** 컷1 집결 줄의 사람 간 간격(m). */
const CLUSTER_GAP = 1.5
/** 컷1 집결 줄의 왼쪽 끝 X. 11명 × 1.5 m = 15 m가 센터서클 앞에 걸쳐 선다. */
const CLUSTER_LEFT_X = -7.5
/** 어웨이 줄의 X 오프셋 — 홈 선수 뒤에 정확히 겹치지 않고 사이로 보이게 한다. */
const CLUSTER_AWAY_OFFSET_X = -0.75

/** 컷2 분리: 두 줄의 Z(같은 높이에 나란히 선다). */
const LINE_Z = -19
/** 컷2 분리 줄의 사람 간 간격(m). */
const LINE_GAP = 1.35
/** 홈 줄의 중심 X — **화면 오른쪽**(-X). 스토리보드의 "우리 팀 = 오른쪽". */
const HOME_LINE_CX = -12
/** 어웨이 줄의 중심 X — 화면 왼쪽(+X). */
const AWAY_LINE_CX = 12

/**
 * 피치에 펼치는 **국기 배너**(스토리보드 컷1의 "태극기 / 상대편 국기").
 *
 * ★ 2026-08-01 정정 — 여기에는 *"실제 국기 이미지를 쓰지 않는다"* 는 주석과 팀 색 tifo
 *   도안이 있었다. **오독이었다.** 설계 스펙 §9.1이 금지한 것은 협회 엠블럼·대표팀
 *   크레스트·FIFA/월드컵 공식 로고이고, 같은 문장이 팀 식별 수단으로 **지정한** 것이
 *   국기(퍼블릭 도메인) + 국가명 텍스트다
 *   (docs/superpowers/specs/2026-07-23-worldcup-manager-sim-design.md:182).
 *   사용자 스토리보드에도 "태극기"라고 적혀 있었다. 자산은 `public/flags/*.svg`,
 *   출처·라이선스는 docs/assets-licenses.md §국기가 정본이다.
 *
 * 크기는 **4:3**이다(16×12 m). 국기 도안은 비율을 바꾸면 안 되고 자산이 전부 4:3
 * (viewBox 640×480)이라, 배너 면과 텍스처 비율을 맞춰 늘어남을 원천 차단한다.
 * 예전 20×12(5:3)에서 폭만 줄인 것이라 좌우 여백은 그대로 남는다.
 *
 * 좌표는 두 팀의 줄보다 **피치 안쪽(+Z)** 이다 — 카메라가 -Z에 있으므로 화면에서
 * 배너가 선수들 위(뒤)에 깔린다. 스토리보드 컷1의 배치 그대로다.
 */
export interface EntranceBanner {
  /** 중심 X(m). */
  x: number
  /** 중심 Z(m). */
  z: number
  /** 가로(X) 길이(m). */
  w: number
  /** 세로(Z) 길이(m). */
  h: number
}
export const ENTRANCE_BANNER_HOME: EntranceBanner = { x: -20, z: 6, w: 16, h: 12 }
export const ENTRANCE_BANNER_AWAY: EntranceBanner = { x: 20, z: 6, w: 16, h: 12 }

/** 심판 3인 — 주심 + 부심 2인. 스토리보드 컷1의 "심판 심판 심판". */
export const REFEREE_IDS = ['referee', 'referee-ar1', 'referee-ar2'] as const
/** 주심 id(하위호환 — 예전 단일 심판 계약). */
export const REFEREE_ID = REFEREE_IDS[0]
/** 심판 포즈의 등번호(플레이스홀더 — 킷·번호 표시는 호출부가 정한다). */
export const REFEREE_NUMBER = 0

/** 심판 3인의 터널 열 위치(열의 선두). */
const REF_COL: readonly Pt[] = [
  { x: COL_HEAD_X - 2.0, z: -33.4 },
  { x: COL_HEAD_X - 3.7, z: -34.6 },
  { x: COL_HEAD_X - 0.3, z: -34.6 },
]
/** 심판 3인의 중앙 위치 — 컷1에서 자리 잡고 컷2·3·4 내내 여기 남는다. */
const REF_CENTER: readonly Pt[] = [
  { x: 0, z: -16.2 },
  { x: -2.6, z: -17.4 },
  { x: 2.6, z: -17.4 },
]
/** 심판 3인의 킥오프 위치 — 주심은 센터서클 옆, 부심은 각자 터치라인. */
const REF_KICKOFF: readonly Pt[] = [
  { x: -4, z: 6 },
  { x: -17, z: -32.5 },
  { x: 17, z: 32.5 },
]

/** 흩어진 뒤 홈이 바라보는 방향(rad). 표시 진영 회전을 포함한다 — {@link kickoffPoint} 참조. */
const FACE_END_HOME = FIRST_HALF_ENDS === 1 ? 0 : Math.PI
/** 어웨이는 그 반대. */
const FACE_END_AWAY = FIRST_HALF_ENDS === 1 ? Math.PI : 0

/**
 * 소개 클로즈업에서 호명 선수 쪽으로 카메라를 당기는 비율(0~1).
 * 1이면 그 선수만 화면 한가운데 두고 줄이 사라진다. 0.55가 "줄 안의 한 사람"이
 * 읽히면서도 양 끝(중심에서 ±6.75 m)이 세이프 에어리어 안에 남는 값이다(전수 검사).
 */
const PAN_GAIN = 0.55

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

// ── 스크립트(타임라인 + 중계 비트) ──────────────────────────────────────────

/**
 * 소개 비트 한 개. `speech`는 이 비트가 시작하는 **순간에 한 번** 발화되고,
 * `playerId`가 있으면 그 선수의 도트·명단 행·3D 포즈가 동시에 하이라이트된다.
 * 즉 소리와 그림의 동기는 스케줄 자체가 보장한다(이벤트 후킹이 아니다).
 */
export interface EntranceBeat {
  /** 연출 시작 기준 시작 ms. */
  start: number
  /** 연출 시작 기준 종료 ms. */
  end: number
  speaker: Speaker
  text: string
  speech: string
  /** 이 비트를 말하는 동안 하이라이트할 선수 id. 없으면 null. */
  playerId: string | null
  /** 소개 중인 팀. */
  side: 'home' | 'away'
  /** 그 팀 명단에서의 순번(하이라이트 대상이 아니면 -1). */
  index: number
}

export interface EntranceScript {
  cast: EntranceCast
  mode: EntranceMode
  phases: readonly EntrancePhaseSpan[]
  totalMs: number
  beats: readonly EntranceBeat[]
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 캐스트 멤버 → 중계 모듈이 아는 최소 정보. */
function toLineupMembers(members: readonly EntranceCastMember[]): LineupMember[] {
  return members.map(m => ({ id: m.id, number: m.number, nameKo: m.nameKo, position: m.position }))
}

/** 비트 하나가 화면에 머무는 시간(ms) — **발화 추정치가 정본**이다. */
function beatDurationMs(b: LineupBeat): number {
  const role: SpeechRole = b.speaker === 'analyst' ? 'analyst' : 'normal'
  // estimateSpeechMs는 분 단위 체류용 여유(SPEECH_TAIL_MS)를 포함하므로 걷어내고
  // 낭독용 여유(BEAT_TAIL_MS)로 갈아 끼운다.
  const spoken = estimateSpeechMs(b.speech, role, ENTRANCE_SPEECH_SPEED) - SPEECH_TAIL_MS
  const stop = b.speech.endsWith('.') ? BEAT_STOP_GAP_MS : 0
  return Math.max(BEAT_MIN_MS, spoken + BEAT_TAIL_MS) + stop
}

function buildBeats(
  cast: EntranceCast, side: 'home' | 'away', from: number,
): { beats: EntranceBeat[]; end: number } {
  const members = side === 'home' ? cast.home : cast.away
  const indexById = new Map(members.map((m, i) => [m.id, i]))
  const lines = lineupIntroBeats(
    side === 'home' ? cast.homeTeamKo : cast.awayTeamKo,
    side === 'home' ? cast.homeFormation : cast.awayFormation,
    toLineupMembers(members),
  )
  const beats: EntranceBeat[] = []
  let at = from
  for (const l of lines) {
    const dur = beatDurationMs(l)
    beats.push({
      start: at,
      end: at + dur,
      speaker: l.speaker,
      text: l.text,
      speech: l.speech,
      playerId: l.playerId,
      side,
      index: l.playerId ? indexById.get(l.playerId) ?? -1 : -1,
    })
    at += dur
  }
  return { beats, end: at }
}

// 스크립트는 (캐스트, 모드)가 같으면 항상 같다 — 매 프레임 재생성을 피한다(60fps).
const scriptCache = new WeakMap<EntranceCast, Map<EntranceMode, EntranceScript>>()

/**
 * 캐스트 + 모드 → 연출 스크립트(결정론·캐시). 길이·단계 구간·중계 비트의 **정본**이다.
 */
export function entranceScript(cast: EntranceCast, mode: EntranceMode = 'full'): EntranceScript {
  let byMode = scriptCache.get(cast)
  if (!byMode) {
    byMode = new Map()
    scriptCache.set(cast, byMode)
  }
  const hit = byMode.get(mode)
  if (hit) return hit

  const phases: EntrancePhaseSpan[] = []
  let at = 0
  const push = (phase: EntrancePhase, ms: number): void => {
    phases.push({ phase, start: at, end: at + ms })
    at += ms
  }
  push('tunnel', ENTRANCE_TUNNEL_MS)
  push('walkout', ENTRANCE_WALKOUT_MS)
  push('split', ENTRANCE_SPLIT_MS)

  let beats: EntranceBeat[] = []
  if (mode === 'full') {
    const h = buildBeats(cast, 'home', at)
    push('home-intro', h.end - at)
    const a = buildBeats(cast, 'away', at)
    push('away-intro', a.end - at)
    beats = [...h.beats, ...a.beats]
  } else {
    // short 모드에서도 단계는 존재한다(길이 0) — 조회 함수가 분기 없이 돈다.
    push('home-intro', 0)
    push('away-intro', 0)
  }
  push('disperse', ENTRANCE_DISPERSE_MS)

  const script: EntranceScript = { cast, mode, phases, totalMs: at, beats }
  byMode.set(mode, script)
  return script
}

/**
 * 소개(캐스터 낭독)가 **시작되는** 시각(ms). 소개가 없는 short 모드면 null.
 *
 * M06 팡파르를 **어디서 걷을지**의 정본이다 — 상수를 다시 쓰지 마라(MatchScreen이
 * `bgm.playSting('M06', { fadeOutAtMs })`에 그대로 넘긴다).
 *
 * ★ 2026-08-01 재판정 — 예전에는 이 자리에 `entranceIntroEndMs`(소개 **끝**)가 있었고,
 *   곡을 소개 위에 덕킹으로 깔아 두었다가 그 시각에 부풀렸다. 실제 플레이가 그 설계를
 *   기각했다(사용자: *"선수 입장 시에 BGM이 아예 안 나와… 선수 소개 거의 다 할 때 갑자기
 *   BGM이 나와"*). 끝 맞추기(alignEndAtMs = totalMs)가 full 모드에서 곡을 연출의 마지막
 *   1/5로 밀어냈기 때문이다 — 곡 13.8초, 연출 약 63초.
 *
 *   그래서 앵커를 **뒤에서 앞으로** 옮긴다: 음악은 입장(터널·워크아웃·정렬)과 **동시에**
 *   시작해 소개가 시작되는 이 시각에 완전히 사라진다. 소개 구간은 무음이다 — 인플레이에
 *   음악을 깔지 않는 것과 같은 이유로 **말이 주인**이고, 절충(덕킹)은 이미 실패했다.
 */
export function entranceIntroStartMs(script: EntranceScript): number | null {
  for (const span of script.phases) {
    // home-intro가 소개의 첫 컷이다. 길이 0이면 소개 자체가 없는 모드(short).
    if (span.phase === 'home-intro' && span.end > span.start) return span.start
  }
  return null
}

/**
 * 소개가 끝나는 시각(ms) = disperse 시작. 소개가 없는 short 모드면 null.
 * {@link entranceIntroStartMs}와 짝을 이루는 순수 조회다(구간의 반대쪽 끝).
 */
export function entranceIntroEndMs(script: EntranceScript): number | null {
  let end: number | null = null
  for (const span of script.phases) {
    if (span.phase !== 'home-intro' && span.phase !== 'away-intro') continue
    if (span.end > span.start) end = span.end
  }
  return end
}

// ── 모드 기억(캠페인 8경기 정책) ────────────────────────────────────────────
// ★ 2026-08-01 정책 변경 — 기본을 **전체 연출**로 되돌렸다(사용자 지시).
//   예전 근거는 "8경기 내내 1분을 붙잡으면 건너뛰기를 누르는 의식이 된다"였고, 그래서
//   본 적이 있으면 short를 기본으로 삼았다. 그런데 실제로 플레이한 사용자는 반대로 말했다:
//   *"선수 소개 보기를 눌러야만 해설이 나온다"* — 소개는 이 연출의 **본체**이고, 버튼 뒤에
//   숨겨 두면 대부분의 경기에서 영영 안 들린다. 길이의 대가는 모드가 아니라 **음악 처리**로
//   치른다(entranceIntroStartMs → bgm.playSting fadeOutAtMs). 건너뛰기는 그대로 남는다.
//   seen 플래그는 계속 기록한다 — 모드를 고르지는 않지만 "이 유저가 전체 컷을 본 적이
//   있는가"는 다른 연출 판단에 쓸 수 있는 사실이다.
const ENTRANCE_SEEN_KEY = 'rematch-entrance-seen'

/** 전체 연출을 이미 본 적이 있는가. 저장소 미지원·오류는 '아직'으로 본다. */
export function readEntranceSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(ENTRANCE_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

/** 전체 연출을 봤다고 기록한다(다음 경기부터 짧은 판이 기본). */
export function markEntranceSeen(): void {
  try {
    globalThis.localStorage?.setItem(ENTRANCE_SEEN_KEY, '1')
  } catch {
    /* no-op — 저장 실패는 다음 경기에도 전체 연출이 나올 뿐이다 */
  }
}

/** 이번 경기의 기본 모드 — 언제나 전체 연출. 근거는 위 ENTRANCE_SEEN_KEY 주석. */
export function defaultEntranceMode(): EntranceMode {
  return 'full'
}

// ── 타임라인 조회 ───────────────────────────────────────────────────────────

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
export function entrancePhaseAt(script: EntranceScript, ms: number): EntrancePhase {
  return entrancePhaseWindow(script, ms).phase
}

/** 해당 시각의 단계 + 구간 + 진행도. */
export function entrancePhaseWindow(script: EntranceScript, ms: number): EntrancePhaseWindow {
  const t = ms < 0 ? 0 : ms
  for (const span of script.phases) {
    // 길이 0인 단계(short 모드의 소개)는 절대 선택되지 않는다.
    if (span.end > span.start && t < span.end) {
      const len = span.end - span.start
      return { phase: span.phase, start: span.start, end: span.end, u: (t - span.start) / len }
    }
  }
  return { phase: 'done', start: script.totalMs, end: Infinity, u: 1 }
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
export function entranceCameraMode(script: EntranceScript, ms: number): CameraMode {
  const ph = entrancePhaseAt(script, ms)
  if (ph === 'home-intro' || ph === 'away-intro') return 'entrance-close'
  if (ph === 'disperse' || ph === 'done') return 'broadcast'
  return 'entrance'
}

/** 지금 말하고 있는 비트. 소개 단계 밖이면 null. */
export function entranceBeatAt(script: EntranceScript, ms: number): EntranceBeat | null {
  const beats = script.beats
  if (beats.length === 0) return null
  if (ms < beats[0].start || ms >= beats[beats.length - 1].end) return null
  // 비트는 시간순 · 빈틈 없음 → 이분 탐색.
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ms < beats[mid].end) hi = mid
    else lo = mid + 1
  }
  return beats[lo]
}

/** 비트의 배열 인덱스(발화 트리거가 "바뀌었는가"를 판정하는 키). 없으면 -1. */
export function entranceBeatIndexAt(script: EntranceScript, ms: number): number {
  const b = entranceBeatAt(script, ms)
  return b ? script.beats.indexOf(b) : -1
}

/** 지금 하이라이트할 선수. 이름을 부르는 비트에서만 값이 있다. */
export interface EntranceHighlight {
  player: EntranceCastMember
  side: 'home' | 'away'
  index: number
  total: number
  /** 비트 내 진행도 0~1. */
  u: number
}

/**
 * 지금 호명 중인 선수와 진행도. 오버레이(DOM)와 3D 프레임이 **같은 함수**를 보므로
 * 도해 도트 · 명단 행 · 한 걸음 앞으로 나오는 선수가 절대 어긋나지 않는다.
 */
export function entranceHighlightAt(script: EntranceScript, ms: number): EntranceHighlight | null {
  const b = entranceBeatAt(script, ms)
  if (!b || !b.playerId || b.index < 0) return null
  const members = b.side === 'home' ? script.cast.home : script.cast.away
  const player = members[b.index]
  if (!player) return null
  const len = b.end - b.start
  return {
    player,
    side: b.side,
    index: b.index,
    total: members.length,
    u: len > 0 ? clamp((ms - b.start) / len, 0, 1) : 1,
  }
}

/** 지금 소개 중인 팀(소개 단계가 아니면 null). */
export function entranceIntroSide(script: EntranceScript, ms: number): 'home' | 'away' | null {
  const ph = entrancePhaseAt(script, ms)
  if (ph === 'home-intro') return 'home'
  if (ph === 'away-intro') return 'away'
  return null
}

/** 단계별 자막(한국어). 오버레이와 3D 자막이 같은 문구를 쓰도록 여기서 만든다. */
export function entranceSubtitle(script: EntranceScript, ms: number): string {
  const cast = script.cast
  switch (entrancePhaseAt(script, ms)) {
    case 'tunnel':
      return '심판진 입장'
    case 'walkout':
      return '양 팀 선수 입장'
    case 'split':
      return '양 팀 정렬'
    // 포메이션을 여기 넣지 않는다 — 오버레이 바가 이미 `ent__formation` 칩으로
    // 상시 표시하므로 문장에 또 넣으면 "대한민국 · 4-2-3-1  4-2-3-1"이 된다.
    case 'home-intro':
      return `${cast.homeTeamKo} 선발 라인업`
    case 'away-intro':
      return `${cast.awayTeamKo} 선발 라인업`
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
  /** 소개 순번(0~10). 심판은 -1. */
  introIndex: number
  /** 심판인가(소개·킷 배선이 다르다). */
  referee: boolean
  /** 터널 안쪽 시작점. */
  s: Pt
  /** 터널을 빠져나와 열이 완성된 지점. */
  c: Pt
  /** 컷1 집결 지점(센터서클 앞). */
  m: Pt
  /** 컷2 분리 후 서는 지점. */
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
  const w = toWorld(c.x, c.y)
  // ★ **표시 진영 회전을 여기서 한 번 흡수한다**(2026-08-01).
  //   Match3D는 경기 프레임을 화면에 올리기 직전 `rotateFrame(frame, FIRST_HALF_ENDS)`로
  //   180° 돌린다(전반에는 항상 −1 — ends.ts 참조). 그런데 **입장 연출 경로는 그 회전을
  //   타지 않는다** — 이 모듈이 이미 "카메라 쪽 = −Z, 화면 오른쪽 = −X"라는 화면 좌표계로
  //   무대를 짜기 때문이다(터널이 카메라 쪽에 있어야 하고, 스토리보드가 "우리 팀은
  //   오른쪽"이라 했다). 두 좌표계가 만나는 유일한 지점이 **흩어짐의 도착지**다.
  //   여기서 돌려 두지 않으면 연출이 끝나는 순간 22명이 통째로 180° 순간이동한다.
  //   `entrance.test.ts`가 이 정합을 못 박는다.
  return FIRST_HALF_ENDS === 1 ? w : { x: -w.x, z: -w.z }
}

function makeTrack(
  id: string,
  side: 'home' | 'away',
  number: number,
  introIndex: number,
  referee: boolean,
  c: Pt,
  m: Pt,
  l: Pt,
  k: Pt,
  faceEnd: number,
): Track {
  const s = { x: c.x + COL_BACK, z: c.z }
  return {
    id, side, number, introIndex, referee, s, c, m, l, k,
    faceWalk: Math.atan2(c.z - s.z, c.x - s.x),
    faceEnd,
  }
}

/** 컷2에서 그 팀 i번째 선수가 서는 자리. 줄은 중심을 기준으로 좌우 대칭이다. */
export function entranceLinePoint(side: 'home' | 'away', i: number, total = 11): { x: number; z: number } {
  const cx = side === 'home' ? HOME_LINE_CX : AWAY_LINE_CX
  const span = LINE_GAP * (total - 1)
  return { x: cx - span / 2 + LINE_GAP * i, z: LINE_Z }
}

function buildTracks(cast: EntranceCast): Track[] {
  const out: Track[] = []
  REFEREE_IDS.forEach((id, i) => {
    out.push(
      makeTrack(
        id,
        'home',
        REFEREE_NUMBER,
        -1,
        true,
        REF_COL[i],
        REF_CENTER[i],
        REF_CENTER[i],
        REF_KICKOFF[i],
        // 심판은 마지막에 센터서클을 향해 선다.
        Math.atan2(-REF_KICKOFF[i].z, -REF_KICKOFF[i].x),
      ),
    )
  })
  cast.home.forEach((mem, i) => {
    out.push(
      makeTrack(
        mem.id, 'home', mem.number, i, false,
        { x: COL_HEAD_X + COL_GAP * i, z: HOME_COL_Z },
        { x: CLUSTER_LEFT_X + CLUSTER_GAP * i, z: CLUSTER_HOME_Z },
        entranceLinePoint('home', i, cast.home.length),
        kickoffPoint(cast.homeFormation, mem.slotIndex, 'home', cast.homeInstructions),
        // 공격 방향도 같은 회전을 탄다(엔진 프레임 홈 = +X 공격).
        FACE_END_HOME,
      ),
    )
  })
  cast.away.forEach((mem, i) => {
    out.push(
      makeTrack(
        mem.id, 'away', mem.number, i, false,
        { x: COL_HEAD_X + COL_GAP * i, z: AWAY_COL_Z },
        { x: CLUSTER_LEFT_X + CLUSTER_AWAY_OFFSET_X + CLUSTER_GAP * i, z: CLUSTER_AWAY_Z },
        entranceLinePoint('away', i, cast.away.length),
        kickoffPoint(cast.awayFormation, mem.slotIndex, 'away', cast.awayInstructions),
        FACE_END_AWAY,
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
function introStep(script: EntranceScript, track: Track, ms: number): number {
  if (track.referee || track.introIndex < 0) return 0
  const hi = entranceHighlightAt(script, ms)
  if (!hi || hi.side !== track.side || hi.index !== track.introIndex) return 0
  // sin(πu)는 u=0·1에서 정확히 0이라 앞뒤 선수와 이어 붙어도 위치가 튀지 않는다.
  return INTRO_STEP_M * Math.sin(Math.PI * hi.u)
}

/**
 * 사람 한 명의 시각 ms 위치. 구간마다 smoothstep이라 각 경계에서 속도가 0이 된다 —
 * 터널 입구에서 한 번 멈췄다 신호를 받고 나오는 실제 의식과 같은 리듬이고,
 * 동시에 속도 불연속(발이 튀는 원인)도 없앤다.
 */
function posAt(script: EntranceScript, track: Track, ms: number): Pt {
  const t = clamp(ms, 0, script.totalMs)
  const [tunnel, walkout, split, , awayIntro, disperse] = script.phases
  if (t < tunnel.end) {
    const u = smoothstep((t - tunnel.start) / (tunnel.end - tunnel.start))
    return { x: track.s.x + (track.c.x - track.s.x) * u, z: track.s.z + (track.c.z - track.s.z) * u }
  }
  if (t < walkout.end) {
    const u = smoothstep((t - walkout.start) / (walkout.end - walkout.start))
    return { x: track.c.x + (track.m.x - track.c.x) * u, z: track.c.z + (track.m.z - track.c.z) * u }
  }
  if (t < split.end) {
    const u = smoothstep((t - split.start) / (split.end - split.start))
    return { x: track.m.x + (track.l.x - track.m.x) * u, z: track.m.z + (track.l.z - track.m.z) * u }
  }
  if (t < awayIntro.end) {
    return { x: track.l.x, z: track.l.z - introStep(script, track, t) }
  }
  const u = smoothstep((t - disperse.start) / (disperse.end - disperse.start))
  return { x: track.l.x + (track.k.x - track.l.x) * u, z: track.l.z + (track.k.z - track.l.z) * u }
}

/**
 * 보폭 위상 — **이동거리 / 공유 보폭 모델**을 0부터 적분한다. 상태를 들고 다니지 않는
 * 순수 함수라 어느 시각으로 건너뛰어도 같은 값이 나오고(스킵·되감기 안전),
 * 렌더러가 소비하는 위상이 실제 이동거리와 정확히 정합해 발이 미끄러지지 않는다.
 *
 * ★ 소개 구간은 **적분에서 건너뛴다**. 모든 사람이 제자리에 서 있는 40초를 50 ms
 *   격자로 적분하면 프레임마다 800스텝이 돌아 60fps가 무너진다(그리고 그 구간의
 *   기여는 정지 보행분뿐이라 해석적으로 더할 수 있다).
 */
function gaitPhaseAt(script: EntranceScript, track: Track, ms: number): number {
  const end = clamp(ms, 0, script.totalMs)
  const introStart = script.phases[3].start
  const introEnd = script.phases[4].end
  let phase = seedPhase(track.id)
  let prev = posAt(script, track, 0)
  let t = 0
  while (t < end) {
    let next = Math.min(t + GAIT_STEP_MS, end)
    // 소개 구간은 호명 선수만 한 걸음 움직인다 — 그 선수는 촘촘히, 나머지는 통째로 건너뛴다.
    if (track.introIndex < 0 && t >= introStart && t < introEnd) next = Math.min(introEnd, end)
    const dt = (next - t) / 1000
    const p = posAt(script, track, next)
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

function poseFor(script: EntranceScript, track: Track, ms: number): PlayerPose {
  const t = clamp(ms, 0, script.totalMs)
  const here = posAt(script, track, t)
  // 속도·진행 방향은 중앙차분으로 뽑는다 — 위치 함수 하나만 정본이면 되고,
  // 속도가 위치와 어긋날 수 없다.
  const a = posAt(script, track, t - VEL_H_MS)
  const b = posAt(script, track, t + VEL_H_MS)
  const dx = b.x - a.x
  const dz = b.z - a.z
  const speed = Math.hypot(dx, dz) / ((2 * VEL_H_MS) / 1000)
  const moveYaw = speed > YAW_MIN_SPEED ? Math.atan2(dz, dx) : track.faceWalk

  const w = entrancePhaseWindow(script, t)
  let yaw: number
  if (w.phase === 'tunnel') {
    yaw = moveYaw
  } else if (w.phase === 'walkout') {
    // 도착 직전에 몸을 돌려 메인스탠드를 본다(멈춘 뒤 홱 도는 것 방지).
    yaw = shortLerpAngle(moveYaw, FACE_CAMERA, smoothstep((w.u - 0.6) / 0.4))
  } else if (w.phase === 'split') {
    // 갈라져 걷는 동안에는 진행 방향을, 도착하며 다시 메인스탠드를 본다.
    yaw = shortLerpAngle(moveYaw, FACE_CAMERA, smoothstep((w.u - 0.55) / 0.45))
  } else if (w.phase === 'disperse') {
    yaw = shortLerpAngle(moveYaw, track.faceEnd, smoothstep(w.u))
  } else if (w.phase === 'done') {
    yaw = track.faceEnd
  } else {
    yaw = FACE_CAMERA
  }

  const gaitPhase = ((gaitPhaseAt(script, track, t) % 1) + 1) % 1
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
 * FrameState + 심판 3인. 심판은 실제 선수가 아니므로 `players`에 섞지 않는다 —
 * 호출부가 별도 리그·킷으로 그리고, side·number는 배선 시 덮어쓸 수 있다.
 */
export interface EntranceFrame extends FrameState {
  referees: PlayerPose[]
  /** 주심(= referees[0]). 예전 단일 심판 계약을 쓰는 호출부용. */
  referee: PlayerPose
}

/**
 * 카메라가 볼 지점 = **이 순간 배역의 무게중심**(소개 단계만 소개 중인 팀 쪽으로 좁힌다).
 *
 * 예전에는 단계마다 무대 좌표(터널 입구·줄 중앙)를 손으로 적어 두고 그 사이를 보간했다.
 * 그 값들은 무대 배치 상수와 따로 자라서 실제 배역 위치와 어긋났다 — 특히 터널 단계의
 * `mouth`는 심판 한 명의 좌표였는데 열의 실제 중심은 10 m 떨어져 있어 열 꼬리가
 * 프레임 밖으로 나갔다. 실제 포즈에서 평균을 내면 무대 배치를 어떻게 바꿔도 카메라가
 * 따라오고, 흩어짐 끝에서는 킥오프 대형의 중심(≈ 원점)으로 저절로 수렴한다.
 */
function focusAt(script: EntranceScript, poses: PlayerPose[], ms: number): Pt {
  const side = entranceIntroSide(script, ms)
  // ── 컷1·컷2·흩어짐: 배역 전원의 무게중심 ────────────────────
  if (!side) {
    let sx = 0
    let sz = 0
    for (const p of poses) {
      sx += p.x
      sz += p.z
    }
    const n = poses.length || 1
    return { x: sx / n, z: sz / n }
  }

  // ── 컷3·컷4: 소개 중인 **그 팀 줄만** 본다 ───────────────────
  // 전원의 무게중심(≈ 원점)을 쓰면 두 줄이 26 m 떨어져 있으므로 카메라가 아무도 없는
  // 센터서클을 클로즈업한다. 줄의 중심에서 출발해 호명 선수 쪽으로 당긴다.
  const line = poses.filter(p => p.side === side)
  let cx = 0
  let cz = 0
  for (const p of line) {
    cx += p.x
    cz += p.z
  }
  const n = line.length || 1
  const c: Pt = { x: cx / n, z: cz / n }

  // 팬 목표 x — **비트가 바뀌어도 끊기지 않는다.**
  //  · 이름 비트: 직전 호명 선수 → 지금 호명 선수로 비트 앞 40 %에 걸쳐 이동한다.
  //    계단식으로 갈아 끼우면 비트 경계마다 카메라가 1.35 m씩 튄다(20 ms에 1.35 m = 67 m/s).
  //  · 그룹 도입·해설 비트: **직전 프레이밍을 그대로 유지**한다. 여기서 줄 중심으로
  //    되돌리면 그룹이 바뀔 때마다 카메라가 줄 한가운데로 5 m씩 왕복한다(실측 5.13 m).
  const tx = panTargetX(script, line, ms, c.x)
  // 완전히 그 선수에 꽂지 않고 일부만 당긴다 — 양옆 동료가 프레임에 남아야 "줄"로
  // 읽힌다. 0.8이면 프레임 내 인원이 급감하고, 0.45면 줄 끝 선수(중심에서 9 m)가
  // 가장 좁은 종횡비에서 프레임 밖으로 나간다(실측 NDC x = 1.01).
  return { x: c.x + (tx - c.x) * PAN_GAIN, z: c.z }
}

/**
 * 지금 카메라가 향할 x(연출 좌표). {@link focusAt}의 소개 구간 전용.
 *
 * @param line     소개 중인 팀의 포즈들
 * @param fallback 아직 아무도 호명되지 않았을 때의 목표(줄 중심)
 */
function panTargetX(script: EntranceScript, line: PlayerPose[], ms: number, fallback: number): number {
  const idx = entranceBeatIndexAt(script, ms)
  if (idx < 0) return fallback
  const side = script.beats[idx].side
  const xOf = (playerId: string): number | null => line.find(p => p.id === playerId)?.x ?? null
  // 지금(포함)부터 뒤로 훑어 **가장 최근 두 명**의 호명 선수를 찾는다.
  let cur: number | null = null
  let prev: number | null = null
  for (let i = idx; i >= 0; i--) {
    const b = script.beats[i]
    if (b.side !== side) break
    if (!b.playerId) continue
    const x = xOf(b.playerId)
    if (x === null) continue
    if (cur === null) cur = x
    else {
      prev = x
      break
    }
  }
  if (cur === null) return fallback
  const hi = entranceHighlightAt(script, ms)
  // 이름 비트가 아니면(그룹 도입·해설) 직전 프레임을 그대로 붙잡는다.
  if (!hi) return cur
  const from = prev ?? fallback
  return from + (cur - from) * smoothstep(hi.u / 0.4)
}

/**
 * 입장 연출 한 프레임(순수 함수). 같은 (script, ms)면 항상 같은 값을 돌려준다.
 *
 * @param script {@link entranceScript} 결과
 * @param ms     연출 시작으로부터 경과 ms(0 미만·총 길이 초과는 클램프)
 */
export function entranceFrame(script: EntranceScript, ms: number): EntranceFrame {
  const tracks = tracksFor(script.cast)
  const t = clamp(ms, 0, script.totalMs)
  const players: PlayerPose[] = []
  const referees: PlayerPose[] = []
  const all: PlayerPose[] = []
  for (const tr of tracks) {
    const pose = poseFor(script, tr, t)
    all.push(pose)
    if (tr.referee) referees.push(pose)
    else players.push(pose)
  }
  const ball: BallPose = { x: 0, y: BALL_Y, z: 0, spin: 0 }
  return {
    players,
    ball,
    // 무게중심은 심판까지 포함한 **배역 전원**에서 낸다(심판도 화면에 있어야 한다).
    focus: focusAt(script, all, t),
    referees,
    referee: referees[0] ?? all[0],
    event: null,
  }
}
