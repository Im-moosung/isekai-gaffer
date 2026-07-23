import { useState, useEffect } from 'react'
import { useMatchStore } from '../../game/matchStore'
import type { Instructions } from '../../engine/types'
import './console.css'

const AXES: { key: 'lineHeight' | 'pressing' | 'tempo'; label: string }[] = [
  { key: 'lineHeight', label: '라인' },
  { key: 'pressing', label: '압박' },
  { key: 'tempo', label: '템포' },
]

const FOCUS: { value: Instructions['attackFocus']; label: string }[] = [
  { value: 'left', label: '좌측' },
  { value: 'center', label: '중앙' },
  { value: 'right', label: '우측' },
  { value: 'balanced', label: '균형' },
]

/** 감독 콘솔 — 지시 4축(라인/압박/템포 슬라이더 + 공격방향).
 *  로컬 draft로 편집하다 "지시 적용" → submitCommand. phase가 halftime/decision일 때만 활성. */
export function ConsolePanel({ side }: { side: 'home' | 'away' }) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const current = engine?.[side].tactics.instructions
  const [draft, setDraft] = useState<Instructions>(
    () => current ?? { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  )
  const [error, setError] = useState<string | null>(null)

  const open = phase === 'halftime' || phase === 'decision'

  // 개입 창(halftime/decision) 진입 시 현재 엔진 지시값을 draft 초기값으로 동기화.
  useEffect(() => {
    if (open && current) setDraft(current)
    // current는 진입 시점 값만 초기화 대상 — phase 전환에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const apply = () => {
    setError(null)
    try {
      submitCommand(side, { type: 'instructions', instructions: draft })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="cs-panel" aria-label="감독 콘솔 — 지시">
      <h3 className="cs-panel__title">전술 지시</h3>
      <div className="cs-axes">
        {AXES.map(({ key, label }) => (
          <div key={key} className="cs-axis">
            <span className="cs-axis__label" aria-hidden="true">{label}</span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label={label}
              value={draft[key]}
              disabled={!open}
              onChange={e => setDraft(d => ({ ...d, [key]: Number(e.target.value) }))}
              className="cs-axis__range"
            />
            <span className="cs-axis__val">{draft[key]}</span>
          </div>
        ))}
        <div className="cs-axis cs-axis--focus">
          <span className="cs-axis__label" aria-hidden="true">공격방향</span>
          <select
            aria-label="공격방향"
            value={draft.attackFocus}
            disabled={!open}
            onChange={e => setDraft(d => ({ ...d, attackFocus: e.target.value as Instructions['attackFocus'] }))}
            className="cs-axis__select"
          >
            {FOCUS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      </div>

      <div className="cs-panel__foot">
        <button type="button" className="cs-btn" onClick={apply} disabled={!open}>지시 적용</button>
        {!open && <span className="cs-lock">다음 개입 창까지 잠김</span>}
      </div>
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}
