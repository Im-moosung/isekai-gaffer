import { useState, useEffect, useRef } from 'react'
import {
  interventionLevel, touchlineOrderError, useMatchStore,
  INTERVENTION_COOLDOWN, TOUCHLINE_STEP,
} from '../../game/matchStore'
import type { Instructions } from '../../engine/types'
import '../shell/shell.css'
import './console.css'

// cost: 슬라이더 아래 트레이드오프 표시. threshold 이상일 때 강조.
// 이모지(⚠·⚡) 대신 평문 한글 태그를 쓴다 — OS마다 모양·크기가 달라 톤이 무너지고,
// 방송 관례도 카드 아이콘 대신 "DOWN TO 10 PLAYERS" 같은 평문 배너를 쓴다.
// ★ 라인 경고 문구는 **양면으로** 적는다. 예전엔 "주의 · 뒷공간 노출"뿐이라 앱이
//   "높은 라인 = 나쁜 선택"이라고 말하는 것처럼 읽혔고, 같은 앱의 코치가 하프타임에
//   "라인 95까지 올립시다"라고 하면 앱이 자기 자신과 싸우는 화면이 됐다(감사 결함 ③).
//   실측은 잉글랜드·프랑스 상대의 최적이 라인 최상단임을 보였다(game/scouting.ts 주석).
//   경고는 "하지 마라"가 아니라 **대가를 알고 걸어라**여야 한다.
const AXES: { key: 'lineHeight' | 'pressing' | 'tempo'; label: string; cost?: { tag: string; text: string; threshold: number } }[] = [
  { key: 'lineHeight', label: '라인', cost: { tag: '거래', text: '뒷공간 노출 ↔ 전방 차단 이득', threshold: 70 } },
  { key: 'pressing', label: '압박', cost: { tag: '체력', text: '체력 소모 +40% · 지치면 파울 증가', threshold: 70 } },
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
 *  킥오프 전('pre')엔 즉시 반영 — 아래 `immediate` 주석 참조.
 *
 *  ★ 개입 등급 2층을 축 단위로 반영한다(2026-08-01 확장 개방):
 *   · 전원 소집('full') — 4축 전부, 폭 제한 없음.
 *   · 터치라인('touchline') — **4축 전부 열린다.** 수치 3축은 한 번에 ±TOUCHLINE_STEP,
 *     공격방향은 범주 축이라 폭 제한이 없다. 개입 자원(10분 시계)은 감독 타임과 공유하고
 *     (외침은 별도의 5분 시계다), 같은 분에 열린 창(touchlineWindow) 안에서는 추가 비용이 없다.
 *  판정 규칙은 store의 touchlineOrderError가 정본이다. 화면이 따로 판정하면
 *  "누를 수는 있는데 store가 거부하는" 조합이 생긴다.
 *
 *  @param onPreview 편집 중인 draft를 상위(작전판)에 흘린다 — 보드가 [지시 적용] 전에
 *   미리 그려 "무엇을 바꾸는지"를 즉시 보여주기 위한 채널이다. 값은 반영되지 않는다. */
export function ConsolePanel({ side, onPreview }: {
  side: 'home' | 'away'
  onPreview?: (draft: Instructions | null) => void
}) {
  const phase = useMatchStore(s => s.phase)
  const pauseReason = useMatchStore(s => s.pauseReason)
  const engine = useMatchStore(s => s.engine)
  const lastInterventionMinute = useMatchStore(s => s.lastInterventionMinute)
  const touchlineWindow = useMatchStore(s => s.touchlineWindow)
  const submitCommand = useMatchStore(s => s.submitCommand)

  const current = engine?.[side].tactics.instructions
  const [draft, setDraft] = useState<Instructions>(
    () => current ?? { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  )
  const [error, setError] = useState<string | null>(null)

  // 킥오프 전(전술 센터)도 개입 창이다 — store의 판정을 그대로 따른다.
  const level = interventionLevel(phase, pauseReason)
  const full = level === 'full'
  const touchline = level === 'touchline'

  // 터치라인 지시는 **감독 타임과 같은 자원**을 쓴다 — 외침과는 시계가 다르다
  // (2026-08-01 재판정, matchStore.SHOUT_COOLDOWN 위의 논증).
  // 단 **같은 분에 창이 열려 있으면** 그 창 안의 지시는 한 번의 개입으로 묶여 무료다
  // (IFAB 교체 기회가 같은 분의 복수 교체를 한 기회로 묶는 것과 같은 문법).
  const minute = engine?.minute ?? 0
  const windowOpen = !!touchlineWindow && touchlineWindow.minute === minute && touchlineWindow.side === side
  const cooldownLeft = touchline && !windowOpen && lastInterventionMinute !== null
    ? Math.max(0, INTERVENTION_COOLDOWN - (minute - lastInterventionMinute))
    : 0
  const onCooldown = cooldownLeft > 0

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
    if ((full || touchline) && current) setDraft(current)
    // current는 진입 시점 값만 초기화 대상 — phase 전환에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // 미리보기 채널은 언마운트(탭 전환·작전판 닫힘)에서 반드시 걷어낸다 —
  // 남아 있으면 보드가 적용되지도 않은 값을 계속 그린다.
  const previewRef = useRef(onPreview)
  previewRef.current = onPreview
  useEffect(() => () => { previewRef.current?.(null) }, [])

  /** 축별 활성 판정. 터치라인에서도 지시 4축은 전부 열린다 — 막는 것은 쿨다운뿐이다. */
  const axisOpen = () => full || (touchline && !onCooldown)

  /** 폭 제한의 기준점. draft도 엔진 현재값도 아니고 **창이 열린 순간의 스냅샷**이다.
   *  현재값을 기준으로 삼으면 같은 창에서 세 번 적용해 ±45를 만드는 우회가 열린다
   *  (store가 창 스냅샷으로 판정하므로, 화면이 다른 기준을 쓰면 "끌 수는 있는데
   *  거부되는" 조합이 된다). 이 기준점 자체는 3f4af06 그대로 유지한다. */
  const axisBase = touchlineWindow && windowOpen ? touchlineWindow.tactics.instructions : current

  /** 이 축에서 지금 소리쳐 전달할 수 있는 허용 밴드. null이면 제한 없음(전원 소집).
   *
   *  ★ 3f4af06은 이 밴드를 **슬라이더의 min/max로 직접 꽂았다** — "끌 수 있는 범위가
   *    곧 규칙"이라는 설계였다. 규칙을 조작으로 체화한다는 점에서 매력적이었지만,
   *    실제 플레이에서 뒤집힌다(사용자 보고 2026-08-01: 압박 83·템포 79로 올려
   *    [터치라인 지시]를 눌렀더니 "손잡이가 중앙에 가 있어서 명령이 안 먹힌 줄 알았다").
   *
   *    원인은 버그가 아니라 그 설계의 필연이다. min/max를 base±STEP으로 자르면 슬라이더의
   *    좌표계가 base를 원점으로 하는 **상대 좌표계**가 된다. 그런데 base는 개입할 때마다
   *    갱신된다. 그래서 방금 83으로 올린 값이 다음 창에서 [68,98]의 정확한 한가운데가 되어
   *    손잡이도 채워진 트랙도 50%에 선다. 값은 맞는데 **눈금이 발밑에서 움직인 것**이다.
   *    유저는 숫자가 아니라 손잡이 위치로 상태를 읽으므로, 이 화면은 "83"이라고 적어 놓고
   *    동시에 "중간"이라고 말한다. 두 신호가 싸우면 유저는 손잡이를 믿는다.
   *
   *    더 근본적으로, 슬라이더의 좌표계는 **축의 의미(0=최저, 100=최고)** 를 나르는
   *    영구적인 것이고 속도 제한은 **이번 개입에만 걸리는 일시적인 것**이다. 영구적인
   *    좌표계를 일시적인 규칙으로 재정의하면 화면이 매 순간 다른 자를 들이대는 셈이다.
   *    그래서 뒤집는다: 좌표계는 **항상 절대 0~100**으로 고정하고, 속도 제한은
   *    ① edit()에서 클램프하고 ② 트랙 위 밴드 표식으로 **보여 준다**.
   *    "끌 수 있는 범위가 곧 규칙"의 의도(눌러 보기 전에 규칙을 안다)는 표식이 그대로
   *    잇는다 — 규칙을 숨기는 것이 아니라 좌표계에서 떼어내 별도의 층으로 그리는 것이다.
   *    판정의 정본은 여전히 store의 touchlineOrderError이고, 이 밴드는 그와 같은
   *    기준점·같은 TOUCHLINE_STEP에서 나오므로 두 판정이 어긋날 수 없다. */
  const axisBand = (key: 'lineHeight' | 'pressing' | 'tempo') => {
    if (!touchline || !axisBase) return null
    const base = axisBase[key]
    return { min: Math.max(0, base - TOUCHLINE_STEP), max: Math.min(100, base + TOUCHLINE_STEP) }
  }

  const edit = (patch: Partial<Instructions>) => {
    // 속도 제한은 이제 좌표계가 아니라 여기서 강제된다(axisBand 주석의 논증).
    // 클램프 기준은 store의 판정과 같은 창 스냅샷이므로 "화면은 통과, store는 거부"가 없다.
    const clamped: Partial<Instructions> = { ...patch }
    for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
      const v = clamped[k]
      if (v === undefined) continue
      const band = axisBand(k)
      if (band) clamped[k] = Math.max(band.min, Math.min(band.max, v))
    }
    const next = { ...shown, ...clamped }
    if (!immediate) {
      setDraft(next)
      // 보드 미리보기 — 반영은 [지시 적용]에서만 일어난다.
      onPreview?.(next)
      return
    }
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
      onPreview?.(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // 터치라인에서 지금 draft가 실제로 통과할 수 있는가(미리 알려 준다 — 눌러 보고 알면 늦다).
  // 기준은 store와 같은 창 스냅샷이다.
  const orderErr = touchline && axisBase ? touchlineOrderError(axisBase, draft) : null
  const dirty = !!current && (
    current.lineHeight !== draft.lineHeight || current.pressing !== draft.pressing
    || current.tempo !== draft.tempo || current.attackFocus !== draft.attackFocus
  )
  const canApply = immediate ? false : full || (touchline && !onCooldown && !orderErr && dirty)

  return (
    <section className="cs-panel" aria-label="감독 콘솔 — 지시">
      <h3 className="cs-panel__title">전술 지시</h3>
      {/* 터치라인 등급에서는 지금 무엇이 열려 있고 무엇이 자원을 먹는지를 먼저 말한다.
          "이유 없는 disabled는 고장으로 읽힌다"(ShoutBar 선례)의 반대편 — 열려 있는데도
          제한이 있으면 그 제한을 말해야 트랙 위 밴드 표식이 무엇인지가 설명된다. */}
      {touchline && (
        <p className="cs-touchline" role="status">
          {onCooldown
            ? <>터치라인 지시 쿨다운 — <b>{cooldownLeft}분</b> 뒤에 다시 지시할 수 있습니다(감독 타임과 같은 시계 · <b>외침은 지금도 됩니다</b>).</>
            : windowOpen
              ? <>이번 개입 안에서는 <b>추가 비용 없이</b> 계속 지시할 수 있습니다 — 다만 폭은 개입 시작 시점 기준 ±{TOUCHLINE_STEP}입니다.</>
              : <>경기 중에도 <b>라인·압박·템포·공격방향</b>을 소리쳐 전달합니다 — 수치 축은 한 번에 ±{TOUCHLINE_STEP}, 감독 타임과 쿨다운({INTERVENTION_COOLDOWN}분)을 공유합니다(외침은 별개).</>}
        </p>
      )}
      <div className="cs-axes">
        {AXES.map(({ key, label, cost }) => {
          const band = axisBand(key)
          const open = axisOpen()
          // 쿨다운으로 막힌 축만 잠금 표시를 단다 — 축 자체가 닫힌 것은 이제 없다.
          return (
            <div key={key} className={`cs-axis-wrap${touchline && !open ? ' cs-axis-wrap--locked' : ''}`}>
              <div className="cs-axis">
                <span className="cs-axis__label" aria-hidden="true">{label}</span>
                {/* 트랙 위에 밴드 표식을 겹친다. 좌표계가 절대 0~100이므로 값이 곧 %다 —
                    인라인 style은 그 데이터 바인딩(폭·위치)에만 쓴다. */}
                <div className="cs-axis__track">
                  {band && open && (
                    <span
                      className="cs-axis__band"
                      aria-hidden="true"
                      style={{ left: `${band.min}%`, width: `${band.max - band.min}%` }}
                    />
                  )}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    aria-label={label}
                    // 밴드는 시각 표식이라 스크린리더에 잡히지 않는다 — 같은 사실을 말로도 적는다.
                    aria-description={band && open
                      ? `이번 개입에서 전달 가능한 범위 ${band.min}부터 ${band.max}까지`
                      : undefined}
                    value={shown[key]}
                    disabled={!open}
                    onChange={e => edit({ [key]: Number(e.target.value) })}
                    className="cs-axis__range"
                  />
                </div>
                <span className="cs-axis__val">{shown[key]}</span>
              </div>
              {cost && (
                <p className={`cs-cost${shown[key] >= cost.threshold ? ' cs-cost--hot' : ''}`}>
                  <span className="cs-cost__tag">{cost.tag}</span> {cost.text}
                </p>
              )}
            </div>
          )
        })}
        {/* 네이티브 select는 OS 팝업이라 다크 UI 밖으로 튀고 터치 타깃도 작다.
            선택지가 4개뿐이므로 세그먼트 컨트롤로 전부 펼친다. */}
        <div className="cs-axis cs-axis--focus">
          <span className="cs-axis__label" id="cs-focus-label">공격방향</span>
          <div className="seg cs-focus" role="group" aria-labelledby="cs-focus-label">
            {/* 세그먼트 높이는 34px지만 손가락에는 44px가 필요하다 — tap-44가 히트 영역만 넓힌다. */}
            {FOCUS.map(f => (
              <button
                key={f.value}
                type="button"
                className="seg__item tap-44"
                aria-pressed={shown.attackFocus === f.value}
                // 공격방향은 범주 축이라 폭 개념이 없다 — "왼쪽으로!" 한마디로 전달된다.
                disabled={!axisOpen()}
                onClick={() => edit({ attackFocus: f.value })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="cs-panel__foot">
        {/* 즉시 반영 모드에선 버튼이 "아직 적용 안 됐다"는 거짓 신호가 되므로 감춘다. */}
        {immediate
          ? <span className="cs-live">조작 즉시 반영 — 하단 검토 요약에서 확인하십시오</span>
          : (
            <button type="button" className="btn btn--primary" onClick={apply} disabled={!canApply}>
              {touchline ? '터치라인 지시' : '지시 적용'}
            </button>
          )}
        {level === 'none' && <span className="cs-lock">다음 브레이크까지 잠김</span>}
        {touchline && onCooldown && (
          <span className="cs-lock num">재사용까지 {cooldownLeft}분</span>
        )}
        {/* [터치라인 지시]를 막는 조건은 셋이다: 쿨다운 · 폭 초과 · 바꾼 것 없음.
            앞의 둘은 위·아래에서 말하고 있으므로 나머지 하나도 말해야 한다 —
            이유 없는 disabled는 고장으로 읽힌다(ShoutBar 선례). */}
        {touchline && !onCooldown && !orderErr && !dirty && (
          <span className="cs-lock">바꾼 것이 없습니다 — 슬라이더를 움직이면 전달됩니다</span>
        )}
      </div>
      {orderErr && !onCooldown && <p className="cs-error" role="alert">{orderErr}</p>}
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}
