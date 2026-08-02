// src/ui/tactics/PlanBadge.tsx
// 스코어버그 옆 플랜 상태 배지 — **비정상일 때만** 뜬다.
//
// ★ 2026-08-02 뒤집기: '플랜 유지 · 팀 이해도 +3%'(상시 긍정 배지)를 없앴다.
//   실플레이 신고: "매번 똑같은 말이 붙어 있어. 필요없으면 빼줘."
//
//   왜 뒤집었는가 — 어제(08-01)의 논증은 "보상 안내는 잔소리가 아니다"였고,
//   그건 배지가 **가끔 켜진다**는 전제 위에 서 있었다. 실제 플레이는 그 전제를 깼다.
//   대부분의 유저는 킥오프 구조(포메이션·멘탈리티)를 경기 내내 그대로 두므로 배지는
//   90분 전부 켜져 있었다. 항상 참인 문장은 정보량이 0이다 — 화면에서 지워도 유저가
//   잃는 판단이 없고, 대신 스코어버그 옆 자리(골·시간이 우선인 자리)만 먹는다.
//   보너스 수치(+3%)를 알려야 할 자리는 **결정하는 순간**, 즉 작전판의 플랜 대비
//   패널(TacticsBoard PlanDiff)이다. 거기서는 유저가 스스로 열어 본 답이라 노이즈가
//   아니고, 그 문구는 그대로 남겨 뒀다.
//
//   그래서 배지가 말하는 것은 하나뿐이다: **구조를 방금 바꿔서 팀이 아직 적응 중**.
//   이건 상시가 아니라 드물고(구조 변경 직후 ADAPT_MINUTES분), 그 사이 실제로
//   페널티가 걸려 있으며(matchStore adaptLag → engine), 유저가 화면에서 달리 알 길이
//   없다 — "바꿨는데 왜 더 안 풀리지"의 답이 여기에 있다.
//
//   세 번째 상태(적응이 끝났고 구조는 킥오프 플랜과 다름)에는 **아무 말도 하지 않는다**.
//   팀은 이미 새 구조에 적응했으니 경고할 것이 없고, "너 계획 어겼다"는 추궁은 경기 후
//   기자회견이 맡는다(game/pressconf.ts planQuestion). 빈 자리는 그대로 비워 둔다.
//
//   엔진 보너스(planIntact)와 집계(planDeviation)는 손대지 않았다 — 이건 표시 문제다.
import { useMatchStore } from '../../game/matchStore'
import './plan-badge.css'

export function PlanBadge() {
  const engine = useMatchStore(s => s.engine)
  // 적응 지연 만료 분. 0이면 이번 경기에서 구조를 바꾼 적이 없다(킥오프 시 0으로 리셋).
  const adaptUntil = useMatchStore(s => s.adaptUntil)
  if (!engine) return null
  // adaptUntil분까지가 지연 구간이다(matchStore advanceMinute의 adaptLag 판정과 같은 경계).
  // 0 체크를 따로 두는 이유: 킥오프 직후 minute이 0이라 `0 >= 0`이 참이 되어 버린다.
  if (adaptUntil <= 0 || adaptUntil < engine.minute) return null
  return (
    <span className="plan-badge" role="status">
      {/* 이모지를 아이콘으로 쓰지 않는다 — 상태는 색과 평문으로 말한다.
          만료 분을 박아 둔다: "언제 끝나나"가 이 배지를 보는 유일한 이유다. */}
      구조 변경 — {adaptUntil}분까지 팀 적응 중
    </span>
  )
}
