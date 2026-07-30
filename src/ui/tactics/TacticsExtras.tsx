import { interventionLevel, useMatchStore } from '../../game/matchStore'
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
  const pauseReason = useMatchStore(s => s.pauseReason)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)

  // 킥오프 전(전술 센터)도 개입 창이다 — store의 판정을 그대로 따른다.
  // 확장 전술도 구조 변경이라 '전원 소집' 등급에서만 열린다(터치라인에선 열람만).
  const open = interventionLevel(phase, pauseReason) === 'full'
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
              className="tx-btn"
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
                  className="tx-btn tx-btn--sm"
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
              className="tx-btn"
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
        {/* 이모지를 아이콘으로 쓰지 않는다 — OS마다 모양·크기가 달라 톤이 무너진다.
            방송 관례도 카드 아이콘 대신 평문 배너를 쓴다. */}
        <button
          type="button"
          aria-pressed={gkPowerplay}
          disabled={!open || !ppUnlocked}
          className="tx-toggle"
          onClick={() => patch({ gkPowerplay: !gkPowerplay })}
        >
          GK 전진
        </button>
        <p className="tx-hint">
          {ppUnlocked
            ? '세트피스 찬스 퀄 +40% · 역습 시 빈 골문 실점 위험 3배'
            : `잠김 — ${ppReason} 가능`}
        </p>
      </div>

      {/* 페이즈 포메이션 3슬롯 (기본 + 공격 시 + 수비 시).
          네이티브 select를 쓰지 않는다 — OS 기본 스타일이 그대로 튀어나오고,
          7개짜리 배타 선택은 열지 않고도 현재 값과 후보를 함께 보이는 편이 낫다. */}
      <div className="tx-group" role="group" aria-label="페이즈 포메이션">
        <h4 className="tx-group__title">페이즈 포메이션</h4>
        <div className="tx-slot">
          <span className="tx-slot__label">기본</span>
          <span className="tx-slot__base num">{t.formation}</span>
        </div>
        <PhaseFormationRow
          label="공격 시"
          value={pf.attack}
          disabled={!open}
          onPick={f => patch({ phaseFormations: { ...pf, attack: f } })}
        />
        <PhaseFormationRow
          label="수비 시"
          value={pf.defense}
          disabled={!open}
          onPick={f => patch({ phaseFormations: { ...pf, defense: f } })}
        />
      </div>
    </section>
  )
}

/** 페이즈 포메이션 한 줄 — "기본 유지" + 6종 세그먼트. */
function PhaseFormationRow({ label, value, disabled, onPick }: {
  label: string
  value: FormationId | undefined
  disabled: boolean
  onPick(f: FormationId | undefined): void
}) {
  return (
    <div className="tx-slot tx-slot--seg">
      <span className="tx-slot__label">{label}</span>
      <div className="tx-btnrow" role="group" aria-label={`${label} 포메이션`}>
        <button
          type="button"
          aria-pressed={value == null}
          disabled={disabled}
          className="tx-btn tx-btn--sm"
          aria-label={`${label} 기본 유지`}
          onClick={() => onPick(undefined)}
        >
          기본 유지
        </button>
        {FORMATIONS.map(f => (
          <button
            key={f}
            type="button"
            aria-pressed={value === f}
            disabled={disabled}
            className="tx-btn tx-btn--sm num"
            // 같은 페이지에 선발 포메이션 세그먼트가 이미 있다 — 접근성 이름을
            // 구분해야 스크린리더도 테스트도 "어느 4-4-2인지"를 가릴 수 있다.
            aria-label={`${label} ${f}`}
            onClick={() => onPick(f)}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  )
}
