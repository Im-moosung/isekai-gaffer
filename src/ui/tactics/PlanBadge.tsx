// src/ui/tactics/PlanBadge.tsx
// 스코어버그 옆 플랜 상태 배지 — **보너스가 살아 있을 때만** 뜬다.
//
// ★ 2026-08-01: "플랜 이탈 N축" 갈래를 없앴다(사용자 지시: "플랜 이탈 이런 게 나오는데 없애줘").
//   왜 갈래 하나만 없애고 배지 자체는 남겼는가:
//   · 유저가 싫어한 것은 **잔소리**다. 이탈 배지는 이미 내린 결정을 경기 내내 붙들고
//     "너 계획 어겼다"고 반복하는데, 그 추궁은 경기 후 기자회견이 이미 맡고 있다
//     (game/pressconf.ts planQuestion). 화면에서 90분 내내 되풀이할 이유가 없다.
//   · 반대로 '플랜 유지 · 팀 이해도 +3%'는 **실제 엔진 보너스**(engine/simulate.ts
//     isPlanStructIntact)가 걸려 있다는 유일한 안내다. 이것까지 지우면 유저는 자기가
//     받고 있는 이득을 화면 어디에서도 알 수 없다. 보상 안내는 잔소리가 아니다.
//   · 그래서 이탈하면 배지가 **그냥 사라진다**. 배지의 존재 자체가 "보너스 살아 있음"이
//     되어 판정이 이진으로 단순해지고, 사라진다는 사실이 추궁 없이 상태를 전달한다.
//     빈 자리는 그대로 비워 둔다 — 자리를 메우려고 다른 상시 표시를 넣으면 방금 없앤
//     잔소리를 다른 문구로 되살리는 셈이고, 스코어버그 옆은 골·시간이 우선인 자리다.
//
//   planDeviation은 store에 그대로 남는다(matchStore의 집계도 손대지 않았다) —
//   기자회견(ui/press/PressConference.tsx)이 store에서 직접 읽으므로 이 배지와 무관하다.
import { useMatchStore, isPlanStructIntact } from '../../game/matchStore'
import './plan-badge.css'

export function PlanBadge() {
  const plan = useMatchStore(s => s.matchPlan)
  const engine = useMatchStore(s => s.engine)
  if (!plan || !engine) return null
  // 구조(포메이션·멘탈리티) 유지 여부가 엔진 보너스의 조건이므로 배지도 같은 판정을 쓴다.
  if (!isPlanStructIntact(plan, engine.home.tactics)) return null
  return (
    <span className="plan-badge plan-badge--ok" role="status">
      {/* 이모지를 아이콘으로 쓰지 않는다 — 상태는 색과 평문으로 말한다. */}
      플랜 유지 · 팀 이해도 +3%
    </span>
  )
}
