import { useEffect } from 'react'
import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage } from '../../game/campaignStore'
import * as bgm from '../../audio/bgm'
import { loadTeam } from '../../data/loader'
import type { TeamId } from '../../data/loader'
import { GROUP_MATCHES } from '../../data/groupStage'
import { AppShell } from '../shell/AppShell'
import { JourneyLadder } from './JourneyLadder'
import './campaign.css'

/** 상단 바 진행 컨텍스트 · 히어로 아이브로우에 함께 쓰는 라운드 이름. */
const STAGE_LABEL: Record<CampaignStage, string> = {
  group1: '조별 1차전', group2: '조별 2차전', group3: '조별 3차전',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '결승', ended: '여정의 끝',
}

/** 상단 바 우측 진행 표시 — "조별리그 2/3", "토너먼트 32강". */
function progressText(stage: CampaignStage): string {
  if (stage === 'group1') return '조별리그 1/3'
  if (stage === 'group2') return '조별리그 2/3'
  if (stage === 'group3') return '조별리그 3/3'
  return `토너먼트 · ${STAGE_LABEL[stage]}`
}

/** 조별 경기의 실제 역사 기준선("실제 역사 2-1 승"). 토너먼트는 기준선이 없다. */
function historyLine(stage: CampaignStage): string | null {
  const idx = stage === 'group1' ? 0 : stage === 'group2' ? 1 : stage === 'group3' ? 2 : -1
  if (idx < 0) return null
  const [a, b] = GROUP_MATCHES[idx].realScore
  return `실제 역사 ${a}-${b} ${a > b ? '승' : a < b ? '패' : '무'}`
}

/** 캠페인 허브 — 3층 셸의 첫 적용 화면.
 *
 *  [2026-07-30 재설계 · H-2~H-6]
 *  이전에는 "여정 사다리 | 다음 상대"가 2열 동급으로 놓이고 CTA가 우측 컬럼 오른쪽 끝에
 *  홀로 떠 있었다. 화면의 1순위는 "다음에 뭘 하는가"이므로 다음 경기를 전폭 히어로로
 *  올리고 사다리를 그 아래로 내렸다. 주 CTA는 하단 고정 바로 내려 앵커를 얻는다
 *  — 동시에 화면 하단 37%를 먹던 빈 검정이 사라진다.
 *
 *  ended 상태에서는 부모가 EndingScreen으로 전환하므로 방어적으로 null을 반환한다. */
export function HubScreen({ onProceed }: { onProceed(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const records = useCampaignStore(s => s.records)
  const groupRank = useCampaignStore(s => s.groupRank)
  const ending = useCampaignStore(s => s.ending)
  const currentOpponent = useCampaignStore(s => s.currentOpponent)
  const bans = useCampaignStore(s => s.bans)
  const cautions = useCampaignStore(s => s.cautions)

  // 허브(여정) 루프 M02 — 경기 사이 화면. 랜딩에서 넘어온 첫 클릭이 오디오를 이미 열었으므로
  // 여기서부터는 실제로 소리가 난다. 장면 선언은 멱등이고 전환은 크로스페이드다.
  useEffect(() => { bgm.setScene('hub') }, [])

  if (stage === 'ended' || ending) return null

  const opponentId: TeamId = currentOpponent()
  const opp = loadTeam(opponentId)
  const kor = loadTeam('kor')
  const styleNotes = (opp.profile as { styleNotes?: string }).styleNotes
  const hist = historyLine(stage)
  const remaining = 8 - records.length

  // 징계는 전술 센터에 들어가기 **전에** 알아야 한다 — 워룸에서 잠긴 카드를 보고 나서야
  // "왜 못 쓰지"를 알게 되면 이미 계획을 그 선수 위에 세운 뒤다.
  const nameOf = (id: string) => kor.squad.find(p => p.id === id)?.name.ko ?? id
  const suspended = Object.entries(bans).filter(([, n]) => n > 0).map(([id]) => nameOf(id)).sort()
  const booked = Object.entries(cautions).filter(([, n]) => n > 0).map(([id]) => nameOf(id)).sort()

  return (
    <AppShell
      className="hub-root"
      top={
        <>
          <span className="shell__brand">Isekai Gaffer</span>
          <span className="shell__context">{progressText(stage)}</span>
        </>
      }
      bottom={
        <>
          {/* 본문 제목 옆 진행 표시와 겹치지 않게, 하단은 "지금 무엇을 여는가"만 말한다. */}
          <span className="shell__bottom-status">
            {STAGE_LABEL[stage]} · 전술 센터에서 라인업과 플랜을 정한다
          </span>
          <button type="button" className="btn btn--primary btn--lg" onClick={onProceed}>
            {opp.name.ko}전 준비하기 <span aria-hidden="true">→</span>
          </button>
        </>
      }
    >
      <div className="section">
        <div className="section__head">
          <h1 className="page-title">대한민국 월드컵 여정</h1>
          <span className="section__meta">
            <span className="num">{records.length}</span>경기 완료 ·{' '}
            <span className="num">{remaining}</span>경기 남음
          </span>
        </div>
      </div>

      {/* 다음 경기 — 전폭 히어로. 국기 이모지는 뺐다(OS마다 글리프 크기가 달라
          line-height와 어긋나며 잘린다). 대신 tricode 칩 + 킷 색 3px 스트립으로
          "필드에서 어느 색을 따라갈 것인가"에 답한다. */}
      <article className="card hub-hero" aria-label="다음 경기">
        <span className="eyebrow eyebrow--brand">다음 경기 · {STAGE_LABEL[stage]}</span>
        <div className="hub-hero__teams">
          <span className="hub-hero__side">
            <span className="kit-strip kit-strip--us" aria-hidden="true" />
            <span className="hub-hero__code num">{kor.fifaCode}</span>
            <span className="hub-hero__name">{kor.name.ko}</span>
          </span>
          <span className="hub-hero__vs" aria-hidden="true">vs</span>
          <span className="hub-hero__side hub-hero__side--away">
            <span className="hub-hero__name hub-hero__opp">{opp.name.ko}</span>
            <span className="hub-hero__code num">{opp.fifaCode}</span>
            <span className="kit-strip kit-strip--them" aria-hidden="true" />
          </span>
          <span className="badge hub-hero__rank">
            FIFA <span className="num">{opp.fifaRanking}</span>위
          </span>
        </div>
        <p className="hub-hero__meta">
          선호 <span className="hub-hero__formation">{opp.profile.preferredFormations.join(', ')}</span>
          {hist ? <> · {hist}</> : null}
        </p>
        {styleNotes ? <p className="hub-hero__notes">{styleNotes}</p> : null}
        {(suspended.length > 0 || booked.length > 0) && (
          <p className="hub-hero__discipline" aria-label="징계 현황">
            {suspended.length > 0 && (
              <span className="hub-hero__susp">
                출장정지 <span className="num">{suspended.length}</span>명 · {suspended.join(', ')}
              </span>
            )}
            {suspended.length > 0 && booked.length > 0 && <span aria-hidden="true"> · </span>}
            {booked.length > 0 && (
              <span className="hub-hero__booked">
                경고 1장 <span className="num">{booked.length}</span>명 · {booked.join(', ')}
                {' '}— 한 장 더 받으면 다음 경기 결장
              </span>
            )}
          </p>
        )}
      </article>

      <JourneyLadder
        stage={stage}
        records={records}
        groupRank={groupRank}
        ending={ending}
        currentOpponentId={opponentId}
        collapsible
      />
    </AppShell>
  )
}
