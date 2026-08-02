import { useEffect, useMemo, useState } from 'react'
import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'
import { loadAllTeams } from '../../data/loader'
import { computeScore, submitScore } from '../../online/leaderboard'
import type { ScoreBreakdown } from '../../online/leaderboard'
import { sanitizeNickname } from '../../online/nickname'
import { LeaderboardBoard } from '../leaderboard/LeaderboardBoard'
import { useLeaderboard } from '../leaderboard/useLeaderboard'
import { STAGE_LABEL } from '../leaderboard/stage'
import { buildEpilogue, describeCampaign } from '../../game/pressconf'
import { narrate } from '../../ai/aiClient'
import * as bgm from '../../audio/bgm'
import { AppShell } from '../shell/AppShell'
import { JourneyLadder } from './JourneyLadder'
import './campaign.css'

/** 우승 트로피 실루엣. 이모지(🏆)를 쓰지 않는 이유는 OS마다 모양·크기가 달라
 *  8경기의 보상 화면 톤이 통째로 흔들리기 때문이다. */
function TrophyMark() {
  return (
    <svg className="end-trophy" viewBox="0 0 48 56" role="img" aria-label="우승 트로피">
      <path
        d="M12 4h24v14a12 12 0 0 1-24 0V4Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M12 8H6v4a8 8 0 0 0 6.6 7.9M36 8h6v4a8 8 0 0 1-6.6 7.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        d="M24 30v8m-8 0h16l3 10H13l3-10Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 컨페티 — 절대배치 파티클 12개. 위치·색은 CSS(nth-child)가 정하고
 *  prefers-reduced-motion에서는 토큰의 전역 규칙이 애니메이션을 1ms로 끝내
 *  종료 상태(정지 이미지)로 남긴다. */
function Confetti() {
  return (
    <div className="end-confetti" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="end-confetti__bit" />
      ))}
    </div>
  )
}

/** 점수 브레이크다운 표에 표시할 항목 순서·라벨. */
const SCORE_ROWS: [keyof Pick<ScoreBreakdown, 'roundPts' | 'matchPts' | 'goalDiffPts' | 'upsetPts' | 'cleanSheetPts'>, string][] = [
  ['roundPts', '진출 라운드'],
  ['matchPts', '승점 (승3·무1)'],
  ['goalDiffPts', '득실차'],
  ['upsetPts', '업셋 보너스'],
  ['cleanSheetPts', '무실점'],
]

/** 라운드별 엔딩 헤드라인 — 사실 서술형. 실존 인물·팀 비하 금지.
 *  eyebrow는 제목 위 한 줄. 제목에 다 넣으면 display 56px가 두 줄로 꺾여
 *  8경기의 보상 화면이 문단처럼 읽힌다(조별 탈락 결말에서 실제로 그랬다). */
function headlineFor(
  reached: CampaignStage,
  champion: boolean,
): { eyebrow: string; title: string; body: string } {
  if (champion) {
    return {
      eyebrow: '최종 결과',
      title: '세계를 제패하다',
      body: '대한민국, 월드컵 정상에 올랐다. 조별리그부터 결승까지 이어진 완주의 끝에서 이룬 위대한 성취.',
    }
  }
  switch (reached) {
    case 'final':
      return {
        eyebrow: '최종 결과',
        title: '준우승, 위대한 여정',
        body: '결승에서 아쉽게 멈췄지만, 세계 무대 정상을 눈앞에 둔 역사에 남을 여정이었다.',
      }
    case 'sf':
      return {
        eyebrow: '최종 결과',
        title: '4강 진출, 세계 4위',
        body: '준결승 무대까지 오르며 세계 네 팀 안에 이름을 올린 값진 대회였다.',
      }
    case 'qf':
      return {
        eyebrow: '최종 결과',
        title: '8강 진출',
        body: '아시아를 넘어 세계 강호들과 어깨를 나란히 한 대회, 8강에서 여정을 마쳤다.',
      }
    case 'r16':
      return {
        eyebrow: '최종 결과',
        title: '16강 진출',
        body: '조별리그를 통과해 토너먼트 무대에서 당당히 겨룬 대회였다.',
      }
    case 'r32':
      return {
        eyebrow: '최종 결과',
        title: '32강 진출',
        body: '조별리그를 넘어 토너먼트에 올랐다. 다음을 기약하는 경험이 된 대회.',
      }
    case 'group3':
    default:
      return {
        eyebrow: '실제 역사와 같은 결말',
        title: '조별리그 탈락',
        body: '조별리그에서 여정을 마쳤다. 아쉬움을 뒤로하고 다음 대회를 준비한다.',
      }
  }
}

// [2026-08-02 · 사용자 판단] "이 판의 시드" 카드(숫자 · ?seed= 안내 · [링크 복사])를 제거했다.
// 시드 공유를 제품 기능으로 넣지 않기로 했다 — 엔딩 화면의 자리는 재도전 동기(리더보드 등록)가
// 쓰는 편이 낫고, 시드 숫자는 대다수 플레이어에게 읽을 이유가 없는 숫자였다.
//
// **엔진의 시드 자체는 그대로다.** 결정론 계약(설계 §99)과 밸런스 테스트 전체가 여기 의존한다.
// 사라진 것은 화면에 시드를 보여주고 공유하게 하던 UI뿐이다.
// App.tsx의 ?seed= URL 파라미터 처리도 남겨 뒀다(화면에서 안내만 하지 않는다) —
// 컨트롤이 0개라 유저에게 보이지 않으면서, 버그 재현과 밸런스 검증에는 그대로 쓸모가 있다.

interface Tally { w: number; d: number; l: number; gf: number; ga: number }

function tally(records: MatchRecord[]): Tally {
  const t: Tally = { w: 0, d: 0, l: 0, gf: 0, ga: 0 }
  for (const r of records) {
    const [a, b] = r.score
    t.gf += a
    t.ga += b
    if (a > b) t.w++
    else if (a < b) t.l++
    else if (r.shootout) (r.shootout[0] > r.shootout[1] ? t.w++ : t.l++)
    else t.d++
  }
  return t
}

/** 캠페인 엔딩 화면 — campaignStore.ending 기반 헤드라인 + 기록 요약 + [처음부터]. */
function fmtPts(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/** 캠페인 엔딩 화면 — 헤드라인 + 기록 요약 + 점수 브레이크다운 + 리더보드 등록/순위. */
export function EndingScreen({ onRestart, onLeaderboard }: {
  onRestart(): void
  /** 독립 리더보드 페이지로 이동. 없으면 진입 버튼을 그리지 않는다(구버전 호출부 방어). */
  onLeaderboard?(): void
}) {
  const ending = useCampaignStore(s => s.ending)
  const records = useCampaignStore(s => s.records)
  const groupRank = useCampaignStore(s => s.groupRank)

  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [myNick, setMyNick] = useState('')
  // 조회는 등록 이후에만 돈다(enabled=submitted). 훅은 리더보드 페이지와 같은 것을 쓴다 —
  // 정렬 기준·폴백 처리가 두 화면에서 갈라지지 않게 하는 유일한 방법이다.
  const board = useLeaderboard(10, submitted)

  // computeScore는 순수 함수 — 기록/엔딩 변화 시에만 재계산.
  const breakdown = useMemo<ScoreBreakdown | null>(
    () => (ending ? computeScore(records, ending, loadAllTeams()) : null),
    [records, ending],
  )
  // 캠페인 여정 에필로그(3~5문장, 사실 서술) — 리더보드 위에 표시.
  const epilogue = useMemo<string[]>(
    () => (ending ? buildEpilogue(records, ending) : []),
    [records, ending],
  )

  // AI 엔딩 서술. **템플릿을 먼저 그려 놓고** 성공한 경우에만 갈아끼운다 —
  // 키가 없거나(503) 프록시가 없는 환경(로컬 vite dev)에서는 narrate가 조용히 null을
  // 반환하므로 화면은 언제나 사전 문안으로 완결된다. 심사자가 키를 준비할 필요가 없다.
  const [aiEpilogue, setAiEpilogue] = useState<string[] | null>(null)
  useEffect(() => {
    if (!ending) return
    let alive = true
    // 기자회견 헤드라인과 같은 결함이 여기에도 있었다: `score: [2,5]`와 코드값 opponentId만
    // 넘기면 어느 칸이 우리 득점인지가 데이터에 없다. 캠페인 요약은 8경기를 한꺼번에 다루므로
    // 뒤집히면 여정 전체가 거짓말이 된다 — describeCampaign이 경기별 승패와 통산 전적,
    // 도달 단계·우승 여부를 판정해서 한국어 필드로 넘긴다.
    narrate('epilogue', describeCampaign(records, ending))
      .then(text => {
        if (!alive || !text) return
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
        if (lines.length) setAiEpilogue(lines)
      })
      .catch(() => { /* 폴백은 템플릿 — 실패를 화면에 노출하지 않는다 */ })
    return () => { alive = false }
  }, [ending, records])

  // 엔딩 곡 — 우승 M10(20s) / 탈락 M11(16s). 루프가 아니라 **스팅**이다: 여정의 끝에
  // 한 번 울리고 끝나야지, 리더보드를 읽는 내내 반복되면 결말이 배경음악이 된다.
  useEffect(() => {
    if (!ending) return
    bgm.setScene(null)
    bgm.playSting(ending.champion ? 'M10' : 'M11')
    return () => bgm.stopSting()
  }, [ending])

  if (!ending || !breakdown) return null

  const { eyebrow, title, body } = headlineFor(ending.reached, ending.champion)
  const t = tally(records)
  const diff = t.gf - t.ga
  const diffLabel = diff > 0 ? `+${diff}` : `${diff}`

  // 등록만 여기서 하고, 조회는 useLeaderboard가 맡는다(submitted가 true가 되면 스스로 돈다).
  async function handleSubmit() {
    if (busy || submitted || !breakdown) return
    setBusy(true)
    const nick = sanitizeNickname(nickname)
    setMyNick(nick)
    await submitScore(nick, breakdown)
    setSubmitted(true)
    setBusy(false)
  }

  return (
    <AppShell
      className={`end-root${ending.champion ? ' end-root--champion' : ''}`}
      top={
        <>
          <span className="shell__brand">Isekai Gaffer</span>
          <span className="shell__context">여정의 끝 · 최종 기록</span>
        </>
      }
      bottom={
        <>
          <span className="shell__bottom-status">
            총점 <span className="num">{breakdown.total}</span>점 ·{' '}
            {ending.champion ? '우승' : STAGE_LABEL[ending.reached]}
          </span>
          {/* 순서: [리더보드] [처음부터]. 주 CTA(처음부터)를 오른쪽 끝에 두는 규칙은
              다른 화면과 같고, 리더보드는 그 옆의 보조 행동이다. */}
          {onLeaderboard && (
            <button type="button" className="btn btn--secondary btn--lg" onClick={onLeaderboard}>
              리더보드 보러가기
            </button>
          )}
          <button type="button" className="btn btn--primary btn--lg" onClick={onRestart}>
            처음부터
          </button>
        </>
      }
    >
      {/* 히어로 — 8경기의 보상 자리. 560px 모달을 걷어내고 화면 전체를 쓴다(D-1·D-2). */}
      <section className="end-hero">
        {ending.champion && <Confetti />}
        <div className="end-hero__inner">
          {ending.champion && <TrophyMark />}
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="end-headline">{title}</h1>
          <p className="end-body">{body}</p>

          <dl className="end-summary" aria-label="기록 요약">
            <div className="end-summary__item">
              <dt>전적</dt>
              <dd className="num">{t.w}승 {t.d}무 {t.l}패</dd>
            </div>
            <div className="end-summary__item">
              <dt>득실</dt>
              <dd className="num">{t.gf}득점 {t.ga}실점 ({diffLabel})</dd>
            </div>
            <div className="end-summary__item">
              <dt>총점</dt>
              <dd className="num">{breakdown.total}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* 리더보드 — **히어로 바로 아래, 2열 본문보다 위**다(2026-08-02).
          예전에는 오른쪽 열의 맨 끝(시드 카드 다음)에 있었고, 실제 플레이에서 유저가
          닉네임 입력창을 발견하지 못했다. 스크롤 한참 아래에 파묻혀 있었기 때문이다.
          리더보드 등록은 이 게임의 재도전 동기이므로 엔딩에 들어오자마자 보여야 한다.
          여정·점수 상세는 "읽을거리"라 아래로 내려가도 손해가 없다. */}
      <section className="section end-board-panel" aria-label="리더보드">
        <div className="section__head">
          <h2 className="section__title">리더보드</h2>
          {submitted && board.status === 'ready' && board.mode === 'local' && (
            <span className="badge end-board__badge">이 기기 기록</span>
          )}
        </div>

        {!submitted ? (
          <>
            <p className="end-submit__lede">
              닉네임을 남기면 총점 <span className="num">{breakdown.total}</span>점이 순위표에 오른다.
            </p>
            <div className="end-submit">
              <input
                className="end-nick"
                type="text"
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                placeholder="닉네임 (2~12자, 미입력 시 익명 감독)"
                maxLength={12}
                aria-label="닉네임"
              />
              <button
                type="button"
                className="btn btn--primary end-register"
                onClick={handleSubmit}
                disabled={busy}
              >
                {busy ? '등록 중…' : '기록 등록'}
              </button>
            </div>
          </>
        ) : (
          <div className="end-board">
            <h3 className="end-board__title">리더보드 TOP 10</h3>
            {/* 목록·로딩·비어있음·실패는 전부 공용 컴포넌트가 그린다(리더보드 페이지와 동일). */}
            <LeaderboardBoard
              state={board}
              highlight={r => r.nickname === myNick && r.total === breakdown.total}
              emptyText="아직 등록된 기록이 없습니다. 방금 등록한 기록이 곧 반영됩니다."
            />
            {onLeaderboard && (
              <button
                type="button"
                className="btn btn--ghost btn--sm end-board__more"
                onClick={onLeaderboard}
              >
                전체 순위 보기 →
              </button>
            )}
          </div>
        )}
      </section>

      <div className="end-cols">
        {/* 최종 여정 — 허브와 같은 컴포넌트라 두 화면의 표기가 어긋나지 않는다(수미상관). */}
        <section className="section end-journey" aria-label="최종 여정">
          <div className="section__head">
            <h2 className="section__title">최종 여정</h2>
          </div>
          <JourneyLadder
            stage="ended"
            records={records}
            groupRank={groupRank}
            ending={ending}
            compact
          />
        </section>

        <div className="end-side">
          {epilogue.length > 0 && (
            <section className="section end-epilogue" aria-label="여정 에필로그">
              <div className="section__head">
                <h2 className="section__title">에필로그</h2>
                {aiEpilogue && <span className="badge">AI 서술</span>}
              </div>
              {(aiEpilogue ?? epilogue).map((p, i) => (
                <p key={i} className="end-epilogue__p">{p}</p>
              ))}
            </section>
          )}

          <section className="section" aria-label="점수 상세">
            <div className="section__head">
              <h2 className="section__title">점수 상세</h2>
            </div>
            <table className="end-score">
              <tbody>
                {SCORE_ROWS.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td className="num">{fmtPts(breakdown[key])}</td>
                  </tr>
                ))}
                <tr className="end-score__total">
                  <th scope="row">합계</th>
                  <td className="num">{breakdown.total}</td>
                </tr>
              </tbody>
            </table>
          </section>

        </div>
      </div>
    </AppShell>
  )
}
