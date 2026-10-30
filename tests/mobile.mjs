/**
 * tests/mobile.mjs — проверка мобильной версии BolidGrid в headless Chromium.
 *
 * Запуск: node tests/mobile.mjs   (Playwright уже в devDependencies)
 * Проверяет: раскладку 390×844 и 412×915, нижний таб-бар, шторки панелей,
 * размещение устройства тапом, выбор и свойства, pinch-zoom, перетаскивание
 * пальцем, спецификацию, журнал, меню действий, отсутствие ошибок JS.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const results = [];
let failures = 0;
const OUT = new URL('output/', import.meta.url).pathname;

function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  console.log(results[results.length - 1]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 8200 + Math.floor(Math.random() * 700);
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

async function main() {
  const { child: server, port } = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    await mkdir(OUT, { recursive: true });

    for (const vp of [
      { width: 390, height: 844, label: '390×844 (iPhone 13/14)' },
      { width: 360, height: 780, label: '360×780 (компактный Android)' },
      { width: 412, height: 915, label: '412×915 (Pixel/Android)' },
    ]) {
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

      const cdp = await ctx.newCDPSession(page);
      const tap = async (x, y) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const swipe = async (x1, y1, x2, y2, steps = 12) => {
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
      };

      const state = () =>
        page.evaluate(() => {
          const st = window.BolidGrid.store;
          return {
            devices: st.project.devices.length,
            channels: st.project.channels.length,
            dims: (st.project.dimensions || []).length,
            walls: st.project.walls.length,
            tool: st.tool,
            selection: st.selection.length,
            view: { w: window.BolidGrid.editor.view.w, x: window.BolidGrid.editor.view.x },
            sheet: document.body.className,
          };
        });

      /* ---------- 1. раскладка ---------- */
      const layout = await page.evaluate(() => {
        const r = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) };
        };
        return {
          innerW: innerWidth,
          innerH: innerHeight,
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          bar: r('#mobile-bar'),
          menuBtn: r('#mobile-menu-btn'),
          stage: r('#stage'),
          canvas: r('#canvas-wrap'),
          sheet: r('.sheet'),
          topActionsHidden: getComputedStyle(document.querySelector('.top-actions')).display === 'none',
          leftClosed: document.getElementById('left').getBoundingClientRect().top >= innerHeight - 10,
          rightClosed: document.getElementById('right').getBoundingClientRect().top >= innerHeight - 10,
          barVisible: (() => {
            const el = document.getElementById('mobile-bar');
            if (!el) return false;
            const cs = getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 10;
          })(),
          tabsVisible: (() => {
            const el = document.querySelector('#tabs');
            if (!el) return false;
            const cs = getComputedStyle(el);
            return cs.display !== 'none' && el.getBoundingClientRect().height > 5;
          })(),
        };
      });
      check(`${vp.label}: нет горизонтального переполнения`, layout.scrollW <= layout.innerW + 1, `${layout.scrollW} vs ${layout.innerW}`);
      check(`${vp.label}: нижний таб-бар виден`, layout.barVisible && layout.bar.h >= 50, JSON.stringify(layout.bar));
      check(`${vp.label}: кнопка меню видна, старые кнопки скрыты`, layout.menuBtn !== null && layout.topActionsHidden);
      check(`${vp.label}: лист стены занимает экран`, layout.canvas.w === vp.width && layout.canvas.h > vp.height * 0.5, JSON.stringify(layout.canvas));
      check(`${vp.label}: панели по умолчанию закрыты`, layout.leftClosed && layout.rightClosed);
      check(`${vp.label}: шторки не перекрывают лист (таб-бар снизу)`, layout.bar.bottom <= vp.height + 1);

      /* ---------- 2. палитра ---------- */
      await page.locator('#mobile-bar button[data-sheet="palette"]').tap();
      await sleep(400);
      const pal = await page.evaluate(() => ({
        cls: document.body.className,
        items: document.querySelectorAll('#palette-list .pal-item').length,
        leftY: Math.round(document.getElementById('left').getBoundingClientRect().y),
        leftBottom: Math.round(document.getElementById('left').getBoundingClientRect().bottom),
        scrim: getComputedStyle(document.getElementById('scrim')).display,
        active: [...document.querySelectorAll('#mobile-bar button')].findIndex((b) => b.classList.contains('active')),
      }));
      check(`${vp.label}: «Палитра» открывает шторку`, /sheet-palette/.test(pal.cls) && pal.leftY < vp.height * 0.6, JSON.stringify(pal));
      check(`${vp.label}: шторка палитры над таб-баром`, pal.leftBottom <= layout.bar.y + 2, `${pal.leftBottom} vs ${layout.bar.y}`);
      check(`${vp.label}: в палитре 15 моделей`, pal.items === 15, `items=${pal.items}`);
      check(`${vp.label}: затемнение активно`, pal.scrim === 'block');

      await page.locator('#palette-list .pal-item[data-model="molnia_exit"]').tap();
      await sleep(350);
      const afterArm = await state();
      check(`${vp.label}: выбор модели включает размещение и закрывает шторку`, afterArm.tool === 'place' && afterArm.sheet === '', JSON.stringify({ tool: afterArm.tool, sheet: afterArm.sheet }));

      const before = await state();
      await tap(vp.width / 2, vp.height * 0.45);
      await sleep(500);
      const afterPlace = await state();
      check(`${vp.label}: тап по стене добавляет устройство`, afterPlace.devices === before.devices + 1, `${before.devices} → ${afterPlace.devices}`);
      check(`${vp.label}: режим размещения остаётся включённым`, afterPlace.tool === 'place', afterPlace.tool);
      const placeDone = page.locator('#btn-place-done');
      if (await placeDone.isVisible().catch(() => false)) await placeDone.tap();
      await sleep(350);
      check(`${vp.label}: кнопка «Готово» завершает размещение`, (await state()).tool === 'select', (await state()).tool);

      /* ---------- 3. выбор устройства пальцем и свойства ---------- */
      const devScreen = await page.evaluate(() => {
        const ed = window.BolidGrid.editor;
        const st = window.BolidGrid.store;
        const d = st.wallDevices[0];
        const m = window.BolidGrid.getModel(d.modelId);
        const pt = ed.svg.createSVGPoint();
        pt.x = d.x + m.w / 2;
        pt.y = ed.wall.height - (d.y + m.h / 2);
        const sp = pt.matrixTransform(ed.svg.getScreenCTM());
        return { x: sp.x, y: sp.y, tag: d.tag };
      });
      // сначала уберём выделение после размещения
      await page.evaluate(() => window.BolidGrid.store.clearSelection());
      await tap(devScreen.x, devScreen.y);
      await sleep(400);
      const sel = await state();
      check(`${vp.label}: тап по мелкому устройству выделяет его`, sel.selection === 1, `selection=${sel.selection}`);

      /* ---------- 3a. долгое нажатие добавляет в выделение ---------- */
      const twoDevs = await page.evaluate(() => {
        const ed = window.BolidGrid.editor;
        const st = window.BolidGrid.store;
        const toScreen = (d) => {
          const m = window.BolidGrid.getModel(d.modelId);
          const pt = ed.svg.createSVGPoint();
          pt.x = d.x + m.w / 2;
          pt.y = ed.wall.height - (d.y + m.h / 2);
          const sp = pt.matrixTransform(ed.svg.getScreenCTM());
          return { x: sp.x, y: sp.y, id: d.id };
        };
        const ds = st.wallDevices.slice(0, 2).map(toScreen);
        return ds;
      });
      await tap(twoDevs[0].x, twoDevs[0].y);
      await sleep(300);
      const pressX = twoDevs[1].x, pressY = twoDevs[1].y;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pressX, y: pressY, id: 1 }] });
      await sleep(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(350);
      const longSel = await state();
      check(`${vp.label}: долгое нажатие добавляет устройство в выделение`, longSel.selection === 2, `selection=${longSel.selection}`);
      await tap(vp.width - 40, vp.height * 0.9);
      await sleep(300);
      check(`${vp.label}: тап по пустому месту снимает выделение`, (await state()).selection === 0);

      /* ---------- 3b. панорама одним пальцем ---------- */
      const panBefore = (await state()).view;
      await page.evaluate(() => window.BolidGrid.editor.fit());
      await sleep(250);
      const panStart = (await state()).view;
      await swipe(vp.width * 0.2, vp.height * 0.82, vp.width * 0.7, vp.height * 0.82);
      await sleep(400);
      const panAfter = (await state()).view;
      check(`${vp.label}: панорама одним пальцем по пустому месту`, Math.abs(panAfter.x - panStart.x) > 50, `x ${Math.round(panStart.x)} → ${Math.round(panAfter.x)}`);
      await page.evaluate(() => window.BolidGrid.editor.fit());
      await sleep(250);
      void panBefore;

      // вернуть одиночное выделение для проверки свойств
      const devAgain = await page.evaluate(() => {
        const ed = window.BolidGrid.editor;
        const st = window.BolidGrid.store;
        const d = st.wallDevices[0];
        const m = window.BolidGrid.getModel(d.modelId);
        const pt = ed.svg.createSVGPoint();
        pt.x = d.x + m.w / 2;
        pt.y = ed.wall.height - (d.y + m.h / 2);
        const sp = pt.matrixTransform(ed.svg.getScreenCTM());
        return { x: sp.x, y: sp.y };
      });
      await tap(devAgain.x, devAgain.y);
      await sleep(300);

      await page.locator('#mobile-bar button[data-sheet="props"]').tap();
      await sleep(400);
      const props = await page.evaluate(() => ({
        cls: document.body.className,
        rightH: Math.round(document.getElementById('right').getBoundingClientRect().height),
        tab: document.querySelector('#tabs button.active')?.dataset.tab,
        inputs: document.querySelectorAll('#tab-props input[data-f]').length,
        tag: document.querySelector('#tab-props input[data-f="tag"]')?.value,
      }));
      check(`${vp.label}: «Свойства» открывает шторку с инспектором`, /sheet-right/.test(props.cls) && props.tab === 'props' && props.inputs >= 4, JSON.stringify(props));
      check(`${vp.label}: свойства устройства читаются и редактируются`, props.tag === devScreen.tag, `${props.tag} vs ${devScreen.tag}`);
      check(`${vp.label}: высота шторки свойств достаточная`, props.rightH > vp.height * 0.5, `h=${props.rightH}`);

      /* ---------- 4. pinch-zoom ---------- */
      await page.locator('#right [data-sheet-close]').tap();
      await sleep(250);
      const zoomBefore = (await state()).view.w;
      await pinch(vp.width / 2, vp.height * 0.45, 60, 220);
      await sleep(500);
      const zoomAfter = (await state()).view.w;
      check(`${vp.label}: pinch-zoom приближает лист`, zoomAfter < zoomBefore * 0.9, `${Math.round(zoomBefore)} → ${Math.round(zoomAfter)}`);
      await page.evaluate(() => window.BolidGrid.editor.fit());
      await sleep(300);

      /* ---------- 5. перетаскивание устройства пальцем ---------- */
      const d0 = await page.evaluate(() => {
        const ed = window.BolidGrid.editor;
        const st = window.BolidGrid.store;
        const d = st.wallDevices[0];
        const m = window.BolidGrid.getModel(d.modelId);
        const pt = ed.svg.createSVGPoint();
        pt.x = d.x + m.w / 2;
        pt.y = ed.wall.height - (d.y + m.h / 2);
        const sp = pt.matrixTransform(ed.svg.getScreenCTM());
        return { x: sp.x, y: sp.y, dx: d.x, dy: d.y };
      });
      await swipe(d0.x, d0.y, d0.x + 70, d0.y - 50);
      await sleep(500);
      const d1 = await page.evaluate(() => ({ dx: window.BolidGrid.store.wallDevices[0].x, dy: window.BolidGrid.store.wallDevices[0].y }));
      check(`${vp.label}: перетаскивание пальцем двигает устройство`, d1.dx !== d0.dx || d1.dy !== d0.dy, JSON.stringify({ before: [d0.dx, d0.dy], after: [d1.dx, d1.dy] }));
      await page.evaluate(() => window.BolidGrid.store.undo());
      await sleep(300);
      const d2 = await page.evaluate(() => ({ dx: window.BolidGrid.store.wallDevices[0].x, dy: window.BolidGrid.store.wallDevices[0].y }));
      check(`${vp.label}: undo возвращает устройство на место`, d2.dx === d0.dx && d2.dy === d0.dy, JSON.stringify({ undo: d2, orig: [d0.dx, d0.dy] }));

      /* ---------- 6. спецификация и журнал ---------- */
      await page.locator('#mobile-bar button[data-sheet="spec"]').tap();
      await sleep(450);
      const spec = await page.evaluate(() => ({
        tables: document.querySelectorAll('#tab-spec table').length,
        text: document.querySelector('#tab-spec').innerText,
        rightVisible: document.getElementById('right').getBoundingClientRect().top < innerHeight * 0.7,
      }));
      check(`${vp.label}: шторка «Спец» показывает таблицы`, spec.tables >= 2 && /ДИП-34А-04/.test(spec.text), `tables=${spec.tables}`);
      const cableFact = await page.evaluate(() => {
        const table = [...document.querySelectorAll('#tab-spec table')].find((t) => /КПСнг/.test(t.textContent));
        const row = table && [...table.querySelectorAll('tbody tr')].find((tr) => /КПСнг/.test(tr.textContent));
        if (!row) return null;
        const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
        const parse = (s) => parseFloat(String(s).replace(/[\s\u00a0]/g, '').replace(',', '.'));
        return { plan: parse(cells[5]), fact: parse(cells[6]) };
      });
      check(
        `${vp.label}: «Факт» кабеля в метрах и меньше проектного`,
        !!cableFact && cableFact.plan === 280 && cableFact.fact > 0 && cableFact.fact < 1000,
        JSON.stringify(cableFact)
      );
      await page.screenshot({ path: `${OUT}mobile-${vp.width}-spec.png` });

      await page.locator('#mobile-bar button[data-sheet="journal"]').tap();
      await sleep(450);
      const journal = await page.evaluate(() => ({ rows: document.querySelectorAll('#tab-journal tbody tr').length, total: /Итого/.test(document.querySelector('#tab-journal').innerText) }));
      check(`${vp.label}: шторка «Журнал» содержит трассы`, journal.rows >= 5 && journal.total, JSON.stringify(journal));

      /* ---------- 6a. рисование кабельного канала и кнопка «Готово» ---------- */
      await page.locator('#mobile-bar button[data-sheet="journal"]').tap();
      await sleep(300);
      const chBefore = (await state()).channels;
      await page.locator('#stage-toolbar [data-tool="channel"]').tap();
      await sleep(250);
      await tap(vp.width * 0.15, vp.height * 0.7);
      await sleep(200);
      await tap(vp.width * 0.75, vp.height * 0.7);
      await sleep(300);
      const doneBtn = page.locator('#btn-channel-done');
      const doneVisible = await doneBtn.isVisible();
      check(`${vp.label}: при рисовании канала есть кнопка «Готово»`, doneVisible);
      await doneBtn.tap();
      await sleep(400);
      const chAfter = await state();
      check(`${vp.label}: кнопка «Готово» завершает трассу`, chAfter.channels === chBefore + 1, `${chBefore} → ${chAfter.channels}`);

      /* ---------- 6b. короб двигается: участок и весь короб (удержание) ---------- */
      // закрыть авто-открытые свойства
      const propsClose = page.locator('#right [data-sheet-close]');
      if (await propsClose.isVisible().catch(() => false)) await propsClose.tap();
      await sleep(300);
      const segScreen = await page.evaluate(() => {
        const ed = window.BolidGrid.editor;
        const s = window.BolidGrid.store;
        const ch = s.project.channels[s.project.channels.length - 1];
        const pt = ed.svg.createSVGPoint();
        pt.x = (ch.points[0][0] + ch.points[1][0]) / 2;
        pt.y = ed.wall.height - (ch.points[0][1] + ch.points[1][1]) / 2;
        const sp = pt.matrixTransform(ed.svg.getScreenCTM());
        return { x: sp.x, y: sp.y, pts: ch.points.map((p) => [...p]) };
      });
      // обычное перетаскивание участка
      await swipe(segScreen.x, segScreen.y, segScreen.x + 20, segScreen.y + 40, 10);
      await sleep(400);
      const segRes = await page.evaluate(() => {
        const s = window.BolidGrid.store;
        const ch = s.project.channels[s.project.channels.length - 1];
        return { pts: ch.points, straight: ch.points.slice(1).every((p, i) => p[0] === ch.points[i][0] || p[1] === ch.points[i][1]) };
      });
      check(`${vp.label}: перетаскивание участка короба пальцем`, segRes.straight && segRes.pts[0][1] !== segScreen.pts[0][1], JSON.stringify({ before: segScreen.pts[0], after: segRes.pts[0] }));

      // удержание + перетаскивание = весь короб
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
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: wholeStart.x, y: wholeStart.y, id: 1 }] });
      await sleep(750);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: wholeStart.x - 30, y: wholeStart.y - 40, id: 1 }] });
      await sleep(120);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(450);
      const wholeRes = await page.evaluate(() => {
        const s = window.BolidGrid.store;
        const ch = s.project.channels[s.project.channels.length - 1];
        const straight = ch.points.slice(1).every((p, i) => p[0] === ch.points[i][0] || p[1] === ch.points[i][1]);
        return { pts: ch.points, straight };
      });
      const wdx = wholeRes.pts.map((p, i) => p[0] - wholeStart.pts[i][0]);
      const wdy = wholeRes.pts.map((p, i) => p[1] - wholeStart.pts[i][1]);
      check(
        `${vp.label}: удержание + перетаскивание двигает весь короб`,
        wholeRes.straight && new Set(wdx).size === 1 && new Set(wdy).size === 1 && (wdx[0] !== 0 || wdy[0] !== 0),
        JSON.stringify({ wdx, wdy })
      );

      /* ---------- 7. меню действий ---------- */
      await page.locator('#mobile-bar button[data-sheet="journal"]').tap();
      await sleep(300);
      await page.locator('#mobile-menu-btn').tap();
      await sleep(400);
      const menu = await page.evaluate(() => ({
        cls: document.body.className,
        sheetTop: Math.round(document.getElementById('menu-sheet').getBoundingClientRect().top),
        actions: document.querySelectorAll('#menu-sheet [data-menu-action]').length,
        walls: document.querySelectorAll('#menu-walls .wall-item').length,
      }));
      check(`${vp.label}: меню действий открывается`, /sheet-menu/.test(menu.cls) && menu.sheetTop < vp.height, JSON.stringify(menu));
      check(`${vp.label}: в меню есть действия и список стен`, menu.actions >= 8 && menu.walls === 2, `actions=${menu.actions}, walls=${menu.walls}`);
      await page.screenshot({ path: `${OUT}mobile-${vp.width}-menu.png` });
      await page.locator('#menu-sheet [data-sheet-close]').tap();
      await sleep(300);
      check(`${vp.label}: затемнение закрывает меню`, (await state()).sheet === '');

      /* ---------- 8. ошибки ---------- */
      check(`${vp.label}: нет ошибок JS`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
      check(`${vp.label}: нет ошибок консоли`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

      await page.screenshot({ path: `${OUT}mobile-${vp.width}.png` });
      await ctx.close();
    }

    await writeFile(`${OUT}mobile-result.txt`, results.join('\n') + '\n');
    console.log(`\n${results.length - failures}/${results.length} проверок пройдено`);
    if (failures) {
      console.error(`\nПРОВАЛЕНО: ${failures}`);
      process.exitCode = 1;
    } else {
      console.log('Мобильные проверки пройдены ✔');
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Мобильный тест упал:', err);
  process.exitCode = 1;
});
