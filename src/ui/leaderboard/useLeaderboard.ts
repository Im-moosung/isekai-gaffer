// src/ui/leaderboard/useLeaderboard.ts
// 리더보드 조회 훅 — **엔딩 화면과 독립 리더보드 페이지가 공유하는 단 하나의 조회 경로다.**
//
// 왜 훅으로 빼는가: 조회 코드가 엔딩 화면 안에 있었고, 독립 페이지를 만들면서 복붙했다면
// 한쪽만 고쳐지는 버그가 반드시 생긴다(정렬 기준·에러 처리·limit이 갈린다).
// 화면은 "몇 개를 언제 볼 것인가"만 정하고, 조회·상태 전이는 전부 여기서 한다.
//
// online/leaderboard.ts의 topScores는 설계 §7 폴백 원칙상 어떤 실패에서도 예외를 던지지 않고
// localStorage 결과를 돌려준다(mode='local'). 그래도 여기서 catch를 다는 이유는,
// 폴백의 폴백까지 무너진 경우(localStorage 접근 자체가 예외)에도 **페이지가 하얗게 되면 안 되기**
// 때문이다. 그 경우 status='error'로 내려가고 화면은 재시도 버튼이 있는 안내를 그린다.
import { useCallback, useEffect, useState } from 'react'
import { topScores } from '../../online/leaderboard'
import type { LeaderboardMode, LeaderboardRow } from '../../online/leaderboard'

/** idle은 "아직 조회할 때가 아니다"이다 — 엔딩 화면은 기록 등록 전까지 idle에 머문다. */
export type LeaderboardStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface LeaderboardState {
  status: LeaderboardStatus
  rows: LeaderboardRow[]
  /** supabase = 전 세계 기록 / local = 이 기기 기록(폴백). */
  mode: LeaderboardMode
  /** 재조회 — 실패 안내의 [다시 시도], 등록 직후 갱신에 쓴다. */
  reload(): void
}

/**
 * 상위 limit개 기록을 조회한다.
 * @param limit 가져올 개수(엔딩 카드 10, 독립 페이지 50).
 * @param enabled false면 조회하지 않고 idle에 머문다(엔딩 화면의 "등록 전" 상태).
 */
export function useLeaderboard(limit: number, enabled = true): LeaderboardState {
  const [status, setStatus] = useState<LeaderboardStatus>('idle')
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [mode, setMode] = useState<LeaderboardMode>('local')
  // reload는 effect를 다시 태우기 위한 카운터다. 상태를 직접 건드리지 않으므로
  // 진행 중이던 조회의 alive 플래그가 그대로 살아 경쟁 상태가 생기지 않는다.
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      return
    }
    let alive = true
    setStatus('loading')
    topScores(limit)
      .then(res => {
        if (!alive) return
        setRows(res.rows)
        setMode(res.mode)
        setStatus('ready')
      })
      .catch(() => {
        if (!alive) return
        setRows([])
        setStatus('error')
      })
    return () => { alive = false }
  }, [enabled, limit, nonce])

  return { status, rows, mode, reload }
}
