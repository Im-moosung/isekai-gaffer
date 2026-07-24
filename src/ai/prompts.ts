// src/ai/prompts.ts
// 프로바이더 중립 프롬프트 빌더 (순수 함수).
// api/narrate.ts(서버)와 향후 호출부가 공유한다. DOM/네트워크 의존 없음 —
// Vercel Node 런타임에서도 그대로 import 가능하도록 순수하게 유지한다.

export type NarrateTask = 'pressq' | 'headline' | 'epilogue'

/**
 * 시스템 프롬프트 — 세이프가드 제약(설계 §7.1의 1단).
 * 실존 인물·팀 비판 금지, 허위 인용 금지, 사실·중립 질문만, 한국어, 대체역사 픽션 인지.
 */
export function buildSystemPrompt(): string {
  return [
    '당신은 축구 매니지먼트 게임 "리매치 코리아 2026"의 내레이터입니다.',
    '반드시 아래 제약을 지키세요:',
    '- 실존 인물·팀에 대한 비판·조롱·부정 평가를 하지 않는다.',
    '- 그들이 실제로 하지 않은 발언을 인용하지 않는다.',
    '- 사실 서술과 중립적 질문만 사용한다.',
    '- 반드시 한국어로만 답한다.',
    '- 이 게임은 대체역사 픽션임을 인지하고, 픽션 세계관 안에서 서술한다.',
    '- 출력은 군더더기 없이 요청된 결과물만 낸다.',
  ].join('\n')
}

/**
 * task별 유저 프롬프트. context(결정 로그·스코어·답변 톤 등)를 그대로 주입한다.
 * 결정론(순수): 같은 입력이면 같은 문자열.
 */
export function buildUserPrompt(task: NarrateTask, context: Record<string, unknown>): string {
  const ctx = JSON.stringify(context)
  switch (task) {
    case 'pressq':
      return [
        '다음 경기의 맥락(결정 로그·스코어 등)을 바탕으로,',
        '경기 직후 기자회견에서 감독에게 던질 기자 질문 1개를 한국어로 생성하세요.',
        '중립적이고 사실에 근거한 질문이어야 합니다.',
        `경기 맥락: ${ctx}`,
      ].join('\n')
    case 'headline':
      return [
        '다음 기자회견 답변의 톤과 경기 결과를 반영하여,',
        '스포츠 신문 1면 헤드라인 1개를 한국어로 작성하세요.',
        '자극적 비하 없이 사실을 담되 신문 헤드라인다운 함축을 사용하세요.',
        `맥락(결과·답변 톤): ${ctx}`,
      ].join('\n')
    case 'epilogue':
      return [
        '다음 캠페인 여정을 3~5문장의 한국어로 요약하세요.',
        '감독과 팀이 걸어온 길을 담담하고 사실적으로 서술합니다.',
        `여정: ${ctx}`,
      ].join('\n')
  }
}
