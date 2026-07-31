import { useState, useEffect, useRef } from 'react'
import {
  interventionLevel, touchlineOrderError, useMatchStore,
  SHOUT_COOLDOWN, TOUCHLINE_AXES, TOUCHLINE_STEP, type TouchlineAxis,
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

/** 터치라인에서 열리는 축인가. */
const isTouchlineAxis = (k: string): k is TouchlineAxis =>
  (TOUCHLINE_AXES as readonly string[]).includes(k)

/** 감독 콘솔 — 지시 4축(라인/압박/템포 슬라이더 + 공격방향).
 *  경기 중(정지·하프타임)엔 로컬 draft로 편집하다 "지시 적용" → submitCommand.
 *  킥오프 전('pre')엔 즉시 반영 — 아래 `immediate` 주석 참조.
 *
 *  ★ 개입 등급 2층을 축 단위로 반영한다(2026-08-01):
 *   · 전원 소집('full') — 4축 전부.
 *   · 터치라인('touchline') — 압박·템포만, 한 번에 ±TOUCHLINE_STEP, 외침과 쿨다운 공유.
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
  const lastShoutMinute = useMatchStore(s => s.lastShoutMinute)
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

  // 터치라인 지시는 외침과 같은 자원을 쓴다(matchStore.TOUCHLINE_AXES 주석).
  const minute = engine?.minute ?? 0
  const cooldownLeft = touchline && lastShoutMinute !== null
    ? Math.max(0, SHOUT_COOLDOWN - (minute - lastShoutMinute))
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

  /** 축별 활성 판정. 터치라인에서는 압박·템포만 열린다. */
  const axisOpen = (key: string) => full || (touchline && !onCooldown && isTouchlineAxis(key))
  /** 터치라인 속도 제한을 슬라이더 자체에 건다 — 끌 수 있는 범위가 곧 규칙이다.
   *  기준점은 draft가 아니라 **엔진 현재값**이다(연속 편집으로 제한을 우회할 수 없게). */
  const axisRange = (key: 'lineHeight' | 'pressing' | 'tempo') => {
    if (!touchline || !current) return { min: 0, max: 100 }
    const base = current[key]
    return { min: Math.max(0, base - TOUCHLINE_STEP), max: Math.min(100, base + TOUCHLINE_STEP) }
  }

  const edit = (patch: Partial<Instructions>) => {
    const next = { ...shown, ...patch }
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
  const orderErr = touchline && current ? touchlineOrderError(current, draft) : null
  const dirty = !!current && (
    current.lineHeight !== draft.lineHeight || current.pressing !== draft.pressing
    || current.tempo !== draft.tempo || current.attackFocus !== draft.attackFocus
  )
  const canApply = immediate ? false : full || (touchline && !onCooldown && !orderErr && dirty)

  return (
    <section className="cs-panel" aria-label="감독 콘솔 — 지시">
      <h3 className="cs-panel__title">전술 지시</h3>
      {/* 터치라인 등급에서는 무엇이 열려 있는지를 먼저 말한다 — 두 축만 움직이는
          이유를 모르면 나머지 슬라이더가 고장으로 읽힌다. */}
      {touchline && (
        <p className="cs-touchline" role="status">
          경기 중에는 <b>압박·템포</b>만 소리쳐 전달됩니다 — 한 번에 ±{TOUCHLINE_STEP},
          {' '}외침과 쿨다운을 공유합니다{onCooldown ? ` (${cooldownLeft}분 남음)` : ''}.
        </p>
      )}
      <div className="cs-axes">
        {AXES.map(({ key, label, cost }) => {
          const range = axisRange(key)
          const open = axisOpen(key)
          return (
            <div key={key} className={`cs-axis-wrap${touchline && !isTouchlineAxis(key) ? ' cs-axis-wrap--locked' : ''}`}>
              <div className="cs-axis">
                <span className="cs-axis__label" aria-hidden="true">{label}</span>
                <input
                  type="range"
                  min={range.min}
                  max={range.max}
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
                disabled={!full}
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
      </div>
      {orderErr && !onCooldown && <p className="cs-error" role="alert">{orderErr}</p>}
      {error && <p className="cs-error" role="alert">{error}</p>}
    </section>
  )
}
