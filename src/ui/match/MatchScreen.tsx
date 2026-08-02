import { useState, useEffect, useMemo, useRef, lazy, Suspense, Component, type ReactNode } from 'react'
import type { Team, TacticState, MatchEvent, DecisionEntry, SideStats } from '../../engine/types'
import {
  useMatchStore, freeInterventionState, MAX_FREE_INTERVENTIONS, INTERVENTION_COOLDOWN,
} from '../../game/matchStore'
import type { MomentKind } from '../../game/matchSession'
import { teamCardTally } from '../../game/playerStats'
import { commentateAt, commentateTimeline, flowLineAt, type CommentaryCtx } from '../../game/commentary'
import * as ctts from '../../audio/commentary-tts'
import * as mp3 from '../../audio/commentary-mp3'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { buildSequence, sceneKeyFor } from '../pitch/choreography'
import { buildFlowSequence } from '../pitch/flow'
import { AnalysisBoard } from './AnalysisBoard'
import { TacticsBoard } from '../tactics/TacticsBoard'
import { TacticsCenter } from '../tactics/TacticsCenter'
import { PlanBadge } from '../tactics/PlanBadge'
import { ShootoutPanel } from './ShootoutPanel'
import { onPitchIds } from './shootout-setup'
// 스탯 표는 워룸·작전판과 공유하기 위해 별도 모듈로 뽑았다(StatsTable.tsx).
import { StatsTable } from './StatsTable'
import { ShoutBar } from './ShoutBar'
import { LiveStats } from './LiveStats'
import { SettingsMenu } from './SettingsMenu'
// 입장 연출 — three 무의존이라 정적 import여도 3D 청크 분리가 깨지지 않는다.
// (entrance.ts/EntranceOverlay.tsx 모두 three를 타입으로도 import하지 않는다.)
import { EntranceOverlay } from '../pitch/three/EntranceOverlay'
import {
  ENTRANCE_SPEECH_SPEED, buildEntranceCast, defaultEntranceMode, entranceIntroStartMs,
  entranceScript, markEntranceSeen,
  type EntranceMode, type EntranceScript,
} from '../pitch/three/entrance'
import {
  minuteDwellWithSpeech, minuteRevealMs, sceneDwellMs, REVEAL_LAG_MS,
  pickDramaEvent, isImportantEvent, isHighlightEvent, eventIndex, type PlaybackSpeed,
} from './playback'
import * as sfx from '../../audio/sfx'
import * as bgm from '../../audio/bgm'
import './match.css'

// ★ 코드 스플릿: PixiPitch(→ pixi.js 전체)는 메인 번들에서 제외하고 지연 로드한다.
// 정적 import 시 pixi.js(~수백 kB)가 엔트리 청크에 정적으로 끌려와 500kB 경고를 유발했다.
// 로딩 순간에는 Suspense 폴백으로 동일 props의 SVG PitchView를 노출한다(피치 상시 노출 원칙 유지 —
// SVG가 잠깐 보였다가 Pixi로 교체). WebGL 불가 폴백 로직은 PixiPitch 내부에 그대로 있다.
const PixiPitch = lazy(() => import('../pitch/pixi/PixiPitch').then(m => ({ default: m.PixiPitch })))

// ★ 3D 매치 뷰(Phase 4E) — three.js는 pixi보다 훨씬 무거우므로 같은 방식으로 지연 로드한다.
// Match3D 내부에서 three를 다시 dynamic import하므로 three는 별도 청크로 분리된다
// (엔트리 청크에 three 시그니처 부재를 build 후 grep으로 검증).
const Match3D = lazy(() => import('../pitch/three/Match3D').then(m => ({ default: m.Match3D })))

/** 2D/3D 렌더러 선택 기억(기본 3D). 심사·저사양 배려로 언제든 2D로 내릴 수 있다. */
const RENDER3D_KEY = 'rematch-render3d'

function read3dPref(): boolean {
  try {
    return localStorage.getItem(RENDER3D_KEY) !== '0'
  } catch {
    return true
  }
}

function write3dPref(on: boolean): void {
  try {
    localStorage.setItem(RENDER3D_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** PixiPitch 청크 로드 실패(네트워크 오류·배포 중 404) 시 React.lazy가 렌더 중 에러를
 *  throw한다. 에러 바운더리가 없으면 이 에러가 위로 전파되어 앱 전체가 백지가 된다
 *  (PixiPitch 내부 WebGL 폴백은 컴포넌트가 로드된 뒤에만 작동 → 이 경로를 못 막는다).
 *  경량 클래스 바운더리로 감싸 실패 시 동일 props의 SVG PitchView(fallback)로 대체한다
 *  — 피치 상시 노출·크래시 금지 원칙 유지. */
class PitchBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** 위험 순간 강조 xG 임계(찬스 큰 세이브·유효 미스).
 *  엔진의 xG가 '찬스 퀄 지수'(슛당 평균 0.23)에서 **실제 P(골|슛)**(슛당 평균 0.10)으로
 *  재정의되면서 0.25 → 0.12로 내렸다. 실측 분포(kor-esp 6,825슛)의 p75 부근이라
 *  예전과 같은 빈도(상위권 찬스)로 발동한다. */
const DANGER_XG = 0.12

/** 일시정지 중 관중 게인. 0(무음)이 아니라 낮은 웅성거림 — 경기장은 그대로 있다. */
const CROWD_FROZEN = 0.1

// 방송 모드↔작전판 모드 전환 연출 지속(ms). 작전판 이탈 시 역연출을 위해
// 이 시간만큼 마운트를 유지한다(CSS transition/animation 길이와 일치).
const MODE_TRANSITION_MS = 600

// 동적 순간 유형별 방송 배너 문구(제안 시). matchSession.DecisionMoment.title과 별개로,
// 배너에서는 감독에게 말 거는 어투로 노출한다(스펙 §17.2 방송 배너).
// broadcast 모드(재생 중)에서만 노출 — 정지·하프타임 안내는 작전판이 담당한다.
// 쿨다운 링 기하 — ShoutBar와 **같은 모양**을 쓴다. 다만 재는 시계는 서로 다르다
// (감독 타임 10분 · 외침 5분 — 2026-08-01 분리). 모양이 같아도 되는 이유는 링이 말하는
// 것이 "이 버튼이 언제 돌아오는가"이지 "어느 자원인가"가 아니기 때문이고, 어느 자원인지는
// 링 옆의 라벨(개입 N/5 · 외침 바)이 말한다.
const RING_R = 8
const RING_C = 2 * Math.PI * RING_R

/** 막힘 알림이 화면에 머무는 시간(ms). 외침 결과 배너(ShoutBar.BANNER_MS)와 **같은 값**이다 —
 *  같은 문법(tt-banner)을 입은 알림이 서로 다른 수명을 가지면 유저가 두 번 배워야 한다. */
const NOTICE_MS = 3800

const MOMENT_PHRASE: Record<MomentKind, string> = {
  conceded: '실점 직후입니다',
  'momentum-lost': '흐름이 상대에게 넘어갑니다',
  scored: '득점 직후 — 더 몰아칠까요?',
  clutch: '승부의 시간입니다',
  fatigue: '주력 선수 체력이 바닥납니다',
}

/** 2D 작전판 캡션용 이벤트 한국어 라벨(3D로 가지 않는 국면들). */
const EVENT_KO: Partial<Record<MatchEvent['type'], string>> = {
  corner: '코너킥',
  foul: '파울',
  yellow: '경고',
  chance: '찬스',
}

interface MatchScreenProps {
  home: Team
  away: Team
  seed: number
  /** 라인업 화면에서 확정한 홈 전술(캠페인·데모). 미지정 시 엔진 기본 XI. */
  initialTactics?: TacticState
  /** 조별 경기: 전반 재현 스크립트(전반은 시뮬 대신 이 결과를 사용). */
  firstHalfScript?: { events: MatchEvent[]; score: [number, number] }
  /** 체력 이월: 홈 선수별 시작 스태미나 덮어쓰기(캠페인). */
  staminaOverride?: Record<string, number>
  /** 사기 이월: 홈 선수별 시작 사기 덮어쓰기(캠페인). */
  moraleOverride?: Record<string, number>
  /** 캠페인 출장정지 명단(우리 팀). 워룸·교체 패널이 잠그는 근거. */
  suspendedIds?: string[]
  /** 캠페인 미소멸 누적 경고(선수 id → 장수). 1장 보유자 표시의 근거. */
  cautionByPlayer?: Record<string, number>
  /** 조별 경기 참고 표시용 실제 스코어 [한국, 상대]. */
  referenceScore?: [number, number]
  /** 토너먼트: 무승부 시 승부차기로 승자를 가려야 한다. */
  requireWinner?: boolean
  /** 스코어버그 컨텍스트 스트립(대회 · 라운드). 미지정 시 대회명만. */
  context?: string
  /** 상단 바에 흡수할 데모 고지. 전폭 라임 띠 대신 중립 칩으로 노출한다.
   *  ★ `.demo-banner`/`.demo-wrap`(App.css)은 다른 작업자 담당이라 여기서 손대지 않는다 —
   *  대신 이 prop을 열어 두어, App이 준비되면 배너를 상단 바 안으로 옮길 수 있게 한다. */
  demoNote?: string
  /** 캠페인: 경기 종료 시 결과 콜백. 미지정 시 데모 동작([다시 보기]).
   *  4번째 인자 decisionLog는 이 경기의 감독 개입 기록(기자회견 근거).
   *  5번째 인자 finalTactics는 종료 시점 홈 전술 — 다음 경기 초기값 이월용
   *  (허브 복귀 후엔 matchStore가 reset될 수 있으므로 여기서 미리 붙들어 넘긴다). */
  onMatchEnd?(
    score: [number, number],
    staminaByPlayer: Record<string, number>,
    shootout: [number, number] | undefined,
    decisionLog: DecisionEntry[],
    finalTactics: TacticState,
    extra: MatchEndExtra,
  ): void
}

/** onMatchEnd 6번째 인자 — 캠페인 이월에 필요한 부가 상태.
 *  위치 인자를 더 늘리지 않으려고 객체 하나로 묶었다. 데모는 무시한다. */
export interface MatchEndExtra {
  /** 종료 시점 홈 사기(다음 경기 사기 이월). */
  moraleByPlayer: Record<string, number>
  /** 이 경기 홈 선수별 카드(경고 누적·출장정지 판정 입력). */
  cards: Record<string, { yellows: number; reds: number }>
}

/** 경기 화면 조립 — ★ 2모드 분리(스펙 §17 Task 4): "시뮬 관전 중인지 작전 지시
 *  중인지" 절대 헷갈리지 않도록 시각 정체성을 분리한다.
 *  - **broadcast**(playing/pre/fulltime): 그린 피치 와이드 관전. 스코어버그·티커·
 *    속도·[감독 타임]·라이브 스탯 HUD·재생 중 순간 배너만. 콘솔 없음.
 *  - **tactics**(정지·하프타임): 다크 전술판(TacticsBoard) — 포메이션 셀렉터·
 *    지시/교체/상대 탭·[전술 확정]. 방송 위로 슬라이드 업(0.6s 전환 연출, 방송은 디밍).
 *  전환은 CSS transition/animation(reduced-motion 대응). 복귀는 역연출 후 언마운트.
 *  ★ 오버레이 폐지 원칙은 broadcast 내에서 유지 — 피치는 관전 중 언제나 보인다.
 *    반대로 작전판·입장 연출이 뜨면 방송 furniture를 **언마운트**한다(겹침의 근본 해결).
 *
 *  재생은 매치데이 2.0 세션(matchStore): advanceMinute()로 1분씩 전진하며
 *  engine.minute가 곧 표시 분이다(엔진이 앞서 달리지 않아 스포일러 없음).
 *  재생 타이밍은 분당 가변 setTimeout 체인(하이라이트 리듬) — 사건 큰 분은 오래
 *  머물고 무사건 분은 빨리 넘긴다(playback.minuteDwellMs, Math.random·Date 금지).
 *  속도 토글 1x/1.5x/2x로 dwell을 나눈다.
 *  onMatchEnd 유무로 데모/캠페인 동작을 분기(props 하위호환). */
export function MatchScreen({
  home, away, seed,
  initialTactics, firstHalfScript, staminaOverride, moraleOverride, suspendedIds, cautionByPlayer,
  referenceScore, requireWinner, onMatchEnd,
  context = 'FIFA 월드컵 2026', demoNote,
}: MatchScreenProps) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const momentPrompt = useMatchStore(s => s.momentPrompt)
  const oppNotices = useMatchStore(s => s.oppNotices)
  // 자유 개입(감독 타임) 자원 — 잔량·쿨다운·막힘 사유를 store의 순수 함수 하나로 받는다.
  // 판정을 화면에서 다시 조립하면 store가 거부하는데 버튼은 살아 있는 조합이 생긴다.
  const freeInterventionsUsed = useMatchStore(s => s.freeInterventionsUsed)
  const lastInterventionMinute = useMatchStore(s => s.lastInterventionMinute)
  const startMatch = useMatchStore(s => s.startMatch)
  const kickoff = useMatchStore(s => s.kickoff)
  const advanceMinute = useMatchStore(s => s.advanceMinute)
  const pauseByUser = useMatchStore(s => s.pauseByUser)
  const acceptMoment = useMatchStore(s => s.acceptMoment)
  const dismissMoment = useMatchStore(s => s.dismissMoment)
  const logShootoutSetup = useMatchStore(s => s.logShootoutSetup)
  const reset = useMatchStore(s => s.reset)
  // 감독 개입 기록 — 해설위원이 "압박을 올린 뒤로 ~"를 말할 근거(§3.5). 읽기만 한다.
  const decisionLog = useMatchStore(s => s.decisionLog)

  const [shootoutOpen, setShootoutOpen] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  /** 설정 팝업(2D/3D · 음소거 · 해설 음성) 열림. 자주 안 바꾸는 것들의 집 — SettingsMenu 주석. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * **막힌 컨트롤을 눌렀을 때 잠깐 떴다 사라지는 알림.**
   *
   * 사용자 지시(2026-08-01 ①): *"게임 쿨다운에 대한 설명은 어차피 아이콘으로 돌아가고
   * 있으니깐 사용자 버튼을 쿨다운일 때도 눌렀을 때 잠깐 뜨는 알럿 형식으로 떴다가
   * 사라지게 해."* 예전에는 `freeInterventionState.blockedReason` 한 줄이 제어 pod에
   * **상시로** 붙어 있었다 — 40자 넘는 문장이 버튼들 옆에 늘 서서 pod를 두 줄로 만들었다.
   *
   * 없앤 것이 아니라 **옮긴 것**이다. 이 프로젝트는 "막히면 이유를 말한다"를 세 곳
   * (교체·GK 파워플레이·감독 타임)에서 통일했고, 그 규칙은 그대로다. 달라진 것은
   * **언제** 말하는가뿐이다: 쿨다운 링이 이미 시각으로 "언제 돌아오는가"를 말하고 있으므로
   * 문장은 실제로 막힌 순간(=눌렀을 때)에만 나오면 된다.
   *
   * 사유의 정본은 여전히 store다 — pauseByUser()가 거절하며 돌려주는 문자열을 그대로 쓴다.
   * 화면에서 다시 조립하면 "눌리는데 다른 이유를 말하는" 조합이 생긴다.
   */
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)
  const noticeSeqRef = useRef(0)
  // 렌더러 선택 — 3D(three) ↔ 2D(pixi). localStorage 기억, 기본 3D.
  const [render3d, setRender3d] = useState(read3dPref)
  // 사운드 — 음소거 상태(sfx 모듈 = localStorage 진실원)와 관중 스웰(골 직후 4초).
  const [muted, setMutedUi] = useState(() => sfx.isMuted())
  // 한국어 TTS 해설 토글(음소거와 별개, localStorage 기억) — 상단 제어 그룹의 [해설 끄기].
  const [ttsOn, setTtsOnUi] = useState(() => ctts.isTtsEnabled())
  /**
   * **일시정지**(감독 타임과 다르다). 시계만 멈춘다 — 개입 권한은 0이다.
   *
   * 왜 store phase가 아니라 UI 상태인가: matchStore의 정지 phase(`paused-*`)는 전부
   * 개입 등급을 발급한다(`interventionLevel`). "정지 시점이 곧 자원"이라는 설계라,
   * 자유롭게 누를 수 있는 일시정지에 phase를 하나 더 만들면 그 설계가 무너진다.
   * 그래서 phase는 'playing' 그대로 두고 **재생 체인·TTS·렌더 루프만** 얼린다.
   * 유일한 누수 경로였던 터치라인 외침은 ShoutBar에 frozen을 넘겨 막는다.
   */
  const [frozen, setFrozen] = useState(false)
  /** 정지로 인해 재생 체인이 끊긴 경우의 **남은 dwell**(ms). 재개는 이 값부터 이어 간다 —
   *  전체 dwell을 다시 세면 그 분이 두 번 재생된 만큼 늘어나 안무·발화와 어긋난다. */
  const resumeMsRef = useRef<number | undefined>(undefined)
  /** 재생 체인 정리(cleanup)가 **정지 때문인지**를 구분하는 미러. 속도 변경 등 다른
   *  재실행에서 남은 시간을 물려받으면 새 속도가 다음 분부터야 반영된다. */
  const frozenRef = useRef(false)
  frozenRef.current = frozen
  const [crowdSwell, setCrowdSwell] = useState(false)
  /**
   * **결과 노출 게이트** — 이 분의 결과(골·세이브·미스)가 화면에 보였는가.
   *
   * 사용자 지적(2026-08-01 ①): *"해설이 먼저 나오고 화면이 다음에 나와. 무슨 예지력이야?"*
   * 재생이 분 단위라 분에 들어서는 즉시 결과 문장을 말하고 스코어를 올리고 GOAL 배너를
   * 띄웠는데, 정작 안무는 6~7초 뒤에야 공을 그물에 넣었다.
   *
   * 이 플래그가 **결과를 아는 모든 UI**의 스위치다 — 발화·스코어버그·티커·골 드라마·
   * 관중 함성이 전부 여기 걸린다. 반대로 **안무·카메라·2D 보드는 걸리지 않는다**
   * (그것들이 결과를 보여주는 주체다). 하이라이트 안무가 없는 분은 처음부터 true다.
   *
   * ★ 2026-08-01(6라운드 실측): 상태가 **어느 분의 노출인지**까지 들고 있어야 한다.
   *   예전에는 boolean 하나였는데, 분이 막 바뀐 첫 렌더에서는 아래 타이머 effect가 아직
   *   돌지 않아 지난 분의 true가 그대로 남았다. 실측(tools/moment-sync)에서 그 한 프레임에
   *   스코어가 0-1로 튀었다가 1ms 뒤 0-0으로 돌아오고(204627 → 204628), 제안 배너도 같이
   *   깜빡였다 — 게이트가 한 프레임 늦게 닫히면 결과가 그 프레임에 새어 나간다.
   *   그래서 `minute`을 함께 들고, **그 분의 판정이 실제로 내려졌을 때만** 노출로 친다.
   *   (boolean만 갱신하면 revealMs=0인 분에서 setState가 no-op이라 리렌더도 없어,
   *    게이트가 열린 줄 모르고 그 분 내내 닫혀 있는 반대 결함이 생긴다.)
   */
  const [revealState, setRevealState] = useState<{ minute: number; on: boolean }>({ minute: -1, on: true })
  // 재생 중이 아니면(킥오프 전·정지·하프타임·종료) 미룰 결과가 없다 — 전부 노출로 본다.
  const revealed = revealState.on && (phase !== 'playing' || revealState.minute === (engine?.minute ?? -1))
  /** 이번 분의 남은 노출 대기(ms). 일시정지에서 이어 붙이기 위한 미러. */
  const revealRef = useRef({ minute: -1, left: 0 })
  /**
   * 마지막으로 **노출된 상태에서** 본 라이브 스탯 스냅샷.
   *
   * engine.stats는 그 분을 시뮬레이션한 즉시 갱신되므로 그대로 HUD에 넘기면 좌하단
   * "슛 8"이 슛 장면보다 먼저 9로 올라간다 — 스코어버그와 정확히 같은 누설이다.
   * 노출 전에는 이 스냅샷을 대신 보여 준다(직전에 이미 보여 준 값이라 새 정보가 없다).
   */
  const shownStatsRef = useRef<[SideStats, SideStats] | null>(null)
  const swellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firedGoalMinuteRef = useRef(-1)
  const spokenMinuteRef = useRef(-1)
  const prevPhaseRef = useRef<string | null>(null)

  // 입장 연출 — cast가 있는 동안만 재생된다(phase는 아직 'pre').
  // 클럭의 정본은 오버레이다(자체 rAF). 3D 씬은 이 ref를 읽어 같은 시각을 그리므로
  // 폴백(Pixi/SVG)에서 3D가 없어도 자막·소개 카드는 그대로 돌아간다.
  const [entranceScr, setEntranceScr] = useState<EntranceScript | null>(null)
  const entranceClock = useRef(0)

  /**
   * 해설 클립 조회표(`public/tts/index.json`)를 **마운트에서** 읽는다.
   *
   * ★ 킥오프에서 읽으면 늦는다 — `ctts.initVoice()`가 부르는 `loadClipIndex()`는
   *   비동기 fetch인데 `beginScript`는 바로 다음 줄에서 **동기로** 판정한다. 조회표가
   *   아직 null이라 `canSpeakAll`이 항상 false를 내고, 클립이 다 있어도 소리를 잃었다
   *   (실측: `/tts/` 요청이 index.json 하나뿐이었다).
   *
   *   조회표는 60KB 정적 JSON이라 오디오 컨텍스트도 유저 제스처도 필요 없다.
   *   여기서 미리 읽어 두면 킥오프 시점에는 이미 준비돼 있다.
   *   ★ 킥오프의 `ctts.initVoice()`는 이제 이 호출의 예비책일 뿐이다 — 예전엔 거기서
   *     ko-KR **보이스**를 탐색했지만, speechSynthesis 폴백이 사라져 할 일이 없어졌다.
   */
  useEffect(() => { mp3.loadClipIndex() }, [])

  // 경기 초기화(마운트/픽스처 변경 시). 엔진은 pre 상태로 준비.
  // initialTactics/firstHalfScript/staminaOverride는 매치별로 안정 참조(App에서 memo).
  useEffect(() => {
    setShootoutOpen(false)
    firedGoalMinuteRef.current = -1
    spokenMinuteRef.current = -1
    startMatch(home, away, seed, {
      ...(initialTactics ? { homeTactics: initialTactics } : {}),
      ...(firstHalfScript ? { firstHalfScript } : {}),
      ...(staminaOverride ? { staminaOverride } : {}),
      ...(moraleOverride ? { moraleOverride } : {}),
      ...(suspendedIds || cautionByPlayer
        ? { discipline: { suspendedIds: suspendedIds ?? [], cautions: cautionByPlayer ?? {} } }
        : {}),
    })
  }, [home, away, seed, startMatch, initialTactics, firstHalfScript, staminaOverride, moraleOverride,
      suspendedIds, cautionByPlayer])

  // 중계 컨텍스트 — 해설위원이 감독의 지시를 알아보는 재료(§3.5).
  // decisionLog는 개입이 있을 때만 참조가 바뀌므로 매 분 재계산되지 않는다.
  const commentaryCtx: CommentaryCtx = useMemo(
    () => ({ decisions: decisionLog, managedTeamId: home.id }),
    [decisionLog, home.id],
  )

  const freeIntervention = freeInterventionState(freeInterventionsUsed, lastInterventionMinute, engine?.minute ?? 0)

  // 재생 중 = playing. 시간 정지(카운트다운 없음)는 phase가 playing이 아닐 때.
  const replaying = phase === 'playing'
  const paused = phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  // ★ 모드 분리: 정지·하프타임이면 작전판(tactics), 그 외(재생·킥오프 전·종료)는 방송(broadcast).
  const tacticsMode = paused || phase === 'halftime'

  // 재생 루프 — 분당 가변 setTimeout 체인(하이라이트 리듬).
  // 현재 분의 이벤트로 dwell을 계산해 그만큼 머문 뒤 advanceMinute()로 1분 전진.
  // playing이 아니면(정지·하프타임·풀타임) 체인을 걸지 않는다 → 자동 정지.
  // confirmTactics/kickoff로 phase가 'playing'이 되면 effect가 재실행되어 재개.
  // speed 변경 시에도 재실행되어 즉시 반영. 언마운트/전환 시 타이머 정리.
  useEffect(() => {
    if (phase !== 'playing' || frozen) return
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    // 이번에 예약한 dwell과 그 시작 시각 — 정지로 끊길 때 **남은 시간**을 계산한다.
    let pendingMs = 0
    let startedAt = 0
    const schedule = (overrideMs?: number) => {
      const st = useMatchStore.getState()
      const eng = st.engine
      if (cancelled || !eng || st.phase !== 'playing') return
      const m = eng.minute
      const eventsAtMinute = eng.events.filter(e => e.minute === m)
      const diff = Math.abs(eng.score[0] - eng.score[1])
      const clutch = m >= 80 && diff <= 1
      // 블로우아웃(3골차+) 가속 — 승부 갈린 뒤 늘어짐 방지.
      // 해설이 들리는 상태면 주인공 이벤트 발화 길이를 dwell 하한으로 쓴다(말 잘림 방지).
      // 화자가 둘이 되면 한 분의 총 발화가 길어진다 — allEvents·seed·ctx를 넘겨야
      // 실제로 발화될 문장(캐스터 + 해설)과 같은 기준으로 체류 하한이 잡힌다.
      // 결과가 화면에 보이는 시각 — 발화·스코어·티커가 전부 이 시각을 기준으로 밀린다.
      const sceneMs = sceneDwellMs(eventsAtMinute, speed, clutch, diff)
      const revealMs = minuteRevealMs(eventsAtMinute, eng.home, eng.away, sceneMs)
      const dwell = overrideMs ?? minuteDwellWithSpeech(
        m, eventsAtMinute, home, away, speed, clutch, diff, ctts.willSpeak(),
        eng.events.filter(e => e.minute <= m), seed,
        { decisions: st.decisionLog, managedTeamId: home.id }, revealMs,
      )
      pendingMs = dwell
      startedAt = performance.now()
      timer = setTimeout(() => {
        if (cancelled) return
        advanceMinute()
        schedule()
      }, dwell)
    }
    // 정지에서 돌아온 첫 예약만 남은 시간으로 건다(그 뒤로는 정상 계산).
    schedule(resumeMsRef.current)
    resumeMsRef.current = undefined
    return () => {
      cancelled = true
      clearTimeout(timer)
      // 정지로 끊긴 경우에만 남은 시간을 남긴다. 속도 변경으로 인한 재실행에서
      // 이어 붙이면 새 배속이 다음 분에야 반영된다(즉시 반영 계약 위반).
      if (frozenRef.current) resumeMsRef.current = Math.max(0, pendingMs - (performance.now() - startedAt))
    }
    // ttsOn: 해설 토글이 dwell 하한(발화 길이 보정)을 켜고 끄므로 의존에 포함한다.
  }, [phase, speed, advanceMinute, home, away, seed, ttsOn, frozen])

  // ── 모드 전환 연출: 작전판 마운트/이탈 ──────────────────────────────
  // tacticsMode 진입 시 즉시 마운트(entrance 애니메이션은 CSS가 담당),
  // 이탈 시 --exiting 클래스로 역연출을 재생한 뒤 MODE_TRANSITION_MS 후 언마운트한다.
  // broadcast 순수 상태(작전판 미마운트)에선 콘솔이 DOM에 없다 → 관전에 콘솔 부재.
  const [tacticsMounted, setTacticsMounted] = useState(false)
  const [tacticsExiting, setTacticsExiting] = useState(false)
  useEffect(() => {
    if (tacticsMode) {
      setTacticsExiting(false)
      setTacticsMounted(true)
      return
    }
    if (!tacticsMounted) return
    // 이탈 — 역연출 후 언마운트.
    setTacticsExiting(true)
    const t = setTimeout(() => { setTacticsMounted(false); setTacticsExiting(false) }, MODE_TRANSITION_MS)
    return () => clearTimeout(t)
  }, [tacticsMode, tacticsMounted])

  // ── 현재 분 하이라이트 안무: 그 분의 **주인공 이벤트**를 시퀀스로 번역 ──
  // ★ 주인공은 pickDramaEvent 하나가 정한다 — 아래 TTS 효과도 같은 함수를 쓰므로
  //   "말한 이벤트 = 그린 이벤트"가 구조적으로 보장된다(예전엔 규칙이 둘이었다).
  // engine이 분 단위로 전진하므로 engine 참조가 바뀔 때(=분 전환)만 재계산 → 한 분
  // 재생 동안 시퀀스 참조가 안정적(ChoreoLayer 타이머가 중간에 리셋되지 않음).
  const highlight = useMemo(() => {
    if (!engine) return null
    const m = engine.minute
    const drama = pickDramaEvent(engine.events.filter(e => e.minute === m))
    if (!drama) return null
    const seq = buildSequence(drama, engine.home, engine.away)
    if (seq.length === 0) return null
    const side: 'home' | 'away' = drama.teamId === engine.home.team.id ? 'home' : 'away'
    return { seq, side, event: drama }
  }, [engine])

  // ── 하이라이트가 없는 분: 점유 흐름(2D 작전판이 재생) ────────────────
  // ★ 예전엔 이 분들에 3D의 idleBall이 리사주 곡선을 돌렸다 — 공이 사람과 무관하게
  //   8자를 그리니 "혼자 떠다닌다"로 보였다. 지금은 실제 라인업 좌표를 잇는 패스 체인이며,
  //   2D 보드에서 **점유 흐름**으로 읽힌다(같은 움직임이 3D에서는 엉성한 애니메이션이 된다).
  const flow = useMemo(() => {
    if (!engine || highlight) return null
    return buildFlowSequence(engine, engine.minute, seed)
  }, [engine, highlight, seed])

  // ── 사운드 배선(매치데이 2.0) — 모두 sfx는 미지원 환경 no-op ──────────
  // 휘슬: phase 전이 1회. 하프 2회·풀타임 3회(+관중 정지)·브레이크 짧게. 킥오프는 버튼 핸들러(제스처).
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (prev === phase) return
    // BGM 스팅도 같은 전이에 붙는다 — 하프타임 M07(5s) · 풀타임 M08(6s).
    // 스팅이 끝나면 그 화면의 루프(하프타임 = 작전판 M04)가 이어받는다(bgm 모듈이 대기시킨다).
    if (phase === 'halftime') { sfx.whistle('halftime'); bgm.playSting('M07') }
    else if (phase === 'fulltime') { sfx.whistle('fulltime'); sfx.crowdLoop('stop'); bgm.playSting('M08') }
    else if (phase === 'paused-break') sfx.whistle('break')
  }, [phase])

  // ── 결과 노출 타이머 ────────────────────────────────────────────────
  // 이 분의 안무에서 결과가 보이는 시각(minuteRevealMs)만큼 기다렸다가 게이트를 연다.
  // 일시정지 중에는 시계도 멈춘다 — 정지 화면에서 스코어가 혼자 올라가면 안 된다.
  useEffect(() => {
    if (!engine || phase !== 'playing') {
      revealRef.current = { minute: -1, left: 0 }
      // 이미 초기 상태면 그대로 둔다(같은 값을 새 객체로 넣으면 헛 리렌더가 난다).
      setRevealState(s => (s.minute === -1 && s.on ? s : { minute: -1, on: true }))
      return
    }
    const m = engine.minute
    if (revealRef.current.minute !== m) {
      const eventsAtMinute = engine.events.filter(e => e.minute === m)
      const diff = Math.abs(engine.score[0] - engine.score[1])
      const clutch = m >= 80 && diff <= 1
      const sceneMs = sceneDwellMs(eventsAtMinute, speed, clutch, diff)
      const revealMs = minuteRevealMs(eventsAtMinute, engine.home, engine.away, sceneMs)
      revealRef.current = { minute: m, left: revealMs }
      // 객체를 새로 넣는다 — 값이 같아도 분이 바뀌었으면 리렌더가 일어나야 한다.
      setRevealState({ minute: m, on: revealMs <= 0 })
    }
    const left = revealRef.current.left
    if (frozen || left <= 0) return
    const started = performance.now()
    const timer = setTimeout(() => {
      revealRef.current.left = 0
      setRevealState({ minute: m, on: true })
    }, left)
    return () => {
      clearTimeout(timer)
      // 아직 안 열렸으면 남은 시간을 보존한다(정지 → 재개에서 이어 간다).
      if (revealRef.current.left > 0) {
        revealRef.current.left = Math.max(0, left - (performance.now() - started))
      }
    }
  }, [engine, phase, frozen, speed])

  // 골 사운드: 재생 중 현재 분의 골에 1회 발동(우리=goalBurst / 실점=concedeMurmur) + 관중 스웰 4초.
  useEffect(() => {
    // ★ revealed 게이트: 공이 그물에 들어가기 전에 함성부터 터지면 결과를 미리 알려 준다.
    if (phase !== 'playing' || !engine || !revealed) return
    const m = engine.minute
    const goal = engine.events.find(e => e.type === 'goal' && e.minute === m)
    if (!goal || firedGoalMinuteRef.current === m) return
    firedGoalMinuteRef.current = m
    if (goal.teamId !== engine.home.team.id) sfx.concedeMurmur()
    else sfx.goalBurst()
    // 골·실점 순간 음악 덕킹(0.1배) — 관중음에 쓴 방식과 같다. 인플레이에 도는 음악은
    // M09 클러치 베드뿐이므로 실제 대상도 대개 그것이다.
    bgm.duck()
    setCrowdSwell(true)
    if (swellTimerRef.current) clearTimeout(swellTimerRef.current)
    swellTimerRef.current = setTimeout(() => setCrowdSwell(false), 4000)
  }, [phase, engine, revealed])

  // TTS 해설: 재생 중 현재 분의 **주인공 이벤트** 1개만 발화(과밀 방지).
  // ★ 위 highlight 안무와 동일한 pickDramaEvent를 쓴다 — 말하는 이벤트와 그리는
  //   이벤트가 항상 같아야 한다(이 계약은 MatchScreen 테스트가 고정한다).
  // Line.speech(TTS 전용 문자열)를 읽고, goal·save는 important(rate·pitch 강조 + 발화 중 선점).
  // ★ 화면에 뿌리는 Line.text와 다른 문자열이다 — `고오오올`·`…`·`!!!`은 ko-KR 보이스에서
  //   말더듬·오독이 되므로 발화에는 정규화된 speech를 쓴다(리서치 §5.2).
  // 분당 1회(spokenMinuteRef)만 발동 — 미지원·보이스 없음·토글 OFF면 조용한 no-op.
  //
  // ★ 2026-08-01: **화면을 보고 해설한다.** 이 효과는 결과가 화면에 보인 뒤(revealed)에야
  //   깨어나고, 거기서 다시 REVEAL_LAG_MS(사람이 보고 입을 떼는 시간)만큼 늦춰 말한다.
  //   예전에는 분에 들어서는 즉시 발화해 "막았습니다"가 세이브보다 6초 앞섰다.
  useEffect(() => {
    if (phase !== 'playing' || !engine || !revealed) return
    const m = engine.minute
    if (spokenMinuteRef.current === m) return
    // ★ 여기서 spokenMinuteRef를 세우지 않는다 — 타이머가 실제로 발화한 뒤에 센다.
    //   먼저 세우면 이 효과가 발화 전에 한 번 더 돌 때(예: 지시 기록 변경) 타이머만
    //   지워지고 그 분의 해설이 통째로 사라진다.
    const timer = setTimeout(() => {
      spokenMinuteRef.current = m
      const all = engine.events.filter(e => e.minute <= m)
      const spoken = pickDramaEvent(all.filter(e => e.minute === m))
      if (!spoken) {
        // 무사건 분 — 소강 구간이면 흐름 라인 하나로 침묵을 메운다(§3.4).
        // speakAside는 선점하지 않으므로 앞 분의 발화가 남아 있으면 조용히 넘어간다.
        const flow = flowLineAt(all, m, home, away, seed)
        if (flow) ctts.speakAside(flow.speech, { speed, role: flow.speaker === 'analyst' ? 'analyst' : 'normal' })
        return
      }
      // 히스토리를 넘겨야 streak·골 종류·변형 억제가 산다(맥락 없는 단발 호출은 로봇 신호).
      const line = commentateAt(all, eventIndex(all, spoken), home, away, seed, commentaryCtx)
      // speed를 함께 넘긴다 — 빨리감기 중계는 발화도 빨라져야 체류 시간과 맞는다.
      ctts.speak(line.speech, { important: isImportantEvent(spoken), intensity: line.intensity, speed })
      // 해설위원은 **받아서** 말한다 — speakAside가 큐에 이어 붙여 캐스터 뒤에 나온다(§5.6).
      // 캐스터보다 뒤라는 순서는 유터런스 체이닝이 보장한다(화면 대비로도 자동으로 더 뒤다).
      if (line.follow) ctts.speakAside(line.follow.speech, { speed })
    }, REVEAL_LAG_MS)
    return () => clearTimeout(timer)
  }, [phase, engine, revealed, home, away, speed, seed, commentaryCtx])

  // 작전판 진입·pause 시 진행 중 발화를 취소한다(작전 지시 중 해설이 새지 않게).
  useEffect(() => {
    if (tacticsMode) ctts.stopAll()
  }, [tacticsMode])

  // 일시정지: 발화를 **취소가 아니라 정지**한다 — 재개하면 끊긴 자리에서 이어 말한다.
  // 문장 중간에 잘라 버리면 재개 후 그 분의 해설이 영영 사라진다(분당 1회 발화).
  useEffect(() => {
    if (frozen) ctts.pauseSpeech()
    else ctts.resumeSpeech()
    // 음악도 함께 멈춘다. 관중음은 낮은 웅성거림으로 남지만(경기장은 그대로 있다)
    // 음악은 연출이라, 화면이 얼어 있는데 곡만 흘러가면 재개 지점의 소절이 어긋난다.
    bgm.setPaused(frozen)
  }, [frozen])

  // 작전판으로 들어가면(감독 타임·하이드레이션·하프타임) 일시정지는 자동 해제한다.
  // 둘은 다른 조작이고, 겹쳐 두면 작전판을 닫았을 때 왜 안 굴러가는지 알 수 없다.
  useEffect(() => {
    if (tacticsMode) setFrozen(false)
  }, [tacticsMode])

  /**
   * **노출된 스코어** — 아직 화면에 보여 주지 않은 이 분의 골을 뺀 [home, away].
   *
   * 소리도 결과를 미리 말한다. engine.score를 그대로 보면 아직 안 보여 준 골로 관중이
   * 먼저 조용해지거나(2골차 → 게인 0.3) 먼저 뜨거워지고(1골차 → 0.5), 클러치 베드가
   * 골보다 먼저 깔린다. 화면에 보인 것만 세는 규칙은 하나뿐이어야 하므로 여기 한 곳에
   * 두고 관중 게인·BGM 클러치 베드·스코어버그가 같은 값을 읽는다 —
   * 같은 판정을 세 번 다시 쓰다가 한 곳(관중)만 원본을 보고 있었던 게 이 결함이다.
   */
  const revealedScore = useMemo<[number, number]>(() => {
    const s: [number, number] = [0, 0]
    if (!engine) return s
    for (const e of engine.events) {
      if (e.type !== 'goal') continue
      if (e.minute > engine.minute || (e.minute === engine.minute && !revealed)) continue
      s[e.teamId === engine.home.team.id ? 0 : 1] += 1
    }
    return s
  }, [engine, revealed])

  // 관중 함성 강도: 기본 0.3, 클러치(80분+·1골차 이내) 0.5, 골 직후 스웰 0.8. crowdLoop('start')는 게인만 갱신(멱등).
  // 일시정지 중에는 낮은 웅성거림으로 **덕킹**한다 — 끊으면 재개 때 클릭이 나고
  // (teardownCrowd는 페이드가 없다) 그대로 두면 정지 화면에 함성만 남아 어색하다.
  useEffect(() => {
    if (phase !== 'playing' || !engine) return
    // ★ revealed 게이트(revealedScore 경유): 클러치 판정은 **노출된 스코어**로만 센다.
    //   원본 engine.score로 세면 관중이 골보다 먼저 반응한다 — 눈보다 귀가 빨라도 예지력이다.
    const clutch = engine.minute >= 80 && Math.abs(revealedScore[0] - revealedScore[1]) <= 1
    sfx.crowdLoop('start', frozen ? CROWD_FROZEN : crowdSwell ? 0.8 : clutch ? 0.5 : 0.3)
  }, [phase, engine, revealedScore, crowdSwell, frozen])

  // ── BGM 장면 배선(docs/audio/bgm-spec.md) ───────────────────────────
  //
  // ★ **경기 중에는 음악을 깔지 않는다.** 관중 루프 + 원샷 효과음 + TTS 2화자가 이미
  //   돌고 있고 실제 중계도 인플레이에 음악을 쓰지 않는다. 아래 표에서 재생 중(playing)
  //   상태의 값이 null인 이유이며, 유일한 예외가 M09 클러치 베드다.
  //
  // 클러치 판정은 **노출된 스코어**로만 센다 — 아직 화면에 보이지 않은 골로 베드가
  // 깔리면 음악이 결과를 미리 말한다(사용자가 지적한 "예지력"과 같은 구조의 누설).
  // 세는 일 자체는 revealedScore가 한다(관중 게인과 같은 값을 써야 둘이 어긋나지 않는다).
  const clutchBed = !!engine && engine.minute >= 80 && Math.abs(revealedScore[0] - revealedScore[1]) <= 1

  const bgmScene: bgm.BgmScene | null =
    entranceScr ? null // 입장은 스팅 M06이 독점한다
      : shootoutOpen ? 'shootout' // M05
        : tacticsMode ? 'tactics' // M04 — 작전판(감독 타임·하프타임)
          : phase === 'pre' ? 'warroom' // M03 — 킥오프 전 전술 센터
            : phase === 'playing' && clutchBed ? 'clutch' // M09 — 80분 이후 + 1골 차 이내
              : null // 인플레이·풀타임 리포트 = 음악 없음
  useEffect(() => { bgm.setScene(bgmScene) }, [bgmScene])

  // 언마운트: 스웰 타이머 정리 + 관중 루프 정지(다음 화면으로 함성이 새지 않게).
  useEffect(() => () => {
    if (swellTimerRef.current) clearTimeout(swellTimerRef.current)
    sfx.crowdLoop('stop')
    ctts.stopAll()
    // 음악도 여기서 끊는다 — 기자회견·신문으로 경기 음악이 따라가면 안 된다.
    bgm.setScene(null)
    bgm.stopSting()
    bgm.setPaused(false)
  }, [])

  // 킥오프: 유저 제스처에서 AudioContext init → 관중 루프 시작. TTS 보이스 탐색도 여기서.
  //
  // 휘슬은 여기서 불지 않는다. 입장 연출(약 13.8초)이 먼저 재생되고, 선수가 흩어져
  // 자리를 잡은 뒤에야 킥오프 휘슬이 울려야 순서가 맞는다. 실제 중계도 그렇다.
  function handleKickoff() {
    sfx.init()
    ctts.initVoice()
    sfx.crowdLoop('start', 0.3)
    // 엔진이 아직 준비 전이면(이론상 도달 불가) 연출을 건너뛰고 바로 시작한다.
    if (!engine) { sfx.whistle('kickoff'); kickoff(); return }
    entranceClock.current = 0
    // 첫 경기는 전체 연출(스토리보드 4컷), 그 뒤로는 짧은 판이 기본이다 — 근거는
    // entrance.defaultEntranceMode 주석. 언제든 "선수 소개 보기"로 되돌릴 수 있다.
    const scr = entranceScript(buildEntranceCast(engine), defaultEntranceMode())
    setEntranceScr(scr)
    beginEntranceScript(scr)
    startEntranceMusic(scr)
  }

  /**
   * 입장 소개 대본을 mp3 경로로 넘긴다 — 덮이지 않으면 대본이 통째로 무음이 된다.
   *
   * ★ **전부 아니면 전무**가 계약이다(ctts.beginScript). 대본 한 줄이라도 클립이 없으면
   *   대본 전체가 조용하다 — 스물 몇 줄 중 몇 줄만 소리가 나면 명단에서 몇 명을 빠뜨린
   *   것처럼 들린다. (2026-08-02 이전엔 그 자리가 브라우저 기본 음성이었다. 폴백을
   *   걷어낸 근거는 audio/commentary-tts.ts 헤더에 있다.)
   *
   * 자막·소개 카드·행진 연출은 이 판정과 무관하게 그대로 흐른다 — 정보는 잃지 않는다.
   *
   * 지금 클립은 12개국 전부를 덮지만(public/tts/index.json), 팀 데이터나 XI 선정이
   * 바뀌면 이름이 어긋나 false로 떨어질 수 있다 — 실제로 `9992bca`(squad 배열 재정렬)가
   * 선발을 바꿔 14명이 누락된 적이 있다. 그때도 화면은 조용해질 뿐 깨지지 않는다.
   */
  function beginEntranceScript(scr: EntranceScript) {
    ctts.beginScript(scr.beats.map(b => b.speech))
  }

  /**
   * 입장 팡파르 M06(13.80s) — **두 모드가 서로 다른 것에 곡을 건다.**
   *
   * ★ 2026-08-01 재판정. 예전에는 두 모드 모두 `alignEndAtMs = totalMs`로 **끝을 킥오프
   *   휘슬에 맞췄다**. 근거는 "곡이 13.8초에 해소되고 이어서 휘슬"이었고, 그것은
   *   short(13.00s)에서만 성립한다. full(약 63초)에서는 곡이 **49초 뒤에야** 시작해
   *   연출의 마지막 1/5에만 걸린다. 유저가 실제로 들은 것은 그래서
   *   *"입장에는 아무 소리도 없다가 소개 끝물에 갑자기 팡파르"*였다(사용자 제보).
   *   덕킹으로 소개 위를 눌러 두는 절충도 같이 기각됐다 — *"그냥 명확하게 해"*.
   *
   * 지금 규칙:
   *  · **full** — 입장(터널·워크아웃·정렬)과 **동시에** 시작하고, 소개 첫 컷이 시작되는
   *    시각에 완전히 걷힌다(`fadeOutAtMs = entranceIntroStartMs`). 소개 구간은 무음이다.
   *  · **short** — 소개가 없으니 걷을 곳도 없다. 끝 맞추기를 그대로 둔다(곡 13.8s가
   *    연출 13.0s보다 0.8초 길어 앞을 잘라 내고, 해소가 킥오프 휘슬에 떨어진다).
   *
   * 소개가 끝난 뒤(disperse 2.2초 → 휘슬)를 **무음으로 두는 것도 결정**이다. 2.2초는
   * 13.8초짜리 팡파르의 어느 조각도 해소까지 데려갈 수 없는 길이여서, 되돌리면 반드시
   * 임의 지점에서 잘린다(예전 "M06 루프" 안이 기각된 바로 그 이유). 그 구간의 소리는
   * 관중 스웰과 킥오프 휘슬이 맡는다 — 실제 중계도 명단 낭독 뒤에 음악을 다시 넣지 않는다.
   */
  function startEntranceMusic(scr: EntranceScript) {
    const introStart = entranceIntroStartMs(scr)
    if (introStart == null) {
      bgm.playSting('M06', { alignEndAtMs: scr.totalMs })
      return
    }
    bgm.playSting('M06', { fadeOutAtMs: introStart })
  }

  /** short 모드에서 "선수 소개 보기" — 전체 연출로 갈아 끼우고 처음부터 다시 재생한다. */
  function expandEntrance(mode: EntranceMode = 'full') {
    const eng = useMatchStore.getState().engine
    if (!eng) return
    ctts.stopAll()
    entranceClock.current = 0
    const scr = entranceScript(buildEntranceCast(eng), mode)
    setEntranceScr(scr)
    // 대본이 통째로 갈리므로 mp3 판정도 팡파르도 새 대본 기준으로 다시 건다.
    beginEntranceScript(scr)
    bgm.stopSting(120)
    startEntranceMusic(scr)
  }

  /**
   * 입장 소개 비트 하나를 발화한다. 큐 정책이 경기 중과 다르다 —
   * {@link ctts.speakScripted}는 드롭도 선점도 하지 않는다(대본이 이미 페이싱을 잡았다).
   * ENTRANCE_SPEECH_SPEED는 비트 길이를 역산할 때 쓴 값과 **같아야** 한다.
   */
  function speakEntranceBeat(beat: { speech: string; speaker: 'caster' | 'analyst' }) {
    ctts.speakScripted(beat.speech, {
      speed: ENTRANCE_SPEECH_SPEED,
      role: beat.speaker === 'analyst' ? 'analyst' : 'normal',
    })
  }

  /** 입장 연출 종료(자연 종료·건너뛰기 공통) — 여기서 비로소 경기가 시작된다. */
  function handleEntranceDone() {
    // 전체 연출을 한 번 봤으면 다음 경기부터는 짧은 판이 기본이다.
    if (entranceScr?.mode === 'full') markEntranceSeen()
    ctts.stopAll()
    // 대본 종료 — 경기 중 중계는 아직 mp3가 없으므로 여기서 반드시 꺼야 한다.
    ctts.endScript()
    setEntranceScr(null)
    // 자연 종료면 팡파르는 방금 해소됐고, 건너뛰기면 여기서 300ms에 걷힌다.
    bgm.stopSting()
    sfx.whistle('kickoff')
    kickoff()
  }

  // 음소거 토글(sfx가 localStorage 기억) — UI 아이콘 동기화.
  function toggleMute() {
    setMutedUi(sfx.toggleMuted())
  }

  // TTS 해설 토글(commentary-tts가 localStorage 기억) — UI 동기화. OFF 시 진행 발화 중단.
  function toggleTts() {
    setTtsOnUi(ctts.toggleTts())
  }

  // ── 일시정지 토글 + 스페이스 단축키 ──────────────────────────────
  // 재생 중이거나 이미 정지 상태일 때만 의미가 있다. 작전판·입장 연출·종료에서는 무의미.
  const canFreeze = phase === 'playing' && !tacticsMode && !entranceScr
  function toggleFreeze() {
    if (!canFreeze) return
    setFrozen(f => !f)
  }

  // 스페이스 = 재생/일시정지. 영상 플레이어의 보편 관습이라 학습 비용이 0이다.
  // ★ 폼 컨트롤에 포커스가 있으면 넘긴다 — 버튼에 포커스를 두고 스페이스를 누르면
  //   브라우저가 그 버튼을 눌러 주는데, 여기서 또 처리하면 두 조작이 동시에 일어난다.
  useEffect(() => {
    if (!canFreeze) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' ||
          el?.isContentEditable || el?.getAttribute('role') === 'button') return
      e.preventDefault() // 스페이스의 기본 동작(문서 스크롤)을 막는다
      setFrozen(f => !f)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canFreeze])

  // ── 막힘 알림 자동 소멸 ────────────────────────────────────────────
  // key(id)가 바뀌면 애니메이션이 다시 재생되고 타이머도 다시 걸린다 — 같은 사유를
  // 두 번 눌러도 "도착했다"는 신호가 매번 난다(SubPanel의 nudge와 같은 장치).
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(t)
  }, [notice])

  /** 거절 사유를 알림 슬롯으로 옮긴다. 성공(null)이면 남아 있던 알림을 치운다. */
  function report(reason: string | null) {
    if (!reason) { setNotice(null); return }
    noticeSeqRef.current += 1
    setNotice({ id: noticeSeqRef.current, text: reason })
  }

  /** 감독 타임 — 막히면 store가 사유를 돌려주고, 그 문장을 그대로 알림으로 띄운다. */
  const handleManagerTime = () => report(pauseByUser())
  /** 순간 제안 [사용] — 배너가 자원이 있을 때만 이 버튼을 그리지만, 누르는 사이에 분이
   *  넘어가 쿨다운이 시작될 수 있다. 그 틈에도 침묵하지 않도록 같은 통로를 쓴다. */
  const handleAcceptMoment = () => report(acceptMoment())

  // 2D/3D 렌더러 선택 — localStorage에 기억한다(저사양·심사 환경 배려).
  // ★ 토글이 아니라 **세그먼트**다. 예전 단일 버튼은 표시 텍스트가 현재 모드,
  //   aria-label이 전환 대상이라 시각 사용자와 스크린리더 사용자가 반대로 이해했다.
  //   두 알약 중 현재 모드가 눌린 상태로 보이면 그 불일치가 구조적으로 사라진다.
  function selectRenderer(next: boolean) {
    if (next === render3d) return
    setRender3d(next)
    write3dPref(next)
  }

  // 토너먼트 무승부 → 승부차기 진입 필요 (캠페인 한정).
  const needsShootout = !!onMatchEnd && !!requireWinner && !!engine && engine.score[0] === engine.score[1]

  // 경기 결과를 캠페인으로 반환한다(홈 종료 스태미나·결정 로그 포함).
  function finishMatch(shootout?: [number, number]) {
    if (!engine || !onMatchEnd) return
    const decisionLog = useMatchStore.getState().decisionLog
    onMatchEnd(
      [engine.score[0], engine.score[1]],
      { ...engine.home.staminaByPlayer },
      shootout,
      decisionLog,
      structuredClone(engine.home.tactics),
      {
        moraleByPlayer: { ...engine.home.moraleByPlayer },
        // 우리 팀(home) 카드만 센다 — 상대 징계는 캠페인이 추적하지 않는다.
        cards: teamCardTally(engine.events, engine.home.team.id),
      },
    )
  }

  // 승부차기 진입 — 키커 순서 확정을 결정 로그에 기록.
  function openShootout() {
    logShootoutSetup('PK: 키커 순서 확정')
    setShootoutOpen(true)
  }

  if (!engine) return <div className="ms-root ms-root--empty" />

  const displayMinute = engine.minute
  // 현재 분까지 도달한 이벤트만 노출. 엔진이 분 단위로 전진하므로 engine.score와
  // 일치하지만, Ticker/PitchView와 동일 필터로 골 이벤트에서 표시 스코어를 파생한다.
  //
  // ★ 이번 분은 **결과가 화면에 보인 뒤에야**(revealed) 노출한다. 그 전에 넣으면
  //   스코어버그가 골보다 먼저 1을 올리고 티커에 "골!"이 먼저 뜬다 — 발화만 미루고
  //   글자를 그대로 두면 사용자가 지적한 예지력이 눈으로 남는다.
  const shown = engine.events.filter(e => e.minute < displayMinute || (e.minute === displayMinute && revealed))
  // 라인은 배열 단위로 만든다 — 접두 안정성이 있어 매 분 다시 계산해도 앞 줄이 바뀌지 않는다.
  // 타임라인은 캐스터 + 해설 + 소강 라인을 시간순으로 펼친 것이다(티커가 화자를 표시한다).
  // displayMinute를 넘겨야 마지막 이벤트 이후의 정적에도 소강 라인이 들어간다.
  // ★ untilMinute도 노출 게이트를 따른다. 아직 안 보여 준 분까지 훑게 하면 그 분의
  //   이벤트를 못 본 채로 "소강 구간"이라 판정해 흐름 라인을 하나 넣었다가, 노출 직후
  //   그 줄이 사라지고 결과 줄로 바뀐다(티커 한 줄이 깜빡인다).
  const tickerUntil = revealed ? displayMinute : displayMinute - 1
  const commentaryLines = commentateTimeline(shown, home, away, seed, commentaryCtx, tickerUntil)
  const tickerLines = commentaryLines.map(l => ({ minute: l.minute, text: l.text, speaker: l.speaker }))
  const lastEvent = shown[shown.length - 1]
  // 스코어버그가 읽는 표시 스코어 = 노출된 스코어. 위 `shown`에서 다시 세도 같은 값이지만,
  // 같은 규칙을 두 번 적어 두면 한쪽만 고쳐지는 사고가 난다(관중 게인이 그렇게 샜다).
  const shownScore = revealedScore
  // 좌하단 HUD가 읽는 스탯도 노출 게이트를 따른다 — 슛·유효슛·점유율은 그 분을
  // 시뮬레이션한 즉시 engine.stats에 들어가므로, 그대로 넘기면 숫자가 슛 장면보다 먼저
  // 올라간다. 노출 전에는 직전에 이미 보여 준 스냅샷을 유지한다.
  //
  // (분 경계의 한 프레임 누설은 revealed 자체가 막는다 — revealState 주석 참조.)
  if (revealed || !shownStatsRef.current) shownStatsRef.current = [engine.stats[0], engine.stats[1]]
  const shownStats = shownStatsRef.current
  // 빨리감기 연출: 재생 중 현재 분에 이벤트가 없으면 분 숫자가 빠르게 넘어간다.
  const fastForward = replaying && !engine.events.some(e => e.minute === displayMinute)

  // ── 이번 분 연출 플래그(재생 중에만) ──────────────────────────────
  const minuteEvents = engine.events.filter(e => e.minute === displayMinute)
  const diffNow = Math.abs(shownScore[0] - shownScore[1])
  const clutchNow = displayMinute >= 80 && diffNow <= 1
  // 안무 재생 시간 = 리듬 dwell(sceneDwellMs). **분 dwell이 아니다.**
  //
  // ★ 2026-08-01: 예전에는 최종 dwell(발화 하한 반영)을 넘겼다. 안무 키프레임 t가 dwell
  //   상대값이라 발화가 길어질수록 장면이 통째로 느려졌고, 그러면 결과 노출 시각도 함께
  //   밀려서 "발화를 결과 뒤로" 보정이 스스로를 쫓는다(골 필요 dwell이 22초로 발산).
  //   지금은 안무가 자기 속도로 끝나고, 남는 시간이 세리머니·중계의 여운이 된다.
  const seqDwell = sceneDwellMs(minuteEvents, speed, clutchNow, diffNow)
  // ── 3D 하이라이트 ↔ 2D 작전판 전환 ────────────────────────────────
  // 3D는 **중요한 이벤트에서만** 돈다(HIGHLIGHT_TYPES = 골·세이브·미스·슛·퇴장).
  // 코너·파울·경고·찬스와 무사건 분은 2D 작전판이 받는다 — 그게 "하이라이트"의 뜻이고,
  // 유한한 장면 라이브러리를 모든 이벤트에 돌리면 반복이 금방 눈에 띈다.
  const live3d = replaying && !!highlight && isHighlightEvent(highlight.event)
  const analysisOn = replaying && !live3d
  // 재생 중에는 항상 시퀀스가 있다: 하이라이트 안무 아니면 점유 흐름(리사주 없음).
  const activeSeq = highlight?.seq ?? flow?.seq
  const activeSide: 'home' | 'away' = highlight?.side ?? flow?.side ?? 'home'
  const playSequence = replaying && !!activeSeq && activeSeq.length > 0
  // 2D 보드 캡션 — 지금 무엇을 보고 있는지 한 줄.
  const possTeam = activeSide === 'home' ? home : away
  const analysisCaption = highlight
    ? `${displayMinute}' ${EVENT_KO[highlight.event.type] ?? '전개'} — 세트피스·국면 정리`
    : `${possTeam.name.ko} 점유 — ${flow?.label ?? '전개'}`
  // 골 드라마: 이번 분 득점. 상대 골이면 실점 연출로 차별화.
  // ★ revealed 게이트 — 공이 그물에 닿기 전에 "GOAL"이 뜨면 연출이 결과를 미리 말한다.
  const goalEvent = revealed ? minuteEvents.find(e => e.type === 'goal') : undefined
  const goalDrama = replaying && !!goalEvent
  const conceded = !!goalEvent && goalEvent.teamId !== home.id
  const scorerTeam = goalEvent ? (goalEvent.teamId === home.id ? home : away) : undefined
  const scorerName = goalEvent?.playerId && scorerTeam
    ? scorerTeam.squad.find(p => p.id === goalEvent.playerId)?.name.ko
    : undefined
  // 위험 순간: xG 0.25+ 세이브·미스.
  const dangerEvent = revealed
    ? minuteEvents.find(e => (e.type === 'save' || e.type === 'miss') && (e.xg ?? 0) >= DANGER_XG)
    : undefined
  const dangerMoment = replaying && !!dangerEvent

  // 상단 방송 배너 — broadcast 모드(재생 중) 순간 제안이 우선. 정지·하프타임 안내는 작전판이 담당.
  // 제안이 없을 때만 상대 감독의 최근 변경 통보를 3분간 흘려보낸다(슬롯 1개를 공유하므로
  // 감독의 결정 기회를 상대 통보가 가리면 안 된다).
  //
  // ★ revealed 게이트 — "실점 직후입니다"가 실점보다 먼저 뜨면 배너가 스코어버그·GOAL
  //   연출을 제치고 결과를 말해 버린다(예지력의 텍스트판). momentPrompt는 advanceMinute이
  //   그 분을 시뮬레이션한 **직후** 세팅되는데 골 안무는 6~7초 뒤에야 공을 그물에 넣는다.
  //   단, 게이트는 **이번 분에 뜬 제안**에만 건다. 지난 분의 제안(TTL 동안 살아 있다)은
  //   이미 노출된 결과를 말하고 있어 누설이 아니고, 거기까지 닫으면 뒤따르는 골 분마다
  //   배너가 통째로 사라졌다 돌아온다 — 결정을 요구하는 슬롯이 깜빡이는 게 더 나쁘다.
  const momentShowable = revealed || (!!momentPrompt && momentPrompt.minute < displayMinute)
  /**
   * **제안인가, 알림인가** — 자원이 가른다(사용자 지적 2026-08-01).
   *
   * 예전에는 순간이 감지되면 무조건 *"… — 감독 타임을 쓰시겠습니까?"* + [사용]을 그렸다.
   * 개입을 다 썼거나 쿨다운 중이어도 그대로 떴고, 눌러도 store가 조용히 거절했다.
   * 화면이 쓸 수 없는 것을 권한 셈이다.
   *
   * 지금은 같은 순간을 두 얼굴로 그린다:
   *  · 쓸 수 있다 → 제안. `… — 감독 타임을 쓰시겠습니까?` + [사용] [흘려보낸다]
   *  · 못 쓴다   → 알림. `…` + **왜 못 쓰는지**(store의 blockedReason 그대로). 버튼 없음.
   *
   * 상황 자체를 숨기지 않는 이유: `흐름이 상대에게 넘어갑니다`는 감독 타임과 무관하게
   * 유저가 알아야 할 경기 사실이고, 그 사실까지 지우면 화면이 조용해진다.
   * 판정을 **렌더 시점**에 두므로, 배너가 살아 있는 동안 쿨다운이 풀리면 같은 배너가
   * 저절로 알림에서 제안으로 승격한다(matchStore.advanceMinute의 소비 규칙과 짝이다).
   */
  const momentLive = replaying && !!momentPrompt && momentShowable
  const momentOfferable = momentLive && freeIntervention.canPause
  const momentBanner = momentLive
    ? momentOfferable
      ? `${MOMENT_PHRASE[momentPrompt!.kind]} — 감독 타임을 쓰시겠습니까?`
      : `${MOMENT_PHRASE[momentPrompt!.kind]} — ${freeIntervention.blockedReason}`
    : null
  const lastNotice = oppNotices.length > 0 ? oppNotices[oppNotices.length - 1] : null
  const recentNotice = lastNotice && displayMinute - lastNotice.minute < 3 ? lastNotice.text : null
  const bannerText = momentBanner ?? recentNotice

  // ── 렌더러 체인 조립(모든 단계가 같은 props 계약을 받는다) ──────────
  // 3D는 이 2D 체인을 fallback 노드로 주입받는다 — Match3D가 pixi를 정적으로
  // import하면 three 청크에 pixi가 딸려오므로, 노드로 넘겨 청크 분리를 유지한다.
  const pitchProps = {
    state: engine,
    lastEvent,
    sequence: playSequence ? activeSeq : undefined,
    dwellMs: seqDwell,
    sequenceSide: activeSide,
    // 일시정지는 렌더러 3단 전부에 같은 계약으로 내려간다(3D·Pixi·SVG).
    paused: frozen,
  }
  const pitchSvg = <PitchView {...pitchProps} />
  const pitch2d = (
    <PitchBoundary fallback={pitchSvg}>
      <Suspense fallback={pitchSvg}>
        <PixiPitch {...pitchProps} />
      </Suspense>
    </PitchBoundary>
  )

  // ── 방송 furniture 노출 판정 ──────────────────────────────────────
  // 원칙: **오버레이가 뜨면 그 아래 furniture는 실제로 언마운트한다.**
  // opacity·pointer-events로 죽이면 텍스트가 겹쳐 쌓인다(실측: 작전판 터치라인 문구가
  // 스코어버그 시계와 92%, 플랜 배지와 100% 겹쳤다).
  //  · 작전판(정지·하프타임) — 작전판이 자체 헤더를 갖는다.
  //  · 입장 연출 — 0:0 0' 스코어버그와 중계 티커가 돌면 "아직 시작 전"이 무너진다.
  //    대신 프리매치 스트립 한 줄만 남긴다.
  const finished = phase === 'fulltime'
  const overlayOpen = tacticsMounted || !!entranceScr
  const chromeOn = !overlayOpen
  // 킥오프 전 전술 설계 화면(워룸)에서는 재생 관련 furniture가 전부 의미가 없다.
  // 되감을 경기도, 바꿀 배속도, 전환할 렌더러도 아직 없다. 남아 있으면
  // "이미 경기가 돌아가고 있다"는 잘못된 신호를 준다(감사 W-12).
  const preDesign = phase === 'pre' && !entranceScr
  /**
   * **풀블리드 방송 스테이지**(입장 연출 · 재생 · 정지). 킥오프 전 워룸과 종료
   * 리포트는 읽는 화면이라 예전처럼 문서 흐름을 쓴다.
   *
   * 왜 바꿨나(실측): 상단 furniture가 흐름 요소라 1920에서 캔버스 위 182px, 390에서
   * 330px이 빈 띠였고, 캔버스가 화면의 26~63%밖에 되지 않았다. 실제 중계는 화면 전체가
   * 경기장이고 스코어버그·시계·티커가 그 위에 얹힌다 — 그 문법을 그대로 따른다.
   */
  const liveStage = !preDesign && !finished

  return (
    <div className={`ms-root${overlayOpen ? ' ms-root--overlay' : ''}${liveStage ? ' ms-root--live' : ''}`}>
      {/* ── 상단 방송 furniture — 스코어버그만. 풀블리드 스테이지 위에 **얹힌다**.
          제어 그룹은 스테이지 안(.ms-controls)으로 내려갔다: 데스크톱에서는 우상단에
          같이 떠 있지만, 390에서는 피치 아래 흐름 요소가 되어야 하기 때문이다
          (좁은 화면에서 7개 컨트롤을 피치 위에 얹으면 경기가 안 보인다). ── */}
      {/* ★ 풀타임에는 스코어버그를 내린다(감사 R6-B). 리포트가 "경기 종료 KOR 3:2 CZE"를
          크게 보여 주는데 그 위에 라이브 스코어버그가 같은 점수를 한 번 더 띄우고 있었다 —
          같은 사실을 두 번 말하는 화면이고, 아래는 정작 비어 있었다.
          CSS(:has)로 감추지 않은 이유: 스코어버그가 **유일하게** 들고 있던 정보인 대회명이
          함께 사라진다. 그래서 대회명을 리포트 헤더로 옮기고 여기서는 통째로 내린다. */}
      {chromeOn && !finished && (
        <header className="ms-topbar">
          <Scorebug
            home={home}
            away={away}
            score={shownScore}
            minute={displayMinute}
            live={replaying && !frozen}
            paused={frozen}
            fastForward={fastForward && !frozen}
            pulse={goalDrama}
            context={context}
          />
        </header>
      )}

      {/* 입장 연출 중 유일한 furniture — 대진 한 줄. 시계도 스코어도 없다. */}
      {entranceScr && (
        <header className="ms-topbar ms-topbar--prematch">
          <p className="ms-prematch">
            <span className="ms-prematch__teams">{home.name.ko} vs {away.name.ko}</span>
            <span className="ms-prematch__ctx">{context}</span>
          </p>
        </header>
      )}

      <main
        className={
          `ms-stage${phase === 'pre' && !entranceScr ? ' ms-stage--pre' : ''}` +
          // 배너가 떠 있는 동안만 2D 작전판이 그만큼 아래로 물러난다(match.css).
          `${bannerText && !finished ? ' ms-stage--banner' : ''}`
        }
      >
        {/* ── 피치 — 관전 중 언제나 보인다(가리는 오버레이 없음).
            렌더러 체인: Match3D(three) → PixiPitch(pixi) → PitchView(SVG).
            각 단계는 청크 로드 실패를 PitchBoundary가, 런타임 미지원(WebGL 불가·
            컨텍스트 로스)을 컴포넌트 내부 폴백이 받아 다음 단계로 넘긴다.

            ★ 종료(fulltime)에는 통째로 언마운트한다 — 빈 피치가 화면의 47%를 먹고
            있을 이유가 없다. 그 자리는 기록 리포트가 가져간다. ── */}
        {!finished && (
          <div
            className="ms-pitch-wrap"
            data-mode={live3d ? '3d' : '2d'}
            data-scene={highlight ? (sceneKeyFor(highlight.event, engine.home, engine.away) ?? 'none') : 'flow'}
          >
            {render3d ? (
              <PitchBoundary key="chain-3d" fallback={pitch2d}>
                <Suspense fallback={pitchSvg}>
                  {/* event: 하이라이트가 아닌 분엔 null — movement가 그 분의 코너·파울을
                      역추적해 엉뚱한 궤적·카메라를 붙이지 않게 명시적으로 끊는다. */}
                  <Match3D
                    {...pitchProps}
                    event={live3d ? highlight!.event : null}
                    fallback={pitch2d}
                    entrance={entranceScr}
                    entranceClock={entranceClock}
                  />
                </Suspense>
              </PitchBoundary>
            ) : (
              pitch2d
            )}
            {/* ── 2D 작전판: 라이브 위에 겹쳐 두고 opacity로 오간다(match.css의 비대칭 전환).
                3D는 언마운트하지 않는다 — WebGL 컨텍스트 재생성이 매번 히치를 만든다. ── */}
            {replaying && (
              <AnalysisBoard
                state={engine}
                sequence={playSequence ? activeSeq : undefined}
                dwellMs={seqDwell}
                sequenceSide={activeSide}
                caption={analysisCaption}
                visible={analysisOn}
                paused={frozen}
              />
            )}
            {/* 입장 연출 오버레이 — 자막·선수 소개 카드·건너뛰기. */}
            {entranceScr && (
              <EntranceOverlay
                // key = 모드. "선수 소개 보기"로 갈아 끼우면 클럭이 0부터 다시 산다.
                key={entranceScr.mode}
                script={entranceScr}
                onDone={handleEntranceDone}
                onProgress={ms => { entranceClock.current = ms }}
                onBeat={speakEntranceBeat}
                {...(entranceScr.mode === 'short' ? { onExpand: () => expandEntrance('full') } : {})}
              />
            )}
            {/* ── 골 드라마: 대형 타이포 + 득점자 배너(스코어버그 펄스는 별도) ──
                풀스크린 플래시·파티클·카메라 셰이크는 PixiPitch(WebGL)가 담당한다.
                피치를 가리지 않는 순간 이펙트(pointer-events 없음). key=분으로 골마다 재발동. */}
            {goalDrama && (
              <div
                key={`drama-${displayMinute}`}
                className={`ms-drama ms-drama--${conceded ? 'concede' : 'score'}`}
                aria-hidden="true"
              >
                <span className="ms-drama__word">{conceded ? '실점' : 'GOAL'}</span>
              </div>
            )}
            {goalDrama && (
              <div key={`scorer-${displayMinute}`} className="ms-scorer" role="status">
                <span className={`badge${conceded ? ' badge--danger' : ' badge--good'} ms-scorer__tag`}>
                  {conceded ? '실점' : '골'}
                </span>
                <span className="ms-scorer__name">{scorerName ?? scorerTeam?.name.ko ?? ''}</span>
                <span className="ms-scorer__min num">{displayMinute}&apos;</span>
              </div>
            )}
            {/* ── 위험 순간: 비네팅(가장자리 어두워짐) 0.5s ── */}
            {dangerMoment && <span key={`vig-${displayMinute}`} className="ms-vignette" aria-hidden="true" />}
          </div>
        )}

        {/* ── 방송 배너(순간 제안 · 상대 감독 통보) ──
            풀블리드 모드에서는 스코어버그 아래 가운데에 **얹힌다**(match.css).
            흐름 요소로 두면 배너가 뜰 때마다 피치가 밀려 WebGL 캔버스가 리사이즈된다 —
            하필 결정을 요구하는 순간에 히치가 나는 셈이다. 390에서는 흐름으로 돌아간다. ── */}
        {bannerText && !finished && (
          <div
            className={
              `ms-banner${momentBanner ? ' ms-banner--moment' : ' ms-banner--opp'}` +
              // 자원이 없어 제안이 아닌 **알림**인 경우 — 행동을 요구하지 않으므로 톤을 낮춘다.
              `${momentBanner && !momentOfferable ? ' ms-banner--info' : ''}`
            }
            role="status"
          >
            <span className="ms-banner__text">{bannerText}</span>
            {/* ★ momentBanner가 아니라 momentOfferable을 조건으로 쓴다. 노출 게이트로 제안
                문장이 밀려 상대 감독 통보가 슬롯을 차지한 동안에는 "실점 직후입니다"가 안
                보이는데 [사용]/[흘려보낸다]만 통보 옆에 붙어 무엇에 대한 선택인지 알 수
                없게 되고, 자원이 없을 때는 누를 수 없는 [사용]이 붙는다. */}
            {momentOfferable && (
              <span className="ms-banner__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={handleAcceptMoment}>사용</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={dismissMoment}>흘려보낸다</button>
              </span>
            )}
          </div>
        )}

        {/* ── 제어 그룹 — 데스크톱: 피치 우상단에 떠 있는 pod / 390: 피치 **아래** 흐름.
            왜 스코어버그와 갈라놨나: 좁은 화면에서 컨트롤 7개를 피치 위에 얹으면
            경기가 안 보인다. 스코어버그(읽기 전용·작다)만 위로 올리고 조작은 내린다.
            pod가 자체 스크림을 까는 이유: `.btn--secondary`는 배경이 투명이라 잔디
            위에 그냥 얹으면 흰 글자가 묻는다(랜딩 감사의 1.08:1 결함과 같은 구조).
            ★ 종료 후에는 통째로 내린다 — 그 시점엔 관중 루프도 해설도 이미 멈춰 있어
            음소거·해설 토글이 아무것도 하지 않는다. 빈 조작 줄이 리포트 위에 남을 뿐이다. ── */}
        {chromeOn && !finished && (
          <div className="ms-controls">
            {demoNote && <span className="badge">{demoNote}</span>}
            {/* 2차 정보(플랜 상태)는 스코어버그 본체에 얹지 않고 별도 슬롯으로 둔다. */}
            {!preDesign && (
              <span className="ms-plan-slot">
                <PlanBadge />
              </span>
            )}
            {!preDesign && <SpeedToggle speed={speed} onChange={setSpeed} />}
            {/* 일시정지 — **감독 타임과 다른 조작이다**. 시계만 멈추고 개입 권한은
                주지 않는다. 그래서 primary(감독의 결정)가 아니라 secondary다. */}
            {canFreeze && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                aria-pressed={frozen}
                aria-keyshortcuts="Space"
                title="스페이스"
                onClick={toggleFreeze}
              >
                {frozen ? '재생' : '일시정지'}
              </button>
            )}
            {/* ── 감독 타임 = **희소 자원**. 잔량과 쿨다운이 항상 보여야 한다 ──
                자유 개입은 5회 + 10분 쿨다운이다(외침은 여기서 세지 않는다). 계획해서 쓰라고 만든
                제약인데 잔량이 안 보이면 계획이 불가능하다 — 그래서 부가 정보가 아니라
                버튼과 한 묶음이다.

                왜 여기(제어 pod)인가: 잔량은 **그 버튼의 상태**이지 경기 상황이 아니다.
                ShoutBar가 쿨다운 문구를 자기 버튼 옆에 두는 것과 같은 규칙이고
                ("이유 없는 disabled는 고장으로 읽힌다"), 하단 액션 바로 내리면 감독 타임
                버튼과 그 사유가 화면 반대편으로 갈라져 무엇이 막혔는지 알 수 없다.
                시각 언어는 ShoutBar에서 그대로 빌린다(sb-ring 원형 링·sb-cool 사유 문구) —
                같은 10분 시계이므로 다르게 생기면 다른 자원으로 읽힌다.

                문구는 store(freeInterventionState.blockedReason)가 정본이다. 화면에서
                따로 지어내면 "눌리는데 거부되는" 조합이 생긴다.

                ★ 2026-08-01 — 사유 문장을 **상시 노출에서 뺐다**(사용자 지시 ①). 40자가
                넘는 문장이 버튼 옆에 늘 서 있어 pod가 두 줄이 됐는데, 정작 "언제 돌아오는가"는
                쿨다운 링이 이미 말하고 있었다. 지금은 **누르면** 잠깐 뜨는 알림으로 나온다
                (notice 상태 주석). 그래서 버튼도 disabled가 아니라 aria-disabled다 —
                disabled면 클릭이 오지 않아 "눌러도 아무 말이 없다"가 그대로 남는다
                (SubPanel의 [교체 확정]과 같은 처방). */}
            {replaying && (
              <>
                <span className="badge num">개입 {freeIntervention.left}/{MAX_FREE_INTERVENTIONS}</span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm sb-btn"
                  aria-disabled={!freeIntervention.canPause}
                  data-blocked={!freeIntervention.canPause || undefined}
                  onClick={handleManagerTime}
                >
                  {freeIntervention.cooldownLeft > 0 && (
                    <svg className="sb-ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                      <circle className="sb-ring__track" cx="10" cy="10" r={RING_R} />
                      <circle
                        className="sb-ring__arc"
                        cx="10"
                        cy="10"
                        r={RING_R}
                        strokeDasharray={`${(Math.min(1, freeIntervention.cooldownLeft / INTERVENTION_COOLDOWN) * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
                      />
                    </svg>
                  )}
                  감독 타임
                </button>
              </>
            )}
            {/* ── 설정 — 자주 안 바꾸는 셋(2D/3D · 음소거 · 해설 음성)을 접는다.
                pod의 **맨 끝**이다: 경기 중 손이 가는 순서(재생 → 배속 → 개입 → 감독 타임)를
                지나 마지막에 놓아야 자주 쓰는 것이 먼저 잡힌다. ── */}
            <SettingsMenu
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              showRenderer={!preDesign}
              render3d={render3d}
              onSelectRenderer={selectRenderer}
              muted={muted}
              onToggleMute={toggleMute}
              showTts={!preDesign}
              ttsOn={ttsOn}
              onToggleTts={toggleTts}
            />

            {/* ── 막힘 알림 — 3.8초 뒤 스스로 사라진다.
                문법은 팀토크 배너(tt-banner)를 그대로 빌린다. 외침 결과 배너(sb-banner)가
                이미 같은 문법을 입고 있어, 유저가 한 번 배운 "잠깐 떴다 사라지는 말"의
                읽는 법이 화면 위아래에서 똑같이 쓰인다 — 새 레이어를 발명하지 않는다. ── */}
            {/* ★ `--down`(빨강)을 쓰지 않는다. 그 톤은 팀토크·외침이 **역효과**를 냈을 때의
                것이고, 여기서 일어난 일은 나쁜 결과가 아니라 *"아직 쓸 수 없다"*는 규칙
                안내다. 규칙을 실패처럼 칠하면 유저가 자기가 뭘 잘못했다고 읽는다. */}
            {notice && (
              <div key={notice.id} className="tt-banner ms-notice" role="status">
                <span className="tt-banner__text">{notice.text}</span>
              </div>
            )}
          </div>
        )}

        {/* ── 라이브 스탯 HUD(좌하단 game assist 슬롯) ──
            관전 중 감독이 답을 알아야 하는 질문은 둘뿐이다 — 공을 갖고 있나,
            더 만들고 있나. 나머지 기록은 정지·하프타임의 작전판이 답한다.
            ★ 피치 래퍼 **밖**에 둔다: 안에 두면 sm에서 흐름 요소로 내렸을 때
            피치와 나란히 서서 피치 폭을 반으로 깎는다(실측 366 → 123px).
            ★ 2D 작전판이 켜지면 **내린다**(!analysisOn). 작전판은 하단에 범례·전술
            칩·요약(점유·슛·xG)을 이미 갖고 있어 같은 정보를 두 번 말하게 되고,
            HUD가 그 범례와 칩 위에 떠서 앞부분을 가렸다. 한 모드에 정보 주인은
            하나다 — 보는 모드는 HUD가, 읽는 모드는 작전판이 답한다. */}
        {replaying && !analysisOn && (
          <LiveStats
            us={shownStats[0]}
            them={shownStats[1]}
            minute={displayMinute}
            usCode={home.fifaCode}
            themCode={away.fifaCode}
          />
        )}

        {/* ── 킥오프 전 전술 센터 — 방송 스테이지 아래에 붙는 워룸.
            입장 연출 중에는 내린다 — 킥오프를 이미 눌렀으므로 설계는 끝났다. ── */}
        {phase === 'pre' && !entranceScr && (
          <div className="ms-precenter">
            <TacticsCenter onKickoff={handleKickoff} referenceScore={referenceScore} />
          </div>
        )}

        {/* ── 풀타임 리포트 — 전체 화면. 3D·속도 토글·플랜 배지는 이미 언마운트됐다. ── */}
        {finished && (
          <section className="ms-report" aria-label="경기 결과">
            {shootoutOpen ? (
              <ShootoutPanel
                home={home}
                away={away}
                seed={seed}
                regulationScore={[engine.score[0], engine.score[1]]}
                /* 규정: 종료 휘슬 시점에 필드에 있던 선수만 킥을 찬다. lineup은 교체가
                   반영된 현재 XI이므로 퇴장자만 덜어내면 자격 명단이 된다. */
                homeEligibleIds={onPitchIds(engine.home.tactics.lineup, engine.home.sentOff)}
                awayEligibleIds={onPitchIds(engine.away.tactics.lineup, engine.away.sentOff)}
                onDone={result => finishMatch(result)}
              />
            ) : (
              <>
                <header className="ms-report__head">
                  {/* 대회명은 스코어버그에서 물려받은 것이다(위 R6-B 주석) — 결과 화면에서도
                      "무슨 대회의 경기였는가"는 남아야 한다. */}
                  <span className="eyebrow">{context} · 경기 종료</span>
                  <div className="ms-final">
                    <span className="ms-final__team">
                      <span className="kit-strip kit-strip--us" aria-hidden="true" />
                      <span className="num">{home.fifaCode}</span>
                    </span>
                    <span className="ms-final__score num">{engine.score[0]} : {engine.score[1]}</span>
                    <span className="ms-final__team ms-final__team--away">
                      <span className="num">{away.fifaCode}</span>
                      <span className="kit-strip kit-strip--them" aria-hidden="true" />
                    </span>
                  </div>
                </header>
                <StatsTable
                  home={engine.stats[0]}
                  away={engine.stats[1]}
                  homeCode={home.fifaCode}
                  awayCode={away.fifaCode}
                />
                <div className="ms-report__actions">
                  {!onMatchEnd ? (
                    <button
                      type="button"
                      className="btn btn--primary btn--lg"
                      onClick={() => { reset(); startMatch(home, away, seed) }}
                    >
                      다시 보기
                    </button>
                  ) : needsShootout ? (
                    <button type="button" className="btn btn--primary btn--lg" onClick={openShootout}>승부차기로</button>
                  ) : (
                    <button type="button" className="btn btn--primary btn--lg" onClick={() => finishMatch()}>결과 확정</button>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </main>

      {/* ── 하단 액션 바 — 외침 + 중계 티커. 둘 다 바 **안**에 들어간다.
          티커를 별도 절대배치 레이어로 띄우면 오버레이·득점자 배너와 겹쳐 쌓인다. ── */}
      {chromeOn && !finished && (
        <footer className="ms-bottombar">
          {replaying && <ShoutBar frozen={frozen} />}
          <Ticker lines={tickerLines} emphasis={dangerMoment} />
        </footer>
      )}

      {/* ── 작전판 오버레이(tactics 모드) — 전체 화면 시트.
          예전엔 inset:12px + overflow:hidden이라 390px에서 572px 중 79%가 하드클립됐고
          (모바일에서 교체 불가), 그 아래 방송 furniture가 살아 있어 텍스트가 겹쳐 쌓였다.
          지금은 화면을 통째로 덮고 넘치는 만큼 스크롤한다. ── */}
      {tacticsMounted && (
        <div className={`ms-tactics-layer scroll-y${tacticsExiting ? ' ms-tactics-layer--exiting' : ''}`}>
          <TacticsBoard />
        </div>
      )}
    </div>
  )
}

const SPEEDS: PlaybackSpeed[] = [1, 1.5, 2]

/** 재생 속도 — 상단 제어 그룹 안의 세그먼트. 배타 선택이므로 `.seg`가 정확한 형태다. */
function SpeedToggle({ speed, onChange }: { speed: PlaybackSpeed; onChange(s: PlaybackSpeed): void }) {
  return (
    <div className="seg" role="group" aria-label="재생 속도">
      {SPEEDS.map(s => (
        <button
          key={s}
          type="button"
          aria-pressed={speed === s}
          className="seg__item num"
          onClick={() => onChange(s)}
        >
          {s}x
        </button>
      ))}
    </div>
  )
}
