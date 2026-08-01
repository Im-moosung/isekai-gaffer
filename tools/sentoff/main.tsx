// 8라운드 ① 증거 하니스 — **개발 전용**(프로덕션 번들에 없다).
// "퇴장이 작전판에 반영되는가"를 세 렌더러에서 같은 state로 나란히 확인한다.
// 시드 52는 어웨이가 40분·68분에 레드카드를 받는 실제 경기다(전수 탐색).
import { createRoot } from 'react-dom/client'
import { makeTestTeam } from '../../src/engine/fixtures/testTeams'
import { createMatch, simulateSegment } from '../../src/engine/simulate'
import { PitchView } from '../../src/ui/pitch/PitchView'
import { PixiPitch } from '../../src/ui/pitch/pixi/PixiPitch'
import { Match3D } from '../../src/ui/pitch/three/Match3D'
import { onPitchMask } from '../../src/ui/pitch/cast'
import { buildSequence } from '../../src/ui/pitch/choreography'
import { computeFrame } from '../../src/ui/pitch/three/movement'

const params = new URLSearchParams(location.search)
const minute = Number(params.get('minute') ?? 41)
const renderer = params.get('r') ?? 'svg'

const state = simulateSegment(
  createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 52 }),
  minute,
)

// 세 렌더러 모두 **움직이는** 상태로 둔다 — 정지 화면은 픽셀 diff로 프레임 진행을
// 증명할 수 없고, 증명 못 한 캡처는 이 프로젝트가 두 번 당한 함정이다.
const ev = { minute, type: 'goal' as const, teamId: state.away.team.id }
const seq = buildSequence(ev, state.home, state.away)
const DWELL = 3000

const reds = state.events.filter(e => e.type === 'red').map(e => `${e.minute}'`)
const onHome = onPitchMask(state.home).filter(Boolean).length
const onAway = onPitchMask(state.away).filter(Boolean).length

;(window as unknown as Record<string, unknown>).__probe = {
  minute, renderer, reds,
  homeSentOff: state.home.sentOff,
  awaySentOff: state.away.sentOff,
  expected: { home: onHome, away: onAway, total: onHome + onAway },
  // 3D는 방송 카메라라 한 프레임에 22명이 다 안 잡힌다 — 실제로 그려지는 배역 수는
  // computeFrame이 정본이다(Match3D는 프레임에 없는 리그를 숨긴다: Match3D.tsx:549).
  framePlayers: computeFrame({
    state, minute, t: 0.5, prev: null, dt: 0.016, sequence: null, sequenceSide: 'away', seed: state.seed,
  }).players.length,
}

function View() {
  const board = renderer === '3d'
    ? <Match3D state={state} lastEvent={ev} event={ev} sequence={seq} dwellMs={DWELL} sequenceSide="away" />
    : renderer === 'pixi'
      ? <PixiPitch state={state} lastEvent={ev} sequence={seq} dwellMs={DWELL} sequenceSide="away" />
      : <PitchView state={state} variant="broadcast" analysis sequence={seq} dwellMs={DWELL} sequenceSide="away" />
  return (
    <>
      {board}
      <div id="hud">
        <div>렌더러 <b>{renderer}</b> · {minute}분 · 레드카드 {reds.join(' ') || '없음'}</div>
        <div>피치 위 인원 — 홈 <b>{onHome}</b> · 어웨이 <b>{onAway}</b> (합 <b>{onHome + onAway}</b>)</div>
        <div>어웨이 퇴장: {state.away.sentOff.join(', ') || '없음'}</div>
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<View />)
