#!/usr/bin/env node
// 입장 팡파르 M06의 **소개 구간 덕킹** 실측 — "소개할 때는 음악을 아주 작게"(사용자 지시).
//
// 왜 브라우저인가: jsdom엔 Web Audio가 없다. 게인 램프 곡선·자동재생 정책·실제 디코드는
// 진짜 Chrome에서만 나온다(tools/bgm-timeline/run.mjs와 같은 이유·같은 계측 방식).
//
// 함정: 백그라운드 탭은 rAF를 멈춘다 → headless:false + 측정 전에 픽셀 diff로 프레임 진행을
// 먼저 증명한다. (AudioParam 스케줄 자체는 rAF와 무관하지만, 폴링이 죽으면 표본이 사라진다.)
//
// 계측 대상은 **정확히 프로덕션 경로**다: MatchScreen이 부를 값(entranceScript.totalMs,
// entranceIntroEndMs)을 같은 모듈에서 뽑아 bgm.playSting에 그대로 넘긴다.
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

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  // 첫 유저 제스처 = AudioContext 해제(bgm.hookFirstGesture). 랜딩의 실제 버튼을 누른다.
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await page.getByRole('button', { name: /준비하기/ }).click({ timeout: 20000 })
  await page.waitForTimeout(1500)

  // ── 0. 현행 앱 경로 실측(MatchScreen 배선 그대로) ─────────────
  // 랜딩·허브·워룸은 정지 화면이라 픽셀 diff가 0이다(스로틀과 구분되지 않는다).
  // **입장 연출**은 3D가 60fps로 도는 유일한 확실한 애니메이션 표면이므로, 프레임 진행
  // 증명도 계측도 여기서 한다.
  await page.getByRole('button', { name: '킥오프' }).click()
  const overlay = page.locator('[data-testid="entrance-overlay"]')
  await overlay.waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(2500)
  const diff = await frameDiff()
  const ok = diff > 0.0001
  console.log(`[프레임 진행 증명 · 입장 연출] 픽셀 diff = ${diff.toFixed(4)} ${ok ? 'OK' : 'FAIL — 계측 무의미'}`)
  if (!ok) throw new Error('rAF 정지 — 계측 무의미')

  const live = await page.evaluate(async () => {
    const bgm = await import('/src/audio/bgm.ts')
    const t0 = performance.now()
    const rec = []
    const id = setInterval(() => {
      const s = bgm.bgmState()
      rec.push({ t: Math.round(performance.now() - t0), sting: s.sting, g: +s.stingGain.toFixed(5), startsIn: s.stingStartsInMs, endsIn: s.stingEndsInMs })
    }, 25)
    await new Promise(r => setTimeout(r, 62000))
    clearInterval(id)
    return rec
  })
  const liveAudible = live.filter(r => r.sting === 'M06' && r.startsIn === 0 && r.endsIn > 0)
  const overlayGone = await overlay.count().then(c => c === 0)
  console.log(`\n[0] 현행 앱 경로 — 오버레이 종료=${overlayGone} · M06 가청 표본 ${liveAudible.length}개`
    + (liveAudible.length ? ` · 게인 ${Math.min(...liveAudible.map(r => r.g)).toFixed(4)}~${Math.max(...liveAudible.map(r => r.g)).toFixed(4)}` : ''))
  console.log('    (MatchScreen이 아직 duckUntilMs를 넘기지 않으므로 소개 위에서도 제 음량이다 — 이것이 고쳐야 할 상태)')

  // ── 1~2. 새 계약 실측 ─────────────────────────────────────────
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
      const introEnd = E.entranceIntroEndMs(scr)
      bgm.stopSting(0)
      await new Promise(r => setTimeout(r, 200))
      const t0 = performance.now()
      bgm.playSting('M06', {
        alignEndAtMs: scr.totalMs,
        ...(introEnd != null ? { duckUntilMs: introEnd } : {}),
      })
      const rec = []
      const id = setInterval(() => {
        const s = bgm.bgmState()
        rec.push({ t: Math.round(performance.now() - t0), sting: s.sting, g: +s.stingGain.toFixed(5), startsIn: s.stingStartsInMs, endsIn: s.stingEndsInMs })
      }, 25)
      await new Promise(r => setTimeout(r, scr.totalMs + 800))
      clearInterval(id)
      window.__runs[mode] = { totalMs: scr.totalMs, introEnd, rec }
      return { totalMs: scr.totalMs, introEnd, samples: rec.length }
    }
    return {
      full: { totalMs: E.entranceScript(cast, 'full').totalMs, introEnd: E.entranceIntroEndMs(E.entranceScript(cast, 'full')) },
      short: { totalMs: E.entranceScript(cast, 'short').totalMs, introEnd: E.entranceIntroEndMs(E.entranceScript(cast, 'short')) },
      defaultMode: E.defaultEntranceMode(),
      duckRatio: bgm.DUCK_RATIO,
      unduckMs: bgm.STING_UNDUCK_MS,
    }
  })
  console.log(`\n기본 모드 = ${plan.defaultMode}`)
  console.log(`full  totalMs=${plan.full.totalMs}  소개 종료=${plan.full.introEnd}`)
  console.log(`short totalMs=${plan.short.totalMs}  소개 종료=${plan.short.introEnd}`)
  console.log(`DUCK_RATIO=${plan.duckRatio}  STING_UNDUCK_MS=${plan.unduckMs}`)

  const out = { plan, runs: {} }
  for (const mode of ['full', 'short']) {
    console.log(`\n── ${mode} 재생 실측(약 ${Math.round((mode === 'full' ? plan.full.totalMs : plan.short.totalMs) / 1000)}초) ──`)
    await page.evaluate(m => window.__probe(m), mode)
    const run = await page.evaluate(m => window.__runs[m], mode)
    out.runs[mode] = run
    // 소리가 실제로 나는 구간(스팅 소스가 시작된 뒤)만 본다.
    const audible = run.rec.filter(r => r.sting === 'M06' && r.startsIn === 0 && r.endsIn > 0)
    if (audible.length === 0) { console.log('  (표본 없음 — 스팅이 울리지 않았다)'); continue }
    const start = audible[0].t
    const introEnd = run.introEnd
    const inIntro = introEnd == null ? [] : audible.filter(r => r.t >= start + 200 && r.t < introEnd - 200)
    const afterIntro = audible.filter(r => introEnd == null || r.t > introEnd + 1100)
    const g = a => a.map(r => r.g)
    const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN
    // 폴링 자체가 스로틀되지 않았음을 표본 간격으로 증명한다(25ms 목표).
    const gaps = audible.slice(1).map((r, i) => r.t - audible[i].t).sort((a, b) => a - b)
    const med = gaps[Math.floor(gaps.length / 2)]
    console.log(`  스팅 개시 t=${start}ms · 표본 ${audible.length}개 · 폴링 간격 중앙값 ${med}ms(목표 25ms) 최대 ${gaps[gaps.length - 1]}ms`)
    if (inIntro.length) {
      console.log(`  소개 구간(${start}~${introEnd}ms · ${inIntro.length}표본) 게인: 최소 ${Math.min(...g(inIntro)).toFixed(4)} / 평균 ${avg(g(inIntro)).toFixed(4)} / 최대 ${Math.max(...g(inIntro)).toFixed(4)}`)
    } else {
      console.log('  소개 구간: 없음(short)')
    }
    console.log(`  해제 후(${afterIntro.length}표본) 게인: 최소 ${Math.min(...g(afterIntro)).toFixed(4)} / 평균 ${avg(g(afterIntro)).toFixed(4)} / 최대 ${Math.max(...g(afterIntro)).toFixed(4)}`)
    if (inIntro.length) {
      const ratio = avg(g(afterIntro)) / avg(g(inIntro))
      console.log(`  ⇒ 배율 차 ${ratio.toFixed(2)}× (기대 ${(1 / plan.duckRatio).toFixed(0)}×)`)
      // 램프가 실제로 언제 시작·완료됐나.
      const full = Math.max(...g(audible))
      const rise = audible.find(r => r.t > introEnd - 100 && r.g > full * 0.15)
      const done = audible.find(r => r.t > introEnd - 100 && r.g >= full * 0.99)
      console.log(`  램프: 상승 개시 ≈${rise ? rise.t : '?'}ms · 도달 ≈${done ? done.t : '?'}ms (소개 종료 ${introEnd}ms 기준 +${done ? done.t - introEnd : '?'}ms)`)
    }
  }
  await writeFile(join(OUT, 'entrance-duck.json'), JSON.stringify(out, null, 2))
  console.log(`\n표본 기록 → docs/audit/bgm/entrance-duck.json`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'entrance-duck.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
