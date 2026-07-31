// src/ui/match/AnalysisBoard.tsx
// 하이라이트 **사이**에 보여주는 2D 작전판.
//
// 실제 중계도 라이브와 전술 분석 화면을 오간다. 전환 자체가 방송 문법이다.
// 여기서는 3D가 못 하는 것을 그린다 — 수비 라인을 선으로, 압박을 존으로, 패스 루트를
// 화살표로. 공은 리사주 곡선이 아니라 실제 선수 발밑을 옮겨 다닌다(flow.ts).
import { useState } from 'react'
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
  /** 일시정지 — 보드의 안무·라이브 무브먼트도 함께 멈춘다. */
  paused?: boolean
}

/**
 * 2D 작전판. 방송 스테이지의 피치 자리에 **겹쳐** 놓고 opacity로 오간다.
 * 마운트를 유지하는 이유: 3D(three)를 매 하이라이트마다 언마운트하면 WebGL 컨텍스트가
 * 재생성되어 히치가 난다. 보이지 않을 때는 pointer-events도 끈다.
 */
export function AnalysisBoard({ state, sequence, dwellMs, sequenceSide, caption, visible, paused }: AnalysisBoardProps) {
  const t = state.home.tactics
  const ins = t.instructions
  const pattern: AttackPattern = t.attackPattern ?? 'balanced'
  const poss = Math.round(state.stats[0].possession)
  // 블록 길이·폭(m) — 라인·압박 슬라이더의 결과를 숫자로도 되돌려준다.
  // PitchView가 실제 도트 좌표에서 재서 올려주므로 화면과 수치가 항상 같다.
  const [block, setBlock] = useState({ lengthM: 0, widthM: 0 })
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
        paused={paused}
        onMetrics={setBlock}
      />
      {/* 정보 바는 피치 아래 — 위쪽은 스코어버그·플랜 배지가 이미 차지한다. */}
      <div className="ab-head">
        <span className="ab-tag">전술 분석</span>
        <span className="ab-pattern">{PATTERN_KO[pattern]} — {buildupLabel(pattern)}</span>
        <span className="ab-chips">
          <span className="ab-chip">라인 {Math.round(ins.lineHeight)}</span>
          <span className="ab-chip">압박 {Math.round(ins.pressing)}</span>
          <span className="ab-chip">템포 {Math.round(ins.tempo)}</span>
          {/* 컴팩트니스 — 슬라이더 두 개가 만든 결과를 코치가 쓰는 단위(m)로 되돌려준다. */}
          <span className="ab-chip">블록 {block.lengthM}×{block.widthM}m</span>
        </span>
        <span className="ab-stats">
          점유 {poss}% · 슛 {state.stats[0].shots}-{state.stats[1].shots} · xG {state.stats[0].xg.toFixed(2)}
        </span>
      </div>
      <Legend state={state} />
      <div className="ab-caption">{caption}</div>
    </div>
  )
}

/**
 * 범례. 색은 **누구**(팀), 형태는 **무엇**(라인/존/경로)이라는 규약을 세 줄로 끝낸다.
 * 피치 안이 아니라 밖에 두는 이유: 안에 두면 도트를 덮고, 좁은 화면에서 글자가
 * 3px 밑으로 내려간다(감사 A-4). 밖이면 11px 본문 크기를 지킬 수 있다.
 */
function Legend({ state }: { state: MatchState }) {
  const us = state.home.team.name.ko
  const them = state.away.team.name.ko
  const usLine = Math.round(state.home.tactics.instructions.lineHeight)
  const themLine = Math.round(state.away.tactics.instructions.lineHeight)
  return (
    <div className="an-legend">
      <span className="an-legend__item">
        <LineSwatch color="var(--an-us)" />
        {us} 수비 라인 <b className="an-legend__val">{usLine}</b>
      </span>
      <span className="an-legend__item">
        <LineSwatch color="var(--an-them)" />
        {them} 수비 라인 <b className="an-legend__val">{themLine}</b>
      </span>
      <span className="an-legend__item">
        <svg className="an-legend__swatch" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
          <rect x="0" y="1" width="24" height="6" fill="var(--an-us)" opacity="0.16" />
          <line x1="24" y1="1" x2="24" y2="7" stroke="var(--an-us)" strokeWidth="1" strokeDasharray="2 2" opacity="0.7" />
        </svg>
        압박 범위
      </span>
      <span className="an-legend__item">
        <ArrowSwatch />
        계획한 전개
      </span>
      <span className="an-legend__item">
        <ArrowSwatch dashed />
        뒷공간 침투
      </span>
    </div>
  )
}

function LineSwatch({ color }: { color: string }) {
  return (
    <svg className="an-legend__swatch" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
      <line x1="12" y1="0.5" x2="12" y2="7.5" stroke={color} strokeWidth="1.6" />
      <line x1="9" y1="0.8" x2="15" y2="0.8" stroke={color} strokeWidth="1.4" />
      <line x1="9" y1="7.2" x2="15" y2="7.2" stroke={color} strokeWidth="1.4" />
    </svg>
  )
}

function ArrowSwatch({ dashed = false }: { dashed?: boolean }) {
  return (
    <svg className="an-legend__swatch" width="26" height="8" viewBox="0 0 26 8" aria-hidden="true">
      <line
        x1="1" y1="4" x2="19" y2="4"
        stroke="var(--an-plan)" strokeWidth="1.3" opacity="0.85"
        strokeDasharray={dashed ? '3.5 2.6' : undefined}
      />
      <path d="M 18 1.4 L 24 4 L 18 6.6 z" fill="var(--an-plan)" opacity="0.85" />
    </svg>
  )
}
