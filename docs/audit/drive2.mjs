import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SHOTS = '/Users/moo/Projects/daker/MH_Soccer-Manager/docs/audit/shots';
const OUT = '/Users/moo/Projects/daker/MH_Soccer-Manager/docs/audit';
import { AUDIT } from './auditfn.mjs';

const W = +(process.env.W || 1440), H = +(process.env.H || 900);
const WARP = +(process.env.WARP || 14);

const clickText = async (page, t, nth = 0) => {
  const r = await page.evaluate(([t, nth]) => {
    const els = [...document.querySelectorAll('button,a,[role=button],[role=tab]')]
      .filter(e => e.textContent.trim().includes(t) && e.offsetParent !== null);
    if (!els[nth]) return 'MISS:' + t;
    els[nth].click(); return 'OK:' + els[nth].textContent.trim().slice(0, 24);
  }, [t, nth]);
  await page.waitForTimeout(400); return r;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'ko-KR' });
await ctx.addInitScript(`(() => { const w=${WARP}; const st=window.setTimeout, si=window.setInterval;
  window.setTimeout=(f,d,...a)=>st(f,Math.max(0,(d||0)/w),...a);
  window.setInterval=(f,d,...a)=>si(f,Math.max(1,(d||0)/w),...a); })();`);
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0,140)));
const R = { console: errs, steps: {} };
const tag = `${W}-flow`;
const snap = async (name, full=false) => { await page.screenshot({ path: `${SHOTS}/${tag}-${name}.png`, fullPage: full }); R.steps[name] = await page.evaluate(AUDIT); console.log('shot', name); };
/** 후보 라벨을 순서대로 시도한다. 문구가 바뀔 때마다 주행 전체가 멈추면
 *  회귀 측정을 못 한다 — 하니스는 카피 변경에 견뎌야 한다. */
const clickAny = async (page, candidates, nth = 0) => {
  for (const t of candidates) {
    const r = await clickText(page, t, nth);
    if (r.startsWith('OK')) return r;
  }
  return 'MISS-ALL:' + candidates.join('|');
};

const minute = () => page.evaluate(() => (document.querySelector('.bc-scorebug__clock')||{}).textContent || document.body.innerText.match(/\d+'/)?.[0] || '?');

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log(await clickText(page, '캠페인 시작'));
console.log(await clickAny(page, ['준비하기', '경기 준비', '준비']));
await page.waitForTimeout(800);
console.log(await clickAny(page, ['킥오프']));
await page.waitForTimeout(4000);
console.log('after kickoff min=', await minute());
console.log(await clickText(page, '2x'));

// capture the FIRST auto break (paused-break) — this is the 2D 작전판 with analysis lines
let brk = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(700);
  const txt = await page.evaluate(() => document.body.innerText);
  if (/하프타임/.test(txt)) { console.log('HALFTIME at iter', i); break; }
  if (!brk && /작전 타임|전술 확정/.test(txt)) {
    brk = true; console.log('BREAK at min', await minute());
    await page.waitForTimeout(900);
    await snap('20-break-board', true);
    console.log('전술탭:', await clickText(page, '전술'));
    await page.waitForTimeout(900);
    await snap('21-break-analysis', true);
    R.steps.breakText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    await clickText(page, '전술 확정');
    await page.waitForTimeout(800);
    continue;
  }
  if (/전술 확정/.test(txt)) { await clickText(page, '전술 확정'); await page.waitForTimeout(600); }
  if (i % 10 === 0) console.log('  min', await minute());
}
await page.waitForTimeout(1200);
await snap('10-halftime', true);
R.steps.halftimeText = await page.evaluate(() => document.body.innerText.slice(0, 1500));

// 전술 tab on halftime board -> analysis 2D
console.log('전술탭:', await clickText(page, '전술'));
await page.waitForTimeout(900);
await snap('11-halftime-tactics', true);
console.log('상대탭:', await clickText(page, '상대'));
await page.waitForTimeout(700);
await snap('12-halftime-opp', true);
console.log('교체탭:', await clickText(page, '교체'));
await page.waitForTimeout(700);
await snap('13-halftime-sub', true);

// resume
for (const label of ['후반 시작', '전술 확정', '재개', '계속']) {
  const r = await clickText(page, label); console.log('resume try', label, r);
  if (r.startsWith('OK')) break;
}
await page.waitForTimeout(2500);
await snap('14-second-half');

// wait for fulltime
for (let i = 0; i < 140; i++) {
  await page.waitForTimeout(1000);
  const txt = await page.evaluate(() => document.body.innerText);
  if (/경기 종료|풀타임|결과 확정|기자회견/.test(txt)) { console.log('FULLTIME iter', i); break; }
  if (i % 15 === 0) console.log('  min', await minute());
  // dismiss any pause
  if (/전술 확정/.test(txt)) { await clickText(page, '전술 확정'); }
  if (/후반 시작/.test(txt)) { await clickText(page, '후반 시작'); }
}
await page.waitForTimeout(1500);
await snap('15-fulltime', true);
R.steps.fulltimeText = await page.evaluate(() => document.body.innerText.slice(0, 2000));

for (const label of ['결과 확정', '기자회견', '다음']) {
  const r = await clickText(page, label); console.log('post try', label, r);
  if (r.startsWith('OK')) break;
}
await page.waitForTimeout(1800);
await snap('16-press', true);
R.steps.pressText = await page.evaluate(() => document.body.innerText.slice(0, 1500));

// answer press questions a few times
for (let k = 0; k < 6; k++) {
  const done = await page.evaluate(() => /신문|헤드라인|다음/.test(document.body.innerText));
  const btns = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>b.textContent.trim().slice(0,20)));
  console.log('press btns', JSON.stringify(btns).slice(0,300));
  const r = await page.evaluate(() => { const b=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length>3); if(!b[0])return 'none'; b[0].click(); return b[0].textContent.trim().slice(0,20); });
  await page.waitForTimeout(1200);
  if (k === 1) await snap('17-press-mid', true);
  if (r === 'none') break;
}
await page.waitForTimeout(1200);
await snap('18-newspaper', true);
R.steps.paperText = await page.evaluate(() => document.body.innerText.slice(0, 1200));

fs.writeFileSync(`${OUT}/audit-flow-${W}.json`, JSON.stringify(R, null, 1));
await browser.close();
console.log('DONE', errs.slice(0,5));
