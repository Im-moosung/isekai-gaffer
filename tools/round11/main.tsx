// 11라운드 증거 하니스 — **개발 전용**. 프로덕션 번들에 포함되지 않는다.
// 세트피스(코너) 장면을 생산 경로(buildSequence)로 뽑아 Match3D에 그대로 먹인다.
// 루트·박스 인원을 URL로 바꿀 수 있어야 "유저 선택이 화면에 보이는가"를 캡처로 증명할 수 있다.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { makeTestTeam } from '../../src/engine/fixtures/testTeams'
import { createMatch } from '../../src/engine/simulate'
import { buildSequence, sceneKeyFor } from '../../src/ui/pitch/choreography'
import { Match3D } from '../../src/ui/pitch/three/Match3D'
import type { BoxLoad, MatchEvent, MatchEventType, SetPieceRoute } from '../../src/engine/types'

const params = new URLSearchParams(location.search)
const route = (params.get('route') ?? 'far') as SetPieceRoute
const boxLoad = (params.get('load') ?? 'normal') as BoxLoad
const type = (params.get('type') ?? 'goal') as MatchEventType
const DWELL = Number(params.get('dwell') ?? 36000)
/** 레인(코너 좌/우)을 고정하고 싶을 때. 지정하면 그 레인이 나오는 분을 찾는다. */
const wantLane = params.get('lane')

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const state = createMatch(home, away, { seed: 42 })
state.home.tactics.setPiece = { route, boxLoad }
const scorer = state.home.tactics.lineup[9].playerId
const kicker = state.home.tactics.lineup[6].playerId

let ev: MatchEvent | null = null
let key = ''
for (let minute = 1; minute <= 5000 && !ev; minute++) {
  const cand: MatchEvent = {
    minute, type, teamId: type === 'save' ? away.id : home.id, playerId: scorer,
    assistId: kicker, ...(type === 'corner' ? {} : { detail: 'setpiece' }),
  }
  const k = sceneKeyFor(cand, state.home, state.away) ?? ''
  if (!wantLane || k.includes(`/L${wantLane}`)) { ev = cand; key = k }
}
if (!ev) throw new Error(`세트피스 장면(${route}/${boxLoad}/${type})을 못 찾았다`)
const seq = buildSequence(ev, state.home, state.away)

// 캡처 스크립트가 읽는 계약.
;(window as unknown as Record<string, unknown>).__probe = {
  key, route, boxLoad, type,
  minute: ev.minute,
  dwellMs: DWELL,
  scorer,
  moverCount: seq[0].movers.length,
  steps: seq.map(s => ({ t: s.t, carrier: s.carrier ?? null, ball: s.ball, movers: s.movers })),
}

/** three 초기화 지연이 벽시계와 클럭을 어긋내지 않도록, 캡처가 부를 때만 시퀀스를 꽂는다. */
function Probe() {
  const [started, setStarted] = useState(false)
  ;(window as unknown as Record<string, unknown>).__start = () => setStarted(true)
  return (
    <Match3D
      state={state}
      lastEvent={ev!}
      event={started ? ev! : null}
      sequence={started ? seq : undefined}
      dwellMs={DWELL}
      sequenceSide={type === 'save' ? 'home' : 'home'}
    />
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
