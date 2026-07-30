// 라이브 스탯 표시 규칙 — 순수 함수. 렌더러·스토어에 의존하지 않는다.
//
// 왜 별도 모듈인가: "경기 2분인데 점유율 100%"는 엔진 버그가 아니라 **표시 규칙의
// 부재**다. 표본이 1~2분이면 비율은 0% 또는 100%로 튄다. 방송도 게임도 이걸 억제하지
// 않고 실시간 피드를 그대로 흘리므로(리서치 §6-8), 억제는 우리가 더 잘할 수 있는
// 지점이다. 규칙을 UI 컴포넌트 안에 묻으면 검증이 불가능해지므로 여기로 뺀다.
//
// 한 줄 원칙: **누적량(슛·xG·패스 수)은 1분부터 정직하다. 억제 대상은 비율(%)뿐이다.**

/** 게이트 A — 이 분 전까지는 값을 아예 내지 않는다("집계 중"). */
export const GATE_HIDE_MIN = 5
/** 게이트 C — 이 분부터는 원본값을 그대로 낸다. */
export const GATE_RAW_MIN = 15
/** 게이트 B 수축 계수 상한. p_shown = (p + k/2) / (1 + k). */
export const SHRINK_K = 0.5
/** 게이트 A의 표본 하한(possession 시퀀스 수). 분당 표본 근사는 아래 주석 참조. */
export const MIN_SAMPLES = 20

export interface PossessionView {
  /** 우리 팀 표시값. 억제 중이면 '—'. */
  usLabel: string
  /** 상대 표시값. 억제 중이면 '—'. */
  themLabel: string
  /** 우리 팀 바 채움(%). 억제 중이면 50(중립 반반). */
  usBar: number
  /** 억제 중 — 바를 팀 색이 아니라 중립색으로 그려야 한다. */
  suppressed: boolean
  /** 분모 병기 캡션. 비율에는 언제나 표본을 함께 적는다(mplsoccer 규범). */
  caption: string
}

/**
 * 점유율 표시값 — 3게이트.
 *
 * - `t < 5분` 이고 표본이 모자라면 값 '—', 바 50:50 중립, 캡션 "집계 중"
 * - `5 ≤ t < 15분` 수축: `p_shown = (p + k/2) / (1 + k)`
 * - `t ≥ 15분` 원본값, 정수 반올림
 *
 * ★ k를 상수 0.5로 두면 15분에도 수축이 남아 "15분엔 원본에 수렴한다"는 규격과
 *   어긋난다(p=1 → 영원히 83%). 그래서 k를 5→15분 구간에서 0.5→0으로 선형 감쇠시킨다.
 *   게이트 B와 C가 연속으로 이어지고, 규격이 요구한 수렴 성질이 실제로 성립한다.
 *
 * ★ 소수점을 내지 않는다. 점유율은 정의가 3종 공존해 같은 경기에서도 제공사 간
 *   4~6%p가 갈리는 지표다 — 소수점 한 자리는 없는 정밀도를 주장하는 것이다.
 *
 * @param minute 현재 분
 * @param usRaw  우리 팀 원본 점유율(0~100 또는 임의 누적량)
 * @param themRaw 상대 원본값
 * @param samples possession 시퀀스 표본 수. 엔진이 시퀀스를 세지 않으므로 기본값은
 *   분 수다(분당 최소 1표본 근사) — 게이트 A가 "초반"을 막는다는 의도는 그대로 산다.
 */
export function possessionView(
  minute: number,
  usRaw: number,
  themRaw: number,
  samples: number = minute,
): PossessionView {
  const total = usRaw + themRaw
  const blank = (caption: string): PossessionView => ({
    usLabel: '—', themLabel: '—', usBar: 50, suppressed: true, caption,
  })
  if (total <= 0) return blank('집계 중')
  if (minute < GATE_HIDE_MIN && samples < MIN_SAMPLES) return blank('집계 중')

  let p = usRaw / total
  if (minute < GATE_RAW_MIN) {
    const k = SHRINK_K * ((GATE_RAW_MIN - minute) / (GATE_RAW_MIN - GATE_HIDE_MIN))
    p = (p + k / 2) / (1 + k)
  }
  const us = Math.round(p * 100)
  return {
    usLabel: `${us}%`,
    themLabel: `${100 - us}%`,
    usBar: us,
    suppressed: false,
    caption: minute < GATE_RAW_MIN ? `표본 ${minute}분 · 보정 중` : `표본 ${minute}분`,
  }
}

/** 누적량 한 줄 — "슛 7-3 · 유효 3-1". 억제하지 않는다(1분부터 정직한 수치다). */
export function countLine(
  items: readonly { label: string; us: number; them: number }[],
): string {
  return items.map(i => `${i.label} ${i.us}-${i.them}`).join(' · ')
}
