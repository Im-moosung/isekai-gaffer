import { useRef, useState, type ReactNode } from 'react'
import type { AttackPattern, Mentality, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { planRisks, recommendPlan } from '../../game/scouting'
import { LineupEditor } from '../lineup/LineupScreen'
import { autoFill } from '../lineup/swap'
import { ConsolePanel } from '../console/ConsolePanel'
import { TacticsExtras } from './TacticsExtras'
import { OppPanel } from './OppPanel'
import './TacticsCenter.css'

// 유저는 홈팀 감독 — 전술 센터는 home 고정(작전판과 동일 규약).
const SIDE = 'home' as const

const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비', defensive: '수비', balanced: '균형',
  attacking: '공격', 'very-attacking': '매우 공격',
}
const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}

/** 접이식 섹션.
 *
 *  ★ 왜 상태를 두면서 데스크톱에서는 무시하는가: FM25는 "한 눈에 보이던 정보를
 *  클릭 뒤로 숨기는 리디자인" 때문에 게임이 통째로 취소됐다. 그러니 넓은 화면에서는
 *  접기를 아예 제공하지 않고(토글 버튼도 감춘다) 전부 펼쳐 둔다. 390px에서만
 *  아코디언이 된다 — 거기서는 접지 않으면 아무것도 조작할 수 없기 때문이다.
 *  펼침/접힘의 전환은 CSS가 담당하고(TacticsCenter.css), 이 상태는 sm에서만 쓰인다. */
function Section({ id, title, meta, open, onToggle, children }: {
  id: string
  title: string
  meta?: ReactNode
  open: boolean
  onToggle(): void
  children: ReactNode
}) {
  return (
    <section className={`tc-acc${open ? ' tc-acc--open' : ''}`} aria-label={title}>
      <div className="tc-acc__head section__head">
        <h2 className="tc-acc__title section__title">
          <button
            type="button"
            className="tc-acc__toggle"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={onToggle}
          >
            {title}
          </button>
          <span className="tc-acc__static">{title}</span>
        </h2>
        {meta && <span className="section__meta">{meta}</span>}
      </div>
      <div className="tc-acc__body" id={`${id}-body`}>{children}</div>
    </section>
  )
}

/** 킥오프 전 워룸 — 한 페이지 세로 흐름.
 *
 *  ★ 재설계(감사 W-3·W-4·W-5·T-6):
 *  1. 상단 3D 스타디움 띠를 걷어냈다(TacticsCenter.css). 킥오프 전 화면의 주인공은
 *     설계다. 190px 극단 레터박스 3D는 정보가 0인데 높이 예산의 21%를 먹었고,
 *     방송 정체성은 상단 바가 이미 담당한다.
 *  2. 탭(① 선발 / ② 팀 전술)을 없애고 세로로 폈다. 선발 → 팀 전술 → 검토는
 *     순차 작업이지 배타 뷰가 아니다.
 *  3. 커밋 어포던스를 하나로 줄였다. 하단 고정 바의 [킥오프]만 primary이고
 *     [추천 적용]은 secondary, [설계 초기화]는 ghost다.
 *
 *  경기 중 작전판과 같은 컨트롤(ConsolePanel·TacticsExtras)을 재사용해 유저가 한 번
 *  배운 UI를 두 시점에서 쓰게 한다 — 이들은 store 바인딩이라 'pre'가 개입 phase가
 *  되는 순간 무수정으로 동작한다. */
export function TacticsCenter({ onKickoff, referenceScore }: {
  onKickoff(): void
  referenceScore?: [number, number]
}) {
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)
  // 코치진 권고는 적용 후에도 닫기 전까지 남긴다 — 근거를 읽으며 수치를 다듬는 것이
  // 이 화면의 본래 용도이므로, 자동 사라짐(타이머)은 오히려 방해다.
  const [reasons, setReasons] = useState<{ field: string; text: string }[]>([])
  // sm 아코디언 초기 상태. 기본 펼침은 "지금 무엇을 해야 하는가"에 맞춘다 —
  // 선발이 첫 작업이므로 선발만 열고 나머지는 접는다.
  const [open, setOpen] = useState({ opp: false, lineup: true, team: false, review: false })
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }))
  // [설계 초기화]의 기준점 — 이 화면에 처음 들어왔을 때의 전술.
  const baseline = useRef<TacticState | null>(null)
  if (engine && !baseline.current) baseline.current = engine[SIDE].tactics

  if (!engine) return null
  const home = engine[SIDE]
  const away = engine.away

  // 선발 편집 결과는 곧바로 엔진 tactics로 커밋한다(store가 진실의 원천).
  const setTactics = (next: TacticState) => {
    submitCommand(SIDE, { type: 'formation', tactics: next })
  }

  // 추천은 현재 전술 위에 덮어쓰는 patch다. 포메이션이 바뀌면 새 슬롯에 재배치한다.
  // 킥오프 전이므로 후보는 스쿼드 전체다(기본 scope 'squad'). 감독의 11인은 적합도가
  // 같을 때 유지된다 — 되돌릴 수 없는 버튼이 되지 않도록 [설계 초기화]를 함께 둔다.
  const applyRecommendation = () => {
    const rec = recommendPlan(home.team, away.team)
    const formation = rec.patch.formation ?? home.tactics.formation
    const merged: TacticState = {
      ...home.tactics,
      ...rec.patch,
      instructions: { ...home.tactics.instructions, ...(rec.patch.instructions ?? {}) },
      lineup: formation === home.tactics.formation
        ? home.tactics.lineup
        : autoFill(home.team, formation, home.tactics.lineup.map(l => l.playerId)),
    }
    submitCommand(SIDE, { type: 'formation', tactics: merged })
    setReasons(rec.reasons)
    // 결과가 생기면 자동 전개한다 — 접힌 채로 값만 바뀌면 "눌렀는데 아무 일도
    // 안 일어났다"로 읽힌다(sm에서만 의미가 있다).
    setOpen(o => ({ ...o, team: true, review: true }))
  }

  const resetPlan = () => {
    if (!baseline.current) return
    submitCommand(SIDE, { type: 'formation', tactics: baseline.current })
    setReasons([])
  }

  const risks = planRisks(home.team, home.tactics, home.staminaByPlayer)
  const warnCount = risks.filter(r => r.level === 'warn').length

  return (
    <div className="tc-root" aria-label="전술 센터">
      {/* 킥오프 전에는 스코어·시계를 띄우지 않는다(감사 W-12) — 0:0 · 0'는
          "경기가 진행 중"이라는 거짓 신호다. 대신 대진과 국면을 적는다. */}
      <header className="tc-head">
        <div className="tc-head__match">
          <span className="kit-strip kit-strip--us" aria-hidden="true" />
          <span className="tc-head__teams">{home.team.name.ko} vs {away.team.name.ko}</span>
          <span className="kit-strip kit-strip--them" aria-hidden="true" />
        </div>
        <span className="tc-head__state">킥오프 전 · 전술 설계</span>
        {referenceScore && (
          <span className="tc-head__ref num">참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}</span>
        )}
      </header>

      <div className="tc-grid">
        <Section id="tc-opp" title="상대 브리핑" open={open.opp} onToggle={() => toggle('opp')}>
          <OppPanel />
        </Section>

        <Section id="tc-lineup" title="선발 라인업" open={open.lineup} onToggle={() => toggle('lineup')}>
          {/* 컨디션은 킥오프 전에 가장 중요한 정보다(캠페인 이월 체력이 여기 반영돼 있다 —
              matchStore.startMatch가 staminaOverride로 엔진 초기값을 이미 덮어썼으므로
              여기서 campaignStore를 다시 읽지 않는다. 진실의 원천은 엔진 하나다). */}
          <LineupEditor
            team={home.team}
            tactics={home.tactics}
            onChange={setTactics}
            embedded
            staminaByPlayer={home.staminaByPlayer}
            moraleByPlayer={home.moraleByPlayer}
          />
        </Section>
      </div>

      {/* 코치진 권고 — 근거를 읽는 카드. 좌측 컬러 띠 없이 아이브로우로만 구분한다. */}
      {reasons.length > 0 && (
        <div className="tc-reasons card" role="status">
          <div className="tc-reasons__head">
            <span className="eyebrow">코치진 권고 · 감독 판단으로 수정하십시오</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setReasons([])}
              aria-label="권고 닫기"
            >
              닫기
            </button>
          </div>
          <ul className="tc-reasons__list">
            {reasons.map((r, i) => <li key={`${r.field}-${i}`}>{r.text}</li>)}
          </ul>
        </div>
      )}

      <Section id="tc-team" title="팀 전술" open={open.team} onToggle={() => toggle('team')}>
        <div className="tc-team">
          <ConsolePanel side={SIDE} />
          <TacticsExtras side={SIDE} />
        </div>
      </Section>

      <Section
        id="tc-review"
        title="검토"
        meta={warnCount > 0 ? `주의 ${warnCount}건` : '특이사항 없음'}
        open={open.review}
        onToggle={() => toggle('review')}
      >
        <PlanSummary />
      </Section>

      {/* 하단 고정 액션 바 — 화면당 primary는 하나다. 점선 테두리 버튼·라임 채움
          버튼·중복 커밋 버튼(채택/지시 적용/전술 확정)을 전부 걷어낸 결과다. */}
      <div className="tc-actions">
        <button type="button" className="btn btn--secondary" onClick={applyRecommendation}>
          추천 적용
        </button>
        <button type="button" className="btn btn--ghost" onClick={resetPlan}>
          설계 초기화
        </button>
        <span className="tc-actions__status">
          {warnCount > 0 ? `검토 — 주의 ${warnCount}건` : '검토 완료 · 특이사항 없음'}
        </span>
        {/* 화살표는 장식이므로 접근성 이름은 "킥오프"로 고정한다. */}
        <button type="button" className="btn btn--primary btn--lg" aria-label="킥오프" onClick={onKickoff}>
          킥오프 <span aria-hidden="true">▶</span>
        </button>
      </div>
    </div>
  )
}

/** 검토 요약 — 4열 표에서 문장 리스트로 바꿨다(감사 W-11).
 *  4번째 열만 문장이라 열 폭이 제각각이었고, 애초에 "무엇을 세웠고 무엇이 위험한가"는
 *  표가 아니라 문장으로 읽는 정보다. 색은 텍스트에만 얹는다. */
function PlanSummary() {
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null
  const t = engine.home.tactics
  const ins = t.instructions
  const risks = planRisks(engine.home.team, t, engine.home.staminaByPlayer)

  const phase: string[] = []
  if (t.phaseFormations?.attack) phase.push(`공격 ${t.phaseFormations.attack}`)
  if (t.phaseFormations?.defense) phase.push(`수비 ${t.phaseFormations.defense}`)

  const facts: { label: string; value: string }[] = [
    { label: '형태', value: phase.length > 0 ? `${t.formation} (${phase.join(' · ')})` : t.formation },
    {
      label: '태도',
      value: `${MENTALITY_KO[t.mentality ?? 'balanced']} · 라인 ${ins.lineHeight} · 압박 ${ins.pressing} · 템포 ${ins.tempo}`,
    },
    { label: '공격 루트', value: PATTERN_KO[t.attackPattern ?? 'balanced'] },
  ]

  return (
    <div className="tc-summary" aria-label="킥오프 전 검토">
      <ul className="tc-facts">
        {facts.map(f => (
          <li key={f.label} className="tc-fact">
            <span className="tc-fact__label">{f.label}</span>
            <span className="tc-fact__value num">{f.value}</span>
          </li>
        ))}
      </ul>
      <ul className="tc-risks">
        {risks.map((r, i) => (
          <li key={`${r.level}-${i}`} className={r.level === 'warn' ? 'tc-risk tc-risk--warn' : 'tc-risk tc-risk--ok'}>
            <span className="tc-risk__mark" aria-hidden="true">{r.level === 'warn' ? '!' : '✓'}</span>
            {r.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
