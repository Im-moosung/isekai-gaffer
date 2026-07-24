import { useState, useEffect } from 'react'
import type { Team } from '../../engine/types'
// 예외 승인(계약 Task 7): 승부차기는 matchStore 상태 머신과 무관한 독립 순수 함수이므로
// UI에서 simulateShootout을 직접 호출한다(엔진 경유 원칙의 명시적 예외).
import { simulateShootout, type ShootoutKick } from '../../engine/shootout'
import { type Dir, DIRS, N_KICKERS, fieldPlayers, topPenaltyIds, buildShootoutParams } from './shootout-setup'
import './match.css'

const DIR_LABEL: Record<Dir, string> = { left: '좌', center: '중', right: '우' }

/** 승부차기 패널 — 홈 키커 5인 순서·방향 선택 → simulateShootout → 킥 순차 연출 → onDone.
 *  홈 GK 다이빙 방향은 엔진(simulateShootout)이 RNG로 결정하므로 UI 선택 항목이 아니다(순수 함수 계약). */
export function ShootoutPanel({ home, away, seed, onDone }: {
  home: Team; away: Team; seed: number; onDone(result: [number, number]): void
}) {
  const [kickerIds, setKickerIds] = useState<string[]>(() => topPenaltyIds(home))
  const [dirs, setDirs] = useState<Dir[]>(() => Array.from({ length: N_KICKERS }, (_, i) => DIRS[i % 3]))
  const [started, setStarted] = useState(false)
  const [kicks, setKicks] = useState<ShootoutKick[]>([])
  const [revealed, setRevealed] = useState(0)

  const field = fieldPlayers(home)
  const byId = (id: string) => home.squad.find(p => p.id === id)

  // 킥 순차 연출: 0.8초 간격으로 한 킥씩 공개, 전부 공개되면 onDone.
  useEffect(() => {
    if (!started) return
    if (revealed >= kicks.length) {
      const done = kicks.filter(k => k.side === 'home' && k.scored).length
      const doneAway = kicks.filter(k => k.side === 'away' && k.scored).length
      const id = setTimeout(() => onDone([done, doneAway]), 800)
      return () => clearTimeout(id)
    }
    const id = setTimeout(() => setRevealed(r => r + 1), 800)
    return () => clearTimeout(id)
  }, [started, revealed, kicks, onDone])

  function start() {
    const result = simulateShootout(buildShootoutParams({ home, away, seed, kickerIds, dirs }))
    setKicks(result.kicks)
    setRevealed(0)
    setStarted(true)
  }

  function setKicker(slot: number, id: string) {
    setKickerIds(prev => {
      const next = [...prev]
      // 다른 슬롯이 이미 그 선수를 쓰면 서로 교환(중복 방지).
      const dup = next.indexOf(id)
      if (dup >= 0) next[dup] = next[slot]
      next[slot] = id
      return next
    })
  }

  function cycleDir(slot: number) {
    setDirs(prev => {
      const next = [...prev]
      next[slot] = DIRS[(DIRS.indexOf(next[slot]) + 1) % 3]
      return next
    })
  }

  const shown = kicks.slice(0, revealed)
  const homeScore = shown.filter(k => k.side === 'home' && k.scored).length
  const awayScore = shown.filter(k => k.side === 'away' && k.scored).length

  return (
    <div className="so-panel">
      <h2 className="ms-overlay__title">승부차기</h2>

      {!started ? (
        <>
          <p className="ms-overlay__note">키커 5인의 순서와 방향을 정하세요 (기본: 페널티 상위 5인)</p>
          <ol className="so-setup" aria-label="키커 순서">
            {kickerIds.map((id, i) => (
              <li key={i} className="so-slot">
                <span className="so-slot__no">{i + 1}</span>
                <select
                  className="so-slot__pick"
                  aria-label={`${i + 1}번 키커`}
                  value={id}
                  onChange={e => setKicker(i, e.target.value)}
                >
                  {field.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name.ko} (PK {p.penalty})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="so-slot__dir"
                  aria-label={`${i + 1}번 방향 ${DIR_LABEL[dirs[i]]}`}
                  onClick={() => cycleDir(i)}
                >
                  {DIR_LABEL[dirs[i]]}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="ms-btn ms-btn--primary" onClick={start}>
            승부차기 시작
          </button>
        </>
      ) : (
        <>
          <div className="ms-final">
            <span className="ms-final__code">{home.fifaCode}</span>
            <span className="ms-final__score">{homeScore} : {awayScore}</span>
            <span className="ms-final__code">{away.fifaCode}</span>
          </div>
          <ul className="so-kicks" aria-label="승부차기 진행">
            {shown.map((k, i) => {
              const label = k.side === 'home'
                ? (byId(k.playerId)?.name.ko ?? k.playerId)
                : away.name.ko
              return (
                <li key={i} className={`so-kick so-kick--${k.side} so-kick--${k.scored ? 'goal' : 'miss'}`}>
                  <span className="so-kick__who">{label}</span>
                  <span className="so-kick__mark">{k.scored ? '⚽ 성공' : '✕ 실패'}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
