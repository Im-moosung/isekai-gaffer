// src/ui/pitch/AnalysisLayer.tsx
// 2D 작전판의 전술 시각화 레이어 — 하이라이트 **사이** 구간에서 화면이 하는 일.
//
// 왜 2D인가: 3D는 수비 라인을 "선"으로, 압박을 "존"으로, 패스 루트를 "화살표"로 그릴 수
// 없다. 3D가 못 하는 걸 여기서 한다. 반대로 2D에서 공이 추상적으로 순환하는 건 실패한
// 사실주의가 아니라 정확한 데이터 시각화(점유 흐름)로 읽힌다.
//
// ★ 여기 그려지는 모든 선은 **유저가 만진 숫자**다. 라인을 내리면 수비 라인이 실제로
//   내려가고, 압박을 올리면 존이 넓어지고, 공격 패턴을 바꾸면 화살표가 바뀐다.
//   지금까지 전술은 슬라이더 위의 숫자로만 존재했다.
import type { AttackPattern, Instructions, MatchState, SideState } from '../../engine/types'

// PitchView와 동일한 viewBox(105×68) 좌표계.
const W = 105
const H = 68
const sx = (x: number) => (x / 100) * W
const sy = (y: number) => (y / 100) * H

/** 라인 높이 0~100 → home-프레임 x(0~100). 최저 8(자기 박스 앞) ~ 최고 42(하프라인 앞). */
export function lineDepth(lineHeight: number): number {
  return 8 + Math.max(0, Math.min(100, lineHeight)) * 0.34
}

/** 압박 강도 0~100 → 라인 앞으로 뻗는 압박 존 깊이(0~100 좌표). */
export function pressReach(pressing: number): number {
  return 10 + Math.max(0, Math.min(100, pressing)) * 0.35
}

/** 공격 패턴별 패스 레인(home-프레임 0~100 좌표의 꺾은선). */
const PASS_LANES: Record<AttackPattern, { pts: [number, number][]; dashed?: boolean }[]> = {
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
  // 중앙 침투 — 하프스페이스에서 수비 뒷공간으로 대각.
  through: [
    { pts: [[52, 44], [70, 30], [86, 40]], dashed: true },
    { pts: [[52, 56], [70, 70], [86, 60]], dashed: true },
  ],
  // 중거리 — 박스 밖 순환 후 슈팅(마지막 구간 파선 = 슛).
  longshot: [
    { pts: [[42, 62], [58, 38], [70, 50]] },
    { pts: [[70, 50], [90, 50]], dashed: true },
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

function toPath(pts: [number, number][], mirror: boolean): string {
  const fx = (x: number) => (mirror ? 100 - x : x)
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(fx(p[0]))} ${sy(p[1])}`).join(' ')
}

/** 한 팀의 수비 라인 + 압박 존 + 컴팩트니스 브래킷. */
function TeamShape({ side, which }: { side: SideState; which: 'home' | 'away' }) {
  const ins = side.tactics.instructions
  const depth = lineDepth(ins.lineHeight)
  const reach = pressReach(ins.pressing)
  const mirror = which === 'away'
  const lineX = mirror ? 100 - depth : depth
  const zoneFrom = mirror ? 100 - depth - reach : depth
  return (
    <g className={`an-team an-team--${which}`}>
      {/* 압박 범위 — 수비 라인 앞으로 뻗는 존. 압박 수치가 곧 폭이다. */}
      <rect className="an-press" x={sx(zoneFrom)} y={sy(4)} width={sx(reach)} height={sy(92)} />
      {/* 수비 라인 — 유저가 라인을 내리면 이 선이 자기 골문 쪽으로 내려간다. */}
      <line className="an-line" x1={sx(lineX)} y1={sy(3)} x2={sx(lineX)} y2={sy(97)} />
      <text className="an-line__tag" x={sx(lineX)} y={sy(mirror ? 99 : 99)}>
        {which === 'home' ? '수비 라인' : '상대 라인'} {Math.round(ins.lineHeight)}
      </text>
    </g>
  )
}

/**
 * 전술 시각화 레이어. PitchView가 `analysis` prop을 받으면 마킹 위·도트 아래에 깐다.
 * 순수 표시 — state를 읽기만 한다.
 */
export function AnalysisLayer({ state }: { state: MatchState }) {
  const homeIns = state.home.tactics.instructions
  const pattern: AttackPattern = state.home.tactics.attackPattern ?? 'balanced'
  const band = focusBand(homeIns.attackFocus)
  const lanes = PASS_LANES[pattern]
  return (
    <g className="an-root" aria-hidden="true">
      <defs>
        <marker id="an-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path className="an-arrow__head" d="M 0 1 L 7 4 L 0 7 z" />
        </marker>
      </defs>
      {/* 공격 집중 밴드 — 좌/중앙/우 중 어디로 몰아가는지. */}
      {band && <rect className="an-focus" x={0} y={sy(band.y)} width={W} height={sy(band.h)} />}
      <TeamShape side={state.home} which="home" />
      <TeamShape side={state.away} which="away" />
      {/* 패스 레인 — 공격 패턴 4택이 곧 이 화살표다. */}
      {lanes.map((l, i) => (
        <path
          key={i}
          className={`an-lane${l.dashed ? ' an-lane--dashed' : ''}`}
          d={toPath(l.pts, false)}
          markerEnd="url(#an-arrow)"
        />
      ))}
    </g>
  )
}
