import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import { formationEdge } from '../../engine/tactics'
import type { Player, SideState } from '../../engine/types'
import { PlayerCard } from '../common/PlayerCard'
import { PitchView } from '../pitch/PitchView'
import './opp.css'

export interface MatchupHint { tone: 'up' | 'even' | 'down'; text: string }

/** 포메이션 상성(내 포메이션 vs 상대) → 한 줄 매치업 힌트.
 *  edge>0이면 홈(유저) 우위. 부호·크기로 톤·문구를 결정(결정론). */
export function matchupHint(edge: number): MatchupHint {
  if (edge >= 0.04) return { tone: 'up', text: '상성 우위 — 중원 수적 우위 예상' }
  if (edge > 0) return { tone: 'up', text: '근소한 상성 우위' }
  if (edge === 0) return { tone: 'even', text: '포메이션 상성 대등' }
  if (edge <= -0.04) return { tone: 'down', text: '상성 열세 — 측면·뒷공간 주의' }
  return { tone: 'down', text: '근소한 상성 열세' }
}

/** 상대 분석 탭(작전판 내) — 상대 포메이션·미니 보드 + 선발 11 리스트(클릭 시 PlayerCard) +
 *  키 플레이어 ★ + styleNotes + 매치업 힌트(formationEdge 부호·크기). 상대 스탯도 조회 가능. */
export function OppPanel() {
  const engine = useMatchStore(s => s.engine)
  const [sel, setSel] = useState<string | null>(null)

  if (!engine) return <section className="op" aria-label="상대 분석" />
  const home: SideState = engine.home
  const away: SideState = engine.away

  const oppFormation = away.tactics.formation
  const myFormation = home.tactics.formation
  const edge = formationEdge(myFormation, oppFormation)
  const hint = matchupHint(edge)

  const byId = (id: string): Player | undefined => away.team.squad.find(p => p.id === id)
  const keyIds = new Set(away.team.profile.keyPlayers.map(k => k.playerId))
  const lineup = away.tactics.lineup
    .map(l => ({ slot: l.slot, player: byId(l.playerId) }))
    .filter((x): x is { slot: Player['position']; player: Player } => !!x.player)
  const styleNotes = (away.team.profile as { styleNotes?: string }).styleNotes
  const preferred = away.team.profile.preferredFormations
  const selected = sel ? byId(sel) : null

  return (
    <section className="op" aria-label="상대 분석">
      <header className="op__head">
        <span className="op__name">{away.team.name.ko}</span>
        <span className="op__form" aria-label="상대 포메이션">{oppFormation}</span>
      </header>
      {preferred.length > 0 && preferred[0] !== oppFormation && (
        <p className="op__pref">선호: {preferred.join(', ')}</p>
      )}

      <div className={`op__matchup op__matchup--${hint.tone}`} role="note" aria-label="매치업 힌트">
        <span className="op__matchup-vs">{myFormation} vs {oppFormation}</span>
        <span className="op__matchup-text">{hint.text}</span>
      </div>

      <div className="op__board">
        <PitchView state={engine} variant="tactics" />
      </div>

      {styleNotes && <p className="op__notes">{styleNotes}</p>}

      <h4 className="op__subtitle">선발 11</h4>
      <ul className="op__list" role="group" aria-label="상대 선발">
        {lineup.map(({ slot, player }) => {
          const star = keyIds.has(player.id)
          return (
            <li key={player.id}>
              <button
                type="button"
                className={`op__row${sel === player.id ? ' op__row--sel' : ''}${star ? ' op__row--key' : ''}`}
                aria-pressed={sel === player.id}
                onClick={() => setSel(sel === player.id ? null : player.id)}
              >
                <span className="op__row-num">{player.number}</span>
                <span className="op__row-name">{player.name.ko}</span>
                {star && <span className="op__row-star" aria-label="키 플레이어">★</span>}
                <span className="op__row-slot">{slot}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {selected && (
        <div className="op__card">
          <PlayerCard
            player={selected}
            side="away"
            star={keyIds.has(selected.id)}
            stamina={away.staminaByPlayer[selected.id]}
          />
        </div>
      )}
    </section>
  )
}
