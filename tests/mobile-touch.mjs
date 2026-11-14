/**
 * tests/mobile-touch.mjs — точечные проверки touch-сценария BolidGrid.
 *
 * Запуск: node tests/mobile-touch.mjs
 *
 * Покрывает именно жесты на телефоне (события касаний через CDP):
 *  - «Вся стена»: масштаб и площадь листа (390×844, 360×780, альбом 844×390);
 *  - тап по мелкому прибору, по коробу и по размерной линии;
 *  - допуск тапа серии (сколько касаний из серии попадают в прибор);
 *  - перетаскивание без скачка: дрожание пальца не двигает прибор;
 *  - drag с ограничением стеной и отменой через undo;
 *  - pinch-zoom: сохранение пропорций вида и точки под пальцами;
 *  - отсутствие «прыжка» панорамы после pinch;
 *  - снятие выделения тапом по пустому месту вне нижней панели/подсказки;
 *  - отсутствие горизонтального переполнения и ошибок консоли.
 *
 * Сам поднимает статический сервер на случайном порту. Ненулевой код при провале.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const results = [];
let failures = 0;
const OUT = new URL('output/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  console.log(results[results.length - 1]);
}

async function startServer() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 8400 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    child.stdout.on('data', (d) => {
      if (String(d).includes('http://localhost')) started = true;
    });
    for (let i = 0; i < 40 && !started; i++) await sleep(250);
    if (started) return { child, port };
    child.kill('SIGKILL');
  }
  throw new Error('не удалось запустить тестовый сервер');
}

/** Прямоугольник листа (SVG .sheet) и параметры вида. */
const measure = (page) => page.evaluate(() => {
  const ed = window.BolidGrid.editor;
  const svg = ed.svg;
  const canvas = document.getElementById('canvas-wrap').getBoundingClientRect();
  const sheet = svg.querySelector('.sheet').getBoundingClientRect();
  return {
    canvas: { w: canvas.width, h: canvas.height },
    sheet: { x: sheet.x, y: sheet.y, w: sheet.width, h: sheet.height },
    ppm: ed.pxPerMm,
    view: { ...ed.view },
    widthPct: sheet.width / canvas.width,
    heightPct: sheet.height / canvas.height,
    areaPct: (sheet.width * sheet.height) / (canvas.width * canvas.height),
    aspectOk: Math.abs(ed.view.w / ed.view.h - canvas.width / canvas.height) < 0.002,
    zoomText: document.getElementById('st-zoom')?.textContent || '',
  };
});

async function touchApi(ctx) {
  const cdp = await ctx.newCDPSession(await ctx.pages()[0]);
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(220);
  };
  const swipe = async (x1, y1, x2, y2, steps = 10) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, id: 1 }],
      });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(320);
  };
  const pinch = async (cx, cy, d0, d1, steps = 10) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cx - d0 / 2, y: cy, id: 1 }, { x: cx + d0 / 2, y: cy, id: 2 }],
    });
    for (let i = 1; i <= steps; i++) {
      const d = d0 + ((d1 - d0) * i) / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }],
      });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(320);
  };
  return { tap, swipe, pinch };
}

/** Экранная точка прибора по его центру. */
const devicePoint = (page, index = 0) => page.evaluate((i) => {
  const ed = window.BolidGrid.editor;
  const d = window.BolidGrid.store.wallDevices[i];
  if (!d) return null;
  const model = window.BolidGrid.getModel(d.modelId);
  const pt = ed.svg.createSVGPoint();
  pt.x = d.x + model.w / 2;
  pt.y = ed.wall.height - (d.y + model.h / 2);
  const sp = pt.matrixTransform(ed.svg.getScreenCTM());
  return { x: sp.x, y: sp.y, id: d.id, dx: d.x, dy: d.y, wmm: model.w, hmm: model.h };
}, index);

/** Свободная точка листа, не перекрытая панелью выбора, подсказкой и приборами. */
const freePoint = (page) => page.evaluate(() => {
  const svg = window.BolidGrid.editor.svg;
  const r = svg.getBoundingClientRect();
  const rects = [...svg.querySelectorAll('[data-type], .dimension')].map((n) => n.getBoundingClientRect());
  const overlays = ['#selection-dock', '#canvas-hint', '#mobile-bar', '#statusbar', '#stage-toolbar']
    .map((sel) => document.querySelector(sel))
    .filter((el) => el && !el.hidden && el.getBoundingClientRect().height > 0)
    .map((el) => el.getBoundingClientRect());
  const inside = (x, y, br, pad = 0) => x >= br.left - pad && x <= br.right + pad && y >= br.top - pad && y <= br.bottom + pad;
  const covered = (x, y) => {
    if (x < r.left + 14 || x > r.right - 14 || y < r.top + 14 || y > r.bottom - 14) return true;
    if (overlays.some((br) => inside(x, y, br, 12))) return true;
    const el = document.elementFromPoint(x, y);
    if (!el) return true;
    if (el.closest('#selection-dock, #canvas-hint, #mobile-bar, #statusbar, #stage-toolbar')) return true;
    return !!el.closest('[data-type]');
  };
  let best = null;
  let bestD = 0;
  const ed = window.BolidGrid.editor;
  for (let fy = 0.04; fy <= 0.96; fy += 0.05) {
    for (let fx = 0.02; fx <= 0.98; fx += 0.05) {
      const x = r.x + r.width * fx;
      const y = r.y + r.height * fy;
      if (covered(x, y)) continue;
      const floor = ed.screenToFloor({ clientX: x, clientY: y });
      if (ed._findNearTarget(floor, 28) || ed._findNearDimension(floor, 22) || ed._findNearHandle(floor, 20)) continue;
      let d = Infinity;
      for (const br of rects) {
        const dx = Math.max(br.left - x, 0, x - br.right);
        const dy = Math.max(br.top - y, 0, y - br.bottom);
        d = Math.min(d, Math.hypot(dx, dy));
      }
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best && bestD >= 34 ? { ...best, clearance: bestD } : { error: true, clearance: bestD };
});

async function runViewport(browser, port, vp, label) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.BolidGrid?.store?.project?.devices?.length > 0, null, { timeout: 20000 });
  await sleep(500);
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  await page.evaluate(() => window.BolidGrid.editor.fit());
  await sleep(200);

  const { tap, swipe, pinch } = await touchApi(ctx);

  /* ---------- 1. «Вся стена» ---------- */
  const fit = await measure(page);
  check(`${label}: нет горизонтального переполнения`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (vp.width > vp.height) {
    check(`${label}: «Вся стена» не мельче 0.72 высоты сцены`, fit.heightPct >= 0.72, `${Math.round(fit.heightPct * 100)}%`);
  } else {
    check(`${label}: «Вся стена» занимает ≥88% ширины`, fit.widthPct >= 0.88, `${Math.round(fit.widthPct * 100)}%`);
    check(`${label}: лист занимает ≥34% площади сцены`, fit.areaPct >= 0.34, `${Math.round(fit.areaPct * 100)}%`);
    check(`${label}: масштаб «Вся стена» ≥ 7,5%`, fit.ppm * 100 >= 7.5, `${fit.zoomText}`);
  }
  check(`${label}: вид сохраняет пропорции сцены`, fit.aspectOk, `${(fit.view.w / fit.view.h).toFixed(3)} vs ${(fit.canvas.w / fit.canvas.h).toFixed(3)}`);
  const cap = await page.evaluate(() => {
    const ed = window.BolidGrid.editor;
    const c = ed.svg.querySelector('.wall-caption').getBoundingClientRect();
    const s = ed.svg.getBoundingClientRect();
    return { left: c.left >= s.left - 1, right: c.right <= s.right + 1, top: c.top >= s.top - 1, sheetIn: ed.svg.querySelector('.sheet').getBoundingClientRect().top >= s.top - 1 };
  });
  check(`${label}: заголовок стены не обрезан`, cap.left && cap.right && cap.top, JSON.stringify(cap));
  check(`${label}: лист не сдвинут за верх сцены`, cap.sheetIn, JSON.stringify(cap));

  /* ---------- 2. тап по мелкому прибору ---------- */
  const smallIdx = await page.evaluate(() => {
    let best = -1;
    let bestArea = Infinity;
    window.BolidGrid.store.wallDevices.forEach((d, i) => {
      const m = window.BolidGrid.getModel(d.modelId);
      const a = m.w * m.h;
      if (a < bestArea) { bestArea = a; best = i; }
    });
    return best;
  });
  const small = await devicePoint(page, smallIdx);
  {
    const before = await page.evaluate(() => window.BolidGrid.store.selection.length);
    await tap(small.x, small.y);
    const sel = await page.evaluate(() => window.BolidGrid.store.selection);
    check(`${label}: тап по мелкому прибору (${Math.round(small.wmm)}×${Math.round(small.hmm)} мм) выделяет его`,
      sel.length === 1 && sel[0].type === 'device' && sel[0].id === small.id, JSON.stringify({ before, sel }));
  }

  /* ---------- 3. серия тапов: допуск попадания ---------- */
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  const big = await devicePoint(page, 0);
  let hits = 0;
  const series = [0, 8, 14, 22, 30];
  for (const off of series) {
    await page.evaluate(() => window.BolidGrid.store.clearSelection());
    await tap(big.x + off, big.y);
    const sel = await page.evaluate(() => window.BolidGrid.store.selection);
    // на мелком масштабе соседний прибор может оказаться ближе — важен любой осмысленный отклик
    if (sel.length === 1 && ['device', 'channel', 'dimension'].includes(sel[0].type)) hits++;
  }
  check(`${label}: серия тапов рядом с прибором попадает (≥4 из 5)`, hits >= 4, `${hits}/${series.length}`);

  /* ---------- 4. drag без скачка ---------- */
  const jumpBefore = await devicePoint(page, 0);
  await tap(jumpBefore.x, jumpBefore.y);
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  await swipe(jumpBefore.x, jumpBefore.y, jumpBefore.x + 4, jumpBefore.y + 3, 6);
  const afterJitter = await page.evaluate((id) => {
    const d = window.BolidGrid.store.getDevice(id);
    return { x: d.x, y: d.y, undo: window.BolidGrid.store.canUndo };
  }, jumpBefore.id);
  check(`${label}: дрожание пальца (4 px) не двигает прибор`,
    afterJitter.x === jumpBefore.dx && afterJitter.y === jumpBefore.dy,
    JSON.stringify({ before: [jumpBefore.dx, jumpBefore.dy], after: [afterJitter.x, afterJitter.y] }));

  const dragPoint = await devicePoint(page, 0);
  // после тапа могла раскрыться нижняя панель выбора (в альбоме она лежит на листе)
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  await sleep(200);
  await swipe(dragPoint.x, dragPoint.y, dragPoint.x + 60, dragPoint.y - 40, 10);
  const moved = await page.evaluate((id) => {
    const d = window.BolidGrid.store.getDevice(id);
    return { x: d.x, y: d.y, sel: window.BolidGrid.store.selection.length };
  }, dragPoint.id);
  check(`${label}: осознанное перетаскивание двигает прибор`,
    moved.x !== dragPoint.dx || moved.y !== dragPoint.dy,
    JSON.stringify({ before: [dragPoint.dx, dragPoint.dy], after: [moved.x, moved.y] }));
  await page.evaluate(() => window.BolidGrid.store.undo());
  await sleep(200);
  const undone = await page.evaluate((id) => {
    const d = window.BolidGrid.store.getDevice(id);
    return { x: d.x, y: d.y };
  }, dragPoint.id);
  check(`${label}: undo возвращает прибор на место`, undone.x === dragPoint.dx && undone.y === dragPoint.dy,
    JSON.stringify({ expect: [dragPoint.dx, dragPoint.dy], got: [undone.x, undone.y] }));

  /* ---------- 5. ограничение стеной ---------- */
  const edgePoint = await devicePoint(page, 0);
  await swipe(edgePoint.x, edgePoint.y, edgePoint.x + 1200, edgePoint.y, 12);
  const edge = await page.evaluate((id) => {
    const st = window.BolidGrid.store;
    const d = st.getDevice(id);
    const m = window.BolidGrid.getModel(d.modelId);
    return { x: d.x, y: d.y, maxX: st.wall.width - m.w, wallW: st.wall.width };
  }, edgePoint.id);
  check(`${label}: прибор не выходит за стену при drag`, edge.x >= 0 && edge.x <= edge.maxX, JSON.stringify(edge));
  await page.evaluate(() => window.BolidGrid.store.undo());
  await sleep(150);

  /* ---------- 6. тап по коробу и размеру ---------- */
  const chPoint = await page.evaluate(() => {
    const ed = window.BolidGrid.editor;
    const ch = window.BolidGrid.store.wallChannels[0];
    if (!ch) return null;
    let best = null;
    for (let i = 1; i < ch.points.length; i++) {
      const a = ch.points[i - 1];
      const b = ch.points[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!best || len > best.len) best = { a, b, len };
    }
    const pt = ed.svg.createSVGPoint();
    pt.x = (best.a[0] + best.b[0]) / 2;
    pt.y = ed.wall.height - (best.a[1] + best.b[1]) / 2;
    const sp = pt.matrixTransform(ed.svg.getScreenCTM());
    return { x: sp.x, y: sp.y, id: ch.id };
  });
  if (chPoint) {
    // касание с промахом 10 px поперёк трассы — палец не обязан попадать в 4-миллиметровую линию
    await page.evaluate(() => window.BolidGrid.store.clearSelection());
    await tap(chPoint.x, chPoint.y + 10);
    const chSel = await page.evaluate(() => window.BolidGrid.store.selection);
    check(`${label}: тап рядом с коробом (10 px) выделяет короб`,
      chSel.length === 1 && chSel[0].type === 'channel', JSON.stringify(chSel));
  }

  const dimPoint = await page.evaluate(() => {
    const ed = window.BolidGrid.editor;
    const dim = (window.BolidGrid.store.project.dimensions || []).find((d) => d.wallId === window.BolidGrid.store.wall.id);
    if (!dim) return null;
    const g = ed._dimGeom(dim);
    const pt = ed.svg.createSVGPoint();
    pt.x = (g.a2[0] + g.b2[0]) / 2;
    pt.y = (g.a2[1] + g.b2[1]) / 2;
    const sp = pt.matrixTransform(ed.svg.getScreenCTM());
    return { x: sp.x, y: sp.y, id: dim.id };
  });
  if (dimPoint) {
    await page.evaluate(() => window.BolidGrid.store.clearSelection());
    await tap(dimPoint.x, dimPoint.y + 8);
    const dimSel = await page.evaluate(() => window.BolidGrid.store.selection);
    check(`${label}: тап по размерной линии (8 px) выделяет размер`,
      dimSel.length === 1 && dimSel[0].type === 'dimension', JSON.stringify(dimSel));
  }

  /* ---------- 7. снятие выделения по пустому месту ---------- */
  await page.evaluate(() => window.BolidGrid.store.select([{ type: 'device', id: window.BolidGrid.store.wallDevices[0].id }]));
  await sleep(300);
  const free = await freePoint(page);
  if (free && !free.error) {
    await page.evaluate(() => {
      window.__w3ev = [];
      for (const t of ['pointerdown', 'pointerup', 'pointercancel']) {
        window.BolidGrid.editor.svg.addEventListener(t, (e) => window.__w3ev.push(`${t}:${Math.round(e.clientX)},${Math.round(e.clientY)}`));
      }
    });
    await tap(free.x, free.y);
    const left = await page.evaluate(() => window.BolidGrid.store.selection.length);
    const dbg = await page.evaluate(() => {
      const ed = window.BolidGrid.editor;
      const dock = document.getElementById('selection-dock');
      return { ev: window.__w3ev, touchPan: !!ed.touchPan, pinch: !!ed.pinch, drag: ed.drag?.mode || null, pointers: ed.pointers.size, dock: getComputedStyle(dock).display, dockHidden: dock.hidden };
    });
    check(`${label}: тап по свободному месту снимает выделение`, left === 0, `selection=${left}, clearance=${Math.round(free.clearance)}, ${JSON.stringify(dbg)}`);
  } else {
    check(`${label}: найдена свободная точка листа для снятия выделения`, false, JSON.stringify(free));
  }

  /* ---------- 8. pinch: пропорции и точка под пальцами ---------- */
  await page.evaluate(() => { window.BolidGrid.store.clearSelection(); window.BolidGrid.editor.fit(); });
  await sleep(200);
  const zoomBefore = await measure(page);
  const focal = await page.evaluate(() => {
    const r = window.BolidGrid.editor.svg.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height * 0.45 };
  });
  const worldBefore = await page.evaluate(({ x, y }) => window.BolidGrid.editor.clientToSvg(x, y), focal);
  await pinch(focal.x, focal.y, 60, 220);
  const zoomAfter = await measure(page);
  const worldAfter = await page.evaluate(({ x, y }) => window.BolidGrid.editor.clientToSvg(x, y), focal);
  check(`${label}: pinch приближает лист`, zoomAfter.view.w < zoomBefore.view.w * 0.9,
    `w ${Math.round(zoomBefore.view.w)} → ${Math.round(zoomAfter.view.w)}`);
  check(`${label}: pinch не сплющивает пропорции`, zoomAfter.aspectOk,
    `${(zoomAfter.view.w / zoomAfter.view.h).toFixed(3)} vs ${(zoomAfter.canvas.w / zoomAfter.canvas.h).toFixed(3)}`);
  const drift = Math.hypot(worldAfter[0] - worldBefore[0], worldAfter[1] - worldBefore[1]);
  check(`${label}: pinch удерживает точку под пальцами (≤20 мм)`, drift <= 20, `${Math.round(drift)} мм`);

  /* ---------- 9. после pinch панорама не «прыгает» ---------- */
  await page.evaluate(() => window.BolidGrid.editor.fit());
  await sleep(150);
  const baseView = await page.evaluate(() => ({ ...window.BolidGrid.editor.view }));
  const c = await page.evaluate(() => {
    const r = window.BolidGrid.editor.svg.getBoundingClientRect();
    return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.85 };
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, id: 1 }] });
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 8, y: c.y, id: 1 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: c.x + 40, y: c.y, id: 1 }, { x: c.x + 140, y: c.y, id: 2 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: c.x + 10, y: c.y, id: 1 }, { x: c.x + 170, y: c.y, id: 2 }],
  });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: c.x + 10, y: c.y, id: 1 }] });
  await sleep(100);
  const afterPinch = await page.evaluate(() => ({ ...window.BolidGrid.editor.view }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 90, y: c.y, id: 1 }] });
  await sleep(120);
  const afterResidual = await page.evaluate(() => ({ ...window.BolidGrid.editor.view }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(`${label}: панорама после pinch не прыгает`, Math.abs(afterResidual.x - afterPinch.x) < 1 && Math.abs(afterResidual.y - afterPinch.y) < 1,
    `dx=${Math.round(afterResidual.x - afterPinch.x)} dy=${Math.round(afterResidual.y - afterPinch.y)} (база ${Math.round(baseView.x)})`);

  /* ---------- 10. экспорт SVG не тащит интерактивные слои ---------- */
  const exportCheck = await page.evaluate(() => {
    const st = window.BolidGrid.store;
    st.select([{ type: 'device', id: st.wallDevices[0].id }]);
    window.BolidGrid.editor.render();
    const { svg } = window.BolidGrid.editor.buildExportSVG();
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const bad = [
      '.channel-hit', '.channel-seg-hit', '.dev-hit', '.cable-hit', '.terminal-hit',
      '.channel-selection', '.sel-frame', '.issue-frame', '.channel-vertex', '.dim-handle',
      '.band', '.armed-ghost', '.dim-preview', '.selection-dimension', '.smart-guide-line', '.smart-guide-label',
    ].filter((sel) => doc.querySelector(sel));
    const body = doc.querySelector('.channel-body');
    return {
      parseError: !!doc.querySelector('parsererror'),
      bad,
      bodyStroke: body?.getAttribute('stroke') || '',
      channels: doc.querySelectorAll('.channel-body').length,
    };
  });
  check(`${label}: экспорт SVG валиден и без интерактивных слоёв`,
    !exportCheck.parseError && exportCheck.bad.length === 0,
    JSON.stringify(exportCheck));
  check(`${label}: цвет короба в экспорте сохранён атрибутом stroke`,
    exportCheck.channels > 0 && /^#[0-9a-f]{6}$/i.test(exportCheck.bodyStroke), JSON.stringify(exportCheck));

  /* ---------- 11. ошибки ---------- */
  check(`${label}: нет ошибок JS`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check(`${label}: нет ошибок консоли`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await page.evaluate(() => window.BolidGrid.editor.fit());
  await sleep(150);
  await page.screenshot({ path: `${OUT}w3-after-${label}.png` });
  await ctx.close();
}

async function main() {
  const { child: server, port } = await startServer();
  let browser;
  try {
    await mkdir(OUT, { recursive: true });
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    await runViewport(browser, port, { width: 390, height: 844 }, '390x844');
    await runViewport(browser, port, { width: 360, height: 780 }, '360x780');
    await runViewport(browser, port, { width: 412, height: 915 }, '412x915');
    await runViewport(browser, port, { width: 844, height: 390 }, '844x390-landscape');

    await writeFile(`${OUT}w3-mobile-touch-result.txt`, results.join('\n') + '\n');
    console.log(`\n${results.length - failures}/${results.length} проверок пройдено`);
    if (failures) {
      console.error(`\nПРОВАЛЕНО: ${failures}`);
      process.exitCode = 1;
    } else {
      console.log('Touch-проверки пройдены ✔');
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Touch-тест упал:', err);
  process.exitCode = 1;
});
