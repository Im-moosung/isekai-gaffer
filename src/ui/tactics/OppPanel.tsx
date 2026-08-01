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

/**
 * 브리핑 문안(styleNotes)에 이름이 나오는 선수를 **오늘 선발 / 오늘 벤치**로 가른다.
 *
 * ★ styleNotes는 대회 전체를 요약한 고정 문안이라 그날의 XI를 모른다. 그래서 체코 브리핑이
 *   "소우체크·시크·호리 등 장신 표적이 강점이나 슐츠 외 중앙 창의성이 부족해…"라고 하는데
 *   실제 선발에는 소우체크도 슐츠도 없는 일이 생겼다(감사 결함 ⑧). 문안을 지우면 팀 성향
 *   서술까지 함께 사라지고, 문장을 기계로 고쳐 쓰면 조사·어미가 깨진다.
 *   그래서 **문안은 그대로 두고 사실 관계만 아래 한 줄로 정정한다** — 실제 방송 브리핑도
 *   "오늘은 벤치입니다"를 덧붙이지 문장을 다시 쓰지 않는다.
 *
 * 매칭은 성(姓)이 아니라 **한국어 표기 전체 이름의 마지막 어절**로 한다(데이터의 name.ko는
 * "토마시 소우체크" 꼴이고 문안은 "소우체크"만 쓴다). 두 글자 이상만 후보로 삼아
 * 흔한 한 글자가 우연히 걸리는 것을 막는다.
 */
export function briefingRoster(
  notes: string | undefined,
  squad: readonly Player[],
  startingIds: readonly string[],
): { starters: string[]; bench: string[] } {
  if (!notes) return { starters: [], bench: [] }
  const on = new Set(startingIds)
  const starters: string[] = [], bench: string[] = []
  for (const p of squad) {
    const last = p.name.ko.split(' ').pop() ?? ''
    if (last.length < 2 || !notes.includes(last)) continue
    ;(on.has(p.id) ? starters : bench).push(last)
  }
  return { starters, bench }
}

/** 포메이션 상성(내 포메이션 vs 상대) → 한 줄 매치업 표기.
 *  edge>0이면 홈(유저) 우위. 부호·크기로 톤·문구를 결정(결정론).
 *
 *  ★ 2026-08-01: **고정 원인 힌트를 걷어냈다.**
 *  예전에는 우위에 "중원 수적 우위 예상", 열세에 "측면·뒷공간 주의"를 붙였다. 그런데
 *  `e3811a3`이 상성표를 순환 구조로 바꾸면서 **어느 축에서 이기고 지는지가 상대마다
 *  달라졌다** — 4-3-3이 4-4-2를 이기는 이유와 3-5-2가 4-3-3을 이기는 이유가 같지 않다.
 *  그래서 그 두 문장은 이제 사실이 아니다. 부호와 크기는 사실이므로 **수치로 적고**,
 *  "그래서 어디를 조심할 것인가"는 감독이 판단한다(원칙: 사실과 수치는 보여주고
 *  결론은 유저가 낸다). 원인을 말할 자격이 있는 것은 화자가 있는 코치 조언 쪽이다. */
export function matchupHint(edge: number): MatchupHint {
  const n = `${edge > 0 ? '+' : ''}${edge.toFixed(2)}`
  if (edge >= 0.04) return { tone: 'up', text: `포메이션 상성 우위 ${n}` }
  if (edge > 0) return { tone: 'up', text: `포메이션 상성 근소 우위 ${n}` }
  if (edge === 0) return { tone: 'even', text: '포메이션 상성 대등 0.00' }
  if (edge <= -0.04) return { tone: 'down', text: `포메이션 상성 열세 ${n}` }
  return { tone: 'down', text: `포메이션 상성 근소 열세 ${n}` }
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
  const roster = briefingRoster(styleNotes, away.team.squad, away.tactics.lineup.map(l => l.playerId))
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
        {/* 브리핑이 부른 이름과 오늘의 XI를 대조해 사실만 정정한다(문안은 건드리지 않는다). */}
        {roster.bench.length > 0 && (
          <p className="op__notes op__notes--correction" role="note">
            브리핑이 언급한 {roster.bench.join('·')}
            {roster.bench.length > 1 ? '는' : '은'} 오늘 선발이 아닙니다
            {roster.starters.length > 0 && ` (선발로 나온 이름: ${roster.starters.join('·')})`}.
          </p>
        )}
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
