import { interventionLevel, useMatchStore } from '../../game/matchStore'
import { MENTALITIES, ATTACK_PATTERNS, BOX_LOADS, SET_PIECE_ROUTES } from '../../engine/tactics'
import { counterRiskScale } from '../../engine/simulate'
import { zoneStrength } from '../../engine/strength'
import { setPieceScore } from '../../game/scouting'
import type {
  AttackPattern, BoxLoad, FormationId, GroupIntensity, Mentality, SetPieceMarking,
  SetPiecePlan, SetPieceRoute, SideState, TacticState,
} from '../../engine/types'

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

// ── 세트피스 (2026-08-01) ────────────────────────────────────────────
// 엔진에는 `TacticState.setPiece`(루트·박스 인원·마킹)가 있고 ff0a1c9가 이 축을
// **상대 의존**으로 만들었다(상대 GK 제공권이 루트를, 역습 위험 지수가 인원을 가른다).
// recommendPlan도 이 축을 고른다. 그런데 유저가 볼 수도 바꿀 수도 없었다 — 기획서
// 차별점 3번("상대마다 다른 정답, 그리고 그 검증")의 축 하나가 화면에 없었던 셈이다.
//
// 왜 여기(TacticsExtras)인가: 세트피스 루틴은 훈련장에서 약속하는 구조다. 페이즈
// 포메이션·태세와 같은 등급('full')이고, 두 화면(워룸·작전판)이 같은 컨트롤을 써야
// 유저가 한 번만 배운다. 이 컴포넌트가 이미 그 역할을 하고 있다.
const ROUTE_KO: Record<SetPieceRoute, string> = { near: '니어', far: '파', short: '짧게' }
const LOAD_KO: Record<BoxLoad, string> = { light: '적게', normal: '표준', heavy: '많이' }
const MARKINGS: readonly SetPieceMarking[] = ['zonal', 'man']
const MARKING_KO: Record<SetPieceMarking, string> = { zonal: '존', man: '맨투맨' }
const DEFAULT_SP: Required<SetPiecePlan> = { route: 'far', boxLoad: 'normal', marking: 'zonal' }

/** 상대 선발 GK의 제공권. 루트 선택의 유일한 판별자다(engine/tactics의 K_NEAR_AERIAL).
 *  스쿼드 최댓값이 아니라 **실제 출전 중인** GK를 본다 — 프랑스는 스쿼드 최대 82인데
 *  선발은 76이라, 최댓값을 쓰면 화면이 엔진과 다른 근거를 말하게 된다. */
function oppGkAerialOf(opp: SideState): number {
  const gkId = opp.tactics.lineup.find(l => l.slot === 'GK')?.playerId
  const gk = gkId ? opp.team.squad.find(p => p.id === gkId) : undefined
  return gk?.gkStats?.aerial ?? 25
}

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
  const sp = { ...DEFAULT_SP, ...(t.setPiece ?? {}) }

  // 부분 갱신 → 전체 tactics로 formation 명령 제출(엔진 applyCommand는 tactics 통째 교체).
  const patch = (p: Partial<TacticState>) => submitCommand(side, { type: 'formation', tactics: { ...t, ...p } })

  // GK 파워플레이 잠금 판정: 85'+ & 해당 side 지는 중에만 유효.
  const minute = engine!.minute
  const [own, opp] = side === 'home' ? [engine!.score[0], engine!.score[1]] : [engine!.score[1], engine!.score[0]]
  const losing = own < opp
  const ppUnlocked = minute >= 85 && losing
  const ppReason = minute < 85 ? "85' 이후에만" : !losing ? '지고 있을 때만' : ''

  // 세트피스 판별자 — 엔진이 쓰는 것과 **같은 두 값**을 화면에도 그대로 적는다.
  // 추천을 조용히 적용하는 대신 근거를 보이고 유저가 뒤집을 수 있게 하는 것이 이 UI의 목적이다.
  const oppState = engine![side === 'home' ? 'away' : 'home']
  const gkAerial = oppGkAerialOf(oppState)
  const risk = counterRiskScale(zoneStrength(state), zoneStrength(oppState))
  let bestRoute: SetPieceRoute = 'far', bestLoad: BoxLoad = 'normal', bestScore = 0
  for (const r of SET_PIECE_ROUTES) for (const b of BOX_LOADS) {
    const s = setPieceScore(r, b, gkAerial, risk)
    if (s > bestScore) { bestScore = s; bestRoute = r; bestLoad = b }
  }

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

      {/* 세트피스 3축 — 코너 루트 · 박스 인원 · 우리 박스 마킹.
          앞의 둘은 **우리가 공격할 때**, 마킹은 **상대가 찰 때** 쓰는 지시다. 한 묶음에
          두되 소제목으로 방향을 갈라 준다 — 섞이면 "왜 마킹이 전환에 영향이 없지"가 된다. */}
      <div className="tx-group" role="group" aria-label="세트피스">
        <h4 className="tx-group__title">세트피스</h4>
        {/* 판별자를 먼저 적는다. 추천만 보여주면 왜 그 추천인지를 알 수 없고,
            "상대마다 다른 정답"이라는 주장이 검증 불가능한 말이 된다. */}
        <p className="tx-hint">
          상대 GK 제공권 <span className="num">{gkAerial}</span>
          {' · '}역습 위험 지수 <span className="num">{risk.toFixed(2)}</span>
          {' — '}추천 {ROUTE_KO[bestRoute]} · 박스 {LOAD_KO[bestLoad]}
        </p>
        <SetPieceRow
          label="코너 루트"
          values={SET_PIECE_ROUTES}
          ko={ROUTE_KO}
          value={sp.route}
          recommended={bestRoute}
          disabled={!open}
          onPick={v => patch({ setPiece: { ...sp, route: v } })}
        />
        <SetPieceRow
          label="박스 인원"
          values={BOX_LOADS}
          ko={LOAD_KO}
          value={sp.boxLoad}
          recommended={bestLoad}
          disabled={!open}
          onPick={v => patch({ setPiece: { ...sp, boxLoad: v } })}
        />
        <SetPieceRow
          label="수비 마킹"
          values={MARKINGS}
          ko={MARKING_KO}
          value={sp.marking}
          disabled={!open}
          onPick={v => patch({ setPiece: { ...sp, marking: v } })}
        />
        <p className="tx-hint">
          {sp.route === 'near' ? '니어 혼전 — 전환 ↑, 클리어가 짧게 떨어져 역습 노출 ↑. 상대 GK가 니어를 지배하면 손해입니다.'
            : sp.route === 'short' ? '짧게 빼기 — 전환은 낮지만 점유를 지켜 역습을 내주지 않습니다.'
            : '파포스트 — 키퍼의 손이 닿지 않는 곳. 기준값(전 배수 1.0)입니다.'}
          {' '}
          {sp.boxLoad === 'heavy' ? '박스에 사람을 더 넣습니다 — 역습 노출이 위험 지수만큼 커집니다.'
            : sp.boxLoad === 'light' ? '박스 인원을 줄여 뒤를 남깁니다 — 전환은 내주고 역습을 막습니다.'
            : '박스 인원은 표준입니다.'}
          {' '}
          {sp.marking === 'man'
            ? '맨투맨은 상대 공중 위협이 높을수록 유리하고, 낮으면 세컨볼을 내줍니다.'
            : '존 수비는 세컨볼에 강하지만 큰 상대에게는 밀립니다.'}
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

/** 세트피스 한 줄 — 라벨 + 배타 선택 세그먼트. 추천 값에는 "추천" 태그를 붙인다.
 *  ★ 추천은 **표시**지 자동 적용이 아니다. 유저가 뒤집을 수 있어야 상대별 정답이
 *    검증 가능한 주장이 된다(추천을 조용히 적용하던 것이 원래 결함이었다). */
function SetPieceRow<T extends string>({ label, values, ko, value, recommended, disabled, onPick }: {
  label: string
  values: readonly T[]
  ko: Record<T, string>
  value: T
  recommended?: T
  disabled: boolean
  onPick(v: T): void
}) {
  return (
    <div className="tx-line">
      <span className="tx-line__label">{label}</span>
      <div className="tx-btnrow" role="group" aria-label={label}>
        {values.map(v => (
          <button
            key={v}
            type="button"
            aria-pressed={v === value}
            disabled={disabled}
            className="tx-btn tx-btn--sm"
            // 같은 화면에 "니어"가 두 번 나오지는 않지만, 추천 태그가 접근성 이름에
            // 섞이면 테스트·스크린리더가 라벨을 특정하지 못한다 — 이름은 순수하게 값이다.
            aria-label={`${label} ${ko[v]}`}
            onClick={() => onPick(v)}
          >
            {ko[v]}
            {recommended === v && <span className="tx-btn__rec" aria-hidden="true">추천</span>}
          </button>
        ))}
      </div>
    </div>
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
