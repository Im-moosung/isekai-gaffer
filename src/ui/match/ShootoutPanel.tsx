import { useState, useEffect, useMemo } from 'react'
import type { Team } from '../../engine/types'
// 예외 승인(계약 Task 7): 승부차기는 matchStore 상태 머신과 무관한 독립 순수 함수이므로
// UI에서 simulateShootout을 직접 호출한다(엔진 경유 원칙의 명시적 예외).
import { simulateShootout, type ShootoutKick } from '../../engine/shootout'
import {
  type Dir, DIRS, N_KICKERS, kickerCandidates, topPenaltyIds, buildShootoutParams, autoAwayKickers,
} from './shootout-setup'
import './match.css'

const DIR_LABEL: Record<Dir, string> = { left: '좌', center: '중', right: '우' }

/** 킥 한 발의 화면 표기 — 같은 편에서 몇 번째인지(round)와 서든데스 여부를 함께 담는다. */
interface KickView { kick: ShootoutKick; round: number; sudden: boolean; who: string }

/** 킥 목록에 라운드 번호를 매긴다. 킥은 홈→어웨이 교대이지만 조기 확정으로
 *  마지막 라운드가 반쪽일 수 있으므로 편별 순번으로 센다. */
function toViews(kicks: ShootoutKick[], nameOf: (k: ShootoutKick) => string): KickView[] {
  let h = 0, a = 0
  return kicks.map(kick => {
    const round = kick.side === 'home' ? ++h : ++a
    return { kick, round, sudden: round > N_KICKERS, who: nameOf(kick) }
  })
}

/** 승부차기 패널 — 홈 키커 5인 순서·방향 선택 → simulateShootout → 킥 순차 연출 → onDone.
 *  홈 GK 다이빙 방향은 엔진(simulateShootout)이 RNG로 결정하므로 UI 선택 항목이 아니다(순수 함수 계약). */
export function ShootoutPanel({
  home, away, seed, regulationScore, homeEligibleIds, awayEligibleIds, onDone,
}: {
  home: Team
  away: Team
  seed: number
  /** 정규시간 스코어 — "왜 승부차기인가"를 화면에 남긴다. 미지정이면 표시하지 않는다. */
  regulationScore?: readonly [number, number]
  /** 종료 시점 그라운드에 있던 우리 선수 id. 미지정이면 자격 제한 없이 전원 후보(데모·테스트). */
  homeEligibleIds?: readonly string[]
  /** 종료 시점 그라운드에 있던 상대 선수 id. */
  awayEligibleIds?: readonly string[]
  onDone(result: [number, number]): void
}) {
  // 후보는 규정상 자격이 있는 선수만 — 교체로 나갔거나 퇴장당한 선수는 킥을 찰 수 없다.
  const candidates = useMemo(() => kickerCandidates(home, homeEligibleIds), [home, homeEligibleIds])
  const [kickerIds, setKickerIds] = useState<string[]>(() => topPenaltyIds(home, N_KICKERS, homeEligibleIds))
  const [dirs, setDirs] = useState<Dir[]>(() => Array.from({ length: N_KICKERS }, (_, i) => DIRS[i % 3]))
  const [started, setStarted] = useState(false)
  const [kicks, setKicks] = useState<ShootoutKick[]>([])
  const [revealed, setRevealed] = useState(0)

  const awayKickers = useMemo(() => autoAwayKickers(away, awayEligibleIds), [away, awayEligibleIds])
  const nameOf = (k: ShootoutKick): string => {
    const pool = k.side === 'home' ? home.squad : away.squad
    return pool.find(p => p.id === k.playerId)?.name.ko ?? k.playerId
  }

  // 킥 순차 연출: 0.8초 간격으로 한 킥씩 공개. 전부 공개되면 멈추고 결과를 읽을 시간을 준다
  // (예전에는 0.8초 뒤 자동으로 넘어가 승패 확정 순간을 볼 수 없었다).
  useEffect(() => {
    if (!started || revealed >= kicks.length) return
    const id = setTimeout(() => setRevealed(r => r + 1), 800)
    return () => clearTimeout(id)
  }, [started, revealed, kicks])

  function start() {
    const result = simulateShootout(
      buildShootoutParams({ home, away, seed, kickerIds, dirs, awayEligibleIds }),
    )
    setKicks(result.kicks)
    setRevealed(0)
    setStarted(true)
  }

  function setKicker(slot: number, id: string) {
    setKickerIds(prev => {
      const next = [...prev]
      // 다른 슬롯이 이미 그 선수를 쓰면 서로 교환(중복 방지).
      const dup = next.indexOf(id)
      if (dup >= 0) next[dup] = next[slot]
      next[slot] = id
      return next
    })
  }

  function setDir(slot: number, dir: Dir) {
    setDirs(prev => {
      const next = [...prev]
      next[slot] = dir
      return next
    })
  }

  const views = toViews(kicks.slice(0, revealed), nameOf)
  const homeScore = views.filter(v => v.kick.side === 'home' && v.kick.scored).length
  const awayScore = views.filter(v => v.kick.side === 'away' && v.kick.scored).length
  const complete = started && revealed >= kicks.length && kicks.length > 0
  const won = homeScore > awayScore
  // 서든데스 진입 지점 — 목록에 구분선을 한 번만 넣는다.
  const suddenAt = views.findIndex(v => v.sudden)

  return (
    <div className="so-panel">
      <div className="so-head">
        <span className="eyebrow">
          {regulationScore
            ? `정규시간 ${regulationScore[0]}-${regulationScore[1]} 무승부`
            : '정규시간 무승부'}
        </span>
        <h2 className="so-title">승부차기</h2>
        <p className="so-sub">다섯 번씩 차고도 갈리지 않으면 승자가 나올 때까지 한 발씩 이어 찬다</p>
        {/* 규정과 다른 지점은 감춘 채로 두지 않는다 — 화면이 90'에서 곧장 승부차기로 넘어가는
            이유를 유저가 알아야 한다. 연장전 미구현 판단의 근거는 아래 주석 참조. */}
        <p className="so-rule" role="note">
          이 게임은 정규 90분이 무승부면 <strong>연장전 없이 곧바로</strong> 승부차기로 간다 —
          실제 규정의 연장 30분은 재생 시간을 위해 생략했다.
        </p>
      </div>

      {!started ? (
        <>
          <p className="so-note">
            키커 5인의 순서와 방향을 정하세요 (기본: 페널티 상위 5인)
          </p>
          {/* 자격 제한을 화면에 밝힌다 — 명단이 갑자기 짧아진 이유를 유저가 알아야 한다. */}
          {homeEligibleIds && (
            <p className="so-rule" role="note">
              규정상 종료 휘슬 때 그라운드에 있던 선수만 킥을 찹니다 — 교체로 나간 선수와
              퇴장 선수는 제외됩니다. 골키퍼를 뺀 후보는{' '}
              <span className="num">{candidates.length}</span>명입니다.
            </p>
          )}
          <ol className="so-setup" aria-label="키커 순서">
            {kickerIds.map((id, i) => (
              <li key={i} className="so-slot">
                <span className="so-slot__no num">{i + 1}</span>
                {/* 후보가 10인 이상이라 세그먼트로 표현할 수 없는 자리 — select 유지(명시적 예외). */}
                <select
                  className="so-slot__pick"
                  aria-label={`${i + 1}번 키커`}
                  value={id}
                  onChange={e => setKicker(i, e.target.value)}
                >
                  {candidates.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name.ko} (PK {p.penalty})
                    </option>
                  ))}
                </select>
                {/* 방향은 3택 배타 선택 — 순환 버튼(누를 때마다 값이 바뀌는 blind toggle)
                    대신 세 알약을 다 보여준다. 현재 값이 눌린 상태로 보인다. */}
                <span className="seg" role="group" aria-label={`${i + 1}번 슛 방향`}>
                  {DIRS.map(d => (
                    <button
                      key={d}
                      type="button"
                      className="seg__item"
                      aria-pressed={dirs[i] === d}
                      onClick={() => setDir(i, d)}
                    >
                      {DIR_LABEL[d]}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ol>
          <p className="so-opp" aria-label="상대 키커">
            상대 키커: {awayKickers.map(k => k.player.name.ko).join(' · ')}
          </p>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            승부차기 시작
          </button>
        </>
      ) : (
        <>
          <div className="ms-final so-score">
            <span className="ms-final__team">
              <span className="kit-strip kit-strip--us" aria-hidden="true" />
              <span className="num">{home.fifaCode}</span>
            </span>
            <span className="ms-final__score num">{homeScore} : {awayScore}</span>
            <span className="ms-final__team ms-final__team--away">
              <span className="num">{away.fifaCode}</span>
              <span className="kit-strip kit-strip--them" aria-hidden="true" />
            </span>
          </div>
          <ul className="so-kicks" aria-label="승부차기 진행">
            {views.map((v, i) => (
              <li
                key={i}
                className={[
                  'so-kick',
                  `so-kick--${v.kick.side}`,
                  `so-kick--${v.kick.scored ? 'goal' : 'miss'}`,
                  i === views.length - 1 ? 'so-kick--latest' : '',
                  i === suddenAt ? 'so-kick--sudden' : '',
                ].filter(Boolean).join(' ')}
              >
                {/* 소속은 킷 스트립이 말한다(좌측 컬러 띠 폐지). 결과는 평문 — 이모지는
                    OS마다 모양·크기가 달라 목록의 행 높이까지 흔든다. */}
                <span
                  className={`kit-strip kit-strip--${v.kick.side === 'home' ? 'us' : 'them'}`}
                  aria-hidden="true"
                />
                <span className="so-kick__no num">
                  {v.sudden ? `SD${v.round - N_KICKERS}` : v.round}
                </span>
                <span className="so-kick__who">{v.who}</span>
                <span className="so-kick__mark">{v.kick.scored ? '성공' : '실패'}</span>
              </li>
            ))}
          </ul>
          {complete && (
            <div className={`so-verdict so-verdict--${won ? 'win' : 'loss'}`} role="status">
              {/* 팀명 + 조사(이/가)는 받침 유무에 따라 갈려 오문이 나기 쉽다 —
                  주어를 생략한 문장으로 두면 어떤 팀명에도 안전하다. */}
              <p className="so-verdict__line">
                승부차기 <span className="num">{homeScore}-{awayScore}</span>,{' '}
                {won ? '다음 라운드로 간다' : '여기서 여정이 멈춘다'}
              </p>
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={() => onDone([homeScore, awayScore])}
              >
                계속
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
