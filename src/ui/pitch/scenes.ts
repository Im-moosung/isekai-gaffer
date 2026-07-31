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
import type { AttackPattern } from '../../engine/types'
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
 */
export const SCENE_DWELL_MS: Record<SceneFinish, number> = {
  goal: 8600,
  save: 8400,
  shot: 8400,
  miss: 8400,
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
export const BUILDUP_BY_PATTERN: Record<AttackPattern, BuildupId> = {
  balanced: 'central',
  cross: 'wing',
  through: 'through',
  longshot: 'outside',
}

/**
 * 빌드업 4계열 × 실행 변형 2종. 전부 3스테이션(= 볼 터치 3번)이다.
 *
 * ★ 저술 규칙(개편 후):
 *  1. 슬롯 0은 슈터다. 빌드업 내내 x 60 → 68 → 76으로 **박스로 침투**한다(공은 안 준다).
 *     마무리에서 그가 슈팅 지점까지 달릴 거리를 6~16 m 안에 두기 위한 배치다.
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
          { movers: [[61, 46], [42, 60], [54, 34]], carrier: 1, arc: 'pass' },
          { movers: [[69, 48], [50, 56], [59, 37]], carrier: 2, arc: 'ground' },
          { movers: [[76, 50], [55, 55], [64, 41]], carrier: 1 },
        ],
      },
      {
        vid: 'b',
        label: '중앙 원투 벽패스',
        roles: [[62, 42], [80, 52], [70, 70]],
        stations: [
          { movers: [[61, 54], [44, 44], [50, 60]], carrier: 1, arc: 'pass' },
          // 벽패스 리턴은 지면·원터치 — 원터치로 되돌리는 공은 뜨지도, 멈추지도 않는다.
          { movers: [[69, 52], [50, 46], [55, 58]], carrier: 2, arc: 'ground', oneTouch: true },
          { movers: [[76, 51], [54, 48], [59, 56]], carrier: 1 },
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
          { movers: [[62, 52], [62, 76], [52, 58]], carrier: 2, arc: 'pass' },
          // 터치라인 드리블 — 캐리어가 그대로 유지되므로 시간 역산이 선수 속도로 눌러 준다.
          { movers: [[69, 54], [68, 80], [58, 62]], carrier: 1, arc: 'ground' },
          { movers: [[76, 56], [76, 86], [64, 60]], carrier: 1 },
        ],
        roles: [[74, 84], [80, 50], [72, 18]],
      },
      {
        vid: 'b',
        label: '풀백 오버래핑',
        roles: [[76, 80], [80, 50], [70, 22]],
        stations: [
          { movers: [[62, 54], [58, 72], [54, 62]], carrier: 2, arc: 'ground' },
          // 안으로 접었다가 다시 측면으로 — 오버래핑의 그림.
          { movers: [[69, 55], [66, 80], [60, 64]], carrier: 1, arc: 'pass' },
          { movers: [[76, 56], [76, 88], [66, 62]], carrier: 1 },
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
          { movers: [[60, 56], [44, 52], [56, 66]], carrier: 1, arc: 'pass' },
          // 스루패스는 뜨지 않는다 — 뜨면 수비가 따라붙는다.
          { movers: [[68, 57], [50, 56], [62, 70]], carrier: 2, arc: 'ground' },
          { movers: [[76, 58], [56, 58], [68, 72]], carrier: 2 },
        ],
      },
      {
        vid: 'b',
        label: '내려받아 원터치 스루',
        roles: [[66, 40], [80, 50], [72, 74]],
        stations: [
          { movers: [[60, 44], [46, 62], [56, 36]], carrier: 1, arc: 'pass' },
          { movers: [[68, 45], [52, 58], [62, 38]], carrier: 2, arc: 'ground', oneTouch: true },
          { movers: [[76, 47], [57, 56], [68, 40]], carrier: 2 },
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
  /** launch → 슈팅 지점 전진율(0.55가 기존 그림). */
  adv: number
  /** 슈팅 지점 y의 전개 폭 유지 계수. 음수면 **반대쪽**에서 잡는다(컷백). */
  w: number
  /** 결과 지점 좌우 — 0=기존(수렴), +1=니어포스트, -1=파포스트. */
  post: -1 | 0 | 1
  /** 배달 구간을 지면으로 강제하는가(컷백은 뜨지 않는다). */
  ground: boolean
  /** 배달을 원터치로 마무리하는가(컨트롤 정지 없음). */
  oneTouch: boolean
}

const FINISH_VARIANTS: FinishVariant[] = [
  // a — 정면. 받아서 한 번 잡고 때린다.
  { vid: 'a', label: '정면 마무리', adv: 0.55, w: 0.35, post: 0, ground: false, oneTouch: false },
  // b — 문전 원터치. 한 발 더 들어가 니어포스트로 밀어 넣는다(트래핑 없음).
  { vid: 'b', label: '문전 원터치', adv: 0.72, w: 0.15, post: 1, ground: false, oneTouch: true },
  // c — 컷백. 엔드라인 쪽에서 되돌린 공을 반대쪽에서 때린다(배달은 지면, 파포스트).
  // ★ w를 -0.45에서 -0.2로 줄였다: 측면 깊은 곳(y≈88)에서 -0.45를 곱하면 슈팅 지점이
  //   반대쪽 하프스페이스(y≈33)로 날아가 배달 거리가 38 m가 됐다. 컷백은 바이라인에서
  //   페널티 스폿 쪽으로 **되빼는** 공이지 피치를 가로지르는 전환 패스가 아니다.
  { vid: 'c', label: '컷백 되돌림', adv: 0.3, w: -0.2, post: -1, ground: true, oneTouch: false },
]
export const FINISH_VARIANT_COUNT = FINISH_VARIANTS.length

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
/** 크로스바 높이(m). */
const CROSSBAR_M = 2.44

/** 미터 단위 좌우 오프셋 → 0~100 y 좌표. */
const offsetY = (m: number) => 50 + (m / PITCH_H) * 100

/**
 * 슈터가 배달 한 구간 동안 달릴 수 있는 최대 전진(0~100 x 단위).
 * 15 units ≈ 15.8 m — 1.6 s 배달에서 9.9 m/s가 되므로 실질 상한이다(그 이상은
 * 시간 역산이 구간을 늘려 배달이 슬로모션이 된다).
 */
const MAX_RUN_IN = 15

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
  /** 레인 인덱스 — 미스 종점의 **크기**(분위수)를 고르는 데 쓴다. */
  lane: number,
): { stations: Station[]; deliverArc: BallArc } {
  const V = FINISH_VARIANTS[variant]
  const [lx, ly] = launch
  // 슈팅 지점 — launch에서 골문 쪽으로 전진. 하한 74는 중거리 계열이 "중거리"로 남게 하고,
  // 상한 lx+MAX_RUN_IN은 슈터가 배달 한 구간에 달려갈 수 있는 거리로 물리에서 나온다.
  const dx = clamp(lx + (95 - lx) * V.adv, 74, Math.min(92, lx + MAX_RUN_IN))
  // 슈팅 지점 y. w>0이면 전개 쪽을 유지한 채 골문으로 수렴, w<0이면 반대쪽(컷백).
  // 슈팅 지점은 박스 폭 안에 머문다 — 밖으로 나가면 "마무리"가 아니라 전환 패스가 된다.
  const my = clamp(50 + (ly - 50) * V.w, 38, 62)
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
  const deliverArc: BallArc = Math.abs(ly - 50) > 25 && lx >= 70
    ? 'cross'
    : V.ground
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
  /** 골문 안 착지 y — post가 0이면 슈팅 지점에서 수렴, 아니면 니어/파포스트. */
  const mouth = (spread: number, lo: number, hi: number) =>
    V.post === 0 ? clamp(50 + (my - 50) * spread, lo, hi) : clamp(50 + V.post * sideSign * (hi - 50) * 0.85, lo, hi)

  /** 슈팅 스테이션 — 캐리어는 반드시 슬롯 0(엔진이 정한 주인공)이다. */
  const shot: Station = { movers: boxMovers, carrier: 0, arc: 'shot', oneTouch: V.oneTouch }
  const end = (ball: [number, number], endY?: number): Station =>
    ({ movers: netMovers, carrier: -1, ball, ...(endY != null ? { endY } : {}) })
  /** 골라인에서 m 미터 앞의 x(0~100). 세이브 접촉점을 미터로 저술하기 위한 환산. */
  const beforeLine = (m: number) => clamp(100 - (m / PITCH_W) * 100)

  switch (finish) {
    case 'goal':
      return { stations: [shot, end([99, mouth(0.35, 44, 56)])], deliverArc }
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
      return {
        stations: [shot, { ...end([beforeLine(depth), mouth(0.45, 43, 57)]), contact: true }],
        deliverArc,
      }
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
      return { stations: [shot, end([99, clamp(y)], over ? CROSSBAR_M + h : MISS_LOW_Y)], deliverArc }
    }
    case 'shot':
      // 블록·굴절 — 골문 바로 앞에서 멈춘다(세이브보다 얕고 미스처럼 벗어나지 않는다).
      return {
        stations: [shot, end([V.post === 1 ? 96 : V.post === -1 ? 94 : 95, mouth(0.3, 45, 55)])],
        deliverArc,
      }
    case 'chance':
      // 마무리 없이 박스까지만 — 골문에 닿지 않는다.
      return { stations: [{ movers: boxMovers, carrier: 0 }], deliverArc }
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

/** 저술 y(아래 전개 기준) → 레인 y. */
function laneY(y: number, lane: number): number {
  const L = LANES[((lane % LANE_COUNT) + LANE_COUNT) % LANE_COUNT]
  return clamp(50 + (y - 50) * L.s * L.k)
}

/** 스테이션에 레인 변형을 적용한다. **시간 역산 전에** 해야 거리가 레인을 반영한다. */
function mapLane(stations: Station[], lane: number): Station[] {
  return stations.map(s => ({
    ...s,
    movers: s.movers.map(([x, y]) => [clamp(x), laneY(y, lane)] as [number, number]),
    ...(s.ball ? { ball: [clamp(s.ball[0]), laneY(s.ball[1], lane)] as [number, number] } : {}),
  }))
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
  const family = BUILDUPS[BUILDUP_BY_PATTERN[pattern]]
  const bv = family.variants[mod(variants.buildup ?? 0, BUILDUP_VARIANT_COUNT)]
  const fv = mod(variants.finish ?? 0, FINISH_VARIANT_COUNT)
  // 찬스는 "마무리 없이 박스까지"다 — 빌드업을 한 스테이션 줄여 dwell 안에 들어오게 한다.
  const build = mapLane(finish === 'chance' ? bv.stations.slice(1) : bv.stations, lane)
  const last = build[build.length - 1]
  const launch = last.movers[last.carrier] as [number, number]
  const { stations: fin, deliverArc } = finishStations(finish, last, launch, fv, lane)
  // ★ 배달 궤적은 **빌드업 마지막 스테이션에서 출발하는 구간**의 것이다(오프바이원 수정).
  const stations: Station[] = [...build.slice(0, -1), { ...last, arc: deliverArc }, ...fin]
  const dwell = SCENE_DWELL_MS[finish]
  const points = timeline(stations, dwell)
  return {
    points,
    roles: bv.roles.map(([x, y]) => [x, laneY(y, lane)] as [number, number]),
    key: `${family.id}.${bv.vid}/${finish}.${FINISH_VARIANTS[fv].vid}/L${mod(lane, LANE_COUNT)}`,
    durationMs: points[points.length - 1].t * dwell,
  }
}

/** 음수·초과 인덱스를 접는다(해시 % 는 양수지만 호출부가 직접 넘길 수도 있다). */
const mod = (v: number, n: number) => ((Math.trunc(v) % n) + n) % n

/** 빌드업 계열 라벨(스크린샷·디버그 HUD). 실행 변형이 달라도 계열 라벨은 하나다. */
export function buildupLabel(pattern: AttackPattern): string {
  return BUILDUPS[BUILDUP_BY_PATTERN[pattern]].label
}

/**
 * 라이브러리 총 조합 수 — (빌드업 계열 × 실행 변형) × (마무리 × 마무리 변형) × 레인 + 세트피스.
 *
 * ★ `total`은 라이브러리 크기일 뿐 **한 경기에서 도달 가능한 수가 아니다.** 경기 안에서는
 *   attackPattern이 계열을 고정하고(팀당 1계열) 하이라이트로 뽑히는 결과도 3종(goal·save·miss)
 *   뿐이라, 실제 칸 수는 팀당 `2 × 3 × 3 × 6 = 108`, 양 팀 216이다.
 */
export function sceneLibrarySize(): { open: number; setPiece: number; total: number; reachablePerMatch: number } {
  const finishes: FinishId[] = ['goal', 'save', 'miss', 'shot', 'chance']
  const open = Object.keys(BUILDUPS).length * BUILDUP_VARIANT_COUNT * finishes.length * FINISH_VARIANT_COUNT * LANE_COUNT
  const setPiece = 2 + 2 // corner 좌/우 + foul 위/아래
  const reachablePerMatch = 2 * BUILDUP_VARIANT_COUNT * 3 * FINISH_VARIANT_COUNT * LANE_COUNT
  return { open, setPiece, total: open + setPiece, reachablePerMatch }
}
