import { useEffect, useRef, useState } from 'react'
import type { FormationId, GroupIntensity, Instructions, Mentality, Player, TacticState } from '../../engine/types'
import {
  canIntervene, interventionLevel, nextBreakMinute, touchlineNotice, touchlineTacticsError, useMatchStore,
} from '../../game/matchStore'
import { buildCoachAdvice, hasPatch, type TacticPatch } from '../../game/coach'
import { playerMatchStats, type PlayerMatchStats } from '../../game/playerStats'
import { PitchView } from '../pitch/PitchView'
import type { AnalysisAxis, AnalysisHighlight } from '../pitch/AnalysisLayer'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { OppPanel } from './OppPanel'
import { PlayerCard } from '../common/PlayerCard'
import { PlayerCompare, type ComparePlayer } from '../common/PlayerCompare'
import { TacticsExtras } from './TacticsExtras'
import { TeamTalk } from '../match/TeamTalk'
import { autoFill, swapPlayers } from '../lineup/swap'
import './tactics.css'

// 유저는 홈팀 감독 — 작전판은 home 고정.
const SIDE = 'home' as const

// 플레이 가능 포메이션 6종(엔진 정본 XI_SLOTS 키와 동일 순서).
const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

type TacticsTab = 'tactics' | 'sub' | 'opp'

/** 플랜 대비 목록에 쓰는 지시 축·멘탈리티 한국어 라벨. */
const PLAN_AXIS_LABEL: Record<'lineHeight' | 'pressing' | 'tempo', string> = {
  lineHeight: '라인', pressing: '압박', tempo: '템포',
}
const PLAN_MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}

/** 정지 사유 → 작전판 하단 표시 문구. moment는 유형별 짧은 문구를 쓴다. */
function reasonText(
  reason: ReturnType<typeof useMatchStore.getState>['pauseReason'],
  halftime: boolean,
): string {
  if (halftime) return '전반 종료'
  if (!reason) return ''
  switch (reason.kind) {
    // 이모지를 아이콘으로 쓰지 않는다 — OS마다 모양·크기가 달라 톤이 무너진다.
    case 'hydration1':
    case 'hydration2':
      return '하이드레이션 브레이크'
    case 'halftime':
      return '전반 종료'
    case 'user':
      return '감독 타임'
    case 'moment':
      return reason.moment.title
  }
}

/** 전술 축 스냅샷 — 강조 판정의 입력. 값이 아니라 "무엇이 바뀌었나"만 뽑는다. */
interface AxisSnapshot {
  lineHeight: number
  pressing: number
  tempo: number
  attackFocus: Instructions['attackFocus']
  attackPattern: string
}

/** 축 변경 → 보드 강조. **정착(settle) 후 한 번만** 올린다.
 *
 *  ★ 왜 즉시 올리지 않는가(사용자 지시: "드래그 중 화면이 요동치면 조작이 어렵다"):
 *  슬라이더 드래그는 1px마다 change를 쏜다. 변경마다 펄스를 걸면 700ms 애니메이션이
 *  프레임마다 재시작해 선이 계속 굵기를 바꾸며 깜박인다 — 값을 읽는 것 자체가 어려워진다.
 *  SETTLE_MS 동안 아무 변화가 없을 때만 "이번 조작은 끝났다"로 보고 한 번 강조한다.
 *  버튼 클릭(공격 패턴·공격방향)은 애초에 단발이라 SETTLE_MS 뒤 즉시 뜬다.
 *
 *  ★ 도형의 **이동 자체는 지연 없이** 매 프레임 반영된다(강조만 지연된다). 즉 "값이
 *  즉시 보인다"와 "무엇이 바뀌었는지 강조된다"를 분리했다. */
const SETTLE_MS = 260
/** 강조를 걷어내는 시각(펄스 700ms보다 조금 길게). */
const HIGHLIGHT_MS = 900

function useAxisHighlight(snap: AxisSnapshot): AnalysisHighlight | undefined {
  const [hl, setHl] = useState<AnalysisHighlight | undefined>(undefined)
  const prev = useRef(snap)
  const pending = useRef(new Set<AnalysisAxis>())
  const tick = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const keys: AnalysisAxis[] = ['lineHeight', 'pressing', 'tempo', 'attackFocus', 'attackPattern']
    let any = false
    for (const k of keys) {
      if (prev.current[k] !== snap[k]) { pending.current.add(k); any = true }
    }
    prev.current = snap
    if (!any) return
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      if (pending.current.size === 0) return
      tick.current += 1
      setHl({ axes: [...pending.current], tick: tick.current })
      pending.current.clear()
      if (clearTimer.current) clearTimeout(clearTimer.current)
      clearTimer.current = setTimeout(() => setHl(undefined), HIGHLIGHT_MS)
    }, SETTLE_MS)
    // snap 객체는 매 렌더 새로 만들어진다 — 의존성은 **값**이어야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.lineHeight, snap.pressing, snap.tempo, snap.attackFocus, snap.attackPattern])

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current)
    if (clearTimer.current) clearTimeout(clearTimer.current)
  }, [])

  return hl
}

/** 작전판(tactics 모드 본체) — 방송 관전과 확연히 다른 다크 전술판 정체성.
 *  중앙 대형 보드(PitchView 재사용, 이름 라벨 + 다크 variant) + 상단 포메이션 셀렉터,
 *  우측 지시 패널(전술=ConsolePanel·교체=SubPanel·상대=Phase 4A T7 예정),
 *  하단 [전술 확정] 대형 버튼(halftime은 [후반 시작]) + 현재 정지 사유.
 *  하프타임엔 팀토크 카드를 상단에 얹는다.
 *
 *  실시간 보드 반영: 포메이션 셀렉터 변경 시 swap.autoFill로 XI를 재배치하고
 *  submitCommand(type:'formation')로 엔진 tactics를 갱신한다 — PitchView가 새
 *  slotCoords로 리렌더되며 tactics.css의 도트 transition(0.5s)으로 이동한다. */
export function TacticsBoard() {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const pauseReason = useMatchStore(s => s.pauseReason)
  const matchPlan = useMatchStore(s => s.matchPlan)
  const schedule = useMatchStore(s => s.schedule)
  const confirmTactics = useMatchStore(s => s.confirmTactics)
  const submitCommand = useMatchStore(s => s.submitCommand)
  // 개입 권한 등급 — 'touchline'(감독 타임·상황 개입)에서는 **대형만** 잠긴다
  // (matchStore TOUCHLINE_AXES 주석의 "포메이션의 경계" 논증).
  const level = interventionLevel(phase, pauseReason)
  const full = level === 'full'
  // 전술 탭을 먼저 연다. 예전에는 터치라인 등급에서 교체 탭을 먼저 열었는데, 그 근거는
  // "전술 탭이 통째로 잠겨 있어 첫 화면이 고장으로 읽힌다"였다. 확장 개방으로 전술 탭은
  // 대형을 뺀 전부가 열려 있으므로 그 근거가 사라졌다 — 감독 타임에 들어간 이유는
  // 대개 지시를 바꾸려는 것이다.
  const [tab, setTab] = useState<TacticsTab>('tactics')
  // 선택은 **최대 2명, 클릭 순서 보존**이다(조작 규약 — 워룸 LineupEditor와 같은 규칙).
  // 1명이면 상세, 2명이면 나란히 비교 + 실행 버튼. 순서가 비교 뷰의 좌/우를 정한다.
  const [selection, setSelection] = useState<string[]>([])
  // 지시 슬라이더 미리보기 — ConsolePanel의 draft를 보드가 [지시 적용] 전에 그린다.
  const [preview, setPreview] = useState<Instructions | null>(null)
  // 코치 회의 팝업 열림. 진입 시 한 번 자동으로 열고, 닫아도 다시 열 수 있다.
  const [coachOpen, setCoachOpen] = useState(true)
  // 조작 결과 안내(스크린리더 + 화면). 키보드·버튼 경로는 시각 피드백이 없으면
  // 무슨 일이 일어났는지 알 수 없다.
  const [say, setSay] = useState('')

  // 보드가 실제로 그리는 지시값 = 미리보기가 있으면 미리보기, 없으면 엔진 값.
  // 훅 순서를 지키려고 조기 반환보다 위에서 계산한다.
  const engineIns = engine?.[SIDE].tactics.instructions
  const shownIns: Instructions = preview ?? engineIns
    ?? { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }
  const highlight = useAxisHighlight({
    lineHeight: shownIns.lineHeight,
    pressing: shownIns.pressing,
    tempo: shownIns.tempo,
    attackFocus: shownIns.attackFocus,
    attackPattern: engine?.[SIDE].tactics.attackPattern ?? 'balanced',
  })

  if (!engine) return null
  const halftime = phase === 'halftime'
  const home = engine[SIDE]
  const formation = home.tactics.formation
  // 미리보기를 얹은 표시용 상태. 엔진은 건드리지 않는다 — 반영은 [지시 적용]에서만.
  const shownState = preview
    ? { ...engine, home: { ...home, tactics: { ...home.tactics, instructions: preview } } }
    : engine
  const byId = (id: string | null): Player | undefined =>
    id ? home.team.squad.find(p => p.id === id) : undefined

  // 포메이션 변경 — 경기 중이므로 **현재 선발 11인 안에서만** 재배치한다('starters-only').
  // 여기서 벤치 선수를 자동 투입하면 감독이 쓰지도 않은 교체 카드를 몰래 소모하는 셈이다
  // (킥오프 전 워룸은 반대로 스쿼드 전체를 후보로 본다 — swap.AutoFillScope 참고).
  const changeFormation = (f: FormationId) => {
    if (f === formation) return
    const preferIds = home.tactics.lineup.map(l => l.playerId)
    const lineup = autoFill(home.team, f, preferIds, 'starters-only')
    submitCommand(SIDE, { type: 'formation', tactics: { ...home.tactics, formation: f, lineup } })
  }

  // ══ 조작 규약 (docs/superpowers/specs/2026-07-31-squad-interaction.md) ══
  // 워룸(LineupEditor)과 **같은 규칙**이다: 클릭은 정보를 여는 동작이고, 두 명을 고르면
  // 나란히 비교 + 실행 버튼이 켜진다. 클릭→클릭으로는 절대 교체되지 않는다.
  // 보드 도트와 교체 탭 카드가 같은 `selection`을 공유해 어느 쪽을 눌러도 같은 상태가 된다.
  const isStarter = (id: string) => home.tactics.lineup.some(l => l.playerId === id)
  const pick = (id: string) => setSelection(prev => {
    if (prev.includes(id)) return prev.filter(x => x !== id)
    if (prev.length >= 2) return [id]
    return [...prev, id]
  })
  const clearSelection = () => setSelection([])

  // SubPanel(교체 탭)은 아웃/인 두 슬롯으로 말한다 — 같은 선택에서 파생한다.
  const subOut = selection.find(isStarter) ?? null
  const subIn = selection.find(id => !isStarter(id)) ?? null

  // 교체 미리보기 고스트: 아웃 선수의 슬롯 인덱스에 투입 선수 번호를 반투명 표시.
  const outIdx = subOut ? home.tactics.lineup.findIndex(l => l.playerId === subOut) : -1
  const inPlayer = byId(subIn)
  const ghost = subOut && subIn && outIdx >= 0
    ? { slotIndex: outIdx, number: inPlayer?.number }
    : null
  const highlightId = selection[0] ?? null
  const selPlayers = selection.map(id => byId(id)).filter((p): p is Player => !!p)
  // 비교 뷰는 워룸과 같은 컴포넌트(PlayerCompare)를 쓴다. 다만 경기 중이므로
  // **이 경기 기록**을 함께 넘긴다(규약 문서 §작전판이 추가해야 할 것).
  const matchStats: Record<string, PlayerMatchStats> = {}
  for (const p of selPlayers) matchStats[p.id] = playerMatchStats(engine.events, p.id)
  const pair: [ComparePlayer, ComparePlayer] | null = selPlayers.length === 2
    ? [
        { player: selPlayers[0], slot: home.tactics.lineup.find(l => l.playerId === selPlayers[0].id)?.slot, status: { stamina: home.staminaByPlayer[selPlayers[0].id], morale: home.moraleByPlayer[selPlayers[0].id] } },
        { player: selPlayers[1], slot: home.tactics.lineup.find(l => l.playerId === selPlayers[1].id)?.slot, status: { stamina: home.staminaByPlayer[selPlayers[1].id], morale: home.moraleByPlayer[selPlayers[1].id] } },
      ]
    : null
  const bothBench = !!pair && !pair[0].slot && !pair[1].slot
  const bothStarters = !!pair && !!pair[0].slot && !!pair[1].slot
  // 선발+선발 자리 바꾸기는 lineup을 다시 쓰는 **구조 변경**이라 전원 소집에서만 연다
  // (엔진에도 formation 명령으로 나가고, store가 터치라인에서 그 명령을 막는다).
  const canRunAction = !!pair && !bothBench && (!bothStarters || full)

  /** 실행 경로의 **단일 합류점**. 규약이 요구하는 대로 실행 버튼·(향후) 드롭·키보드 놓기가
   *  전부 여기로 모인다 — 경로마다 규칙이 갈리면 같은 조작이 다른 결과를 낸다. */
  function applyMove(aId: string, bId: string): string {
    if (aId === bId) return ''
    const a = byId(aId), b = byId(bId)
    if (!a || !b) return ''
    const aStarter = isStarter(aId), bStarter = isStarter(bId)
    if (!aStarter && !bStarter) return '둘 다 벤치입니다 — 선발 한 명을 함께 고르십시오.'
    try {
      if (aStarter && bStarter) {
        if (!full) return '자리 바꾸기는 선수를 모아 놓고 해야 합니다 — 다음 브레이크에서.'
        submitCommand(SIDE, {
          type: 'formation',
          tactics: { ...home.tactics, lineup: swapPlayers(home.tactics.lineup, aId, bId) },
        })
        return `${a.name.ko}와 ${b.name.ko}의 자리를 바꿨습니다.`
      }
      const outId = aStarter ? aId : bId
      const inId = aStarter ? bId : aId
      submitCommand(SIDE, { type: 'sub', out: outId, in: inId })
      return `${byId(outId)!.name.ko}를 빼고 ${byId(inId)!.name.ko}를 넣었습니다.`
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  const runAction = () => {
    if (!pair) return
    const msg = applyMove(pair[0].player.id, pair[1].player.id)
    setSelection([])
    setSay(msg)
  }

  return (
    <div className="tb-root" role="dialog" aria-label="작전판" aria-modal="true">
      <div className="tb-head">
        <span className="tb-head__label">작전 타임</span>
        <span className="tb-head__reason">{reasonText(pauseReason, halftime)}</span>
        {/* 팝업을 닫은 뒤 다시 부르는 유일한 경로. 상시 노출한다 — 숨겨 두면
            "실수로 닫았을 때 다시 열 수 있다"가 발견되지 않는 기능이 된다. */}
        {!coachOpen && (
          <button type="button" className="btn btn--ghost btn--sm tb-head__coach" onClick={() => setCoachOpen(true)}>
            코치 회의 열기
          </button>
        )}
        {/* ── 경기 상황: 지금 몇 분에 몇 대 몇인가 (사용자 지시 2026-08-01) ────────
            전술을 바꾸는 판단의 첫 번째 입력이다. 이게 없으면 감독은 작전판을 닫고
            스코어버그를 본 뒤 다시 열어야 했다. 방송 스코어버그(Scorebug)의 문법을
            그대로 쓴다 — 킷 스트립 + FIFA 코드 + 스코어 + 시계. 같은 정보를 두 화면이
            다른 모양으로 말하면 어느 쪽이 정본인지 알 수 없다.

            ★ 왜 engine.score를 그대로 읽어도 노출 게이트(커밋 56cb691)를 어기지 않는가
              — 가정이 아니라 확인한 사실이다.
              1. 이 작전판은 MatchScreen이 `tacticsMode = paused || phase === 'halftime'`
                 일 때만 마운트한다(MatchScreen.tsx 314·1258행). paused는
                 paused-break/paused-user/paused-moment다 — **'playing'은 없다**.
              2. 게이트의 정의는 `revealed = revealState.on && (phase !== 'playing' || ...)`
                 이고(MatchScreen.tsx 261행), 그 주석이 스스로 말한다: "재생 중이 아니면
                 미룰 결과가 없다 — 전부 노출로 본다".
              3. 실제로 노출 타이머 effect(429~435행)가 `phase !== 'playing'`에서
                 revealState를 `{minute:-1, on:true}`로 되돌린다.
              즉 작전판이 열려 있는 모든 phase에서 revealed는 참이고, 화면에 아직
              안 보여 준 골이 남아 있을 수 없다. 하이라이트 안무는 정지와 함께 끝났다.

            ★ 하프타임에 45'가 아니라 HT를 쓰는 이유: 하프타임에도 engine.minute은 45라
              "45'"로 적으면 시계가 도는 중으로 읽힌다. 방송이 쓰는 표기를 그대로 쓴다. */}
        <div className="tb-head__score" role="status" aria-label="경기 상황">
          <span className="kit-strip kit-strip--us" aria-hidden="true" />
          <span className="tb-head__code num">{home.team.fifaCode}</span>
          <span className="tb-head__num num">{engine.score[0]}</span>
          <span className="tb-head__dash">:</span>
          <span className="tb-head__num num">{engine.score[1]}</span>
          <span className="tb-head__code num">{engine.away.team.fifaCode}</span>
          <span className="kit-strip kit-strip--them" aria-hidden="true" />
          <span className="tb-head__clock num">{halftime ? 'HT' : `${engine.minute}'`}</span>
        </div>
      </div>

      {/* 터치라인 안내 — 잠긴 이유와 언제 풀리는지를 함께 말한다.
          이 문구가 없으면 대부분이 비활성인 작전판이 '고장'으로 읽힌다. */}
      {!full && (
        <p className="tb-touchline" role="status">
          {touchlineNotice(engine.minute, schedule)}
        </p>
      )}

      {/* 조작 결과 안내 — 교체·자리 바꾸기는 보드 밖에서도 일어나므로 문장으로 확인시킨다.
          실패(교체 기회 소진·IFAB 제3조 등)도 같은 자리에서 말한다. */}
      {say && <p className="tb-say" role="status">{say}</p>}

      {/* 플랜 대비 — 킥오프 때 세운 계획과 지금의 차이를 축별로 보여준다.
          작전판에서 지시를 만질 때 "무엇을 계획했었는지"가 눈앞에 없으면
          이탈이 누적되는 줄도 모르고 매번 갈아엎게 된다. */}
      {matchPlan && <PlanDiff plan={matchPlan} current={home.tactics} />}

      {/* 코치 회의 — **팝업**이다(사용자 지시 2026-08-01). 예전에는 상단 상시 카드라
          코치가 넷이면 세로 400px 가까이 먹었고, 정작 봐야 할 보드가 접힌 아래로 밀렸다.
          ★ 팝업은 정지 상태에서만 뜬다 — 작전판 자체가 정지 화면이므로 조건이 이미 만족된다
            (경기가 흐르는 중에 모달을 띄우면 관전을 막는다).
          ★ 닫아도 헤더 버튼으로 다시 열 수 있다. 실수로 닫았을 때 조언이 영영 사라지면
            "무시할 수 있다"가 아니라 "잃어버렸다"가 된다. */}
      <CoachMeeting full={full} open={coachOpen} onOpenChange={setCoachOpen} />

      {halftime && (
        <div className="tb-talk">
          <TeamTalk side={SIDE} />
        </div>
      )}

      <div className="tb-main">
        <div className="tb-board">
          <div className="tb-formsel" role="group" aria-label="포메이션">
            {FORMATIONS.map(f => (
              <button
                key={f}
                type="button"
                aria-pressed={f === formation}
                // 포메이션 교체는 선수 열한 명을 모아 놓고 해야 하는 지시다(전원 소집 등급 전용).
                disabled={!full}
                className={`tb-formsel__btn${f === formation ? ' tb-formsel__btn--active' : ''}`}
                onClick={() => changeFormation(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="tb-board__pitch">
            {/* analysis 레이어를 켠다 — 수비 라인(선)·압박 존(면)·패스 레인(화살표)·
                공격 집중 밴드가 여기서 그려진다. 이 네 도형이 곧 슬라이더 네 축이라,
                작전판에서 지시를 만지면 **무엇이 어디서 바뀌는지**가 보드에 바로 나타난다.
                state는 미리보기가 얹힌 shownState다 — [지시 적용] 전에도 그림이 먼저 움직인다. */}
            <PitchView
              state={shownState}
              variant="tactics"
              analysis
              analysisHighlight={highlight}
              nameLabels
              highlightId={highlightId}
              ghost={ghost}
              onDotClick={pick}
            />
            {pair && (
              <div className="tb-pop tb-pop--cmp" role="group" aria-label="선수 비교">
                {/* 워룸과 같은 비교 컴포넌트. 다른 점은 **이 경기 기록**이 얹힌다는 것뿐이다. */}
                <PlayerCompare
                  a={pair[0]}
                  b={pair[1]}
                  stamina={home.staminaByPlayer}
                  morale={home.moraleByPlayer}
                  matchStats={matchStats}
                  action={
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--lg tb-pop__exec"
                        disabled={!canRunAction}
                        onClick={runAction}
                      >
                        {bothStarters ? '자리 바꾸기' : '교체하기'}
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={clearSelection}>선택 해제</button>
                      {bothBench && <span className="tb-pop__hint">둘 다 벤치입니다 — 선발 한 명을 함께 고르십시오.</span>}
                      {bothStarters && !full && (
                        <span className="tb-pop__hint">자리 바꾸기는 다음 브레이크에서 — 지금은 교체만 가능합니다.</span>
                      )}
                    </>
                  }
                />
                <button type="button" className="tb-pop__close" aria-label="카드 닫기" onClick={clearSelection}>✕</button>
              </div>
            )}
            {!pair && selPlayers.length === 1 && (
              <div className="tb-pop" role="group" aria-label="선수 카드">
                <PlayerCard
                  player={selPlayers[0]}
                  side={SIDE}
                  stamina={home.staminaByPlayer[selPlayers[0].id]}
                  morale={home.moraleByPlayer[selPlayers[0].id]}
                  matchStats={matchStats[selPlayers[0].id]}
                />
                <p className="tb-pop__next">한 명을 더 클릭하면 나란히 비교합니다.</p>
                <button type="button" className="tb-pop__close" aria-label="카드 닫기" onClick={clearSelection}>✕</button>
              </div>
            )}
          </div>
        </div>

        <aside className="tb-side">
          <div className="tb-tabs" role="tablist" aria-label="지시 패널">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'tactics'}
              className={`tb-tab${tab === 'tactics' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('tactics')}
            >
              전술{!full && <span className="tb-tab__lock">일부</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'sub'}
              className={`tb-tab${tab === 'sub' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('sub')}
            >
              교체
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'opp'}
              className={`tb-tab${tab === 'opp' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('opp')}
            >
              상대
            </button>
          </div>
          <div className="tb-side__body">
            {tab === 'tactics' && (
              <div className="tb-tactics">
                {!full && (
                  <p className="tb-locked" role="status">
                    {/* "전부 잠김"이 아니다 — 지시 4축·태세·적극성·패턴·세트피스가 아래에서
                        열려 있다. 무엇이 잠겼는지를 정확히 적지 않으면 열린 축까지 죽은
                        것으로 읽힌다(확장 개방 이후로는 잠긴 쪽이 소수다). */}
                    {touchlineNotice(engine.minute, schedule)}
                  </p>
                )}
                <ConsolePanel side={SIDE} onPreview={setPreview} />
                <TacticsExtras side={SIDE} />
              </div>
            )}
            {tab === 'sub' && (
              <SubPanel
                side={SIDE}
                outId={subOut}
                inId={subIn}
                onSelectOut={pick}
                onSelectIn={pick}
                onConfirmed={clearSelection}
              />
            )}
            {tab === 'opp' && <OppPanel />}
          </div>
        </aside>
      </div>

      <footer className="tb-foot">
        <span className="tb-foot__reason">{reasonText(pauseReason, halftime)}</span>
        <button
          type="button"
          className="btn btn--primary btn--lg"
          // 작전판 이탈 애니메이션(600ms) 동안 버튼이 DOM에 남아 있어 연타가 가능하다.
          // 두 번째 클릭은 이미 phase가 'playing'이라 store가 throw한다 — 개입 가능할 때만 보낸다.
          disabled={!canIntervene(phase)}
          onClick={() => { if (canIntervene(phase)) confirmTactics() }}
        >
          {halftime ? '후반 시작' : '전술 확정'}
        </button>
      </footer>
    </div>
  )
}

/** 킥오프 플랜 대비 현재 전술의 차이 목록. 차이가 없으면 "계획대로 가는 중"을 명시한다
 *  — 아무것도 안 보여주면 유지 중인지 기능이 죽은 건지 구분되지 않는다. */
function PlanDiff({ plan, current }: { plan: TacticState; current: TacticState }) {
  const rows: string[] = []
  if (plan.formation !== current.formation) {
    rows.push(`계획: 포메이션 ${plan.formation} → 현재 ${current.formation}`)
  }
  const pm = plan.mentality ?? 'balanced', cm = current.mentality ?? 'balanced'
  if (pm !== cm) rows.push(`계획: 멘탈리티 ${PLAN_MENTALITY_KO[pm]} → 현재 ${PLAN_MENTALITY_KO[cm]}`)
  for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
    if (plan.instructions[k] !== current.instructions[k]) {
      rows.push(`계획: ${PLAN_AXIS_LABEL[k]} ${plan.instructions[k]} → 현재 ${current.instructions[k]}`)
    }
  }
  return (
    <section className="tb-plan" aria-label="플랜 대비">
      {rows.length === 0
        ? <span className="tb-plan__row tb-plan__row--ok">킥오프 플랜대로 가는 중 — 팀 이해도 +3%</span>
        : rows.map(r => <span key={r} className="tb-plan__row">{r}</span>)}
    </section>
  )
}

const DEFAULT_GI: GroupIntensity = { attack: 0, midfield: 0, defense: 0 }

/** 코치 회의 카드 리스트 — 발동 조건을 만족한 코치만 등장한다(0~4명 가변).
 *  각 카드 [채택]은 부분 전술(TacticPatch)을 현재 draft에 병합해 즉시 반영한다(유저가 이후 수정 가능).
 *  전술 축으로 표현할 수 없는 조언(교체 권유 등)은 패치가 비어 있어 [채택]이 붙지 않는다.
 *  맨 아래 [감독 판단대로 간다]는 전체 카드를 접는다(전부 무시 — 감독의 딜레마 존중).
 *
 *  ★ 터치라인 등급에서의 [채택](2026-08-01 확장 개방): 예전에는 등급 하나로 전부 껐다.
 *  이제는 **패치 내용으로 판정한다** — 코치 조언은 지시·태세·적극성·패턴의 조합이라
 *  대부분 터치라인에서도 성립하지만, 한 카드가 멘탈리티를 두 단계 밀거나 지시를 ±15
 *  넘게 움직이면 그 카드만 막혀야 한다. 판정은 store와 **같은 함수**(touchlineTacticsError)를
 *  쓴다. 막힌 카드는 사유를 그 자리에 적는다 — 이유 없는 disabled는 고장으로 읽힌다. */
function CoachMeeting({ full, open, onOpenChange }: {
  full: boolean
  open: boolean
  onOpenChange(v: boolean): void
}) {
  const engine = useMatchStore(s => s.engine)
  const schedule = useMatchStore(s => s.schedule)
  const touchlineWindow = useMatchStore(s => s.touchlineWindow)
  const submitCommand = useMatchStore(s => s.submitCommand)

  if (!engine || !open) return null
  const advice = buildCoachAdvice(engine, SIDE)
  // 조언 0건은 정상 상태다(근거 없는 코치는 침묵한다). 이때는 팝업을 띄우지 않는다 —
  // "드릴 말씀 없습니다" 한 줄을 위해 화면을 덮는 모달을 여는 것은 방해다. 대신
  // 작전판 흐름 안에 한 줄로 남겨 "기능이 죽은 것이 아니다"만 말한다.
  if (advice.length === 0) {
    return (
      <section className="tb-coach tb-coach--quiet" aria-label="코치 회의">
        <p className="tb-coach__quiet">코치진: 특별히 드릴 말씀 없습니다.</p>
      </section>
    )
  }

  // TacticPatch → 현재 tactics에 병합. 판정과 제출이 같은 결과를 보게 순수 함수로 뽑는다.
  const mergedOf = (p: TacticPatch): TacticState => {
    const t = engine[SIDE].tactics
    return {
      ...t,
      ...(p.instructions ? { instructions: { ...t.instructions, ...p.instructions } } : {}),
      ...(p.mentality ? { mentality: p.mentality } : {}),
      ...(p.groupIntensity ? { groupIntensity: { ...(t.groupIntensity ?? DEFAULT_GI), ...p.groupIntensity } } : {}),
      ...(p.attackPattern ? { attackPattern: p.attackPattern } : {}),
    }
  }
  const adopt = (p: TacticPatch) => submitCommand(SIDE, { type: 'formation', tactics: mergedOf(p) })

  // 터치라인에서 이 패치가 통과하는가 — store와 같은 판정, 같은 기준점(창 스냅샷).
  const minute = engine.minute
  const windowOpen = !!touchlineWindow && touchlineWindow.minute === minute && touchlineWindow.side === SIDE
  const base = windowOpen && touchlineWindow ? touchlineWindow.tactics : engine[SIDE].tactics
  const adoptBlock = (p: TacticPatch): string | null => full ? null : touchlineTacticsError(base, mergedOf(p), {
    minute, losing: engine.score[0] < engine.score[1], nextBreak: nextBreakMinute(minute, schedule),
  })

  return (
    // 스크림 + 카드. role=dialog는 작전판 루트에도 있지만 중첩 대화상자는 정상이다
    // (작전판이 '정지 화면', 이 팝업이 '지금 결정할 것' — 층이 다르다).
    <div className="tb-coachpop" role="dialog" aria-modal="true" aria-label="코치 회의">
      <section className="tb-coach">
        <header className="tb-coach__head">
          <h3 className="tb-coach__title">코치 회의</h3>
          <button type="button" className="tb-coach__close" aria-label="코치 회의 닫기" onClick={() => onOpenChange(false)}>✕</button>
        </header>
        <ul className="tb-coach__list">
          {advice.map((a, i) => {
            const block = hasPatch(a.apply) ? adoptBlock(a.apply) : null
            return (
              <li key={`${a.coach}-${i}`} className="tb-coach__card">
                <div className="tb-coach__role">{a.coach}</div>
                <p className="tb-coach__rationale">{a.rationale}</p>
                <p className="tb-coach__proposal">{a.proposal}</p>
                {hasPatch(a.apply) && (
                  <div className="tb-coach__actions">
                    {/* 채택하면 반영되고 **팝업이 사라진다**(사용자 지시). 회의는 결정하는
                        자리지 머무는 자리가 아니다 — 고른 뒤에도 남아 있으면 다시 닫아야 한다. */}
                    <button
                      type="button"
                      className="tb-coach__adopt btn btn--secondary btn--sm"
                      disabled={!!block}
                      onClick={() => { adopt(a.apply); onOpenChange(false) }}
                    >
                      채택
                    </button>
                    {/* 막힌 카드는 사유를 그 자리에 적는다 — 조언은 읽히되 왜 못 쓰는지가 보인다. */}
                    {block && <span className="tb-coach__block">{block}</span>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {/* 아무것도 고르지 않고 닫는 경로. 기획서 원칙 2 — 코치는 전부 무시할 수 있어야 한다. */}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onOpenChange(false)}>
          감독 판단대로 간다
        </button>
      </section>
    </div>
  )
}
