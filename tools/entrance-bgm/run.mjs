#!/usr/bin/env node
// 입장 팡파르 M06의 **시간별 게인 궤적** 실측 — "입장과 동시에 나오고, 소개에 들어가면
// 없다"(사용자 지시 2026-08-01)가 실제로 그렇게 들리는지 브라우저에서 잰다.
//
// 이 도구의 이전 이름은 entrance-duck이었다. 덕킹 절충(소개 위에 작게 깔아 두기)이
// 기각되면서 계약이 뒤집혔으므로 이름과 판정 기준을 함께 바꾼다.
//
// 왜 브라우저인가: jsdom엔 Web Audio가 없다. 게인 램프 곡선·자동재생 정책·실제 디코드는
// 진짜 Chrome에서만 나온다(tools/bgm-timeline/run.mjs와 같은 이유·같은 계측 방식).
//
// 함정: 백그라운드 탭은 rAF를 멈춘다 → headless:false + 측정 전에 픽셀 diff로 프레임 진행을
// 먼저 증명한다. (AudioParam 스케줄 자체는 rAF와 무관하지만, 폴링이 죽으면 표본이 사라진다.)
//
// 계측 대상은 **정확히 프로덕션 경로**다: MatchScreen이 부를 값(entranceScript.totalMs,
// entranceIntroStartMs)을 같은 모듈에서 뽑아 bgm.playSting에 그대로 넘긴다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'docs/audit/bgm')
const W = 1280, H = 800

const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  // --autoplay-policy 를 건드리지 않는다(bgm-timeline과 같은 규칙).
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

async function frameDiff(ms = 400) {
  const a = await page.screenshot()
  await new Promise(r => setTimeout(r, ms))
  const b = await page.screenshot()
  if (a.length !== b.length) return 1
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff / a.length
}

/** 궤적을 스파크라인 한 줄로 — "언제 올라오고 언제 0이 되는가"를 눈으로 본다. */
function spark(rec, from, to, bins = 32) {
  const chars = ' ▁▂▃▄▅▆▇█'
  const out = []
  for (let i = 0; i < bins; i++) {
    const lo = from + ((to - from) * i) / bins
    const hi = from + ((to - from) * (i + 1)) / bins
    const s = rec.filter(r => r.t >= lo && r.t < hi)
    const g = s.length ? Math.max(...s.map(r => r.g)) : 0
    out.push(chars[Math.min(8, Math.round((g / 0.8) * 8))])
  }
  return out.join('')
}

const maxG = a => (a.length ? Math.max(...a.map(r => r.g)) : 0)

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  // 첫 유저 제스처 = AudioContext 해제(bgm.hookFirstGesture). 랜딩의 실제 버튼을 누른다.
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await page.getByRole('button', { name: /준비하기/ }).click({ timeout: 20000 })
  await page.waitForTimeout(1500)

  // ── 0. 현행 앱 경로 실측(MatchScreen 배선 그대로) ─────────────
  // ★ 폴링은 킥오프를 누르는 **순간** 시작해야 한다. 궤적의 핵심 주장이 "0초에 소리가
  //   있는가"라서, 오버레이가 뜨기를 기다린 뒤 붙으면 바로 그 구간을 놓친다.
  const live = await page.evaluate(async () => {
    const bgm = await import('/src/audio/bgm.ts')
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('킥오프'))
    const rec = []
    const t0 = performance.now()
    btn.click()
    const id = setInterval(() => {
      const s = bgm.bgmState()
      rec.push({ t: Math.round(performance.now() - t0), sting: s.sting, g: +s.stingGain.toFixed(5), startsIn: s.stingStartsInMs, endsIn: s.stingEndsInMs })
    }, 25)
    await new Promise(r => setTimeout(r, 18000))
    clearInterval(id)
    return rec
  })
  // 랜딩·허브·워룸은 정지 화면이라 픽셀 diff가 0이다(스로틀과 구분되지 않는다).
  // **입장 연출**은 3D가 60fps로 도는 유일한 확실한 애니메이션 표면이라 여기서 증명한다.
  const diff = await frameDiff()
  const okFrames = diff > 0.0001
  console.log(`[프레임 진행 증명 · 입장 연출] 픽셀 diff = ${diff.toFixed(4)} ${okFrames ? 'OK' : 'FAIL — 계측 무의미'}`)
  if (!okFrames) throw new Error('rAF 정지 — 계측 무의미')

  const bounds = await page.evaluate(async () => {
    const E = await import('/src/ui/pitch/three/entrance.ts')
    const { useMatchStore } = await import('/src/game/matchStore.ts')
    const st = useMatchStore.getState().engine
    const cast = E.buildEntranceCast(st)
    const scr = E.entranceScript(cast, E.defaultEntranceMode())
    return { mode: scr.mode, totalMs: scr.totalMs, introStart: E.entranceIntroStartMs(scr), introEnd: E.entranceIntroEndMs(scr) }
  })
  console.log(`\n[0] 현행 앱 경로 — 모드=${bounds.mode} · totalMs=${bounds.totalMs} · 소개 ${bounds.introStart}~${bounds.introEnd}ms`)
  const audible = live.filter(r => r.sting === 'M06' && r.startsIn === 0)
  const IS = bounds.introStart ?? 0
  const before = audible.filter(r => r.t < IS - 700)   // 페이드 시작(−500ms)보다 앞
  const after = live.filter(r => r.t > IS + 300)       // 페이드 완료 뒤
  const firstAudible = audible.find(r => r.g > 0.01)
  console.log(`  게인 궤적 0~${Math.round(IS + 4000)}ms: |${spark(live, 0, IS + 4000)}|  (소개 시작 ${IS}ms)`)
  console.log(`  첫 가청 t=${firstAudible ? firstAudible.t : '없음'}ms · 입장 구간 최대 게인 ${maxG(before).toFixed(4)}`)
  console.log(`  소개 구간 최대 게인 ${maxG(after).toFixed(4)} (기대 0.0000)`)
  const verdict = [
    ['입장과 동시에 시작(<700ms)', !!firstAudible && firstAudible.t < 700],
    ['입장 구간은 제 음량', maxG(before) > 0.5],
    ['소개 구간은 완전 무음', maxG(after) < 0.0005],
  ]
  for (const [k, v] of verdict) console.log(`  ${v ? 'PASS' : 'FAIL'} — ${k}`)

  // ── 1~2. 두 모드를 격리 페이지에서 재확인 ──────────────────────
  // **깨끗한 페이지에서** 잰다 — MatchScreen이 살아 있으면 그쪽 effect가 setScene/stopSting을
  // 호출해 스팅 채널을 빼앗는다(위 [0] 직후 그대로 재면 표본이 0개가 된다).
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await page.waitForTimeout(1000)

  const plan = await page.evaluate(async () => {
    const bgm = await import('/src/audio/bgm.ts')
    const E = await import('/src/ui/pitch/three/entrance.ts')
    const { createMatch } = await import('/src/engine/simulate.ts')
    const { makeTestTeam } = await import('/src/engine/fixtures/testTeams.ts')
    const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
    const cast = E.buildEntranceCast(state)

    window.__runs = {}
    window.__probe = async (mode) => {
      const scr = E.entranceScript(cast, mode)
      const introStart = E.entranceIntroStartMs(scr)
      bgm.stopSting(0)
      await new Promise(r => setTimeout(r, 200))
      const t0 = performance.now()
      // ★ MatchScreen.startEntranceMusic과 **같은 분기**다. 규칙이 두 벌이면 계측이 거짓이 된다.
      bgm.playSting('M06', introStart == null ? { alignEndAtMs: scr.totalMs } : { fadeOutAtMs: introStart })
      const rec = []
      const id = setInterval(() => {
        const s = bgm.bgmState()
        rec.push({ t: Math.round(performance.now() - t0), sting: s.sting, g: +s.stingGain.toFixed(5), startsIn: s.stingStartsInMs, endsIn: s.stingEndsInMs })
      }, 25)
      await new Promise(r => setTimeout(r, (introStart ?? scr.totalMs) + 3000))
      clearInterval(id)
      window.__runs[mode] = { totalMs: scr.totalMs, introStart, rec }
      return { totalMs: scr.totalMs, introStart, samples: rec.length }
    }
    return {
      full: { totalMs: E.entranceScript(cast, 'full').totalMs, introStart: E.entranceIntroStartMs(E.entranceScript(cast, 'full')) },
      short: { totalMs: E.entranceScript(cast, 'short').totalMs, introStart: E.entranceIntroStartMs(E.entranceScript(cast, 'short')) },
      defaultMode: E.defaultEntranceMode(),
      fadeoutMs: bgm.STING_FADEOUT_MS,
    }
  })
  console.log(`\n기본 모드 = ${plan.defaultMode} · STING_FADEOUT_MS=${plan.fadeoutMs}`)
  console.log(`full  totalMs=${plan.full.totalMs}  소개 시작=${plan.full.introStart}`)
  console.log(`short totalMs=${plan.short.totalMs}  소개 시작=${plan.short.introStart}`)

  const out = { bounds, live, plan, runs: {} }
  for (const mode of ['full', 'short']) {
    const p = mode === 'full' ? plan.full : plan.short
    console.log(`\n── ${mode} 재생 실측 ──`)
    await page.evaluate(m => window.__probe(m), mode)
    const run = await page.evaluate(m => window.__runs[m], mode)
    out.runs[mode] = run
    const aud = run.rec.filter(r => r.sting === 'M06' && r.startsIn === 0)
    if (aud.length === 0) { console.log('  (표본 없음 — 스팅이 울리지 않았다)'); continue }
    // 폴링 자체가 스로틀되지 않았음을 표본 간격으로 증명한다(25ms 목표).
    const gaps = aud.slice(1).map((r, i) => r.t - aud[i].t).sort((a, b) => a - b)
    const cut = p.introStart
    const win = cut ?? p.totalMs
    console.log(`  표본 ${aud.length}개 · 폴링 간격 중앙값 ${gaps[Math.floor(gaps.length / 2)]}ms(목표 25ms) 최대 ${gaps[gaps.length - 1]}ms`)
    console.log(`  게인 궤적 0~${Math.round(win + 2000)}ms: |${spark(run.rec, 0, win + 2000)}|`)
    const first = aud.find(r => r.g > 0.01)
    console.log(`  첫 가청 t=${first ? first.t : '없음'}ms`)
    if (cut != null) {
      const inCut = aud.filter(r => r.t < cut - 700)
      const post = run.rec.filter(r => r.t > cut + 300)
      console.log(`  입장 구간 최대 ${maxG(inCut).toFixed(4)} → 소개 구간 최대 ${maxG(post).toFixed(4)}`)
      // 페이드가 하드 컷이 아님을 표본으로 본다 — 중간 게인이 실제로 관측되어야 한다.
      const mid = run.rec.filter(r => r.g > 0.02 && r.g < 0.7 && r.t > cut - 900)
      console.log(`  페이드 중간 게인 표본 ${mid.length}개 (하드 컷이면 0개)`)
    } else {
      const last = aud[aud.length - 1]
      console.log(`  (short) 끝 맞추기 — 마지막 표본 t=${last.t}ms · 남은 ${last.endsIn}ms`)
    }
  }
  await writeFile(join(OUT, 'entrance-bgm.json'), JSON.stringify(out, null, 2))
  console.log(`\n표본 기록 → docs/audit/bgm/entrance-bgm.json`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'entrance-bgm.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
