import { useMemo, useState } from 'react'
// 예외 승인: App.tsx는 캠페인/데모 기본 XI 산정(lineup)을 위해
// 엔진 모듈 직접 import를 허용한다(조립 최상단 진입점 한정).
import { pickBestXI } from './engine/lineup'
import type { TacticState } from './engine/types'
import { MatchScreen } from './ui/match/MatchScreen'
import { LandingScreen } from './ui/landing/LandingScreen'
import { HubScreen } from './ui/campaign/HubScreen'
import { EndingScreen } from './ui/campaign/EndingScreen'
import { PressConference } from './ui/press/PressConference'
import { NewspaperCard } from './ui/press/NewspaperCard'
import { useCampaignStore } from './game/campaignStore'
import type { MatchRecord } from './game/campaignStore'
import type { Headline } from './game/pressconf'
import { loadTeam } from './data/loader'
import { GROUP_MATCHES, type GroupMatch } from './data/groupStage'
import './App.css'

// 재현성을 위해 시드 고정 (Math.random·Date 미사용).
const DEMO_SEED = 20260724
const CAMPAIGN_SEED = 20260724

type Mode = 'landing' | 'demo' | 'campaign'

function App() {
  const [mode, setMode] = useState<Mode>('landing')
  const startCampaign = useCampaignStore(s => s.startCampaign)
  const resetCampaign = useCampaignStore(s => s.reset)

  if (mode === 'demo') {
    return <DemoFlow onExit={() => setMode('landing')} />
  }

  if (mode === 'campaign') {
    return <CampaignFlow onExit={() => { resetCampaign(); setMode('landing') }} />
  }

  return (
    <LandingScreen
      onCampaign={() => { resetCampaign(); startCampaign(CAMPAIGN_SEED); setMode('campaign') }}
      onDemo={() => setMode('demo')}
    />
  )
}

/** 데모 플로우: 실팀(kor vs esp, 고정 시드) 한 경기 → 기자회견 → 신문 → 랜딩 복귀.
 *  캠페인 기록·리더보드에는 반영하지 않는다("리더보드 미반영" 표기). */
function DemoFlow({ onExit }: { onExit(): void }) {
  const teams = useMemo(() => ({ home: loadTeam('kor'), away: loadTeam('esp') }), [])
  // 데모도 유저는 대한민국(kor)을 지휘한다.
  const teamName = teams.home.name.ko
  // 킥오프 전 설계는 MatchScreen의 'pre' 전술 센터가 담당한다(라인업 단독 화면 폐지).
  // useMemo로 참조를 고정해야 MatchScreen의 초기화 effect가 매 렌더 재실행되지 않는다.
  const initial = useMemo(() => pickBestXI(teams.home), [teams.home])

  const [result, setResult] = useState<PostMatch | null>(null)
  const [headline, setHeadline] = useState<Headline | null>(null)

  if (!result) {
    return (
      <div className="demo-wrap">
        <div className="demo-banner" role="note">데모 · 리더보드 미반영</div>
        <MatchScreen
          home={teams.home}
          away={teams.away}
          seed={DEMO_SEED}
          initialTactics={initial}
          onMatchEnd={(score, _stamina, shootout, decisions) => {
            // 데모에는 캠페인 기록이 없으므로 임시 MatchRecord를 중립값으로 구성한다
            // (stage='r32' 중립·상대 'esp'). 결정 로그는 matchStore가 수집한 실제 개입 기록.
            const record: MatchRecord = {
              stage: 'r32', opponentId: 'esp', score,
              ...(shootout ? { shootout } : {}), decisions,
            }
            setResult({ record })
          }}
        />
      </div>
    )
  }

  if (!headline) {
    return (
      <PressConference
        record={result.record}
        log={result.record.decisions}
        teamName={teamName}
        onDone={setHeadline}
      />
    )
  }

  return (
    <div className="demo-wrap">
      <div className="demo-banner" role="note">데모 · 리더보드 미반영</div>
      <NewspaperCard headline={headline} record={result.record} teamName={teamName} onNext={onExit} />
    </div>
  )
}

/** 경기 종료 결과 보관: 임시/확정 MatchRecord + 홈 종료 스태미나(캠페인 이월용). */
interface PostMatch {
  record: MatchRecord
  stamina?: Record<string, number>
  /** 경기 종료 시점의 홈 전술 — 다음 경기 초기값으로 이월한다. */
  finalTactics?: TacticState
}

type CampaignStep = 'hub' | 'match'

/** 캠페인 플로우 조립: hub → match(킥오프 전 전술 센터 포함) →(자동 recordResult)→ hub … → ending.
 *  라인업 단독 화면은 전술 센터에 흡수됐다 — 허브에서 곧장 경기로 들어간다. */
function CampaignFlow({ onExit }: { onExit(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const ending = useCampaignStore(s => s.ending)
  const [step, setStep] = useState<CampaignStep>('hub')
  // 직전 경기의 종료 시점 전술을 다음 경기 초기값으로 이월한다(8경기 반복 마찰 제거).
  const [carried, setCarried] = useState<TacticState | null>(null)

  const kor = useMemo(() => loadTeam('kor'), [])
  // MatchScreen 초기화 effect의 deps에 들어가므로 참조가 안정적이어야 한다.
  const initialTactics = useMemo(() => carried ?? pickBestXI(kor), [carried, kor])

  // 종료 → 엔딩(부모 store가 stage/ending을 갱신하면 여기로 수렴).
  if (stage === 'ended' || ending) {
    return <EndingScreen onRestart={onExit} />
  }

  if (step === 'hub') {
    return <HubScreen onProceed={() => setStep('match')} />
  }

  // step === 'match'
  return (
    <CampaignMatch
      tactics={initialTactics}
      onBackToHub={next => { if (next) setCarried(next); setStep('hub') }}
    />
  )
}

/** 캠페인 한 경기 — 상대·시드·조별 스크립트·체력 이월을 조립해 MatchScreen에 전달.
 *  경기 종료 → 기자회견 → 신문 카드 → [다음]에서 recordResult 후 허브 복귀.
 *
 *  [구조 선택] record는 recordResult 이전에 방금 결과로 "임시 MatchRecord"를 구성한다.
 *  recordResult를 먼저 부르면 최종전/탈락전에서 stage='ended'가 되어 부모(CampaignFlow)가
 *  즉시 EndingScreen으로 전환 → 기자회견을 건너뛴다. 따라서 결과를 임시 record로 붙들고
 *  기자회견·신문까지 보여준 뒤, [다음]에서 recordResult로 상태를 전진시킨다. */
function CampaignMatch({ tactics, onBackToHub }: {
  tactics: TacticState
  /** next: 경기 종료 시점의 홈 전술(다음 경기 이월용). 없으면 이월하지 않는다. */
  onBackToHub(next: TacticState | null): void
}) {
  const currentOpponent = useCampaignStore(s => s.currentOpponent)
  const matchSeed = useCampaignStore(s => s.matchSeed)
  const startingStamina = useCampaignStore(s => s.startingStamina)
  const recordResult = useCampaignStore(s => s.recordResult)
  const stage = useCampaignStore(s => s.stage)

  const kor = useMemo(() => loadTeam('kor'), [])
  const teamName = kor.name.ko
  const oppId = currentOpponent()
  const opp = useMemo(() => loadTeam(oppId), [oppId])
  const seed = matchSeed()
  const isGroup = stage === 'group1' || stage === 'group2' || stage === 'group3'

  const [result, setResult] = useState<PostMatch | null>(null)
  const [headline, setHeadline] = useState<Headline | null>(null)

  // 매치별 파생 props는 seed(진행 순 고정)에 고정 memo → MatchScreen 재초기화 방지.
  //
  // [F1 B안 · 2026-07-26] 조별 경기도 1분부터 90분까지 완전 시뮬한다.
  // 예전에는 여기서 firstHalfScript를 만들어 넘겼고, 그러면 엔진이 전반 45분을 통째로 건너뛰어
  // 유저 플랜이 조별 3경기의 절반 동안 무력화됐다. 배선을 끊어 전반부터 전술이 작동하게 한다.
  // GROUP_MATCHES에서 남겨 쓰는 것은 realScore 하나 — "참고 · 실제 역사 2-1" 기준선 표시용이다.
  const derived = useMemo(() => {
    const staminaOverride: Record<string, number> = {}
    for (const p of kor.squad) staminaOverride[p.id] = startingStamina(p.id)
    const gm: GroupMatch | undefined = isGroup ? GROUP_MATCHES.find(m => m.opponent === oppId) : undefined
    return { staminaOverride, referenceScore: gm?.realScore, requireWinner: !isGroup }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  // 경기 진행 중 — 종료 시 임시 MatchRecord로 결과를 붙든다(recordResult는 [다음]에서).
  if (!result) {
    return (
      <MatchScreen
        home={kor}
        away={opp}
        seed={seed}
        initialTactics={tactics}
        staminaOverride={derived.staminaOverride}
        referenceScore={derived.referenceScore}
        requireWinner={derived.requireWinner}
        onMatchEnd={(score, stamina, shootout, decisions, finalTactics) => {
          const record: MatchRecord = {
            stage, opponentId: oppId, score,
            ...(shootout ? { shootout } : {}), decisions,
          }
          setResult({ record, stamina, finalTactics })
        }}
      />
    )
  }

  // 기자회견 — 3문항 답변 후 헤드라인 확정.
  if (!headline) {
    return (
      <PressConference
        record={result.record}
        log={result.record.decisions}
        teamName={teamName}
        onDone={setHeadline}
      />
    )
  }

  // 신문 1면 — [다음]에서 결과를 캠페인에 반영하고 허브(또는 엔딩)로 복귀.
  return (
    <NewspaperCard
      headline={headline}
      record={result.record}
      teamName={teamName}
      onNext={() => {
        const { score, shootout, decisions } = result.record
        recordResult(score, result.stamina ?? {}, shootout, decisions)
        // recordResult가 stage='ended'로 갱신한 경우 부모(CampaignFlow)가 엔딩을 렌더한다.
        onBackToHub(result.finalTactics ?? null)
      }}
    />
  )
}

// [F1 B안 · 2026-07-26] toFirstHalfScript(ScriptEvent[] → 엔진 firstHalfScript) 제거.
// 조별 전반을 스크립트로 재현하지 않으므로 변환기가 필요 없다.
// 엔진의 firstHalfScript 지원과 GROUP_MATCHES의 데이터는 그대로 남아 있으니
// 되돌리려면 이 자리에 변환기를 복원하고 MatchScreen에 prop을 다시 넘기면 된다.

export default App
