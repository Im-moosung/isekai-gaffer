// src/data/groupStage.ts
// 조별리그(A조) 한국 3경기의 역사 재현 데이터.
// 리서치 🟢 사실(스코어·득점자·득점 분)만 사용한다.
//
// 경기 순서: 체코(cze) → 멕시코(mex) → 남아공(rsa)
//   · 체코 2-1 : 크레이치 59' / 황인범 67' · 오현규 80'
//   · 멕시코 0-1 : 로모 50'
//   · 남아공 0-1 : 마세코 63'
//
// 핵심: 실제 득점은 전부 후반(50'~80')이다. 따라서 firstHalfScript(전반 스크립트)는
// 3경기 모두 빈 배열이 사실이다(전반 0-0). 후반은 유저가 시뮬로 새로 플레이한다.
// realScore는 참고 표시용이며, 위 후반 득점 사실은 아래 주석으로만 기록하고 스크립트엔 미포함한다.
//
// koreaHome: 실제 대회는 중립 개최지이므로 홈/원정 개념이 없다 → true로 고정한다.
import type { TeamId } from './loader'

export interface ScriptEvent {
  minute: number
  type: 'goal'
  teamId: string
  playerName: string
}

export interface GroupMatch {
  opponent: TeamId
  /** 한국 관점 최종 스코어 [한국, 상대] — 참고 표시용 */
  realScore: [number, number]
  /** 중립 개최지이므로 true 고정 */
  koreaHome: boolean
  /** 전반(0~45') 이벤트만. 3경기 모두 전반 0-0이므로 빈 배열 */
  firstHalfScript: ScriptEvent[]
}

export const GROUP_MATCHES: GroupMatch[] = [
  // 체코 2-1 — 후반 득점: 크레이치(cze) 59', 황인범(kor) 67', 오현규(kor) 80' → 전반 스크립트 없음
  { opponent: 'cze', realScore: [2, 1], koreaHome: true, firstHalfScript: [] },
  // 멕시코 0-1 — 후반 득점: 로모(mex) 50' → 전반 스크립트 없음
  { opponent: 'mex', realScore: [0, 1], koreaHome: true, firstHalfScript: [] },
  // 남아공 0-1 — 후반 득점: 마세코(rsa) 63' → 전반 스크립트 없음
  { opponent: 'rsa', realScore: [0, 1], koreaHome: true, firstHalfScript: [] },
]
