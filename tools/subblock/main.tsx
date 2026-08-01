// 교체 차단 고지 캡처 하네스 — 실제 브라우저에서 "막힌 상태의 작전판 교체 탭"을 띄운다.
//
// 왜 하네스인가: 인원 5/5 소진 상태를 실플레이로 만들려면 세 번의 브레이크에 걸쳐
// 다섯 번을 교체해야 하고, 그 과정에서 시뮬 난수가 화면 상태를 흔든다. 여기서 보려는
// 것은 "막혔을 때 화면이 무엇을 말하는가" 하나뿐이므로 상태를 직접 세팅한다.
// 렌더되는 컴포넌트·스토어·CSS는 전부 프로덕션 그대로다(가짜 마크업 없음).
//
// URL 쿼리로 케이스를 고른다:
//   ?case=quota   교체 인원 5/5 소진 (기회는 2/3 남음 — 사용자가 지적한 그 화면)
//   ?case=window  교체 기회 3/3 소진
//   ?case=both    둘 다 소진
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { useMatchStore } from '../../src/game/matchStore'
import { TacticsBoard } from '../../src/ui/tactics/TacticsBoard'
import { loadTeam } from '../../src/data/loader'

const kase = new URLSearchParams(location.search).get('case') ?? 'quota'

const store = useMatchStore.getState()
store.startMatch(loadTeam('kor'), loadTeam('esp'), 42)
const eng = useMatchStore.getState().engine!
const patch =
  kase === 'window' ? { subsUsed: 2, subWindowsUsed: 3, lastSubMinute: 55 }
    : kase === 'both' ? { subsUsed: 5, subWindowsUsed: 3, lastSubMinute: 55 }
      : { subsUsed: 5, subWindowsUsed: 2, lastSubMinute: 55 }

useMatchStore.setState({
  phase: 'paused-break',
  pauseReason: { kind: 'hydration2' },
  engine: { ...eng, minute: 68, home: { ...eng.home, ...patch } },
})

createRoot(document.getElementById('root')!).render(<TacticsBoard />)
