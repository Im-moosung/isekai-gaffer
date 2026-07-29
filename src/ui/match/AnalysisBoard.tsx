// src/ui/match/AnalysisBoard.tsx
// 하이라이트 **사이**에 보여주는 2D 작전판.
//
// 실제 중계도 라이브와 전술 분석 화면을 오간다. 전환 자체가 방송 문법이다.
// 여기서는 3D가 못 하는 것을 그린다 — 수비 라인을 선으로, 압박을 존으로, 패스 루트를
// 화살표로. 공은 리사주 곡선이 아니라 실제 선수 발밑을 옮겨 다닌다(flow.ts).
import type { AttackPattern, MatchState } from '../../engine/types'
import type { ChoreoStep } from '../pitch/choreography'
import { buildupLabel } from '../pitch/scenes'
import { PitchView } from '../pitch/PitchView'

const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형',
  cross: '크로스',
  through: '중앙 침투',
  longshot: '중거리',
}

interface AnalysisBoardProps {
  state: MatchState
  /** 이 구간에 재생할 시퀀스(점유 흐름 또는 비하이라이트 이벤트 안무). */
  sequence?: ChoreoStep[]
  dwellMs: number
  sequenceSide: 'home' | 'away'
  /** 하단 캡션 — 현재 무엇을 보고 있는지 한 줄. */
  caption: string
  /** 보이는 상태인가(전환 연출은 CSS가 담당, 마운트는 유지한다). */
  visible: boolean
}

/**
 * 2D 작전판. 방송 스테이지의 피치 자리에 **겹쳐** 놓고 opacity로 오간다.
 * 마운트를 유지하는 이유: 3D(three)를 매 하이라이트마다 언마운트하면 WebGL 컨텍스트가
 * 재생성되어 히치가 난다. 보이지 않을 때는 pointer-events도 끈다.
 */
export function AnalysisBoard({ state, sequence, dwellMs, sequenceSide, caption, visible }: AnalysisBoardProps) {
  const t = state.home.tactics
  const ins = t.instructions
  const pattern: AttackPattern = t.attackPattern ?? 'balanced'
  const poss = Math.round(state.stats[0].possession)
  return (
    <div
      className={`ab-root${visible ? ' ab-root--on' : ''}`}
      aria-hidden={!visible}
      // 라이브가 보일 때는 스크린리더에서도 빠져야 한다(중복 낭독 방지).
      {...(visible ? { role: 'img', 'aria-label': '전술 분석 보드' } : {})}
    >
      <PitchView
        state={state}
        variant="tactics"
        analysis
        nameLabels
        sequence={sequence}
        dwellMs={dwellMs}
        sequenceSide={sequenceSide}
      />
      {/* 정보 바는 피치 아래 — 위쪽은 스코어버그·플랜 배지가 이미 차지한다. */}
      <div className="ab-head">
        <span className="ab-tag">전술 분석</span>
        <span className="ab-pattern">{PATTERN_KO[pattern]} — {buildupLabel(pattern)}</span>
        <span className="ab-chips">
          <span className="ab-chip">라인 {Math.round(ins.lineHeight)}</span>
          <span className="ab-chip">압박 {Math.round(ins.pressing)}</span>
          <span className="ab-chip">템포 {Math.round(ins.tempo)}</span>
        </span>
        <span className="ab-stats">
          점유 {poss}% · 슛 {state.stats[0].shots}-{state.stats[1].shots} · xG {state.stats[0].xg.toFixed(2)}
        </span>
      </div>
      <div className="ab-caption">{caption}</div>
    </div>
  )
}
