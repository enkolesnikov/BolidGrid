/**
 * tests/smoke.mjs — смоук-тест интерфейса BolidGrid в headless Chromium.
 *
 * Требуется Playwright:  npm install && npx playwright install chromium
 * Запуск:                npm test
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = 8123;
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const results = [];
let failures = 0;

function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  console.log(results[results.length - 1]);
}

function waitForServer(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), timeoutMs);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('http://localhost')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, ['server.mjs', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await waitForServer(server);
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.BolidGrid?.store?.project?.devices?.length > 0, null, { timeout: 15000 });
    await sleep(400);

    const state = () =>
      page.evaluate(() => {
        const s = window.BolidGrid.store;
        return {
          devices: s.project.devices.length,
          channels: s.project.channels.length,
          dims: (s.project.dimensions || []).length,
          walls: s.project.walls.length,
          tool: s.tool,
          selection: s.selection.length,
          spec: !!s.spec,
          wall: s.wall?.name,
        };
      });

    const s0 = await state();
    check('демо-проект загружен', s0.devices >= 6 && s0.walls === 1, JSON.stringify(s0));
    check('спецификация загружена из data/spec.json', s0.spec);

    const paletteCount = await page.locator('#palette-list .pal-item').count();
    check('палитра устройств содержит модели', paletteCount >= 11, `items=${paletteCount}`);
    const specBadge = await page.locator('#palette-list .pal-item[data-model="sp2"]').innerText();
    check('в палитре показано «размещено / по спецификации»', /\/\s*4/.test(specBadge), specBadge.replace(/\s+/g, ' '));

    // --- размещение устройства из палитры ---
    await page.locator('#palette-list .pal-item[data-model="sp2"]').click();
    const toolAfterArm = (await state()).tool;
    check('выбор модели в палитре включает режим размещения', toolAfterArm === 'place', toolAfterArm);
    const wallBox = await page.locator('#wall').boundingBox();
    await page.mouse.click(wallBox.x + wallBox.width * 0.45, wallBox.y + wallBox.height * 0.5);
    await sleep(200);
    const afterPlace = await state();
    check('клик по стене добавляет устройство', afterPlace.devices === s0.devices + 1, `${s0.devices} → ${afterPlace.devices}`);
    check('режим размещения остаётся включённым (можно ставить подряд)', afterPlace.tool === 'place', afterPlace.tool);
    await page.mouse.click(wallBox.x + wallBox.width * 0.52, wallBox.y + wallBox.height * 0.5);
    await sleep(200);
    check('второй клик ставит ещё один прибор без повторного выбора модели', (await state()).devices === s0.devices + 2, `devices=${(await state()).devices}`);
    await page.keyboard.press('Escape');
    await sleep(200);
    check('Esc завершает режим размещения', (await state()).tool === 'select', (await state()).tool);

    // --- размеры стены задаются в панели инструментов ---
    await page.fill('#wall-w', '5.2');
    await page.locator('#wall-w').press('Enter');
    await sleep(300);
    const wallSize = await page.evaluate(() => ({ w: window.BolidGrid.store.wall.width, h: window.BolidGrid.store.wall.height }));
    check('ширина стены меняется через поле «Стена»', wallSize.w === 5200, JSON.stringify(wallSize));
    await page.fill('#wall-w', '4.2');
    await page.locator('#wall-w').press('Enter');
    await sleep(300);
    await page.evaluate(() => document.activeElement?.blur());

    // --- кабельный канал ---
    await page.keyboard.press('c');
    check('клавиша C включает инструмент «канал»', (await state()).tool === 'channel');
    await page.mouse.click(wallBox.x + wallBox.width * 0.2, wallBox.y + wallBox.height * 0.2);
    await page.mouse.click(wallBox.x + wallBox.width * 0.65, wallBox.y + wallBox.height * 0.2);
    await page.mouse.click(wallBox.x + wallBox.width * 0.65, wallBox.y + wallBox.height * 0.55);
    await page.keyboard.press('Enter');
    await sleep(250);
    const afterChannel = await state();
    check('рисование канала: ломаная из 3 точек добавляет канал', afterChannel.channels === s0.channels + 1, `${s0.channels} → ${afterChannel.channels}`);

    // --- короб DKC 100×40: ширина трассы по умолчанию ---
    const channelWidth = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      return { kind: ch.kind, width: ch.width };
    });
    check('канал создаётся как короб шириной 100 мм', channelWidth.width === 100, JSON.stringify(channelWidth));

    // --- цвет короба ---
    const chPoint = await page.evaluate(() => {
      const ed = window.BolidGrid.editor;
      const ch = window.BolidGrid.store.project.channels[window.BolidGrid.store.project.channels.length - 1];
      const pt = ed.svg.createSVGPoint();
      pt.x = (ch.points[0][0] + ch.points[1][0]) / 2;
      pt.y = ed.wall.height - (ch.points[0][1] + ch.points[1][1]) / 2;
      const sp = pt.matrixTransform(ed.svg.getScreenCTM());
      return { x: sp.x, y: sp.y };
    });
    await page.mouse.click(chPoint.x, chPoint.y);
    await sleep(250);
    const chSel = await page.evaluate(() => window.BolidGrid.store.selection[0]?.type);
    check('клик по трассе выделяет короб', chSel === 'channel', String(chSel));
    // --- короб всегда прямой: тянем вершину по диагонали ---
    const vx = await page.evaluate(() => {
      const ed = window.BolidGrid.editor;
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const pt = ed.svg.createSVGPoint();
      pt.x = ch.points[1][0];
      pt.y = ed.wall.height - ch.points[1][1];
      const sp = pt.matrixTransform(ed.svg.getScreenCTM());
      return { x: sp.x, y: sp.y };
    });
    await page.mouse.move(vx.x, vx.y);
    await page.mouse.down();
    await page.mouse.move(vx.x + 70, vx.y + 55, { steps: 8 });
    await page.mouse.up();
    await sleep(350);
    const ortho = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const segs = ch.points.slice(1).map((p, i) => [p[0] - ch.points[i][0], p[1] - ch.points[i][1]]);
      return { points: ch.points, straight: segs.every(([dx, dy]) => dx === 0 || dy === 0) };
    });
    check('короб остаётся прямым: после перетаскивания вершины все сегменты H/V', ortho.straight, JSON.stringify(ortho));

    // --- перетаскивание участка короба и всего короба ---
    const segMid = await page.evaluate(() => {
      const ed = window.BolidGrid.editor;
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const pt = ed.svg.createSVGPoint();
      pt.x = (ch.points[0][0] + ch.points[1][0]) / 2;
      pt.y = ed.wall.height - (ch.points[0][1] + ch.points[1][1]) / 2;
      const sp = pt.matrixTransform(ed.svg.getScreenCTM());
      return { x: sp.x, y: sp.y, pts: ch.points.map((p) => [...p]) };
    });
    const dragPts = async (x1, y1, x2, y2, shift = false) => {
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 8 });
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
      await sleep(300);
    };
    await dragPts(segMid.x, segMid.y, segMid.x + 20, segMid.y + 45);
    const segMoved = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      return { pts: ch.points, straight: ch.points.slice(1).every((p, i) => p[0] === ch.points[i][0] || p[1] === ch.points[i][1]) };
    });
    check(
      'линию короба можно тянуть: сдвиг участка сохраняет прямоту',
      segMoved.straight && (segMoved.pts[0][1] !== segMid.pts[0][1] || segMoved.pts[0][0] !== segMid.pts[0][0]),
      JSON.stringify({ before: segMid.pts, after: segMoved.pts })
    );
    await page.keyboard.press('Escape');
    // Shift+протяжка — весь короб
    const wholeStart = await page.evaluate(() => {
      const ed = window.BolidGrid.editor;
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const pt = ed.svg.createSVGPoint();
      pt.x = (ch.points[0][0] + ch.points[1][0]) / 2;
      pt.y = ed.wall.height - (ch.points[0][1] + ch.points[1][1]) / 2;
      const sp = pt.matrixTransform(ed.svg.getScreenCTM());
      return { x: sp.x, y: sp.y, pts: ch.points.map((p) => [...p]) };
    });
    await dragPts(wholeStart.x, wholeStart.y, wholeStart.x + 50, wholeStart.y - 30, true);
    const wholeMoved = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const straight = ch.points.slice(1).every((p, i) => p[0] === ch.points[i][0] || p[1] === ch.points[i][1]);
      return { pts: ch.points, straight };
    });
    const dxs = wholeMoved.pts.map((p, i) => p[0] - wholeStart.pts[i][0]);
    const dys = wholeMoved.pts.map((p, i) => p[1] - wholeStart.pts[i][1]);
    check(
      'Shift+протяжка двигает весь короб целиком',
      wholeMoved.straight && new Set(dxs).size === 1 && new Set(dys).size === 1 && (dxs[0] !== 0 || dys[0] !== 0),
      JSON.stringify({ dxs, dys })
    );

    const swatchCount = await page.locator('#tab-props [data-ch-color]').count();
    check('в свойствах короба есть палитра цветов', swatchCount >= 6, `swatches=${swatchCount}`);
    await page.locator('#tab-props [data-ch-color]').nth(2).click();
    await sleep(250);
    const chColor = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const ch = s.project.channels[s.project.channels.length - 1];
      const path = document.querySelector(`#channels .channel[data-id="${ch.id}"] .channel-body`);
      return { color: ch.color, stroke: path?.getAttribute('stroke') || '' };
    });
    check('цвет короба меняется и применяется на листе', /^#[0-9a-fA-F]{6}$/.test(chColor.color) && chColor.stroke.toLowerCase() === chColor.color.toLowerCase(), JSON.stringify(chColor));

    // --- размерные линии ---
    const dimsBefore = await page.evaluate(() => (window.BolidGrid.store.project.dimensions || []).length);
    await page.locator('#stage-toolbar [data-tool="dimension"]').click();
    check('инструмент «Размер» включается', (await state()).tool === 'dimension');
    await page.mouse.click(wallBox.x + wallBox.width * 0.25, wallBox.y + wallBox.height * 0.8);
    await sleep(120);
    await page.mouse.click(wallBox.x + wallBox.width * 0.7, wallBox.y + wallBox.height * 0.8);
    await sleep(250);
    const dimState = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const dim = s.project.dimensions[s.project.dimensions.length - 1];
      const text = document.querySelector('#dimensions .dim-text')?.textContent || '';
      const arrows = document.querySelectorAll('#dimensions .dim-arrow').length;
      const domDims = document.querySelectorAll('#dimensions .dimension').length;
      return { count: s.project.dimensions.length, domDims, text, arrows, len: dim ? Math.round(Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1])) : 0 };
    });
    check(
      'размерная линия создаётся и подписывается длиной',
      dimState.count === dimsBefore + 1 && /\d/.test(dimState.text) && /мм/.test(dimState.text),
      JSON.stringify({ before: dimsBefore, ...dimState })
    );
    check('у каждой размерной линии две стрелки', dimState.domDims > 0 && dimState.arrows === dimState.domDims * 2, `arrows=${dimState.arrows}, domDims=${dimState.domDims}`);
    await page.keyboard.press('Delete');
    await sleep(250);
    check('размерная линия удаляется', (await page.evaluate(() => window.BolidGrid.store.project.dimensions.length)) === dimsBefore);

    // --- подписи: режим «нет» скрывает обозначения ---
    await page.selectOption('#sel-labels', 'none');
    await sleep(300);
    const labelsOff = await page.evaluate(() => ({ tags: document.querySelectorAll('#devices .dev-tag').length, mode: window.BolidGrid.store.settings.labels }));
    check('режим «Подписи: нет» убирает обозначения с листа', labelsOff.tags === 0 && labelsOff.mode === 'none', JSON.stringify(labelsOff));
    await page.selectOption('#sel-labels', 'tag');
    await sleep(300);
    check('режим «кратко» возвращает обозначения', (await page.evaluate(() => document.querySelectorAll('#devices .dev-tag').length)) > 0);

    // --- выделение устройства и инспектор ---
    await page.locator('.dev-hit').first().click();
    await sleep(150);
    const sel = await state();
    check('клик по устройству выделяет его', sel.selection === 1, `selection=${sel.selection}`);
    check('инспектор устройства показывает поля', (await page.locator('#tab-props input[data-f="tag"]').count()) === 1);

    // --- смена обозначения ---
    await page.fill('#tab-props input[data-f="tag"]', 'TEST-1');
    await page.locator('#tab-props input[data-f="tag"]').press('Enter');
    await sleep(200);
    const tagText = await page.evaluate(() => window.BolidGrid.store.selectedDevices()[0]?.tag);
    check('изменение обозначения сохраняется', tagText === 'TEST-1', String(tagText));

    // --- мультивыделение и удаление с отменой ---
    await page.locator('.dev-hit').nth(0).click();
    await page.keyboard.down('Shift');
    await page.locator('.dev-hit').nth(1).click();
    await page.keyboard.up('Shift');
    const selTwo = (await state()).selection;
    check('Shift+клик добавляет второе устройство', selTwo >= 2, `selection=${selTwo}`);
    const beforeDelete = (await state()).devices;
    await page.keyboard.press('Delete');
    await sleep(300);
    const afterDelete = await state();
    check('Delete удаляет выделенные устройства', afterDelete.devices < beforeDelete, `${beforeDelete} → ${afterDelete.devices}`);

    // --- undo ---
    await page.keyboard.press('Control+z');
    await sleep(300);
    const afterUndo = await state();
    check('Ctrl+Z возвращает удалённые устройства', afterUndo.devices === beforeDelete, `${afterDelete.devices} → ${afterUndo.devices}`);

    // --- точное положение, размеры и согласование с коробом ---
    const posId = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.wallDevices[0];
      s.selectOne('device', d.id);
      return d.id;
    });
    await sleep(180);
    const posDevice = () => page.evaluate((id) => {
      const s = window.BolidGrid.store;
      const d = s.getDevice(id);
      const m = window.BolidGrid.getModel(d.modelId);
      return { x: d.x, y: d.y, w: m.w, h: m.h };
    }, posId);
    const changePos = async (axis, value) => {
      const input = page.locator(`#tab-props [data-pos-${axis}]`);
      await input.fill(String(value));
      await input.press('Enter');
      await sleep(100);
    };

    await page.selectOption('#tab-props [data-anchor-x]', 'center');
    await changePos('x', 2100);
    let pd = await posDevice();
    check('X до центра прибора пересчитывается в координату левого края', pd.x === Math.round(2100 - pd.w / 2), JSON.stringify(pd));
    await page.selectOption('#tab-props [data-anchor-x]', 'right');
    await changePos('x', 3000);
    pd = await posDevice();
    check('X до правого края учитывает ширину прибора', pd.x === 3000 - pd.w, JSON.stringify(pd));
    await page.selectOption('#tab-props [data-anchor-x]', 'left');
    await changePos('x', 400);
    pd = await posDevice();
    check('X слева до прибора задаёт координату напрямую', pd.x === 400, JSON.stringify(pd));

    await page.selectOption('#tab-props [data-anchor-y]', 'center');
    await changePos('y', 1350);
    pd = await posDevice();
    check('H до центра прибора учитывает половину высоты', pd.y === Math.round(1350 - pd.h / 2), JSON.stringify(pd));
    await page.selectOption('#tab-props [data-anchor-y]', 'top');
    await changePos('y', 2000);
    pd = await posDevice();
    check('H до верха прибора учитывает полную высоту', pd.y === 2000 - pd.h, JSON.stringify(pd));
    await page.locator('#tab-props [data-height="1500"]').click();
    pd = await posDevice();
    check('быстрая высота задаёт низ прибора от пола', pd.y === 1500, JSON.stringify(pd));

    const temporaryDims = await page.evaluate(() => ({
      groups: document.querySelectorAll('#overlay .selection-dimension').length,
      labels: document.querySelectorAll('#overlay .smart-guide-label').length,
      enabled: window.BolidGrid.store.settings.selectionDims,
    }));
    check('у выбранного прибора видны временные отступы и габарит', temporaryDims.enabled && temporaryDims.groups === 1 && temporaryDims.labels >= 1, JSON.stringify(temporaryDims));
    await page.locator('#tab-props [data-act="toggle-guides"]').click();
    await sleep(100);
    check('временные отступы можно отключить', (await page.locator('#overlay .selection-dimension').count()) === 0);
    await page.locator('#tab-props [data-act="toggle-guides"]').click();
    const beforeDeviceDims = await page.evaluate(() => window.BolidGrid.store.project.dimensions.length);
    await page.locator('#tab-props [data-act="add-dims"]').click();
    await sleep(150);
    const addedDims = await page.evaluate((before) => {
      const s = window.BolidGrid.store;
      const d = s.selectedDevices()[0];
      const added = s.project.dimensions.slice(before);
      return {
        count: s.project.dimensions.length,
        added: added.map((x) => ({ a: x.a, b: x.b, offset: x.offset })),
        expected: { x: d.x, y: d.y },
      };
    }, beforeDeviceDims);
    check('кнопка добавляет постоянные размеры слева и от пола', addedDims.count === beforeDeviceDims + 2 && addedDims.added.length === 2 && addedDims.added.every((d) => d.offset < 0), JSON.stringify(addedDims));
    await page.keyboard.press('Control+z');
    await sleep(150);
    check('оба добавленных размера отменяются одним действием', (await page.evaluate(() => window.BolidGrid.store.project.dimensions.length)) === beforeDeviceDims);

    // Undo намеренно очищает выделение — вернём прибор перед проверкой стрелок.
    await page.evaluate((id) => window.BolidGrid.store.selectOne('device', id), posId);
    await sleep(100);
    const beforeNudge = await posDevice();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    const afterNudge = await posDevice();
    check('стрелки двигают прибор на 10 мм, с Shift — на 1 мм', afterNudge.x === beforeNudge.x + 10 && afterNudge.y === beforeNudge.y + 1, JSON.stringify({ before: beforeNudge, after: afterNudge }));

    const exportedGuides = await page.evaluate(async () => {
      const text = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      return { dims: doc.querySelectorAll('.selection-dimension').length, lines: doc.querySelectorAll('.smart-guide-line').length, labels: doc.querySelectorAll('.smart-guide-label').length };
    });
    check('временные направляющие не попадают в экспорт SVG', exportedGuides.dims === 0 && exportedGuides.lines === 0 && exportedGuides.labels === 0, JSON.stringify(exportedGuides));

    // Три прибора: все шесть выравниваний и равномерное распределение.
    const groupIds = await page.evaluate(() => window.BolidGrid.store.wallDevices.slice(0, 3).map((d) => d.id));
    const resetGroup = async () => {
      await page.evaluate((ids) => {
        const s = window.BolidGrid.store;
        const coords = [[300, 900], [900, 600], [1600, 1200]];
        ids.forEach((id, i) => { const d = s.getDevice(id); d.x = coords[i][0]; d.y = coords[i][1]; });
        s.select(ids.map((id) => ({ type: 'device', id })));
      }, groupIds);
      await sleep(100);
    };
    const groupRects = () => page.evaluate((ids) => ids.map((id) => {
      const d = window.BolidGrid.store.getDevice(id);
      const m = window.BolidGrid.getModel(d.modelId);
      return { id, x: d.x, y: d.y, w: m.w, h: m.h };
    }), groupIds);
    for (const mode of ['left', 'right', 'center-x', 'bottom', 'top', 'center-y']) {
      await resetGroup();
      const before = await groupRects();
      await page.locator(`#tab-props [data-align="${mode}"]`).click();
      const after = await groupRects();
      const expected = before.map((r) => {
        let x = r.x, y = r.y;
        if (mode === 'left') x = Math.min(...before.map((v) => v.x));
        if (mode === 'right') x = Math.max(...before.map((v) => v.x + v.w)) - r.w;
        if (mode === 'center-x') x = Math.round((Math.min(...before.map((v) => v.x)) + Math.max(...before.map((v) => v.x + v.w))) / 2 - r.w / 2);
        if (mode === 'bottom') y = Math.min(...before.map((v) => v.y));
        if (mode === 'top') y = Math.max(...before.map((v) => v.y + v.h)) - r.h;
        if (mode === 'center-y') y = Math.round((Math.min(...before.map((v) => v.y)) + Math.max(...before.map((v) => v.y + v.h))) / 2 - r.h / 2);
        return { id: r.id, x, y };
      });
      check(`групповое выравнивание: ${mode}`, after.every((r, i) => r.x === expected[i].x && r.y === expected[i].y), JSON.stringify({ expected, after }));
    }
    for (const [mode, axis, size] of [['distribute-x', 'x', 'w'], ['distribute-y', 'y', 'h']]) {
      await resetGroup();
      await page.locator(`#tab-props [data-align="${mode}"]`).click();
      const rects = await groupRects();
      const centers = rects.map((r) => r[axis] + r[size] / 2).sort((a, b) => a - b);
      check(`равномерное распределение: ${mode}`, Math.abs((centers[0] + centers[2]) / 2 - centers[1]) <= 1, JSON.stringify(centers));
    }

    await page.evaluate((id) => window.BolidGrid.store.selectOne('device', id), posId);
    await sleep(100);
    const channelLevels = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.selectedDevices()[0];
      const m = window.BolidGrid.getModel(d.modelId);
      const levels = s.wallChannels.filter((c) => c.points.some((p, i) => i && p[1] === c.points[i - 1][1])).flatMap((c) => c.points.slice(1).filter((p, i) => p[1] === c.points[i][1]).map((p) => ({ y: p[1], width: c.width || 40 })));
      const above = levels.slice().sort((a, b) => Math.abs(a.y - d.y) - Math.abs(b.y - d.y))[0];
      return { aboveY: Math.min(s.wall.height - m.h, above.y + above.width / 2) };
    });
    await page.locator('#tab-props [data-act="device-above-channel"]').click();
    pd = await posDevice();
    check('низ прибора можно поставить на верхнюю кромку короба', pd.y === channelLevels.aboveY, JSON.stringify({ actual: pd.y, expected: channelLevels.aboveY }));
    const belowExpected = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const d = s.selectedDevices()[0];
      const m = window.BolidGrid.getModel(d.modelId);
      const levels = s.wallChannels.filter((c) => c.points.some((p, i) => i && p[1] === c.points[i - 1][1])).flatMap((c) => c.points.slice(1).filter((p, i) => p[1] === c.points[i][1]).map((p) => ({ y: p[1], width: c.width || 40 })));
      const below = levels.sort((a, b) => Math.abs(a.y - (d.y + m.h)) - Math.abs(b.y - (d.y + m.h)))[0];
      return Math.max(0, below.y - below.width / 2 - m.h);
    });
    await page.locator('#tab-props [data-act="device-below-channel"]').click();
    pd = await posDevice();
    check('верх прибора можно привязать к нижней кромке короба', pd.y === belowExpected, JSON.stringify({ actual: pd.y, expected: belowExpected }));

    const simpleChannelId = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      const c = s.wallChannels.find((x) => x.points.length === 2 && x.points[0][1] === x.points[1][1]);
      s.selectOne('channel', c.id);
      return c.id;
    });
    await sleep(100);
    const chHeight = page.locator('#tab-props [data-ch-point="0"][data-axis="1"]');
    await chHeight.fill('1600');
    await chHeight.press('Enter');
    await sleep(120);
    const exactChannel = await page.evaluate((id) => window.BolidGrid.store.getChannel(id).points, simpleChannelId);
    check('высота горизонтальной трассы меняется синхронно в обеих точках', exactChannel[0][1] === 1600 && exactChannel[1][1] === 1600, JSON.stringify(exactChannel));

    await page.evaluate((id) => window.BolidGrid.store.selectOne('device', id), posId);
    await sleep(120);
    await page.screenshot({ path: new URL('output/smoke-positioning.png', import.meta.url).pathname, fullPage: false });

    // --- спецификация ---
    await page.locator('#tabs button[data-tab="spec"]').click();
    await page.waitForSelector('#tab-spec table');
    const specTables = await page.locator('#tab-spec table').count();
    const specText = await page.locator('#tab-spec').innerText();
    check('вкладка «Спецификация» отрисована', specTables >= 2, `tables=${specTables}`);
    check('в спецификации есть «Сириус» и С2000-СП2, убранных позиций нет', /Сириус/.test(specText) && /С2000-СП\s*2/.test(specText) && !/ДИП-34А-04/.test(specText) && !/Маяк-24-3М/.test(specText) && !/КМ-О/.test(specText), specText.replace(/\s+/g, ' ').slice(0, 120));
    check('в спецификации есть сопоставление факта и количества', /по\s*спец\./i.test(specText) && /факт/i.test(specText));
    check('в спецификации посчитана длина кабеля по журналу', /КПСнг/.test(specText), '');
    const cable = await page.evaluate(() => {
      const table = [...document.querySelectorAll('#tab-spec table')].find((t) => /КПСнг/.test(t.textContent));
      if (!table) return null;
      const row = [...table.querySelectorAll('tbody tr')].find((tr) => /КПСнг/.test(tr.textContent));
      if (!row) return null;
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
      const parse = (s) => parseFloat(String(s).replace(/[\s\u00a0]/g, '').replace(',', '.'));
      return { cells, plan: parse(cells[5]), fact: parse(cells[6]), diff: parse(cells[7]) };
    });
    check(
      'кабель: «Факт» в метрах и сопоставим с проектом (не мм)',
      !!cable && cable.fact > 0 && cable.fact < 1000 && Math.abs(cable.diff - (cable.fact - cable.plan)) < 0.05,
      JSON.stringify(cable)
    );

    // --- кабельный журнал ---
    await page.locator('#tabs button[data-tab="journal"]').click();
    await page.waitForSelector('#tab-journal table');
    const journalRows = await page.locator('#tab-journal table').first().locator('tbody tr').count();
    check('кабельный журнал содержит строки трасс', journalRows === afterUndo.channels, `rows=${journalRows}, channels=${afterUndo.channels}`);
    const journalText = await page.locator('#tab-journal').innerText();
    check('ведомость короба содержит длину и итог', /итого короба/i.test(journalText.replace(/\s+/g, ' ')) && /длина,\s*м/i.test(journalText.replace(/\s+/g, ' ')), journalText.replace(/\s+/g, ' ').slice(0, 90));

    // --- отрисовка SVG ---
    await page.locator('#wall-tabs .wall-tab').first().click();
    await sleep(250);
    const dom = await page.evaluate(() => {
      const s = window.BolidGrid.store;
      return {
        devNodes: document.querySelectorAll('#devices .dev').length,
        wallDevices: s.wallDevices.length,
        channelNodes: document.querySelectorAll('#channels .channel').length,
        wallChannels: s.wallChannels.length,
        drops: document.querySelectorAll('#drops .drop').length,
        groupLinks: document.querySelectorAll('#groups .group-link').length,
      };
    });
    check('все устройства стены отрисованы в SVG', dom.devNodes === dom.wallDevices, JSON.stringify(dom));
    check('все каналы стены отрисованы в SVG', dom.channelNodes === dom.wallChannels, JSON.stringify(dom));
    check('точек подключения и линий шлейфов нет (упрощённый план)', dom.drops === 0 && dom.groupLinks === 0, JSON.stringify(dom));

    // --- экспорт ---
    const svg = await page.evaluate(async () => (await window.BolidGrid.editor.exportSVGFile()).length);
    check('экспорт SVG формирует документ', svg > 5000, `chars=${svg}`);
    const svgValid = await page.evaluate(async () => {
      const s = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
      return !doc.querySelector('parsererror') && doc.documentElement.tagName === 'svg' && doc.querySelectorAll('.dev').length > 0;
    });
    check('экспортированный SVG — корректный XML с устройствами', svgValid);
    const svgRoot = await page.evaluate(async () => {
      const s = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
      const root = doc.documentElement;
      return {
        viewBox: root.getAttribute('viewBox'),
        width: root.getAttribute('width'),
        height: root.getAttribute('height'),
        devs: doc.querySelectorAll('.dev').length,
        hasSheet: !!doc.querySelector('.sheet'),
      };
    });
    check(
      'экспортированный SVG имеет viewBox, размеры и лист стены',
      !!svgRoot.viewBox && !!svgRoot.width && !!svgRoot.height && svgRoot.devs > 0 && svgRoot.hasSheet,
      JSON.stringify(svgRoot)
    );
    const json = await page.evaluate(() => window.BolidGrid.store.serialize().length);
    check('экспорт JSON проекта', json > 1000, `chars=${json}`);
    const saved = await page.evaluate(() => !!localStorage.getItem('bolidgrid:project:v1'));
    check('автосохранение в localStorage', saved);

    // --- переключение стен ---
    const secondWall = await page.locator('#wall-tabs .wall-tab').nth(1);
    if (await secondWall.count()) {
      await secondWall.click();
      await sleep(300);
      check('переключение на вторую стену', (await state()).wall !== s0.wall, String((await state()).wall));
    }

    await mkdir(new URL('output/', import.meta.url).pathname, { recursive: true }).catch(() => {});
    await page.screenshot({ path: new URL('output/smoke.png', import.meta.url).pathname, fullPage: false });
    await writeFile(new URL('output/smoke-result.txt', import.meta.url).pathname, results.join('\n') + '\n');

    // --- устойчивость импорта: ограничение координат и согласование состава ---
    const imported = await page.evaluate(() => {
      const st = window.BolidGrid.store;
      st.replaceProject({
        walls: [{ id: 'w1', name: 'W', width: 6000, height: 2700 }],
        devices: [
          { id: 'd1', modelId: 'dip34a', wallId: 'w1', x: 99999, y: -50 },
          { id: 'd2', modelId: 'sp2', wallId: 'w1', x: 100, y: 100 },
        ],
        channels: [{ id: 'c1', wallId: 'w1', kind: 'кабель-канал', width: 100, points: [[0, 0], [400, 300], [400, 300], [900, 650]], color: 'не-цвет' }],
        dimensions: [{ id: 'dim1', wallId: 'w1', a: [0, 0], b: [500, 0] }],
      });
      const d = st.project.devices[0];
      const ch = st.project.channels[0];
      const segs = ch.points.slice(1).map((p, i) => [p[0] - ch.points[i][0], p[1] - ch.points[i][1]]);
      return { x: d.x, y: d.y, models: st.project.devices.map((x) => x.modelId), chColor: ch.color, chLabel: ch.label, dims: st.project.dimensions.length, chPoints: ch.points, chStraight: segs.every(([dx, dy]) => dx === 0 || dy === 0) };
    });
    check('импорт: координаты устройств ограничены стеной', imported.x <= 5900 && imported.y >= 0, JSON.stringify(imported));
    check('импорт: устройства убранных моделей не загружаются', imported.models.length === 1 && imported.models[0] === 'sp2', JSON.stringify(imported.models));
    check('импорт: размерные линии и цвет короба нормализуются', imported.dims === 1 && imported.chColor === '' && imported.chLabel === undefined, JSON.stringify(imported));
    check('импорт: диагональные трассы выпрямляются в горизонтальные/вертикальные', imported.chStraight && imported.chPoints.length >= 2, JSON.stringify({ points: imported.chPoints }));

    const tagState = await page.evaluate(() => {
      const st = window.BolidGrid.store;
      st.replaceProject({
        walls: [{ id: 'a', name: 'A', width: 6000, height: 2700 }, { id: 'b', name: 'B', width: 6000, height: 2700 }],
        devices: [{ id: 'd1', modelId: 'sp2', wallId: 'b', x: 100, y: 100, tag: '2.1' }],
        channels: [],
      });
      st.activeWallId = 'b';
      st.removeWall('a');
      st.activeWallId = st.project.walls[0].id;
      return { walls: st.project.walls.length, tag: st.nextTag(st.project.walls[0].id) };
    });
    check('после удаления первой стены нумерация продолжается (2.2)', tagState.tag === '2.2', JSON.stringify(tagState));

    // --- точные зазоры и проверка пересечений ---
    await page.evaluate(() => {
      const st = window.BolidGrid.store;
      st.replaceProject({
        walls: [{ id: 'review-wall', name: 'Проверка', width: 4000, height: 2700 }],
        devices: [
          { id: 'r1', modelId: 'sp2', wallId: 'review-wall', x: 500, y: 1000, tag: '1.1' },
          { id: 'r2', modelId: 'sp2', wallId: 'review-wall', x: 900, y: 1000, tag: '1.2' },
          { id: 'r3', modelId: 'sp2', wallId: 'review-wall', x: 500, y: 1500, tag: '1.3' },
        ],
        channels: [{ id: 'rc1', wallId: 'review-wall', kind: 'кабель-канал', width: 100, points: [[2000, 0], [2000, 2000]] }],
        dimensions: [],
      });
      st.select([{ type: 'device', id: 'r1' }, { type: 'device', id: 'r2' }]);
    });
    await sleep(150);
    await page.locator('#tabs button[data-tab="props"]').click();
    check('контрольная сцена изначально не содержит пересечений', await page.evaluate(() => window.BolidGrid.store.findPlacementIssues().length === 0));
    check('для группы доступен ввод точного зазора', await page.locator('[data-gap-value]').count() === 1);
    await page.fill('[data-gap-value]', '75');
    await page.selectOption('[data-gap-direction]', 'x');
    await page.click('[data-act="apply-gap"]');
    const exactGap = await page.evaluate(() => {
      const st = window.BolidGrid.store;
      return { x1: st.getDevice('r1').x, x2: st.getDevice('r2').x, gap: st.getDevice('r2').x - st.getDevice('r1').x - 102 };
    });
    check('точный зазор по X сохраняет первый прибор и раздвигает остальные', exactGap.x1 === 500 && exactGap.gap === 75, JSON.stringify(exactGap));
    const verticalGap = await page.evaluate(() => {
      const st = window.BolidGrid.store;
      const ok = st.setDeviceGap('y', 80);
      return { ok, y1: st.getDevice('r1').y, y2: st.getDevice('r2').y };
    });
    check('точный зазор по Y учитывает высоту прибора', verticalGap.ok && verticalGap.y1 === 1000 && verticalGap.y2 === 1187, JSON.stringify(verticalGap));
    const gapWithoutSpace = await page.evaluate(() => {
      const st = window.BolidGrid.store;
      const before = st.getDevice('r2').x;
      const ok = st.setDeviceGap('x', 10000);
      return { ok, unchanged: st.getDevice('r2').x === before };
    });
    check('слишком большой зазор не выполняется частично', !gapWithoutSpace.ok && gapWithoutSpace.unchanged, JSON.stringify(gapWithoutSpace));
    await page.evaluate(() => {
      const st = window.BolidGrid.store;
      st.act('контрольное пересечение', () => {
        st.getDevice('r2').x = st.getDevice('r1').x;
        st.getDevice('r2').y = st.getDevice('r1').y;
      });
    });
    await sleep(120);
    const overlap = await page.evaluate(() => ({
      issues: window.BolidGrid.store.findPlacementIssues().map((i) => i.type),
      status: document.querySelector('#st-check').textContent,
      marked: document.querySelectorAll('.dev.issue').length,
    }));
    check('пересечение двух приборов обнаруживается', overlap.issues.includes('device-device'), JSON.stringify(overlap));
    check('статус и рамки на листе показывают пересечение', /Пересечения:/.test(overlap.status) && overlap.marked === 2, JSON.stringify(overlap));
    await page.click('#st-check');
    check('диалог проверки содержит переходы к местам пересечений', await page.locator('[data-review-index]').count() >= 1);
    await page.locator('[data-review-index]').first().click();
    check('выбор замечания закрывает диалог и выделяет прибор', await page.evaluate(() => document.querySelector('#modal').hidden && window.BolidGrid.store.isSelected('device', 'r1')));
    await page.evaluate(() => {
      const st = window.BolidGrid.store;
      st.updateChannel('rc1', { points: [[0, 1550], [1000, 1550]] });
      st.clearSelection();
    });
    check('пересечение прибора с полосой короба обнаруживается', await page.evaluate(() => window.BolidGrid.store.findPlacementIssues().some((i) => i.type === 'device-channel' && i.channelId === 'rc1')));
    await page.click('#st-check');
    await page.keyboard.press('Escape');
    check('диалог проверки закрывается клавишей Esc', await page.locator('#modal').evaluate((node) => node.hidden));
    const reviewNotExported = await page.evaluate(async () => {
      const source = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return doc.querySelectorAll('.issue-frame').length === 0;
    });
    check('служебные рамки пересечений не попадают в экспорт SVG', reviewNotExported);

    check('нет ошибок JavaScript на странице', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    check('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    console.log(`\n${results.length - failures}/${results.length} проверок пройдено`);
    if (failures) {
      console.error(`\nПРОВАЛЕНО: ${failures}`);
      process.exitCode = 1;
    } else {
      console.log('Все проверки пройдены ✔');
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Смоук-тест упал:', err);
  process.exitCode = 1;
});
