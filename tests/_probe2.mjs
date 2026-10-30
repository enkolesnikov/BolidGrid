/** temp probe 2 — deleted before final */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const server = spawn(process.execPath, ['server.mjs', '--port', String(port)], { cwd: '/root/BolidGrid', stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => server.stdout.on('data', (b) => String(b).includes(`:${port}`) && res()));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/tests/output/qa-export.svg`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 400));
  const info = await page.evaluate(() => {
    const root = document.documentElement;
    const r = root.getBoundingClientRect();
    let bbox = null;
    try { const b = root.getBBox(); bbox = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) { bbox = String(e); }
    return {
      tag: root.tagName,
      viewBox: root.getAttribute('viewBox'),
      widthAttr: root.getAttribute('width'),
      heightAttr: root.getAttribute('height'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bbox,
      innerW: innerWidth, innerH: innerHeight,
      devs: document.querySelectorAll('.dev').length,
      firstDevRect: (() => { const el = document.querySelector('.dev'); if (!el) return null; const q = el.getBoundingClientRect(); return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) }; })(),
      sheet: (() => { const el = document.querySelector('.sheet'); if (!el) return null; const q = el.getBoundingClientRect(); return { x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height) }; })(),
    };
  });
  console.log('SVGFILE', JSON.stringify(info, null, 1));
  await page.screenshot({ path: '/root/BolidGrid/tests/output/qa-08-export-svg.png' });
  console.log('ERRS', JSON.stringify(errs));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
