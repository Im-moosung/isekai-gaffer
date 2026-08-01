#!/usr/bin/env node
// tools/tts/live-jobs.mjs
// `docs/audio/tts/live-plan.json`(분해 설계의 산출물)을 **Qwen 생성 작업 목록**으로 바꾼다.
// 형식은 기존 `docs/audio/tts/qwen-jobs*.json`과 같다 — 코덱스 세션이 그대로 먹는다.
//
// 여기서 하는 판단은 셋뿐이다:
//  ① **이미 구운 것은 다시 굽지 않는다.** `public/tts/index.json`에 같은 문자열이
//     있으면 그 키를 재사용하고 작업 목록에서 뺀다(입장 소개 219클립과 겹친다).
//  ② **키**는 발화 문자열의 sha1 앞 10자다(기존 규칙과 동일). 접두사는 `l/`(live) —
//     입장 소개의 `t/`·`n/`과 섞이지 않아 어느 갈래가 만든 파일인지 경로로 구분된다.
//  ③ **캐리어 모드**(`cut`)를 그대로 넘긴다. 조각이 문장 안 어디에 서는지에 따라
//     억양이 달라야 한다 — 설계가 정한 값이고 생성기가 판단할 일이 아니다.
//     · head  = 문중 억양이 필요하다 → `{조각} …… 지금 좋습니다.`의 앞부분을 잘라낸다
//     · tail  = 문말 하강이 필요하다 → `이 선수는 …… {조각}`의 뒷부분을 잘라낸다
//     · plain = 그 자체로 완결 문장 → 캐리어 없이 직접 생성
//
// 사용:
//   node tools/tts/live-corpus.mjs --seeds 200      # 먼저 설계를 뽑고
//   node tools/tts/live-jobs.mjs                    # 작업 목록을 만든다
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const PLAN = 'docs/audio/tts/live-plan.json'
const INDEX = 'public/tts/index.json'
const OUT = 'docs/audio/tts/qwen-jobs-live.json'

const plan = JSON.parse(readFileSync(PLAN, 'utf8'))
const baked = JSON.parse(readFileSync(INDEX, 'utf8')).clips
/** 이미 구운 문자열 → 키. 조회표 키는 trim해서 본다(조각 텍스트는 trim된 정본이다). */
const bakedKey = new Map(Object.entries(baked).map(([t, k]) => [t.trim(), k]))

const keyOf = text => `l/${createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 10)}`

const jobs = []
const reused = []
for (const c of plan.clips) {
  const hit = bakedKey.get(c.text)
  if (hit) { reused.push({ key: hit, text: c.text, role: c.role }); continue }
  jobs.push({ key: keyOf(c.text), text: c.text, role: c.role, kind: c.cut === 'plain' ? 'plain' : 'frag', cut: c.cut })
}

// 키 충돌 감시 — sha1 10자는 762개에서 충돌 확률이 사실상 0이지만, 충돌하면
// **엉뚱한 이름이 방송된다**. 조용히 지나가면 안 되는 종류의 사고다.
const seen = new Map()
for (const j of jobs) {
  if (seen.has(j.key)) throw new Error(`키 충돌: ${j.key} — "${seen.get(j.key)}" vs "${j.text}"`)
  seen.set(j.key, j.text)
}

const out = {
  schemaVersion: 1,
  purpose: '이세계 감독 — **경기 중 중계** TTS 조각. Qwen3-TTS 1.7B Base 음성 복제(ICL)로 생성.',
  source: {
    plan: PLAN,
    design: 'tools/tts/live-corpus.mjs — 토큰 열 분해 + 빈도 가중 탐욕 합치기',
    rewrite: 'docs/audio/tts/name-rewrite.json (commentary.ts 발화 문자열에 선적용해야 한다)',
    corpusUtterances: plan.totalUtter,
    avgSeamsPerUtterance: Number(plan.avgSeams.toFixed(3)),
    coverage: plan.coverage,
  },
  // ★ 화자 고정이 전부다. 역할당 `create_voice_clone_prompt`를 **한 번만** 만들어
  //   전량 재사용하고, `x_vector_only_mode=False` + `ref_text`를 쓴다.
  //   입장 소개 219클립과 **같은 참조 음원·같은 시드**여야 이어 붙였을 때 한 사람이다.
  voices: {
    caster: { id: 'C3', alias: '정석', speed: 1.2, ko: '캐스터' },
    analyst: { id: 'A3', alias: '열정', speed: 1.5, ko: '해설위원' },
  },
  seed: 20260806,
  carriers: {
    head: '{text} …… 지금 좋습니다.',
    tail: '이 선수는 …… {text}',
    note: '`cut`이 캐리어를 정한다. plain은 캐리어 없이 직접 생성한다. 잘라내기는 tools/qwen-tts/process.py.',
  },
  audio: { format: 'wav', note: '모노 24kHz. 라우드니스(−16 LUFS)·mp3 인코딩은 tools/tts/live-package.py가 한다.' },
  counts: {
    planned: plan.clips.length,
    reused: reused.length,
    jobs: jobs.length,
    byRole: { caster: jobs.filter(j => j.role === 'caster').length, analyst: jobs.filter(j => j.role === 'analyst').length },
    byCut: { head: jobs.filter(j => j.cut === 'head').length, tail: jobs.filter(j => j.cut === 'tail').length, plain: jobs.filter(j => j.cut === 'plain').length },
  },
  jobs,
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')

console.log(`${OUT}`)
console.log(`  설계 클립 ${plan.clips.length} = 재사용 ${reused.length} + **새로 구울 것 ${jobs.length}**`)
console.log(`  역할: 캐스터 ${out.counts.byRole.caster} · 해설 ${out.counts.byRole.analyst}`)
console.log(`  캐리어: head ${out.counts.byCut.head} · tail ${out.counts.byCut.tail} · 직접 ${out.counts.byCut.plain}`)
console.log(`  평균 이음매 ${out.source.avgSeamsPerUtterance} · 커버리지 ${(plan.coverage * 100).toFixed(2)}% (발화 ${plan.totalUtter}건)`)
