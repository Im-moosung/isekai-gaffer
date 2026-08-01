import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chrome', headless: false })
const pg = await (await b.newContext()).newPage()
await pg.addInitScript(() => { window.__spoke = []; const s = window.speechSynthesis
  if (s) { const o = s.speak.bind(s); s.speak = u => { window.__spoke.push(u.text); return o(u) } } })
const reqs = []
pg.on('request', r => { if (r.url().includes('/tts/')) reqs.push(r.url().split('/tts/')[1]) })
pg.on('console', m => { if (/tts|clip|script/i.test(m.text())) console.log('  [console]', m.text().slice(0, 160)) })
await pg.goto('http://localhost:4321/', { waitUntil: 'networkidle' })
await pg.getByRole('button', { name: /캠페인 시작/ }).click(); await pg.waitForTimeout(1500)
console.log('허브 버튼:', (await pg.getByRole('button').allTextContents()).slice(0, 8).join(' | '))
const prep = pg.getByRole('button', { name: /준비하기/ }).first()
if (await prep.count()) { await prep.click(); await pg.waitForTimeout(2000) }
console.log('전술센터 버튼:', (await pg.getByRole('button').allTextContents()).slice(0, 10).join(' | '))
const kick = pg.getByRole('button', { name: /^킥오프$/ }).first()
console.log('킥오프 버튼 있음:', await kick.count())
if (await kick.count()) await kick.click()
await pg.waitForTimeout(6000)
console.log('입장 화면 텍스트:', (await pg.locator('body').innerText()).replace(/\n+/g, ' / ').slice(0, 240))
const r = await pg.evaluate(() => ({ spoke: window.__spoke.slice(0, 5), n: window.__spoke.length }))
console.log('발화', r.n, '건:', r.spoke.join(' | '))
console.log('/tts/ 요청:', reqs.slice(0, 6).join(' '), '(총', reqs.length + ')')
await b.close()
