// src/ui/pitch/AnalysisLayer.tsx
// 2D 작전판의 전술 시각화 레이어 — 하이라이트 **사이** 구간에서 화면이 하는 일.
//
// 왜 2D인가: 3D는 수비 라인을 "선"으로, 압박을 "존"으로, 패스 루트를 "화살표"로 그릴 수
// 없다. 3D가 못 하는 걸 여기서 한다.
//
// ★ 여기 그려지는 모든 선은 **유저가 만진 숫자**다. 라인을 내리면 수비 라인이 실제로
//   내려가고, 압박을 올리면 존이 넓어지고, 공격 패턴을 바꾸면 화살표가 바뀐다.
//
// ★ 색·형태 규약(2026-07 재배정 — 감사 A-1: 빨강=우리선수∧패스레인, 라임=수비라인∧CTA라
//   범례로도 설명이 안 됐다):
//     · **색 = 누구**. 팀 색(우리 빨강 / 상대 파랑)은 그 팀 이야기에만 쓴다.
//     · **형태 = 무엇**. 실선=현재 상태(수비 라인), 파선=의도(침투·압박 경계),
//       점선=참고 경계(공격 집중 밴드), 화살촉=방향 있는 경로.
//     · **계획은 흰색**. 패스 레인은 팀 소속이 아니라 감독의 계획이다(방송 텔레스트레이션 관례).
//     · 라임(--bc-accent)은 여기서 쓰지 않는다 — 그 색은 라이브 UI 전용이다.
import type { AttackPattern, Instructions, MatchState, Mentality, SideState } from '../../engine/types'
import { lineDepth, pressReach } from './shape'
import type { Coord } from './formations'
import type { LabelReq } from './labels'

// PitchView와 동일한 viewBox(105×68) 좌표계.
const W = 105
const H = 68
const sx = (x: number) => (x / 100) * W
const sy = (y: number) => (y / 100) * H

// 라인·압박 매핑의 정본은 shape.ts다 — **선(여기)과 도트(PitchView)가 같은 함수에서 나와야**
// 마커와 선수가 어긋나지 않는다. 기존 import 경로 호환을 위해 여기서 재수출한다.
export { lineDepth, pressReach }

/** 라이브 좌표에서 뽑은 양 팀 수비 라인 x(절대 프레임 0~100). PitchView가 계산해 넘긴다. */
export interface AnalysisGeom {
  homeLineX: number
  awayLineX: number
  /** 우리 팀 무게중심(절대 프레임 0~100). **전술 좌표 10명(GK 제외)의 평균**이고
   *  PitchView가 계산해 넘긴다 — 여기서 좌표를 다시 만들지 않는다(마커-도트 일치 계약). */
  homeGravity: Coord
}

// ── 변경 강조 (2026-08-01) ─────────────────────────────────────────
// 요구: "라인을 올리거나 공격방향을 바꾸면 **내가 어떤 영역에서 무엇을 바꾸는지**가
// 바로 보이게." 값이 바뀌어 도형이 이동하는 것만으로는 *무엇이* 바뀌었는지 안 읽힌다
// — 22개 도트가 늘 미세하게 움직이는 화면에서 선 하나의 이동은 잡음에 묻힌다.
//
// ★ 과하지 않게 만드는 세 가지 결정(사용자 지시: "슬라이더 드래그 중 화면이 요동치면 안 된다"):
//  1. **새 상시 모션을 만들지 않는다.** 도형의 이동 자체에는 transition이 없다
//     (pitch.css의 `--analysis ... { transition: none }`). 작전판은 이미 20 Hz로
//     좌표를 다시 그리므로 값 변화는 그 프레임에 그냥 도착한다.
//  2. 강조는 **한 번만, 축이 멈춘 뒤에** 뜬다. 호출자가 드래그가 끝난 뒤에만
//     highlight를 올린다(TacticsBoard의 정착 지연). 드래그 중에는 아무 펄스도 없다.
//  3. 강조 수단은 **불투명도·굵기 한 단계**뿐이다. 크기·위치·색을 건드리지 않으므로
//     "무엇이 바뀌었나"만 말하고 형태 규약(실선=현재/파선=의도)을 흔들지 않는다.
export type AnalysisAxis = 'lineHeight' | 'pressing' | 'tempo' | 'attackFocus' | 'attackPattern' | 'mentality'

// ── 팀 무게중심 마커 (2026-08-02) ──────────────────────────────────
// 요구(사용자 원문): "사용자가 **멘탈리티를 건드릴 때 눈으로 알 수만 있으면** 돼."
// 멘탈리티는 감독이 가장 자주 만지는 손잡이인데 보드에 도형이 하나도 없었다 — 문장으로만
// 말했다. 다섯 축(라인·압박·템포·집중·패턴)은 전부 그림이 있는데 이것만 없었다.
//
// ★ 왜 선수 좌표에 멘탈리티를 넣지 않았나(shape.ts를 건드리지 않은 이유):
//   shape.ts에는 테스트로 고정된 계약이 있다 — "백라인 그룹 평균 x == lineDepth(lineHeight),
//   정확히 같다". 도트와 수비 라인 마커가 어긋나지 않게 하는 계약이고, 그 파일이 존재하는
//   이유가 과거 사고("그림이 거짓말을 했다")다. 멘탈리티를 좌표 생성에 끼워 넣으면 라인
//   슬라이더가 백라인의 유일한 정본이라는 전제가 깨진다. 그래서 무게중심은 **파생 표시**다:
//   이미 만들어진 전술 좌표의 평균(PitchView.teamGravity)을 받아 여기서 그리기만 한다.
//
// ★ 그래서 이 마커는 **실선(현재)이 아니라 파선(의도)**이다. 엔진의 멘탈리티는 좌표가
//   아니라 확률(찬스 빈도·질·역습 취약성)을 움직인다(engine/tactics.ts MENTALITY_FX).
//   "지금 선수 평균이 여기 있다"고 실선으로 말하면 그거야말로 거짓말이다. 파선 마름모는
//   형태 규약 그대로 **"이 태세로 팀 무게중심을 여기까지 밀겠다"는 의도**를 뜻한다.
//   기준점(전술 좌표 평균)은 진짜 도트에서 나오므로 라인·압박을 만져도 같이 움직인다.
//
// ★ 색은 빨강(--an-us) — 색 규약상 "누구"다. 이건 우리 팀 이야기지 감독의 계획 도형
//   (패스 레인·집중 밴드, 흰색)이 아니다. 형태는 마름모: 원은 도트(선수)와, 사각·띠는
//   압박 존과 헷갈린다. 보드에서 유일한 마름모라 무엇이 새로 생겼는지 바로 잡힌다.
//
// ★ 상대 팀 무게중심은 그리지 않는다. 요구는 "내가 멘탈리티를 건드릴 때"이고, 상대 마커는
//   감독이 만질 수 없는 값이라 조작 피드백이 아니다 — 도형만 하나 더 늘어 보드가 복잡해진다.
//
// ★ 과거 사용자 지시(위 세 가지) 중 ③"강조 수단은 불투명도·굵기뿐, 위치 금지"와의 관계:
//   ③은 **변경을 강조하는 수단**에 대한 규칙이다. 무게중심의 위치는 강조가 아니라 정보
//   그 자체(우리 평균이 거기 있다)이므로 값이 바뀌면 자리를 옮기는 게 맞다. 대신 변경
//   **강조**는 여기서도 굵기·불투명도 한 단계뿐이다(an-hl-grav) — 크기·색은 흔들지 않는다.
//   ①"새 상시 모션 금지"는 그대로 지킨다: 기준점이 라이브 좌표가 아니라 전술 좌표라
//   가만히 있으면 마커도 완전히 정지해 있고, 값이 바뀔 때만 CSS transition으로 미끄러진다.

/** 멘탈리티 → 무게중심을 공격 방향으로 미는 양(home-프레임 0~100 ≈ m).
 *  ±7은 5단계 양 극단이 약 14유닛(≈14.7m) 벌어지는 값 — 한 단계(3.5 ≈ 3.7m)만 움직여도
 *  마커 지름(6)의 절반 이상이라 눈으로 잡히고, 양 극단에서도 블록 밖으로 튀어나가지 않는다. */
const MENTALITY_PUSH: Record<Mentality, number> = {
  'very-defensive': -7,
  'defensive': -3.5,
  'balanced': 0,
  'attacking': 3.5,
  'very-attacking': 7,
}

/** 무게중심 마커 좌표(절대 프레임). base는 전술 좌표 평균, push는 멘탈리티.
 *  @param dir 공격 방향(+1 = home 프레임에서 오른쪽). 우리 팀만 그리므로 사실상 +1이다. */
export function gravityMark(base: Coord, mentality: Mentality | undefined, dir: 1 | -1 = 1): Coord {
  const push = MENTALITY_PUSH[mentality ?? 'balanced'] * dir
  // 피치 밖으로 나가지 않게(마커 반지름 3 + 여백).
  return { x: Math.max(5, Math.min(95, base.x + push)), y: base.y }
}

/** 방금 바뀐 축의 강조 요청. */
export interface AnalysisHighlight {
  axes: readonly AnalysisAxis[]
  /** 같은 축이 연속으로 바뀔 때 애니메이션을 다시 트리거하기 위한 카운터.
   *  React key에 섞어 요소를 재마운트한다 — CSS 애니메이션 재시작의 가장 단순한 방법이다. */
  tick: number
}

/** 템포 0~100 → 패스 레인 흐름 애니메이션 주기(초). 템포는 도형이 없는 유일한 축이라
 *  **속도**로 표현한다: 느린 템포는 6초에 한 번, 빠른 템포는 1.8초에 한 번 흐른다.
 *  실제로 이 축이 정하는 것(공이 얼마나 빨리 앞으로 가는가)과 같은 방향의 은유다. */
export function tempoFlowSeconds(tempo: number): number {
  const t = Math.max(0, Math.min(100, tempo))
  return Math.round((6 - (t / 100) * 4.2) * 100) / 100
}

/** 라인 태그 폰트(viewBox 단위). 2.2 → 2.6으로 올렸다(감사 0-4: 피치 위 텍스트 가독성). */
export const TAG_FS = 2.6
/** 라인 태그가 앉는 띠 — 홈은 상단, 어웨이는 하단. 서로 다른 띠라 애초에 만나지 않는다. */
const TAG_Y_HOME = 3.2
const TAG_Y_AWAY = H - 3.2

/** 공격 패턴별 패스 레인(home-프레임 0~100 좌표의 꺾은선). */
const PASS_LANES: Record<AttackPattern, { pts: [number, number][]; kind?: 'through' | 'shot' }[]> = {
  // 균형 — 중앙 짧은 연결 두 갈래.
  balanced: [
    { pts: [[40, 42], [56, 46], [72, 50]] },
    { pts: [[40, 58], [56, 54], [72, 50]] },
  ],
  // 크로스 — 측면을 타고 내려간 뒤 문전으로 접는다(양 측면).
  cross: [
    { pts: [[44, 80], [70, 88], [86, 56]] },
    { pts: [[44, 20], [70, 12], [86, 44]] },
  ],
  // 중앙 침투 — 하프스페이스에서 수비 뒷공간으로 대각(파선 = 아직 없는 공간으로의 의도).
  through: [
    { pts: [[52, 44], [70, 30], [86, 40]], kind: 'through' },
    { pts: [[52, 56], [70, 70], [86, 60]], kind: 'through' },
  ],
  // 중거리 — 박스 밖 순환 후 슈팅(마지막 구간 점선 = 슛).
  longshot: [
    { pts: [[42, 62], [58, 38], [70, 50]] },
    { pts: [[70, 50], [90, 50]], kind: 'shot' },
  ],
}

/** attackFocus → 강조할 y 밴드(없으면 null). */
function focusBand(focus: Instructions['attackFocus']): { y: number; h: number } | null {
  switch (focus) {
    case 'left': return { y: 0, h: 30 }
    case 'right': return { y: 70, h: 30 }
    case 'center': return { y: 34, h: 32 }
    default: return null
  }
}

function toPath(pts: [number, number][]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p[0])} ${sy(p[1])}`).join(' ')
}

/** 한 팀의 수비 라인 + 압박 존. 텍스트는 여기서 그리지 않는다(labels 배치 패스로 넘긴다).
 *  hl은 **우리 팀에만** 붙는다 — 감독이 만진 것은 우리 숫자뿐이다. */
function TeamShape({ side, which, lineX, highlight: hl }: {
  side: SideState; which: 'home' | 'away'; lineX: number; highlight?: AnalysisHighlight
}) {
  const ins = side.tactics.instructions
  const reach = pressReach(ins.pressing)
  const mirror = which === 'away'
  // 압박 존은 수비 라인에서 **상대 골문 쪽으로** 뻗는다.
  const zoneFrom = mirror ? lineX - reach : lineX
  // 존의 앞 경계(파선)만 따로 긋는다 — "여기까지 나가서 압박한다"의 경계선.
  const edgeX = mirror ? zoneFrom : zoneFrom + reach
  const pressHl = hl?.axes.includes('pressing') ? ' an-hl' : ''
  const lineHl = hl?.axes.includes('lineHeight') ? ' an-hl' : ''
  const k = hl?.tick ?? 0
  return (
    <g className={`an-team an-team--${which}`}>
      <g key={`p${pressHl ? k : 0}`} className={`an-pressg${pressHl}`}>
        <rect className="an-press" x={sx(zoneFrom)} y={sy(4)} width={sx(reach)} height={sy(92)} />
        <line className="an-press__edge" x1={sx(edgeX)} y1={sy(4)} x2={sx(edgeX)} y2={sy(96)} />
      </g>
      <g key={`l${lineHl ? k : 0}`} className={`an-lineg${lineHl}`}>
        {/* 수비 라인 — 실선(현재 상태). 라인 높이를 내리면 자기 골문 쪽으로 내려간다. */}
        <line className="an-line" x1={sx(lineX)} y1={sy(3)} x2={sx(lineX)} y2={sy(97)} />
        {/* 양끝 T캡 — 화살촉 없는 실선이 "경계"임을 형태로 말한다. */}
        <line className="an-line__cap" x1={sx(lineX) - 1.6} y1={sy(3)} x2={sx(lineX) + 1.6} y2={sy(3)} />
        <line className="an-line__cap" x1={sx(lineX) - 1.6} y1={sy(97)} x2={sx(lineX) + 1.6} y2={sy(97)} />
      </g>
    </g>
  )
}

/** 우리 팀 무게중심 — 파선 마름모(의도) + 중심 십자.
 *  translate는 **바깥 g**에 건다: 강조는 안쪽 g를 재마운트해 트리거하는데, 이동을 안쪽에
 *  걸면 재마운트가 CSS transition을 리셋해 마커가 순간이동한다. */
function GravityMarker({ at, highlight: hl }: { at: Coord; highlight?: AnalysisHighlight }) {
  const on = hl?.axes.includes('mentality') ? ' an-hl' : ''
  const k = hl?.tick ?? 0
  return (
    <g className="an-grav" style={{ transform: `translate(${sx(at.x)}px, ${sy(at.y)}px)` }}>
      <g key={`g${on ? k : 0}`} className={`an-gravg${on}`}>
        <path className="an-grav__ring" d="M 0 -3 L 3 0 L 0 3 L -3 0 Z" />
        <line className="an-grav__tick" x1={-1} y1={0} x2={1} y2={0} />
        <line className="an-grav__tick" x1={0} y1={-1} x2={0} y2={1} />
      </g>
    </g>
  )
}

/** 라인 태그 2개의 배치 요청 — PitchView의 통합 라벨 패스가 자리를 정한다. */
export function analysisLabels(state: MatchState, geom: AnalysisGeom): LabelReq[] {
  const mk = (which: 'home' | 'away', lineX: number, y: number, value: number): LabelReq => ({
    id: `an-tag-${which}`,
    text: `${which === 'home' ? '우리' : '상대'} 라인 ${Math.round(value)}`,
    ax: sx(lineX),
    ay: y,
    fontSize: TAG_FS,
    padX: 0.9,
    // 같은 띠 안에서 좌우로 비켜서고, 그래도 막히면 안쪽 한 줄 아래/위로.
    slots: [
      { dx: 0, dy: 0 },
      { dx: 0, dy: which === 'home' ? 3.6 : -3.6 },
      { dx: 0, dy: which === 'home' ? 7.2 : -7.2 },
    ],
    rank: 0,
  })
  return [
    mk('home', geom.homeLineX, TAG_Y_HOME, state.home.tactics.instructions.lineHeight),
    mk('away', geom.awayLineX, TAG_Y_AWAY, state.away.tactics.instructions.lineHeight),
  ]
}

/**
 * 전술 시각화 레이어. PitchView가 `analysis` prop을 받으면 마킹 위·도트 아래에 깐다.
 * 순수 표시 — state를 읽기만 한다.
 */
export function AnalysisLayer({ state, geom, highlight }: {
  state: MatchState
  geom: AnalysisGeom
  /** 방금 바뀐 축(작전판이 정착 후 한 번만 올린다). 없으면 강조 없음. */
  highlight?: AnalysisHighlight
}) {
  const homeIns = state.home.tactics.instructions
  const pattern: AttackPattern = state.home.tactics.attackPattern ?? 'balanced'
  const band = focusBand(homeIns.attackFocus)
  const lanes = PASS_LANES[pattern]
  const k = highlight?.tick ?? 0
  const focusHl = highlight?.axes.includes('attackFocus') ? ' an-hl' : ''
  // 패턴은 레인의 **모양**을, 템포는 레인의 **속도**를 정한다. 둘 다 레인을 강조한다.
  const laneHl = highlight?.axes.some(a => a === 'attackPattern' || a === 'tempo') ? ' an-hl' : ''
  return (
    <g
      className="an-root"
      aria-hidden="true"
      // 데이터 바인딩 값만 인라인(프로젝트 규약의 허용 예외) — 흐름 주기는 템포 숫자 그 자체다.
      style={{ ['--an-flow' as string]: `${tempoFlowSeconds(homeIns.tempo)}s` }}
    >
      <defs>
        <marker id="an-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path className="an-arrow__head" d="M 0 1 L 7 4 L 0 7 z" />
        </marker>
      </defs>
      {/* 공격 집중 밴드 — 좌/중앙/우 중 어디로 몰아가는지. 계획이므로 흰색·점선 경계. */}
      {band && (
        <g key={`f${focusHl ? k : 0}`} className={`an-focus${focusHl}`}>
          <rect className="an-focus__fill" x={0} y={sy(band.y)} width={W} height={sy(band.h)} />
          {band.y > 0 && <line className="an-focus__edge" x1={0} y1={sy(band.y)} x2={W} y2={sy(band.y)} />}
          {band.y + band.h < 100 && (
            <line className="an-focus__edge" x1={0} y1={sy(band.y + band.h)} x2={W} y2={sy(band.y + band.h)} />
          )}
        </g>
      )}
      <TeamShape side={state.home} which="home" lineX={geom.homeLineX} highlight={highlight} />
      <TeamShape side={state.away} which="away" lineX={geom.awayLineX} />
      {/* 우리 팀 무게중심 — 멘탈리티가 이 마커를 앞뒤로 민다(위 논증 참고). */}
      <GravityMarker at={gravityMark(geom.homeGravity, state.home.tactics.mentality)} highlight={highlight} />
      {/* 패스 레인 — 공격 패턴 4택이 곧 이 화살표다. 색이 아니라 선 스타일로 구분한다. */}
      <g key={`n${laneHl ? k : 0}`} className={`an-lanes${laneHl}`}>
        {lanes.map((l, i) => (
          <path
            key={i}
            className={`an-lane${l.kind ? ` an-lane--${l.kind}` : ''}`}
            d={toPath(l.pts)}
            markerEnd="url(#an-arrow)"
          />
        ))}
      </g>
    </g>
  )
}
