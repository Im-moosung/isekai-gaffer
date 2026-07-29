// tools/tone-stats/smoke.mjs
// 실앱 스모크 — 하네스가 아니라 **진짜 앱(index.html)** 을 헤드리스로 띄워 랜딩 배경이
// 포스트 프로세싱과 함께 실제로 뜨는지, 콘솔 에러가 없는지 눈과 로그로 확인한다.
// 하네스는 프로덕션 모듈을 쓰지만 React 배선까지는 재현하지 않는다 — 그 간극을 여기서 메운다.
//
// 사용: node tools/tone-stats/smoke.mjs [--reduced] [--tag 이름]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const args = process.argv.slice(2)
const reduced = args.includes('--reduced')
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : reduced ? 'reduced' : 'landing'
const W = 1600, H = 900

const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer(); s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
const waitFor = async (fn, ms = 30000) => {
  const end = Date.now() + ms
  for (;;) { try { const v = await fn(); if (v) return v } catch {}
    if (Date.now() > end) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 120)) }
}

const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
await mkdir(SHOTS, { recursive: true })

const bin = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome']
  .filter(Boolean).find(existsSync)
const udd = join(tmpdir(), `smoke-${process.pid}`)
const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${udd}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run',
  '--enable-unsafe-swiftshader', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
proc.stderr.on('data', () => {})
const cdpPort = await waitFor(async () => Number((await readFile(join(udd, 'DevToolsActivePort'), 'utf8')).split('\n')[0]))
const ver = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json())

const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pend = new Map(); const logs = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') logs.push(`[예외] ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`)
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    logs.push(`[${m.params.type}] ${(m.params.args ?? []).map(a => a.value ?? a.description).join(' ')}`)
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(`[log] ${m.params.entry.text}`)
  const p = pend.get(m.id); if (!p) return; pend.delete(m.id)
  if (m.error) p.rej(new Error(m.error.message))
  else p.res(m.result)
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (m, p) => send(m, p, sessionId)
await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable')
await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
if (reduced) await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await call('Page.navigate', { url: `http://127.0.0.1:${port}/` })
await new Promise(r => setTimeout(r, 6000))
const shot = join(SHOTS, `smoke-${tag}.png`)
const cap = await call('Page.captureScreenshot', { format: 'png' })
await writeFile(shot, Buffer.from(cap.data, 'base64'))
const canvas = await call('Runtime.evaluate', {
  expression: 'JSON.stringify({ bg: !!document.querySelector(".landing-bg__canvas"), ready: !!document.querySelector(".landing-bg__host.is-ready") })',
  returnByValue: true })
console.log('스크린샷:', shot)
console.log('랜딩 배경 캔버스:', canvas.result.value)
console.log('콘솔 에러/경고:', logs.length ? '\n' + logs.join('\n') : '없음')
ws.close(); proc.kill('SIGKILL'); await server.close(); await rm(udd, { recursive: true, force: true })
