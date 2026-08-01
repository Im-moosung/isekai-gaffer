import { useEffect, useMemo, useState } from 'react'
import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'
import { loadAllTeams } from '../../data/loader'
import { computeScore, submitScore, topScores } from '../../online/leaderboard'
import type { LeaderboardMode, LeaderboardRow, ScoreBreakdown } from '../../online/leaderboard'
import { sanitizeNickname } from '../../online/nickname'
import { shareUrlForSeed } from '../../game/seed'
import { buildEpilogue } from '../../game/pressconf'
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

const STAGE_LABEL: Record<CampaignStage, string> = {
  group1: '조별 1차전', group2: '조별 2차전', group3: '조별리그',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '준우승', ended: '여정의 끝',
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

/**
 * 이 판의 시드 카드 — 시드를 **유저에게 돌려주는** 자리다.
 *
 * 시드가 매 판 달라지면(2026-08-01) 결정론 엔진의 값어치는 "내 판을 다시 열 수 있는가"에 달린다.
 * 그래서 여정이 끝난 화면에 시드를 적고, 그대로 링크로 복사할 수 있게 둔다.
 * 리더보드가 "모두 같은 시드"가 아니라 "기록된 시드 + 재현 가능한 리플레이"로 성립하는 근거다.
 *
 * 클립보드가 없는 환경(비보안 컨텍스트·구형 브라우저·jsdom)에서는 버튼을 아예 그리지 않는다 —
 * 눌러도 아무 일이 없는 버튼보다 없는 편이 낫고, 시드 숫자는 언제나 화면에 남는다.
 */
function SeedCard({ seed }: { seed: number }) {
  const [copied, setCopied] = useState(false)
  const shareUrl = useMemo(() => shareUrlForSeed(seed), [seed])
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?(t: string): Promise<void> } } })
    .navigator?.clipboard
  const canCopy = shareUrl !== null && typeof clipboard?.writeText === 'function'

  return (
    <section className="section end-seed" aria-label="이 판의 시드">
      <div className="section__head">
        <h2 className="section__title">이 판의 시드</h2>
      </div>
      <p className="end-seed__val num">{seed}</p>
      <p className="end-seed__note">
        같은 시드로 시작하면 이 대회가 사건 하나까지 그대로 재현된다.
        주소 끝에 <code>?seed={seed}</code>를 붙이면 친구도 같은 판을 지휘한다.
      </p>
      {canCopy && (
        <button
          type="button"
          className="btn btn--secondary end-seed__copy"
          onClick={() => {
            const write = clipboard?.writeText
            if (!write || !shareUrl) return
            const done = write.call(clipboard, shareUrl)
            done.then(() => setCopied(true)).catch(() => { /* 조용히 실패 — 시드 숫자는 화면에 남는다 */ })
          }}
        >
          {copied ? '복사됨' : '링크 복사'}
        </button>
      )}
    </section>
  )
}

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
export function EndingScreen({ onRestart }: { onRestart(): void }) {
  const ending = useCampaignStore(s => s.ending)
  const records = useCampaignStore(s => s.records)
  const groupRank = useCampaignStore(s => s.groupRank)
  const seed = useCampaignStore(s => s.seed)

  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [myNick, setMyNick] = useState('')
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [mode, setMode] = useState<LeaderboardMode>('local')

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
    narrate('epilogue', {
      reached: ending.reached,
      champion: ending.champion,
      records: records.map(r => ({ stage: r.stage, opponent: r.opponentId, score: r.score, shootout: r.shootout })),
    })
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

  async function handleSubmit() {
    if (busy || submitted || !breakdown) return
    setBusy(true)
    const nick = sanitizeNickname(nickname)
    setMyNick(nick)
    await submitScore(nick, breakdown)
    const res = await topScores(10)
    setRows(res.rows)
    setMode(res.mode)
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

          <SeedCard seed={seed} />

          <section className="section" aria-label="리더보드">
            <div className="section__head">
              <h2 className="section__title">리더보드</h2>
              {submitted && mode === 'local' && (
                <span className="badge end-board__badge">이 기기 기록</span>
              )}
            </div>

            {!submitted ? (
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
                  className="btn btn--secondary end-register"
                  onClick={handleSubmit}
                  disabled={busy}
                >
                  {busy ? '등록 중…' : '기록 등록'}
                </button>
              </div>
            ) : (
              <div className="end-board">
                <h3 className="end-board__title">리더보드 TOP 10</h3>
                <ol className="end-board__list">
                  {rows.map((r, i) => {
                    const mine = r.nickname === myNick && r.total === breakdown.total
                    return (
                      <li
                        key={`${r.nickname}-${r.total}-${i}`}
                        className={`end-board__row${mine ? ' end-board__row--me' : ''}`}
                      >
                        <span className="end-board__rank num">{i + 1}</span>
                        <span className="end-board__nick">{r.nickname}</span>
                        <span className="end-board__reached">
                          {r.champion ? '우승' : STAGE_LABEL[r.reached]}
                        </span>
                        <span className="end-board__pts num">{r.total}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  )
}
