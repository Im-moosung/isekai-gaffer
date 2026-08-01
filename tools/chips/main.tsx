// 8라운드 ② 증거 하니스 — 상태 칩의 **실루엣이 실제로 갈리는가**.
// 사용자가 물었다: "빨간 카드 칩에 2 — 이거 퇴장 표시야?" (2026-08-01)
import { Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { StatusChips, type StatusInput } from '../../src/ui/common/StatusChips'

const CASES: [string, StatusInput][] = [
  ['경고 1장(아직 여유)', { cautions: 1 }],
  ['경고 2장 = 다음 경기 결장 확정', { cautions: 1, matchYellows: 1 }],
  ['이번 경기 퇴장', { sentOff: true }],
  ['출장정지(이번 경기 못 뜀)', { suspended: true }],
  ['교체 아웃', { subbedOff: true }],
  ['체력 저하 + 사기 침체', { stamina: 33, morale: 40 }],
  ['사용자 캡처 재현 — 경고 2장 + 체력 66', { cautions: 2, stamina: 66 }],
]

function App() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '14px 24px', alignItems: 'center', width: 'fit-content' }}>
      {CASES.map(([label, input]) => (
        <Fragment key={label}>
          <div style={{ fontSize: 13, color: 'var(--t-mid)' }}>{label}</div>
          <StatusChips input={input} />
        </Fragment>
      ))}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
