import './broadcast.css'

interface TickerProps {
  lines: string[]
}

/** 방송 티커 — 하단 얇은 바. 마지막 해설 1줄 표시, 이전 줄은 페이드. */
export function Ticker({ lines }: TickerProps) {
  const last = lines[lines.length - 1]
  const prev = lines.length > 1 ? lines[lines.length - 2] : undefined
  return (
    <div className="bc-ticker" role="log" aria-live="polite" aria-label="해설">
      <span className="bc-ticker__tag" aria-hidden="true">중계</span>
      <div className="bc-ticker__stack">
        {prev !== undefined && (
          <span key={`${lines.length}-prev`} className="bc-ticker__line bc-ticker__line--prev">
            {prev}
          </span>
        )}
        {last !== undefined && (
          <span key={`${lines.length}-last`} className="bc-ticker__line bc-ticker__line--current">
            {last}
          </span>
        )}
      </div>
    </div>
  )
}
