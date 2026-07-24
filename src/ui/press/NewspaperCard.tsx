// src/ui/press/NewspaperCard.tsx
// 신문 1면 카드. 제호 "리매치 타임스" + 가상 날짜(고정) + 대형 세리프 헤드라인 +
// 부제 + 어록 인용 박스 + 스코어박스 + "대체역사 FICTION" 대각선 워터마크.
// [이미지 저장]은 canvas 2D 직접 드로잉으로 1080×1350 PNG를 만들어 다운로드한다
// (외부 라이브러리 금지, 시스템 폰트). 저장 로직은 renderNewspaperPng로 분리해
// jsdom(canvas 미지원) 테스트에서 스킵하고 브라우저 E2E에서 검증한다.
import { useCallback, useState } from 'react'
import type { Headline } from '../../game/pressconf'
import type { MatchRecord } from '../../game/campaignStore'
import './press.css'

// 가상 발행일 — 실제 날짜(Date) 사용 금지, 대체역사 톤을 위해 고정.
const FAKE_DATE = '2026년 여름'
const MASTHEAD = '리매치 타임스'
const WATERMARK = '대체역사 FICTION'

// 상대 한글 표기(계층 격리: 외부 로더 비의존). 미등록 id는 코드 그대로.
const OPPONENT_KO: Record<string, string> = {
  cze: '체코', mex: '멕시코', rsa: '남아공',
  ecu: '에콰도르', eng: '잉글랜드', nor: '노르웨이', arg: '아르헨티나', esp: '스페인',
  can: '캐나다', mar: '모로코', fra: '프랑스',
}
function oppName(id: string): string { return OPPONENT_KO[id] ?? id }

interface Props {
  headline: Headline
  record: MatchRecord
  teamName: string
  /** 다음 단계(허브 복귀·랜딩 복귀)로 진행. 미지정 시 [다음] 버튼 숨김(단독 프리뷰 호환). */
  onNext?(): void
}

export function NewspaperCard({ headline, record, teamName, onNext }: Props) {
  const [busy, setBusy] = useState(false)
  const opp = oppName(record.opponentId)
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
      a.download = `rematch-times-${record.stage}.png`
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
        <div className="np-watermark" aria-hidden>{WATERMARK}</div>

        <header className="np-masthead">
          <h1 className="np-masthead__title">{MASTHEAD}</h1>
          <div className="np-masthead__meta">
            <span>{FAKE_DATE}</span>
            <span className="np-masthead__fiction">{WATERMARK}</span>
          </div>
        </header>

        <div className="np-rule" />

        <h2 className="np-headline">{headline.title}</h2>
        <p className="np-sub">{headline.sub}</p>

        <blockquote className="np-quote">{headline.quote}</blockquote>

        <div className="np-scorebox" aria-label="스코어">
          <span className="np-scorebox__team">{teamName}</span>
          <span className="np-scorebox__score">{kor} - {og}</span>
          <span className="np-scorebox__team">{opp}</span>
          {so && <span className="np-scorebox__so">{so}</span>}
        </div>
      </article>

      <div className="np-actions">
        <button type="button" className="np-save" onClick={onSave} disabled={busy}>
          {busy ? '저장 중…' : '이미지 저장'}
        </button>
        {onNext && (
          <button type="button" className="np-next" onClick={onNext}>
            다음
          </button>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// renderNewspaperPng — canvas 2D 직접 드로잉(1080×1350). 외부 lib 없음.
// jsdom에서 getContext('2d')가 null → null 반환(테스트 스킵). 브라우저 E2E 검증.
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

  const opp = oppName(record.opponentId)
  const [kor, og] = record.score
  const so = record.shootout ? `승부차기 ${record.shootout[0]}-${record.shootout[1]}` : null
  const serif = 'Georgia, "Times New Roman", "Apple SD Gothic Neo", serif'
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

  // 인용 박스
  y += 60
  const quoteH = 200
  ctx.fillStyle = '#e9e4d6'
  ctx.fillRect(PAD, y, PNG_W - PAD * 2, quoteH)
  ctx.fillStyle = '#14110c'
  ctx.fillRect(PAD, y, 10, quoteH) // 왼쪽 강조 바
  ctx.fillStyle = '#2a251d'
  wrapText(ctx, headline.quote, PAD + 44, y + 70, PNG_W - PAD * 2 - 80, `italic 500 40px ${serif}`, 52)

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

  // 대각선 워터마크(반투명)
  ctx.save()
  ctx.translate(PNG_W / 2, PNG_H / 2)
  ctx.rotate(-Math.PI / 6)
  ctx.globalAlpha = 0.10
  ctx.fillStyle = '#b02a2a'
  ctx.textAlign = 'center'
  ctx.font = `800 130px ${sans}`
  ctx.fillText(WATERMARK, 0, 0)
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
