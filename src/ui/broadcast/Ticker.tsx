import './broadcast.css'

/** 티커 한 줄. minute은 **UI 타임스탬프 컬럼**으로 표시한다 —
 *  Phase C에서 분 접두를 문장에서 걷어내고 크롬으로 옮겼다(리서치 §4.1 #1). */
export interface TickerLine {
  minute: number
  text: string
  /** 화자. 미지정은 캐스터(기존 호출부 호환). 해설위원 라인은 눈으로도 갈려야 한다 —
   *  소리로만 구분하면 음소거·해설 OFF 상태에서 두 사람이 한 사람으로 합쳐진다. */
  speaker?: 'caster' | 'analyst'
}

interface TickerProps {
  lines: readonly TickerLine[]
  /** 위험 순간 강조(비네팅 연동) — 티커 테두리·글자를 강조 톤으로. */
  emphasis?: boolean
}

/** 한 줄 렌더 — 분 타임스탬프 + (해설이면) 화자 배지 + 문장. */
function TickerRow({ line, variant }: { line: TickerLine; variant: 'prev' | 'current' }) {
  const analyst = line.speaker === 'analyst'
  return (
    <span
      className={`bc-ticker__line bc-ticker__line--${variant}${analyst ? ' bc-ticker__line--analyst' : ''}`}
    >
      <span className="bc-ticker__min">{line.minute}&apos;</span>
      {analyst && <span className="bc-ticker__who">해설</span>}
      {line.text}
    </span>
  )
}

/** 방송 티커 — 하단 액션 바 **안**에 들어가는 한 줄(별도 레이어로 띄우면 오버레이와
 *  겹쳐 텍스트가 쌓인다). 마지막 해설 1줄 표시, 이전 줄은 페이드.
 *  `중계` 배지는 중립색이다 — 빨강은 카드·실점 전용이라 상시 노출 배지에 쓸 수 없다. */
export function Ticker({ lines, emphasis }: TickerProps) {
  const last = lines[lines.length - 1]
  const prev = lines.length > 1 ? lines[lines.length - 2] : undefined
  return (
    <div className={`bc-ticker${emphasis ? ' bc-ticker--emphasis' : ''}`} role="log" aria-live="polite" aria-label="해설">
      <span className="badge bc-ticker__tag" aria-hidden="true">중계</span>
      <div className="bc-ticker__stack">
        {prev !== undefined && <TickerRow key={`${lines.length}-prev`} line={prev} variant="prev" />}
        {last !== undefined && <TickerRow key={`${lines.length}-last`} line={last} variant="current" />}
      </div>
    </div>
  )
}
