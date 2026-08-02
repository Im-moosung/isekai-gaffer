// src/ui/press/NewspaperCard.tsx
// 신문 1면 카드. 제호 "일간 축구" + 가상 날짜(고정) + 대형 세리프 헤드라인 +
// 부제 + 어록 인용 박스 + 스코어박스 + "대체역사 FICTION" 대각선 워터마크.
// [이미지 저장]은 canvas 2D 직접 드로잉으로 1080×1350 PNG를 만들어 다운로드한다
// (외부 라이브러리 금지, 시스템 폰트). 저장 로직은 renderNewspaperPng로 분리해
// jsdom(canvas 미지원) 테스트에서 스킵하고 브라우저 E2E에서 검증한다.
import { useCallback, useState } from 'react'
import type { Headline } from '../../game/pressconf'
import type { MatchRecord } from '../../game/campaignStore'
import { teamNameShortKo } from '../../data/loader'
import '../shell/shell.css'
import './press.css'

// 가상 발행일 — 실제 날짜(Date) 사용 금지, 대체역사 톤을 위해 고정.
const FAKE_DATE = '2026년 여름'
// 제호는 게임 제목과 일부러 다르다 — 밈 톤 제목은 바깥에서만 쓰고,
// 신문 1면은 방송·저널 톤을 유지해야 헤드라인이 진짜처럼 읽힌다.
// 실존 매체명을 피하려고 일반명사 조합("일간 축구")을 골랐다.
const MASTHEAD = '일간 축구'
const WATERMARK = '대체역사 FICTION'

// 상대 표기 — 스코어박스는 **폭이 고정된 칸**이라 짧은 표기를 쓴다(teamNameShortKo).
// 헤드라인·부제 본문은 pressconf가 정본(teamNameKo)으로 이미 지어 넣었으므로,
// 한 카드 안에서 본문은 '남아프리카공화국', 스코어박스는 '남아공'이 된다 —
// 실제 스포츠 지면의 관행(본문 정식명 · 스코어보드 약칭)과 같고, 의도된 차이다.
// 두 표기의 정본은 둘 다 src/data/loader.ts 한 곳에 있다.

interface Props {
  headline: Headline
  record: MatchRecord
  teamName: string
  /** 다음 단계(허브 복귀·랜딩 복귀)로 진행. 미지정 시 [다음] 버튼 숨김(단독 프리뷰 호환). */
  onNext?(): void
}

export function NewspaperCard({ headline, record, teamName, onNext }: Props) {
  const [busy, setBusy] = useState(false)
  // [다음] 1회 가드 — 2연타 시 onNext(→recordResult)가 중복 실행되어 스테이지를
  // 건너뛰거나 'ended' 상태 재호출로 throw 되는 것을 막는다(onSave busy 선례와 일관).
  const [advancing, setAdvancing] = useState(false)
  const onNextClick = useCallback(() => {
    if (advancing) return
    setAdvancing(true)
    onNext?.()
  }, [advancing, onNext])
  const opp = teamNameShortKo(record.opponentId)
  const [kor, og] = record.score
  const so = record.shootout ? `승부차기 ${record.shootout[0]}-${record.shootout[1]}` : null

  const onSave = useCallback(async () => {
    setBusy(true)
    try {
      const blob = await renderNewspaperPng(headline, record, teamName)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `daily-soccer-${record.stage}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setBusy(false)
    }
  }, [headline, record, teamName])

  return (
    <div className="np-wrap">
      <article className="np-card" aria-label="신문 1면">
        <header className="np-masthead">
          <h1 className="np-masthead__title">{MASTHEAD}</h1>
          <div className="np-masthead__meta">
            <span>{FAKE_DATE}</span>
            <span>스포츠 · 1면</span>
          </div>
        </header>

        <div className="np-rule" />

        <h2 className="np-headline">{headline.title}</h2>
        <p className="np-sub">{headline.sub}</p>

        <blockquote className="np-quote">{headline.quote}</blockquote>

        <div className="np-scorebox" aria-label="스코어">
          <span className="np-scorebox__team">{teamName}</span>
          <span className="np-scorebox__score num">{kor} - {og}</span>
          <span className="np-scorebox__team">{opp}</span>
          {so && <span className="np-scorebox__so num">{so}</span>}
        </div>

        {/* 사실 고지는 지면 밖 도장으로. 본문을 가로지르던 대각선 워터마크는
            헤드라인·인용문의 가독성을 깎았다. */}
        <span className="np-stamp">{WATERMARK}</span>
      </article>

      <div className="np-actions">
        {/* 우선순위: 진행 동작이 primary. [이미지 저장]은 부차 동작이다. */}
        {onNext && (
          <button type="button" className="btn btn--lg btn--primary" onClick={onNextClick} disabled={advancing}>
            다음
          </button>
        )}
        <button type="button" className="btn btn--lg btn--secondary" onClick={onSave} disabled={busy}>
          {busy ? '저장 중…' : '이미지 저장'}
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// renderNewspaperPng — canvas 2D 직접 드로잉(1080×1350). 외부 lib 없음.
// jsdom에서 getContext('2d')가 null → null 반환(테스트 스킵). 브라우저 E2E 검증.
// 색 리터럴이 남는 유일한 자리다: canvas 2D는 CSS 변수를 읽지 못한다.
// 값은 press.css의 .np-card 지역 변수(--np-paper/--np-ink/…)와 일치시켜 둔다.
// ═══════════════════════════════════════════════════════════
const PNG_W = 1080
const PNG_H = 1350

export function renderNewspaperPng(
  headline: Headline,
  record: MatchRecord,
  teamName: string,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = PNG_W
  canvas.height = PNG_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null) // jsdom 등 미지원 환경

  const opp = teamNameShortKo(record.opponentId)
  const [kor, og] = record.score
  const so = record.shootout ? `승부차기 ${record.shootout[0]}-${record.shootout[1]}` : null
  // 화면과 같은 명조 스택. 신문으로 읽히게 하는 것이 이 카드의 핵심이라
  // PNG도 같은 서체 우선순위를 따른다.
  const serif = '"Nanum Myeongjo", "Apple SD Gothic Neo", "Times New Roman", serif'
  const sans = '"Apple SD Gothic Neo", "Noto Sans KR", sans-serif'
  const PAD = 72

  // 배경(신문지 톤)
  ctx.fillStyle = '#f4f1e8'
  ctx.fillRect(0, 0, PNG_W, PNG_H)

  // 제호
  ctx.fillStyle = '#14110c'
  ctx.textAlign = 'center'
  ctx.font = `700 84px ${serif}`
  ctx.fillText(MASTHEAD, PNG_W / 2, 150)

  // 날짜 + FICTION 표기 라인
  ctx.font = `500 30px ${sans}`
  ctx.fillStyle = '#5a5346'
  ctx.textAlign = 'left'
  ctx.fillText(FAKE_DATE, PAD, 210)
  ctx.textAlign = 'right'
  ctx.fillText(WATERMARK, PNG_W - PAD, 210)

  // 굵은 룰 라인
  ctx.fillStyle = '#14110c'
  ctx.fillRect(PAD, 235, PNG_W - PAD * 2, 6)

  // 헤드라인(세리프, 자동 줄바꿈)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#14110c'
  let y = 360
  y = wrapText(ctx, headline.title, PAD, y, PNG_W - PAD * 2, `800 84px ${serif}`, 96)

  // 부제
  ctx.font = `500 38px ${sans}`
  ctx.fillStyle = '#3a352c'
  y += 24
  y = wrapText(ctx, headline.sub, PAD, y, PNG_W - PAD * 2, `500 38px ${sans}`, 50)

  // 인용 — 좌측 강조 바 대신 큰따옴표 글리프 + 들여쓰기(신문 관례).
  y += 60
  const quoteH = 200
  const quoteX = PAD + 96
  ctx.fillStyle = '#14110c'
  ctx.font = `800 140px ${serif}`
  ctx.fillText('“', PAD, y + 100)
  ctx.fillStyle = '#3a352c'
  wrapText(ctx, headline.quote, quoteX, y + 70, PNG_W - quoteX - PAD, `italic 500 40px ${serif}`, 52)

  // 스코어박스
  const boxY = y + quoteH + 80
  const boxH = 260
  ctx.fillStyle = '#14110c'
  ctx.fillRect(PAD, boxY, PNG_W - PAD * 2, boxH)
  ctx.fillStyle = '#f4f1e8'
  ctx.textAlign = 'center'
  ctx.font = `700 46px ${sans}`
  const cx = PNG_W / 2
  ctx.fillText(teamName, cx - 300, boxY + 130)
  ctx.fillText(opp, cx + 300, boxY + 130)
  ctx.font = `800 110px ${serif}`
  ctx.fillText(`${kor} - ${og}`, cx, boxY + 155)
  if (so) {
    ctx.font = `500 34px ${sans}`
    ctx.fillText(so, cx, boxY + 215)
  }

  // FICTION 도장 — 지면 하단 오른쪽. 본문을 가로지르던 대각선 워터마크는
  // 헤드라인·인용문 위에 겹쳐 가독성을 깎았다.
  ctx.save()
  ctx.translate(PNG_W - PAD - 130, PNG_H - PAD - 20)
  ctx.rotate(-Math.PI / 30) // -6°
  ctx.globalAlpha = 0.3
  ctx.strokeStyle = '#14110c'
  ctx.lineWidth = 4
  ctx.strokeRect(-150, -40, 300, 72)
  ctx.fillStyle = '#14110c'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 34px ${sans}`
  ctx.fillText(WATERMARK, 0, -2)
  ctx.restore()

  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), 'image/png')
  })
}

/** 캔버스 자동 줄바꿈. 그린 뒤 다음 baseline y를 반환. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  font: string,
  lineH: number,
): number {
  ctx.font = font
  const words = text.split(/(\s+)/) // 공백 보존 분할
  let line = ''
  let cursorY = y
  for (const w of words) {
    const test = line + w
    if (ctx.measureText(test).width > maxW && line.trim().length > 0) {
      ctx.fillText(line.trimEnd(), x, cursorY)
      line = w.trimStart()
      cursorY += lineH
    } else {
      line = test
    }
  }
  if (line.trim().length > 0) {
    ctx.fillText(line.trimEnd(), x, cursorY)
    cursorY += lineH
  }
  return cursorY
}
