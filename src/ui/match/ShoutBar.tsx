import { useMatchStore, SHOUT_LABEL, SHOUT_COOLDOWN, type ShoutType } from '../../game/matchStore'

// 버튼 순서·라벨 — [독려][더 뛰어][침착][칭찬].
const SHOUTS: ShoutType[] = ['urge', 'work', 'calm', 'praise']

/** 터치라인 외침 바 — 방송(broadcast) 하단. 재생을 멈추지 않고 즉시 사기/체력을 미세 보정한다.
 *  10분 쿨다운: 마지막 외침 이후 SHOUT_COOLDOWN분이 지나야 재외침 가능. 쿨다운 진행 바 표시.
 *  홈(감독) 전용. playing이 아니면 렌더하지 않는다(MatchScreen이 replaying일 때만 마운트). */
export function ShoutBar() {
  const engine = useMatchStore(s => s.engine)
  const phase = useMatchStore(s => s.phase)
  const lastShoutMinute = useMatchStore(s => s.lastShoutMinute)
  const shout = useMatchStore(s => s.shout)

  if (!engine || phase !== 'playing') return null
  const minute = engine.minute
  const elapsed = lastShoutMinute === null ? SHOUT_COOLDOWN : minute - lastShoutMinute
  const remaining = Math.max(0, SHOUT_COOLDOWN - elapsed)
  const onCooldown = remaining > 0
  const progress = Math.min(1, elapsed / SHOUT_COOLDOWN) // 0(방금)→1(준비 완료)

  return (
    <div className="sb-root" role="group" aria-label="터치라인 외침">
      <div className="sb-btns">
        {SHOUTS.map(t => (
          <button
            key={t}
            type="button"
            className="sb-btn"
            disabled={onCooldown}
            onClick={() => shout(t)}
          >
            {SHOUT_LABEL[t]}
          </button>
        ))}
      </div>
      <div
        className="sb-cool"
        role="progressbar"
        aria-label="외침 재사용 대기"
        aria-valuemin={0}
        aria-valuemax={SHOUT_COOLDOWN}
        aria-valuenow={Math.min(SHOUT_COOLDOWN, elapsed)}
      >
        <div className="sb-cool__bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        <span className="sb-cool__text">
          {onCooldown ? `재사용까지 ${remaining}분` : '외침 준비 완료'}
        </span>
      </div>
    </div>
  )
}
