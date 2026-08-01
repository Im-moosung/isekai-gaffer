import { useState, type ReactNode } from 'react'
import type { Instructions } from '../../engine/types'
import { interventionLevel, useMatchStore } from '../../game/matchStore'
import { ConsolePanel } from '../console/ConsolePanel'
import { TacticsExtras } from './TacticsExtras'
import './tactics.css'

/** 전술 작업대의 서브탭. 묶음은 사용자가 정했다(2026-08-01):
 *   지시   — 라인·압박·템포 슬라이더 + 공격방향 + [지시 적용]
 *   태세   — 멘탈리티 · 그룹 적극성 · 공격 패턴 · GK 파워플레이
 *   세트피스·대형 — 세트피스 3축(판별자 포함) + 페이즈 포메이션
 *
 *  ★ 왜 세 번째 탭 이름에 "대형"을 붙였는가: 사용자 묶음은 세트피스 옆에 페이즈
 *    포메이션을 두었다. 그런데 경기 중에는 대형만 잠긴다(b303d92). 탭 이름이
 *    "세트피스"뿐이면 그 안의 잠긴 축이 예고 없이 나타나 **탭 전체가 죽은 것으로**
 *    읽힌다. 이름에 대형을 적고 탭 위에 "대형 잠김"을 붙이면 열기 전에 무엇이
 *    잠겼는지 알 수 있다 — 묶음은 그대로 두고 라벨만 정확하게 한 것이다. */
export type TacticsSubtab = 'orders' | 'stance' | 'setpiece'

const SUBTABS: { id: TacticsSubtab; label: string }[] = [
  { id: 'orders', label: '지시' },
  { id: 'stance', label: '태세' },
  { id: 'setpiece', label: '세트피스·대형' },
]

/** 전술 작업대 — 작전판(경기 중)과 전술 센터(킥오프 전)가 **같은 컴포넌트**를 쓴다.
 *  두 화면의 조작법이 갈리면 유저가 같은 일을 두 번 배워야 한다.
 *
 *  ★ 왜 비활성 패널을 언마운트하지 않고 `hidden`으로 감추는가:
 *  ConsolePanel은 경기 중 로컬 draft(슬라이더 값)를 들고 있고 그 draft는 [지시 적용]
 *  전까지 엔진에 없다. 언마운트하면 탭을 옮겼다 돌아왔을 때 만지던 값이 사라진다 —
 *  "슬라이더를 만지다 세트피스를 확인하고 돌아오는" 것은 이 화면의 정상 동선이다.
 *  `hidden`은 접근성 트리에서도 빠지므로 스크린리더·탭 이동이 숨은 컨트롤에 닿지 않는다
 *  (display:none 대신 CSS 클래스로 감추면 그 성질이 깨진다).
 *
 *  ★ 미적용 변경 표시: 탭으로 나누면 다른 탭의 변경이 눈에서 사라진다. 다만 이 화면에서
 *  **미적용 상태가 생길 수 있는 곳은 지시 탭 하나뿐**이다 — 태세·세트피스·대형은 버튼을
 *  누르는 즉시 submitCommand로 엔진에 반영된다(TacticsExtras.patch). 그래서 점을 세 탭에
 *  다는 대신 지시 탭에만 "미적용" 평문 배지를 달고, 다른 탭에 있을 때는 그 사실을 한 줄로
 *  말한다. 이모지를 아이콘으로 쓰지 않는다는 규칙에 따라 색점이 아니라 글자로 말한다. */
export function TacticsWorkbench({ side, idPrefix, onPreview }: {
  side: 'home' | 'away'
  /** DOM id 접두사 — 한 문서에 두 작업대가 동시에 뜨지 않지만 id는 전역이다. */
  idPrefix: string
  /** 편집 중인 지시 draft를 상위로 흘린다(작전판 보드 미리보기). */
  onPreview?: (draft: Instructions | null) => void
}) {
  const phase = useMatchStore(s => s.phase)
  const pauseReason = useMatchStore(s => s.pauseReason)
  const engine = useMatchStore(s => s.engine)
  const [sub, setSub] = useState<TacticsSubtab>('orders')
  // ConsolePanel의 draft 사본 — 미적용 여부 판정에만 쓴다(반영은 ConsolePanel이 한다).
  const [draft, setDraft] = useState<Instructions | null>(null)

  const full = interventionLevel(phase, pauseReason) === 'full'
  const current = engine?.[side].tactics.instructions
  const dirty = !!draft && !!current && (
    draft.lineHeight !== current.lineHeight || draft.pressing !== current.pressing
    || draft.tempo !== current.tempo || draft.attackFocus !== current.attackFocus
  )

  const handlePreview = (d: Instructions | null) => {
    setDraft(d)
    onPreview?.(d)
  }

  const panel = (id: TacticsSubtab, body: ReactNode) => (
    <div
      className="tw-panel"
      role="tabpanel"
      id={`${idPrefix}-sub-${id}`}
      aria-labelledby={`${idPrefix}-subtab-${id}`}
      hidden={sub !== id}
    >
      {body}
    </div>
  )

  return (
    <div className="tw">
      <div className="tw-tabs" role="tablist" aria-label="전술 작업 묶음">
        {SUBTABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idPrefix}-subtab-${t.id}`}
            aria-controls={`${idPrefix}-sub-${t.id}`}
            aria-selected={sub === t.id}
            className={`tw-tab${sub === t.id ? ' tw-tab--active' : ''}`}
            onClick={() => setSub(t.id)}
          >
            {t.label}
            {t.id === 'orders' && dirty && <span className="tw-tab__mark">미적용</span>}
            {/* 잠금은 열기 전에 말한다 — 이 프로젝트의 규칙은 "막히면 이유를 말한다"다. */}
            {t.id === 'setpiece' && !full && <span className="tw-tab__lock">대형 잠김</span>}
          </button>
        ))}
      </div>

      {/* 다른 탭에 있을 때만 알린다. 지시 탭에서는 [지시 적용] 버튼 자체가 그 사실을 말한다. */}
      {dirty && sub !== 'orders' && (
        <p className="tw-dirty" role="status">
          지시 탭에 아직 적용하지 않은 변경이 있습니다 — 태세·세트피스는 누르는 즉시
          반영되지만 지시 4축은 [지시 적용]을 눌러야 전달됩니다.
        </p>
      )}

      {panel('orders', <ConsolePanel side={side} onPreview={handlePreview} />)}
      {panel('stance', <TacticsExtras side={side} part="stance" />)}
      {panel('setpiece', <TacticsExtras side={side} part="setpiece" />)}
    </div>
  )
}
