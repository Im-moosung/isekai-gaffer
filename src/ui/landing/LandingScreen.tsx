// src/ui/landing/LandingScreen.tsx
// 첫인상 화면 — 3D 스타디움 라이브 배경 위에 대체역사 훅 문안과 두 개의 진입 CTA.
//
// 순서 계약(심사자가 1분 안에 판단한다):
//  1. **문안·버튼이 먼저 뜬다.** 3D는 lazy 청크라 로드에 수백 ms가 걸리므로,
//     첫 페인트 이후(rAF 1틱 뒤)에야 마운트를 시작한다. 버튼 클릭은 3D와 무관하게 즉시 동작한다.
//  2. **3D 실패는 조용하다.** 청크 로드 실패는 BackdropBoundary가, WebGL 불가·컨텍스트 로스는
//     StadiumBackdrop 내부가 받아 null을 렌더한다 → CSS 그라디언트 배경만 남는다.
//  3. 모바일(좁은 뷰포트)에서는 3D를 아예 로드하지 않는다 — 근거는 shouldLoad3d 주석.
import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'

const StadiumBackdrop = lazy(() =>
  import('./StadiumBackdrop').then(m => ({ default: m.StadiumBackdrop })),
)

/**
 * 3D 배경 청크 로드가 실패하면 React.lazy가 렌더 중 에러를 throw한다.
 * 바운더리가 없으면 랜딩 전체가 백지가 되므로, 실패를 삼키고 null을 렌더한다
 * (= 정적 그라디언트 배경). MatchScreen의 PitchBoundary와 같은 패턴.
 */
class BackdropBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * 모바일에서 3D를 켤지 판단한다. **끈다** — 근거:
 *  - 390px 폭 세로 화면에서 스타디움 볼은 손톱만 하게 들어가 "3D의 증거"로 읽히지 않는다.
 *    반면 관중 인스턴싱 + 피치 텍스처 업로드 비용은 모바일 GPU에서 그대로 든다.
 *  - 첫인상 화면의 목적은 문안 전달이며, 좁은 화면일수록 텍스트가 화면을 다 차지한다.
 *  - 3D 자체는 경기 화면에서 전면 노출되므로 랜딩에서 포기해도 잃는 게 없다.
 * 데스크톱 창을 좁혀도 같은 규칙이 적용된다(mql change 구독).
 */
const NARROW_MQ = '(max-width: 720px)'

export function LandingScreen({ onCampaign, onDemo }: {
  onCampaign(): void
  onDemo(): void
}) {
  const [show3d, setShow3d] = useState(false)

  useEffect(() => {
    // jsdom(테스트)에는 matchMedia가 없다 — 판단할 수 없으면 3D를 켜지 않는다(안전측).
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_MQ) : null
    let raf = 0
    const sync = (): void => setShow3d(!!mql && !mql.matches)
    // 첫 페인트를 3D 청크 요청이 방해하지 않도록 rAF 한 틱 뒤에 마운트한다.
    raf = requestAnimationFrame(sync)
    mql?.addEventListener?.('change', sync)
    return () => {
      cancelAnimationFrame(raf)
      mql?.removeEventListener?.('change', sync)
    }
  }, [])

  return (
    <main className="landing">
      <div className="landing__bg">
        {show3d && (
          <BackdropBoundary>
            <Suspense fallback={null}>
              <StadiumBackdrop />
            </Suspense>
          </BackdropBoundary>
        )}
      </div>
      <div className="landing__scrim" aria-hidden="true" />

      <div className="landing__card">
        <p className="landing__kicker">대체역사 축구 감독 시뮬레이션</p>
        <h1 className="landing__title">리매치: 코리아 2026</h1>
        <p className="landing__lede">
          {/* 좁은 화면에서 "1 / 승 2패"처럼 숫자와 단위가 갈라지지 않게 묶는다. */}
          2026년 6월, 대한민국은 <span className="landing__nowrap">1승 2패</span>로 조별리그를 마쳤다.
          <br />
          당신에게 <span className="landing__nowrap">90분</span>과{' '}
          <span className="landing__nowrap">다섯 번의 개입</span>이 주어진다.
        </p>
        <div className="landing__actions">
          <button type="button" className="landing__cta" onClick={onCampaign}>
            캠페인 시작 <span aria-hidden="true">→</span>
          </button>
          <button type="button" className="landing__cta landing__cta--ghost" onClick={onDemo}>
            바로 지휘하기
          </button>
        </div>
        <p className="landing__foot">실제 대회 데이터 기반 · 12개국 312명 · 시드 재현 시뮬레이션</p>
      </div>
    </main>
  )
}
