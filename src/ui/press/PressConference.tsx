// src/ui/press/PressConference.tsx
// 경기 직후 기자회견 세그먼트. buildQuestions(정본 템플릿)로 3문항을 순차 진행하고,
// 완료 시 buildHeadline(템플릿)로 헤드라인을 만든 뒤 aiClient.narrate('headline')로
// 제목만 대체를 시도한다. 실패·지연은 UX를 막지 않는다.
//
// [지연 처리 선택] onDone(headline)은 단일 콜백이므로, 답변 완료 후 aiClient.narrate를
// await 한 뒤 결과를 반영해 한 번만 호출한다. aiClient는 이미 3초 하드 타임아웃(AbortController)을
// 내장하므로 최악의 경우에도 3초 뒤 반드시 템플릿으로 진행한다 — "3s 대기 후 진행" 방식.
// 대기 동안에는 "발표 준비 중" 상태를 표시해 화면이 멈춘 것처럼 보이지 않게 한다.
import { useMemo, useRef, useState } from 'react'
import { buildQuestions, buildHeadline } from '../../game/pressconf'
import type { Headline } from '../../game/pressconf'
import type { MatchRecord } from '../../game/campaignStore'
import type { DecisionEntry } from '../../engine/types'
import { narrate } from '../../ai/aiClient'
import { useMatchStore } from '../../game/matchStore'
import '../shell/shell.css'
import './press.css'

interface Props {
  record: MatchRecord
  log: DecisionEntry[]
  teamName: string
  onDone(headline: Headline): void
}

const TONE_LABEL = ['공격적', '겸손', '유머'] as const

// 상대·라운드 한글 표기(계층 격리: pressconf 내부 상수를 끌어오지 않는다).
// 컨텍스트 스트립 전용 — 미등록 id는 코드 그대로 노출한다.
const OPPONENT_KO: Record<string, string> = {
  cze: '체코', mex: '멕시코', rsa: '남아공',
  ecu: '에콰도르', eng: '잉글랜드', nor: '노르웨이', arg: '아르헨티나', esp: '스페인',
  can: '캐나다', mar: '모로코', fra: '프랑스',
}
const STAGE_KO: Record<string, string> = {
  group1: '조별리그 1차전', group2: '조별리그 2차전', group3: '조별리그 3차전',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '결승', ended: '여정의 끝',
}

// 질문자 표기 — 회견장이라는 사실을 화면이 스스로 말하게 하는 장치.
// 실존 매체명은 쓰지 않는다(신문 제호와 같은 이유). 질문 순서로 결정론 선택.
const PRESS_DESK = [
  { outlet: '대한스포츠', name: '김 기자' },
  { outlet: '월드컵 데일리', name: '박 기자' },
  { outlet: '축구주간', name: '이 기자' },
] as const

export function PressConference({ record, log, teamName, onDone }: Props) {
  // 킥오프 플랜 이탈 축 수 — matchStore는 경기 종료 후에도 리셋되지 않으므로 여기서 직접 읽는다.
  // App→MatchScreen→onMatchEnd 콜백에 인자를 하나 더 얹는 것보다 결합이 얕고,
  // 플랜을 세운 적 없는 렌더(단독 테스트·데모)는 matchPlan이 null이라 undefined가 되어
  // 추궁 질문이 생기지 않는다.
  const planDeviation = useMatchStore(s => (s.matchPlan ? s.planDeviation : undefined))
  const questions = useMemo(
    () => buildQuestions(record, log, planDeviation),
    [record, log, planDeviation],
  )
  // 확정된 문답 스택(위로 쌓임) + 현재 인덱스.
  const [answers, setAnswers] = useState<string[]>([])
  const [finishing, setFinishing] = useState(false)
  const doneRef = useRef(false)

  const idx = answers.length
  const current = questions[idx]

  // 완료 시퀀스는 "마지막 답변 클릭" 핸들러에서 직접 실행한다.
  // effect(재실행·cleanup)를 쓰지 않으므로, narrate await 중 부모가 인라인 콜백을
  // 새 참조로 넘겨도 진행 중 콜백이 무효화되지 않는다(이 클릭 시점의 onDone/record/teamName을
  // 클로저로 고정). doneRef가 1회 실행을 보장한다.
  async function pick(option: string) {
    if (finishing || idx >= questions.length) return
    const next = [...answers, option]
    setAnswers(next)
    if (next.length < questions.length || doneRef.current) return

    doneRef.current = true
    setFinishing(true)
    const template = buildHeadline(record, next, teamName)
    const context = {
      teamName,
      opponentId: record.opponentId,
      stage: record.stage,
      score: record.score,
      shootout: record.shootout ?? null,
      answers: next,
    }
    // narrate는 내부 3s 타임아웃으로 반드시 종결된다. 실패·null이면 템플릿 title 유지.
    const ai = await narrate('headline', context).catch(() => null)
    const title = ai && ai.trim().length > 0 ? ai.trim() : template.title
    onDone({ ...template, title })
  }

  const opponent = OPPONENT_KO[record.opponentId] ?? record.opponentId
  const stage = STAGE_KO[record.stage] ?? record.stage
  const shootout = record.shootout ? ` (승부차기 ${record.shootout[0]}-${record.shootout[1]})` : ''
  const desk = PRESS_DESK[idx % PRESS_DESK.length]

  return (
    <div className="pc-root">
      <div className="pc-stage">
        {/* 컨텍스트 스트립 — 어느 경기 뒤의 회견인지 화면 안에서 확인된다. */}
        <header className="pc-strip">
          <span className="pc-strip__live">
            <span className="live-dot" aria-hidden /> 기자회견
          </span>
          <span className="pc-strip__ctx num">
            {teamName} {record.score[0]}-{record.score[1]} {opponent}{shootout} · {stage}
          </span>
        </header>

        {/* 지난 문답 — 요약 레일. 말풍선이 아니라 회견록 한 줄이다. */}
        {answers.length > 0 && (
          <ol className="pc-past" aria-label="지난 문답">
            {answers.map((ans, i) => (
              <li key={questions[i].id} className="pc-past__item">
                <p className="pc-past__q">
                  <span className="pc-past__mark" aria-hidden>Q.</span>{questions[i].text}
                </p>
                <p className="pc-past__a">
                  <span className="pc-past__mark" aria-hidden>A.</span>{ans}
                </p>
              </li>
            ))}
          </ol>
        )}

        <div className="pc-main">
          {/* 현재 질문(로어서드) + 3택 */}
          {current && !finishing && (
            <>
              <article className="pc-question" key={current.id}>
                <div className="pc-question__meta">
                  <span className="pc-question__outlet">{desk.outlet} · {desk.name}</span>
                  {/* 진행 표시는 막대가 아니라 평문이다 — 로딩바로 오독되지 않는다. */}
                  <span className="pc-question__count num">
                    질문 {idx + 1} / {questions.length}
                  </span>
                </div>
                <p className="pc-question__text">{current.text}</p>
              </article>

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
            </>
          )}

          {finishing && (
            <p className="pc-finishing" role="status">헤드라인 발표 준비 중…</p>
          )}
        </div>
      </div>
    </div>
  )
}
