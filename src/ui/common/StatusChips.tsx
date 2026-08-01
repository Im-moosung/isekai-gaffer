// src/ui/common/StatusChips.tsx
// 선수 상태를 "목록을 훑을 때 한눈에" 읽히게 만드는 아이콘 칩.
//
// ── 왜 게이지가 아니라 칩인가 ─────────────────────────────────────
// 체력·사기 게이지는 선수 카드를 열어야 보인다. 그런데 교체 판단은 카드 하나가 아니라
// **11+15명을 훑으면서** 일어난다 — "누굴 뺄까"는 목록 스캔 문제다. 그래서 목록 행에
// 붙는 저면적 표식이 필요하다.
//
// ── 설계 규칙 ────────────────────────────────────────────────────
// 1. **나쁠 때만 뜬다.** 체력 100·사기 정상인 선수에겐 아무것도 붙지 않는다. 전원에게
//    칩을 달면 정보량이 0이 되고(벤치 15명 전원 풀바 문제의 반복), 눈에 띄어야 할
//    소수가 묻힌다. 아무것도 없는 행 = "이상 없음"이 그 자체로 신호다.
// 2. **형태 + 색.** 색만으로 구분하지 않는다(색각 접근성). 실루엣이 서로 다르다.
//      · 경고 누적   = 카드 1장(세로 직사각형)
//      · 출장정지    = 카드 2장 겹침(누적 경고가 임계에 닿은 순간부터 같은 실루엣)
//      · 퇴장        = 카드 1장에 **대각선 컷**
//      · 체력        = 가로 막대
//      · 사기        = 삼각형(▲/▼)
//      · 교체 아웃   = 빈 원(링)
//    수치를 항상 옆에 적어 색을 못 읽어도 값이 전달된다.
//
// ── 2-1. 왜 누적 경고를 빨강으로 올리지 않는가 ──────────────────
// 예전에는 임계 도달(2장) 시 톤을 danger로 올렸다. 그래서 **빨간 카드 모양 칩에 숫자 2**가
// 찍혔고, 사용자가 실제로 물었다: "이게 지금 퇴장 표시인 거야?" (2026-08-01 제보)
// aria-label에는 "누적 경고 2장 · 다음 경기 출장정지 확정"이 이미 들어 있었으니, 문제는
// 정보가 아니라 **그림이 축구의 색 문법을 어겼다**는 것이다. 축구에서 노랑은 경고,
// 빨강은 퇴장·결장이다. 그래서 **카드 계열 안에서** 규칙을 하나로 못박는다:
//   · 노란 카드 = 경고가 쌓였다(아직 뛴다)   · 빨간 카드 = 이 선수는 뛰지 않는다(퇴장·정지)
// (체력 막대의 빨강은 카드가 아니므로 이 규칙과 충돌하지 않는다 — 실루엣이 다르다.)
// 임계 도달의 무게는 색이 아니라 **실루엣**이 진다 — 카드가 두 장이 되고, 그 두 장은
// 다음 경기에 '정지' 칩으로 그대로 이어진다(같은 도형 = 같은 결과).
// 3. **최대 3개.** 정지자에게는 다른 칩을 붙이지 않는다 — 뛰지 않는 선수의 체력·사기는
//    잡음이다. 그래서 실제로 겹치는 최대치는 카드+체력+사기 = 3개이고, 390px에서도
//    한 줄에 들어간다.
// 4. 이모지 금지(프로젝트 컨벤션 — 10px에서 OS마다 크기가 튄다). 도형은 CSS로 그린다.
import './StatusChips.css'

/** 체력 임계 — PlayerCard.conditionTone·LineupScreen.staminaTone과 같은 눈금이다.
 *  세 곳이 갈리면 같은 선수가 화면마다 다른 색으로 보인다. 바꿀 땐 셋을 함께 바꿔라. */
const FIT_WARN = 70
const FIT_LOW = 40
/** 사기 밴드 — 이 밖으로 나갈 때만 표시한다. 기준선은 70(엔진 초기값). */
const MOOD_LOW = 55
const MOOD_HIGH = 85

/** 'mute'는 상태가 아니라 **자격 소멸**을 말한다 — 잘못한 것이 없으므로 경고색을 쓰지 않는다. */
export type ChipTone = 'warn' | 'danger' | 'good' | 'mute'
/**
 * 'out'(원)은 카드(직사각)·체력(막대)·사기(삼각) 어느 것과도 겹치지 않는 네 번째 실루엣이다.
 * 'card-stack'(카드 2장)·'card-slash'(대각선 컷 카드)는 카드 계열 안에서 **결과가 다른 셋**을
 * 갈라 놓는다: 경고 누적(card) / 결장 확정·정지(card-stack) / 이번 경기 퇴장(card-slash).
 */
export type ChipShape = 'card' | 'card-stack' | 'card-slash' | 'bar' | 'tri-up' | 'tri-down' | 'out'

export interface StatusChip {
  /** React key·테스트 훅. */
  kind: 'susp' | 'sent' | 'caution' | 'fit' | 'mood' | 'out'
  shape: ChipShape
  tone: ChipTone
  /** 칩에 찍히는 짧은 글자(숫자 또는 2글자). 빈 문자열이면 도형만. */
  text: string
  /** 스크린리더·툴팁용 완전한 문장. */
  label: string
}

export interface StatusInput {
  /** 이 경기에서 이미 교체로 나갔다(IFAB 제3조 — 재출전 불가). 참이면 다른 칩을 만들지 않는다. */
  subbedOff?: boolean
  /** 이번 경기 출장정지(캠페인 징계). 참이면 다른 칩을 만들지 않는다. */
  suspended?: boolean
  /** 대회 미소멸 누적 경고 장수(이번 경기 이전까지). */
  cautions?: number
  /** 이번 경기에서 받은 경고 장수. */
  matchYellows?: number
  /** 이번 경기 퇴장. */
  sentOff?: boolean
  /** 체력 0~100. */
  stamina?: number
  /** 사기 0~100. */
  morale?: number
}

/** 경고 누적 임계 — campaignStore.CAUTION_THRESHOLD와 같은 수여야 한다.
 *  UI가 store를 import하면 순환·테스트 부담이 생겨 상수만 복제하고 여기 적어 둔다. */
const CAUTION_THRESHOLD = 2

/**
 * 선수 상태 → 표시할 칩 목록(순수). 정렬은 **심각도 순**이다 —
 * 징계(다음 경기를 못 뛴다) → 카드(다음 경기를 못 뛸 수 있다) → 체력 → 사기.
 * 잘리는 상황에서 먼저 잘려도 되는 것을 뒤에 둔다.
 */
export function statusChips(input: StatusInput): StatusChip[] {
  const { subbedOff, suspended, sentOff, stamina, morale } = input
  const cautions = input.cautions ?? 0
  const matchYellows = input.matchYellows ?? 0

  // 교체 아웃도 단독 표시다. 다시 못 들어오는 선수의 체력·사기는 잡음이고,
  // 정지와 같은 이유로 "왜 선택이 막혔는가"만 남긴다. 정지보다 먼저 판정하는 이유:
  // 이 경기에 뛴 선수는 애초에 이 경기 정지 대상이 아니므로 둘이 겹칠 일이 없고,
  // 겹친다면 그건 이번 경기의 사실(교체 아웃)이 더 구체적이다.
  if (subbedOff) {
    return [{
      kind: 'out', shape: 'out', tone: 'mute', text: '아웃',
      label: '교체 아웃 — 이 경기에 다시 출전할 수 없습니다(IFAB 제3조)',
    }]
  }

  // 출장정지는 단독 표시. 뛰지 않는 선수의 컨디션은 판단 재료가 아니다.
  if (suspended) {
    return [{ kind: 'susp', shape: 'card-stack', tone: 'danger', text: '정지', label: '출장정지 — 이번 경기 출전 불가' }]
  }

  const chips: StatusChip[] = []

  if (sentOff) {
    // 대각선 컷 = "이 선수는 지금 경기에서 지워졌다". 숫자 칩과 실루엣부터 다르므로
    // 색을 못 읽어도(그리고 색을 읽어도) 누적 경고와 헷갈리지 않는다.
    chips.push({ kind: 'sent', shape: 'card-slash', tone: 'danger', text: '퇴장', label: '퇴장 — 이번 경기에서 제외 · 다음 경기 출장정지' })
  } else {
    const total = cautions + matchYellows
    if (total > 0) {
      // 임계에 도달하면 다음 경기 결장이 **확정**이다. 그 무게는 색이 아니라 실루엣이 진다
      // (카드 2장 = 정지 칩과 같은 도형). 톤은 언제나 warn — 상단 주석 2-1 참조.
      const reached = total >= CAUTION_THRESHOLD
      const parts = [`누적 경고 ${total}장`]
      if (matchYellows > 0) parts.push(`이 경기 ${matchYellows}장`)
      parts.push(reached ? '다음 경기 출장정지 확정' : `${CAUTION_THRESHOLD - total}장 더 받으면 다음 경기 결장`)
      chips.push({
        kind: 'caution',
        shape: reached ? 'card-stack' : 'card',
        tone: 'warn',
        text: String(total),
        label: parts.join(' · '),
      })
    }
  }

  if (stamina != null && stamina < FIT_WARN) {
    const pct = Math.round(stamina)
    chips.push({
      kind: 'fit', shape: 'bar', tone: pct < FIT_LOW ? 'danger' : 'warn',
      text: String(pct), label: `체력 ${pct}% — ${pct < FIT_LOW ? '한계' : '저하'}`,
    })
  }

  if (morale != null && (morale < MOOD_LOW || morale >= MOOD_HIGH)) {
    const pct = Math.round(morale)
    const up = pct >= MOOD_HIGH
    chips.push({
      kind: 'mood', shape: up ? 'tri-up' : 'tri-down', tone: up ? 'good' : 'warn',
      text: String(pct), label: `사기 ${pct}% — ${up ? '고조' : '침체'}`,
    })
  }

  return chips
}

/** 상태 칩 줄. 표시할 것이 없으면 아무것도 렌더하지 않는다(빈 요소도 남기지 않는다 —
 *  그리드 행에 투명 상자가 남으면 정렬이 어긋난다). */
export function StatusChips({ input, className }: { input: StatusInput; className?: string }) {
  const chips = statusChips(input)
  if (chips.length === 0) return null
  return (
    <span className={`sx${className ? ` ${className}` : ''}`}>
      {chips.map(c => (
        <span
          key={c.kind}
          className={`sx__chip sx__chip--${c.shape} sx__chip--${c.tone}`}
          data-kind={c.kind}
          role="img"
          aria-label={c.label}
          title={c.label}
        >
          <span className="sx__mark" aria-hidden="true" />
          {c.text && <span className="sx__text num">{c.text}</span>}
        </span>
      ))}
    </span>
  )
}
