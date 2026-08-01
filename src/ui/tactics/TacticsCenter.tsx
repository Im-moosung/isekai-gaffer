import { useRef, useState } from 'react'
import type { AttackPattern, Mentality, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { planRisks, recommendPlan } from '../../game/scouting'
import { formationEdge } from '../../engine/tactics'
import { LineupEditor } from '../lineup/LineupScreen'
import { autoFill } from '../lineup/swap'
import { TacticsWorkbench } from './TacticsWorkbench'
import { useAxisHighlight, useChangeCaption } from './boardFeedback'
import { PitchView } from '../pitch/PitchView'
import { OppPanel, matchupHint } from './OppPanel'
import './tactics.css'
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

type TabId = 'lineup' | 'team' | 'opp'

const TABS: { id: TabId; label: string }[] = [
  { id: 'lineup', label: '선발 라인업' },
  { id: 'team', label: '팀 전술' },
  { id: 'opp', label: '상대 브리핑' },
]

/** 킥오프 전 워룸 — 탭 3장 + 탭 밖 고정 영역.
 *
 *  ★ 왜 다시 탭인가, 그리고 직전 판단을 어떻게 지켰는가:
 *  직전 재설계는 탭을 **일부러** 없앴다. "선발 → 팀 전술 → 검토는 순차 작업이지 배타
 *  뷰가 아니다"가 근거였고, 그건 지금도 맞다. 하지만 세로로 편 결과 실측 2133px(1440)
 *  ~2184px(1920)가 되어 한 화면에서 두 번 이상 스크롤해야 전모가 보였다. 정보를 다
 *  펼친다는 목적이 스크롤 때문에 오히려 무너진 것이다.
 *
 *  그래서 **순차성을 지키는 것과 배타 뷰를 나누는 것을 분리**했다:
 *   · 탭이 나누는 것은 *작업 공간*이다 — 선발 / 팀 전술 / 상대 브리핑.
 *   · **탭 밖에 고정**되는 것은 *플랜의 현재 상태*다 — 검토 요약(형태·태도·리스크·
 *     상대 상성)과 [추천 적용]·[설계 초기화]·[킥오프]. 어느 탭에 있든 지금 무엇을
 *     세웠는지 보이고, 언제든 시작할 수 있다.
 *  즉 "순차 작업"이라는 성질은 탭이 아니라 그 고정 영역이 지킨다. FM25가 정보를 클릭
 *  뒤로 숨겨 취소된 전례가 겨냥한 것도 *상태의 은닉*이지 작업 공간의 분리가 아니다.
 *
 *  ★ 기본 탭은 선발이다. 상대 브리핑을 먼저 두면 "스카우팅 → 설계" 순서와는 맞지만
 *  화면에 들어오자마자 한 번 클릭해야 일을 시작할 수 있다. 대신 브리핑에서 실제로
 *  필요한 한 줄(상대 포메이션 + 상성)은 고정 요약에 상시 노출해 탭을 열지 않아도
 *  판단이 가능하게 했다 — 깊이가 필요할 때만 탭을 연다.
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
  // 캠페인 징계 — 워룸이 정지 선수를 잠그고 경고 보유자를 구분하는 근거(데모는 빈 상태).
  const discipline = useMatchStore(s => s.discipline)
  // 코치진 권고는 적용 후에도 닫기 전까지 남긴다 — 근거를 읽으며 수치를 다듬는 것이
  // 이 화면의 본래 용도이므로, 자동 사라짐(타이머)은 오히려 방해다.
  const [reasons, setReasons] = useState<{ field: string; text: string }[]>([])
  const [tab, setTab] = useState<TabId>('lineup')
  // [설계 초기화]의 기준점 — 이 화면에 처음 들어왔을 때의 전술.
  const baseline = useRef<TacticState | null>(null)
  if (engine && !baseline.current) baseline.current = engine[SIDE].tactics

  // 보드 피드백은 작전판과 **같은 훅**이다(boardFeedback.ts) — 두 화면이 다른 규율로
  // 움직이면 같은 조작에서 다른 피드백을 받게 된다. 킥오프 전에는 지시가 즉시 반영이라
  // 미리보기 채널이 없고, 엔진 값 자체가 곧 보드가 그리는 값이다.
  const ins = engine?.[SIDE].tactics.instructions
  const highlight = useAxisHighlight({
    lineHeight: ins?.lineHeight ?? 50,
    pressing: ins?.pressing ?? 50,
    tempo: ins?.tempo ?? 50,
    attackFocus: ins?.attackFocus ?? 'balanced',
    attackPattern: engine?.[SIDE].tactics.attackPattern ?? 'balanced',
  })
  const caption = useChangeCaption(engine?.[SIDE].tactics)

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
      // 추천도 정지 선수를 세우면 안 된다 — 자동 경로 전부가 같은 제외 목록을 통과해야 한다.
      lineup: formation === home.tactics.formation
        ? home.tactics.lineup
        : autoFill(home.team, formation, home.tactics.lineup.map(l => l.playerId), 'squad', discipline.suspendedIds),
    }
    submitCommand(SIDE, { type: 'formation', tactics: merged })
    setReasons(rec.reasons)
    // ★ 2026-08-01: **탭을 강제로 옮기지 않는다.** 예전에는 여기서 setTab('team')으로
    //   화면을 팀 전술로 끌고 갔다. 추천을 받아들이는 것과 화면이 멋대로 움직이는 것은
    //   다른 일이다 — 라인업을 보던 감독은 자기가 보던 것을 잃는다. 결과가 보이지
    //   않는다는 원래 걱정은 이제 성립하지 않는다: 고정 검토 요약이 형태·태도·루트를
    //   즉시 갱신하고, 코치진 권고 카드가 무엇을 왜 바꿨는지 그 자리에 남으며,
    //   선발 탭이라면 라인업 보드가 바로 재배치된다.
  }

  const resetPlan = () => {
    if (!baseline.current) return
    submitCommand(SIDE, { type: 'formation', tactics: baseline.current })
    setReasons([])
  }

  const risks = planRisks(home.team, home.tactics, home.staminaByPlayer)
  const warnCount = risks.filter(r => r.level === 'warn').length
  // 정지 인원은 선발 탭을 열지 않아도 알아야 한다 — 탭 라벨에 붙는 유일한 배지다.
  const suspendedCount = discipline.suspendedIds.length

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
        {/* 주 CTA는 헤더 우측이다(작전판과 같은 문법). 예전에는 하단 sticky 액션 바에
            있었는데, 1600×900 첫 화면에 [킥오프]가 없다는 것이 6라운드 감사의 지적이었다
            (r6-1600x900-03-warroom.png). 헤더도 sticky라 어느 탭·어느 스크롤 위치에서도
            보인다. 화살표는 장식이므로 접근성 이름은 "킥오프"로 고정한다. */}
        <button
          type="button"
          className="btn btn--primary btn--lg tc-head__go"
          aria-label="킥오프"
          onClick={onKickoff}
        >
          킥오프 <span aria-hidden="true">▶</span>
        </button>
      </header>

      {/* ── 탭 밖 고정: 지금 플랜이 무엇인가 ───────────────────
          어느 탭에 있든 형태·태도·리스크·상대 상성이 여기 있다. */}
      <PlanSummary />

      <div className="tc-tabs tabs" role="tablist" aria-label="워룸 작업 공간">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tc-tab-${t.id}`}
            className="tabs__item tc-tabs__item"
            aria-selected={tab === t.id}
            aria-controls={`tc-panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'lineup' && suspendedCount > 0 && (
              <span className="badge badge--danger tc-tabs__badge">
                정지 <span className="num">{suspendedCount}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 코치진 권고 — 근거를 읽는 카드. 좌측 컬러 띠 없이 아이브로우로만 구분한다.
          탭 밖에 두는 이유: 권고는 선발·팀 전술 양쪽을 동시에 건드린다. */}
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

      <div
        className="tc-panel"
        role="tabpanel"
        id={`tc-panel-${tab}`}
        aria-labelledby={`tc-tab-${tab}`}
      >
        {tab === 'lineup' && (
          /* 컨디션은 킥오프 전에 가장 중요한 정보다(캠페인 이월 체력이 여기 반영돼 있다 —
             matchStore.startMatch가 staminaOverride로 엔진 초기값을 이미 덮어썼으므로
             여기서 campaignStore를 다시 읽지 않는다. 진실의 원천은 엔진 하나다). */
          <LineupEditor
            team={home.team}
            tactics={home.tactics}
            onChange={setTactics}
            embedded
            staminaByPlayer={home.staminaByPlayer}
            moraleByPlayer={home.moraleByPlayer}
            unavailableIds={discipline.suspendedIds}
            cautionByPlayer={discipline.cautions}
          />
        )}
        {/* 팀 전술 = **작전판 + 작업대** 2열. 사용자 지시(2026-08-01): "전술은 탭을
            변경해도 항상 포메이션 작전판이 같이 나오게." 예전에는 이 탭이 컨트롤만
            보여줘서 슬라이더를 만져도 무엇이 어떻게 달라지는지 볼 데가 없었다 —
            검토 요약의 숫자만 바뀌었다.
            ★ 390에서는 2열이 불가능하다. 위아래로 쌓되 **보드를 위에** 둔다: 컨트롤이
              위면 조작하는 손이 결과를 가리고, 무엇보다 보드는 "지금 무엇을 세웠나"라
              화면에 들어온 순간 먼저 보여야 할 것이다(작전판 .tb-main과 같은 순서). */}
        {tab === 'team' && (
          <div className="tc-team">
            <div className="tc-team__board">
              <PitchView
                state={engine}
                variant="tactics"
                analysis
                analysisHighlight={highlight}
                nameLabels
              />
              {caption && <p key={caption.tick} className="tb-cap" role="status">{caption.text}</p>}
            </div>
            <TacticsWorkbench side={SIDE} idPrefix="tc" />
          </div>
        )}
        {tab === 'opp' && <OppPanel />}
      </div>

      {/* 하단 고정 바 — 이제 **설계 보조**만 남는다(추천·초기화·검토 상태).
          주 CTA를 여기서 헤더로 올린 것은 위치 문제만이 아니다: [설계 초기화]는
          되돌리는 동작이고 [킥오프]는 되돌릴 수 없는 동작인데, 둘이 같은 바에서
          이웃해 있었다. 성격이 반대인 버튼을 붙여 두지 않는다. */}
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
      </div>
    </div>
  )
}

/** 검토 요약 — 탭 밖 고정 밴드. 4열 표에서 문장 리스트로 바꿨다(감사 W-11).
 *  4번째 열만 문장이라 열 폭이 제각각이었고, 애초에 "무엇을 세웠고 무엇이 위험한가"는
 *  표가 아니라 문장으로 읽는 정보다. 색은 텍스트에만 얹는다.
 *
 *  ★ 상대 상성 한 줄이 여기 있는 이유: 상대 브리핑을 탭 뒤로 보냈으므로, 브리핑에서
 *  실제로 판단에 쓰이는 한 줄(포메이션 + 상성)은 탭을 열지 않아도 보여야 한다.
 *  나머지(스쿼드·스타일 노트·미니보드)는 깊이 파고들 때만 필요한 정보다. */
function PlanSummary() {
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null
  const t = engine.home.tactics
  const ins = t.instructions
  const risks = planRisks(engine.home.team, t, engine.home.staminaByPlayer)
  const oppFormation = engine.away.tactics.formation
  const hint = matchupHint(formationEdge(t.formation, oppFormation))

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
    { label: '상대', value: `${engine.away.team.name.ko} ${oppFormation} · ${hint.text}` },
  ]

  return (
    <section className="tc-summary" aria-label="킥오프 전 검토">
      <h2 className="tc-summary__title eyebrow">지금 플랜 · 검토</h2>
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
    </section>
  )
}
