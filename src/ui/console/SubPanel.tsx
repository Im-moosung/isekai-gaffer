import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import type { MatchEvent, Player, SideState } from '../../engine/types'
import { playerMatchStats, hasPlayerMatchStats, type PlayerMatchStats } from '../../game/playerStats'
import './console.css'

const MAX_SUBS = 5

interface SubPanelProps {
  side: 'home' | 'away'
  /** 제어 모드(작전판 보드 연동): 지정 시 선택 상태를 상위(TacticsBoard)가 소유한다. */
  outId?: string | null
  inId?: string | null
  onSelectOut?: (id: string) => void
  onSelectIn?: (id: string) => void
  /** 교체 확정 성공 후 콜백(상위 상태 리셋). */
  onConfirmed?: () => void
}

/** 교체 패널 — 라인업 11인 카드(이름·번호·포지션·체력바) + 벤치.
 *  아웃(라인업)/인(벤치) 선택 → "교체 확정" → submitCommand({type:'sub'}).
 *  제어 모드(onSelectOut/onSelectIn 제공)면 선택 상태를 상위가 소유해 보드 하이라이트·
 *  고스트 미리보기와 동기화한다. 미제공 시 내부 state로 독립 동작(기존 호환). */
export function SubPanel({ side, outId, inId, onSelectOut, onSelectIn, onConfirmed }: SubPanelProps) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const controlled = !!(onSelectOut && onSelectIn)
  const [outLocal, setOutLocal] = useState<string | null>(null)
  const [inLocal, setInLocal] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const out = controlled ? outId ?? null : outLocal
  const inSel = controlled ? inId ?? null : inLocal
  const pickOut = (id: string) => (controlled ? onSelectOut!(id) : setOutLocal(id))
  const pickIn = (id: string) => (controlled ? onSelectIn!(id) : setInLocal(id))

  const open = phase === 'halftime' || phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  const state: SideState | undefined = engine?.[side]
  // 개인 기록은 "누구를 뺄까"의 근거다 — 카드를 열어야만 보이면 늦다. 진행 전엔 데이터가 없다.
  const events: MatchEvent[] | null = engine && engine.minute > 0 ? engine.events : null
  if (!state) return <section className="cs-panel" aria-label="교체" />

  const squad = state.team.squad
  const byId = (id: string) => squad.find(p => p.id === id)
  const lineupIds = state.tactics.lineup.map(l => l.playerId)
  const lineup = state.tactics.lineup
    .map(l => ({ slot: l.slot, player: byId(l.playerId) }))
    .filter((x): x is { slot: Player['position']; player: Player } => !!x.player)
  const bench = squad.filter(p => !lineupIds.includes(p.id))

  const swap = () => {
    setError(null)
    if (!out || !inSel) { setError('아웃/인 선수를 선택하세요'); return }
    try {
      submitCommand(side, { type: 'sub', out, in: inSel })
      if (controlled) onConfirmed?.()
      else { setOutLocal(null); setInLocal(null) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const ready = !!out && !!inSel

  return (
    <section className="cs-panel cs-sub" aria-label="교체">
      <div className="cs-panel__head">
        <h3 className="cs-panel__title">교체</h3>
        <span className="cs-sub__count">{state.subsUsed}/{MAX_SUBS}</span>
      </div>

      <p className="cs-sub__hint">
        {!out ? '① 나갈 선수를 고르세요(보드 발광)' : !inSel ? '② 들어올 벤치 선수를 고르세요' : '③ [교체 확정]'}
      </p>

      <div className="cs-sub__lineup" role="group" aria-label="라인업">
        {lineup.map(({ slot, player }) => (
          <SubCard
            key={player.id}
            player={player}
            slot={slot}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            stats={events ? playerMatchStats(events, player.id) : null}
            selected={out === player.id}
            disabled={!open}
            onSelect={() => pickOut(player.id)}
          />
        ))}
      </div>

      <h4 className="cs-sub__subtitle">벤치</h4>
      <div className="cs-sub__bench" role="group" aria-label="벤치">
        {bench.map(player => (
          <SubCard
            key={player.id}
            player={player}
            slot={player.position}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            stats={events ? playerMatchStats(events, player.id) : null}
            selected={inSel === player.id}
            disabled={!open || !out}
            onSelect={() => pickIn(player.id)}
          />
        ))}
      </div>

      <div className="cs-panel__foot">
        <button type="button" className="cs-btn" onClick={swap} disabled={!open || !ready}>교체 확정</button>
        {!open && <span className="cs-lock">다음 개입 창까지 잠김</span>}
      </div>
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}

function SubCard({ player, slot, stamina, stats, selected, disabled, onSelect }: {
  player: Player; slot: Player['position']; stamina: number
  /** 이 경기 개인 기록. null이면 아직 경기가 진행되지 않은 것(표시 안 함). */
  stats: PlayerMatchStats | null
  selected: boolean; disabled: boolean; onSelect: () => void
}) {
  const pct = Math.max(0, Math.min(100, Math.round(stamina)))
  const low = pct < 30
  return (
    <button
      type="button"
      className={`cs-card${selected ? ' cs-card--sel' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="cs-card__num">{player.number}</span>
      <span className="cs-card__name">{player.name.ko}</span>
      <span className="cs-card__slot">{slot}</span>
      <span className="cs-card__stamina" aria-label={`체력 ${pct}%`}>
        {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
        <span className={`cs-card__bar${low ? ' cs-card__bar--low' : ''}`} style={{ width: `${pct}%` }} />
      </span>
      {stats && hasPlayerMatchStats(stats) && <SubCardStats stats={stats} />}
    </button>
  )
}

/** 교체 카드 한 줄 기록 — 0인 항목은 생략해 카드가 길어지지 않게 한다.
 *  유효슛은 일부러 넣지 않는다: 선방당한 슛은 슈터를 알 수 없어 정직하게 셀 수 없다
 *  (playerStats.ts 주석 참조). 확실한 '슛/골'만 내건다. */
function SubCardStats({ stats }: { stats: PlayerMatchStats }) {
  const parts: string[] = []
  if (stats.goals > 0) parts.push(`⚽${stats.goals}`)
  if (stats.assists > 0) parts.push(`🅰${stats.assists}`)
  if (stats.saves > 0) parts.push(`🧤${stats.saves}`)
  if (stats.shots > 0) parts.push(`슛${stats.shots}`)
  if (stats.fouls > 0) parts.push(`파울${stats.fouls}`)
  const carded = stats.reds > 0 ? '🟥' : stats.yellows > 0 ? '🟨' : ''
  return (
    <span className={`cs-card__rec${carded ? ' cs-card__rec--carded' : ''}`}>
      {carded}{parts.join(' · ')}
    </span>
  )
}
