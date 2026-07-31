import { useRef } from 'react'
import { useMatchStore, SHOUT_LABEL, SHOUT_COOLDOWN, type ShoutType } from '../../game/matchStore'

// 버튼 순서·라벨 — [독려][더 뛰어][침착][칭찬].
const SHOUTS: ShoutType[] = ['urge', 'work', 'calm', 'praise']

// 쿨다운 링 기하 — r=8의 원둘레. 인라인 style이 아니라 SVG 속성으로 넘긴다.
const RING_R = 8
const RING_C = 2 * Math.PI * RING_R

/**
 * 터치라인 외침 바 — 하단 액션 바 안. 재생을 멈추지 않고 즉시 사기/체력을 보정한다.
 *
 * ★ 예전에는 350px짜리 진행 바에 "외침 준비 완료" 라벨이 붙어 있었다. 진행률처럼
 *   보이지만 실제로는 boolean이고, 바 하나가 화면 하단의 절반을 먹었다.
 *   지금은 **상태를 버튼 자신이 말한다** — disabled + 버튼 안의 원형 쿨다운 링.
 *   FM이 쓰는 방식이고, 남는 가로폭은 중계 티커가 가져간다.
 *
 * ★ 연타 방지가 필수다(FM26 실제 버그: 같은 외침을 두 번 연속 고르면 UI가 멈춘다).
 *   버튼 disabled + 같은 분 재진입 차단 두 겹으로 막는다.
 */
export function ShoutBar({ frozen = false }: { frozen?: boolean }) {
  const engine = useMatchStore(s => s.engine)
  const phase = useMatchStore(s => s.phase)
  const lastShoutMinute = useMatchStore(s => s.lastShoutMinute)
  const shout = useMatchStore(s => s.shout)
  // 같은 분에 두 번 들어오는 클릭을 삼킨다(상태 반영 전 연타·더블탭).
  const firedMinuteRef = useRef(-1)

  if (!engine || phase !== 'playing') return null
  const minute = engine.minute
  const elapsed = lastShoutMinute === null ? SHOUT_COOLDOWN : minute - lastShoutMinute
  const remaining = Math.max(0, SHOUT_COOLDOWN - elapsed)
  const onCooldown = remaining > 0
  // 링은 **남은 쿨다운**을 그린다 — 줄어드는 호가 "곧 다시 쓸 수 있다"를 말한다.
  const left = Math.max(0, Math.min(1, remaining / SHOUT_COOLDOWN))

  function fire(t: ShoutType) {
    // ★ 일시정지는 **아무 개입 권한도 주지 않는다**. 외침은 개입이므로 여기서 막는다 —
    //   막지 않으면 "멈춰 놓고 천천히 고른 뒤 외친다"가 되어, 정지 시점이 곧 자원이라는
    //   개입 등급 설계(matchStore.interventionLevel)에 구멍이 난다.
    if (frozen || onCooldown || firedMinuteRef.current === minute) return
    firedMinuteRef.current = minute
    shout(t)
  }

  return (
    <div className="sb-root" role="group" aria-label="터치라인 외침">
      {SHOUTS.map(t => (
        <button
          key={t}
          type="button"
          className="btn btn--secondary btn--sm sb-btn"
          disabled={frozen || onCooldown}
          onClick={() => fire(t)}
        >
          {onCooldown && (
            <svg className="sb-ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <circle className="sb-ring__track" cx="10" cy="10" r={RING_R} />
              <circle
                className="sb-ring__arc"
                cx="10"
                cy="10"
                r={RING_R}
                strokeDasharray={`${(left * RING_C).toFixed(2)} ${RING_C.toFixed(2)}`}
              />
            </svg>
          )}
          {SHOUT_LABEL[t]}
        </button>
      ))}
      {/* 왜 버튼이 죽었는지 말해 준다 — 이유 없는 disabled는 고장으로 읽힌다. */}
      {frozen && <span className="sb-cool">일시정지 중</span>}
      {!frozen && onCooldown && (
        <span
          className="sb-cool num"
          role="progressbar"
          aria-label="외침 재사용 대기"
          aria-valuemin={0}
          aria-valuemax={SHOUT_COOLDOWN}
          aria-valuenow={Math.min(SHOUT_COOLDOWN, elapsed)}
        >
          재사용까지 {remaining}분
        </span>
      )}
    </div>
  )
}
