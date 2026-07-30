// src/ui/tactics/PlanBadge.tsx
// 스코어버그 옆 플랜 상태 배지.
// 유지 중이면 보너스를 명시해 "계획을 지킨 대가"를 눈에 보이게 하고,
// 이탈했으면 축 수를 보여줘 경기 후 기자회견의 추궁을 예고한다.
import { useMatchStore, isPlanStructIntact } from '../../game/matchStore'
import './plan-badge.css'

export function PlanBadge() {
  const plan = useMatchStore(s => s.matchPlan)
  const dev = useMatchStore(s => s.planDeviation)
  const engine = useMatchStore(s => s.engine)
  if (!plan || !engine) return null
  // 구조(포메이션·멘탈리티) 유지 여부가 엔진 보너스의 조건이므로 배지도 같은 판정을 쓴다.
  const intact = isPlanStructIntact(plan, engine.home.tactics)
  return (
    <span className={`plan-badge${intact ? ' plan-badge--ok' : ''}`} role="status">
      {/* 이모지를 아이콘으로 쓰지 않는다 — 상태는 색과 평문으로 말한다. */}
      {intact ? '플랜 유지 · 팀 이해도 +3%' : `플랜 이탈 ${dev}축`}
    </span>
  )
}
