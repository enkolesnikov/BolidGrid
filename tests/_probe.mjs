/** temp probe — deleted before final */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const PORT = 8150;
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    child.stdout.on('data', (b) => { if (String(b).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    child.on('error', reject);
  });
}

const server = spawn(process.execPath, ['server.mjs', '--port', String(PORT)], { cwd: '/root/BolidGrid', stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.BolidGrid?.store?.spec, null, { timeout: 15000 });
  await sleep(500);

  // ----- layout at 1280 -----
  const layout = await page.evaluate(() => {
    const b = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; };
    const overflow = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 1 || r.left < -1)) overflow.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 40), left: Math.round(r.left), right: Math.round(r.right) });
    }
    return {
      innerWidth, innerHeight,
      bodyScroll: document.body.scrollWidth, docScroll: document.documentElement.scrollWidth,
      bodyClient: document.body.clientWidth,
      topbar: b('#topbar'), left: b('#left'), stage: b('#stage'), right: b('#right'), wall: b('#wall'),
      topbarH: b('#topbar')?.h,
      overflow: overflow.slice(0, 12), overflowCount: overflow.length,
      layoutStyle: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
    };
  });
  console.log('LAYOUT1280', JSON.stringify(layout, null, 1));

  // ----- print media -----
  await page.emulateMedia({ media: 'print' });
  await sleep(300);
  const print = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const wall = document.getElementById('wall');
    const r = wall.getBoundingClientRect();
    return {
      topbar: cs('#topbar').display, left: cs('#left').display, right: cs('#right').display,
      statusbar: cs('#statusbar').display, toolbar: cs('#stage-toolbar').display,
      wallDisplay: cs('#wall').display, wallPos: cs('#wall').position, wallRect: { w: Math.round(r.width), h: Math.round(r.height) },
      devNodes: document.querySelectorAll('#devices .dev').length,
      viewBox: wall.getAttribute('viewBox'),
    };
  });
  console.log('PRINT', JSON.stringify(print));
  await page.emulateMedia({ media: 'screen' });
  await sleep(200);

  // ----- spec cable rows + journal -----
  await page.locator('#tabs button[data-tab="spec"]').click();
  await sleep(400);
  const specCables = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('#tab-spec table')];
    const out = [];
    for (const t of tables) {
      const head = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      const rows = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
      if (rows.length) out.push({ head, rows });
    }
    const journal = window.BolidGrid.panels.buildJournalRows();
    return { tables: out, journalTotals: journal.totals, totalsByCable: journal.totalsByCable };
  });
  console.log('SPECCABLES', JSON.stringify(specCables, null, 1));

  // ----- journal display -----
  await page.locator('#tabs button[data-tab="journal"]').click();
  await sleep(300);
  const journalText = await page.locator('#tab-journal table').last().innerText().catch(() => '');
  console.log('JOURNALTOTALS_TABLE', JSON.stringify(journalText));

  // ----- reload page for clean state, then out-of-bounds import -----
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.BolidGrid?.store?.spec, null, { timeout: 15000 });
  await sleep(400);
  const badProject = { project: { walls: [{ id: 'w1', name: 'W', width: 6000, height: 2700 }], devices: [{ id: 'd1', modelId: 'dip34a', wallId: 'w1', x: 99999, y: -50, rot: 45, tag: '<b>x</b>', groupIds: ['nope'] }], channels: [{ id: 'c1', wallId: 'w1', points: [[0, 0]] }], groups: [{ id: 'g1', name: 'g', deviceIds: ['d1'] }] } };
  await writeFile('/tmp/badproj.json', JSON.stringify(badProject));
  await page.setInputFiles('#file-input', '/tmp/badproj.json');
  await sleep(700);
  const imported = await page.evaluate(() => {
    const s = window.BolidGrid.store;
    const d = s.project.devices[0];
    return { walls: s.project.walls.length, devices: s.project.devices.length, channels: s.project.channels.length, groups: s.project.groups.length, dev: d, devNodes: document.querySelectorAll('#devices .dev').length, toast: document.getElementById('toast').textContent, toastHidden: document.getElementById('toast').hidden };
  });
  console.log('IMPORT_OOB', JSON.stringify(imported, null, 1));

  // malformed import
  await writeFile('/tmp/bad.json', '{not json');
  await page.setInputFiles('#file-input', '/tmp/bad.json');
  await sleep(500);
  const malformed = await page.evaluate(() => ({ toast: document.getElementById('toast').textContent, hidden: document.getElementById('toast').hidden, devices: window.BolidGrid.store.project.devices.length }));
  console.log('IMPORT_MALFORMED', JSON.stringify(malformed));

  // ----- reload demo, delete first wall, inspect tags -----
  await page.evaluate(() => window.BolidGrid.loadDemo(false));
  await sleep(600);
  const tagsBefore = await page.evaluate(() => {
    const s = window.BolidGrid.store;
    const w1 = s.project.walls[0], w2 = s.project.walls[1];
    return { walls: s.project.walls.map((w) => ({ id: w.id, name: w.name })), w1Tags: s.project.devices.filter((d) => d.wallId === w1.id).map((d) => d.tag), w2Tags: s.project.devices.filter((d) => d.wallId === w2.id).map((d) => d.tag) };
  });
  const delRes = await page.evaluate(() => {
    const s = window.BolidGrid.store;
    const id = s.project.walls[0].id;
    const ok = s.removeWall(id);
    const wall = s.wall;
    const dev = s.addDevice('dip34a', 100, 100);
    return { ok, remainingWalls: s.project.walls.map((w) => ({ id: w.id, name: w.name })), wallIndex: s.wallIndex, newTag: dev.tag, existingTags: s.project.devices.filter((d) => d.wallId === s.wall.id).map((d) => d.tag) };
  });
  console.log('TAG_AFTER_WALL_DELETE', JSON.stringify({ tagsBefore, delRes }, null, 1));

  // ----- zoom clamps -----
  await page.evaluate(() => window.BolidGrid.loadDemo(false));
  await sleep(400);
  const zoomTest = await page.evaluate(() => {
    const ed = window.BolidGrid.editor;
    const before = { ...ed.view };
    for (let i = 0; i < 40; i++) ed.zoomBy(1.25);
    const zin = { ...ed.view };
    for (let i = 0; i < 80; i++) ed.zoomBy(1 / 1.25);
    const zout = { ...ed.view };
    ed.fit();
    const fit = { ...ed.view };
    return { before, zin, zout, fit, bbox: ed.contentBBox() };
  });
  console.log('ZOOM', JSON.stringify(zoomTest));

  console.log('ERRORS', JSON.stringify(errs));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
