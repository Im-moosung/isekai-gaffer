import { useState } from 'react'
// 예외 승인: App.tsx는 데모 픽스처 팀 생성을 위해 엔진 fixtures import 허용.
import { makeTestTeam } from './engine/fixtures/testTeams'
import { MatchScreen } from './ui/match/MatchScreen'
import './App.css'

// 데모 재현성을 위해 시드 고정 (Math.random·Date 미사용).
const DEMO_SEED = 20260724

function App() {
  const [started, setStarted] = useState(false)

  if (started) {
    return (
      <MatchScreen
        home={makeTestTeam('kor', 76)}
        away={makeTestTeam('esp', 88)}
        seed={DEMO_SEED}
      />
    )
  }

  return (
    <main className="landing">
      <div className="landing__card">
        <p className="landing__kicker">개발 빌드</p>
        <h1 className="landing__title">리매치: 코리아 2026 (개발 빌드)</h1>
        <p className="landing__sub">방송형 축구 감독 시뮬레이터 — Phase 2 경기 화면 데모</p>
        <button
          type="button"
          className="landing__cta"
          onClick={() => setStarted(true)}
        >
          데모 경기 시작
        </button>
      </div>
    </main>
  )
}

export default App
