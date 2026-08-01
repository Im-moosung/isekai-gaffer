// 입장 소개가 실제로 mp3로 나는지 실측한다.
// rAF 함정: 백그라운드 탭은 프레임을 정지시킨다 — 측정 전에 픽셀 diff로 진행을 증명한다.
import { chromium } from 'playwright-core'
const URL = process.env.URL ?? 'http://localhost:4321/'
const b = await chromium.launch({ channel: 'chrome', headless: false })
const pg = await (await b.newContext()).newPage()
await pg.addInitScript(() => {
  window.__spoke = []; window.__clips = []
  const s = window.speechSynthesis
  if (s) { const o = s.speak.bind(s); s.speak = u => { window.__spoke.push(u.text); return o(u) } }
})
pg.on('request', r => {
  const u = r.url()
  if (/\/tts\/[tn]\//.test(u)) pg.evaluate(x => window.__clips.push(x), u).catch(() => {})
})
await pg.goto(URL, { waitUntil: 'networkidle' })
const shot = async () => (await pg.screenshot()).toString('base64')
const a = await shot(); await pg.waitForTimeout(400)
console.log('프레임 진행:', a === (await shot()) ? '❌ 정지' : '✅ 진행 중')

await pg.getByRole('button', { name: /캠페인 시작/ }).click()
// 허브 → 전술 센터 → 킥오프. 버튼 이름이 갈릴 수 있어 순서대로 시도한다.
for (const re of [/준비하기/, /킥오프/]) {
  const el = pg.getByRole('button', { name: re }).first()
  await el.waitFor({ timeout: 8000 }).catch(() => {})
  if (await el.count()) { await el.click().catch(() => {}); await pg.waitForTimeout(1500) }
}
await pg.waitForTimeout(16000)   // 입장 연출 구간
const r = await pg.evaluate(() => ({
  clips: window.__clips.length, spoke: window.__spoke.length,
  sample: window.__clips.slice(0, 4).map(u => u.split('/tts/')[1]),
}))
console.log(`클립 mp3 ${r.clips}건 · speechSynthesis ${r.spoke}건`)
if (r.sample.length) console.log('예:', r.sample.join(' '))
console.log(r.clips > 0 && r.spoke === 0 ? '✅ mp3로 나온다'
  : r.clips === 0 ? '❌ 폴백(브라우저 음성)' : '⚠ 섞임')
await b.close()
