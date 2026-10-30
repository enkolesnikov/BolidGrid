/**
 * tests/qa.mjs — независимый расширенный QA-прогон BolidGrid.
 *
 * Сам поднимает статический сервер на свободном порту, запускает headless Chromium
 * (Playwright) и проверяет вёрстку, печатные стили, интерактивные сценарии,
 * спецификацию/журнал, импорт-экспорт, зум/пан и устойчивость к «плохим» данным.
 *
 * Запуск:  node tests/qa.mjs
 * Код возврата: 0 — все проверки пройдены, 1 — есть FAIL.
 *
 * Приложение не изменяется; пишет только в tests/output/.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright';

/* ============================ каркас ============================ */
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = new URL('output/', import.meta.url).pathname;
const OUT_URL = new URL('output/', import.meta.url);
const results = [];
const failuresLog = [];
let currentSection = '';
let PAGE_ERRORS = [];
let CONSOLE_ERRORS = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function section(title) {
  currentSection = title;
  console.log(`\n=== ${title} ===`);
}

function check(name, cond, detail = '') {
  const ok = !!cond;
  const line = `${ok ? 'PASS' : 'FAIL'}  [${currentSection}] ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ''}`;
  results.push(line);
  if (!ok) failuresLog.push(line);
  console.log(line);
  return ok;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout (${stderr.slice(0, 300)})`)), 20000);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr.slice(0, 300)}`)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return { child, base: `http://127.0.0.1:${port}/`, port };
}

async function openApp(browser, base, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = { page: [], console: [] };
  page.on('pageerror', (e) => errors.page.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(m.text()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.BolidGrid?.store?.spec, null, { timeout: 20000 });
  await page.waitForFunction(() => window.BolidGrid.store.project.walls.length > 0, null, { timeout: 20000 });
  await sleep(500);
  return { ctx, page, errors };
}

/* ---------------- page helpers ---------------- */
const getState = (page) =>
  page.evaluate(() => {
    const s = window.BolidGrid.store;
    return {
      devices: s.project.devices.length,
      channels: s.project.channels.length,
      dims: (s.project.dimensions || []).length,
      walls: s.project.walls.length,
      wallId: s.wall?.id,
      wallName: s.wall?.name,
      wallDevices: s.wallDevices.length,
      wallChannels: s.wallChannels.length,
      selection: s.selection.slice(),
      tool: s.tool,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      undoLen: s._undo.length,
      redoLen: s._redo.length,
      modalOpen: !document.getElementById('modal').hidden,
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
    };
  });

const blurAll = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
  });

const canvasBox = (page) => page.locator('#wall').boundingBox();

async function clickCanvas(page, fx, fy, opts = {}) {
  const b = await canvasBox(page);
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy, opts);
  await sleep(140);
}

async function armModel(page, modelId) {
  await page.locator(`#palette-list .pal-item[data-model="${modelId}"]`).click();
  await sleep(80);
}

async function placeModel(page, modelId, fx, fy) {
  await armModel(page, modelId);
  await clickCanvas(page, fx, fy);
}

async function clickDevice(page, id, modifiers = []) {
  const loc = page.locator(`#devices .dev[data-id="${id}"] .dev-hit`);
  const cb = await canvasBox(page);
  const box = await loc.boundingBox().catch(() => null);
  const inside = box && box.x + box.width / 2 >= cb.x && box.x + box.width / 2 <= cb.x + cb.width &&
    box.y + box.height / 2 >= cb.y && box.y + box.height / 2 <= cb.y + cb.height;
  if (!inside) {
    // устройство вне кадра (например, после «Показать» объединение) — вернуть «вся стена»
    await page.locator('#btn-zoom-fit').click();
    await sleep(320);
  }
  await loc.click({ modifiers });
  await sleep(140);
  return page.evaluate(() => window.BolidGrid.store.selection.slice());
}

async function dragScreen(page, from, to, { steps = 6, button = 'left' } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up({ button });
  await sleep(260);
}

const worldToClient = (page, x, yFloor) =>
  page.evaluate(
    ({ x, yFloor }) => {
      const svg = document.getElementById('wall');
      const s = window.BolidGrid.store;
      const p = svg.createSVGPoint();
      p.x = x;
      p.y = s.wall.height - yFloor;
      const m = svg.getScreenCTM();
      const q = p.matrixTransform(m);
      return { x: q.x, y: q.y };
    },
    { x, yFloor }
  );

const pressKeys = async (page, keys, betweenMs = 22) => {
  for (const k of keys) {
    await page.keyboard.press(k);
    await sleep(betweenMs);
  }
};

const normCable = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[\s«»"'()]/g, '')
    .replace(/[хx*]/g, 'x');

const parseRuNum = (s) => {
  const t = String(s ?? '')
    .replace(/[\s\u00a0]/g, '')
    .replace(',', '.')
    .replace(/^\+/, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};

const normProject = (p) => ({
  meta: p.meta,
  walls: p.walls
    .map((w) => ({ id: w.id, name: w.name, width: w.width, height: w.height }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  devices: p.devices
    .map((d) => ({
      id: d.id,
      modelId: d.modelId,
      wallId: d.wallId,
      x: d.x,
      y: d.y,
      rot: d.rot,
      tag: d.tag,
      address: d.address,
      note: d.note,
      noDrop: !!d.noDrop,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  channels: p.channels
    .map((c) => ({
      id: c.id,
      wallId: c.wallId,
      kind: c.kind,
      width: c.width,
      points: c.points,
      cableModelId: c.cableModelId,
      label: c.label,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  dims: p.dimensions?.length ?? 0
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      color: g.color,
      note: g.note,
      deviceIds: [...g.deviceIds].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
});

const hashString = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

const readSpecTables = (page) =>
  page.evaluate(() => {
    const box = document.getElementById('tab-spec');
    const out = [];
    let sec = '';
    for (const child of box.children) {
      if (child.classList.contains('pal-group-title')) {
        sec = child.textContent.trim();
        continue;
      }
      if (child.tagName === 'TABLE') {
        const head = [...child.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        const rows = [...child.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
        out.push({ section: sec, head, rows });
      }
    }
    return out;
  });

/* ============================ основной прогон ============================ */
async function main() {
  await mkdir(OUT, { recursive: true });
  const { child: server, base, port } = await startServer();
  console.log(`BolidGrid QA: сервер http://127.0.0.1:${port}/`);
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });

    /* ------------------------------------------------------------------ *
     * 0. ДАННЫЕ: data/spec.json и каталог моделей                        *
     * ------------------------------------------------------------------ */
    section('DATA: data/spec.json + каталог');
    const spec = JSON.parse(await readFile(new URL('../data/spec.json', import.meta.url), 'utf8'));
    const allPos = [
      ...(spec.equipment || []),
      ...(spec.cables || []),
      ...(spec.materials || []),
      ...(spec.spares || []),
    ].map((r) => +r.pos);
    check('spec.json: ровно 30 позиций', allPos.length === 30, `count=${allPos.length}`);
    const sorted = [...allPos].sort((a, b) => a - b);
    check(
      'spec.json: позиции непрерывны 1..30 без пропусков и дублей',
      sorted.every((v, i) => v === i + 1),
      `min=${sorted[0]}, max=${sorted[sorted.length - 1]}, unique=${new Set(allPos).size}`
    );
    check('spec.json: 12 позиций оборудования', spec.equipment.length === 12, `n=${spec.equipment.length}`);
    check('spec.json: 2 позиции кабеля', spec.cables.length === 2, `n=${spec.cables.length}`);
    check('spec.json: 11 позиций материалов и 5 запасных', spec.materials.length === 11 && spec.spares.length === 5, `materials=${spec.materials.length}, spares=${spec.spares.length}`);
    const dipRow = spec.equipment.find((r) => +r.pos === 2);
    check('spec.json: ДИП-34А-04, поз.2, план 32 шт.', dipRow && +dipRow.qty === 32 && /ДИП-34А-04/.test(dipRow.model), JSON.stringify(dipRow?.qty));

    const catalog = await import('../js/catalog.js');
    const catalogIds = catalog.MODELS.filter((m) => !m.hidden).map((m) => m.id);
    check('каталог: ровно 20 моделей устройств', catalog.MODELS.length === 20, `count=${catalog.MODELS.length}`);
    check('каталог: идентификаторы моделей уникальны', new Set(catalogIds).size === catalogIds.length);
    const specPositions = catalog.MODELS.map((m) => m.specPos).filter((p) => p != null).sort((a, b) => a - b);
    check('каталог: модели покрывают позиции 1..12 спецификации', specPositions.length === 12 && specPositions.every((v, i) => v === i + 1), JSON.stringify(specPositions));

    /* ------------------------------------------------------------------ *
     * A. ВЁРСТКА 1680×1000 / 1280×800 + ПЕЧАТЬ                            *
     * ------------------------------------------------------------------ */
    section('A. Layout 1680×1000 / 1280×800 / print CSS');
    const appA = await openApp(browser, base, { width: 1680, height: 1000 });
    const { page: pageA, errors: errorsA } = appA;
    const sA0 = await getState(pageA);
    check('демо-проект загружен при старте', sA0.devices === 20 && sA0.walls === 2 && sA0.channels === 5 && sA0.dims === 4, JSON.stringify(sA0));
    check('спецификация загружена (data/spec.json)', await pageA.evaluate(() => !!window.BolidGrid.store.spec));

    const metrics = () =>
      pageA.evaluate(() => {
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
        };
        const overflow = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('svg')) continue; // SVG-геометрия обрезается viewBox'ом
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
            overflow.push({ tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 40), left: Math.round(r.left), right: Math.round(r.right) });
          }
        }
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          overflow,
          topbar: rect('#topbar'),
          left: rect('#left'),
          stage: rect('#stage'),
          right: rect('#right'),
          wall: rect('#wall'),
          palette: rect('#palette-list'),
          activePanel: document.querySelector('.tabpanel.active')?.id,
          tabs: [...document.querySelectorAll('#tabs button')].map((b) => b.textContent.trim()),
          devNodes: document.querySelectorAll('#devices .dev').length,
          channelNodes: document.querySelectorAll('#channels .channel').length,
          gridColumns: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
        };
      });

    const m1680 = await metrics();
    const columnsOk = m1680.left && m1680.stage && m1680.right &&
      m1680.left.w > 200 && m1680.stage.w > 400 && m1680.right.w > 250 &&
      m1680.left.right <= m1680.stage.x + 1 && m1680.stage.right <= m1680.right.x + 1;
    check('1680×1000: три колонки видны и не перекрываются', columnsOk, JSON.stringify({ left: m1680.left?.w, stage: m1680.stage?.w, right: m1680.right?.w, cols: m1680.gridColumns }));
    check('1680×1000: палитра слева и вкладки справа отрисованы', m1680.palette && m1680.palette.h > 50 && m1680.tabs.length === 3 && m1680.activePanel === 'tab-props', JSON.stringify({ paletteH: m1680.palette?.h, tabs: m1680.tabs }));
    check('1680×1000: SVG-стена отрисована (полотно > 500×400)', m1680.wall && m1680.wall.w > 500 && m1680.wall.h > 400, JSON.stringify(m1680.wall));
    check('1680×1000: нет горизонтального переполнения body', m1680.docScrollWidth <= m1680.innerWidth + 1 && m1680.bodyScrollWidth <= m1680.innerWidth + 1, `scrollW=${m1680.docScrollWidth}, innerW=${m1680.innerWidth}`);
    check('1680×1000: ни один HTML-элемент не выходит за вьюпорт', m1680.overflow.length === 0, JSON.stringify(m1680.overflow.slice(0, 3)));
    check('1680×1000: узлы устройств/каналов соответствуют стене', m1680.devNodes === sA0.wallDevices && m1680.channelNodes === sA0.wallChannels, JSON.stringify({ devNodes: m1680.devNodes, wallDevices: sA0.wallDevices, channelNodes: m1680.channelNodes, wallChannels: sA0.wallChannels }));
    // health-check панели «Объект»: поля/кнопки не должны вылезать за панель и перекрываться соседями
    const panelHealth = () =>
      pageA.evaluate(() => {
        const panel = document.getElementById('panel-project');
        const pr = panel.getBoundingClientRect();
        const items = [...panel.querySelectorAll('input,button')].map((el) => {
          const b = el.getBoundingClientRect();
          const target = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return {
            name: el.dataset.action || el.id || el.getAttribute('placeholder') || el.tagName,
            outsideBy: Math.round(b.bottom - pr.bottom),
            hitSelf: !!target && (target === el || el.contains(target)),
          };
        });
        return {
          panelH: Math.round(pr.height),
          contentH: Math.round([...panel.children].reduce((a, c) => a + c.getBoundingClientRect().height, 0)),
          broken: items.filter((i) => i.outsideBy > 1 || !i.hitSelf),
        };
      });
    const ph1680 = await panelHealth();
    check('1680×1000: панель «Объект» не обрезает свои поля и кнопки (BUG-6)', ph1680.broken.length === 0 && ph1680.contentH <= ph1680.panelH + 1, JSON.stringify({ panelH: ph1680.panelH, contentH: ph1680.contentH, broken: ph1680.broken }));
    await pageA.screenshot({ path: OUT + 'qa-01-demo-1680.png' });

    // 1280×800
    await pageA.setViewportSize({ width: 1280, height: 800 });
    await sleep(500);
    const m1280 = await metrics();
    const columnsOk1280 = m1280.left && m1280.stage && m1280.right &&
      m1280.left.w > 200 && m1280.stage.w > 400 && m1280.right.w > 250 &&
      m1280.left.right <= m1280.stage.x + 1 && m1280.stage.right <= m1280.right.x + 1;
    check('1280×800: три колонки видны и не перекрываются', columnsOk1280, JSON.stringify({ left: m1280.left?.w, stage: m1280.stage?.w, right: m1280.right?.w, cols: m1280.gridColumns }));
    check('1280×800: нет горизонтального переполнения body', m1280.docScrollWidth <= m1280.innerWidth + 1 && m1280.bodyScrollWidth <= m1280.innerWidth + 1, `scrollW=${m1280.docScrollWidth}, innerW=${m1280.innerWidth}`);
    check('1280×800: ни один HTML-элемент не выходит за вьюпорт', m1280.overflow.length === 0, JSON.stringify(m1280.overflow.slice(0, 3)));
    check('1280×800: SVG-стена и устройства отрисованы', m1280.wall && m1280.wall.w > 400 && m1280.wall.h > 300 && m1280.devNodes > 0, JSON.stringify({ wall: m1280.wall, devNodes: m1280.devNodes }));
    check('1280×800: топбар не схлопнулся (высота > 40)', m1280.topbar && m1280.topbar.h > 40, `h=${m1280.topbar?.h}`);
    const ph1280 = await panelHealth();
    check('1280×800: панель «Объект» не обрезает свои поля и кнопки (BUG-6)', ph1280.broken.length === 0 && ph1280.contentH <= ph1280.panelH + 1, JSON.stringify({ panelH: ph1280.panelH, contentH: ph1280.contentH, broken: ph1280.broken }));
    await pageA.screenshot({ path: OUT + 'qa-02-1280.png' });

    // print CSS
    await pageA.emulateMedia({ media: 'print' });
    await sleep(400);
    const printInfo = await pageA.evaluate(() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const wall = document.getElementById('wall');
      const r = wall.getBoundingClientRect();
      return {
        topbar: cs('#topbar')?.display,
        left: cs('#left')?.display,
        right: cs('#right')?.display,
        toolbar: cs('#stage-toolbar')?.display,
        statusbar: cs('#statusbar')?.display,
        bodyDisplay: getComputedStyle(document.body).display,
        bodyOverflow: getComputedStyle(document.body).overflow,
        wallDisplay: cs('#wall')?.display,
        wallPosition: cs('#wall')?.position,
        wallRect: { w: Math.round(r.width), h: Math.round(r.height) },
        viewBox: wall.getAttribute('viewBox'),
        devNodes: document.querySelectorAll('#devices .dev').length,
        wallDevices: window.BolidGrid.store.wallDevices.length,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    check('print: topbar/left/right/toolbar/statusbar скрыты', ['topbar', 'left', 'right', 'toolbar', 'statusbar'].every((k) => printInfo[k] === 'none'), JSON.stringify(printInfo));
    check('print: стена (SVG) остаётся видимой', printInfo.wallDisplay !== 'none' && printInfo.wallPosition === 'static' && printInfo.wallRect.w > 500 && printInfo.wallRect.h > 500, JSON.stringify({ display: printInfo.wallDisplay, pos: printInfo.wallPosition, rect: printInfo.wallRect }));
    check('print: viewBox и узлы устройств сохранены', /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(printInfo.viewBox || '') && printInfo.devNodes === printInfo.wallDevices && printInfo.devNodes > 0, JSON.stringify({ viewBox: printInfo.viewBox, devNodes: printInfo.devNodes, wallDevices: printInfo.wallDevices }));
    check('print: body не создаёт горизонтального переполнения', printInfo.scrollWidth <= printInfo.innerWidth + 1, `scrollW=${printInfo.scrollWidth}, innerW=${printInfo.innerWidth}`);
    await pageA.screenshot({ path: OUT + 'qa-03-print.png' });
    await pageA.emulateMedia({ media: 'screen' });
    await sleep(250);
    PAGE_ERRORS = PAGE_ERRORS.concat(errorsA.page);
    CONSOLE_ERRORS = CONSOLE_ERRORS.concat(errorsA.console);
    check('A: нет pageerror при загрузке/ресайзе/print', errorsA.page.length === 0, errorsA.page.slice(0, 3).join(' | '));
    check('A: нет console.error при загрузке/ресайзе/print', errorsA.console.length === 0, errorsA.console.slice(0, 3).join(' | '));
    await appA.ctx.close();

    /* ------------------------------------------------------------------ *
     * B. ИНТЕРАКТИВНЫЕ СЦЕНАРИИ                                          *
     * ------------------------------------------------------------------ */
    section('B1. Палитра: 20 моделей + undo/redo');
    const appB = await openApp(browser, base, { width: 1680, height: 1000 });
    const { page, errors: errorsB } = appB;
    const s0 = await getState(page);
    check('B: стартовое демо 20 устройств / 5 коробов / 4 размера / 2 стены', s0.devices === 20 && s0.channels === 5 && s0.dims === 4 && s0.walls === 2, JSON.stringify({ d: s0.devices, c: s0.channels, dims: s0.dims, w: s0.walls }));

    const paletteIds = await page.$$eval('#palette-list .pal-item', (els) => els.map((e) => e.dataset.model));
    check('B: палитра содержит ровно 18 моделей (без извещателей)', paletteIds.length === 18, `count=${paletteIds.length}`);
    check('B: модели палитры совпадают с каталогом', catalogIds.every((id) => paletteIds.includes(id)), JSON.stringify(paletteIds.filter((id) => !catalogIds.includes(id))));

    let placedAll = true;
    let prevCount = s0.devices;
    for (let i = 0; i < paletteIds.length; i++) {
      const id = paletteIds[i];
      const fx = 0.07 + (i % 8) * 0.115;
      const fy = 0.2 + Math.floor(i / 8) * 0.11;
      await armModel(page, id);
      const tool = (await getState(page)).tool;
      if (tool !== 'place') placedAll = false;
      await clickCanvas(page, fx, fy);
      const st = await getState(page);
      if (st.devices !== prevCount + 1) placedAll = false;
      prevCount = st.devices;
    }
    check('B: все 18 моделей размещаются по клику (счётчик +1 каждый раз, режим place)', placedAll, `итог devices=${prevCount}`);
    const s20 = await getState(page);
    check('B: после размещения 18 моделей устройств 38 (20+18)', s20.devices === 38 && s20.wallDevices === s0.wallDevices + 18, JSON.stringify({ devices: s20.devices, wallDevices: s20.wallDevices }));
    const placement = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const wallDevs = s.wallDevices;
      const modelIds = [...new Set(wallDevs.map((d) => d.modelId))];
      const tags = wallDevs.map((d) => d.tag);
      return { modelIds, uniqueTags: new Set(tags).size, tagCount: tags.length, devNodes: document.querySelectorAll('#devices .dev').length, wallDevices: wallDevs.length };
    });
    check('B: размещены все 18 разных моделей', catalogIds.every((id) => placement.modelIds.includes(id)), JSON.stringify(placement.modelIds));
    check('B: обозначения новых устройств уникальны', placement.uniqueTags === placement.tagCount, `${placement.uniqueTags}/${placement.tagCount}`);
    check('B: SVG-узлы устройств = устройствам стены', placement.devNodes === placement.wallDevices, JSON.stringify(placement));

    await blurAll(page);
    await pressKeys(page, Array(20).fill('Control+z'), 40);
    const su = await getState(page);
    check('B: 18×undo возвращает исходные 20 устройств', su.devices === 20, `devices=${su.devices}`);
    check('B: после 20×undo история пуста (canUndo=false)', su.canUndo === false && su.undoLen === 0, JSON.stringify({ canUndo: su.canUndo, undoLen: su.undoLen }));
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 60);
    const sExtra = await getState(page);
    check('B: лишний undo не меняет проект и показывает подсказку', sExtra.devices === 20 && /Уже в начале истории/.test(sExtra.toast), JSON.stringify({ devices: sExtra.devices, toast: sExtra.toast }));
    await blurAll(page);
    await pressKeys(page, Array(20).fill('Control+y'), 30);
    const sr = await getState(page);
    check('B: 18×redo восстанавливает 38 устройств', sr.devices === 38, `devices=${sr.devices}`);
    await blurAll(page);
    await pressKeys(page, Array(20).fill('Control+z'), 30);
    check('B: повторный 18×undo снова даёт 20 устройств', (await getState(page)).devices === 20);

    /* ---------- B2. Перетаскивание устройства ---------- */
    section('B2. Перетаскивание устройства мышью');
    await page.locator('#btn-zoom-fit').click();
    await sleep(350);
    const wall1 = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const w = s.project.walls[0];
      return { id: w.id, width: w.width, height: w.height, name: w.name };
    });
    let devsOnWall = await page.evaluate(() => window.BolidGrid.store.wallDevices.map((d) => ({ id: d.id, x: d.x, y: d.y, modelId: d.modelId })));
    const targetDev = devsOnWall[0];
    const targetModel = catalog.MODELS.find((m) => m.id === targetDev.modelId);
    let hit = await page.locator(`#devices .dev[data-id="${targetDev.id}"] .dev-hit`).boundingBox();
    const start = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 };
    await dragScreen(page, start, { x: start.x + 70, y: start.y + 35 });
    let afterDrag = await page.evaluate((id) => {
      const d = window.BolidGrid.store.getDevice(id);
      return { x: d.x, y: d.y, wallId: d.wallId, sel: window.BolidGrid.store.selection.some((s) => s.type === 'device' && s.id === id) };
    }, targetDev.id);
    check('B: перетаскивание меняет координаты устройства', afterDrag.x !== targetDev.x || afterDrag.y !== targetDev.y, JSON.stringify({ before: [targetDev.x, targetDev.y], after: [afterDrag.x, afterDrag.y] }));
    check('B: устройство остаётся выделенным после перетаскивания', afterDrag.sel === true);
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 80);
    let afterUndo = await page.evaluate((id) => {
      const d = window.BolidGrid.store.getDevice(id);
      return { x: d.x, y: d.y };
    }, targetDev.id);
    check('B: undo возвращает координаты после перетаскивания', afterUndo.x === targetDev.x && afterUndo.y === targetDev.y, JSON.stringify({ expect: [targetDev.x, targetDev.y], got: [afterUndo.x, afterUndo.y] }));

    // за границы стены — вправо-вниз
    hit = await page.locator(`#devices .dev[data-id="${targetDev.id}"] .dev-hit`).boundingBox();
    const b = await canvasBox(page);
    await dragScreen(page, { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 }, { x: b.x + b.width - 3, y: b.y + b.height - 3 });
    const edge1 = await page.evaluate((id) => {
      const s = window.BolidGrid.store;
      const d = s.getDevice(id);
      const m = window.BolidGrid.getModel(d.modelId);
      return { x: d.x, y: d.y, w: m.w, h: m.h, wallW: s.wall.width, wallH: s.wall.height };
    }, targetDev.id);
    check(
      'B: перетаскивание за правый/нижний край ограничено стеной',
      edge1.x >= 0 && edge1.y >= 0 && edge1.x <= edge1.wallW - edge1.w && edge1.y <= edge1.wallH - edge1.h,
      JSON.stringify(edge1)
    );
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 80);
    // за границы — влево-вверх
    hit = await page.locator(`#devices .dev[data-id="${targetDev.id}"] .dev-hit`).boundingBox();
    await dragScreen(page, { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 }, { x: b.x + 2, y: b.y + 2 });
    const edge2 = await page.evaluate((id) => {
      const s = window.BolidGrid.store;
      const d = s.getDevice(id);
      return { x: d.x, y: d.y, wallW: s.wall.width, wallH: s.wall.height };
    }, targetDev.id);
    check('B: перетаскивание за левый/верхний край ограничено стеной', edge2.x >= 0 && edge2.y >= 0 && edge2.x <= edge2.wallW && edge2.y <= edge2.wallH, JSON.stringify(edge2));
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 80);
    afterUndo = await page.evaluate((id) => {
      const d = window.BolidGrid.store.getDevice(id);
      return { x: d.x, y: d.y };
    }, targetDev.id);
    check('B: undo после перетаскивания за края восстанавливает координаты', afterUndo.x === targetDev.x && afterUndo.y === targetDev.y);

    /* ---------- B3. Кабельный канал: 4 точки, вершина, удаление ---------- */
    section('B3. Кабельный канал: 4 точки, перетаскивание вершины, удаление');
    const channelsBefore = (await getState(page)).channels;
    await page.locator('#stage-toolbar [data-tool="channel"]').click();
    await sleep(120);
    check('B: кнопка «Канал» включает инструмент channel', (await getState(page)).tool === 'channel');
    const draftLens = [];
    for (const [fx, fy] of [[0.2, 0.7], [0.2, 0.82], [0.5, 0.82], [0.5, 0.73]]) {
      await clickCanvas(page, fx, fy);
      draftLens.push(await page.evaluate(() => window.BolidGrid.editor.channelDraft?.points?.length ?? null));
    }
    check('B: клики накапливают 1→4 точки черновика канала', JSON.stringify(draftLens) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(draftLens));
    await blurAll(page);
    await page.keyboard.press('Enter');
    await sleep(300);
    const sCh = await getState(page);
    const newCh = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const c = s.project.channels[s.project.channels.length - 1];
      return { id: c.id, points: c.points, wallId: c.wallId, kind: c.kind, activeWall: s.activeWallId };
    });
    check('B: Enter завершает канал из 4 точек', sCh.channels === channelsBefore + 1 && newCh.points.length === 4, JSON.stringify({ channels: sCh.channels, points: newCh.points.length }));
    check('B: канал создан на активной стене', newCh.wallId === newCh.activeWall && newCh.wallId === wall1.id);
    check('B: после завершения канала инструмент возвращается в select', sCh.tool === 'select');

    // выделить канал кликом по его трассе
    const chMid = await worldToClient(page, (newCh.points[0][0] + newCh.points[1][0]) / 2, (newCh.points[0][1] + newCh.points[1][1]) / 2);
    await page.mouse.click(chMid.x, chMid.y);
    await sleep(220);
    const selCh = await page.evaluate(() => window.BolidGrid.store.selection.slice());
    check('B: клик по трассе выделяет канал', selCh.length === 1 && selCh[0].type === 'channel' && selCh[0].id === newCh.id, JSON.stringify(selCh));
    const vertexCount = await page.locator('.channel-vertex').count();
    check('B: у выделенного канала показаны 4 вершины', vertexCount === 4, `vertices=${vertexCount}`);
    const inspectorText = await page.locator('#tab-props').innerText();
    check('B: инспектор канала содержит тип трассы и длину', /Тип трассы/.test(inspectorText) && /Длина, мм/.test(inspectorText), inspectorText.slice(0, 120));

    // перетащить вершину
    const vtx = page.locator('.channel-vertex[data-index="1"]');
    const vb = await vtx.boundingBox();
    const beforePts = newCh.points.map((p) => [...p]);
    await dragScreen(page, { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }, { x: vb.x + vb.width / 2 + 45, y: vb.y + vb.height / 2 + 25 });
    const movedPts = await page.evaluate((id) => window.BolidGrid.store.getChannel(id).points, newCh.id);
    check('B: перетаскивание вершины меняет точку канала', JSON.stringify(movedPts[1]) !== JSON.stringify(beforePts[1]), JSON.stringify({ before: beforePts[1], after: movedPts[1] }));
    check(
      'B: вершина канала остаётся в габаритах стены',
      movedPts.every(([x, y]) => x >= 0 && x <= wall1.width && y >= 0 && y <= wall1.height),
      JSON.stringify(movedPts)
    );

    // утащить вершину далеко за пределы полотна
    const vb2 = await page.locator('.channel-vertex[data-index="1"]').boundingBox();
    await dragScreen(page, { x: vb2.x + vb2.width / 2, y: vb2.y + vb2.height / 2 }, { x: b.x + 2, y: b.y + 2 });
    const clampedPts = await page.evaluate((id) => window.BolidGrid.store.getChannel(id).points, newCh.id);
    check(
      'B: вершина за пределами полотна ограничивается габаритами стены',
      clampedPts.every(([x, y]) => x >= 0 && x <= wall1.width && y >= 0 && y <= wall1.height),
      JSON.stringify(clampedPts)
    );

    // удалить канал
    await blurAll(page);
    await page.keyboard.press('Delete');
    await sleep(250);
    const sDelCh = await getState(page);
    check('B: Delete удаляет выделенный канал', sDelCh.channels === channelsBefore && sDelCh.selection.length === 0, JSON.stringify({ channels: sDelCh.channels, sel: sDelCh.selection.length }));
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 80);
    check('B: undo возвращает удалённый канал', (await getState(page)).channels === channelsBefore + 1);
    await blurAll(page);
    await pressKeys(page, ['Control+z', 'Control+z', 'Control+z'], 80);
    check('B: отмена правок трассы и создания канала возвращает исходное число каналов', (await getState(page)).channels === channelsBefore);

    /* ---------- B5. Стены ---------- */
    section('B5. Стены: переключение, добавление, изменение размера, удаление');
    const walls = await page.evaluate(() => window.BolidGrid.store.project.walls.map((w) => ({ id: w.id, name: w.name, width: w.width, height: w.height })));
    const wall2 = walls[1];
    await page.locator('#wall-tabs .wall-tab').nth(1).click();
    await sleep(350);
    const sw2 = await getState(page);
    const domWall2 = await page.evaluate(() => ({
      devNodes: document.querySelectorAll('#devices .dev').length,
      channelNodes: document.querySelectorAll('#channels .channel').length,
      wallDevices: window.BolidGrid.store.wallDevices.length,
      wallChannels: window.BolidGrid.store.wallChannels.length,
      sheetCaption: document.querySelector('#sheet .wall-caption')?.textContent || '',
    }));
    check('B: переключение на вторую демо-стену', sw2.wallId === wall2.id && sw2.wallName === wall2.name, JSON.stringify({ wall: sw2.wallName }));
    check('B: при переключении рисуются устройства/каналы выбранной стены', domWall2.devNodes === domWall2.wallDevices && domWall2.channelNodes === domWall2.wallChannels && domWall2.devNodes > 0, JSON.stringify(domWall2));
    check('B: подпись листа соответствует активной стене', domWall2.sheetCaption === wall2.name, domWall2.sheetCaption);
    await page.locator('#wall-tabs .wall-tab').nth(0).click();
    await sleep(350);
    check('B: возврат на первую стену', (await getState(page)).wallId === wall1.id);

    // добавить стену
    await page.locator('#btn-add-wall').click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    await page.fill('#wall-name', 'QA-стена');
    await page.fill('#wall-w', '3.5');
    await page.fill('#wall-h', '2.2');
    await page.locator('#modal-actions button', { hasText: 'Создать' }).click();
    await sleep(450);
    const sAddWall = await getState(page);
    const addedWall = await page.evaluate(() => {
      const w = window.BolidGrid.store.wall;
      return { id: w.id, name: w.name, width: w.width, height: w.height, walls: window.BolidGrid.store.project.walls.length };
    });
    check('B: добавлена стена с заданными размерами (3.5×2.2 м)', sAddWall.walls === 3 && addedWall.name === 'QA-стена' && addedWall.width === 3500 && addedWall.height === 2200, JSON.stringify(addedWall));
    check('B: новая стена становится активной', sAddWall.wallId === addedWall.id);

    // устройство на новой стене, затем уменьшение стены
    await placeModel(page, 'custom', 0.75, 0.6);
    const placedOnNew = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.wallDevices[s.wallDevices.length - 1];
      return { id: d.id, x: d.x, y: d.y, wallDevices: s.wallDevices.length };
    });
    check('B: устройство размещено на новой стене', placedOnNew.wallDevices === 1, JSON.stringify(placedOnNew));
    await page.evaluate(({ id }) => window.BolidGrid.store.updateWall(id, { width: 1500, height: 1200 }), { id: addedWall.id });
    await sleep(400);
    const resized = await page.evaluate(({ wallId, devId }) => {
      const s = window.BolidGrid.store;
      const w = s.project.walls.find((x) => x.id === wallId);
      const d = s.getDevice(devId);
      const m = window.BolidGrid.getModel(d.modelId);
      return { width: w.width, height: w.height, x: d.x, y: d.y, modelW: m.w, modelH: m.h };
    }, { wallId: addedWall.id, devId: placedOnNew.id });
    check('B: размер стены изменён (1500×1200)', resized.width === 1500 && resized.height === 1200, JSON.stringify(resized));
    check('B: устройство после уменьшения стены осталось в габаритах', resized.x >= 0 && resized.y >= 0 && resized.x <= resized.width - resized.modelW && resized.y <= resized.height - resized.modelH, JSON.stringify(resized));

    // удалить добавленную стену
    await page.locator(`#walls-list [data-wall-del="${addedWall.id}"]`).click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    await page.locator('#modal-actions button', { hasText: 'Удалить' }).click();
    await sleep(450);
    const sDelWall = await getState(page);
    check('B: удаление добавленной стены возвращает 2 стены и 20 устройств', sDelWall.walls === 2 && sDelWall.devices === 20, JSON.stringify({ walls: sDelWall.walls, devices: sDelWall.devices }));
    check('B: активной становится существующая стена', [wall1.id, wall2.id].includes(sDelWall.wallId), String(sDelWall.wallId));

    // удалить демо-стену с устройствами + undo
    await page.locator('#wall-tabs .wall-tab').nth(1).click();
    await sleep(300);
    await page.locator(`#walls-list [data-wall-del="${wall2.id}"]`).click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    const confirmText = await page.locator('#modal-body').innerText();
    check('B: подтверждение удаления стены предупреждает о числе устройств', /5\s*устройств/.test(confirmText.replace(/\s+/g, ' ')), confirmText.replace(/\s+/g, ' ').slice(0, 160));
    await page.locator('#modal-actions button', { hasText: 'Удалить' }).click();
    await sleep(500);
    const sDeleteWall2 = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return {
        walls: s.project.walls.length,
        devices: s.project.devices.length,
        channelsLeft: s.project.channels.length,
        dimsLeft: (s.project.dimensions || []).length,
        orphanChannels: s.project.channels.filter((c) => c.wallId !== s.wall.id).length,
        orphanDims: (s.project.dimensions || []).filter((d) => d.wallId !== s.wall.id).length,
      };
    });
    check(
      'B: удаление стены удаляет её устройства, короба и размеры',
      sDeleteWall2.walls === 1 && sDeleteWall2.devices === 15 && sDeleteWall2.orphanChannels === 0 && sDeleteWall2.orphanDims === 0,
      JSON.stringify(sDeleteWall2)
    );
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 100);
    const sUndoWall = await getState(page);
    check('B: undo восстанавливает стену с устройствами', sUndoWall.walls === 2 && sUndoWall.devices === 20, JSON.stringify({ walls: sUndoWall.walls, devices: sUndoWall.devices }));

    /* ---------- B6. Наложение устройств / длинные подписи / XSS ---------- */
    section('B6. Наложение устройств, длинные подписи, XSS');
    await page.locator('#wall-tabs .wall-tab').nth(0).click();
    await sleep(350);
    const overlapBefore = (await getState(page)).devices;
    await placeModel(page, 'custom', 0.62, 0.78);
    await placeModel(page, 'custom', 0.62, 0.78);
    const overlap = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const customs = s.project.devices.filter((d) => d.modelId === 'custom');
      return {
        count: customs.length,
        sameSpot: customs.length === 2 && customs[0].x === customs[1].x && customs[0].y === customs[1].y,
        ids: customs.map((d) => d.id),
        uniqueIds: new Set(customs.map((d) => d.id)).size,
        devNodes: document.querySelectorAll('#devices .dev').length,
        wallDevices: s.wallDevices.length,
      };
    });
    check('B: два устройства можно поставить в одну точку (оба существуют)', overlap.count === 2 && overlap.sameSpot && overlap.uniqueIds === 2, JSON.stringify(overlap));
    check('B: наложенные устройства обе отрисованы', overlap.devNodes === overlap.wallDevices, JSON.stringify(overlap));
    await blurAll(page);
    await pressKeys(page, ['Control+z', 'Control+z'], 80);
    check('B: undo убирает наложенные устройства', (await getState(page)).devices === overlapBefore);

    devsOnWall = await page.evaluate(() => window.BolidGrid.store.wallDevices.map((d) => d.id));
    // подписи по умолчанию скрыты — для проверки отрисовки длинных обозначений включаем режим «кратко»
    await page.selectOption('#sel-labels', 'tag');
    await sleep(250);
    const originalTag = await page.evaluate((id) => window.BolidGrid.store.getDevice(id)?.tag, devsOnWall[0]);
    await clickDevice(page, devsOnWall[0]);
    await page.locator('#tabs button[data-tab="props"]').click();
    await sleep(150);
    const longTag = 'A'.repeat(400);
    await page.fill('#tab-props input[data-f="tag"]', longTag);
    await page.locator('#tab-props input[data-f="tag"]').press('Enter');
    await sleep(300);
    const longTagState = await page.evaluate((id) => {
      const s = window.BolidGrid.store;
      const tag = s.getDevice(id)?.tag;
      const text = document.querySelector(`#devices .dev[data-id="${id}"] .dev-tag`)?.textContent || '';
      return { len: tag.length, textLen: text.length, same: tag === text };
    }, devsOnWall[0]);
    check('B: очень длинное обозначение (400 симв.) сохраняется и рисуется', longTagState.len === 400 && longTagState.same, JSON.stringify(longTagState));

    const xss = '<img src=x onerror="window.__xss=1">';
    await page.fill('#tab-props input[data-f="tag"]', xss);
    await page.locator('#tab-props input[data-f="tag"]').press('Enter');
    await sleep(350);
    const xssState = await page.evaluate((id) => {
      const s = window.BolidGrid.store;
      return {
        tag: s.getDevice(id)?.tag,
        imgInDom: document.querySelectorAll('img').length,
        imgInProps: document.querySelectorAll('#tab-props img').length,
        imgInSvg: document.querySelectorAll('#devices img').length,
        devTagText: document.querySelector(`#devices .dev[data-id="${id}"] .dev-tag`)?.textContent || '',
        xssFlag: typeof window.__xss,
      };
    }, devsOnWall[0]);
    check('B: HTML-инъекция в обозначении экранируется (нет <img> в DOM)', xssState.imgInDom === 0 && xssState.imgInProps === 0 && xssState.imgInSvg === 0, JSON.stringify({ imgInDom: xssState.imgInDom, imgInProps: xssState.imgInProps, imgInSvg: xssState.imgInSvg }));
    check('B: обозначение хранится как текст, обработчик не выполняется', xssState.tag === xss && xssState.devTagText.includes('<img') && xssState.xssFlag === 'undefined', JSON.stringify({ tag: xssState.tag, flag: xssState.xssFlag }));
    await blurAll(page);
    await pressKeys(page, ['Control+z', 'Control+z'], 90);
    check('B: undo восстанавливает исходное обозначение', (await page.evaluate((id) => window.BolidGrid.store.getDevice(id)?.tag, devsOnWall[0])) === originalTag);

    /* ---------- B7. Переключение стены во время перетаскивания ---------- */
    section('B7. Смена стены посреди перетаскивания');
    const midDragDev = (await page.evaluate(() => window.BolidGrid.store.wallDevices.map((d) => ({ id: d.id, x: d.x, y: d.y }))))[0];
    const hitBox = await page.locator(`#devices .dev[data-id="${midDragDev.id}"] .dev-hit`).boundingBox();
    const from = { x: hitBox.x + hitBox.width / 2, y: hitBox.y + hitBox.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
    await page.evaluate((wid) => window.BolidGrid.store.setActiveWall(wid), wall2.id);
    await sleep(200);
    await page.mouse.move(from.x + 100, from.y + 40, { steps: 4 });
    await page.mouse.up();
    await sleep(300);
    const midDrag = await page.evaluate(({ did, wallA }) => {
      const s = window.BolidGrid.store;
      const d = s.getDevice(did);
      const walls = new Set(s.project.walls.map((w) => w.id));
      const bad = s.project.devices.filter((x) => !walls.has(x.wallId));
      const wall = s.project.walls.find((w) => w.id === wallA);
      const m = window.BolidGrid.getModel(d.modelId);
      return {
        devWall: d.wallId,
        x: d.x, y: d.y,
        inBounds: d.x >= 0 && d.y >= 0 && d.x <= wall.width - m.w && d.y <= wall.height - m.h,
        activeWall: s.wall.id,
        orphanDevices: bad.length,
      };
    }, { did: midDragDev.id, wallA: wall1.id });
    check('B: смена стены посреди drag не переносит устройство на другую стену', midDrag.devWall === wall1.id && midDrag.orphanDevices === 0, JSON.stringify(midDrag));
    check('B: координаты устройства после drag остаются в габаритах своей стены', midDrag.inBounds, JSON.stringify(midDrag));
    // вернуть первую стену (реальный клик по вкладке) и отменить перемещение
    await page.locator('#wall-tabs .wall-tab').nth(0).click();
    await sleep(350);
    await blurAll(page);
    await pressKeys(page, ['Control+z'], 100);
    const backDev = await page.evaluate((id) => {
      const d = window.BolidGrid.store.getDevice(id);
      return { x: d.x, y: d.y };
    }, midDragDev.id);
    check('B: undo после drag со сменой стены восстанавливает координаты', backDev.x === midDragDev.x && backDev.y === midDragDev.y, JSON.stringify({ expect: [midDragDev.x, midDragDev.y], got: [backDev.x, backDev.y] }));

    /* ---------- B8. Undo/redo spam ---------- */
    section('B8. Undo/redo spam');
    // сначала «дочистим» redo-стек предыдущих сценариев, чтобы 60×(undo+redo) были симметричны
    await blurAll(page);
    await pressKeys(page, Array(60).fill('Control+y'), 12);
    const beforeSpam = await page.evaluate(() => ({
      serialize: window.BolidGrid.store.serialize(),
      devices: window.BolidGrid.store.project.devices.length,
      channels: window.BolidGrid.store.project.channels.length,
      dims: (window.BolidGrid.store.project.dimensions || []).length,
    }));
    await blurAll(page);
    await pressKeys(page, Array(60).fill('Control+z'), 14);
    await pressKeys(page, Array(60).fill('Control+y'), 14);
    const afterSpam = await page.evaluate(() => ({
      serialize: window.BolidGrid.store.serialize(),
      devices: window.BolidGrid.store.project.devices.length,
      channels: window.BolidGrid.store.project.channels.length,
      dims: (window.BolidGrid.store.project.dimensions || []).length,
    }));
    check(
      'B: 60×undo + 60×redo не меняют проект (побайтово)',
      afterSpam.serialize === beforeSpam.serialize && beforeSpam.devices === afterSpam.devices && beforeSpam.channels === afterSpam.channels && beforeSpam.dims === afterSpam.dims,
      JSON.stringify({ d: [beforeSpam.devices, afterSpam.devices], c: [beforeSpam.channels, afterSpam.channels], dims: [beforeSpam.dims, afterSpam.dims] })
    );
    const integrity = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const wallIds = new Set(s.project.walls.map((w) => w.id));
      const devIds = new Set(s.project.devices.map((d) => d.id));
      return {
        badDevices: s.project.devices.filter((d) => !wallIds.has(d.wallId) || !Number.isFinite(d.x) || !Number.isFinite(d.y)).length,
        badChannels: s.project.channels.filter((c) => !wallIds.has(c.wallId) || !Array.isArray(c.points) || c.points.length < 2).length,
        badDims: (s.project.dimensions || []).filter((d) => !wallIds.has(d.wallId) || !Array.isArray(d.a) || !Array.isArray(d.b)).length,
        devCount: devIds.size,
      };
    });
    check('B: после spam проект целостен (нет висячих ссылок)', integrity.badDevices === 0 && integrity.badChannels === 0 && integrity.badDims === 0 && integrity.devCount > 0, JSON.stringify(integrity));

    /* ---------- B9. Зум / пан ---------- */
    section('B9. Зум и панорама');
    await page.locator('#btn-zoom-fit').click();
    await sleep(350);
    const fitView = await page.evaluate(() => ({ ...window.BolidGrid.editor.view, pxW: document.getElementById('wall').clientWidth }));
    const b9 = await canvasBox(page);
    const panFrom = { x: b9.x + b9.width / 2, y: b9.y + b9.height / 2 };
    const panBefore = await page.evaluate(() => ({ ...window.BolidGrid.editor.view, scale: window.BolidGrid.editor.pxPerMm }));
    await page.mouse.move(panFrom.x, panFrom.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(panFrom.x + 120, panFrom.y + 60, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    await sleep(300);
    const panAfter = await page.evaluate(() => ({ ...window.BolidGrid.editor.view }));
    const expDx = -120 / panBefore.scale;
    const expDy = -60 / panBefore.scale;
    const panOk = Math.abs((panAfter.x - panBefore.x) - expDx) < Math.abs(expDx) * 0.02 + 2 && Math.abs((panAfter.y - panBefore.y) - expDy) < Math.abs(expDy) * 0.02 + 2;
    check('B: панорама СКМ сдвигает вид на ожидаемое расстояние', panOk, JSON.stringify({ dx: Math.round(panAfter.x - panBefore.x), expDx: Math.round(expDx), dy: Math.round(panAfter.y - panBefore.y), expDy: Math.round(expDy) }));

    await page.locator('#btn-zoom-fit').click();
    await sleep(350);
    const fitAgain = await page.evaluate(() => ({ ...window.BolidGrid.editor.view }));
    check('B: кнопка «вся стена» восстанавливает исходный вид', Math.abs(fitAgain.w - fitView.w) < 1e-6 && Math.abs(fitAgain.x - fitView.x) < 1e-6, JSON.stringify({ fitView: [fitView.x, fitView.w], fitAgain: [fitAgain.x, fitAgain.w] }));

    const zoomPoint = { x: b9.x + b9.width * 0.3, y: b9.y + b9.height * 0.4 };
    await page.mouse.move(zoomPoint.x, zoomPoint.y);
    const worldBefore = await page.evaluate(({ x, y }) => window.BolidGrid.editor.clientToSvg(x, y), zoomPoint);
    const widthBefore = (await page.evaluate(() => window.BolidGrid.editor.view.w));
    await page.mouse.wheel(0, -600);
    await sleep(300);
    const worldAfter = await page.evaluate(({ x, y }) => window.BolidGrid.editor.clientToSvg(x, y), zoomPoint);
    const widthAfter = await page.evaluate(() => window.BolidGrid.editor.view.w);
    check('B: колесо мыши приближает вид', widthAfter < widthBefore, `w: ${Math.round(widthBefore)} → ${Math.round(widthAfter)}`);
    check('B: зум колесом удерживает точку под курсором', Math.abs(worldAfter[0] - worldBefore[0]) < 3 && Math.abs(worldAfter[1] - worldBefore[1]) < 3, JSON.stringify({ before: worldBefore, after: worldAfter }));

    await page.mouse.wheel(0, 600);
    await sleep(300);
    const widthOut = await page.evaluate(() => window.BolidGrid.editor.view.w);
    const worldOut = await page.evaluate(({ x, y }) => window.BolidGrid.editor.clientToSvg(x, y), zoomPoint);
    check('B: колесо мыши отдаляет вид', widthOut > widthAfter, `w: ${Math.round(widthAfter)} → ${Math.round(widthOut)}`);
    check('B: отдаление колесом удерживает точку под курсором', Math.abs(worldOut[0] - worldBefore[0]) < 3 && Math.abs(worldOut[1] - worldBefore[1]) < 3, JSON.stringify({ before: worldBefore, after: worldOut }));

    await page.mouse.move(panFrom.x, panFrom.y);
    await page.mouse.wheel(0, -1000);
    await page.mouse.wheel(0, -1000);
    await page.mouse.wheel(0, -1000);
    await page.mouse.wheel(0, -1000);
    await sleep(350);
    const extremeIn = await page.evaluate(() => window.BolidGrid.editor.view.w);
    check('B: предельный зум-ин ограничен (view.w ≥ 300 мм)', extremeIn >= 299 && extremeIn <= 301, `w=${extremeIn}`);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 1000);
    await sleep(350);
    const extremeOut = await page.evaluate(() => window.BolidGrid.editor.view.w);
    check('B: предельный зум-аут ограничен (view.w ≤ 200000 мм)', extremeOut <= 200001 && extremeOut >= 199000, `w=${extremeOut}`);
    await page.locator('#btn-zoom-fit').click();
    await sleep(350);
    const statusZoom = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const v = window.BolidGrid.editor.view;
      return { text: document.getElementById('st-zoom').textContent.trim(), expected: Math.round((document.getElementById('wall').clientWidth / v.w) * 100) };
    });
    check('B: статус-бар показывает корректный масштаб', Math.abs(parseInt(statusZoom.text, 10) - statusZoom.expected) <= 1, JSON.stringify(statusZoom));

    await blurAll(page);
    const w0 = await page.evaluate(() => window.BolidGrid.editor.view.w);
    await pressKeys(page, ['=', '='], 60);
    const wIn = await page.evaluate(() => window.BolidGrid.editor.view.w);
    await pressKeys(page, ['-'], 60);
    const wOutKey = await page.evaluate(() => window.BolidGrid.editor.view.w);
    check('B: клавиши «+»/«−» управляют масштабом', wIn < w0 && wOutKey > wIn, JSON.stringify({ w0, wIn, wOutKey }));
    await page.locator('#btn-zoom-fit').click();
    await sleep(300);
    await page.screenshot({ path: OUT + 'qa-04-board.png' });

    /* ---------- B10. Спецификация и кабельный журнал ---------- */
    section('B10. Спецификация: факт/план, кабель в метрах, журнал');
    await page.locator('#wall-tabs .wall-tab').nth(0).click();
    await sleep(300);
    await page.locator('#btn-zoom-fit').click();
    await sleep(200);
    await placeModel(page, 'sp2', 0.38, 0.32);
    await placeModel(page, 'sp2', 0.46, 0.32);
    const sp2State = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return { fact4: s.placedCountBySpecPos().get(4) || 0, sp2Total: s.project.devices.filter((d) => d.modelId === 'sp2').length };
    });
    check('B: добавлены 2 С2000-СП2 → 4 на стенах (план 4)', sp2State.sp2Total === 4 && sp2State.fact4 === 4, JSON.stringify(sp2State));
    const badge = await page.locator('#palette-list .pal-item[data-model="sp2"]').innerText();
    check('B: палитра показывает «4 / 4» для С2000-СП2', /4\s*\/\s*4/.test(badge.replace(/\s+/g, ' ')), badge.replace(/\s+/g, ' ').slice(0, 120));

    await page.locator('#tabs button[data-tab="spec"]').click();
    await page.waitForSelector('#tab-spec table', { timeout: 5000 });
    await sleep(300);
    const specTables = await readSpecTables(page);
    const equipTable = specTables.find((t) => /Оборудование/.test(t.section) && t.rows.length >= 12);
    const cableTable = specTables.find((t) => /Кабельная продукция/.test(t.section) && t.rows.some((r) => /КПСнг/.test(r.join(' '))));
    check('B: таблица оборудования содержит 12 позиций', !!equipTable && equipTable.rows.length === 12, equipTable ? `rows=${equipTable.rows.length}` : 'no table');
    check('B: таблица кабеля содержит 2 позиции', !!cableTable && cableTable.rows.length === 2, cableTable ? `rows=${cableTable.rows.length}` : 'no table');
    const row4 = equipTable?.rows.find((r) => r[0] === '4');
    const plan4 = row4 ? parseRuNum(row4[5]) : null;
    const fact4 = row4 ? parseRuNum(row4[6]) : null;
    const diff4 = row4 ? parseRuNum(row4[7]) : null;
    const pill4 = await page.evaluate(() => {
      const table = document.querySelectorAll('#tab-spec table')[0];
      const row = table ? [...table.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim() === '4') : null;
      const pill = row?.querySelector('.pill');
      return { cls: pill?.className || '', text: pill?.textContent.trim() || '' };
    });
    check('B: поз.4 «По спец.» = 4', plan4 === 4, JSON.stringify(row4));
    check('B: поз.4 «Факт» = 4 (2 демо + 2 добавленных)', fact4 === 4, JSON.stringify(row4));
    check('B: поз.4 «Расхожд.» = 0 и подсвечено как норма', diff4 === 0 && /\bok\b/.test(pill4.cls), JSON.stringify(pill4));
    const row10 = equipTable?.rows.find((r) => r[0] === '10');
    const plan10 = row10 ? parseRuNum(row10[5]) : null;
    const fact10 = row10 ? parseRuNum(row10[6]) : null;
    const diff10 = row10 ? parseRuNum(row10[7]) : null;
    const pill10 = await page.evaluate(() => {
      const table = document.querySelectorAll('#tab-spec table')[0];
      const row = table ? [...table.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim() === '10') : null;
      const pill = row?.querySelector('.pill');
      return { cls: pill?.className || '', text: pill?.textContent.trim() || '' };
    });
    check('B: поз.10 «Маяк-24-3М»: план 8, факт 3, недостача подсвечена', plan10 === 8 && fact10 === 3 && diff10 === -5 && /\bwarn\b/.test(pill10.cls), JSON.stringify({ plan10, fact10, diff10, pill10 }));
    const pos2Ok = equipTable?.rows.some((r) => /ДИП-34А-04/.test(r[2]));
    check('B: в спецификации присутствует ДИП-34А-04 (строка из спецификации)', !!pos2Ok);

    const journalApi = await page.evaluate(() => {
      const p = window.BolidGrid.panels;
      const j = p.buildJournalRows();
      return { totals: j.totals, totalsByCable: j.totalsByCable, rows: j.rows.map((r) => ({ id: r.id, length: r.length, width: r.width, cable: r.cable })) };
    });
    const cableApi = new Map(journalApi.totalsByCable.map((t) => [normCable(t.cable), t.length]));
    let cableOk = true;
    const cableDetails = [];
    for (const r of cableTable?.rows || []) {
      const model = r[2];
      const plan = parseRuNum(r[5]);
      const fact = parseRuNum(r[6]);
      const diff = parseRuNum(r[7]);
      const expected = (cableApi.get(normCable(model)) || 0) / 1000;
      const ok = fact != null && expected != null && Math.abs(fact - expected) < 0.02 && diff != null && Math.abs(diff - (fact - plan)) < 0.02 && fact < 1000;
      if (!ok) cableOk = false;
      cableDetails.push({ model, plan, fact, diff, expected });
    }
    check('B: «Факт» кабеля в МЕТРАХ и равен итогу кабельного журнала по марке (BUG-1 fix)', cableOk && cableDetails.length === 2, JSON.stringify(cableDetails));
    check('B: план кабеля 280 / 160 м по спецификации', cableDetails.some((c) => c.plan === 280) && cableDetails.some((c) => c.plan === 160), JSON.stringify(cableDetails.map((c) => c.plan)));
    await page.screenshot({ path: OUT + 'qa-05-spec.png' });

    // кабельный журнал в DOM
    await page.locator('#tabs button[data-tab="journal"]').click();
    await page.waitForSelector('#tab-journal table', { timeout: 5000 });
    await sleep(300);
    const journalDom = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('#tab-journal table')];
      const first = tables[0];
      const rows = [...first.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));
      const tfoot = [...first.querySelectorAll('tfoot tr td')].map((td) => td.textContent.trim());      const cables = tables[1] ? [...tables[1].querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())) : [];
      return { rowCount: rows.length, rows, tfoot, cables };
    });
    check('B: строк кабельного журнала = числу каналов', journalDom.rowCount === journalApi.rows.length && journalDom.rowCount === (await getState(page)).channels, JSON.stringify({ dom: journalDom.rowCount, api: journalApi.rows.length }));
    const journalRowsOk = journalApi.rows.every((r, i) => {
      const cells = journalDom.rows[i];
      if (!cells) return false;
      const trace = parseRuNum(cells[3]);
      return Math.abs(trace - r.length / 1000) < 0.006;
    });
    check('B: длины трасс в ведомости короба совпадают с расчётом (м)', journalRowsOk);
    const footerOk = journalDom.tfoot.length >= 1 &&
      Math.abs(parseRuNum(journalDom.tfoot[journalDom.tfoot.length - 1]) - journalApi.totals.length / 1000) < 0.006;
    check('B: итоговая строка ведомости короба корректна', footerOk, JSON.stringify(journalDom.tfoot));
    const cableSectionOk = journalDom.cables.length === journalApi.totalsByCable.length && journalApi.totalsByCable.every((t) => {
      const row = journalDom.cables.find((c) => normCable(c[0]) === normCable(t.cable));
      return row && Math.abs(parseRuNum(row[1]) - t.length / 1000) < 0.006;
    });
    check('B: итоги по маркам кабеля в журнале корректны', cableSectionOk, JSON.stringify(journalDom.cables));
    await page.screenshot({ path: OUT + 'qa-06-journal.png' });

    // CSV-экспорт спецификации должен содержать метры, а не миллиметры
    const [csvDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('#tabs button[data-tab="spec"]').click().then(() => page.locator('#tab-spec [data-spec-act="csv"]').click()),
    ]);
    const csvPath = OUT + 'qa-spec.csv';
    await csvDownload.saveAs(csvPath);
    const csvText = await readFile(csvPath, 'utf8');
    const csvCableLine = csvText.split(/\r?\n/).find((l) => /КПСнг\(А\)-FRHF 1x2x0,5/.test(l) && /^13;/.test(l));
    const csvCells = csvCableLine ? csvCableLine.split(';') : [];
    check('B: CSV спецификации содержит факт кабеля в метрах', csvCells.length > 6 && parseRuNum(csvCells[6]) > 0 && parseRuNum(csvCells[6]) < 1000, csvCableLine?.slice(0, 200));

    /* ---------- B11. Автосохранение и перезагрузка ---------- */
    section('B11. Автосохранение localStorage и восстановление после reload');
    await sleep(900);
    const ls = await page.evaluate(() => {
      const raw = localStorage.getItem('bolidgrid:project:v1');
      return raw ? { raw, parsed: JSON.parse(raw) } : null;
    });
    check('B: автосохранение записано в localStorage', !!ls && !!ls.parsed.project, ls ? `bytes=${ls.raw.length}` : 'empty');
    if (ls) {
      const savedAgo = Date.now() - Date.parse(ls.parsed.savedAt);
      check('B: метка сохранения свежая', Number.isFinite(savedAgo) && savedAgo >= 0 && savedAgo < 180000, `savedAgo=${savedAgo}`);
      check('B: в сохранении актуальное число устройств', ls.parsed.project.devices.length === (await getState(page)).devices, JSON.stringify({ saved: ls.parsed.project.devices.length, live: (await getState(page)).devices }));
      check('B: в сохранении записан activeWallId', ls.parsed.activeWallId === (await getState(page)).wallId);
    }
    await page.locator('#topbar [data-action="save"]').click();
    await sleep(250);
    check('B: кнопка «Сохранить» подтверждает сохранение', /сохранён в браузере/.test((await getState(page)).toast));

    const beforeReload = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return {
        devices: s.project.devices.length,
        channels: s.project.channels.length,
        dims: (s.project.dimensions || []).length,
        walls: s.project.walls.length,
        wallName: s.wall?.name,
        wallId: s.activeWallId,
        tags: s.wallDevices.map((d) => d.tag).sort(),
      };
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.BolidGrid?.store?.spec, null, { timeout: 20000 });
    await page.waitForFunction(() => window.BolidGrid.store.project.walls.length > 0, null, { timeout: 20000 });
    await sleep(600);
    const afterReload = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return {
        devices: s.project.devices.length,
        channels: s.project.channels.length,
        dims: (s.project.dimensions || []).length,
        walls: s.project.walls.length,
        wallName: s.wall?.name,
        wallId: s.activeWallId,
        tags: s.wallDevices.map((d) => d.tag).sort(),
        devNodes: document.querySelectorAll('#devices .dev').length,
        wallDevices: s.wallDevices.length,
      };
    });
    check('B: после reload проект восстановлен из localStorage (не демо)', afterReload.devices === beforeReload.devices && afterReload.devices > 0, JSON.stringify({ before: beforeReload.devices, after: afterReload.devices }));
    check('B: после reload восстановлена активная стена и всё содержимое', afterReload.wallName === beforeReload.wallName && afterReload.wallId === beforeReload.wallId && afterReload.channels === beforeReload.channels && afterReload.dims === beforeReload.dims && JSON.stringify(afterReload.tags) === JSON.stringify(beforeReload.tags), JSON.stringify({ before: { wall: beforeReload.wallName, c: beforeReload.channels, dims: beforeReload.dims }, after: { wall: afterReload.wallName, c: afterReload.channels, dims: afterReload.dims } }));
    check('B: после reload SVG снова отрисован', afterReload.devNodes === afterReload.wallDevices && afterReload.devNodes > 0, JSON.stringify({ devNodes: afterReload.devNodes, wallDevices: afterReload.wallDevices }));

    /* ---------- B12. Экспорт JSON → импорт → идентичность ---------- */
    section('B12. Экспорт JSON / SVG → импорт обратно');
    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('#topbar [data-action="export"]').click(),
    ]);
    const jsonPath = OUT + 'qa-export.json';
    await jsonDownload.saveAs(jsonPath);
    const exportedRaw = await readFile(jsonPath, 'utf8');
    let exported = null;
    try {
      exported = JSON.parse(exportedRaw);
    } catch {
      exported = null;
    }
    check('B: экспорт JSON скачан и парсится', !!exported && exported.app === 'BolidGrid' && exported.schema === 1 && Array.isArray(exported.project?.walls), exported ? `bytes=${exportedRaw.length}` : 'parse error');
    const liveProject = await page.evaluate(() => JSON.parse(window.BolidGrid.store.serialize()).project);
    check('B: экспортированный JSON совпадает с состоянием проекта', !!exported && JSON.stringify(normProject(exported.project)) === JSON.stringify(normProject(liveProject)), exported ? JSON.stringify({ exportedDevices: exported.project.devices.length, liveDevices: liveProject.devices.length }) : '');

    const beforeImport = await page.evaluate(() => window.BolidGrid.store.serialize());
    await page.setInputFiles('#file-input', jsonPath);
    await sleep(1000);
    const afterImport = await page.evaluate(() => ({
      serialize: window.BolidGrid.store.serialize(),
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
      canUndo: window.BolidGrid.store.canUndo,
      devNodes: document.querySelectorAll('#devices .dev').length,
      wallDevices: window.BolidGrid.store.wallDevices.length,
    }));
    const importedProject = JSON.parse(afterImport.serialize).project;
    check('B: импорт JSON прошёл без ошибок', /Проект загружен/.test(afterImport.toast), afterImport.toast);
    check(
      'B: проект после экспорт→импорт идентичен (стены/устройства/каналы/объединения/обозначения)',
      JSON.stringify(normProject(importedProject)) === JSON.stringify(normProject(JSON.parse(beforeImport).project)) && afterImport.devNodes === afterImport.wallDevices,
      JSON.stringify({ devices: importedProject.devices.length, channels: importedProject.channels.length, dims: (importedProject.dimensions || []).length })
    );
    check('B: импорт сбрасывает историю undo', afterImport.canUndo === false);

    const svgInfo = await page.evaluate(async () => {
      const text = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const err = doc.querySelector('parsererror');
      return {
        text,
        parseError: err ? err.textContent.slice(0, 200) : null,
        root: doc.documentElement.tagName,
        devs: doc.querySelectorAll('.dev').length,
        channels: doc.querySelectorAll('.channel').length,
        styleLen: (doc.querySelector('style')?.textContent || '').length,
        viewBox: doc.documentElement.getAttribute('viewBox') || '',
        wallDevices: window.BolidGrid.store.wallDevices.length,
        wallChannels: window.BolidGrid.store.wallChannels.length,
      };
    });
    await writeFile(OUT + 'qa-export.svg', svgInfo.text, 'utf8');
    check('B: экспортированный SVG — валидный XML', svgInfo.parseError === null && svgInfo.root === 'svg', svgInfo.parseError || 'ok');
    check('B: экспортированный SVG содержит все .dev-узлы', svgInfo.devs === svgInfo.wallDevices && svgInfo.devs > 0, JSON.stringify({ devs: svgInfo.devs, wallDevices: svgInfo.wallDevices }));
    check('B: экспортированный SVG содержит каналы и встроенный CSS', svgInfo.channels === svgInfo.wallChannels && svgInfo.styleLen > 1000, JSON.stringify({ channels: svgInfo.channels, styleLen: svgInfo.styleLen }));
    check('B: viewBox экспортированного SVG охватывает лист', /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(svgInfo.viewBox) && parseFloat(svgInfo.viewBox.split(' ')[2]) > 4000, svgInfo.viewBox);

    // новая кнопка «SVG» в верхней панели (появилась после фикса BUG-5): реальный клик → скачивание
    const [svgDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('#topbar [data-action="export-svg"]').click(),
    ]);
    const svgDlPath = OUT + 'qa-export-file.svg';
    await svgDownload.saveAs(svgDlPath);
    const svgDlText = await readFile(svgDlPath, 'utf8');
    const svgDl = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      return {
        parserError: !!doc.querySelector('parsererror'),
        root: doc.documentElement.tagName,
        viewBox: doc.documentElement.getAttribute('viewBox'),
        width: doc.documentElement.getAttribute('width'),
        height: doc.documentElement.getAttribute('height'),
        devs: doc.querySelectorAll('.dev').length,
      };
    }, svgDlText);
    check(
      'B: кнопка «SVG» на верхней панели скачивает валидный векторный лист',
      !svgDl.parserError && svgDl.root === 'svg' && /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(svgDl.viewBox || '') && +svgDl.width > 300 && svgDl.devs > 0,
      JSON.stringify({ ...svgDl, file: svgDlPath })
    );
    check('B: скачанный SVG-файл имеет расширение .svg', /\.svg$/.test(svgDownload.suggestedFilename()), svgDownload.suggestedFilename());
    check('B: скачивание SVG сопровождается подтверждением', /выгружен в SVG/.test((await getState(page)).toast), (await getState(page)).toast);

    // проверка экспортированного файла как самостоятельного SVG-документа
    const svgViewer = await appB.ctx.newPage();
    await svgViewer.goto(base + 'tests/output/qa-export.svg', { waitUntil: 'load' });
    await sleep(400);
    const svgFileInfo = await svgViewer.evaluate(() => {
      const root = document.documentElement;
      const rect = root.getBoundingClientRect();
      let bbox = null;
      try {
        const b = root.getBBox();
        bbox = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      } catch {
        bbox = null;
      }
      const firstDev = document.querySelector('.dev')?.getBoundingClientRect();
      return {
        tag: root.tagName,
        viewBox: root.getAttribute('viewBox'),
        widthAttr: root.getAttribute('width'),
        heightAttr: root.getAttribute('height'),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        bbox,
        devs: document.querySelectorAll('.dev').length,
        firstDev: firstDev ? { y: Math.round(firstDev.y), h: Math.round(firstDev.height) } : null,
      };
    });
    await svgViewer.screenshot({ path: OUT + 'qa-08-export-svg.png' });
    await svgViewer.close();
    check(
      'B: экспортированный SVG как файл сохраняет viewBox/размер листа (BUG-5)',
      !!svgFileInfo.viewBox && svgFileInfo.rect.w > 1000 && !!svgFileInfo.bbox && svgFileInfo.bbox.w > 4000 && svgFileInfo.firstDev !== null && svgFileInfo.firstDev.y < svgFileInfo.rect.h,
      JSON.stringify(svgFileInfo)
    );

    /* ---------- B13. Плохие данные на импорте ---------- */
    section('B13. Импорт: битый JSON и неконсистентные данные');
    const devicesBeforeBad = (await getState(page)).devices;
    await page.setInputFiles('#file-input', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
    await sleep(700);
    const badJson = await getState(page);
    check('B: битый JSON — понятная ошибка, проект не изменён', /Не удалось прочитать файл/.test(badJson.toast) && badJson.devices === devicesBeforeBad && badJson.modalOpen === false, JSON.stringify({ toast: badJson.toast, devices: badJson.devices }));
    await page.setInputFiles('#file-input', { name: 'nowalls.json', mimeType: 'application/json', buffer: Buffer.from('{"project":{"devices":[]}}') });
    await sleep(700);
    const noWalls = await getState(page);
    check('B: JSON без массива walls отклонён с ошибкой', /Не удалось прочитать файл/.test(noWalls.toast) && noWalls.devices === devicesBeforeBad, JSON.stringify({ toast: noWalls.toast }));

    // координаты за стеной ограничиваются (BUG-2 fix)
    const oobPayload = {
      project: {
        walls: [{ id: 'w1', name: 'W', width: 6000, height: 2700 }],
        devices: [{ id: 'd1', modelId: 'dip34a', wallId: 'w1', x: 99999, y: -50, rot: 45, tag: '1.1' }],
        channels: [{ id: 'c1', wallId: 'w1', kind: 'кабель-канал', width: 40, points: [[0, 0], [100, 0]] }],
        dimensions: [{ id: 'dim1', wallId: 'w1', a: [0, 0], b: [500, 0] }],
      },
    };
    await page.setInputFiles('#file-input', { name: 'oob.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(oobPayload)) });
    await sleep(800);
    const oob = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.project.devices[0];
      const m = window.BolidGrid.getModel(d.modelId);
      const w = s.project.walls[0];
      return { x: d.x, y: d.y, rot: d.rot, wallW: w.width, wallH: w.height, modelW: m.w, modelH: m.h, devNodes: document.querySelectorAll('#devices .dev').length };
    });
    check(
      'B: импорт — координаты устройства ограничены габаритами стены (BUG-2 fix)',
      oob.x >= 0 && oob.y >= 0 && oob.x <= oob.wallW - oob.modelW && oob.y <= oob.wallH - oob.modelH && oob.rot === 0,
      JSON.stringify(oob)
    );

    // размерные линии: координаты ограничиваются, битые отбрасываются
    const dimPayload = {
      project: {
        walls: [{ id: 'w1', name: 'W', width: 6000, height: 2700 }],
        devices: [],
        channels: [],
        dimensions: [
          { id: 'dim1', wallId: 'w1', a: [-100, 99999], b: [7000, 400] },
          { id: 'dim2', wallId: 'нет-такой', a: [0, 0], b: [100, 0] },
        ],
      },
    };
    await page.setInputFiles('#file-input', { name: 'dims.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dimPayload)) });
    await sleep(800);
    const dimsImported = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const dims = s.project.dimensions || [];
      return { count: dims.length, a: dims[0]?.a, b: dims[0]?.b };
    });
    check(
      'B: импорт — размерные линии ограничиваются стеной, чужая стена отбрасывается',
      dimsImported.count === 1 && dimsImported.a[0] >= 0 && dimsImported.b[0] <= 6000 && dimsImported.a[1] <= 2700,
      JSON.stringify(dimsImported)
    );

    // неизвестные kind/color нормализуются
    const dirtyPayload = {
      project: {
        walls: [{ id: 'w1', name: 'W', width: 6000, height: 2700 }],
        devices: [],
        channels: [{ id: 'c1', wallId: 'w1', kind: 'ракета', width: -10, color: 'red', points: [[0, 0], [10, 10]] }],
      },
    };
    await page.setInputFiles('#file-input', { name: 'dirty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dirtyPayload)) });
    await sleep(800);
    const dirty = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return { channelKind: s.project.channels[0].kind, channelWidth: s.project.channels[0].width, channelColor: s.project.channels[0].color };
    });
    check('B: импорт — неизвестный тип канала и «чужой» цвет нормализуются', dirty.channelKind === 'кабель-канал' && dirty.channelWidth >= 5 && dirty.channelColor === '', JSON.stringify(dirty));

    /* ---------- B14. Нумерация после удаления первой стены (BUG-4 fix) ---------- */
    section('B14. Нумерация обозначений после удаления первой стены');
    await page.evaluate(() => window.BolidGrid.loadDemo(false));
    await sleep(900);
    const demoWalls = await page.evaluate(() => window.BolidGrid.store.project.walls.map((w) => ({ id: w.id, name: w.name })));
    const wall1Id = demoWalls[0].id;
    const tagsOnSecond = await page.evaluate(({ w1, w2 }) => {
      const s = window.BolidGrid.store;
      return { remain: s.project.devices.filter((d) => d.wallId === w2).map((d) => d.tag).sort() };
    }, { w1: wall1Id, w2: demoWalls[1].id });
    await page.locator(`#walls-list [data-wall-del="${wall1Id}"]`).click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    await page.locator('#modal-actions button', { hasText: 'Удалить' }).click();
    await sleep(600);
    const afterWallDel = await getState(page);
    check('B: первая стена удалена, осталась одна', afterWallDel.walls === 1, `walls=${afterWallDel.walls}`);
    await placeModel(page, 'sp2', 0.45, 0.55);
    const newTag = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.wallDevices[s.wallDevices.length - 1];
      return { tag: d.tag, existing: s.wallDevices.filter((x) => x.id !== d.id).map((x) => x.tag) };
    });
    const numFamily = (t) => String(t).split('.')[0];
    check('B: после удаления первой стены нумерация продолжает семейство (2.x), а не 1.x (BUG-4 fix)', numFamily(newTag.tag) === '2' && newTag.existing.every((t) => t !== newTag.tag), JSON.stringify(newTag));
    check('B: новое обозначение не дублирует существующие', !newTag.existing.includes(newTag.tag), JSON.stringify(newTag));

    /* ---------- B15. Новый проект и удаление последней стены ---------- */
    section('B15. Новый проект + защита от удаления последней стены');
    await page.evaluate(() => window.BolidGrid.loadDemo(false));
    await sleep(800);
    // после фикса BUG-6 кнопки панели «Объект» должны быть кликабельны мышью
    await page.locator('[data-action="edit-project"]').click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    const dlgTitle = await page.locator('#modal-title').innerText();
    await page.locator('#modal-actions button', { hasText: 'Отмена' }).click();
    await sleep(300);
    check('B: диалог «Свойства проекта» открывается кликом по кнопке', dlgTitle === 'Свойства проекта', dlgTitle);
    await page.locator('[data-action="reset"]').click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    await page.locator('#modal-actions button', { hasText: 'Подтвердить' }).click();
    await sleep(600);
    const fresh = await getState(page);
    check('B: «Новый проект» создаёт пустой проект с одной стеной', fresh.walls === 1 && fresh.devices === 0 && fresh.channels === 0 && (fresh.dims ?? 0) === 0, JSON.stringify({ walls: fresh.walls, devices: fresh.devices, dims: fresh.dims }));
    const wallDeleteButtons = await page.locator('#walls-list .wdel').count();
    check('B: кнопка удаления есть у единственной стены', wallDeleteButtons === 1);
    await page.locator('#walls-list .wdel').click();
    await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
    await page.locator('#modal-actions button', { hasText: 'Удалить' }).click();
    await sleep(500);
    const lastWall = await getState(page);
    check('B: последняя стена не удаляется (защита сработала)', lastWall.walls === 1 && lastWall.devices === 0, JSON.stringify({ walls: lastWall.walls }));
    const sheetAlive = await page.evaluate(() => ({
      sheet: document.querySelectorAll('#sheet .sheet').length,
      devNodes: document.querySelectorAll('#devices .dev').length,
      channelNodes: document.querySelectorAll('#channels .channel').length,
      wallName: window.BolidGrid.store.wall?.name,
    }));
    check('B: после попытки удаления последней стены редактор продолжает работать', sheetAlive.sheet === 1 && sheetAlive.devNodes === 0 && sheetAlive.channelNodes === 0 && !!sheetAlive.wallName, JSON.stringify(sheetAlive));
    await page.screenshot({ path: OUT + 'qa-07-final.png' });

    /* ---------- итоговые проверки страницы B ---------- */
    section('B16. Ошибки JS/консоли за весь прогон');
    check('B: нет pageerror на протяжении всех сценариев', errorsB.page.length === 0, errorsB.page.slice(0, 4).join(' | '));
    check('B: нет console.error на протяжении всех сценариев', errorsB.console.length === 0, errorsB.console.slice(0, 4).join(' | '));
    const xssFlag = await page.evaluate(() => typeof window.__xss);
    check('B: XSS-маркер так и не появился в window', xssFlag === 'undefined', xssFlag);
    PAGE_ERRORS = PAGE_ERRORS.concat(errorsB.page);
    CONSOLE_ERRORS = CONSOLE_ERRORS.concat(errorsB.console);
    await appB.ctx.close();

    /* ---------- скриншоты/файлы ---------- */
    section('FILES: артефакты прогона');
    for (const [name, minSize] of [
      ['qa-01-demo-1680.png', 20000],
      ['qa-02-1280.png', 20000],
      ['qa-03-print.png', 20000],
      ['qa-04-board.png', 20000],
      ['qa-05-spec.png', 20000],
      ['qa-06-journal.png', 20000],
      ['qa-07-final.png', 20000],
      ['qa-08-export-svg.png', 5000],
      ['qa-export.json', 1000],
      ['qa-export.svg', 5000],
      ['qa-export-file.svg', 5000],
      ['qa-spec.csv', 200],
    ]) {
      const st = await stat(OUT + name).catch(() => null);
      check(`FILES: ${name} сохранён (tests/output/, gitignored)`, !!st && st.size >= minSize, st ? `${st.size} байт` : 'нет файла');
    }
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGTERM');
  }
}

/* ============================ запуск ============================ */
main()
  .catch((err) => {
    console.error('\nQA-прогон упал с исключением:', err);
    failuresLog.push(`EXCEPTION: ${err?.stack || err}`);
  })
  .finally(async () => {
    const total = results.length;
    const failed = failuresLog.length;
    const summary = [
      '',
      `Всего проверок: ${total}, пройдено: ${total - failed}, провалено: ${failed}`,
      failed ? 'ПРОВАЛЕНО:' : 'Все проверки пройдены ✔',
      ...failuresLog.map((l) => `  - ${l}`),
      '',
      'pageerror: ' + JSON.stringify(PAGE_ERRORS),
      'console.error: ' + JSON.stringify(CONSOLE_ERRORS),
    ].join('\n');
    console.log(summary);
    await mkdir(OUT, { recursive: true }).catch(() => {});
    await writeFile(
      OUT + 'qa-result.txt',
      `${results.join('\n')}\n${summary}\n`,
      'utf8'
    ).catch(() => {});
    if (failed) process.exitCode = 1;
  });
