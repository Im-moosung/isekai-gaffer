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
// 3경기 모두 빈 배열이 사실이다(전반 0-0).
//
// [용도 변경 · F1 B안 2026-07-26]
//  · realScore  — 계속 쓴다. MatchScreen → TacticsCenter의 referenceScore prop으로
//                 "참고 · 실제 역사 2-1" 기준선을 보여준다. 유저가 자기 결과와 비교할 앵커다.
//  · firstHalfScript — 이제 아무도 소비하지 않는다. App이 전반 스크립트 배선을 끊고
//                 조별 경기도 1~90분 완전 시뮬로 바꿨기 때문이다(전반이 죽어 있던 문제).
//                 삭제하지 않는 이유: 리서치로 검증한 실제 데이터라 나중에 리플레이·
//                 "역사 vs 내 경기" 비교 기능의 입력으로 되살릴 수 있다.
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
  /** 전반(0~45') 이벤트만. 3경기 모두 전반 0-0이므로 빈 배열.
   *  현재 소비처 없음(F1 B안으로 배선 해제) — 리플레이·역사 비교용 보존 데이터. */
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
