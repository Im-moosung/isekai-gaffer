// src/ui/leaderboard/stage.ts
// 도달 라운드 → 한국어 라벨. **엔딩 화면과 리더보드 페이지가 같은 표를 쓴다.**
//
// 예전에는 이 표가 EndingScreen.tsx 안에만 있었다. 리더보드를 독립 페이지로 빼면서
// 복사했다면 "준우승/결승" 같은 표기가 두 화면에서 갈라지는 것은 시간문제다
// (한쪽만 고쳐지는 버그는 이 저장소에서 이미 여러 번 나왔다). 그래서 표를 밖으로 꺼낸다.
import type { CampaignStage } from '../../game/campaignStore'

/** final을 '준우승'으로 적는 이유: reached는 **탈락한 라운드**이고,
 *  결승에서 탈락했다면 그 결과의 이름은 '결승'이 아니라 '준우승'이다.
 *  우승은 champion 플래그로 따로 판정한다(아래 reachedLabel). */
export const STAGE_LABEL: Record<CampaignStage, string> = {
  group1: '조별 1차전', group2: '조별 2차전', group3: '조별리그',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '준우승', ended: '여정의 끝',
}

/** 한 기록의 도달 라운드 표기 — 우승은 라운드 이름 대신 '우승'이다. */
export function reachedLabel(reached: CampaignStage, champion: boolean): string {
  return champion ? '우승' : STAGE_LABEL[reached]
}
