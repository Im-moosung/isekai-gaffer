import { useEffect, useRef, useState } from 'react'
import {
  useMatchStore, shoutState, SHOUT_LABEL, SHOUT_COOLDOWN,
  type ShoutResult, type ShoutType,
} from '../../game/matchStore'
import type { Position } from '../../engine/types'

// 버튼 순서·라벨 — [독려][더 뛰어][침착][칭찬].
const SHOUTS: ShoutType[] = ['urge', 'work', 'calm', 'praise']

// 쿨다운 링 기하 — r=8의 원둘레. 인라인 style이 아니라 SVG 속성으로 넘긴다.
const RING_R = 8
const RING_C = 2 * Math.PI * RING_R

/** 결과 배너가 화면에 머무는 시간(ms). 팀토크 배너와 달리 **스스로 사라진다** —
 *  경기가 흐르는 중이라 감독이 닫아 줄 짬이 없고, 남아 있으면 다음 장면을 가린다.
 *  3.8초: 이름 세 개 + 수치를 읽기에 충분하고, 다음 분(1x 기준 약 4초)을 넘기지 않는다. */
const BANNER_MS = 3800

/** 포지션 → 라인 그룹 한국어. 결과 문장을 *"수비진의 사기가 올랐습니다"*로 만들기 위한 표. */
const LINE_KO: Record<Position, string> = {
  GK: '골키퍼', CB: '수비진', LB: '수비진', RB: '수비진',
  DM: '중원', CM: '중원', AM: '중원',
  LW: '공격진', RW: '공격진', ST: '공격진',
}

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
 *
 * ★ 2026-08-01 — 외침은 **자유 개입 5회에서 빠졌다**(matchStore.SHOUT_COOLDOWN 위의
 *   논증). 그래서 이 바는 개입 잔량을 읽지 않는다. 화면에서 둘을 구별하는 방법:
 *    · 개입 — 상단 제어 pod의 `개입 N/5` 배지 + [감독 타임] 버튼(잔량이 보인다)
 *    · 외침 — 하단 액션 바의 이 바(잔량이라는 개념 자체가 없다)
 *   자원의 성격이 다르면 사는 곳도 달라야 한다. 같은 줄에 두면 다시 한 통장으로 읽힌다.
 */
export function ShoutBar({ frozen = false }: { frozen?: boolean }) {
  const engine = useMatchStore(s => s.engine)
  const phase = useMatchStore(s => s.phase)
  const lastShoutMinute = useMatchStore(s => s.lastShoutMinute)
  const shout = useMatchStore(s => s.shout)
  // 같은 분에 두 번 들어오는 클릭을 삼킨다(상태 반영 전 연타·더블탭).
  const firedMinuteRef = useRef(-1)
  /** 방금 외침의 결과 — 잠깐 떴다 사라진다. */
  const [result, setResult] = useState<ShoutResult | null>(null)

  // 배너 자동 소멸. 새 외침이 들어오면 타이머를 다시 건다(마지막 것만 산다).
  useEffect(() => {
    if (!result) return
    const t = setTimeout(() => setResult(null), BANNER_MS)
    return () => clearTimeout(t)
  }, [result])

  if (!engine || phase !== 'playing') return null
  const minute = engine.minute
  const { cooldownLeft: remaining, canShout } = shoutState(lastShoutMinute, minute)
  const onCooldown = !canShout
  const elapsed = lastShoutMinute === null ? SHOUT_COOLDOWN : minute - lastShoutMinute
  // 링은 **남은 쿨다운**을 그린다 — 줄어드는 호가 "곧 다시 쓸 수 있다"를 말한다.
  const left = Math.max(0, Math.min(1, remaining / SHOUT_COOLDOWN))

  function fire(t: ShoutType) {
    // ★ 일시정지 중에는 외치지 않는다. 외침이 개입 자원에서 빠진 뒤에도 이 규칙은 남는다 —
    //   근거가 바뀌었을 뿐이다. 예전 근거는 "외침은 개입이다"였고, 지금 근거는
    //   *"멈춘 시계에서는 아무 일도 일어나지 않는다"*이다. 정지 중에 지르면 그 한 마디가
    //   경기 시간 0분을 소비하고, 쿨다운도 흐르지 않아 재개 즉시 또 지를 수 있다.
    if (frozen || onCooldown || firedMinuteRef.current === minute) return
    firedMinuteRef.current = minute
    setResult(shout(t))
  }

  return (
    <div className="sb-root" role="group" aria-label="터치라인 외침">
      {result && <ShoutResultBanner result={result} />}
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

/**
 * 외침 결과 — 잠깐 떴다 사라지는 배너.
 *
 * ★ **팀토크 결과 배너(tt-banner)의 문법을 그대로 빌린다.** 새 레이어를 발명하지 않는
 *   이유는 둘이 같은 종류의 사건이기 때문이다 — "감독이 말했고, 라커룸이 이렇게 반응했다".
 *   유저가 하프타임에 한 번 배운 읽는 법이 90분 내내 그대로 쓰인다. 다른 점은 위치와
 *   수명뿐이다(하단 바 위 · 3.8초 자동 소멸).
 */
function ShoutResultBanner({ result }: { result: ShoutResult }) {
  const engine = useMatchStore(s => s.engine)
  const squad = engine?.home.team.squad
  // 뽑힌 선수들이 한 라인에 모여 있으면 그 라인 이름으로 말한다 — *"수비진의 사기가
  // 올랐습니다"*가 *"선수단 사기 상승"*보다 구체적이고, 감독이 무엇을 건드렸는지 보여 준다.
  const lines = new Set(
    result.targets.map(t => {
      const pos = squad?.find(p => p.id === t.playerId)?.position
      return pos ? LINE_KO[pos] : '선수단'
    }),
  )
  const who = lines.size === 1 ? [...lines][0] : '선수단'
  const headline = result.backfire
    ? `역효과 — ${who}의 사기가 떨어졌습니다`
    : `${who}의 사기가 올랐습니다`

  return (
    <div
      className={`tt-banner sb-banner ${result.backfire ? 'tt-banner--down' : 'tt-banner--up'}`}
      role="status"
    >
      <span className="tt-banner__tone">{SHOUT_LABEL[result.type]}</span>
      <span className="tt-banner__text">{headline}</span>
      {/* 체력을 건드리는 외침은 [더 뛰어]뿐이다. 대가를 숨기면 다음에 또 누른다. */}
      {result.teamStamina !== 0 && (
        <span className="sb-banner__cost num">체력 {result.teamStamina}</span>
      )}
      <ul className="tt-reactions">
        {result.targets.map(t => (
          <li key={t.playerId} className="tt-reactions__item">
            <span className="tt-reactions__name">{t.name}</span>
            {/* "누가 얼마나" — 실제로 움직인 값이다(클램프 반영). */}
            <span className="badge num">사기 {t.morale > 0 ? `+${t.morale}` : t.morale}</span>
          </li>
        ))}
      </ul>
      {/* 대상 선정이 무작위가 아니라는 것을 한 줄로 알려 준다 — 유저가 패턴을 찾는 통로다. */}
      <p className="tt-banner__note">{result.affinity}</p>
    </div>
  )
}
