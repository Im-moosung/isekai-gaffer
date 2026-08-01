// src/ui/landing/LandingScreen.tsx
// 첫인상 화면 — 3D 스타디움 라이브 배경 위에 대체역사 훅 문안과 두 개의 진입 CTA.
//
// [2026-07-30 재설계 · L-2/L-4] 유리 카드를 없애고 문안을 3D 위에 직접 얹는다.
// 방송 타이틀 시퀀스의 문법이고, 카드가 없어야 3D가 화면을 온전히 쓴다.
// 대비는 좌→우 선형 스크림(.landing__scrim)이 전담한다.
//
// 순서 계약(심사자가 1분 안에 판단한다):
//  1. **문안·버튼이 먼저 뜬다.** 3D는 lazy 청크라 로드에 수백 ms가 걸리므로,
//     첫 페인트 이후(rAF 1틱 뒤)에야 마운트를 시작한다. 버튼 클릭은 3D와 무관하게 즉시 동작한다.
//  2. **3D 실패는 조용하다.** 청크 로드 실패는 BackdropBoundary가, WebGL 불가·컨텍스트 로스는
//     StadiumBackdrop 내부가 받아 null을 렌더한다 → CSS 그라디언트 배경만 남는다.
//  3. 모바일(좁은 뷰포트)에서는 3D를 아예 로드하지 않는다 — 근거는 shouldLoad3d 주석.
import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react'
import * as bgm from '../../audio/bgm'
import * as sfx from '../../audio/sfx'
// 공통 프리미티브(.btn, .eyebrow)를 쓰므로 셸 스타일시트를 함께 싣는다.
import '../shell/shell.css'
import './landing.css'

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

/**
 * 소리 안내의 세 상태.
 *  - ask : 아직 오디오 컨텍스트가 없다 → "음악 켜기"와 그 이유를 말한다.
 *  - on  : 방금 열렸다 → 2.6초 동안 "재생됩니다"만 말하고 사라진다.
 *  - gone: 아무것도 그리지 않는다(이미 열려 있거나, 유저가 음소거를 골라 뒀거나, 다 말했거나).
 */
type SoundCue = 'ask' | 'on' | 'gone'

/** 켜졌다는 안내를 남겨 두는 시간(ms). landing.css의 페이드아웃 길이와 같은 값이다. */
const CUE_HOLD_MS = 2600

export function LandingScreen({ onCampaign, onDemo }: {
  onCampaign(): void
  onDemo(): void
}) {
  const [show3d, setShow3d] = useState(false)

  // 랜딩 테마 M01. ★ **첫 방문에는 울리지 않는다** — 자동재생 정책상 오디오 컨텍스트는
  // 유저 제스처 뒤에만 열리고(sfx.init), 랜딩은 그 제스처보다 앞이다. 여기서는 "이 화면의
  // 음악은 M01"이라고 선언만 하고, 컨텍스트가 열려 있을 때(= 캠페인을 마치고 돌아온 랜딩)만
  // 실제로 소리가 난다. 첫 클릭 전에 강제로 틀면 브라우저가 막고 콘솔 경고가 남는다.
  //
  // ★ 그 "첫 제스처"를 여기서 받아낸다(사용자 지적 2026-08-01: 첫인상 화면이 무음이다).
  //   bgm.setScene이 화면 아무 곳의 첫 클릭·키 입력에 sfx.init을 걸어 두므로 기능은 이미
  //   있었다. 없었던 것은 **그 사실을 아는 방법**이다 — 아래 안내가 그 자리를 맡는다.
  //   정책 우회(무음 오디오 선재생 따위)는 하지 않는다. 정책을 설명하고 제스처를 받는다.
  const [cue, setCue] = useState<SoundCue>(() => (
    // 이미 열려 있으면(캠페인 후 복귀) 말할 게 없고,
    // 유저가 음소거를 골라 뒀으면 그 선택을 존중해 아무 말도 하지 않는다.
    sfx.audioBus() || sfx.isMuted() ? 'gone' : 'ask'
  ))

  useEffect(() => { bgm.setScene('landing') }, [])

  // 안내 버튼이 아니라 **다른 곳**을 눌러 열렸을 때도 같은 확인을 준다(bgm의 전역 훅 경로).
  useEffect(() => {
    if (cue !== 'ask') return
    return sfx.onAudioUnlock(() => setCue('on'))
  }, [cue])

  useEffect(() => {
    if (cue !== 'on') return
    const t = setTimeout(() => setCue('gone'), CUE_HOLD_MS)
    return () => clearTimeout(t)
  }, [cue])

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

      <div className="landing__content">
        <p className="eyebrow landing__eyebrow">대체역사 축구 감독 시뮬레이션</p>
        {/* 제목은 두 절을 각각 한 줄로 고정한다. 뷰포트에 따라 "내가," 뒤에서
            끊기거나 "국대 / 감독?"으로 갈라지면 밈 문장의 리듬이 죽는다. */}
        <h1 className="landing__title">
          <span className="landing__title-line">현실에서 축덕인 내가,</span>
          <span className="landing__title-line">이세계에선 국대 감독?</span>
        </h1>
        <p className="landing__lede">
          {/* 좁은 화면에서 "1 / 승 2패"처럼 숫자와 단위가 갈라지지 않게 묶는다. */}
          2026년 6월, 대한민국은 <span className="landing__nowrap">1승 2패</span>로 조별리그를 마쳤다.
          <br />
          당신에게 <span className="landing__nowrap">90분</span>과{' '}
          <span className="landing__nowrap">다섯 번의 개입</span>이 주어진다.
        </p>
        {/* 주 CTA는 --brand 파랑. 라임은 --live("지금 진행 중") 전용으로 강등됐다. */}
        <div className="landing__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={onCampaign}>
            캠페인 시작 <span aria-hidden="true">→</span>
          </button>
          <button type="button" className="btn btn--ghost btn--lg" onClick={onDemo}>
            바로 지휘하기
          </button>
        </div>
        {/* 소리 안내 — CTA 바로 아래. 새 토글이 아니라 **한 번 쓰고 사라지는 안내**다.
            헤더의 기존 음소거 토글과 겹치지 않는다: 여기서는 끄지 못하고, 음소거 상태에서는
            뜨지도 않는다(= 유저가 명시적으로 고른 무음을 랜딩이 뒤집지 않는다). */}
        {cue === 'ask' && (
          <button type="button" className="landing__sound" onClick={() => sfx.init()}>
            <span className="landing__sound-icon" aria-hidden="true">♪</span>
            <span className="landing__sound-text">
              음악 켜기
              <span className="landing__sound-note">브라우저 정책상 첫 클릭 전에는 소리가 나지 않습니다</span>
            </span>
          </button>
        )}
        {cue === 'on' && (
          <p className="landing__sound landing__sound--on" role="status">
            <span className="landing__sound-icon" aria-hidden="true">♪</span>
            <span className="landing__sound-text">테마가 재생됩니다</span>
          </p>
        )}
        <p className="landing__foot">실제 대회 데이터 기반 · 12개국 312명 · 시드 재현 시뮬레이션</p>
        {/* 픽션 고지 — 기획서에 "서비스 내 명시"로 약속한 항목이다.
            실존 대회·선수를 다루는 이상 화면에 남아 있어야 한다(각주 톤, 삭제 금지). */}
        <p className="landing__disclaimer">※ 실제 2026 월드컵을 모티브로 한 대체역사 픽션입니다</p>
      </div>
    </main>
  )
}
