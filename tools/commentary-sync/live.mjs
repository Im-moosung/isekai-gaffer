#!/usr/bin/env node
// 중계 발화 ↔ 화면 사건 **동기 실측** — 실제 Chrome(headless:false)을 몰아
// `speechSynthesis.speak` 호출 시각과 화면에 결과가 나타난 시각의 차를 잰다.
//
// ⚠️ 2026-08-02부터 이 도구는 **아무것도 잡지 못한다.** 중계가 미리 구운 mp3 클립으로만
//    나가고 `speechSynthesis` 폴백이 사라져(근거: src/audio/commentary-tts.ts 헤더),
//    후킹 대상 호출 자체가 일어나지 않는다. 아래 pitch 기반 화자 구분(ROLE_PITCH)도
//    같은 이유로 유물이다 — 이제 화자는 클립 자체가 다르다. 다시 쓰려면 후킹 지점을
//    `commentary-mp3.playLine`으로 옮겨야 한다(계측 규약은 그대로 쓸 수 있다).
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭은 rAF·타이머가 스로틀되어 캔버스가
// 얼어붙고 재생 리듬 자체가 달라진다. 실제 창을 띄우고 **연속 프레임 픽셀 diff**로
// 진행을 먼저 증명한 뒤에 계측한다(tools/entrance-frame/live.mjs와 같은 규약).
//
// 계측 방법(전부 페이지 안에서 한 시계로 — 프로세스 간 시계 차를 없앤다):
//  · `speechSynthesis.speak`를 후킹해 (t, 문장, pitch, rate)를 기록한다.
//    pitch로 화자를 가른다(캐스터 1.00~1.35 / 해설위원 0.75 — commentary-tts.ROLE_PITCH).
//  · MutationObserver로 **화면에 결과가 나타난 시각**을 잡는다:
//      - 스코어버그 스코어 텍스트 변화        → 골이 화면에 반영된 순간
//      - `.ms-drama`(GOAL/실점 대형 타이포) 등장 → 같은 순간의 시각 신호
//      - 티커에 그 분의 줄이 추가되는 순간
//  · 분 표시(스코어버그 시계)가 바뀌는 시각도 함께 기록해 "분 시작"을 기준점으로 둔다.
//
// 사용: node tools/commentary-sync/live.mjs [--minutes 90] [--w 1600 --h 900]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const RUN_MS = Number(arg('ms', 240000))

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
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

// ── 후킹은 **문서 스크립트보다 먼저** 심는다 ──────────────────────
await page.addInitScript(() => {
  const rec = { speak: [], screen: [], minute: [] }
  window.__syncRec = rec
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)

  const install = () => {
    const synth = window.speechSynthesis
    if (!synth || synth.__hooked) return
    synth.__hooked = true
    const orig = synth.speak.bind(synth)
    synth.speak = u => {
      rec.speak.push({ t: now(), text: String(u.text ?? ''), pitch: u.pitch, rate: u.rate })
      // 실제로 소리를 내지는 않는다(무음 실행) — 발화 길이가 계측을 붙잡지 않게.
      // 순서·시각만 필요하므로 원본 호출은 그대로 두되 볼륨을 0으로 낮춘다.
      u.volume = 0
      return orig(u)
    }
  }
  install()
  document.addEventListener('DOMContentLoaded', install)

  const watch = () => {
    const root = document.body
    if (!root) return
    let lastScore = ''
    let lastMinute = ''
    let dramaOn = false
    const scan = () => {
      const nums = document.querySelectorAll('.bc-scorebug__num')
      const score = nums.length >= 2 ? `${nums[0].textContent}-${nums[1].textContent}` : ''
      const clock = document.querySelector('.bc-scorebug__clock')
      const minute = clock ? (clock.textContent || '').replace(/[^0-9]/g, '') : ''
      if (score && score !== lastScore) {
        if (lastScore) rec.screen.push({ t: now(), kind: 'score', value: score })
        lastScore = score
      }
      if (minute && minute !== lastMinute) {
        rec.minute.push({ t: now(), minute: Number(minute) })
        lastMinute = minute
      }
      const drama = !!document.querySelector('.ms-drama')
      if (drama && !dramaOn) rec.screen.push({ t: now(), kind: 'drama' })
      dramaOn = drama
      // 티커의 마지막 줄이 바뀌는 순간(= 그 분의 문장이 화면에 뜬 시각).
      const rows = document.querySelectorAll('[class*="ticker"] li, .bc-ticker__line')
      const lastRow = rows.length > 0 ? (rows[rows.length - 1].textContent || '') : ''
      if (lastRow && lastRow !== rec.__lastRow) {
        rec.__lastRow = lastRow
        rec.screen.push({ t: now(), kind: 'ticker', value: lastRow.slice(0, 30) })
      }
    }
    new MutationObserver(scan).observe(root, { subtree: true, childList: true, characterData: true })
    setInterval(scan, 30)
  }
  document.addEventListener('DOMContentLoaded', watch)
})

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()

  // ① 화면이 실제로 갱신되는지부터 증명한다(rAF 스로틀 함정).
  const stage = page.locator('.ms-stage')
  await stage.waitFor({ state: 'visible', timeout: 20000 })
  const a = await page.screenshot()
  await page.waitForTimeout(300)
  const b = await page.screenshot()
  console.log(`프레임 진행 ${a.equals(b) ? 'FAIL(정지)' : 'OK(픽셀 변화 있음)'}`)

  // ② 입장 연출은 건너뛴다(이번 계측 대상이 아니다).
  const skip = page.getByRole('button', { name: /건너뛰기/ })
  if (await skip.isVisible().catch(() => false)) await skip.click()

  // ③ 경기를 굴리며 기록한다.
  //    ★ 수분 브레이크·하프타임·감독 타임에서 재생이 **멈춘다**. 사람이 눌러야 이어지므로
  //      계측기가 대신 눌러 준다(누르지 않으면 22분에서 영원히 서 있는다 — 실제로 겪었다).
  const until = Date.now() + RUN_MS
  while (Date.now() < until) {
    await page.waitForTimeout(1000)
    for (const name of ['전술 확정', '후반 시작', '나중에']) {
      const b = page.getByRole('button', { name, exact: true })
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
    }
    const done = await page.evaluate(() => !!document.querySelector('.ms-report, [class*="fulltime"]'))
    if (done) break
  }

  const rec = await page.evaluate(() => window.__syncRec)
  await writeFile(join(OUT, 'commentary-sync.json'), JSON.stringify(rec, null, 2))

  // ── 표: 화면 결과 → 발화 지연 ──────────────────────────────────
  // 캐스터는 pitch ≥ 1.0, 해설위원은 0.75(commentary-tts.ROLE_PITCH).
  const casters = rec.speak.filter(s => s.pitch >= 0.95)
  const analysts = rec.speak.filter(s => s.pitch < 0.95)

  // ── 표 ①: 분 시작 대비 발화 지연 ────────────────────────────────
  // 예전 코드는 분에 들어서는 **즉시** 말했으므로 이 값이 구조적으로 0이었다.
  console.log('\n### 분 시작 → 캐스터 발화 지연')
  console.log('| 분 | 분 시작(ms) | 캐스터 발화(ms) | 지연(ms) | 문장 |')
  console.log('|---:|---:|---:|---:|---|')
  const lags = []
  for (let i = 0; i < rec.minute.length; i++) {
    const m = rec.minute[i]
    const next = rec.minute[i + 1]
    const say = casters.find(s => s.t >= m.t && (!next || s.t < next.t))
    if (!say) continue
    lags.push(say.t - m.t)
    console.log(`| ${m.minute} | ${m.t} | ${say.t} | +${say.t - m.t} | ${say.text.slice(0, 30)} |`)
  }
  if (lags.length > 0) {
    const mean = Math.round(lags.reduce((s, v) => s + v, 0) / lags.length)
    console.log(`\n표본 ${lags.length} · 평균 +${mean}ms · 최소 +${Math.min(...lags)}ms · 최대 +${Math.max(...lags)}ms`)
  }

  // ── 표 ②: 화면 사건 대비 발화(음수 = 예지력) ─────────────────────
  const rows = []
  for (const ev of rec.screen) {
    // ★ 짝짓기는 **그 사건 이후 첫 캐스터 발화**로만 한다. 창을 뒤로 열어 두면
    //   한 발화가 여러 화면 사건에 중복으로 짝지어져 인위적인 음수가 생긴다.
    const next = casters.find(s => s.t >= ev.t)
    if (!next || next.t - ev.t > 4000) continue
    rows.push({ kind: ev.kind, screenT: ev.t, speakT: next.t, delta: next.t - ev.t, text: next.text.slice(0, 28) })
  }
  console.log('\n### 화면 사건 → 캐스터 발화 (음수 = 해설이 먼저 = 예지력)')
  console.log('| 화면 사건 | 화면 시각(ms) | 캐스터 발화(ms) | 차이(ms) | 문장 |')
  console.log('|---|---:|---:|---:|---|')
  for (const r of rows) {
    console.log(`| ${r.kind} | ${r.screenT} | ${r.speakT} | ${r.delta >= 0 ? '+' : ''}${r.delta} | ${r.text} |`)
  }

  // ── 표 ③: 화자 순서(캐스터 → 해설위원) ──────────────────────────
  let analystAfter = 0
  for (const an of analysts) {
    const prev = [...casters].reverse().find(c => c.t <= an.t)
    if (prev) analystAfter++
  }
  console.log(`\n해설위원 발화 ${analysts.length}건 중 캐스터 뒤 ${analystAfter}건`)
  console.log(`\n발화 ${rec.speak.length}건 · 화면 사건 ${rec.screen.length}건 · 분 전환 ${rec.minute.length}건`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'commentary-sync.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
