import { useMemo, useState } from 'react'
// 예외 승인: App.tsx는 캠페인/데모 기본 XI 산정(lineup)을 위해
// 엔진 모듈 직접 import를 허용한다(조립 최상단 진입점 한정).
import { pickBestXI } from './engine/lineup'
import type { MatchEvent, TacticState } from './engine/types'
import { MatchScreen } from './ui/match/MatchScreen'
import { HubScreen } from './ui/campaign/HubScreen'
import { EndingScreen } from './ui/campaign/EndingScreen'
import { LineupScreen } from './ui/lineup/LineupScreen'
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
    <main className="landing">
      <div className="landing__card">
        <p className="landing__kicker">개발 빌드</p>
        <h1 className="landing__title">리매치: 코리아 2026 (개발 빌드)</h1>
        <p className="landing__sub">방송형 축구 감독 시뮬레이터 — Phase 3</p>
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
            바로 지휘하기
          </button>
        </div>
      </div>
    </main>
  )
}

/** 데모 플로우: 실팀(kor vs esp, 고정 시드) 한 경기 → 기자회견 → 신문 → 랜딩 복귀.
 *  캠페인 기록·리더보드에는 반영하지 않는다("리더보드 미반영" 표기). */
function DemoFlow({ onExit }: { onExit(): void }) {
  const teams = useMemo(() => ({ home: loadTeam('kor'), away: loadTeam('esp') }), [])
  // 데모도 유저는 대한민국(kor)을 지휘한다.
  const teamName = teams.home.name.ko
  const initial = useMemo(() => pickBestXI(teams.home), [teams.home])

  const [tactics, setTactics] = useState<TacticState | null>(null)
  const [result, setResult] = useState<PostMatch | null>(null)
  const [headline, setHeadline] = useState<Headline | null>(null)

  // 캠페인과 동일하게 데모도 라인업 선행 — 킥오프 전 선발/전술을 짠다.
  if (!tactics) {
    return (
      <div className="demo-wrap">
        <div className="demo-banner" role="note">데모 · 리더보드 미반영</div>
        <LineupScreen team={teams.home} initial={initial} onConfirm={setTactics} />
      </div>
    )
  }

  if (!result) {
    return (
      <div className="demo-wrap">
        <div className="demo-banner" role="note">데모 · 리더보드 미반영</div>
        <MatchScreen
          home={teams.home}
          away={teams.away}
          seed={DEMO_SEED}
          initialTactics={tactics}
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
 *  경기 종료 → 기자회견 → 신문 카드 → [다음]에서 recordResult 후 허브 복귀.
 *
 *  [구조 선택] record는 recordResult 이전에 방금 결과로 "임시 MatchRecord"를 구성한다.
 *  recordResult를 먼저 부르면 최종전/탈락전에서 stage='ended'가 되어 부모(CampaignFlow)가
 *  즉시 EndingScreen으로 전환 → 기자회견을 건너뛴다. 따라서 결과를 임시 record로 붙들고
 *  기자회견·신문까지 보여준 뒤, [다음]에서 recordResult로 상태를 전진시킨다. */
function CampaignMatch({ tactics, onBackToHub }: { tactics: TacticState; onBackToHub(): void }) {
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
  const derived = useMemo(() => {
    const staminaOverride: Record<string, number> = {}
    for (const p of kor.squad) staminaOverride[p.id] = startingStamina(p.id)
    const gm: GroupMatch | undefined = isGroup ? GROUP_MATCHES.find(m => m.opponent === oppId) : undefined
    const firstHalfScript = gm ? toFirstHalfScript(gm, kor.id, oppId) : undefined
    return { staminaOverride, firstHalfScript, referenceScore: gm?.realScore, requireWinner: !isGroup }
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
        firstHalfScript={derived.firstHalfScript}
        staminaOverride={derived.staminaOverride}
        referenceScore={derived.referenceScore}
        requireWinner={derived.requireWinner}
        onMatchEnd={(score, stamina, shootout, decisions) => {
          const record: MatchRecord = {
            stage, opponentId: oppId, score,
            ...(shootout ? { shootout } : {}), decisions,
          }
          setResult({ record, stamina })
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
