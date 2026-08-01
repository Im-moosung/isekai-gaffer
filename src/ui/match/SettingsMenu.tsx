// src/ui/match/SettingsMenu.tsx
// 경기 화면 설정 팝업 — **한 번 정하면 잘 안 바꾸는 것들**의 집.
//
// ── 왜 접는가 ───────────────────────────────────────────────────────
// 사용자 지적(2026-08-01): *"이 부분이 쓸데없이 영역 차지를 많이 해."* 제어 pod에
// [2D|3D] [1x|1.5x|2x] [음소거] [해설 끄기] [재생] [개입 3/5] [감독 타임] + 쿨다운
// 설명문 한 줄이 상시로 서 있었다. 여덟 개가 같은 무게로 서 있으면 위계가 없다.
//
// 접는 기준은 **바꾸는 빈도**다:
//  · 설정으로 내려간 것 — 2D/3D · 음소거 · 해설 음성. 셋 다 localStorage에 기억되고,
//    유저는 첫 경기에서 한 번 정한 뒤 다시 열지 않는다(그래서 기억하게 만든 것이다).
//  · 바에 남은 것 — 재생/일시정지 · 배속 · 개입 잔량 · 감독 타임. 전부 **이 경기의
//    지금 이 순간**에 쓰는 조작이다. 배속을 여기 넣지 않은 이유가 그것이다: 90분
//    재생에서 0-0 구간은 2x로 넘기고 80분 1골 차에서는 1x로 내리는 것이 이 게임의
//    관전 방식이고, 그 조작은 재생/일시정지와 같은 가족이다(영상 플레이어의 배속이
//    설정 메뉴가 아니라 컨트롤 바에 있는 것과 같은 이유).
//
// ── 이모지를 쓰지 않는다 ────────────────────────────────────────────
// 프로젝트 규칙. OS마다 모양·크기가 달라 톤이 무너진다(교체 카드에서 ⚽🟨를 걷어낸
// 것과 같은 판정). 톱니는 SVG로 직접 그린다.
//
// ── SVG 안에 포커스를 두지 않는다 ───────────────────────────────────
// 297e74b가 고친 지뢰: 전역 `:focus-visible { outline: 2px }`가 SVG 안에서는 사용자
// 단위로 해석돼 viewBox 배율만큼 부풀어 오른다. 그래서 포커스를 받는 것은 항상 바깥
// <button>(HTML)이고, 아이콘은 `aria-hidden` + `focusable="false"`로 접근성 트리와
// 탭 순서 양쪽에서 빠진다. 클릭도 버튼이 받아야 하므로 pointer-events는 CSS가 끈다.
import { useEffect, useId, useRef } from 'react'

/**
 * 톱니 아이콘. viewBox 24 기준으로 그리고 크기는 width/height가 정한다.
 * 획 굵기를 CSS px가 아니라 SVG 속성(stroke-width)으로 주는 것이 위 지뢰의 처방이다.
 *
 * ★ 실측 후 고쳤다(r10-hud-after-settings.png): 처음엔 작은 원 + 긴 방사 획이라
 *   16px에서 **해 모양**으로 읽혔다. 톱니는 "축(원) 바깥에 이가 붙은 링"이어야 하므로
 *   축을 키우고(r 2.6) 링을 넣고(r 7.2) 이를 링 바깥의 짧은 획으로 줄였다.
 */
function GearIcon() {
  return (
    <svg
      className="ms-gear"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="12" cy="12" r="7.2" />
      {/* 톱니 8개 — 링(r 7.2) 바깥으로 1.9만큼만 나온 짧은 이. 길면 해가 된다. */}
      <path d="M12 4.8V2.9M12 19.2v1.9M19.2 12h1.9M4.8 12H2.9M17.1 6.9l1.35-1.35M5.55 18.45 6.9 17.1M17.1 17.1l1.35 1.35M5.55 5.55 6.9 6.9" />
    </svg>
  )
}

export interface SettingsMenuProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** 2D/3D 세그먼트를 그릴지. 킥오프 전 워룸에서는 전환할 렌더러가 아직 없다. */
  showRenderer: boolean
  render3d: boolean
  onSelectRenderer(next: boolean): void
  muted: boolean
  onToggleMute(): void
  /** 해설 음성 토글을 그릴지. 킥오프 전에는 말할 해설이 없다. */
  showTts: boolean
  ttsOn: boolean
  onToggleTts(): void
}

/**
 * 톱니 버튼 + 그 아래 붙는 설정 시트.
 *
 * 접근성 계약(전부 테스트가 고정한다):
 *  · 버튼은 `aria-haspopup="dialog"` + `aria-expanded`. 열림 상태가 버튼 자신에 있다.
 *  · 시트는 `role="dialog"` + `aria-modal` + 이름. 열리면 첫 컨트롤로 포커스가 간다.
 *  · Esc로 닫히고 **포커스가 톱니로 돌아온다** — 돌아오지 않으면 키보드 사용자는
 *    문서 맨 앞으로 튕겨 나가 방금 무엇을 하고 있었는지 잃는다.
 *  · Tab이 시트 안에서 돈다(포커스 트랩). 트랩이 없으면 탭 한 번에 시트 뒤의 피치
 *    도트로 포커스가 새고, 화면상 시트는 열려 있는데 조작은 딴 데로 간다.
 *  · 바깥 클릭으로도 닫힌다(마우스 사용자의 Esc).
 */
export function SettingsMenu({
  open, onOpenChange, showRenderer, render3d, onSelectRenderer,
  muted, onToggleMute, showTts, ttsOn, onToggleTts,
}: SettingsMenuProps) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // 열릴 때 첫 컨트롤로 포커스. 닫힐 때는 톱니로 되돌린다.
  // ★ 되돌리기는 "열려 있었다가 닫혔을 때"만 해야 한다. 마운트 시점(open=false)에도
  //   돌리면 다른 곳을 조작하던 포커스를 이 컴포넌트가 빼앗는다.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      focusables(sheetRef.current)[0]?.focus()
      return
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      btnRef.current?.focus()
    }
  }, [open])

  // Esc + 포커스 트랩. keydown을 시트가 아니라 window에서 듣는 이유: 포커스가 어떤
  // 이유로든 시트 밖에 있어도 Esc가 살아 있어야 한다(닫을 방법이 사라지면 갇힌다).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onOpenChange(false); return }
      if (e.key !== 'Tab') return
      const items = focusables(sheetRef.current)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !sheetRef.current?.contains(active))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  // 바깥 클릭으로 닫기. pointerdown으로 듣는다 — click까지 기다리면 시트 뒤의 피치
  // 도트가 먼저 눌려 "닫으려 했는데 선수를 골랐다"가 된다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (sheetRef.current?.contains(t) || btnRef.current?.contains(t)) return
      onOpenChange(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open, onOpenChange])

  return (
    <div className="ms-set">
      <button
        ref={btnRef}
        type="button"
        className={`btn btn--secondary btn--sm ms-set__btn${open ? ' ms-set__btn--open' : ''}`}
        aria-label="설정"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <GearIcon />
      </button>

      {open && (
        <div
          ref={sheetRef}
          className="ms-set__sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <p id={titleId} className="eyebrow ms-set__title">화면 · 소리 설정</p>

          {showRenderer && (
            <div className="ms-set__row">
              <span className="ms-set__label">피치 렌더러</span>
              <div className="seg" role="group" aria-label="화면 렌더러">
                <button
                  type="button"
                  className="seg__item"
                  aria-pressed={!render3d}
                  onClick={() => onSelectRenderer(false)}
                >
                  2D
                </button>
                <button
                  type="button"
                  className="seg__item"
                  aria-pressed={render3d}
                  onClick={() => onSelectRenderer(true)}
                >
                  3D
                </button>
              </div>
            </div>
          )}

          {/* 음소거 토글 하나가 BGM·효과음·TTS를 전부 끊는다(sfx.setMuted 단일 계약).
              자리를 옮겨도 그 계약은 그대로다 — 여기서 소리 종류별로 쪼개면
              "다 껐는데 아직 뭔가 난다"가 생긴다. */}
          <div className="ms-set__row">
            <span className="ms-set__label">소리</span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-label={muted ? '소리 켜기' : '음소거'}
              aria-pressed={muted}
              onClick={onToggleMute}
            >
              {muted ? '소리 켜기' : '음소거'}
            </button>
          </div>

          {showTts && (
            <div className="ms-set__row">
              <span className="ms-set__label">해설 음성</span>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                aria-label={ttsOn ? '해설 음성 끄기' : '해설 음성 켜기'}
                aria-pressed={ttsOn}
                onClick={onToggleTts}
              >
                {ttsOn ? '해설 끄기' : '해설 켜기'}
              </button>
            </div>
          )}

          <p className="ms-set__note">여기서 정한 값은 다음 경기에도 그대로 적용됩니다.</p>
        </div>
      )}
    </div>
  )
}

/** 시트 안에서 탭이 닿는 요소들. disabled는 빼야 트랩이 빈 곳에서 멈추지 않는다. */
function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')]
    .filter(el => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1')
}
