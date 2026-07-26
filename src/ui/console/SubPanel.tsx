import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import { MAX_SUBS, MAX_SUB_WINDOWS } from '../../engine/simulate'
import type { MatchEvent, Player, SideState } from '../../engine/types'
import { playerMatchStats, hasPlayerMatchStats, type PlayerMatchStats } from '../../game/playerStats'
import './console.css'

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

  // 교체 기회(IFAB Law 3: 경기당 3회, UI 표기는 "교체 기회") — 하프타임 교체는 기회를
  // 소모하지 않고, 같은 분의 복수 교체는 이미 연 기회에 묶인다.
  // ★ 패널을 여는 것 자체는 어떤 상황에서도 막지 않는다. 선수 체력·개인 기록 확인은
  //   감독이 벤치에서 늘 하는 일이고, 차감되는 것은 실제 교체를 확정했을 때뿐이다.
  const windowsUsed = state.subWindowsUsed ?? 0
  const halftime = phase === 'halftime'
  const minute = engine?.minute ?? 0
  // 하프타임이 아직 오지 않았다면 "하프타임에는 기회 소모 없이" 안내가 참이다.
  // 이미 지났다면 그 문장은 거짓이 되므로 문구를 분기한다.
  const beforeHalftime = minute < 45
  const sameWindow = state.lastSubMinute !== undefined && state.lastSubMinute === minute
  const noWindow = windowsUsed >= MAX_SUB_WINDOWS && !halftime && !sameWindow

  const ready = !!out && !!inSel && !noWindow && state.subsUsed < MAX_SUBS

  return (
    <section className="cs-panel cs-sub" aria-label="교체">
      <div className="cs-panel__head">
        <h3 className="cs-panel__title">교체</h3>
        {/* 남은 인원과 남은 기회를 함께 — 인원이 남아도 기회가 없으면 못 바꾼다.
            둘 중 하나만 보여주면 [교체 확정]이 거부되는 이유를 알 수 없다. */}
        <span className="cs-sub__count">
          교체 {state.subsUsed}/{MAX_SUBS}명 · 교체 기회 {windowsUsed}/{MAX_SUB_WINDOWS}회
        </span>
      </div>

      {noWindow && (
        <p className="cs-sub__locked" role="status">
          {beforeHalftime
            ? `교체 기회 ${MAX_SUB_WINDOWS}회를 모두 사용했습니다. 하프타임에는 기회 소모 없이 교체할 수 있습니다.`
            : `교체 기회 ${MAX_SUB_WINDOWS}회를 모두 사용했습니다. 이번 경기에서는 더 이상 교체할 수 없습니다.`}
        </p>
      )}
      {halftime && (
        <p className="cs-sub__hint">하프타임 교체는 교체 기회를 소모하지 않습니다.</p>
      )}
      {!halftime && sameWindow && (
        <p className="cs-sub__hint">
          {state.lastSubMinute}분 교체와 같은 기회로 묶입니다 — 지금 더 바꿔도 기회를 쓰지 않습니다.
        </p>
      )}

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
        {!open && <span className="cs-lock">다음 브레이크까지 잠김</span>}
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
