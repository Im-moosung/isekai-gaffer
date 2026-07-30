import type { ReactNode } from 'react'
import './shell.css'

/** 3층 셸 — [sticky 상단 furniture] / [문서 스크롤 본문] / [sticky 하단 액션 바].
 *
 *  왜 컴포넌트로 묶는가: 화면마다 손으로 높이를 배분하다가 중첩 스크롤 5단이
 *  생겼다. 셸이 높이를 갖지 않고 본문이 자라게 두면 그 문제가 구조적으로 사라진다.
 *  상·하단만 sticky이고 중간은 자유롭게 자란다. */
export function AppShell({ top, bottom, width = 'content', flush, className, children }: {
  /** 상단 바 내용. 없으면 바 자체를 렌더하지 않는다(입장 연출처럼 크롬이 0인 화면). */
  top?: ReactNode
  /** 하단 액션 바 내용. 주 CTA는 화면당 하나만 여기 둔다. */
  bottom?: ReactNode
  /** content 1440 / wide 1760(워룸·경기처럼 밀도가 높은 화면) / read 780(읽기 전용) */
  width?: 'content' | 'wide' | 'read'
  /** 본문 패딩·gap 제거(캔버스를 풀블리드로 깔 때) */
  flush?: boolean
  className?: string
  children: ReactNode
}) {
  const bodyClass = [
    'shell__body',
    width === 'wide' ? 'shell__body--wide' : '',
    width === 'read' ? 'shell__body--read' : '',
    flush ? 'shell__body--flush' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className ? `shell ${className}` : 'shell'}>
      {top ? <header className="shell__top">{top}</header> : null}
      <main className={bodyClass}>{children}</main>
      {bottom ? <div className="shell__bottom">{bottom}</div> : null}
    </div>
  )
}
