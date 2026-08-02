// src/ui/leaderboard/LeaderboardScreen.tsx
// 독립 리더보드 페이지 — 전체 순위(최대 50위)와 [타이틀로 돌아가기].
//
// 왜 독립 화면인가: 예전에는 순위가 엔딩 화면 안의 TOP 10 카드로만 존재했다.
// 그러면 순위를 보려면 **캠페인 8경기를 다시 끝내야** 했고, 재도전 동기인 리더보드가
// 정작 재도전을 시작하기 전에는 보이지 않았다. 타이틀에서도 바로 들어올 수 있게 화면을 뺀다.
//
// 조회는 useLeaderboard 하나뿐이다(엔딩 화면과 공유). 로딩·비어있음·실패 표시는
// LeaderboardBoard가 전담하므로, Supabase가 죽어도 이 페이지가 하얗게 되지 않는다.
import { AppShell } from '../shell/AppShell'
import { LeaderboardBoard } from './LeaderboardBoard'
import { useLeaderboard } from './useLeaderboard'
import './leaderboard.css'

/** 표시 상한. TOP 10은 "내 기록이 거기 없으면 아무 정보도 없는" 표라서 재도전 동기가 약하다.
 *  50위까지 보이면 대부분의 플레이가 표 안에 들어오고, 다음 한 칸이 눈에 보인다.
 *  localStorage 폴백의 보관 상한(LOCAL_MAX=50)과도 같은 수라 두 모드의 표가 어긋나지 않는다. */
const LIMIT = 50

export function LeaderboardScreen({ onBackToTitle }: { onBackToTitle(): void }) {
  const board = useLeaderboard(LIMIT)

  return (
    <AppShell
      className="lb-root"
      width="read"
      top={
        <>
          <span className="shell__brand">Isekai Gaffer</span>
          <span className="shell__context">리더보드 · 전체 순위</span>
        </>
      }
      bottom={
        <>
          <span className="shell__bottom-status">
            {board.status === 'ready' ? (
              <>
                기록 <span className="num">{board.rows.length}</span>개 ·{' '}
                {board.mode === 'local' ? '이 기기 기록' : '전 세계 기록'}
              </>
            ) : (
              '감독들의 여정 기록'
            )}
          </span>
          <button type="button" className="btn btn--primary btn--lg" onClick={onBackToTitle}>
            타이틀로 돌아가기
          </button>
        </>
      }
    >
      <section className="lb-hero">
        <span className="eyebrow">역대 기록</span>
        <h1 className="lb-headline">리더보드</h1>
        <p className="lb-lede">
          도달 라운드·승점·득실·업셋·무실점을 합산한 총점 순위다. 상위 {LIMIT}위까지 표시한다.
        </p>
      </section>

      <section className="section lb-panel" aria-label="전체 순위">
        <div className="section__head">
          <h2 className="section__title">전체 순위</h2>
          {board.status === 'ready' && board.mode === 'local' && (
            <span className="badge">이 기기 기록</span>
          )}
        </div>
        {/* 열 제목 — 50행짜리 표에서는 숫자 두 개(순위·점수)가 무엇인지 한 번은 적어야 한다. */}
        <div className="lb-head" aria-hidden="true">
          <span className="lb-row__rank">순위</span>
          <span className="lb-row__nick">감독</span>
          <span className="lb-row__reached">도달</span>
          <span className="lb-row__pts">점수</span>
        </div>
        <LeaderboardBoard state={board} />
      </section>
    </AppShell>
  )
}
