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
