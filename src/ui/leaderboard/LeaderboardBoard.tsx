// src/ui/leaderboard/LeaderboardBoard.tsx
// 리더보드 표 본체 — 로딩·비어있음·실패·목록의 **네 상태를 모두 그리는** 공용 컴포넌트.
//
// 엔딩 화면(TOP 10 카드)과 독립 리더보드 페이지(TOP 50)가 이 하나를 쓴다.
// 상태 분기를 화면마다 따로 쓰면 한쪽에서 "Supabase가 죽었을 때 하얀 화면"이 되살아난다 —
// 실제로 그 사고를 막으려고 만든 컴포넌트이므로, 새 화면이 생겨도 여기로 들어와야 한다.
import type { LeaderboardRow } from '../../online/leaderboard'
import type { LeaderboardState } from './useLeaderboard'
import { reachedLabel } from './stage'
import './leaderboard.css'

/** 1~3위 시각 구분. 메달 이모지를 쓰지 않는 이유는 트로피와 같다 —
 *  OS마다 모양·폭이 달라 순위 열의 정렬이 흔들린다. 색과 굵기로만 구분한다. */
function rankClass(rank: number): string {
  if (rank === 1) return ' lb-row--gold'
  if (rank === 2) return ' lb-row--silver'
  if (rank === 3) return ' lb-row--bronze'
  return ''
}

export function LeaderboardBoard({ state, highlight, emptyText }: {
  state: LeaderboardState
  /** 내 기록 강조 판정. 닉네임만으로는 동명이인이 걸리므로 화면이 총점까지 함께 본다. */
  highlight?(row: LeaderboardRow, index: number): boolean
  emptyText?: string
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <p className="lb-note" role="status">
        {state.status === 'loading' ? '순위를 불러오는 중…' : '순위를 준비하는 중…'}
      </p>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="lb-note lb-note--error" role="alert">
        <p>순위를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.</p>
        <button type="button" className="btn btn--secondary btn--sm lb-retry" onClick={state.reload}>
          다시 시도
        </button>
      </div>
    )
  }

  if (state.rows.length === 0) {
    return (
      <p className="lb-note" role="status">
        {emptyText ?? '아직 등록된 기록이 없습니다. 첫 기록의 주인공이 되어 보세요.'}
      </p>
    )
  }

  return (
    <ol className="lb-list">
      {state.rows.map((r, i) => {
        const rank = i + 1
        const mine = highlight?.(r, i) ?? false
        return (
          <li
            key={`${r.nickname}-${r.total}-${i}`}
            className={`lb-row${rankClass(rank)}${mine ? ' lb-row--me' : ''}`}
          >
            <span className="lb-row__rank num">{rank}</span>
            <span className="lb-row__nick">{r.nickname}</span>
            <span className="lb-row__reached">{reachedLabel(r.reached, r.champion)}</span>
            <span className="lb-row__pts num">{r.total}</span>
          </li>
        )
      })}
    </ol>
  )
}
