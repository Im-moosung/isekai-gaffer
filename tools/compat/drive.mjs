#!/usr/bin/env node
// tools/compat/drive.mjs — 브라우저 호환성 실주행 감사.
//
// 왜: 해커톤 심사는 배포 URL로 진행되고 규정은 "주요 브라우저에서 정상 실행"·"동적
// 인터랙션이 실제로 작동하지 않으면 평가 제외"를 명시한다. 그런데 이 프로젝트의 모든
// 하니스가 channel:'chrome'이었다. 심사자가 Safari를 쓰면 전부 무의미해질 수 있다.
//
// rAF 함정: 헤드리스·백그라운드 탭은 rAF를 스로틀·정지시킨다. 이 프로젝트가 두 번 당했다.
// 그래서 headless:false로 띄우고, 캡처·판정 전에 **픽셀 diff로 프레임 진행을 먼저 증명**한다.
//
// 사용: node tools/compat/drive.mjs                 (webkit,firefox,chromium 전부)
//       ENGINES=webkit node tools/compat/drive.mjs  (일부만)
//       BASE=http://localhost:5199 …
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, firefox, webkit } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const OUT = join(ROOT, 'docs/audit/compat')
const BASE = process.env.BASE || 'http://localhost:5199'
const ENGINES = (process.env.ENGINES || 'webkit,firefox,chromium').split(',')
const W = 1440, H = 900
/** 전·후반 재생을 지켜보는 상한(ms). 넘으면 "완주 못함"으로 기록한다. */
const HALF_BUDGET = Number(process.env.HALF_BUDGET || 300000)

const LAUNCHERS = {
  webkit: () => webkit.launch({ headless: false }),
  firefox: () => firefox.launch({
    headless: false,
    // 자동재생 차단을 풀어야 Web Audio 경로를 실제로 밟는다(차단 자체는 별도로 판정).
    firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
  }),
  chromium: () => chromium.launch({
    headless: false, channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  }),
}

/** 브라우저가 실제로 무엇을 지원하는지 — 추정이 아니라 실측. */
const PROBE = () => {
  const sup = (p, v) => { try { return CSS.supports(p, v) } catch { return false } }
  const supSel = s => { try { return CSS.supports(`selector(${s})`) } catch { return false } }
  let gl = null, gl2 = null, glRenderer = null
  try {
    // 캔버스 하나에서 'webgl' → 'webgl2'를 잇달아 부르면 두 번째는 항상 null이다(스펙).
    // 캔버스를 따로 만들지 않으면 WebGL2 미지원으로 잘못 읽힌다.
    gl = !!document.createElement('canvas').getContext('webgl')
    const g2 = document.createElement('canvas').getContext('webgl2')
    gl2 = !!g2
    const g = g2 || document.createElement('canvas').getContext('webgl')
    if (g) {
      const dbg = g.getExtension('WEBGL_debug_renderer_info')
      glRenderer = dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)
    }
  } catch (e) { glRenderer = 'throw: ' + e.message }
  const AC = window.AudioContext || window.webkitAudioContext
  const voices = (() => {
    try { return (speechSynthesis.getVoices() || []).map(v => `${v.lang}|${v.name}`) } catch { return null }
  })()
  return {
    ua: navigator.userAgent,
    css: {
      'color-mix': sup('color', 'color-mix(in srgb, red 50%, blue)'),
      ':has()': supSel(':has(*)'),
      '@container': typeof CSSContainerRule !== 'undefined',
      'backdrop-filter': sup('backdrop-filter', 'blur(4px)') || sup('-webkit-backdrop-filter', 'blur(4px)'),
      'oklch': sup('color', 'oklch(50% 0.1 200)'),
      'aspect-ratio': sup('aspect-ratio', '1/1'),
      'text-wrap-balance': sup('text-wrap', 'balance'),
      'dvh': sup('height', '100dvh'),
      'nesting': sup('selector(&)'),
    },
    js: {
      structuredClone: typeof structuredClone === 'function',
      'crypto.getRandomValues': !!(globalThis.crypto && crypto.getRandomValues),
      'crypto.randomUUID': !!(globalThis.crypto && crypto.randomUUID),
      'Array.at': typeof [].at === 'function',
      'Object.hasOwn': typeof Object.hasOwn === 'function',
      'Array.toSorted': typeof [].toSorted === 'function',
      'Promise.withResolvers': typeof Promise.withResolvers === 'function',
      'RegExp.v': (() => { try { new RegExp('a', 'v'); return true } catch { return false } })(),
      'ResizeObserver': typeof ResizeObserver === 'function',
      'OffscreenCanvas': typeof OffscreenCanvas === 'function',
      'speechSynthesis': typeof speechSynthesis !== 'undefined',
    },
    webgl: { webgl: gl, webgl2: gl2, renderer: glRenderer },
    audio: { AudioContext: !!AC, prefixed: !window.AudioContext && !!window.webkitAudioContext },
    voicesRaw: voices,
    koVoices: (voices || []).filter(v => /^ko/i.test(v)),
  }
}

/** 텍스트를 포함하는 보이는 컨트롤을 실제로 누른다(히트 테스트 포함). */
const tap = async (page, text, nth = 0) => {
  const h = await page.evaluateHandle(([t, n]) => {
    const els = [...document.querySelectorAll('button,a,[role=button],[role=tab],summary')]
      .filter(e => e.textContent.trim().includes(t) && e.offsetParent !== null)
    return els[n] || null
  }, [text, nth])
  const el = h.asElement()
  if (!el) return { ok: false, why: `"${text}" 없음` }
  await el.scrollIntoViewIfNeeded().catch(() => {})
  const covered = await el.evaluate(node => {
    const r = node.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit && !node.contains(hit) && hit !== node ? (hit.className || hit.tagName) : null
  })
  if (covered) return { ok: false, why: `"${text}"가 ${covered}에 덮임` }
  await el.click({ timeout: 5000 }).catch(async () => { await el.evaluate(n => n.click()) })
  await page.waitForTimeout(700)
  return { ok: true }
}

/** 프레임이 실제로 진행하는가 — 정지 화면이면 이후 판정이 전부 무의미하다. */
const proveMotion = async (page, sel) => {
  const loc = page.locator(sel).first()
  if (!await loc.count()) return { ok: false, why: `${sel} 없음` }
  try {
    const a = await loc.screenshot()
    await page.waitForTimeout(400)
    const b = await loc.screenshot()
    const moving = a.length !== b.length || !a.equals(b)
    // rAF 자체도 직접 센다(캔버스가 정적인 장면일 수 있으므로 보조 증거).
    const raf = await page.evaluate(() => new Promise(res => {
      let n = 0; const t0 = performance.now()
      const tick = () => { n++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else res(n) }
      requestAnimationFrame(tick)
    }))
    return { ok: moving || raf > 10, pixelDiff: moving, rafPer500ms: raf }
  } catch (e) { return { ok: false, why: e.message } }
}

await mkdir(SHOTS, { recursive: true })
await mkdir(OUT, { recursive: true })

for (const eng of ENGINES) {
  const t0 = Date.now()
  const browser = await LAUNCHERS[eng]()
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  })
  const page = await ctx.newPage()
  const console_ = [], errors = [], failedReq = []
  page.on('console', m => console_.push({ type: m.type(), text: m.text().slice(0, 400) }))
  page.on('pageerror', e => errors.push(String(e.stack || e).slice(0, 600)))
  page.on('requestfailed', r => failedReq.push(`${r.failure()?.errorText} ${r.url().slice(0, 160)}`))

  const steps = []
  const rec = (name, ok, detail) => {
    steps.push({ name, ok, detail })
    console.log(`[${eng}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  const shot = async (tag, full = false) =>
    page.screenshot({ path: join(SHOTS, `compat-${eng}-${tag}.png`), fullPage: full }).catch(() => {})

  const report = { engine: eng, base: BASE, viewport: [W, H], steps, console: console_, errors, failedReq }
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(3500)
    // 음성 목록은 비동기로 채워지는 브라우저가 있다 — 한 번 더 기다렸다 다시 잰다.
    await page.evaluate(() => new Promise(r => {
      if (typeof speechSynthesis === 'undefined') return r()
      speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => r(); setTimeout(r, 2000)
    })).catch(() => {})
    report.probe = await page.evaluate(PROBE)
    rec('랜딩 로드', true, report.probe.ua.slice(0, 90))
    rec('color-mix 지원', report.probe.css['color-mix'])
    rec('WebGL 사용 가능', report.probe.webgl.webgl, String(report.probe.webgl.renderer).slice(0, 80))
    rec('한국어 TTS 음성 존재', report.probe.koVoices.length > 0,
      `${report.probe.voicesRaw ? report.probe.voicesRaw.length : 'null'}개 중 ko ${report.probe.koVoices.length}개`)

    report.landingMotion = await proveMotion(page, 'canvas')
    rec('랜딩 프레임 진행', !!report.landingMotion.ok, JSON.stringify(report.landingMotion))
    await shot('01-landing')

    // 화면이 실제로 그려졌는가 — 흰 화면/빈 body면 여기서 잡힌다.
    const landing = await page.evaluate(() => ({
      chars: document.body.innerText.length,
      canvases: document.querySelectorAll('canvas').length,
      bg: getComputedStyle(document.body).backgroundColor,
    }))
    rec('랜딩 콘텐츠 렌더', landing.chars > 50, JSON.stringify(landing))

    let r = await tap(page, '캠페인 시작')
    if (!r.ok) r = await tap(page, '캠페인')
    rec('랜딩 → 캠페인', r.ok, r.why)
    await page.waitForTimeout(1200)
    await shot('02-hub', true)

    r = await tap(page, '준비')
    rec('허브 → 경기 준비(전술 센터)', r.ok, r.why)
    await page.waitForTimeout(1800)
    await shot('03-warroom', true)
    const war = await page.evaluate(() => {
      const t = document.body.innerText
      return { chars: t.length, lineup: /선발|라인업/.test(t), tactics: /전술|압박|라인/.test(t) }
    })
    rec('전술 센터 렌더', war.chars > 300 && war.lineup && war.tactics, JSON.stringify(war))

    r = await tap(page, '킥오프')
    rec('전술 센터 → 킥오프', r.ok, r.why)
    await page.waitForTimeout(3000)
    await shot('04-entrance')
    // 입장 연출: 오디오 컨텍스트가 살아 있는가(자동재생 정책의 실제 결과).
    report.audioAtEntrance = await page.evaluate(() => {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return { supported: false }
      const c = new AC()
      const st = c.state
      c.close?.()
      return { supported: true, state: st }
    })
    rec('AudioContext 생성', !!report.audioAtEntrance.supported, JSON.stringify(report.audioAtEntrance))
    report.entranceMotion = await proveMotion(page, 'canvas')
    rec('입장 연출 프레임 진행', !!report.entranceMotion.ok, JSON.stringify(report.entranceMotion))

    const skip = await tap(page, '건너뛰기')
    if (skip.ok) rec('입장 건너뛰기', true)
    await page.waitForTimeout(4000)
    await shot('05-match')

    // 경기 렌더러 실체 — 3D(three)인지 Pixi인지 SVG 폴백인지.
    report.renderer = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')].map(c => ({
        cls: c.className, w: c.width, h: c.height,
        gl: !!(c.getContext('webgl2', {}) || c.getContext('webgl', {})),
      }))
      return {
        canvases: cs, svg: document.querySelectorAll('svg.pv-root').length,
        has3d: !!document.querySelector('canvas.m3d-canvas'),
      }
    })
    rec('경기 캔버스 존재', report.renderer.canvases.length > 0 || report.renderer.svg > 0,
      JSON.stringify(report.renderer).slice(0, 300))
    report.matchMotion = await proveMotion(page, 'canvas, svg.pv-root')
    rec('경기 프레임 진행', !!report.matchMotion.ok, JSON.stringify(report.matchMotion))

    // 배속 2x — 동적 인터랙션이자 완주 시간 단축.
    for (const label of ['2x', '×2', '2배']) { if ((await tap(page, label)).ok) { rec('배속 2x', true, label); break } }

    // 90분 관전. 경기는 하이드레이션 브레이크·순간 프롬프트로 **스스로 멈춘다** —
    // 감독이 재개하지 않으면 시계가 흐르지 않는다. 그래서 폴링하며 재개를 눌러 준다.
    // (하프타임은 여기서 멈춰 작전판을 검증한 뒤 [후반 시작]으로 넘긴다.)
    // store 조회에 **반드시 상한을 건다**. 다른 갈래가 src를 편집 중이면 Vite HMR이 모듈을
    // 다시 굽는 동안 dynamic import가 영원히 안 돌아온다(실측: 20분 정지). 그러면 예산
    // 검사가 있는 루프 머리에 도달하지 못해 감사 전체가 멈춘다.
    const clock = () => Promise.race([
      page.evaluate(async () => {
        const m = await import('/src/game/matchStore.ts')
        const s = m.useMatchStore.getState()
        return { minute: s.minute, phase: s.phase, reason: s.pauseReason ?? null, score: s.score }
      }),
      new Promise(res => setTimeout(() => res(null), 8000)),
    ]).catch(() => null)

    const run = async (until, budget, tag) => {
      const t = Date.now()
      let last = null
      while (Date.now() - t < budget) {
        const c = await clock()
        if (!c) { await page.waitForTimeout(1500); continue } // 일시적 HMR 정지 — 예산까지 계속 본다
        last = c
        if (until(c)) return { ok: true, c }
        if (c.phase !== 'playing') {
          // 정지 상태 — 코치 회의·순간 프롬프트 같은 모달이 재개 버튼을 덮는다. 먼저 치운다.
          // '닫기'·'계속' 같은 애매한 라벨은 쓰지 않는다 — 랜딩으로 빠져나가 경기가 초기화된다(실측).
          await tap(page, '감독 판단대로 간다')
          let done = false
          // 'pre'(입장 연출 직후)는 [킥오프]로만 풀린다 — 이 라벨이 빠지면 영원히 멈춰 있다.
          const labels = c.phase === 'pre'
            ? ['킥오프', '건너뛰기', '전술 확정']
            : ['전술 확정', '후반 시작', '재개']
          for (const label of labels) { if ((await tap(page, label)).ok) { done = true; break } }
          if (!done) await page.waitForTimeout(1500)
        } else await page.waitForTimeout(1500)
      }
      return { ok: false, c: last, tag }
    }

    const half = await run(c => c.phase === 'halftime' || c.minute >= 45, HALF_BUDGET, 'half')
    rec('전반 진행 → 하프타임 도달', half.ok, JSON.stringify(half.c))
    await shot('06-halftime', true)

    // 하프타임 작전판 — 실제로 조작 가능한가(교체 탭). 코치 회의 모달을 먼저 치운다.
    await tap(page, '감독 판단대로 간다')
    const mt = await tap(page, '감독 타임')
    const subTab = await tap(page, '교체')
    rec('하프타임 작전판 조작', mt.ok || subTab.ok, `감독타임 ${mt.ok} 교체탭 ${subTab.ok}`)
    await shot('07-tactics', true)

    // 후반 재개 → 풀타임
    for (const label of ['후반 시작', '전술 확정', '재개']) { if ((await tap(page, label)).ok) break }
    await page.waitForTimeout(1500)
    const full = await run(c => c.phase === 'fulltime' || c.minute >= 90, HALF_BUDGET, 'full')
    rec('후반 진행 → 풀타임 도달', full.ok, JSON.stringify(full.c))
    await shot('08-fulltime', true)

    // 기자회견 → 신문
    for (const label of ['기자회견', '다음', '계속']) { if ((await tap(page, label)).ok) break }
    await page.waitForTimeout(1500)
    await shot('09-press', true)
    const press = await page.evaluate(() => document.body.innerText.slice(0, 400))
    rec('기자회견 화면', /\?|질문|기자/.test(press), press.replace(/\n/g, ' ').slice(0, 120))
    // 답변 3회
    for (let i = 0; i < 4; i++) {
      const ans = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].filter(e => e.offsetParent && e.textContent.trim().length > 4)
        if (!b.length) return false
        b[0].click(); return true
      })
      if (!ans) break
      await page.waitForTimeout(900)
    }
    await shot('10-newspaper', true)
    const paper = await page.evaluate(() => document.body.innerText.slice(0, 300))
    rec('신문 1면 도달', /FICTION|일간|축구/.test(paper), paper.replace(/\n/g, ' ').slice(0, 120))
  } catch (e) {
    rec('주행 중단', false, String(e).slice(0, 300))
    await shot('99-crash', true)
  }

  report.elapsedMs = Date.now() - t0
  report.consoleErrors = console_.filter(c => c.type === 'error')
  report.consoleWarnings = console_.filter(c => c.type === 'warning')
  // 원본 console 배열은 Firefox에서 수만 줄이 된다(리포트가 5MB를 넘었다). 저장소에 남길 것은
  // **에러·경고 전문**이지 info/debug 잡음이 아니다 — 원본은 앞 200줄만 표본으로 남긴다.
  report.consoleSample = console_.slice(0, 200)
  report.consoleTotal = console_.length
  delete report.console
  await writeFile(join(OUT, `${eng}.json`), JSON.stringify(report, null, 2))
  console.log(`[${eng}] 완료 — 에러 ${errors.length} · console.error ${report.consoleErrors.length} · warn ${report.consoleWarnings.length} · ${Math.round(report.elapsedMs / 1000)}s`)
  await ctx.close(); await browser.close()
}
