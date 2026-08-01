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
// ★ 빌드업의 키는 **유저가 워룸에서 고른 attackPattern**이다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-30 전면 개편 — "공이 혼자 떠다닌다"의 근원을 데이터에서 없앤다
// ─────────────────────────────────────────────────────────────────────────────
// 예전 저술 방식은 **볼 궤적과 무버 궤적을 따로** 손으로 썼다. 실측 결과 같은 스텝에서
// 둘이 6.7~17.9 m 떨어져 있었다(docs/research/football-sim-physics.md §1.1). 즉 공은
// 태생적으로 아무의 발에도 없었고, 화면에서 공 옆에 서던 것은 수렴 로직에 빨려온
// **엉뚱한 일반 선수**였다.
//
// 지금은 **스테이션(Station)**을 저술한다: 무버 3명의 위치 + "이 순간 누가 공을 가졌나"
// (carrier). 볼 좌표는 저술하지 않고 **캐리어의 발 앞 0.45 m**에서 유도한다. 그래서
// 공이 발에서 떨어지는 것이 구조적으로 불가능하다.
//
// 시각(t)도 손으로 쓰지 않는다. 구간 거리를 실제 미터로 재고 **의도 볼 속도**(지면 13 /
// 패스 15 / 크로스 20 / 슛 25 m/s)로 나눠 소요 시간을 역산하고, 구간 사이에 컨트롤
// 정지(TOUCH_MS)를 끼운다. 캐리어가 인간 속도로 도달할 수 없으면 그 구간을 늘린다 —
// 즉 **선수 속도 상한이 저술 데이터가 아니라 물리에서 나온다.**
//
// 좌표계: home-프레임(좌→우 공격) 0~100. y는 "아래 전개"(y>50)로 저술하고
// 레인 변형이 위/아래·중앙으로 접는다. away 미러(100-x)는 choreography가 마지막에 한다.
// 랜덤·시간 의존 없음(결정론).
import type { AttackPattern, Instructions } from '../../engine/types'
import { PITCH_H, PITCH_W } from './geometry'

/** 볼 궤적 종류(구간 시작 스텝에 붙는다). movement.BallArcKind가 이 타입을 재사용한다. */
export type BallArc = 'ground' | 'pass' | 'shot' | 'cross'

// ── 물리 상수 (docs/research/football-sim-physics.md §2.2) ────────────────
/**
 * 궤적별 의도 초기 속도(m/s).
 *
 * 근거: Bray & Kerwin(2003) 직접 프리킥 실측 23.0~28.3 m/s → 슛 25. 짧은 지면 패스는
 * 10~15, 크로스는 18~22가 타당 범위(같은 모델로 도달거리·체공에서 역산).
 * ★ 예전 코드는 정확히 뒤집혀 있었다 — 빌드업 패스 22~25, 마무리 슛 14 m/s.
 */
export const SEGMENT_SPEED: Record<BallArc, number> = {
  ground: 13,
  pass: 15,
  cross: 20,
  shot: 25,
}

/** 패스 도착 → 다음 패스 출발 사이의 컨트롤 정지(ms). 실제 빌드업의 트래핑 시간. */
export const TOUCH_MS = 380

/**
 * 캐리어(공을 든/받는 선수)의 주행 상한(m/s).
 * movement.MAX_SPEED(7.5)보다 낮게 둔다 — 저술이 클램프 한계를 요구하면 속도 클램프에
 * 걸려 선수가 공보다 뒤처지고, 그것이 곧 "공이 혼자 간다"가 된다.
 */
export const CARRIER_RUN_SPEED = 7.0

/**
 * 지원 무버(공을 만지지 않는 두 명)의 주행 상한(m/s).
 * 캐리어보다 조금 높게 두되 movement.MAX_SPEED(7.5) 아래다 — 저술이 이 값을 넘기면
 * 속도 클램프에 걸려 무버가 안무 좌표를 영원히 따라잡지 못하고 뒤에서 질질 끌린다.
 */
export const SUPPORT_RUN_SPEED = 7.4

/** 배달 한 구간 동안 지원 무버가 이동하는 최대 거리(m). 9 m ≈ 1.2 s × 7.4 m/s. */
const SUPPORT_STEP_M = 9

/** 구간 최소 소요(ms) — 0거리 구간이 t를 붕괴시키지 않게. */
const MIN_SEGMENT_MS = 140

/** 공이 놓이는 발 앞 거리(m). football-match-viewer의 `finalDistance = 0.4`와 같은 처방. */
export const FOOT_OFFSET_M = 0.45

/**
 * 세이브 접촉점이 골라인에서 떨어지는 거리(m). 변형별로 2.2 / 2.6 / 3.2를 쓴다.
 *
 * 왜 이 범위인가: GK는 골라인 0.6~6 m의 박스 안에 살고(movement.GK_BOX_DEPTH),
 * 문전 상황에서는 골라인 약 1 m 지점에 선다. 완전 신전 반경이 2.0 m
 * (movement.GK_DIVE_REACH — 어깨 높이 1.44 + 팔 0.56)이므로 접촉점이 골라인에서
 * 3.4 m를 넘으면 손이 물리적으로 닿지 못한다. 2~3 m 띠가 "몸을 던져 닿는" 구간이다.
 */
export const SAVE_CONTACT_M = 2.6

/**
 * 도착 키프레임에서 **캐리어가 아닌** 무버를 목표의 몇 %에 두는가.
 * 100%면 컨트롤 정지 동안 세 명이 함께 얼어붙는다. 88%로 두면 나머지 12%를 정지
 * 구간에서 마저 달려 화면이 굳지 않는다.
 */
const ARRIVE_BLEND = 0.88

/**
 * 장면 종류별 기준 dwell(ms) — **playback.EVENT_DWELL_MS의 정본**.
 *
 * 왜 여기 사는가: 안무 t는 dwell 상대값이다. dwell을 재생 쪽에서 따로 정하면 저술이
 * 계산한 "초당 몇 미터"가 화면에서 그대로 나오지 않는다. 실제 소요(아래 계산 결과)에
 * 여운·세리머니를 더한 값이며 `scenes.test.ts`가 마지막 t ≤ 0.8을 고정한다.
 *
 * 실측 총 소요(전 조합 최댓값): goal 6.54s · miss 6.71s · shot 6.34s · save 6.27s ·
 * chance 4.12s · corner 2.88s · foul 0.32s. 여기에 여운(골은 세리머니 창 2 s)을 더해
 * 마지막 키프레임이 dwell의 80% 안에 들어오도록 잡았다.
 *
 * ★ 2026-08-01 +400 ms(goal/save/shot/miss). 득점 루트 5종으로 늘리면서 드리블 돌파
 *   루트가 배달 뒤에 터치를 두 번 더 쓰고, 오프사이드 상한이 슈터를 뒤로 물리면 배달
 *   구간도 길어진다. 전수 실측(전 계열 × 실행 2 × 루트 5 × 레인 6 × 라인 0~100)에서
 *   최대 마지막 t가 8400 ms 기준 0.808로 계약(≤0.8)을 넘었다 — 저술을 잘라 그림을
 *   망가뜨리는 대신 dwell을 늘렸다. 8800 ms에서 최댓값 0.771이다.
 */
export const SCENE_DWELL_MS: Record<SceneFinish, number> = {
  goal: 9000,
  save: 8800,
  shot: 8800,
  miss: 8800,
  chance: 5200,
  corner: 3700,
  foul: 2600,
}

/** 장면 키프레임 한 점(lane 매핑 후 좌표). */
export interface ScenePoint {
  t: number
  ball: [number, number]
  /** 역할 슬롯 3개의 위치(순서 = 역할 순서). 스텝마다 같은 길이여야 보간된다. */
  movers: [number, number][]
  /** 이 스텝에서 시작하는 구간의 볼 궤적. 미지정이면 이벤트 타입으로 추론한다. */
  arc?: BallArc
  /**
   * 이 스텝에서 공을 소유한 무버 슬롯(0~2). 없으면 볼이 자유(비행 후 결과 지점).
   * ★ 렌더러는 이 값으로 **누가 차는가**를 정한다 — "볼에서 가장 가까운 아무나"가 아니라.
   */
  carrier?: number
  /**
   * 이 스텝의 **도착 높이**(m). 미지정이면 궤적 종류의 기본값(movement.BALL_END).
   * 크로스바를 넘겨 버리는 미스처럼 "골라인 통과 높이"가 장면의 핵심일 때만 쓴다.
   */
  endY?: number
  /**
   * 이 스텝이 **GK의 손이 공에 닿는 순간**인가(세이브 전용).
   *
   * 왜 별도 플래그인가: 무브먼트는 다이브 최대 신전을 "마지막 키프레임"에 맞추고 있었는데,
   * 그 규약은 마지막 키프레임이 곧 접촉일 때만 성립한다. 접촉을 명시하면 뒤에 여운·리바운드
   * 스텝을 붙여도 인과가 흔들리지 않고, GK를 **어디로 보낼지**도 이 좌표에서 나온다.
   */
  contact?: boolean
}

/** 저술 단위 — 한 순간의 무버 배치와 소유자. 볼 좌표는 여기서 유도한다. */
interface Station {
  /** 무버 3명(역할 슬롯 순서). 슬롯 0은 항상 이벤트 주인공(슈터)이다. */
  movers: [number, number][]
  /** 공을 가진 슬롯. -1이면 자유(마지막 결과 지점). */
  carrier: number
  /** carrier < 0일 때의 명시 볼 좌표. */
  ball?: [number, number]
  /** 도착 높이(m) — {@link ScenePoint.endY}로 그대로 나간다. */
  endY?: number
  /** 이 스테이션에서 **출발**하는 구간의 궤적. 마지막 스테이션은 무시된다. */
  arc?: BallArc
  /** true면 컨트롤 정지를 넣지 않는다(원터치). 첫 스테이션은 항상 정지가 없다. */
  oneTouch?: boolean
  /** GK 손이 공에 닿는 스테이션(세이브 전용) — {@link ScenePoint.contact}로 그대로 나간다. */
  contact?: boolean
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
  stations: Station[]
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
/**
 * attackPattern이 **가장 자주** 부르는 계열. 워룸·분석보드 라벨 전용이다.
 *
 * ★ 2026-08-01: 이것이 더 이상 "그 전술이 쓰는 유일한 계열"이 아니다. 실제 선택은
 *   {@link BUILDUP_WEIGHTS}가 정하고, 여기 있는 값은 그 분포의 최빈값일 뿐이다.
 */
export const BUILDUP_BY_PATTERN: Record<AttackPattern, BuildupId> = {
  balanced: 'central',
  cross: 'wing',
  through: 'through',
  longshot: 'outside',
}

/** 가중치 표의 열 순서 — 누적 합 탐색이 이 순서를 쓴다(결정론). */
export const BUILDUP_ORDER: readonly BuildupId[] = ['central', 'wing', 'through', 'outside']

/**
 * attackPattern → 빌드업 계열 **분포**(백분율, 합 100).
 *
 * ★ 2026-08-01 재설계(5라운드 피드백 ③). 예전에는 attackPattern이 계열을 팀당 **1종으로
 *   고정**했다. 의도는 "유저 전술이 화면에 보인다"였고 그 목적 자체는 달성됐지만,
 *   부작용으로 기본값(balanced)을 둔 유저는 90분 내내 `central` 한 장면 계열만 봤다
 *   (사용자 지적: "항상 중앙에서 공격수한테 패스하고 공격수가 슛을 쏘고 있어").
 *
 * 처방: **고정이 아니라 기울임**. 고른 전술의 계열이 최빈값이 되되 나머지도 나온다.
 * 전술 가시성은 유지된다 — 60% 대 15%는 눈에 띄게 다른 비율이고, 한 경기(하이라이트
 * 20~30건)에서도 최빈 계열이 명확히 드러난다.
 *
 * · balanced  30/25/25/20 — "고르게". 어느 계열도 3분의 1을 넘지 않는다.
 * · cross     측면 60 / 중앙 15 / 침투 15 / 중거리 10 (스펙이 예로 든 비율)
 * · through   침투 60 / 중앙 15 / 측면 15 / 중거리 10
 * · longshot  중거리 55 / 중앙 20 / 측면 15 / 침투 10 — 중거리는 다른 계열과 그림 차이가
 *   가장 커서(슛 지점 21~30 m) 55%면 충분히 "이 팀은 밖에서 때린다"로 읽힌다.
 */
export const BUILDUP_WEIGHTS: Record<AttackPattern, Record<BuildupId, number>> = {
  balanced: { central: 30, wing: 25, through: 25, outside: 20 },
  cross: { central: 15, wing: 60, through: 15, outside: 10 },
  through: { central: 15, wing: 15, through: 60, outside: 10 },
  longshot: { central: 20, wing: 15, through: 10, outside: 55 },
}

/**
 * 분포에서 계열 하나를 뽑는다. `u`는 0~99의 결정론 해시값(choreography가 준다).
 * 누적 합 탐색이라 가중치 순서가 곧 결과의 순서다 — 같은 u면 언제나 같은 계열.
 */
export function pickBuildup(pattern: AttackPattern, u: number): BuildupId {
  const w = BUILDUP_WEIGHTS[pattern]
  let acc = 0
  const r = mod(u, 100)
  for (const id of BUILDUP_ORDER) {
    acc += w[id]
    if (r < acc) return id
  }
  return BUILDUP_ORDER[BUILDUP_ORDER.length - 1]
}

/**
 * 빌드업 4계열 × 실행 변형 2종. 전부 3스테이션(= 볼 터치 3번)이다.
 *
 * ★ 저술 규칙(개편 후):
 *  1. 슬롯 0은 슈터다. 빌드업 내내 x 65 → 73 → 80으로 **박스로 침투**한다(공은 안 준다).
 *     마무리에서 그가 슈팅 지점까지 달릴 거리를 {@link MAX_RUN_IN_M} 안에 두기 위한 배치다.
 *     ★ 2026-07-31: 마지막 지점을 76 → 80으로 밀었다. 76(골라인 25 m)에서는 박스 안
 *     마무리(골라인 8~13 m)가 한 구간에 17 m 주행을 요구해 물리적으로 불가능했고,
 *     그래서 모든 슛이 박스 밖으로 밀려났다. 중거리 계열(outside)만 70에 남는다.
 *  2. 공은 슬롯 1·2 사이를 오간다. 같은 슬롯이 연속으로 캐리어면 드리블 구간이 되고,
 *     그때는 볼 속도가 곧 선수 속도이므로 시간 역산이 자동으로 6.6 m/s로 눌러 준다.
 *  3. 무버 한 명이 한 구간에 8~10 m를 넘게 달리지 않는다(구간 1~1.6 s × 6.6 m/s).
 *
 * FM 교훈대로 t=0에서 이미 공이 중원 이상에 있다 — 자기 진영 롱빌드업은 데드타임이다.
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
        stations: [
          { movers: [[65, 46], [42, 60], [54, 34]], carrier: 1, arc: 'pass' },
          { movers: [[73, 48], [50, 56], [59, 37]], carrier: 2, arc: 'ground' },
          { movers: [[80, 50], [55, 55], [64, 41]], carrier: 1 },
        ],
      },
      {
        vid: 'b',
        label: '중앙 원투 벽패스',
        roles: [[62, 42], [80, 52], [70, 70]],
        stations: [
          { movers: [[65, 54], [44, 44], [50, 60]], carrier: 1, arc: 'pass' },
          // 벽패스 리턴은 지면·원터치 — 원터치로 되돌리는 공은 뜨지도, 멈추지도 않는다.
          { movers: [[73, 52], [50, 46], [55, 58]], carrier: 2, arc: 'ground', oneTouch: true },
          { movers: [[80, 51], [54, 48], [59, 56]], carrier: 1 },
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
        stations: [
          { movers: [[66, 52], [62, 76], [52, 58]], carrier: 2, arc: 'pass' },
          // 터치라인 드리블 — 캐리어가 그대로 유지되므로 시간 역산이 선수 속도로 눌러 준다.
          { movers: [[73, 54], [68, 80], [58, 62]], carrier: 1, arc: 'ground' },
          { movers: [[80, 56], [76, 86], [64, 60]], carrier: 1 },
        ],
        roles: [[74, 84], [80, 50], [72, 18]],
      },
      {
        vid: 'b',
        label: '풀백 오버래핑',
        roles: [[76, 80], [80, 50], [70, 22]],
        stations: [
          { movers: [[66, 54], [58, 72], [54, 62]], carrier: 2, arc: 'ground' },
          // 안으로 접었다가 다시 측면으로 — 오버래핑의 그림.
          { movers: [[73, 55], [66, 80], [60, 64]], carrier: 1, arc: 'pass' },
          { movers: [[80, 56], [76, 88], [66, 62]], carrier: 1 },
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
        stations: [
          { movers: [[64, 56], [44, 52], [56, 66]], carrier: 1, arc: 'pass' },
          // 스루패스는 뜨지 않는다 — 뜨면 수비가 따라붙는다.
          { movers: [[72, 57], [50, 56], [62, 70]], carrier: 2, arc: 'ground' },
          { movers: [[80, 58], [56, 58], [68, 72]], carrier: 2 },
        ],
      },
      {
        vid: 'b',
        label: '내려받아 원터치 스루',
        roles: [[66, 40], [80, 50], [72, 74]],
        stations: [
          { movers: [[64, 44], [46, 62], [56, 36]], carrier: 1, arc: 'pass' },
          { movers: [[72, 45], [52, 58], [62, 38]], carrier: 2, arc: 'ground', oneTouch: true },
          { movers: [[80, 47], [57, 56], [68, 40]], carrier: 2 },
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
        stations: [
          { movers: [[58, 50], [42, 66], [54, 36]], carrier: 1, arc: 'pass' },
          { movers: [[64, 50], [48, 62], [58, 38]], carrier: 2, arc: 'pass' },
          { movers: [[70, 50], [52, 60], [62, 42]], carrier: 2 },
        ],
      },
      {
        vid: 'b',
        label: '뒤로 빼주고 때리기',
        roles: [[58, 44], [80, 52], [70, 74]],
        stations: [
          { movers: [[58, 46], [44, 34], [54, 64]], carrier: 1, arc: 'pass' },
          { movers: [[64, 47], [50, 40], [58, 62]], carrier: 2, arc: 'pass' },
          // 박스 앞으로 되빼주는 공 — 뒤에서 달려드는 선수가 때린다.
          { movers: [[70, 48], [54, 44], [62, 58]], carrier: 2 },
        ],
      },
    ],
  },
}

/** 빌드업 실행 변형 수(계열마다 동일). 해시 모듈러가 이 수를 쓴다. */
export const BUILDUP_VARIANT_COUNT = 2

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** 0~100 좌표 두 점의 실제 거리(m). */
function metres(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(((b[0] - a[0]) / 100) * PITCH_W, ((b[1] - a[1]) / 100) * PITCH_H)
}

/**
 * 마무리 변형 — **같은 엔진 결과를 다른 그림으로** 끝낸다.
 *
 * 왜 필요한가: 한 경기의 하이라이트는 goal·save·miss 세 종류가 거의 전부다. 마무리가
 * 3종뿐이면 반복이 산술적으로 강제된다. 결과는 엔진이 정하지만 **어디서 어떻게 때렸는지**는
 * 비어 있으므로, 그 빈칸을 채워 칸 수를 3배로 늘린다.
 */
interface FinishVariant {
  /** 키 접미어. */
  vid: string
  label: string
  /** 슈팅 지점 y의 전개 폭 유지 계수. 음수면 **반대쪽**에서 잡는다(컷백). */
  w: number
  /** 결과 지점 좌우 — 0=기존(수렴), +1=니어포스트, -1=파포스트. */
  post: -1 | 0 | 1
  /** 배달 구간을 지면으로 강제하는가(컷백은 뜨지 않는다). */
  ground: boolean
  /** 배달을 원터치로 마무리하는가(컨트롤 정지 없음). */
  oneTouch: boolean
  /**
   * **헤더 마무리** — 배달을 크로스로 강제하고 임팩트를 머리 높이({@link HEADER_BALL_Y})에서
   * 잡는다. 무브먼트가 이 높이를 보고 킥이 아니라 헤더 포즈를 재생한다.
   */
  head?: boolean
  /**
   * **드리블 돌파 마무리** — 배달이 슈터에게 가는 짧은 패스이고, 그 뒤 슈터가 직접 공을
   * 몰고 들어간다(캐리어가 연속 = 드리블). 빌드업을 한 스테이션 줄여 시간을 낸다.
   */
  solo?: boolean
  /**
   * 골문 안 착지점을 기둥 쪽으로 미는 정도. 미지정이면 {@link POST_INSET}.
   * 루트마다 다르게 두는 이유: post 부호가 같은 두 루트(b·e, c·d)가 같은 값을 쓰면
   * **결과 지점이 완전히 겹쳐** 다섯 루트의 그림이 세 가지로 줄어든다(전수 실측).
   */
  postInset?: number
}

/**
 * 마무리 변형 = **득점 루트**. 5종이며 실제 축구의 서로 다른 득점 경로에 대응한다.
 *
 * ★ 2026-08-01 d·e 추가(5라운드 피드백 ③). 그전에는 세 변형이 전부 "받아서 발로 찬다"의
 *   변주라, 사용자가 본 마무리 동작이 사실상 한 가지였다("사이드에서 크로스 올리고
 *   헤딩을 할수도 있는거고, 드리블 돌파를 할수도 있는거고").
 */
const FINISH_VARIANTS: FinishVariant[] = [
  // a — 정면. 받아서 한 번 잡고 때린다.
  { vid: 'a', label: '정면 마무리', w: 0.35, post: 0, ground: false, oneTouch: false },
  // b — 문전 원터치. 한 발 더 들어가 니어포스트로 밀어 넣는다(트래핑 없음).
  { vid: 'b', label: '문전 원터치', w: 0.15, post: 1, ground: false, oneTouch: true },
  // c — 컷백. 엔드라인 쪽에서 되돌린 공을 반대쪽에서 때린다(배달은 지면, 파포스트).
  // ★ w를 -0.45에서 -0.2로 줄였다: 측면 깊은 곳(y≈88)에서 -0.45를 곱하면 슈팅 지점이
  //   반대쪽 하프스페이스(y≈33)로 날아가 배달 거리가 38 m가 됐다. 컷백은 바이라인에서
  //   페널티 스폿 쪽으로 **되빼는** 공이지 피치를 가로지르는 전환 패스가 아니다.
  // postInset 0.60 — 컷백은 스폿 부근에서 때리므로 각이 넓다. 기둥까지 밀지 않아도 들어간다.
  { vid: 'c', label: '컷백 되돌림', w: -0.2, post: -1, ground: true, oneTouch: false, postInset: 0.6 },
  // d — 크로스 헤더. 전개한 쪽 폭을 유지한 채 문전에서 머리로 파포스트에 꽂는다.
  //     w를 0.5로 크게 둔 이유: 헤더는 크로스가 온 쪽 반대 기둥으로 내리꽂는 그림이라
  //     슈팅 지점이 골문 정면으로 수렴하면 "크로스를 받았다"가 읽히지 않는다.
  // postInset 0.72 — 헤더는 크로스가 온 반대쪽 **먼 기둥**으로 내리꽂는 것이 정석이라
  // 네 루트 중 가장 기둥에 가깝다. 골 중앙에서 2.94 m로 포스트(3.66)까지 0.72 m 여유이며,
  // 골 종점 전수 게이트(기둥 여유 > 0.7 m)를 지키는 상한값이다.
  { vid: 'd', label: '크로스 → 헤더', w: 0.5, post: -1, ground: false, oneTouch: true, head: true, postInset: 0.72 },
  // postInset 0.5 — 돌파 후 마무리는 각이 좁아 니어포스트 **안쪽**을 뚫는 그림이 된다.
  // e — 드리블 돌파. 받아서 두 번 몰고 들어간 뒤 니어포스트로 때린다.
  { vid: 'e', label: '드리블 돌파', w: 0.3, post: 1, ground: true, oneTouch: false, solo: true, postInset: 0.5 },
]
export const FINISH_VARIANT_COUNT = FINISH_VARIANTS.length

/** 득점 루트 라벨(디버그 HUD·계측 도구). 인덱스는 마무리 변형 인덱스와 같다. */
export const FINISH_ROUTE_LABELS: readonly string[] = FINISH_VARIANTS.map(v => v.label)

/**
 * 헤더 임팩트 시 공의 높이(m).
 *
 * 근거: 이 프로젝트의 선수 모델은 힙 0.94 m + 어깨 0.5 m = 어깨 1.44 m(pose.ts HIP_Y·
 * SHOULDER_Y)이고 머리 중심은 그보다 약 0.3 m 위인 1.74 m다. 실제 헤더는 도약해서
 * 이마로 때리므로 접점이 그보다 조금 높다 — 1.95 m면 "뛰어서 머리에 맞혔다"가 되고
 * 크로스바(2.44 m) 아래라 골문으로 내리꽂는 궤적도 성립한다.
 */
export const HEADER_BALL_Y = 1.95

// ── 미스 종점 분포 (StatsBomb open-data 실측) ─────────────────────────────
// 출처: statsbomb/open-data 이벤트 1,014경기에서 뽑은 **오프타깃 슛 7,772건**의
// `shot_end_location`(골라인 평면 3D 좌표). 스펙상 `Off T`는 "초기 궤적이 포스트 밖에서
// 끝난 슛"이라 GK와 무관한 순수 조준 결과이며, 우리가 필요한 값이 정확히 이것이다.
//   · 포스트 바깥 수평 간극:  p25 1.10 · **p50 2.10** · p75 4.30 · p90 6.49 m
//   · 크로스바 위 높이:       p25 1.31 · **p50 2.04** · p75 2.86 · p90 3.69 m
//   · 범주 비율: 옆으로만 45.4% / 위로만 27.9% / 옆+위 26.6%
//   · 프레임에서 2 m 안 40.5% · 3 m 안 60.9% — 미스는 **골대 근처에 몰려 있다**
//
// ★ 개편 전 우리 값은 포스트 밖 **5.18 / 11.30 / 19.46 m**로, 모든 미스가 실측 분포의
//   p90~p99 꼬리에 있었다(전수 144조합). 사용자 지적 "너무 멀찍하게 빗나가서 긴장감이
//   떨어져"가 정확히 이 숫자다.
/**
 * 포스트 바깥 수평 간극(m) — 레인 6종이 실측 분포의 **1/12·3/12·…·11/12 분위수**를 훑는다.
 * 레인은 균등하게 뽑히므로 이렇게 놓아야 6개의 표본 중앙값이 실측 중앙값과 맞는다
 * (LogNormal μ=0.750 σ=0.918을 역함수로 평가). 균등 간격으로 놓으면 중앙값이 3.0으로
 * 부풀어 "실측보다 항상 더 멀리 빗나간다"가 된다.
 */
const MISS_WIDE_M = [0.6, 1.1, 1.75, 2.6, 3.9, 7.5]
/** 크로스바 위 높이(m) — 같은 규칙(Gamma k=4.09 θ=0.52, 표본 중앙값 2.05). */
const MISS_OVER_M = [0.8, 1.3, 1.8, 2.3, 2.9, 3.8]
/**
 * 미스 범주 배정표 — 행 = 마무리 변형(3), 열 = 레인(6).
 * 18칸의 비율이 실측 범주 비율(옆 45.4 / 위 27.9 / 옆+위 26.6)과 맞도록 짰다:
 * W 8칸(44.4%) · O 5칸(27.8%) · B 5칸(27.8%). 한 변형 안에서도 섞여 있어야
 * 같은 변형이 반복돼도 같은 그림이 되지 않는다.
 */
const MISS_CATEGORY: readonly (readonly ('W' | 'O' | 'B')[])[] = [
  ['W', 'W', 'W', 'O', 'B', 'W'],
  ['W', 'O', 'B', 'O', 'W', 'O'],
  ['B', 'W', 'O', 'B', 'W', 'B'],
]
/** 옆으로만 빗나간 슛의 골라인 통과 높이(m). 실측 중앙값 0.64 — 낮게 스친다. */
const MISS_LOW_Y = 0.64
/** 골문 반폭(m) — 규정 7.32 m. */
const GOAL_HALF_M = 3.66
/**
 * 니어/파포스트 마무리를 골문 반폭의 몇 %까지 밀어 넣는가.
 *
 * 0.7 → 골 중앙에서 최대 2.86 m, 포스트(3.66)까지 **0.80 m** 여유다. 공 반지름 0.11 +
 * 포스트 반지름 0.09 = 0.20 m를 빼도 0.6 m가 남아, 원근이 눌리는 골 뒤 카메라에서도
 * "기둥 안쪽"으로 읽힌다.
 */
const POST_INSET = 0.7
/** 크로스바 높이(m). */
const CROSSBAR_M = 2.44

/** 미터 단위 좌우 오프셋 → 0~100 y 좌표. */
const offsetY = (m: number) => 50 + (m / PITCH_H) * 100

/**
 * 슈터가 배달 한 구간 동안 이동할 수 있는 최대 거리(m).
 *
 * 13.5 m ≈ 1.93 s × {@link CARRIER_RUN_SPEED}. 그 이상을 요구하면 시간 역산이 배달
 * 구간을 늘려 크로스가 공중에 떠 있는 슬로모션이 되고, 장면 전체가 dwell 계약
 * (마지막 t ≤ 0.8)을 넘긴다 — 실측 cross/b1/f2/miss가 15.8 m에서 0.828이었다.
 *
 * ★ 방향 제한은 없다. 뒤로 빼주는 공(`outside.b`)에 맞춰 **물러나며** 때리는 것도
 *   축구이고, 실제로 컷백 마무리는 슈터가 골라인 쪽에서 되돌아 나온다.
 */
const MAX_RUN_IN_M = 13.5

/**
 * 드리블 돌파에서 중간 터치가 직선 경로에서 옆으로 벗어나는 폭(0~100 y 프레임 단위).
 *
 * 4.0 ≈ 2.7 m. 실제 돌파의 "안쪽으로 접기"는 2~4 m다. 더 크게 잡으면 주행 거리가
 * 피타고라스로 늘어 드리블 구간이 dwell 예산을 먹고, 더 작으면 화면에서 직선으로 읽힌다.
 */
const DRIBBLE_CUT = 4.0

/**
 * 드리블 돌파의 **총 주행 상한**(m). {@link MAX_RUN_IN_M}보다 짧다.
 *
 * 왜 더 짧은가: 이 루트는 배달 뒤에 드리블 터치가 두 번 더 붙고, 드리블 구간의 속도는
 * 볼 속도가 아니라 **선수 속도**(7.0 m/s)라 같은 거리를 두 배 가까운 시간에 간다.
 * 11 m ≈ 1.57 s이고 옆으로 꺾는 만큼(≈+8%) 실제로는 1.7 s다. 13.5로 두면 miss.e 조합의
 * 총 소요가 7.02 s가 되어 dwell을 8800 ms로 올려도 계약(마지막 t ≤ 0.8)에 여유가 없다
 * (전수 실측). 11 m면 최댓값이 0.775다.
 */
const SOLO_RUN_IN_M = 11

/**
 * 슛 발사점의 x 상한(0~100). 92 = 골라인 8.4 m 앞.
 *
 * 왜 상한이 있나: 결과 키프레임(블록 x 94~96 · 세이브 97.5 · 골 99)이 그 앞에 있어야
 * "슛 → 결과"의 순서가 성립한다. 그래서 실측의 최근접 사분위(6야드 박스 안 8.6%)는
 * 이 라이브러리가 표현하지 못한다 — 그 대신 가장 가까운 칸이 8.4 m에 몰린다.
 */
const MAX_SHOT_X = 92

// ── 슛 발사점 분포 (StatsBomb open-data 실측) ─────────────────────────────
// 출처: statsbomb/open-data 이벤트 전 4,235경기에서 무작위 350경기를 뽑아 얻은
// **오픈플레이 슛 8,348건**의 `location` → 골문 중앙(120, 40) 거리(야드→m).
//   · p10 7.4 · p25 10.7 · **p50 16.1** · p75 22.2 · p90 27.1 · p95 30.0 · p99 37.2 m
//   · 페널티 박스 안 63.8% · 6야드 박스 안 8.6%
//   · 구간: 0~6 4.6% / 6~11 21.6% / 11~16.5 25.4% / 16.5~20 14.3% /
//           20~25 18.8% / 25~30 10.2% / 30~35 3.4% / 35+ 1.6%
//   · 박스 밖(>16.5 m)만: n=4,038(48.4%) p50 22.4 · p75 26.2 · p90 30.1 m
//   · 프리킥 슛(n=394)은 p50 26.1 m — 오픈플레이 중거리와 겹치는 띠다.
//
// ★ 개편 전 우리 값은 **전 패턴 p50 26.9 m · 박스 안 0%**였다(라이브러리 전수 576조합,
//   90분 실주행 4시드 97슛에서도 p50 27.3 m). 즉 어떤 전술을 골라도 화면에 나오는 슛이
//   전부 실측 p88 이상의 중거리였다. 사용자 지적 "너무 먼 곳에서 중거리 슛"이 이 숫자다.
//   원인은 `finishStations`의 `launch`가 **슈터가 아니라 마지막 패서**의 위치였던 것이다:
//   패서는 x 55~62(하프라인 부근)에 있으므로 `clamp(lx + …, 74, lx + MAX_RUN_IN)`의
//   상한(lx+15 = 70~77)이 하한(74)보다 작아져 clamp가 **항상 하한 74**를 뱉었다.
/**
 * 빌드업 계열별 슛 거리 사다리(m, 골문 중앙까지) — 3칸을 **변형 축**으로 색인한다.
 *
 * 왜 레인으로 색인하지 않는가: 레인은 **좌우(y) 전용 축**이고, 거리를 거기 묶으면
 * 두 개의 미러 계약이 동시에 깨진다 — (a) 레인 0/1처럼 서로 좌우 미러인 쌍이 다른 깊이를
 * 갖고, (b) `laneFor`가 팀마다 다른 레인을 주면 같은 사건의 홈·원정 x가 미러가 아니게 된다
 * (실측: 홈 x + 원정 x = 92.99, 규약은 100). 그래서 축을 분리해 **변형 축**으로 색인한다:
 * (빌드업 실행 변형 0~1 + 마무리 변형 0~2)의 합이 3칸을 균등하게(6조합 × 2) 훑는다.
 *
 * 계열마다 다른 사다리를 쓰는 이유 = **유저 전술이 화면에 보여야 한다**(전수 576조합 실측):
 *  · wing(크로스)   문전 마무리 — p50 13.3 m · 골문 16.5 m 안 81%
 *  · through(스루)  뒷공간을 째면 GK와 마주 본다 — p50 14.4 m · 74%
 *  · central(균형)  실측 오픈플레이 전체 분포에 맞춘다 — p50 15.6 m(실측 16.1) · 58%
 *  · outside(중거리) 실측 **박스 밖 슛** 분포(p50 22.4 · p90 30.1)에 맞춘다 — p50 21.8 m · 0%
 */
const SHOT_DIST_M: Record<BuildupId, readonly [number, number, number]> = {
  central: [10.5, 17, 25],
  wing: [9, 13, 19],
  through: [9.5, 14, 20],
  outside: [21, 25, 30],
}

/**
 * 마무리 변형별 거리 배율 — 같은 전술 안에서도 "어떻게 끝냈나"로 거리가 갈린다.
 * a 정면(1.0) · b 문전 원터치(0.8 — 한 발 더 들어간다) · c 컷백(0.92 — 스폿 부근) ·
 * d 헤더(0.62) · e 드리블 돌파(0.85).
 *
 * 헤더가 가장 가까운 근거: StatsBomb 오픈플레이 헤더 슛의 거리 중앙값은 발 슛보다 뚜렷하게
 * 짧다(크로스는 문전으로 배달되므로 구조적으로 그렇다). 0.62를 곱하면 central 사다리
 * 기준 6.5~15.5 m 띠에 들어와 "문전 헤더"로 읽힌다.
 */
const FINISH_DIST_SCALE = [1, 0.8, 0.92, 0.62, 0.85]

/**
 * **결과별** 거리 배율 — 같은 전술이라도 결과에 따라 거리가 다르다. 실측이 그렇다.
 *
 * 출처: 같은 StatsBomb 표본의 오픈플레이 슛을 `shot.outcome`으로 갈랐다(거리 p50, 박스 안).
 *   · Goal    n=856   **11.0 m** · 88%   → 골은 문전에서 난다
 *   · Saved   n=2,003 **16.9 m** · 62%
 *   · Off T   n=2,699 **17.1 m** · 60%   (우리 'miss')
 *   · Blocked n=2,028 **18.1 m** · 55%   (우리 'shot' = 블록·굴절)
 * 기준(1.0)은 오픈플레이 전체 p50 16.1 m이고, 위 값을 그 비로 옮겼다.
 * chance는 슛이 아니라 "박스까지"라 기준값을 그대로 쓴다.
 */
const FINISH_KIND_SCALE: Record<FinishId, number> = {
  goal: 0.68,
  save: 1.05,
  miss: 1.06,
  shot: 1.12,
  chance: 1,
}

/**
 * 세이브 슛의 **최소 거리**(m) — 칸(rung)별. 실측 분포보다 가까운 쪽을 잘라 낸다.
 *
 * 왜 실측을 그대로 못 쓰는가(실측 Saved p25는 12.0 m다): GK는 임팩트 **후에** 움직인다
 * (movement.gkDiveAnchor는 `t >= tShot`부터, 다이브 포즈는 GK_REACTION_MS=200 ms 뒤부터).
 * 접촉점까지 몸통이 2.5~2.8 m를 가야 하는데 GK 상한은 5.5 m/s이고 정지에서 출발한다.
 * 실측(90분 3시드 28세이브, 프레임 단위): 하한 16.0 m면 손-공 최소 거리가 0.00~0.34 m로
 * 전부 접촉 판정(0.33 m) 근처까지 들어오고, 15.4 m로 낮추면 0.45 m까지 벌어진다.
 * 비행 시간으로 옮기면 (16.0 − 0.45 발 앞 − 2.6 접촉 깊이) / 25 m/s = 518 ms다.
 * 근거리 세이브는 실제로도 다이브가 아니라 **반사 블록**인데 우리 포즈 라이브러리에 그
 * 동작이 없다 — 그래서 저술 쪽에서 막는다. 그 대가로 세이브 표본 중앙값이 실측
 * 16.9 m보다 조금 멀어진다(90분 실주행 17.1 m).
 *
 * 칸마다 다른 값을 두는 이유: 단일 하한이면 가까운 칸이 전부 한 점에 뭉쳐
 * "세이브는 늘 같은 자리에서"가 된다.
 */
const SAVE_MIN_M: readonly [number, number, number] = [16.0, 17.0, 18.0]

/**
 * 어떤 전술이든 이 거리(m)를 넘는 슛은 저술하지 않는다.
 *
 * 근거: 실측 오픈플레이 슛의 p95가 30.0 m이고 30 m 초과는 5.0%뿐이다. 하프라인
 * 부근(50 m+)은 시즌에 몇 번이라 **연출 라이브러리에 넣을 사건이 아니다** —
 * 라이브러리는 반복 재생되므로 꼬리 사건을 넣으면 그것이 곧 일상이 된다.
 */
export const MAX_SHOT_DIST_M = 31

/**
 * 마무리 스테이션 — 빌드업의 마지막 캐리어 위치(launch)에서 이어 붙인다.
 * launch가 다르면 같은 마무리도 다른 그림이 된다: 중거리는 62에서, 크로스는 76에서 뜬다.
 *
 * ★ R4 수정(아크 오프바이원): 배달 궤적(`deliverArc`)은 **빌드업 마지막 스테이션**에
 *   붙는다. 예전엔 슈팅 지점 스텝에 붙어서, 크로스 전술 유저가 모든 골·세이브·미스에서
 *   "6 m 떠서 골문으로 들어가는 공"을 봤다(전수 검사 확인).
 */
function finishStations(
  finish: FinishId,
  prev: Station,
  launch: [number, number],
  variant: number,
  /** 레인 인덱스 — 슛 거리와 미스 종점의 **분위수**를 고르는 데 쓴다. */
  lane: number,
  /** 빌드업 계열 — 슛 거리 사다리를 고른다(유저 전술이 화면에 보이는 지점). */
  buildup: BuildupId,
  /** 빌드업 실행 변형 0~1 — 마무리 변형과 합쳐 거리 칸을 고른다(좌우 미러 보존). */
  buildupVariant: number,
): { stations: Station[]; deliverArc: BallArc } {
  const V = FINISH_VARIANTS[variant]
  /**
   * 헤더는 **세이브에 쓰지 않는다.**
   *
   * 왜: 세이브 슛은 {@link SAVE_MIN_M}(16~18 m) 밖에서 떠야 GK가 접촉점까지 몸을 보낼 수
   * 있는데, 16 m 헤더는 실제 축구에 거의 없는 그림이다. 둘 중 하나를 포기해야 하고,
   * 이미 실측으로 못박은 GK 접촉 계약을 지키는 쪽을 택했다. 헤더는 골·미스·블록·찬스에
   * 남으므로 화면에서 사라지지는 않는다.
   */
  const head = !!V.head && finish !== 'save'
  /** 드리블 돌파는 찬스에 쓰지 않는다 — 찬스는 이미 빌드업을 한 스테이션 줄여 쓴다. */
  const solo = !!V.solo && finish !== 'chance'
  const [lx, ly] = launch
  /** 슈터(슬롯 0)가 배달 직전에 서 있는 곳 — 주행 상한은 여기서 잰다. */
  const runFrom = prev.movers[0]
  // 슈팅 지점 y. w>0이면 전개 쪽을 유지한 채 골문으로 수렴, w<0이면 반대쪽(컷백).
  // 슈팅 지점은 박스 폭 안에 머문다 — 밖으로 나가면 "마무리"가 아니라 전환 패스가 된다.
  let my = clamp(50 + (ly - 50) * V.w, 38, 62)
  /**
   * 슈팅 지점 x — **골문 중앙까지의 거리를 먼저 정하고** 깊이를 역산한다.
   *
   * 왜 거리가 먼저인가: 실측 대조군(StatsBomb)이 "골문까지 몇 m"의 분포이고, 사용자가
   * 보는 것도 그 거리다. 예전처럼 전진율(V.adv)로 x를 정하면 y가 벌어질수록 실제 거리가
   * 멋대로 늘어난다(전개 쪽 y=38이면 좌우로만 8 m가 붙는다).
   */
  const rung = mod(buildupVariant + variant, SHOT_DIST_M[buildup].length)
  const want = Math.min(
    MAX_SHOT_DIST_M,
    Math.max(
      SHOT_DIST_M[buildup][rung] * FINISH_DIST_SCALE[mod(variant, FINISH_DIST_SCALE.length)]
        * FINISH_KIND_SCALE[finish],
      finish === 'save' ? SAVE_MIN_M[rung] : 0,
    ),
  )
  // 좌우 성분이 목표 거리를 삼키지 않게 한다 — 삼키면 깊이가 0이 되어 골라인에 붙는다.
  let gz = ((my - 50) / 100) * PITCH_H
  if (Math.abs(gz) > want * 0.8) {
    gz = Math.sign(gz) * want * 0.8
    my = 50 + (gz / PITCH_H) * 100
  }
  const gx = Math.sqrt(Math.max(1, want * want - gz * gz))
  let dx = clamp(100 - (gx / PITCH_W) * 100, 0, MAX_SHOT_X)
  // 슈터가 배달 한 구간에 갈 수 있는 곳인가 — 넘으면 슛 지점을 슈터 쪽으로 당긴다.
  // (당기는 것이지 자르는 것이 아니다: 방향은 유지되고 거리만 줄어든다.)
  const runCap = solo ? SOLO_RUN_IN_M : MAX_RUN_IN_M
  const runM = metres(runFrom, [dx, my])
  if (runM > runCap) {
    const f = runCap / runM
    dx = clamp(runFrom[0] + (dx - runFrom[0]) * f)
    my = clamp(runFrom[1] + (my - runFrom[1]) * f, 38, 62)
  }
  // 전개한 쪽 부호 — 니어/파포스트는 이걸 기준으로 정한다.
  const sideSign = ly > 50 ? 1 : -1
  const deliverDist = metres([lx, ly], [dx, my])
  /**
   * 배달 궤적. 측면 깊은 곳에서 문전으로 올리면 크로스, 컷백은 지면, 그 밖에는
   * 거리로 가른다(긴 배달은 살짝 뜨고 짧은 배달은 구른다).
   * ★ 'shot'은 절대 배달에 쓰지 않는다 — 그 아크는 골문을 향한 슛 전용이다.
   */
  // ★ 크로스 판정이 V.ground보다 우선한다: 측면 깊은 곳에서 문전까지는 30 m가 넘는데
  //   그걸 지면(13 m/s)으로 굴리면 배달 하나가 2.4 s를 먹는다.
  // ★ 컷백 강제(V.ground)에도 거리 조건이 붙는다: 컷백은 바이라인에서 스폿으로 **되빼는**
  //   짧은 공이다. 중앙 빌드업에서 슛 지점이 문전까지 들어가면 배달이 35 m를 넘는데,
  //   그것을 13 m/s 지면으로 굴리면 한 구간이 3.0 s가 되어 dwell 계약(마지막 t ≤ 0.8)이
  //   깨진다(실측 balanced/b0/f2/goal 0.810). 그 거리는 이미 컷백이 아니라 스루패스다.
  // ★ 헤더는 배달이 반드시 크로스다 — 머리 높이로 올라오지 않는 공은 헤딩할 수 없다.
  // ★ 드리블 돌파는 배달이 **슈터 발밑까지**의 짧은 공이라 거리 기준이 다르다.
  const soloDeliverDist = metres([lx, ly], runFrom)
  const deliverArc: BallArc = head
    ? 'cross'
    : solo
      ? (soloDeliverDist > 18 ? 'pass' : 'ground')
      : Math.abs(ly - 50) > 25 && lx >= 70
        ? 'cross'
        : V.ground && deliverDist <= 22
          ? 'ground'
          : deliverDist > 18
            ? 'pass'
            : 'ground'

  /**
   * 지원 무버의 배달 구간 목표 — 직전 위치에서 박스 목표 쪽으로 **최대 SUPPORT_STEP_M**.
   * ★ 예전엔 목표까지 75%를 이동시켰는데, 크로스를 올린 윙어(y≈88)에게 문전(y≈54)을
   *   목표로 주면 한 구간에 28 m를 달려야 했다(실측). 크로스를 올린 선수는 그 자리에
   *   남는 것이 축구다.
   */
  const support = (i: number, tx: number, ty: number): [number, number] => {
    const [px, py] = prev.movers[i]
    const dx0 = ((tx - px) / 100) * PITCH_W
    const dy0 = ((ty - py) / 100) * PITCH_H
    const len = Math.hypot(dx0, dy0)
    const f = len > SUPPORT_STEP_M ? SUPPORT_STEP_M / len : 1
    return [clamp(px + (tx - px) * f), clamp(py + (ty - py) * f)]
  }
  const boxMovers: [number, number][] = [
    [dx, my],
    support(1, clamp(dx - 6), clamp(my + 10)),
    support(2, clamp(dx - 2), clamp(my - 13)),
  ]
  /**
   * 결과 지점의 무버 = 슈팅 지점 그대로.
   * ★ 예전엔 여기서 골문 쪽으로 몇 걸음 전진시켰는데, 슛 구간은 0.15~0.9 s라 3 m를
   *   전진시키면 그 순간 무버 속도가 17 m/s가 된다(실측). 팔로스루는 킥 애니메이션이
   *   그리는 것이지 좌표로 옮길 것이 아니다.
   */
  const netMovers: [number, number][] = boxMovers.map(m2 => [...m2] as [number, number])
  /**
   * 골문 안 착지 y — post가 0이면 슈팅 지점에서 수렴, 아니면 니어/파포스트.
   *
   * ★ 2026-07-31 포스트 계수 0.85 → {@link POST_INSET}. 0.85는 `hi`가 큰 마무리에서
   *   골문 밖으로 나갔다: 골(hi 56)은 골 중앙에서 3.47 m — 포스트 3.66 m에서 **19 cm**,
   *   공 반지름(0.11)과 포스트 반지름(0.09)을 빼면 **0 cm** 여유였다. 세이브(hi 57)는
   *   4.05 m로 아예 포스트 **밖**이었다. 블라인드 감사가 잡은 "골인데 공이 골대 오른쪽
   *   기둥 바깥 잔디에 있다"가 이 숫자다.
   */
  const inset = V.postInset ?? POST_INSET
  const mouth = (spread: number, lo: number, hi: number) =>
    V.post === 0 ? clamp(50 + (my - 50) * spread, lo, hi) : clamp(50 + V.post * sideSign * (hi - 50) * inset, lo, hi)

  /**
   * 슈팅 스테이션 — 캐리어는 반드시 슬롯 0(엔진이 정한 주인공)이다.
   *
   * ★ 헤더는 여기에 `endY`를 실어 **공이 머리 높이로 도착**하게 한다. 무브먼트가 그 높이를
   *   보고 킥 대신 헤더 포즈를 재생하고(movement.HEADER_MIN_Y), 뒤이은 슛 구간도 그
   *   높이에서 출발한다. 헤딩은 언제나 원터치다 — 머리로 트래핑할 수는 없다.
   */
  const shot: Station = {
    movers: boxMovers,
    carrier: 0,
    arc: 'shot',
    oneTouch: head ? true : V.oneTouch,
    ...(head ? { endY: HEADER_BALL_Y } : {}),
  }
  const end = (ball: [number, number], endY?: number): Station =>
    ({ movers: netMovers, carrier: -1, ball, ...(endY != null ? { endY } : {}) })
  /** 골라인에서 m 미터 앞의 x(0~100). 세이브 접촉점을 미터로 저술하기 위한 환산. */
  const beforeLine = (m: number) => clamp(100 - (m / PITCH_W) * 100)

  /**
   * 드리블 돌파의 **선행 스테이션 2개** — 받는 지점(R)과 수비를 제치는 터치(D).
   *
   * 캐리어가 R·D·슛 스테이션에서 연속으로 슬롯 0이므로 {@link timeline}이 이 구간을
   * 드리블로 판정하고(볼이 뜨지 않고, 속도가 볼이 아니라 **선수 속도**로 눌린다),
   * 볼은 계속 슈터의 발 앞 {@link FOOT_OFFSET_M}에 붙는다.
   *
   * D를 R과 슛 지점의 중점에서 **가로로 밀어** 두는 이유: 직선으로 몰고 가면 그냥 달리기다.
   * 옆으로 한 번 꺾어야 "수비를 제쳤다"로 읽힌다. 미는 폭 {@link DRIBBLE_CUT}는 진행
   * 방향의 수직이고, 꺾은 만큼 주행 거리가 늘어나므로 작게 잡는다.
   */
  const carry: Station[] = []
  if (solo) {
    const recv = runFrom
    const midX = (recv[0] + dx) / 2
    const midY = (recv[1] + my) / 2
    // 진행 방향의 수직 단위벡터(0~100 프레임 기준으로 근사) — 전개한 쪽 반대로 꺾는다.
    const vx = dx - recv[0]
    const vy = my - recv[1]
    const vl = Math.hypot(vx, vy) || 1
    const cutX = clamp(midX + (-vy / vl) * DRIBBLE_CUT * -sideSign)
    const cutY = clamp(midY + (vx / vl) * DRIBBLE_CUT * -sideSign, 30, 70)
    carry.push(
      // 받는 순간 컨트롤 정지를 넣지 않는다(oneTouch) — 돌파는 공을 세우지 않고
      // 그대로 몰고 나가는 동작이고, 정지 380 ms는 dwell 예산에서 가장 비싼 항목이다.
      { movers: [recv, prev.movers[1], prev.movers[2]], carrier: 0, arc: 'ground', oneTouch: true },
      {
        movers: [
          [cutX, cutY],
          support(1, clamp(cutX - 8), clamp(cutY + 9)),
          support(2, clamp(cutX - 4), clamp(cutY - 11)),
        ],
        carrier: 0,
        arc: 'ground',
      },
    )
  }
  /** 마무리 스테이션 앞에 드리블 구간을 붙여 반환한다(드리블 루트가 아니면 그대로). */
  const out = (stations: Station[]): { stations: Station[]; deliverArc: BallArc } =>
    ({ stations: carry.length ? [...carry, ...stations] : stations, deliverArc })

  switch (finish) {
    case 'goal':
      // ★ 골 종점은 **골라인 위**(x=100)다. 예전 99는 골라인 1.05 m **앞**이라 공이
      //   골망에 들어가지 않았다 — 무브먼트가 여기서부터 네트 안까지 밀어 넣는다
      //   (movement.GOAL_NET_REST_M). 0~100 좌표계는 골라인까지만 표현할 수 있다.
      return out([shot, end([100, mouth(0.35, 44, 56)])])
    case 'save': {
      /**
       * GK가 **잡는다** — 접촉점은 골라인 앞 {@link SAVE_CONTACT_M} 띠 안이다.
       *
       * ★ 2026-07-31 재저술. 예전 종점은 x 92.5~94.5, 즉 골라인에서 **5.8~7.9 m 앞**이었다.
       *   GK 박스는 골라인에서 0.6~6 m(movement.gkTarget)이고 볼이 문전에 오면 GK는
       *   골라인 1 m 지점에 선다. 그래서 실측 GK-볼 최소거리가 **7.03 m**, 완전 신전
       *   반경(2 m)을 5 m 초과했다 — 접촉 프레임이 존재할 수 없었다. 사용자가 캡처에서
       *   본 "GK는 누워 있고 공은 8 m 밖 빈 잔디"가 정확히 이 숫자다.
       *   지금은 GK가 신전으로 닿을 수 있는 유일한 띠에 접촉점을 두고, 무브먼트가
       *   그 점을 향해 GK 몸통을 보낸다(movement.gkDiveAnchor).
       */
      const depth = V.post === 1 ? SAVE_CONTACT_M - 0.4 : V.post === -1 ? SAVE_CONTACT_M + 0.6 : SAVE_CONTACT_M
      // ★ 접촉점의 좌우 폭을 0.45/43~57 → 0.4/44~56으로 좁혔다: 예전 최대 3.67 m는
      //   포스트(3.66 m) **밖**이라, GK가 골문을 벗어나는 공에 몸을 던지는 그림이었다.
      return out([shot, { ...end([beforeLine(depth), mouth(0.4, 44, 56)]), contact: true }])
    }
    case 'miss': {
      /**
       * 골문 밖 — **실측 분포**(위 MISS_* 주석)를 세 범주로 나눠 마무리 변형에 싣는다.
       *  W 옆으로만(45%) : 포스트 밖 g m, 낮게 스친다
       *  O 위로만(28%)   : 좌우는 골문 폭 안, 크로스바 위 h m
       *  B 옆+위(27%)    : 둘 다
       * 범주는 (마무리 변형 × 레인) 표가, 크기(g·h)는 레인이 정한다 — 같은 변형이라도
       * 장면마다 다른 분위수를 뽑아 "항상 같은 거리로 빗나간다"가 되지 않게 한다.
       */
      const g = MISS_WIDE_M[mod(lane, MISS_WIDE_M.length)]
      const h = MISS_OVER_M[mod(lane + 3, MISS_OVER_M.length)]
      const cat = MISS_CATEGORY[mod(variant, MISS_CATEGORY.length)][mod(lane, LANE_COUNT)]
      const wide = cat !== 'O'
      const over = cat !== 'W'
      // 벗어나는 쪽은 전개한 쪽(sideSign) — 슈터가 몸을 연 방향으로 밀린다.
      const y = wide
        ? offsetY(sideSign * (GOAL_HALF_M + g))
        : offsetY(sideSign * GOAL_HALF_M * 0.45)
      return out([shot, end([99, clamp(y)], over ? CROSSBAR_M + h : MISS_LOW_Y)])
    }
    case 'shot':
      // 블록·굴절 — 골문 바로 앞에서 멈춘다(세이브보다 얕고 미스처럼 벗어나지 않는다).
      return out([shot, end([V.post === 1 ? 96 : V.post === -1 ? 94 : 95, mouth(0.3, 45, 55)])])
    case 'chance':
      // 마무리 없이 박스까지만 — 골문에 닿지 않는다.
      return out([{ movers: boxMovers, carrier: 0 }])
  }
}

// ── 세트피스·반칙: 빌드업이 없는 독립 장면 ───────────────────────────────
/** 코너 — 깃발에서 문전으로. 레인 미러가 곧 좌/우 코너다. */
const CORNER_STATIONS: Station[] = [
  { movers: [[86, 74], [90, 52], [98, 95]], carrier: 2, arc: 'cross' },
  { movers: [[89, 58], [90, 47], [93, 80]], carrier: 1, arc: 'ground' },
  { movers: [[91, 57], [93, 49], [90, 72]], carrier: 1 },
]
/** 코너 역할 원형 — 키 큰 중앙 수비·스트라이커·키커. */
const CORNER_ROLES: [number, number][] = [[80, 50], [22, 38], [70, 84]]

/** 반칙 — 중원 충돌 후 정지. */
const FOUL_STATIONS: Station[] = [
  { movers: [[49, 58], [54, 64], [44, 54]], carrier: 0, arc: 'ground' },
  { movers: [[51, 59], [53, 63], [46, 55]], carrier: 0 },
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

/**
 * attackFocus → 레인 **분포**(가중치, 합은 자유 — 합으로 정규화한다).
 *
 * ★ 2026-08-01 신설(7라운드 ②). 사용자 지적: "공격 방향을 바꾸면 해당 공격 방향에 맞는
 *   시뮬레이션도 같이 나오게 해줘 — 실제 경기에 반영되는 걸 볼 수 있게."
 *   워룸의 `공격방향`(좌/중앙/우/균형)은 그때까지 **화면에 전혀 나타나지 않았다**.
 *   `choreography.laneFor`가 레인 6종을 해시로 **균일 추첨**했기 때문이다.
 *
 * 문법은 {@link BUILDUP_WEIGHTS}와 같다 — **고정이 아니라 기울임**. 좌측을 고르면 좌측
 * 레인이 최빈이 되되 나머지도 나온다. 고정하면 90분 내내 같은 그림이 되어 5라운드에
 * 지적받은 "패턴이 모두 똑같아"로 되돌아간다.
 *
 * 두 축은 **직교한다**: `attackPattern`은 빌드업 **계열**(중앙 침투/크로스/중거리)을,
 * `attackFocus`는 그 계열을 **어느 레인에 접느냐**를 정한다. 레인은 y만 건드리고
 * (`laneY`) 계열은 x 진행과 역할 배치를 정하므로 곱해도 모순이 없다 — `중거리 + 좌측`은
 * "왼쪽 하프스페이스에서 때리는 중거리 슛"이라는 실재하는 그림이다.
 *
 * 좌/우의 정본: 이 프로젝트의 화면은 y가 작을수록 위쪽이고, **자기 골문을 등지고 선
 * 공격 팀 기준으로 위쪽이 왼쪽**이다. 작전판의 공격 집중 밴드(`AnalysisLayer.focusBand`:
 * left → y 0~30)와 점유 흐름의 패턴 라벨(`flow.FLOW_PATTERNS`: '좌측 전개' y 18~38)이
 * 이미 그렇게 정해 두었고, 여기서도 그것을 따른다. LANES의 s=-1('위')이 곧 좌측이다.
 */
export const LANE_WEIGHTS: Record<Instructions['attackFocus'], readonly number[]> = {
  // 균형 — 균일. 개편 전(`hash % LANE_COUNT`)과 **분포가 같다**(어느 레인도 편애하지
  // 않는다). 같은 이벤트가 가는 레인 번호는 추첨 방식이 바뀌면서 재배치됐지만, 레인은
  // 좌우·폭 변형일 뿐이라 화면의 다양성은 그대로다.
  balanced: [1, 1, 1, 1, 1, 1],
  //         우wide 좌wide 우mid 좌mid 우중앙 좌중앙
  left: [10, 45, 7, 25, 5, 8],
  right: [45, 10, 25, 7, 8, 5],
  // 중앙 — 압축 레인(k=0.35)을 60%로. 좌우는 대칭이다.
  center: [8, 8, 12, 12, 30, 30],
}

/**
 * 분포에서 레인 하나를 뽑는다. `u`는 0~99의 결정론 해시값(choreography가 준다).
 *
 * @param mirror 공격 팀이 **원정**이면 true. 안무는 x만 미러하고 y는 그대로 두므로
 *   (choreography.buildSequence의 `fx`), 진행 방향이 뒤집힌 원정 팀에게는 같은 y가 반대쪽
 *   측면이 된다. 레인 쌍(0↔1, 2↔3, 4↔5)이 정확한 상하 미러이므로 인덱스 하위 1비트만
 *   뒤집으면 된다.
 *
 * ★ **가중치를 뒤집지 않고 결과 인덱스를 뒤집는다.** 두 방식은 같아 보이지만 다르다:
 *   누적 합 탐색은 열 순서에 의존하므로, 가중치를 섞으면 같은 u가 짝이 아닌 레인으로
 *   간다. 그러면 홈과 원정이 정확한 y 거울이 아니게 되고, 슛 거리 역산(`finishStations`의
 *   gz·gx)이 갈려 **x 미러 계약(홈 x + 원정 x = 100)이 깨진다.** 결과를 뒤집으면
 *   |y−50| 열이 완전히 같아 x가 그대로 미러다.
 */
export function pickLane(focus: Instructions['attackFocus'], u: number, mirror: boolean): number {
  const w = LANE_WEIGHTS[focus] ?? LANE_WEIGHTS.balanced
  let sum = 0
  for (let i = 0; i < LANE_COUNT; i++) sum += w[i]
  const r = mod(u, 100) * (sum / 100)
  let acc = 0
  let lane = LANE_COUNT - 1
  for (let i = 0; i < LANE_COUNT; i++) {
    acc += w[i]
    if (r < acc) { lane = i; break }
  }
  return mirror ? lane ^ 1 : lane
}

/** 저술 y(아래 전개 기준) → 레인 y. */
function laneY(y: number, lane: number): number {
  const L = LANES[((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT]
  return clamp(50 + (y - 50) * L.s * L.k)
}

/**
 * 공격 방향이 빌드업 전체를 옆으로 미는 폭(0~100 프레임). 9 ≈ **6.1 m**.
 *
 * 왜 레인 기울이기만으로는 부족한가(실측): 레인은 저술 y를 **압축만** 한다(k ≤ 1).
 * 그런데 `central`·`through`·`outside` 계열은 애초에 y 34~68에 저술돼 있어서, 레인을
 * 아무리 넓은 쪽으로 뽑아도 볼 평균 y가 중앙을 크게 벗어나지 않는다. 레인 가중치만
 * 넣었을 때 실측은 좌측 지시에서 "왼쪽 전개" 33.5% / "오른쪽 전개" 8.0%였다 —
 * 방향은 맞지만 **대부분의 장면이 여전히 중앙**이었다.
 *
 * 실제 축구의 `공격 방향`은 폭을 넓히는 지시가 아니라 팀 전체의 **좌우 무게중심을 옮기는**
 * 지시다. 그래서 레인(폭)과 별개로 평행 이동을 준다. 이동은 **빌드업 스테이션에만**
 * 적용한다 — 마무리는 문전에서 일어나야 하고, `finishStations`가 이미 슈팅 지점 y를
 * 38~62로, 골문 통과점을 골대 안으로 클램프한다. 결과적으로 "왼쪽에서 전개해 문전에서
 * 마무리"라는 정상적인 그림이 된다.
 *
 * 좌우 미러 계약은 깨지지 않는다: 원정은 레인도(`pickLane`의 mirror) 이동도 함께
 * 뒤집히므로 저술 프레임에서 정확한 y 미러가 되고, |y−50|이 같으면 `finishStations`의
 * 슛 거리 역산(gz·gx)이 같아 x가 그대로 미러다.
 */
export const FOCUS_SHIFT = 9

/** 빌드업 스테이션을 공격 방향으로 민다. dir: -1 좌 / 0 없음 / +1 우. */
function mapFocus(stations: Station[], dir: -1 | 0 | 1): Station[] {
  if (dir === 0) return stations
  const shift = (y: number) => clamp(y + dir * FOCUS_SHIFT, 3, 97)
  return stations.map(s => ({
    ...s,
    movers: s.movers.map(([x, y]) => [x, shift(y)] as [number, number]),
    ...(s.ball ? { ball: [s.ball[0], shift(s.ball[1])] as [number, number] } : {}),
  }))
}

/** 스테이션에 레인 변형을 적용한다. **시간 역산 전에** 해야 거리가 레인을 반영한다. */
function mapLane(stations: Station[], lane: number): Station[] {
  return stations.map(s => ({
    ...s,
    movers: s.movers.map(([x, y]) => [clamp(x), laneY(y, lane)] as [number, number]),
    ...(s.ball ? { ball: [clamp(s.ball[0]), laneY(s.ball[1], lane)] as [number, number] } : {}),
  }))
}

/**
 * 오프사이드 상한을 빌드업 스테이션에 건다 — **슬롯 0(마무리 배역)의 x만** 자른다.
 *
 * 왜 슬롯 0만인가: 슬롯 1·2는 빌드업 내내 x 42~68에 있어 어떤 라인에도 걸리지 않고, 둘 중
 * 하나는 늘 공을 갖고 있다(공을 가진 선수는 정의상 오프사이드가 아니다). 화면에서 "혼자
 * 라인을 넘어 서 있는" 배역은 언제나 슬롯 0이다.
 *
 * 상한 = max(뒤에서 두 번째 수비수, **그 순간 공이 있는 x**, 하프라인 50). 세 항 모두
 * 경기 규칙 11조 그대로다. 자르고 나면 슛 지점은 손댈 필요가 없다 — {@link MAX_RUN_IN_M}
 * 클램프가 "슈터가 배달 한 구간에 갈 수 있는 곳"까지만 슛을 허용하므로, 출발점을 온사이드로
 * 내리면 도착점도 자동으로 따라 내려온다. 즉 **라인을 올린 상대는 슛을 밖으로 밀어낸다** —
 * 실제 하이라인의 효과가 그대로 화면에 나온다.
 *
 * y는 건드리지 않는다. 오프사이드는 전진 성분만의 문제이고, y를 당기면 레인 미러 계약이
 * 깨진다.
 */
function onside(stations: Station[], off?: OffsideLimit): Station[] {
  if (!off) return stations
  return stations.map(s => {
    // 공은 캐리어의 **발 앞** FOOT_OFFSET_M에 놓이므로(ballAt), 되돌리는 패스에서는
    // 캐리어보다 그만큼 뒤에 있을 수 있다. 상한은 그 최악을 가정한다(보수적).
    const footBack = (FOOT_OFFSET_M / PITCH_W) * 100
    const ballX = (s.carrier >= 0 ? s.movers[s.carrier][0] : (s.ball?.[0] ?? 0)) - footBack
    const cap = Math.max(off.secondLastX, ballX, 50)
    const [sx, sy] = s.movers[0]
    if (sx <= cap) return s
    const movers = s.movers.map((m, i) => (i === 0 ? [cap, sy] : m)) as [number, number][]
    return { ...s, movers }
  })
}

/** 이 스테이션에서 공이 놓이는 자리 — 캐리어의 발 앞 FOOT_OFFSET_M. */
function ballAt(s: Station, next: Station | undefined): [number, number] {
  if (s.carrier < 0) return s.ball ?? [50, 50]
  const [mx, my] = s.movers[s.carrier]
  const aim: [number, number] = next
    ? next.carrier >= 0
      ? next.movers[next.carrier]
      : (next.ball ?? [mx + 6, my])
    : [mx + 6, my]
  const dx = ((aim[0] - mx) / 100) * PITCH_W
  const dy = ((aim[1] - my) / 100) * PITCH_H
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return [clamp(mx), clamp(my)]
  return [
    clamp(mx + ((dx / len) * FOOT_OFFSET_M * 100) / PITCH_W),
    clamp(my + ((dy / len) * FOOT_OFFSET_M * 100) / PITCH_H),
  ]
}

/**
 * 스테이션 배열 → 키프레임 배열. **여기가 페이싱의 정본이다.**
 *
 * 각 구간의 소요 = max(볼 거리 / 의도 속도, 캐리어 주행 거리 / CARRIER_RUN_SPEED).
 * 두 번째 항이 "1x면 진짜 축구처럼"의 하한을 만든다 — 공을 받을 사람이 도착하지 못하는
 * 시간표는 아무리 물리가 정확해도 공이 혼자 가는 그림이 된다.
 */
function timeline(stations: Station[], dwellMs: number): ScenePoint[] {
  const balls = stations.map((s, i) => ballAt(s, stations[i + 1]))
  const out: ScenePoint[] = []
  let ms = 0
  for (let k = 0; k < stations.length; k++) {
    const s = stations[k]
    const isLast = k === stations.length - 1
    // 도착 → (정지) → 출발. 첫 스테이션·마지막 스테이션·원터치는 정지 키프레임이 없다.
    if (k > 0 && !isLast && !s.oneTouch) {
      // 도착 키프레임: 캐리어는 공 위치, 나머지는 목표의 88%까지만 와 있다.
      const arriveMovers = s.movers.map((m, i) =>
        i === s.carrier
          ? ([...m] as [number, number])
          : ([lerp(stations[k - 1].movers[i][0], m[0], ARRIVE_BLEND),
              lerp(stations[k - 1].movers[i][1], m[1], ARRIVE_BLEND)] as [number, number]),
      )
      out.push({ t: ms / dwellMs, ball: balls[k], movers: arriveMovers, arc: 'ground', carrier: s.carrier })
      ms += TOUCH_MS
    }
    const dribble = !isLast && s.carrier >= 0 && stations[k + 1].carrier === s.carrier
    out.push({
      t: ms / dwellMs,
      ball: balls[k],
      movers: s.movers.map(mv => [...mv] as [number, number]),
      // 같은 선수가 계속 소유하면 드리블이다 — 드리블하는 공은 뜨지 않는다.
      ...(dribble ? { arc: 'ground' as BallArc } : s.arc ? { arc: s.arc } : {}),
      ...(s.carrier >= 0 ? { carrier: s.carrier } : {}),
      ...(s.endY != null ? { endY: s.endY } : {}),
      ...(s.contact ? { contact: true as const } : {}),
    })
    if (isLast) break
    const arc: BallArc = dribble ? 'ground' : (s.arc ?? 'pass')
    const ballMs = (metres(balls[k], balls[k + 1]) / SEGMENT_SPEED[arc]) * 1000
    const nc = stations[k + 1].carrier
    // 캐리어(다음에 공을 받는 사람)는 반드시 제시간에 도착해야 하고, 지원 무버도
    // 속도 클램프를 넘기면 안 된다 — 둘 다 하한으로 넣는다.
    let runMs = nc >= 0 ? (metres(s.movers[nc], stations[k + 1].movers[nc]) / CARRIER_RUN_SPEED) * 1000 : 0
    for (let i = 0; i < s.movers.length; i++) {
      if (i === nc) continue
      runMs = Math.max(runMs, (metres(s.movers[i], stations[k + 1].movers[i]) / SUPPORT_RUN_SPEED) * 1000)
    }
    ms += Math.max(ballMs, runMs, MIN_SEGMENT_MS)
  }
  return out
}

/** 장면 한 벌 — 좌표는 아직 home-프레임(away 미러는 호출자가 한다). */
export interface Scene {
  points: ScenePoint[]
  /** 역할 슬롯 원형 좌표(레인 적용 완료). 실제 선수 배정에 쓴다. */
  roles: [number, number][]
  /** 반복 측정·디버그용 키. 예: `wing.a/goal.c/L1`. */
  key: string
  /** 이 장면이 실제로 소비하는 시간(ms). dwell 대비 남는 시간이 여운·세리머니다. */
  durationMs: number
}

/** 이 이벤트에 붙일 마무리(없으면 세트피스·반칙 전용 장면). */
export type SceneFinish = FinishId | 'corner' | 'foul'

/** 장면 변형 축 — 레인 말고 나머지. 생략하면 기준 변형(최빈 계열 / a / a)이다. */
export interface SceneVariants {
  /**
   * 빌드업 **계열** 추첨값 0~99(결정론 해시). {@link BUILDUP_WEIGHTS}가 이 값을 계열로
   * 바꾼다. 미지정이면 그 전술의 최빈 계열({@link BUILDUP_BY_PATTERN})을 쓴다 —
   * 기존 호출부·테스트가 계열을 고정해 검사할 수 있도록 남긴 문이다.
   */
  family?: number
  /** 빌드업 실행 변형 0~1. */
  buildup?: number
  /** 마무리 변형(득점 루트) 0~4. */
  finish?: number
  /**
   * 공격 방향의 평행 이동 부호 — **저술 프레임 기준** -1 좌 / 0 없음 / +1 우
   * ({@link FOCUS_SHIFT}). 해시 변형이 아니라 유저 지시에서 곧바로 온다
   * (`choreography.focusDirFor`). 원정은 호출부가 뒤집어서 넘긴다.
   */
  focusDir?: -1 | 0 | 1
}

/**
 * 오프사이드 상한 — 이 장면을 붙일 때 **뒤에서 두 번째 수비수**가 서 있는 x(공격 프레임 0~100).
 *
 * ★ 2026-08-01 신설(5라운드 피드백 ②). 사용자 캡처: 공격수가 박스 안에서 공을 받는데 최종
 *   수비는 하프라인 근처였다 — GK 말고는 아무도 뒤에 없는 명백한 오프사이드다. 원인은
 *   저술이 수비 라인을 **전혀 몰랐다**는 것이다. 슈터(슬롯 0)는 계열과 무관하게 x 65 → 73 →
 *   80으로 고정 침투했고, 상대가 라인을 아무리 올려도 그 값은 그대로였다.
 *
 * 규칙(경기 규칙 11조 그대로): 패스가 **출발하는 순간** 공격수가 뒤에서 두 번째 수비수보다
 * 앞서 있으면 오프사이드다. 단 **공보다 뒤에 있으면** 언제나 온사이드다 — 그래서 바이라인
 * 크로스·컷백은 원리적으로 오프사이드가 될 수 없고, 여기서도 볼 x가 상한을 밀어 올린다.
 * 하프라인 뒤(자기 진영)도 오프사이드가 아니므로 하한은 50이다.
 *
 * 유저가 라인을 바꾸면 이 값이 따라 움직인다 — 상수로 박지 않는다(호출부가 매번 계산해
 * 넘긴다: choreography.offsideLineFor → shape.tacticalCoords).
 */
export interface OffsideLimit {
  /** 뒤에서 두 번째 수비수의 x(공격 프레임). 미지정이면 제한 없음(레거시·세트피스). */
  secondLastX: number
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
  offside?: OffsideLimit,
): Scene {
  if (finish === 'corner') {
    // 코너는 좌/우만 의미가 있다(중앙 압축 레인은 코너 깃발을 중앙으로 끌어와 말이 안 된다).
    const l = lane % 2
    const points = timeline(mapLane(CORNER_STATIONS, l), SCENE_DWELL_MS.corner)
    return {
      points,
      roles: CORNER_ROLES.map(([x, y]) => [x, laneY(y, l)] as [number, number]),
      key: `corner/L${l}`,
      durationMs: points[points.length - 1].t * SCENE_DWELL_MS.corner,
    }
  }
  if (finish === 'foul') {
    const l = lane % 2
    const points = timeline(mapLane(FOUL_STATIONS, l), SCENE_DWELL_MS.foul)
    return {
      points,
      roles: FOUL_ROLES.map(([x, y]) => [x, laneY(y, l)] as [number, number]),
      key: `foul/L${l}`,
      durationMs: points[points.length - 1].t * SCENE_DWELL_MS.foul,
    }
  }
  const family = BUILDUPS[
    variants.family != null ? pickBuildup(pattern, variants.family) : BUILDUP_BY_PATTERN[pattern]
  ]
  const bv = family.variants[mod(variants.buildup ?? 0, BUILDUP_VARIANT_COUNT)]
  const fv = mod(variants.finish ?? 0, FINISH_VARIANT_COUNT)
  // 찬스는 "마무리 없이 박스까지"다 — 빌드업을 한 스테이션 줄여 dwell 안에 들어오게 한다.
  // 드리블 돌파도 같은 이유로 한 스테이션을 줄인다: 뒤에 드리블 터치 2개가 붙기 때문이다.
  const trim = finish === 'chance' || !!FINISH_VARIANTS[fv].solo
  const fd = variants.focusDir ?? 0
  const build = onside(mapFocus(mapLane(trim ? bv.stations.slice(1) : bv.stations, lane), fd), offside)
  const last = build[build.length - 1]
  const launch = last.movers[last.carrier] as [number, number]
  const { stations: fin, deliverArc } =
    finishStations(finish, last, launch, fv, lane, family.id, mod(variants.buildup ?? 0, BUILDUP_VARIANT_COUNT))
  // ★ 배달 궤적은 **빌드업 마지막 스테이션에서 출발하는 구간**의 것이다(오프바이원 수정).
  const stations: Station[] = [...build.slice(0, -1), { ...last, arc: deliverArc }, ...fin]
  const dwell = SCENE_DWELL_MS[finish]
  const points = timeline(stations, dwell)
  return {
    points,
    // 역할 원형도 함께 민다 — 왼쪽에서 전개하는 장면의 배역은 왼쪽 선수가 맡아야 한다.
    roles: bv.roles.map(([x, y]) => [x, clamp(laneY(y, lane) + fd * FOCUS_SHIFT, 3, 97)] as [number, number]),
    key: `${family.id}.${bv.vid}/${finish}.${FINISH_VARIANTS[fv].vid}/L${mod(lane, LANE_COUNT)}`,
    durationMs: points[points.length - 1].t * dwell,
  }
}

/** 음수·초과 인덱스를 접는다(해시 % 는 양수지만 호출부가 직접 넘길 수도 있다). */
const mod = (v: number, n: number) => ((Math.trunc(v) % n) + n) % n

/**
 * 빌드업 계열 라벨(분석보드·디버그 HUD).
 *
 * ★ 2026-08-01: 전술이 계열을 고정하지 않게 되면서 "이 전술 = 이 그림"이 아니라
 *   "이 전술 = 이 그림이 n%"가 됐다. 라벨도 그렇게 말해야 화면과 어긋나지 않는다.
 */
export function buildupLabel(pattern: AttackPattern): string {
  const id = BUILDUP_BY_PATTERN[pattern]
  return `${BUILDUPS[id].label} ${BUILDUP_WEIGHTS[pattern][id]}%`
}

/**
 * 라이브러리 총 조합 수 — (빌드업 계열 × 실행 변형) × (마무리 × 마무리 변형) × 레인 + 세트피스.
 *
 * ★ `reachablePerMatch`는 **한 경기에서 도달 가능한 칸 수**다. 2026-08-01부터 attackPattern은
 *   계열을 고정하지 않고 기울이기만 하므로 4계열 전부가 도달 가능하다(예전에는 팀당 1계열).
 *   하이라이트로 뽑히는 결과는 여전히 3종(goal·save·miss)이므로
 *   팀당 `4 × 2 × 3 × 5 × 6 = 720`, 양 팀 1440이다.
 */
export function sceneLibrarySize(): { open: number; setPiece: number; total: number; reachablePerMatch: number } {
  const finishes: FinishId[] = ['goal', 'save', 'miss', 'shot', 'chance']
  const open = Object.keys(BUILDUPS).length * BUILDUP_VARIANT_COUNT * finishes.length * FINISH_VARIANT_COUNT * LANE_COUNT
  const setPiece = 2 + 2 // corner 좌/우 + foul 위/아래
  const reachablePerMatch =
    2 * Object.keys(BUILDUPS).length * BUILDUP_VARIANT_COUNT * 3 * FINISH_VARIANT_COUNT * LANE_COUNT
  return { open, setPiece, total: open + setPiece, reachablePerMatch }
}
