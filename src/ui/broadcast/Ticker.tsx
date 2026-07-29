import './broadcast.css'

/** 티커 한 줄. minute은 **UI 타임스탬프 컬럼**으로 표시한다 —
 *  Phase C에서 분 접두를 문장에서 걷어내고 크롬으로 옮겼다(리서치 §4.1 #1). */
export interface TickerLine {
  minute: number
  text: string
}

interface TickerProps {
  lines: readonly TickerLine[]
  /** 위험 순간 강조(비네팅 연동) — 티커 테두리·글자를 강조 톤으로. */
  emphasis?: boolean
}

/** 방송 티커 — 하단 얇은 바. 마지막 해설 1줄 표시, 이전 줄은 페이드. */
export function Ticker({ lines, emphasis }: TickerProps) {
  const last = lines[lines.length - 1]
  const prev = lines.length > 1 ? lines[lines.length - 2] : undefined
  return (
    <div className={`bc-ticker${emphasis ? ' bc-ticker--danger' : ''}`} role="log" aria-live="polite" aria-label="해설">
      <span className="bc-ticker__tag" aria-hidden="true">중계</span>
      <div className="bc-ticker__stack">
        {prev !== undefined && (
          <span key={`${lines.length}-prev`} className="bc-ticker__line bc-ticker__line--prev">
            <span className="bc-ticker__min">{prev.minute}&apos;</span>
            {prev.text}
          </span>
        )}
        {last !== undefined && (
          <span key={`${lines.length}-last`} className="bc-ticker__line bc-ticker__line--current">
            <span className="bc-ticker__min">{last.minute}&apos;</span>
            {last.text}
          </span>
        )}
      </div>
    </div>
  )
}
