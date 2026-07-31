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
import type { AttackPattern, Instructions, MatchState, SideState } from '../../engine/types'
import { lineDepth, pressReach } from './shape'
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
export type AnalysisAxis = 'lineHeight' | 'pressing' | 'tempo' | 'attackFocus' | 'attackPattern'

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
