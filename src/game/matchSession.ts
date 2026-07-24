// src/game/matchSession.ts
// 매치데이 2.0 재생 세션의 순수 로직 — 하이드레이션 브레이크 스케줄과 동적 결정 순간 감지.
// 어느 것도 Date/Math.random을 쓰지 않는다(시드·입력 결정론). matchStore가 이 함수들을
// 호출해 phase 전이를 결정한다.
import { createRng } from '../engine/rng'
import type { MatchEvent } from '../engine/types'

/** 전·후반 하이드레이션 브레이크 분. 22±2', 67±2' — 시드 결정론. */
export interface HydrationSchedule {
  firstHydration: number
  secondHydration: number
}

/** 시드에서 두 하이드레이션 브레이크 분을 결정한다.
 *  실제 2026 규정: 전·후반 각 ~22분·~67분에 3분간, 전 경기 의무 — research/2026-hydration-breaks.md.
 *  엔진 분 파생 RNG(seed*10007+minute)와 겹치지 않도록 별도 상수로 xor. */
export function breakSchedule(seed: number): HydrationSchedule {
  const rng = createRng((seed ^ 0x42011) >>> 0)
  return {
    firstHydration: rng.int(20, 24), // 22±2 (전반 ~22')
    secondHydration: rng.int(65, 69), // 67±2 (후반 ~67')
  }
}

/** 동적 결정 순간 5유형. */
export type MomentKind = 'conceded' | 'momentum-lost' | 'scored' | 'clutch' | 'fatigue'

/** 감지된 결정 순간 — 배너 제안의 근거. */
export interface DecisionMoment {
  kind: MomentKind
  minute: number
  /** 방송 배너 헤드라인(한국어). */
  title: string
}

const MOMENTUM_WINDOW = 10 // 흐름 상실 판정 창(분)
const MOMENTUM_SHOTS = 3 // 창 내 상대 슛 임계
const CLUTCH_FROM = 80 // 막판 클러치 시작 분
const FATIGUE_FLOOR = 35 // 주력 체력 급락 임계

/** 홈(유저) 관점에서 이 분에 제안할 결정 순간을 감지한다. 우선순위 순으로 첫 매칭 반환.
 *  '같은 유형 경기당 1회'는 호출자(matchStore)가 firedMoments로 관리한다.
 *  @param events    누적 매치 이벤트
 *  @param minute    현재(방금 시뮬한) 분
 *  @param score     현재 스코어 [home, away]
 *  @param prevScore 직전 분 스코어 [home, away]
 *  @param staminaFloor 홈 주전 최저 스태미나
 *  @param teams     팀 id (상대 슛 필터용) */
export function detectMoment(
  events: readonly MatchEvent[],
  minute: number,
  score: readonly [number, number],
  prevScore: readonly [number, number],
  staminaFloor: number,
  teams: { homeId: string; awayId: string },
): DecisionMoment | null {
  // 1) 실점 직후 (away 득점) — 가장 즉각적
  if (score[1] > prevScore[1]) return { kind: 'conceded', minute, title: '실점 직후 — 벤치가 술렁입니다' }
  // 2) 득점 직후 (home 득점)
  if (score[0] > prevScore[0]) return { kind: 'scored', minute, title: '득점 직후 — 흐름을 굳히시겠습니까?' }
  // 3) 흐름 상실 — 최근 10분 상대 슛 3+
  if (oppShotsInWindow(events, minute, teams) >= MOMENTUM_SHOTS)
    return { kind: 'momentum-lost', minute, title: '흐름을 내주고 있습니다' }
  // 4) 막판 클러치 — 80'+ 스코어차 ≤ 1
  if (minute >= CLUTCH_FROM && Math.abs(score[0] - score[1]) <= 1)
    return { kind: 'clutch', minute, title: '막판 승부처' }
  // 5) 주력 체력 급락
  if (staminaFloor < FATIGUE_FLOOR) return { kind: 'fatigue', minute, title: '주력 체력이 바닥입니다' }
  return null
}

/** 최근 MOMENTUM_WINDOW분 내 상대(away)의 슛 수.
 *  상대 슛 = away의 goal·miss + home GK가 막은 save(teamId=home). */
function oppShotsInWindow(events: readonly MatchEvent[], minute: number, teams: { homeId: string; awayId: string }): number {
  const from = minute - MOMENTUM_WINDOW
  let n = 0
  for (const e of events) {
    if (e.minute <= from || e.minute > minute) continue
    if ((e.type === 'goal' || e.type === 'miss') && e.teamId === teams.awayId) n++
    else if (e.type === 'save' && e.teamId === teams.homeId) n++
  }
  return n
}
