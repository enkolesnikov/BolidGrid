/** temp probe 3 — deleted before final */
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
  const measure = async (label) => {
    const info = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), scrollTop: e.scrollTop }; };
      const reset = document.querySelector('[data-action="reset"]');
      const rb = reset?.getBoundingClientRect();
      const elAt = rb ? document.elementFromPoint(rb.x + rb.width / 2, rb.y + rb.height / 2) : null;
      return {
        left: r('#left'), panelProject: r('#panel-project'), panelWalls: r('#panel-walls'), panelPalette: r('#panel-palette'),
        reset: rb ? { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) } : null,
        hitAtResetCenter: elAt ? { tag: elAt.tagName, id: elAt.id, cls: String(elAt.className || '').slice(0, 50) } : null,
        paletteSearch: r('#palette-search'),
        leftScrollTop: document.querySelector('#left')?.scrollTop,
        docScrollY: scrollY,
      };
    });
    console.log(label, JSON.stringify(info, null, 1));
  };
  await measure('INITIAL');
  // B14: load demo (already demo), delete first wall via UI, place dip34a, loadDemo(false)
  const wall1Id = await page.evaluate(() => window.BolidGrid.store.project.walls[0].id);
  await page.locator(`#walls-list [data-wall-del="${wall1Id}"]`).click();
  await page.waitForSelector('#modal:not([hidden])');
  await page.locator('#modal-actions button', { hasText: 'Удалить' }).click();
  await sleep(500);
  await page.locator('#palette-list .pal-item[data-model="dip34a"]').click();
  await sleep(100);
  const bb = await page.locator('#wall').boundingBox();
  await page.mouse.click(bb.x + bb.width * 0.45, bb.y + bb.height * 0.55);
  await sleep(400);
  await measure('AFTER_WALL_DELETE');
  await page.evaluate(() => window.BolidGrid.loadDemo(false));
  await sleep(900);
  await measure('AFTER_LOADDEMO');
  // try clicking reset
  try {
    await page.locator('[data-action="reset"]').click({ timeout: 8000 });
    console.log('RESET CLICK OK');
  } catch (e) {
    console.log('RESET CLICK FAIL:', String(e).split('\n').slice(0, 8).join(' | '));
  }
  await page.screenshot({ path: '/root/BolidGrid/tests/output/_probe3.png' });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
