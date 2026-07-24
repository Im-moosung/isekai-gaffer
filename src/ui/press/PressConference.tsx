// src/ui/press/PressConference.tsx
// 경기 직후 기자회견 세그먼트. buildQuestions(정본 템플릿)로 3문항을 순차 진행하고,
// 완료 시 buildHeadline(템플릿)로 헤드라인을 만든 뒤 aiClient.narrate('headline')로
// 제목만 대체를 시도한다. 실패·지연은 UX를 막지 않는다.
//
// [지연 처리 선택] onDone(headline)은 단일 콜백이므로, 답변 완료 후 aiClient.narrate를
// await 한 뒤 결과를 반영해 한 번만 호출한다. aiClient는 이미 3초 하드 타임아웃(AbortController)을
// 내장하므로 최악의 경우에도 3초 뒤 반드시 템플릿으로 진행한다 — "3s 대기 후 진행" 방식.
// 대기 동안에는 "발표 준비 중" 상태를 표시해 화면이 멈춘 것처럼 보이지 않게 한다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildQuestions, buildHeadline } from '../../game/pressconf'
import type { Headline } from '../../game/pressconf'
import type { MatchRecord } from '../../game/campaignStore'
import type { DecisionEntry } from '../../engine/types'
import { narrate } from '../../ai/aiClient'
import './press.css'

interface Props {
  record: MatchRecord
  log: DecisionEntry[]
  teamName: string
  onDone(headline: Headline): void
}

const TONE_LABEL = ['공격적', '겸손', '유머'] as const

export function PressConference({ record, log, teamName, onDone }: Props) {
  const questions = useMemo(() => buildQuestions(record, log), [record, log])
  // 확정된 문답 스택(위로 쌓임) + 현재 인덱스.
  const [answers, setAnswers] = useState<string[]>([])
  const [finishing, setFinishing] = useState(false)
  const doneRef = useRef(false)

  const idx = answers.length
  const current = questions[idx]

  function pick(option: string) {
    if (finishing || idx >= questions.length) return
    setAnswers(prev => [...prev, option])
  }

  // 3문항 완료 → 헤드라인 확정(템플릿 → AI 제목 대체 시도) → onDone.
  useEffect(() => {
    if (answers.length < questions.length || doneRef.current) return
    doneRef.current = true
    setFinishing(true)
    const template = buildHeadline(record, answers, teamName)
    const context = {
      teamName,
      opponentId: record.opponentId,
      stage: record.stage,
      score: record.score,
      shootout: record.shootout ?? null,
      answers,
    }
    let cancelled = false
    // narrate는 내부 3s 타임아웃으로 반드시 종결된다.
    narrate('headline', context)
      .then(ai => {
        if (cancelled) return
        const title = ai && ai.trim().length > 0 ? ai.trim() : template.title
        onDone({ ...template, title })
      })
      .catch(() => { if (!cancelled) onDone(template) })
    return () => { cancelled = true }
  }, [answers, questions.length, record, teamName, onDone])

  return (
    <div className="pc-root">
      <div className="pc-stage">
        <div className="pc-badge">
          <span className="pc-badge__dot" /> 기자회견
        </div>

        <div className="pc-stack">
          {/* 이전 문답: 위로 쌓임 */}
          {answers.map((ans, i) => (
            <div key={questions[i].id} className="pc-turn pc-turn--past">
              <div className="pc-question pc-question--past">
                <span className="pc-reporter" aria-hidden>🎙️</span>
                <p className="pc-question__text">{questions[i].text}</p>
              </div>
              <p className="pc-answer-said">{ans}</p>
            </div>
          ))}

          {/* 현재 질문 + 3택 */}
          {current && !finishing && (
            <div className="pc-turn pc-turn--current">
              <div className="pc-question" key={current.id}>
                <span className="pc-reporter" aria-hidden>🎙️</span>
                <p className="pc-question__text">{current.text}</p>
              </div>
              <div className="pc-answers" role="group" aria-label="답변 선택">
                {current.options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    className="pc-answer"
                    onClick={() => pick(opt)}
                  >
                    <span className="pc-answer__tone">{TONE_LABEL[i]}</span>
                    <span className="pc-answer__text">{opt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {finishing && (
            <p className="pc-finishing" role="status">헤드라인 발표 준비 중…</p>
          )}
        </div>

        <div className="pc-progress" aria-label={`질문 ${Math.min(idx + (finishing ? 0 : 1), questions.length)} / ${questions.length}`}>
          {questions.map((q, i) => (
            <span key={q.id} className={`pc-progress__dot${i < answers.length ? ' is-done' : ''}${i === idx && !finishing ? ' is-active' : ''}`} />
          ))}
        </div>
      </div>
    </div>
  )
}
