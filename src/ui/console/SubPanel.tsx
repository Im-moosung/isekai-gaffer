import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import type { Player, SideState } from '../../engine/types'
import './console.css'

const MAX_SUBS = 5

/** 교체 패널 — 라인업 11인 카드(이름·번호·포지션·체력바) + 벤치.
 *  아웃(라인업)/인(벤치) 선택 → "교체" → submitCommand({type:'sub'}). phase 가드는 콘솔과 동일. */
export function SubPanel({ side }: { side: 'home' | 'away' }) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const [out, setOut] = useState<string | null>(null)
  const [inId, setInId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = phase === 'halftime' || phase === 'decision'
  const state: SideState | undefined = engine?.[side]
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
    if (!out || !inId) { setError('아웃/인 선수를 선택하세요'); return }
    try {
      submitCommand(side, { type: 'sub', out, in: inId })
      setOut(null); setInId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="cs-panel cs-sub" aria-label="교체">
      <div className="cs-panel__head">
        <h3 className="cs-panel__title">교체</h3>
        <span className="cs-sub__count">{state.subsUsed}/{MAX_SUBS}</span>
      </div>

      <div className="cs-sub__lineup" role="group" aria-label="라인업">
        {lineup.map(({ slot, player }) => (
          <PlayerCard
            key={player.id}
            player={player}
            slot={slot}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            selected={out === player.id}
            disabled={!open}
            onSelect={() => setOut(player.id)}
          />
        ))}
      </div>

      <h4 className="cs-sub__subtitle">벤치</h4>
      <div className="cs-sub__bench" role="group" aria-label="벤치">
        {bench.map(player => (
          <PlayerCard
            key={player.id}
            player={player}
            slot={player.position}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            selected={inId === player.id}
            disabled={!open}
            onSelect={() => setInId(player.id)}
          />
        ))}
      </div>

      <div className="cs-panel__foot">
        <button type="button" className="cs-btn" onClick={swap} disabled={!open}>교체</button>
        {!open && <span className="cs-lock">다음 개입 창까지 잠김</span>}
      </div>
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}

function PlayerCard({ player, slot, stamina, selected, disabled, onSelect }: {
  player: Player; slot: Player['position']; stamina: number
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
    </button>
  )
}
