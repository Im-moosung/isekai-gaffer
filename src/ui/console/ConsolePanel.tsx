import { useState, useEffect } from 'react'
import { canIntervene, useMatchStore } from '../../game/matchStore'
import type { Instructions } from '../../engine/types'
import './console.css'

// cost: 슬라이더 옆 트레이드오프 표시(⚡ 체력·⚠ 리스크). threshold 이상일 때 강조.
const AXES: { key: 'lineHeight' | 'pressing' | 'tempo'; label: string; cost?: { icon: string; text: string; threshold: number } }[] = [
  { key: 'lineHeight', label: '라인', cost: { icon: '⚠', text: '뒷공간 노출', threshold: 70 } },
  { key: 'pressing', label: '압박', cost: { icon: '⚡', text: '체력 소모 +40% · 지치면 파울 증가', threshold: 70 } },
  { key: 'tempo', label: '템포' },
]

const FOCUS: { value: Instructions['attackFocus']; label: string }[] = [
  { value: 'left', label: '좌측' },
  { value: 'center', label: '중앙' },
  { value: 'right', label: '우측' },
  { value: 'balanced', label: '균형' },
]

/** 감독 콘솔 — 지시 4축(라인/압박/템포 슬라이더 + 공격방향).
 *  경기 중(정지·하프타임)엔 로컬 draft로 편집하다 "지시 적용" → submitCommand.
 *  킥오프 전('pre')엔 즉시 반영 — 아래 `immediate` 주석 참조. */
export function ConsolePanel({ side }: { side: 'home' | 'away' }) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const current = engine?.[side].tactics.instructions
  const [draft, setDraft] = useState<Instructions>(
    () => current ?? { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  )
  const [error, setError] = useState<string | null>(null)

  // 킥오프 전(전술 센터)도 개입 창이다 — store의 판정을 그대로 따른다.
  const open = canIntervene(phase)

  /** 킥오프 전에는 시계가 멈춰 있다. "묶어서 결정"할 이유가 없고, 같은 화면의
   *  TacticsExtras·[추천 적용]은 이미 즉시 반영이라 두 모델이 섞이면 하단 검토 요약의
   *  "즉시 갱신" 약속이 4축에서만 깨진다. 그래서 'pre'에서는 로컬 draft를 쓰지 않고
   *  엔진 값을 직접 그린다 — 추천 적용 같은 외부 변경도 슬라이더에 곧바로 나타난다.
   *  경기 중에는 기존 2단계(draft → [지시 적용])를 그대로 유지한다: 정지된 시계 동안
   *  여러 축을 검토해 한 번에 내리는 것이 감독의 실제 결정 단위이기 때문이다. */
  const immediate = phase === 'pre'
  const shown = immediate ? (current ?? draft) : draft

  // 개입 창(정지·하프타임) 진입 시 현재 엔진 지시값을 draft 초기값으로 동기화.
  useEffect(() => {
    if (open && current) setDraft(current)
    // current는 진입 시점 값만 초기화 대상 — phase 전환에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const edit = (patch: Partial<Instructions>) => {
    const next = { ...shown, ...patch }
    if (!immediate) { setDraft(next); return }
    setDraft(next)
    const t = engine?.[side].tactics
    if (!t) return
    setError(null)
    try {
      // 슬라이더 드래그는 1스텝마다 change를 쏜다. instructions 명령은 스텝마다
      // 결정 로그를 남겨 기자회견 근거를 노이즈로 덮으므로, 로그를 만들지 않는
      // formation 명령으로 엔진만 갱신한다(applyCommand의 전술 교체 효과는 동일).
      submitCommand(side, { type: 'formation', tactics: { ...t, instructions: next } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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
        {AXES.map(({ key, label, cost }) => (
          <div key={key} className="cs-axis-wrap">
            <div className="cs-axis">
              <span className="cs-axis__label" aria-hidden="true">{label}</span>
              <input
                type="range"
                min={0}
                max={100}
                aria-label={label}
                value={shown[key]}
                disabled={!open}
                onChange={e => edit({ [key]: Number(e.target.value) })}
                className="cs-axis__range"
              />
              <span className="cs-axis__val">{shown[key]}</span>
            </div>
            {cost && (
              <p className={`cs-cost${shown[key] >= cost.threshold ? ' cs-cost--hot' : ''}`}>
                <span aria-hidden="true">{cost.icon}</span> {cost.text}
              </p>
            )}
          </div>
        ))}
        <div className="cs-axis cs-axis--focus">
          <span className="cs-axis__label" aria-hidden="true">공격방향</span>
          <select
            aria-label="공격방향"
            value={shown.attackFocus}
            disabled={!open}
            onChange={e => edit({ attackFocus: e.target.value as Instructions['attackFocus'] })}
            className="cs-axis__select"
          >
            {FOCUS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      </div>

      <div className="cs-panel__foot">
        {/* 즉시 반영 모드에선 버튼이 "아직 적용 안 됐다"는 거짓 신호가 되므로 감춘다. */}
        {immediate
          ? <span className="cs-live">조작 즉시 반영 — 하단 검토 요약에서 확인하십시오</span>
          : <button type="button" className="cs-btn" onClick={apply} disabled={!open}>지시 적용</button>}
        {!open && <span className="cs-lock">다음 개입 창까지 잠김</span>}
      </div>
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}
