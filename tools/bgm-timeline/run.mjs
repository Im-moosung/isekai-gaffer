#!/usr/bin/env node
// BGM 배선 **실측** — 어느 곡이 언제 재생·정지·크로스페이드했는가.
//
// 왜 브라우저인가: jsdom엔 Web Audio가 없어 단위 테스트는 그래프 조작만 검증한다.
// 실제 자동재생 정책(제스처 전 무음)·디코드·게인 램프 곡선은 진짜 Chrome에서만 나온다.
//
// 함정 하나: **백그라운드 탭은 rAF를 멈춘다.** 그래서 headless:false로 띄우고,
// 측정 전에 픽셀 diff로 프레임이 실제로 진행 중인지 먼저 증명한다.
//
// 계측 방식: Vite dev의 모듈 그래프를 그대로 import해(`/src/audio/bgm.ts`) 앱과 **같은
// 모듈 인스턴스**의 bgmState()를 25 ms로 폴링한다. 게인 값은 진짜 AudioParam의
// 현재 값이므로 크로스페이드 곡선이 그대로 찍힌다.
//
// 사용: node tools/bgm-timeline/run.mjs [--w 1280 --h 800] [--speed 2]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'docs/audit/bgm')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1280))
const H = Number(arg('h', 800))

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
})
await server.listen()

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  // ★ --autoplay-policy 를 건드리지 않는다. 자동재생 정책을 그대로 두어야
  //   "첫 클릭 전 무음"이 실제 브라우저 규칙으로 검증된다.
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
const netBgm = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))
page.on('requestfinished', r => {
  if (r.url().includes('/bgm/')) netBgm.push({ t: Date.now(), url: r.url().split('/').pop() })
})

async function installProbe() {
  await page.evaluate(async () => {
    if (window.__bgmRec) return
    const bgm = await import('/src/audio/bgm.ts')
    const sfx = await import('/src/audio/sfx.ts')
    window.__bgm = bgm
    window.__sfx = sfx
    window.__t0 = performance.now()
    const rec = []
    window.__bgmRec = rec
    window.__mark = label => rec.push({ t: Math.round(performance.now() - window.__t0), mark: label })
    setInterval(() => {
      const s = bgm.bgmState()
      const bus = sfx.audioBus()
      rec.push({
        t: Math.round(performance.now() - window.__t0),
        loop: s.loop, lg: +s.loopGain.toFixed(4),
        sting: s.sting, sg: +s.stingGain.toFixed(4),
        fade: s.fading.map(([k, g]) => `${k}:${g.toFixed(3)}`).join(','),
        duck: +s.duck.toFixed(4),
        paused: s.paused,
        ctx: bus ? bus.ctx.state : 'none',
        master: bus ? +bus.master.gain.value.toFixed(3) : null,
      })
    }, 25)
  })
}

/** 두 스크린샷의 픽셀 차이 비율(0~1). rAF가 실제로 도는지 증명하는 데 쓴다. */
async function frameDiff(ms = 400) {
  const a = await page.screenshot({ type: 'png' })
  await sleep(ms)
  const b = await page.screenshot({ type: 'png' })
  if (a.length !== b.length) return 1
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff / a.length
}

const marks = []
async function mark(label) {
  const t = await page.evaluate(l => {
    window.__mark?.(l)
    return Math.round(performance.now() - window.__t0)
  }, label)
  marks.push({ t, label })
  console.log(`  · ${String(t).padStart(6)}ms  ${label}`)
  return t
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await installProbe()
  await mark('랜딩 도착')

  // ── 1. 제스처 전 무음 ────────────────────────────────────────
  await sleep(1500)
  const preClick = await page.evaluate(() => window.__bgm.bgmState())
  const preFetch = netBgm.length
  console.log(`\n[1] 첫 클릭 전 — ready=${preClick.ready} loop=${preClick.loop} bgm요청=${preFetch}건`)

  // ── 2. 랜딩 → 허브(M02) ──────────────────────────────────────
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await mark('캠페인 시작 클릭(첫 제스처)')
  await page.getByRole('button', { name: /준비하기/ }).waitFor({ timeout: 15000 })
  await sleep(2500)

  // ── 3. 허브 → 워룸(M03) 크로스페이드 ─────────────────────────
  await page.getByRole('button', { name: /준비하기/ }).click()
  await mark('워룸 진입')
  await sleep(2500)
  console.log(`\n[프레임 진행 증명 · 워룸] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)

  // ── 4. 킥오프 → 입장 연출(M06, full) ─────────────────────────
  await page.getByRole('button', { name: '킥오프' }).click()
  const tKick = await mark('킥오프(입장 연출 시작)')
  const overlay = page.locator('[data-testid="entrance-overlay"]')
  await overlay.waitFor({ state: 'visible', timeout: 20000 })
  console.log(`\n[프레임 진행 증명 · 입장] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)
  await overlay.waitFor({ state: 'detached', timeout: 150000 })
  const tWhistle = await mark('입장 종료 = 킥오프 휘슬')
  console.log(`\n[4] 입장 실측 길이 = ${tWhistle - tKick}ms`)

  // ── 5. 인플레이 — 음악 없음 ──────────────────────────────────
  await page.getByRole('group', { name: '재생 속도' }).getByRole('button', { name: '2x' }).click()
  await mark('2배속')
  await sleep(4000)
  console.log(`\n[프레임 진행 증명 · 인플레이] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)

  // ── 6. 일시정지 반응 ─────────────────────────────────────────
  await page.getByRole('button', { name: '일시정지' }).click()
  await mark('일시정지')
  await sleep(1200)
  await page.getByRole('button', { name: '재생' }).click()
  await mark('재생 재개')

  // ── 7. 덕킹(골 경로와 같은 함수) ─────────────────────────────
  await page.evaluate(() => window.__bgm.duck())
  await mark('duck() 호출')
  await sleep(3500)

  // ── 8. 하프타임 · 클러치 · 풀타임까지 흘려보낸다 ─────────────
  const deadline = Date.now() + 240000
  let lastMin = -1
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const el = document.querySelector('.bc-scorebug__clock')
      const done = !!document.querySelector('.ms-report')
      return { clock: el?.textContent?.trim() ?? '', done }
    })
    if (st.done) break
    const m = Number((st.clock.match(/\d+/) ?? [0])[0])
    if (m !== lastMin && (m === 45 || m === 80 || m === 90)) {
      await mark(`경기 ${m}분`)
      lastMin = m
    }
    // 하프타임 작전판이 뜨면 확정하고 후반으로.
    const confirm = page.getByRole('button', { name: /전술 확정|후반 시작|계속/ })
    if (await confirm.count()) {
      await sleep(6000) // M07 스팅 → M04 루프 전환을 관측할 시간
      await mark('하프타임 작전판 — 전술 확정 직전')
      await confirm.first().click().catch(() => {})
      await mark('후반 재개')
    }
    await sleep(500)
  }
  await mark('풀타임 리포트')
  await sleep(4000)

  const rec = await page.evaluate(() => window.__bgmRec)
  await writeFile(join(OUT, 'timeline.json'), JSON.stringify({ marks, rec, netBgm }, null, 2))

  // ── 요약 표: 트랙 구간 ───────────────────────────────────────
  console.log('\n### 실측 타임라인 — 트랙 구간')
  console.log('| 채널 | 트랙 | 시작(ms) | 종료(ms) | 길이(ms) | 최대 게인 |')
  console.log('|---|---|---:|---:|---:|---:|')
  for (const ch of ['loop', 'sting']) {
    const key = ch === 'loop' ? 'lg' : 'sg'
    let cur = null
    const spans = []
    for (const r of rec) {
      if (r.mark) continue
      const track = r[ch]
      if (track !== cur?.track) {
        if (cur) spans.push(cur)
        cur = track ? { track, from: r.t, to: r.t, peak: r[key] } : null
      }
      if (cur) {
        cur.to = r.t
        cur.peak = Math.max(cur.peak, r[key])
      }
    }
    if (cur) spans.push(cur)
    for (const s of spans) {
      console.log(`| ${ch} | ${s.track} | ${s.from} | ${s.to} | ${s.to - s.from} | ${s.peak.toFixed(3)} |`)
    }
  }

  // ── 크로스페이드 실측 ────────────────────────────────────────
  console.log('\n### 크로스페이드(게인 램프) 실측')
  const rises = []
  let prev = null
  for (const r of rec) {
    if (r.mark) continue
    if (r.loop && r.loop !== prev?.loop) rises.push({ track: r.loop, t0: r.t, done: null })
    const cur = rises[rises.length - 1]
    if (cur && cur.track === r.loop && cur.done == null && r.lg >= 0.79) cur.done = r.t
    prev = r
  }
  for (const s of rises) {
    console.log(`  ${s.track} 페이드인 ${s.done == null ? '미완' : `${s.done - s.t0}ms`}`)
  }
  const overlaps = rec.filter(r => !r.mark && r.fade && r.loop)
  console.log(`  크로스페이드 중첩 관측: ${overlaps.length}샘플 (예: ${overlaps.slice(0, 4).map(r => `${r.t}ms ${r.loop}:${r.lg.toFixed(2)} ← ${r.fade}`).join(' | ')})`)

  const ducked = rec.filter(r => !r.mark && r.duck < 0.99)
  if (ducked.length) {
    console.log(`\n### 덕킹: 최저 ${Math.min(...ducked.map(r => r.duck)).toFixed(3)}배 · ` +
      `${ducked[0].t}ms → ${ducked[ducked.length - 1].t}ms (${ducked[ducked.length - 1].t - ducked[0].t}ms)`)
  }
  const pausedRows = rec.filter(r => !r.mark && r.paused)
  if (pausedRows.length) {
    console.log(`### 일시정지: ${pausedRows[0].t}ms~${pausedRows[pausedRows.length - 1].t}ms · ` +
      `그 구간 loop 게인 최대 ${Math.max(...pausedRows.map(r => r.lg)).toFixed(3)}`)
  }
  console.log(`\n### 네트워크: ${netBgm.map(n => n.url).join(', ') || '없음'}`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'run.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
