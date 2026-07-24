import { useMemo, useState } from 'react'
// 예외 승인: App.tsx는 데모 픽스처 팀 생성(fixtures)과 캠페인 기본 XI 산정(lineup)을 위해
// 엔진 모듈 직접 import를 허용한다(조립 최상단 진입점 한정).
import { makeTestTeam } from './engine/fixtures/testTeams'
import { pickBestXI } from './engine/lineup'
import type { MatchEvent, TacticState } from './engine/types'
import { MatchScreen } from './ui/match/MatchScreen'
import { HubScreen } from './ui/campaign/HubScreen'
import { EndingScreen } from './ui/campaign/EndingScreen'
import { LineupScreen } from './ui/lineup/LineupScreen'
import { useCampaignStore } from './game/campaignStore'
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

  const demoTeams = useMemo(() => ({ home: makeTestTeam('kor', 76), away: makeTestTeam('esp', 88) }), [])

  if (mode === 'demo') {
    return <MatchScreen home={demoTeams.home} away={demoTeams.away} seed={DEMO_SEED} />
  }

  if (mode === 'campaign') {
    return <CampaignFlow onExit={() => { resetCampaign(); setMode('landing') }} />
  }

  return (
    <main className="landing">
      <div className="landing__card">
        <p className="landing__kicker">개발 빌드</p>
        <h1 className="landing__title">리매치: 코리아 2026 (개발 빌드)</h1>
        <p className="landing__sub">방송형 축구 감독 시뮬레이터 — Phase 2</p>
        <div className="landing__actions">
          <button
            type="button"
            className="landing__cta"
            onClick={() => { resetCampaign(); startCampaign(CAMPAIGN_SEED); setMode('campaign') }}
          >
            캠페인 시작
          </button>
          <button
            type="button"
            className="landing__cta landing__cta--ghost"
            onClick={() => setMode('demo')}
          >
            데모 경기
          </button>
        </div>
      </div>
    </main>
  )
}

type CampaignStep = 'hub' | 'lineup' | 'match'

/** 캠페인 플로우 조립: hub → lineup → match →(자동 recordResult)→ hub … → ending. */
function CampaignFlow({ onExit }: { onExit(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const ending = useCampaignStore(s => s.ending)
  const [step, setStep] = useState<CampaignStep>('hub')
  const [tactics, setTactics] = useState<TacticState | null>(null)

  const kor = useMemo(() => loadTeam('kor'), [])

  // 종료 → 엔딩(부모 store가 stage/ending을 갱신하면 여기로 수렴).
  if (stage === 'ended' || ending) {
    return <EndingScreen onRestart={onExit} />
  }

  if (step === 'hub') {
    return <HubScreen onProceed={() => setStep('lineup')} />
  }

  if (step === 'lineup') {
    // 직전 확정 전술을 유지하며 편집(첫 진입은 기본 XI).
    const initial = tactics ?? pickBestXI(kor)
    return (
      <LineupScreen
        team={kor}
        initial={initial}
        onConfirm={t => { setTactics(t); setStep('match') }}
      />
    )
  }

  // step === 'match'
  return (
    <CampaignMatch
      tactics={tactics ?? pickBestXI(kor)}
      onBackToHub={() => { setTactics(null); setStep('hub') }}
    />
  )
}

/** 캠페인 한 경기 — 상대·시드·조별 스크립트·체력 이월을 조립해 MatchScreen에 전달.
 *  경기 종료 시 recordResult 후 다음 스텝을 결정한다(종료면 부모가 엔딩으로 전환). */
function CampaignMatch({ tactics, onBackToHub }: { tactics: TacticState; onBackToHub(): void }) {
  const currentOpponent = useCampaignStore(s => s.currentOpponent)
  const matchSeed = useCampaignStore(s => s.matchSeed)
  const startingStamina = useCampaignStore(s => s.startingStamina)
  const recordResult = useCampaignStore(s => s.recordResult)
  const stage = useCampaignStore(s => s.stage)

  const kor = useMemo(() => loadTeam('kor'), [])
  const oppId = currentOpponent()
  const opp = useMemo(() => loadTeam(oppId), [oppId])
  const seed = matchSeed()
  const isGroup = stage === 'group1' || stage === 'group2' || stage === 'group3'

  // 매치별 파생 props는 seed(진행 순 고정)에 고정 memo → MatchScreen 재초기화 방지.
  const derived = useMemo(() => {
    const staminaOverride: Record<string, number> = {}
    for (const p of kor.squad) staminaOverride[p.id] = startingStamina(p.id)
    const gm: GroupMatch | undefined = isGroup ? GROUP_MATCHES.find(m => m.opponent === oppId) : undefined
    const firstHalfScript = gm ? toFirstHalfScript(gm, kor.id, oppId) : undefined
    return { staminaOverride, firstHalfScript, referenceScore: gm?.realScore, requireWinner: !isGroup }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  return (
    <MatchScreen
      home={kor}
      away={opp}
      seed={seed}
      initialTactics={tactics}
      firstHalfScript={derived.firstHalfScript}
      staminaOverride={derived.staminaOverride}
      referenceScore={derived.referenceScore}
      requireWinner={derived.requireWinner}
      onMatchEnd={(score, stamina, shootout) => {
        recordResult(score, stamina, shootout)
        // 스텝을 허브로 되돌린다. recordResult가 stage='ended'로 갱신한 경우엔
        // 부모(CampaignFlow)가 ended를 감지해 허브 대신 엔딩을 렌더한다.
        onBackToHub()
      }}
    />
  )
}

/** 조별 전반 스크립트(ScriptEvent[]) → 엔진 firstHalfScript(MatchEvent[] + 전반 스코어). */
function toFirstHalfScript(m: GroupMatch, homeId: string, awayId: string): { events: MatchEvent[]; score: [number, number] } {
  const events: MatchEvent[] = m.firstHalfScript.map(e => ({
    minute: e.minute, type: e.type, teamId: e.teamId, detail: e.playerName,
  }))
  const score: [number, number] = [
    events.filter(e => e.teamId === homeId).length,
    events.filter(e => e.teamId === awayId).length,
  ]
  return { events, score }
}

export default App
