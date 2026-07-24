// src/audio/commentary-tts.ts
// 한국어 TTS 실시간 중계 — Web Speech API(speechSynthesis)로 해설 문장을 소리로 낸다.
// 발화 텍스트는 commentary.commentate() 산출을 그대로 쓴다(스펙 §7.1 세이프가드 통과 문장).
//
// 핵심 원칙(불변):
//  1) 미지원 브라우저·ko-KR 보이스 없음 = 조용한 no-op. 절대 throw하지 않는다(TTS 실패가 경기를 멈추지 않는다).
//  2) speechSynthesis 자동재생 요건은 관대하지만, 안전하게 킥오프(유저 제스처) 이후에만 발화한다.
//  3) [🎙 해설] 토글은 음소거(rematch-muted)와 별개로 localStorage('rematch-tts')에 기억한다. 기본값 ON.
//  4) 큐 정책: 발화 중이면 일반 라인은 스킵(드롭), important(골·세이브 등)는 현재 발화를 cancel 후 즉시.
//  5) pause·모드 전환 시 stopAll()로 진행 중 발화를 취소한다(작전 지시 중 해설이 새지 않게).

import type { MatchEvent, MatchEventType } from '../engine/types'

const TTS_KEY = 'rematch-tts'

// ── 모듈 상태 ─────────────────────────────────────────────────
// available = speechSynthesis 존재 + ko-KR 보이스 발견(둘 다여야 실제 발화). 아니면 조용한 no-op.
let available = false
let voice: SpeechSynthesisVoice | null = null
let voiceInitStarted = false
// ttsOn = 유저 토글(localStorage 진실원). available과 독립 — 켜져 있어도 미지원이면 no-op.
let ttsOn = readStoredTts()

// ── speechSynthesis 접근(미지원이면 null) ─────────────────────
function getSynth(): SpeechSynthesis | null {
  try {
    return (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? null
  } catch {
    return null
  }
}

/** ko-KR 보이스로 발화 utterance를 만든다. important는 rate·pitch 상향 강조. */
function makeUtterance(line: string, important: boolean): SpeechSynthesisUtterance | null {
  try {
    const U = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
      .SpeechSynthesisUtterance
    if (!U) return null
    const u = new U(line)
    if (voice) u.voice = voice
    u.lang = 'ko-KR'
    // important(골·세이브·승부차기): 빠르고 높게(흥분). 일반: 살짝만 빠르게.
    u.rate = important ? 1.15 : 1.05
    u.pitch = important ? 1.15 : 1.0
    return u
  } catch {
    return null
  }
}

// ── 보이스 초기화 ─────────────────────────────────────────────
/**
 * ko-KR 보이스를 탐색한다(1회). 보이스 목록이 비동기 로드되는 브라우저를 위해
 * voiceschanged 이벤트에도 재탐색한다. 끝까지 ko 보이스가 없으면 available=false로 남아 no-op.
 * 미지원(speechSynthesis 부재)이면 즉시 no-op.
 */
export function initVoice(): void {
  if (voiceInitStarted) return
  voiceInitStarted = true
  const synth = getSynth()
  if (!synth) {
    available = false
    return
  }
  const pick = (): void => {
    try {
      const voices = synth.getVoices?.() ?? []
      const ko = voices.find(v => (v.lang || '').toLowerCase().startsWith('ko'))
      if (ko) {
        voice = ko
        available = true
      }
    } catch {
      /* no-op — 탐색 실패는 available=false 유지 */
    }
  }
  pick()
  // 아직 못 찾았으면 보이스 목록 로드(voiceschanged) 후 재탐색.
  try {
    if (!available && typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', pick)
    }
  } catch {
    /* no-op */
  }
}

// ── 발화 ──────────────────────────────────────────────────────
/**
 * 한 줄을 음성 중계한다. 미지원·보이스 없음·토글 OFF·빈 문자열이면 조용한 no-op.
 * 큐 정책: 발화 중이면 일반 라인은 드롭, important는 현재 발화를 cancel 후 즉시 발화한다.
 */
export function speak(line: string, opts: { important?: boolean } = {}): void {
  if (!available || !ttsOn || !line) return
  const synth = getSynth()
  if (!synth) return
  try {
    const important = !!opts.important
    if (synth.speaking) {
      if (!important) return // 발화 중 일반 라인은 스킵(드롭) — 과밀 방지
      synth.cancel() // important는 선점: 현재 발화 취소 후 즉시
    }
    const u = makeUtterance(line, important)
    if (u) synth.speak(u)
  } catch {
    /* no-op — TTS 실패가 경기를 멈추지 않는다 */
  }
}

/** 진행 중인 모든 발화를 취소한다(pause·모드 전환·언마운트). 미지원이면 no-op. */
export function stopAll(): void {
  const synth = getSynth()
  if (!synth) return
  try {
    synth.cancel()
  } catch {
    /* no-op */
  }
}

// ── 토글(localStorage 기억) ───────────────────────────────────
/** localStorage에서 TTS 활성 여부를 읽는다. 기본 ON — '0'만 OFF, 부재·오류 시 ON. */
export function readStoredTts(): boolean {
  try {
    return globalThis.localStorage?.getItem(TTS_KEY) !== '0'
  } catch {
    return true
  }
}

/** 현재 TTS 토글 상태(유저 설정). */
export function isTtsEnabled(): boolean {
  return ttsOn
}

/** TTS 토글 설정 + localStorage 반영. OFF로 끄면 진행 중 발화도 즉시 중단. */
export function setTtsEnabled(next: boolean): void {
  ttsOn = next
  try {
    if (next) globalThis.localStorage?.removeItem(TTS_KEY)
    else globalThis.localStorage?.setItem(TTS_KEY, '0')
  } catch {
    /* localStorage 미지원 — 메모리 상태만 유지 */
  }
  if (!next) stopAll()
}

/** TTS 토글 — 새 상태를 반환(UI 동기화용). */
export function toggleTts(): boolean {
  setTtsEnabled(!ttsOn)
  return ttsOn
}

// ── 대표 이벤트 선정(순수 함수) ───────────────────────────────
// 하이라이트 분에 이벤트가 여러 개면 대표 1개만 발화한다(과밀 방지).
// 우선순위: goal > save > miss > corner > foul. 목록에 없는 타입은 발화 대상 아님.
const SPOKEN_PRIORITY: MatchEventType[] = ['goal', 'save', 'miss', 'corner', 'foul']

/** 이벤트 배열에서 음성 중계할 대표 이벤트를 고른다(우선순위 최상위). 없으면 null. */
export function pickSpokenEvent(events: MatchEvent[]): MatchEvent | null {
  let best: MatchEvent | null = null
  let bestRank = Infinity
  for (const e of events) {
    const rank = SPOKEN_PRIORITY.indexOf(e.type)
    if (rank === -1) continue
    if (rank < bestRank) {
      bestRank = rank
      best = e
    }
  }
  return best
}
