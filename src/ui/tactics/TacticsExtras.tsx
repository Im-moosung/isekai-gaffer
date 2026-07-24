import { useMatchStore } from '../../game/matchStore'
import { MENTALITIES, ATTACK_PATTERNS } from '../../engine/tactics'
import type { AttackPattern, FormationId, GroupIntensity, Mentality, TacticState } from '../../engine/types'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}
const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}
const LINES: { key: keyof GroupIntensity; label: string }[] = [
  { key: 'attack', label: '공격' }, { key: 'midfield', label: '미드필드' }, { key: 'defense', label: '수비' },
]
const INTENSITY: { v: -1 | 0 | 1; label: string }[] = [
  { v: -1, label: '자제' }, { v: 0, label: '기본' }, { v: 1, label: '적극' },
]

const DEFAULT_GI: GroupIntensity = { attack: 0, midfield: 0, defense: 0 }

/** 확장 전술 지시 — 멘탈리티·그룹 적극성·공격 패턴·GK 파워플레이·페이즈 포메이션.
 *  각 컨트롤은 즉시 submitCommand({type:'formation'})로 tactics를 갱신한다(포메이션 셀렉터와 동일 패턴).
 *  4축 슬라이더(ConsolePanel)와 달리 별도 [적용] 버튼 없이 토글/버튼 즉시 반영.
 *  개입 창(정지·하프타임)에서만 활성. */
export function TacticsExtras({ side }: { side: 'home' | 'away' }) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const open = phase === 'halftime' || phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  const state = engine?.[side]
  if (!state) return null
  const t = state.tactics
  const mentality = t.mentality ?? 'balanced'
  const gi = t.groupIntensity ?? DEFAULT_GI
  const pattern = t.attackPattern ?? 'balanced'
  const gkPowerplay = t.gkPowerplay ?? false
  const pf = t.phaseFormations ?? {}

  // 부분 갱신 → 전체 tactics로 formation 명령 제출(엔진 applyCommand는 tactics 통째 교체).
  const patch = (p: Partial<TacticState>) => submitCommand(side, { type: 'formation', tactics: { ...t, ...p } })

  // GK 파워플레이 잠금 판정: 85'+ & 해당 side 지는 중에만 유효.
  const minute = engine!.minute
  const [own, opp] = side === 'home' ? [engine!.score[0], engine!.score[1]] : [engine!.score[1], engine!.score[0]]
  const losing = own < opp
  const ppUnlocked = minute >= 85 && losing
  const ppReason = minute < 85 ? "85' 이후에만" : !losing ? '지고 있을 때만' : ''

  return (
    <section className="tx-panel" aria-label="확장 전술 지시">
      {/* 멘탈리티 5버튼 */}
      <div className="tx-group" role="group" aria-label="멘탈리티">
        <h4 className="tx-group__title">멘탈리티</h4>
        <div className="tx-btnrow">
          {MENTALITIES.map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mentality}
              disabled={!open}
              className={`tx-btn${m === mentality ? ' tx-btn--active' : ''}`}
              onClick={() => patch({ mentality: m })}
            >
              {MENTALITY_KO[m]}
            </button>
          ))}
        </div>
      </div>

      {/* 그룹 적극성 3줄 */}
      <div className="tx-group" role="group" aria-label="그룹 적극성">
        <h4 className="tx-group__title">그룹 적극성</h4>
        {LINES.map(({ key, label }) => (
          <div key={key} className="tx-line">
            <span className="tx-line__label">{label}</span>
            <div className="tx-btnrow" role="group" aria-label={`${label} 적극성`}>
              {INTENSITY.map(({ v, label: il }) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={gi[key] === v}
                  disabled={!open}
                  className={`tx-btn tx-btn--sm${gi[key] === v ? ' tx-btn--active' : ''}`}
                  onClick={() => patch({ groupIntensity: { ...gi, [key]: v } })}
                >
                  {il}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 공격 패턴 4택 */}
      <div className="tx-group" role="group" aria-label="공격 패턴">
        <h4 className="tx-group__title">공격 패턴</h4>
        <div className="tx-btnrow">
          {ATTACK_PATTERNS.map(p => (
            <button
              key={p}
              type="button"
              aria-pressed={p === pattern}
              disabled={!open}
              className={`tx-btn${p === pattern ? ' tx-btn--active' : ''}`}
              onClick={() => patch({ attackPattern: p })}
            >
              {PATTERN_KO[p]}
            </button>
          ))}
        </div>
      </div>

      {/* GK 파워플레이 토글 */}
      <div className="tx-group" role="group" aria-label="GK 파워플레이">
        <h4 className="tx-group__title">GK 파워플레이</h4>
        <button
          type="button"
          aria-pressed={gkPowerplay}
          disabled={!open || !ppUnlocked}
          className={`tx-toggle${gkPowerplay ? ' tx-toggle--on' : ''}`}
          onClick={() => patch({ gkPowerplay: !gkPowerplay })}
        >
          {gkPowerplay ? '⚡ GK 전진 (도박)' : 'GK 전진'}
        </button>
        <p className="tx-hint">
          {ppUnlocked
            ? '세트피스 찬스 퀄 +40% · 역습 시 빈 골문 실점 위험 3배'
            : `🔒 ${ppReason} 가능`}
        </p>
      </div>

      {/* 페이즈 포메이션 3슬롯 (기본 + 공격 시 + 수비 시) */}
      <div className="tx-group" role="group" aria-label="페이즈 포메이션">
        <h4 className="tx-group__title">페이즈 포메이션</h4>
        <div className="tx-slot">
          <span className="tx-slot__label">기본</span>
          <span className="tx-slot__base">{t.formation}</span>
        </div>
        <div className="tx-slot">
          <span className="tx-slot__label">공격 시</span>
          <select
            aria-label="공격 시 포메이션"
            value={pf.attack ?? ''}
            disabled={!open}
            className="tx-slot__select"
            onChange={e => patch({ phaseFormations: { ...pf, attack: (e.target.value || undefined) as FormationId | undefined } })}
          >
            <option value="">기본 유지</option>
            {FORMATIONS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="tx-slot">
          <span className="tx-slot__label">수비 시</span>
          <select
            aria-label="수비 시 포메이션"
            value={pf.defense ?? ''}
            disabled={!open}
            className="tx-slot__select"
            onChange={e => patch({ phaseFormations: { ...pf, defense: (e.target.value || undefined) as FormationId | undefined } })}
          >
            <option value="">기본 유지</option>
            {FORMATIONS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
    </section>
  )
}
