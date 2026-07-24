import type { MatchState, MatchEvent, SideState } from '../../engine/types'
import { slotCoords } from './formations'
import './pitch.css'

// 피치 실측 비율(m) — viewBox 0 0 105 68.
const W = 105
const H = 68
// slotCoords의 0~100 좌표를 viewBox 좌표로 스케일.
const sx = (x: number) => (x / 100) * W
const sy = (y: number) => (y / 100) * H

interface PitchViewProps {
  state: MatchState
  lastEvent?: MatchEvent
  /** 'broadcast'(기본, 그린 피치) | 'tactics'(다크 전술판 — 색은 tactics.css가 pv-root--tactics로 덮음). */
  variant?: 'broadcast' | 'tactics'
  /** 홈 도트에 선수 이름 라벨 표시(작전판 — "이 선수가 어디 포지션인지" 가시화). */
  nameLabels?: boolean
}

/** SVG 105×68 피치 뷰.
 *  외곽선·센터서클·페널티박스 + 양팀 lineup 11 도트(등번호) + lastEvent 마커.
 *  엔진 호출 없이 전달받은 state만 그린다(컴포넌트는 엔진 타입 import만).
 *  variant='tactics'면 다크 보드 클래스(pv-root--tactics)를 붙여 작전판 톤으로 렌더하고,
 *  도트 좌표에 transition을 걸어(포메이션 변경 시) 새 위치로 부드럽게 이동한다(tactics.css). */
export function PitchView({ state, lastEvent, variant = 'broadcast', nameLabels = false }: PitchViewProps) {
  return (
    <svg
      className={`pv-root${variant === 'tactics' ? ' pv-root--tactics' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="경기 피치 포메이션"
      preserveAspectRatio="xMidYMid meet"
    >
      <PitchMarkings />
      <SideDots side={state.home} which="home" nameLabels={nameLabels} />
      <SideDots side={state.away} which="away" />
      {lastEvent && <EventMarker event={lastEvent} state={state} />}
    </svg>
  )
}

function PitchMarkings() {
  const cy = H / 2
  // 페널티박스: 깊이 16.5m, 폭 40.3m / 골박스: 깊이 5.5m, 폭 18.3m.
  const penH = 40.3
  const penTop = (H - penH) / 2
  const goalH = 18.3
  const goalTop = (H - goalH) / 2
  return (
    <g>
      <rect className="pv-stripe" x={0} y={0} width={W / 2} height={H} />
      {/* 외곽선 */}
      <rect className="pv-line" x={0.5} y={0.5} width={W - 1} height={H - 1} />
      {/* 하프라인 */}
      <line className="pv-line" x1={W / 2} y1={0.5} x2={W / 2} y2={H - 0.5} />
      {/* 센터서클 + 킥오프 점 */}
      <circle className="pv-line" cx={W / 2} cy={cy} r={9.15} />
      <circle cx={W / 2} cy={cy} r={0.5} fill="var(--bc-pitch-line)" />
      {/* 좌측(홈) 페널티/골 박스 */}
      <rect className="pv-line" x={0.5} y={penTop} width={16.5} height={penH} />
      <rect className="pv-line" x={0.5} y={goalTop} width={5.5} height={goalH} />
      {/* 우측(어웨이) 페널티/골 박스 */}
      <rect className="pv-line" x={W - 0.5 - 16.5} y={penTop} width={16.5} height={penH} />
      <rect className="pv-line" x={W - 0.5 - 5.5} y={goalTop} width={5.5} height={goalH} />
    </g>
  )
}

function SideDots({ side, which, nameLabels = false }: { side: SideState; which: 'home' | 'away'; nameLabels?: boolean }) {
  const { formation, lineup } = side.tactics
  const numberById = new Map(side.team.squad.map(p => [p.id, p.number]))
  const nameById = new Map(side.team.squad.map(p => [p.id, p.name.ko]))
  return (
    <g>
      {lineup.map((slot, i) => {
        const c = slotCoords(formation, i, which)
        const cx = sx(c.x)
        const cy = sy(c.y)
        const num = numberById.get(slot.playerId)
        const name = nameById.get(slot.playerId)
        return (
          <g key={`${which}-${i}`}>
            <circle className={`pv-dot pv-dot--${which}`} cx={cx} cy={cy} r={2.4} />
            {num != null && (
              <text className="pv-num" x={cx} y={cy}>{num}</text>
            )}
            {nameLabels && name && (
              <text className="pv-name" x={cx} y={cy + 4.4}>{name}</text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/** 이벤트 타입별 근사 존 좌표(0~100) — 득점/슈팅 팀의 공격 방향 기준. */
function eventZone(event: MatchEvent, state: MatchState): { x: number; y: number } {
  const isHome = event.teamId === state.home.team.id
  // 홈은 우측(x 큰 쪽) 공격, 어웨이는 좌측 공격.
  const attackX = isHome ? 88 : 12
  // 분(minute)으로 결정론적 y 분산(코너/파울 등 위치 다양화).
  const yJitter = 35 + ((event.minute * 7) % 30)
  switch (event.type) {
    case 'corner':
      return { x: attackX, y: event.minute % 2 === 0 ? 8 : 92 }
    case 'foul':
    case 'yellow':
    case 'red':
      return { x: 50 + (isHome ? 12 : -12), y: yJitter }
    default: // goal, shot, save, miss, chance ...
      return { x: attackX, y: yJitter }
  }
}

function EventMarker({ event, state }: { event: MatchEvent; state: MatchState }) {
  const z = eventZone(event, state)
  const cx = sx(z.x)
  const cy = sy(z.y)
  if (event.type === 'goal') {
    return (
      <g className="pv-marker pv-marker--goal" aria-label="득점 위치">
        <circle cx={cx} cy={cy} r={3} fill="none" />
        <circle className="pv-pulse" cx={cx} cy={cy} r={1.5} fill="none" />
      </g>
    )
  }
  if (event.type === 'foul' || event.type === 'yellow' || event.type === 'red') {
    // ▲ 삼각형
    const s = 2.6
    const d = `M ${cx} ${cy - s} L ${cx + s} ${cy + s} L ${cx - s} ${cy + s} Z`
    return <path className="pv-marker pv-marker--foul" d={d} aria-label="파울 위치" />
  }
  // miss / save / shot 등 → × 마커
  const s = 2.2
  return (
    <g className="pv-marker pv-marker--x" aria-label="슈팅 위치">
      <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} />
      <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} />
    </g>
  )
}
