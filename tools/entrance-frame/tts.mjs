#!/usr/bin/env node
// 입장 소개 **TTS 동기 실측** — 캐스터가 이름을 부르는 순간 그 선수가 하이라이트돼 있는가.
//
// 계약(entrance.ts): 비트 하나 = 문장 하나 = 발화 하나이고, 비트 길이는 발화 길이
// 추정치(estimateSpeechMs)로 역산한다. 즉 **스케줄 자체가 동기를 보장**하는 설계다.
// 이 도구는 그 설계가 실제 브라우저에서도 성립하는지 재는 것이다.
//
// 방법: `speechSynthesis.speak`를 후킹해 (t, 문장)을 기록하고, 같은 시계로
// `.ent__row--on`(강조된 명단 행)과 `.ent__line-text`(자막)를 30 ms 폴링으로 기록한다.
// 두 계열을 시간으로 짝지어 "말한 이름 == 강조된 이름"을 검사한다.
//
// 사용: node tools/entrance-frame/tts.mjs [--w 1600 --h 900]
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

await page.addInitScript(() => {
  const rec = { speak: [], row: [], line: [], phase: [] }
  window.__entRec = rec
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)

  const hook = () => {
    const synth = window.speechSynthesis
    if (!synth || synth.__hooked) return
    synth.__hooked = true
    const orig = synth.speak.bind(synth)
    synth.speak = u => {
      rec.speak.push({ t: now(), text: String(u.text ?? ''), pitch: u.pitch, rate: u.rate })
      u.volume = 0
      return orig(u)
    }
  }
  hook()
  document.addEventListener('DOMContentLoaded', hook)

  const watch = () => {
    let lastRow = ''
    let lastLine = ''
    let lastPhase = ''
    setInterval(() => {
      const ov = document.querySelector('[data-testid="entrance-overlay"]')
      if (!ov) return
      const ph = ov.dataset.phase || ''
      if (ph !== lastPhase) {
        rec.phase.push({ t: now(), phase: ph, side: ov.dataset.side || '' })
        lastPhase = ph
      }
      const row = document.querySelector('.ent__row--on')
      const name = row ? (row.querySelector('.ent__row-name')?.textContent || '').trim() : ''
      if (name !== lastRow) {
        if (name) rec.row.push({ t: now(), name })
        lastRow = name
      }
      const line = (document.querySelector('.ent__line-text')?.textContent || '').trim()
      if (line !== lastLine) {
        if (line) rec.line.push({ t: now(), line })
        lastLine = line
      }
    }, 30)
  }
  document.addEventListener('DOMContentLoaded', watch)
})

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()

  const overlay = page.locator('[data-testid="entrance-overlay"]')
  await overlay.waitFor({ state: 'visible', timeout: 20000 })
  // 연출이 끝날 때까지(오버레이 사라짐) 기다린다.
  await overlay.waitFor({ state: 'detached', timeout: 120000 })

  const rec = await page.evaluate(() => window.__entRec)
  await writeFile(join(OUT, 'entrance-tts.json'), JSON.stringify(rec, null, 2))

  // ── 표: 이름 발화 ↔ 하이라이트 ──────────────────────────────────
  // 이름 비트의 발화는 `이름,` 또는 `이름입니다.` 꼴이다(commentary.lineupIntroBeats).
  const strip = s => s.replace(/[,.]/g, '').replace(/입니다$/, '').replace(/^골키퍼\s*/, '').trim()
  const casters = rec.speak.filter(s => s.pitch >= 0.95)
  const rows = []
  for (const r of rec.row) {
    // 그 하이라이트와 가장 가까운 발화(앞뒤 1.2 s 이내).
    let best = null
    for (const s of casters) {
      const d = Math.abs(s.t - r.t)
      if (d <= 1200 && (!best || d < Math.abs(best.t - r.t))) best = s
    }
    rows.push({
      name: r.name,
      rowT: r.t,
      speakT: best ? best.t : null,
      spoken: best ? strip(best.text) : '',
      delta: best ? best.t - r.t : null,
    })
  }
  console.log('\n### 이름 호명 ↔ 명단 하이라이트')
  console.log('| 강조된 이름 | 강조 시각(ms) | 발화 시각(ms) | 차이(ms) | 발화 내용 | 일치 |')
  console.log('|---|---:|---:|---:|---|---|')
  let hit = 0
  for (const r of rows) {
    const ok = r.spoken.includes(r.name) || r.name.includes(r.spoken)
    if (ok) hit++
    console.log(
      `| ${r.name} | ${r.rowT} | ${r.speakT ?? '—'} | ${r.delta == null ? '—' : (r.delta >= 0 ? '+' : '') + r.delta} |` +
        ` ${r.spoken || '—'} | ${ok ? 'O' : 'X'} |`,
    )
  }
  const ds = rows.filter(r => r.delta != null).map(r => r.delta)
  if (ds.length > 0) {
    const mean = Math.round(ds.reduce((s, v) => s + v, 0) / ds.length)
    console.log(
      `\n하이라이트 ${rows.length}건 · 이름 일치 ${hit}/${rows.length} · ` +
        `발화 지연 평균 ${mean >= 0 ? '+' : ''}${mean}ms (${Math.min(...ds)} ~ ${Math.max(...ds)}ms)`,
    )
  }
  console.log('\n### 단계 전환')
  for (const p of rec.phase) console.log(`  ${p.t}ms  ${p.phase}${p.side && p.side !== 'none' ? ` (${p.side})` : ''}`)
  console.log(`\n총 발화 ${rec.speak.length}건 · 자막 ${rec.line.length}건 · 하이라이트 ${rec.row.length}건`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'entrance-tts.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
