import {
  interventionLevel, nextBreakMinute, useMatchStore,
  SHOUT_COOLDOWN, TOUCHLINE_RANK_STEP,
} from '../../game/matchStore'
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
// 왜 여기(TacticsExtras)인가: 태세·적극성·패턴과 같은 성격의 지시이고, 두 화면
// (워룸·작전판)이 같은 컨트롤을 써야 유저가 한 번만 배운다.
//
// ★ 등급 재판정(2026-08-01 확장 개방): 예전에는 "세트피스 루틴은 훈련장에서 약속하는
//   구조"라며 페이즈 포메이션과 같은 'full' 등급에 두었다. 그러나 훈련장에서 약속하는
//   것은 **루틴 자체**이고, 코너 앞에서 감독이 하는 일은 **이미 약속된 것 중 하나를
//   고르는** 것이다(실제로도 손짓 하나로 전달된다). 새 루틴을 발명하는 것이 아니므로
//   터치라인에서 연다. 대형 재배치가 아니라는 것이 판정의 기준이다.
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

/** 확장 전술 지시 — 멘탈리티·그룹 적극성·공격 패턴·GK 파워플레이·세트피스·페이즈 포메이션.
 *  각 컨트롤은 즉시 submitCommand({type:'formation'})로 tactics를 갱신한다(포메이션 셀렉터와 동일 패턴).
 *  4축 슬라이더(ConsolePanel)와 달리 별도 [적용] 버튼 없이 토글/버튼 즉시 반영.
 *
 *  ★ 2026-08-01 확장 개방 — 잠금을 **축별로** 쪼갠다.
 *   예전에는 `level === 'full'` 하나로 전 컨트롤을 잠갔다. 그런데 태세·적극성·패턴·세트피스는
 *   "같은 대형 안에서 어떻게 행동할지"라 터치라인에서 소리쳐 전달되는 지시다. 잠기는 것은
 *   **대형**(페이즈 포메이션)뿐이다 — 판정 정본은 store의 touchlineTacticsError다.
 *   서열 축(멘탈리티·그룹 적극성)에는 한 번에 ±1단계 제한이 붙고, 기준점은 **개입이
 *   시작된 시점의 스냅샷**(touchlineWindow)이다. 그래서 버튼도 그 기준으로 잠근다. */
export function TacticsExtras({ side }: { side: 'home' | 'away' }) {
  const phase = useMatchStore(s => s.phase)
  const pauseReason = useMatchStore(s => s.pauseReason)
  const engine = useMatchStore(s => s.engine)
  const schedule = useMatchStore(s => s.schedule)
  const lastShoutMinute = useMatchStore(s => s.lastShoutMinute)
  const touchlineWindow = useMatchStore(s => s.touchlineWindow)
  const submitCommand = useMatchStore(s => s.submitCommand)

  // 킥오프 전(전술 센터)도 개입 창이다 — store의 판정을 그대로 따른다.
  const level = interventionLevel(phase, pauseReason)
  const full = level === 'full'
  const touchline = level === 'touchline'
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

  const minute = engine!.minute
  const [own, opp] = side === 'home' ? [engine!.score[0], engine!.score[1]] : [engine!.score[1], engine!.score[0]]
  const losing = own < opp

  // ── 개입 자원 상태 ────────────────────────────────────────────────
  // 같은 분에 열린 창 안이면 추가 비용이 없다(ConsolePanel과 같은 규칙).
  const windowOpen = !!touchlineWindow && touchlineWindow.minute === minute && touchlineWindow.side === side
  const cooldownLeft = touchline && !windowOpen && lastShoutMinute !== null
    ? Math.max(0, SHOUT_COOLDOWN - (minute - lastShoutMinute))
    : 0
  const onCooldown = cooldownLeft > 0
  /** 터치라인에서 열리는 축의 공통 활성 조건. */
  const liveOpen = full || (touchline && !onCooldown)
  const nextBreak = nextBreakMinute(minute, schedule)
  const breakTail = nextBreak === null
    ? '남은 브레이크가 없습니다'
    : `다음 브레이크(${nextBreak}분)에서`

  // ── 서열 축 폭 제한(한 번에 ±1단계) ─────────────────────────────
  // 기준은 창 스냅샷 — 현재값 기준이면 같은 개입 안에서 여러 번 눌러 끝에서 끝까지 간다.
  const baseTactics = windowOpen && touchlineWindow ? touchlineWindow.tactics : t
  const baseMentalityRank = MENTALITIES.indexOf(baseTactics.mentality ?? 'balanced')
  const baseGi = { ...DEFAULT_GI, ...(baseTactics.groupIntensity ?? {}) }
  /** 이 멘탈리티를 지금 고를 수 있는가(터치라인 한정 ±1단계). */
  const mentalityPickable = (m: Mentality) =>
    !touchline || Math.abs(MENTALITIES.indexOf(m) - baseMentalityRank) <= TOUCHLINE_RANK_STEP
  const intensityPickable = (line: keyof GroupIntensity, v: -1 | 0 | 1) =>
    !touchline || Math.abs(v - baseGi[line]) <= TOUCHLINE_RANK_STEP

  // ── GK 파워플레이 잠금 판정 ──────────────────────────────────────
  // ★ 결함 수정(2026-08-01): 예전에는 버튼이 `!open || !ppUnlocked`로 막히는데 안내문은
  //   ppUnlocked만 봤다. 85분이 지나면 "해제됐다"는 문구가 뜬 채 버튼은 등급 잠금으로
  //   죽어 있었다 — "조건은 충족됐다는데 눌리지 않는" 모순이다. 잠금 조건이 여럿이면
  //   **지금 막고 있는 조건**을 말해야 한다(ShoutBar 선례: 이유 없는 disabled는 고장으로 읽힌다).
  // 끄는 것은 조건과 무관하게 허용한다 — 위험한 상태를 되돌리는 길까지 막을 이유가 없다.
  const ppEngineBlock = gkPowerplay ? null : minute < 85 ? "85' 이후에만 효과가 있습니다" : !losing ? '지고 있을 때만 효과가 있습니다' : null
  const ppResourceBlock = liveOpen ? null
    : onCooldown ? `개입 쿨다운 — ${cooldownLeft}분 남음`
    : `지금은 개입 창이 아닙니다 — ${breakTail}`
  // 두 조건이 동시에 막을 수 있으므로 **둘 다** 적는다. 하나만 적으면 그 하나를 풀었는데도
  // 여전히 눌리지 않는 같은 결함이 재발한다.
  const ppBlocks = [ppResourceBlock, ppEngineBlock].filter((x): x is string => !!x)
  const ppDisabled = ppBlocks.length > 0

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
      {/* 터치라인에서 지금 무엇이 열려 있고 무엇이 제한되는지 — 화면이 먼저 말한다. */}
      {touchline && (
        <p className="tx-hint" role="status">
          {onCooldown
            ? `터치라인 지시 쿨다운 — ${cooldownLeft}분 뒤에 다시 외칠 수 있습니다(외침·감독 타임과 같은 시계).`
            : `경기 중에도 태세·적극성·패턴·세트피스를 소리쳐 전달합니다 — 서열 축은 한 번에 ±${TOUCHLINE_RANK_STEP}단계. 대형(페이즈 포메이션)만 ${breakTail} 바꿀 수 있습니다.`}
        </p>
      )}

      {/* 멘탈리티 5버튼 */}
      <div className="tx-group" role="group" aria-label="멘탈리티">
        <h4 className="tx-group__title">멘탈리티</h4>
        <div className="tx-btnrow">
          {MENTALITIES.map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mentality}
              // 두 겹의 잠금 — 개입 자원(창·쿨다운)과 폭 제한(±1단계). 아래 안내가 둘을 구분한다.
              disabled={!liveOpen || !mentalityPickable(m)}
              className="tx-btn"
              onClick={() => patch({ mentality: m })}
            >
              {MENTALITY_KO[m]}
            </button>
          ))}
        </div>
        {touchline && liveOpen && (
          <p className="tx-hint">
            한 번에 한 단계씩 — 지금은 <b>{MENTALITY_KO[baseTactics.mentality ?? 'balanced']}</b>의 양옆까지입니다.
          </p>
        )}
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
                  disabled={!liveOpen || !intensityPickable(key, v)}
                  className="tx-btn tx-btn--sm"
                  onClick={() => patch({ groupIntensity: { ...gi, [key]: v } })}
                >
                  {il}
                </button>
              ))}
            </div>
          </div>
        ))}
        {touchline && liveOpen && (
          <p className="tx-hint">한 라인당 한 번에 한 단계씩 — 자제에서 적극으로 한 번에 갈 수는 없습니다.</p>
        )}
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
              // 범주 축이라 폭 개념이 없다 — 열려 있거나 닫혀 있거나 둘 중 하나다.
              disabled={!liveOpen}
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
          disabled={ppDisabled}
          className="tx-toggle"
          onClick={() => patch({ gkPowerplay: !gkPowerplay })}
        >
          GK 전진
        </button>
        <p className="tx-hint">
          {ppDisabled
            ? `잠김 — ${ppBlocks.join(' · ')}`
            : '세트피스 찬스 퀄 +40% · 역습 시 빈 골문 실점 위험 3배'}
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
          disabled={!liveOpen}
          onPick={v => patch({ setPiece: { ...sp, route: v } })}
        />
        <SetPieceRow
          label="박스 인원"
          values={BOX_LOADS}
          ko={LOAD_KO}
          value={sp.boxLoad}
          recommended={bestLoad}
          disabled={!liveOpen}
          onPick={v => patch({ setPiece: { ...sp, boxLoad: v } })}
        />
        <SetPieceRow
          label="수비 마킹"
          values={MARKINGS}
          ko={MARKING_KO}
          value={sp.marking}
          disabled={!liveOpen}
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
          disabled={!full}
          onPick={f => patch({ phaseFormations: { ...pf, attack: f } })}
        />
        <PhaseFormationRow
          label="수비 시"
          value={pf.defense}
          disabled={!full}
          onPick={f => patch({ phaseFormations: { ...pf, defense: f } })}
        />
        {/* 이 패널에서 유일하게 잠기는 축이다 — 왜 잠겼고 언제 풀리는지를 반드시 말한다.
            나머지가 전부 열려 있는 화면에서 이유 없이 죽어 있으면 고장으로 읽힌다. */}
        {!full && (
          <p className="tx-hint">
            잠김 — 페이즈 포메이션도 <b>대형</b>입니다. 열한 명의 좌표를 다시 그리는 일은
            {' '}선수를 모아 놓고 해야 합니다. {breakTail} 바꿀 수 있습니다.
          </p>
        )}
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
