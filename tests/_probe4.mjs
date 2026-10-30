/** temp probe 4 — deleted before final */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const server = spawn(process.execPath, ['server.mjs', '--port', String(port)], { cwd: '/root/BolidGrid', stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => server.stdout.on('data', (b) => String(b).includes(`:${port}`) && res()));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.BolidGrid?.store?.spec);
  await sleep(600);
  const report = async (label) => {
    const info = await page.evaluate(() => {
      const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
      const hit = (el) => {
        const b = el.getBoundingClientRect();
        const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { label: el.getAttribute('data-action') || el.id || el.getAttribute('placeholder') || el.tagName, hit: e ? `${e.tagName}#${e.id || ''}.${String(e.className || '').slice(0, 30)}` : null, isSelf: e === el || el.contains(e) };
      };
      const project = document.getElementById('panel-project');
      const pr = project.getBoundingClientRect();
      const children = [...project.querySelectorAll('input,button')];
      const outside = children.map((el) => { const b = el.getBoundingClientRect(); return { el: el.getAttribute('data-action') || el.id || el.placeholder || el.tagName, top: Math.round(b.top), bottom: Math.round(b.bottom), outsideBy: Math.round(b.bottom - pr.bottom) }; }).filter((c) => c.outsideBy > 1);
      return {
        viewport: [innerWidth, innerHeight],
        aside: R(document.getElementById('left')),
        project: R(project),
        walls: R(document.getElementById('panel-walls')),
        palettePanel: R(document.getElementById('panel-palette')),
        projectContentHeight: Math.round([...project.children].reduce((a, c) => a + c.getBoundingClientRect().height, 0)),
        childrenOutsidePanel: outside,
        buttons: [...document.querySelectorAll('#panel-project [data-action]')].map(hit),
        inputs: [...document.querySelectorAll('#panel-project input')].map(hit),
        leftStyle: { overflow: getComputedStyle(document.getElementById('left')).overflow, overflowY: getComputedStyle(document.getElementById('left')).overflowY },
      };
    });
    console.log(label, JSON.stringify(info, null, 1));
  };
  for (const [w, h] of [[1680, 1000], [1280, 800], [1920, 1080], [1366, 768], [1680, 1200], [1680, 1400]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    await report(`VIEW ${w}x${h}`);
  }
  await page.setViewportSize({ width: 1680, height: 1000 });
  await sleep(400);
  await page.screenshot({ path: '/root/BolidGrid/tests/output/_probe4.png', clip: { x: 0, y: 0, width: 340, height: 620 } });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
