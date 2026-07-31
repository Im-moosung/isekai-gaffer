import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import { formationEdge } from '../../engine/tactics'
import type { Player, SideState } from '../../engine/types'
import { playerMatchStats } from '../../game/playerStats'
import { PlayerCard } from '../common/PlayerCard'
import { MatchStatsPanel } from '../match/StatsTable'
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
 *  키 플레이어 ★ + styleNotes + 매치업 힌트(formationEdge 부호·크기). 상대 스탯도 조회 가능.
 *
 *  ★ 팀 경기 스탯(MatchStatsPanel)이 맨 위에 붙는다. 이 패널은 워룸의 [상대 브리핑] 탭과
 *  작전판의 [상대] 탭 **양쪽에서 렌더되는 유일한 컴포넌트**라, 여기에 한 번 꽂으면 두 화면
 *  모두에서 스탯을 볼 수 있다(두 화면에 각각 넣으면 워룸에서는 이중 표시). */
export function OppPanel() {
  const engine = useMatchStore(s => s.engine)
  const notices = useMatchStore(s => s.oppNotices)
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

  // 세 묶음(브리핑 / 도해 / 스쿼드)으로 나눈다. 좁은 곳(작전판 [상대] 탭)에서는 세로로
  // 쌓이고, 넓은 곳(워룸 상대 브리핑 탭)에서는 CSS가 3열로 편다. 한 줄로 늘어놓으면
  // 워룸 전폭에서 문서가 2200px까지 자란다(실측) — 탭으로 나눈 의미가 사라진다.
  return (
    <section className="op" aria-label="상대 분석">
      <div className="op__col op__col--brief">
        <MatchStatsPanel />
        <header className="op__head">
          <span className="op__name">{away.team.name.ko}</span>
          <span className="op__form num" aria-label="상대 포메이션">{oppFormation}</span>
        </header>
        {preferred.length > 0 && preferred[0] !== oppFormation && (
          <p className="op__pref">선호: {preferred.join(', ')}</p>
        )}

        <div className={`op__matchup op__matchup--${hint.tone}`} role="note" aria-label="매치업 힌트">
          <span className="op__matchup-vs num">{myFormation} vs {oppFormation}</span>
          <span className="op__matchup-text">{hint.text}</span>
        </div>

        {/* 상대 감독의 변경 이력 — 배너는 3분 뒤 사라지므로, 작전판에서 최근 3건을 다시 확인한다. */}
        {notices.length > 0 && (
          <ul className="op__timeline" aria-label="상대 변경 이력">
            {notices.slice(-3).map(n => (
              <li key={`${n.minute}-${n.text}`} className="op__timeline-row">
                <span className="op__timeline-min num">{n.minute}&apos;</span>
                <span className="op__timeline-text">{n.text.replace('📢 ', '')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="op__col op__col--board">
        <div className="op__board">
          <PitchView state={engine} variant="tactics" />
        </div>
        {styleNotes && <p className="op__notes">{styleNotes}</p>}
      </div>

      <div className="op__col op__col--squad">
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
                  <span className="op__row-num num">{player.number}</span>
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
            {/* 상대 카드는 기본 스탯(레이더)+프로필만 — 실시간 체력·사기는 비노출(치트 방지).
                반면 이 경기 기록(골·슛·경고)은 중계로 이미 공개된 정보라 감춰 봐야 의미가 없다.
                킥오프 전에는 이벤트가 없으므로 아예 넘기지 않는다. */}
            <PlayerCard
              player={selected}
              side="away"
              star={keyIds.has(selected.id)}
              matchStats={engine.minute > 0 ? playerMatchStats(engine.events, selected.id) : undefined}
            />
          </div>
        )}
      </div>
    </section>
  )
}
