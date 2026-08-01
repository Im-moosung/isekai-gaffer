#!/usr/bin/env node
// 순간 제안 배너 ↔ 화면 사건 **동기 실측** — 실제 Chrome(headless:false)을 몰아
// `"실점 직후입니다 — 감독 타임을 쓰시겠습니까?"` 배너가 그 분의 결과 **뒤에** 뜨는지 잰다.
//
// tools/commentary-sync/live.mjs의 계측 규약을 그대로 복제했다(같은 결함의 배너판이므로
// 같은 자로 재야 두 수치를 나란히 놓을 수 있다). 달라진 점만 적는다:
//  · 계측 대상이 speechSynthesis가 아니라 **DOM에 배너가 나타난 시각**이다.
//  · 배너가 뜨는 분이 항상 골 분은 아니다(momentum-lost·fatigue·clutch는 결과 노출이
//    없는 분에서도 뜬다). 그래서 표본을 두 부류로 갈라 보고한다:
//      [A] 그 분에 **화면 결과 사건이 있는** 표본 → 배너가 그 사건 뒤인지 잰다(핵심 계약)
//      [B] 결과 사건이 없는 분(revealMs=0) → 미룰 결과가 없으므로 분 시작 대비만 적는다
//  · 데모 화면의 시드가 고정이라(App.tsx의 DEMO_SEED) 표본이 한 경기에 5건 이하다.
//    Vite가 내려 주는 App.tsx 소스를 **네트워크 단에서** 바꿔치기해 시드를 갈아 끼운다
//    (저장소 파일은 건드리지 않는다 — 계측기가 코드를 남기면 안 된다).
//
// 왜 headless가 아닌가: 백그라운드/헤드리스 탭은 rAF가 정지해 안무가 얼어붙고 재생 리듬
// 자체가 달라진다. 실제 창을 띄우고 **연속 프레임 픽셀 diff**로 진행을 먼저 증명한 뒤 잰다.
//
// 사용: node tools/moment-sync/live.mjs [--seeds 20260724,777,4242] [--ms 300000]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

// ★ --root: 저장소가 아닌 **스냅샷 디렉터리**에서 재도 되게 열어 뒀다. 여러 에이전트가
//   같은 저장소를 동시에 고치면 Vite HMR이 계측 도중 화면을 갈아 끼우거나 컴파일 오류로
//   앱을 죽인다(실제로 겪었다: 90분 완주가 8분에서 멎었다). 스냅샷을 뜨고 그쪽을 재면
//   측정 대상이 계측 중에 변하지 않는다.
const ROOT = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : resolve(import.meta.dirname, '../..'))
const OUT = join(ROOT, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const RUN_MS = Number(arg('ms', 300000))
const SEEDS = String(arg('seeds', '20260724,777,4242')).split(',').map(s => s.trim()).filter(Boolean)

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
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})

// ── 페이지 안에 심는 관찰자 ────────────────────────────────────────
// 전부 페이지의 한 시계(performance.now)로 찍는다 — 프로세스 간 시계 차를 없앤다.
const INIT = () => {
  const rec = { screen: [], banner: [], minute: [] }
  window.__momentRec = rec
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)

  const watch = () => {
    const root = document.body
    if (!root) return
    let lastScore = ''
    let lastMinute = ''
    let minuteNow = 0
    let dramaOn = false
    let vignetteOn = false
    let lastRow = ''
    let bannerOn = ''
    const scan = () => {
      const clock = document.querySelector('.bc-scorebug__clock')
      const minute = clock ? (clock.textContent || '').replace(/[^0-9]/g, '') : ''
      if (minute && minute !== lastMinute) {
        lastMinute = minute
        minuteNow = Number(minute)
        rec.minute.push({ t: now(), minute: minuteNow })
      }
      // ── 화면 결과 사건(= 노출 게이트가 여는 것들) ──
      const nums = document.querySelectorAll('.bc-scorebug__num')
      const score = nums.length >= 2 ? `${nums[0].textContent}-${nums[1].textContent}` : ''
      if (score && score !== lastScore) {
        if (lastScore) rec.screen.push({ t: now(), minute: minuteNow, kind: 'score', value: score })
        lastScore = score
      }
      const drama = !!document.querySelector('.ms-drama')
      if (drama && !dramaOn) rec.screen.push({ t: now(), minute: minuteNow, kind: 'drama' })
      dramaOn = drama
      const vig = !!document.querySelector('.ms-vignette')
      if (vig && !vignetteOn) rec.screen.push({ t: now(), minute: minuteNow, kind: 'danger' })
      vignetteOn = vig
      const rows = document.querySelectorAll('.bc-ticker__line, [class*="ticker"] li')
      const row = rows.length > 0 ? (rows[rows.length - 1].textContent || '') : ''
      if (row && row !== lastRow) {
        lastRow = row
        rec.screen.push({ t: now(), minute: minuteNow, kind: 'ticker', value: row.slice(0, 30) })
      }
      // ── 계측 대상: 순간 제안 배너가 **나타난** 시각 ──
      const el = document.querySelector('.ms-banner--moment .ms-banner__text')
      const text = el ? (el.textContent || '') : ''
      if (text && text !== bannerOn) {
        rec.banner.push({ t: now(), minute: minuteNow, text: text.slice(0, 40) })
      }
      bannerOn = text
    }
    new MutationObserver(scan).observe(root, { subtree: true, childList: true, characterData: true })
    setInterval(scan, 30)
  }
  document.addEventListener('DOMContentLoaded', watch)
}

/** 한 경기를 끝까지 굴리고 기록을 돌려준다. */
async function runMatch(seed) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => logs.push(`[error] ${e.message}`))
  // 시드 바꿔치기 — Vite가 변환해 내려 주는 App.tsx 모듈에서 상수 하나만 갈아 끼운다.
  await page.route('**/src/App.tsx*', async route => {
    const res = await route.fetch()
    const body = (await res.text()).replace(/const DEMO_SEED = \d+/, `const DEMO_SEED = ${seed}`)
    await route.fulfill({ response: res, body })
  })
  await page.addInitScript(INIT)

  let frameProof = 'n/a'
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
    await page.getByRole('button', { name: '바로 지휘하기' }).click()
    await page.getByRole('button', { name: '킥오프' }).click()

    // ① 프레임이 실제로 진행 중임을 픽셀 diff로 먼저 증명한다(rAF 스로틀 함정).
    const stage = page.locator('.ms-stage')
    await stage.waitFor({ state: 'visible', timeout: 20000 })
    const a = await page.screenshot()
    await page.waitForTimeout(300)
    const b = await page.screenshot()
    frameProof = a.equals(b) ? 'FAIL(정지)' : 'OK(픽셀 변화 있음)'
    console.log(`[seed ${seed}] 프레임 진행 ${frameProof}`)

    const skip = page.getByRole('button', { name: /건너뛰기/ })
    if (await skip.isVisible().catch(() => false)) await skip.click()

    // ② 경기를 굴린다. 브레이크·하프타임은 계측기가 눌러 이어 준다.
    //    ★ 순간 제안은 **흘려보낸다**로 치운다 — 그래야 다음 유형이 뜰 자리가 생겨
    //      한 경기에서 표본이 여러 건 나온다(제안은 하나만 살아 있을 수 있다).
    const until = Date.now() + RUN_MS
    while (Date.now() < until) {
      await page.waitForTimeout(700)
      for (const name of ['전술 확정', '후반 시작', '나중에', '흘려보낸다']) {
        const btn = page.getByRole('button', { name, exact: true })
        if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
      }
      const done = await page.evaluate(() => !!document.querySelector('.ms-report, [class*="fulltime"]'))
      if (done) break
    }
    const rec = await page.evaluate(() => window.__momentRec)
    // 도달 분은 **최댓값**으로 센다 — 종료 후 리포트 화면에서 시계가 사라지면
    // 마지막 기록이 0으로 남는다(마지막 값을 쓰면 90분 완주가 0분으로 보인다).
    const lastMinute = rec.minute.reduce((mx, r) => Math.max(mx, r.minute), 0)
    console.log(`[seed ${seed}] 도달 ${lastMinute}분 · 배너 ${rec.banner.length}건 · 화면 사건 ${rec.screen.length}건`)
    return { seed, frameProof, lastMinute, ...rec }
  } catch (e) {
    console.error(`[seed ${seed}] 실패:`, e.message)
    console.error(logs.slice(-20).join('\n'))
    return { seed, frameProof, lastMinute: 0, screen: [], banner: [], minute: [] }
  } finally {
    await page.close()
  }
}

try {
  const runs = []
  for (const seed of SEEDS) runs.push(await runMatch(seed))
  await writeFile(join(OUT, 'moment-sync.json'), JSON.stringify(runs, null, 2))

  // ── 표: 배너 vs 그 분의 화면 결과 사건 ────────────────────────────
  console.log('\n### 순간 제안 배너 ↔ 화면 결과 (음수 = 배너가 먼저 = 예지력)')
  console.log('| 시드 | 분 | 분 시작(ms) | 결과 노출(ms) | 배너(ms) | 결과 대비 | 문구 |')
  console.log('|---:|---:|---:|---:|---:|---:|---|')
  const withResult = []
  const noResult = []
  for (const run of runs) {
    for (const b of run.banner) {
      const start = [...run.minute].reverse().find(m => m.t <= b.t)
      const t0 = start ? start.t : 0
      // 그 분의 **첫** 결과 사건. 배너와 같은 분의 것만 본다(다음 분 것과 짝지으면 무의미).
      const reveal = run.screen.find(s => s.minute === b.minute && s.t >= t0)
      const sinceStart = b.t - t0
      if (reveal) {
        const delta = b.t - reveal.t
        withResult.push(delta)
        console.log(`| ${run.seed} | ${b.minute} | ${t0} | ${reveal.t} (${reveal.kind}) | ${b.t} | ${delta >= 0 ? '+' : ''}${delta} | ${b.text} |`)
      } else {
        noResult.push(sinceStart)
        console.log(`| ${run.seed} | ${b.minute} | ${t0} | — | ${b.t} | (결과 없음 +${sinceStart}) | ${b.text} |`)
      }
    }
  }
  const stat = xs => xs.length === 0 ? '표본 없음'
    : `표본 ${xs.length} · 평균 ${Math.round(xs.reduce((s, v) => s + v, 0) / xs.length)}ms · 최소 ${Math.min(...xs)}ms · 최대 ${Math.max(...xs)}ms`
  console.log(`\n[A] 결과 사건이 있는 분: ${stat(withResult)} · **음수(예지력) ${withResult.filter(d => d < 0).length}건**`)
  console.log(`[B] 결과 사건이 없는 분(미룰 결과 없음): ${stat(noResult)}`)
  console.log(`\n경기 ${runs.length}회 · 프레임 진행 증명: ${runs.map(r => `${r.seed}:${r.frameProof}`).join(' / ')}`)
  console.log(`도달 분: ${runs.map(r => `${r.seed}:${r.lastMinute}'`).join(' / ')}`)
} finally {
  await browser.close()
  await server.close()
}
