/**
 * tests/a11y.mjs — доступность и клавиатура BolidGrid.
 *
 * Проверяет доступные имена кнопок, связки tab/tablist/tabpanel, живые регионы,
 * ловушку фокуса и Escape в диалогах и шторках, возврат фокуса, шорткаты,
 * inert для закрытых шторок и отсутствие ошибок JS.
 *
 * Запуск: node tests/a11y.mjs   (нужен Playwright Chromium)
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = new URL('output/', import.meta.url).pathname;
const results = [];
let failures = 0;

function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  console.log(results[results.length - 1]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 8300 + Math.floor(Math.random() * 600);
    const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    child.stdout.on('data', (data) => {
      if (String(data).includes('http://localhost')) started = true;
    });
    for (let i = 0; i < 40 && !started; i++) await sleep(200);
    if (started) return { child, port };
    child.kill('SIGKILL');
  }
  throw new Error('не удалось запустить тестовый сервер');
}

const VISIBLE = `(el) => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}`;

async function waitReady(page, timeout = 20000) {
  await page.goto(page.__BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.BolidGrid?.store?.project?.devices?.length > 0, null, { timeout });
  await sleep(450);
}

async function desktopChecks(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.__BASE_URL = baseUrl;
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await waitReady(page);
  await mkdir(OUT, { recursive: true });

  /* ---------- доступные имена ---------- */
  const unnamed = await page.evaluate((visibleSrc) => {
    const visible = eval(visibleSrc);
    return [...document.querySelectorAll('button')]
      .filter(visible)
      .filter((button) => !(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim()))
      .map((button) => button.outerHTML.slice(0, 140));
  }, VISIBLE);
  check('у всех видимых кнопок есть доступное имя', unnamed.length === 0, unnamed.join(' | '));

  const iconNames = await page.evaluate((visibleSrc) => {
    const visible = eval(visibleSrc);
    const selector = '.btn.icon, #st-help, #mobile-menu-btn, #desktop-menu-btn, .search-clear';
    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((button) => button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim());
  }, VISIBLE);
  check('кнопки-иконки имеют aria-label', iconNames.length > 0 && iconNames.every(Boolean), JSON.stringify(iconNames));

  /* ---------- живые регионы и описание листа ---------- */
  const regions = await page.evaluate(() => {
    const attr = (id) => {
      const node = document.getElementById(id);
      return node ? { role: node.getAttribute('role'), live: node.getAttribute('aria-live'), atomic: node.getAttribute('aria-atomic') } : null;
    };
    const wall = document.getElementById('wall');
    return {
      save: attr('save-status'),
      toast: attr('toast'),
      sr: attr('sr-status'),
      wall: {
        role: wall.getAttribute('role'),
        label: wall.getAttribute('aria-label'),
        describedby: wall.getAttribute('aria-describedby'),
        target: document.getElementById(wall.getAttribute('aria-describedby')) !== null,
      },
    };
  });
  check('статус сохранения — вежливый live-регион', regions.save?.role === 'status' && regions.save?.live === 'polite', JSON.stringify(regions.save));
  check('тост — live-регион', regions.toast?.role === 'status' && regions.toast?.live === 'polite', JSON.stringify(regions.toast));
  check('есть отдельный регион объявлений выбора', regions.sr?.role === 'status' && regions.sr?.live === 'polite' && regions.sr?.atomic === 'true', JSON.stringify(regions.sr));
  check('интерактивный SVG-лист имеет роль и описание', regions.wall.role === 'application' && /Монтажный план/i.test(regions.wall.label || '') && regions.wall.describedby && regions.wall.target, JSON.stringify(regions.wall));

  /* ---------- tab / tablist / tabpanel ---------- */
  const tabs = await page.evaluate(() => {
    const list = document.getElementById('tabs');
    const buttons = [...list.querySelectorAll('[role="tab"]')];
    return {
      listRole: list.getAttribute('role'),
      buttons: buttons.map((button) => ({
        tab: button.dataset.tab,
        selected: button.getAttribute('aria-selected'),
        controls: button.getAttribute('aria-controls'),
        tabindex: button.getAttribute('tabindex'),
        panel: (() => {
          const panel = document.getElementById(button.getAttribute('aria-controls'));
          return panel ? { role: panel.getAttribute('role'), labelledby: panel.getAttribute('aria-labelledby'), active: panel.classList.contains('active') } : null;
        })(),
      })),
    };
  });
  const selectedTabs = tabs.buttons.filter((button) => button.selected === 'true');
  check('панели свойств — связанный tablist', tabs.listRole === 'tablist' && tabs.buttons.length === 3, JSON.stringify(tabs));
  check('выбрана ровно одна вкладка, остальные вне Tab-порядка', selectedTabs.length === 1 && tabs.buttons.every((button) => (button.selected === 'true') === (button.tabindex === '0')), JSON.stringify(tabs.buttons));
  check('у каждой вкладки есть aria-controls и tabpanel', tabs.buttons.every((button) => button.controls && button.panel?.role === 'tabpanel' && button.panel?.labelledby), JSON.stringify(tabs.buttons));

  await page.locator('#tabs [data-tab="props"]').focus();
  await page.keyboard.press('ArrowRight');
  await sleep(120);
  const afterArrow = await page.evaluate(() => ({
    active: window.BolidGrid.panels.activeTab,
    focused: document.activeElement?.dataset?.tab,
    selected: [...document.querySelectorAll('#tabs [role="tab"]')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.tab),
  }));
  check('стрелка вправо переключает и фокусирует вкладку', afterArrow.active === 'spec' && afterArrow.focused === 'spec' && afterArrow.selected.join() === 'spec', JSON.stringify(afterArrow));
  await page.keyboard.press('ArrowLeft');
  await sleep(100);

  /* ---------- инструменты: aria-pressed ---------- */
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('c');
  await sleep(120);
  const channelTool = await page.evaluate(() => ({
    tool: window.BolidGrid.store.tool,
    pressed: [...document.querySelectorAll('#stage-toolbar [data-tool]')].map((b) => [b.dataset.tool, b.getAttribute('aria-pressed')]),
  }));
  check('C включает «Короб» и aria-pressed следует за инструментом', channelTool.tool === 'channel' && channelTool.pressed.filter(([, value]) => value === 'true').length === 1 && channelTool.pressed.some(([tool, value]) => tool === 'channel' && value === 'true'), JSON.stringify(channelTool));
  await page.keyboard.press('v');
  await sleep(100);

  /* ---------- шорткаты V/C/L/M/H/F ---------- */
  const shortcutState = [];
  await page.evaluate(() => document.activeElement?.blur?.());
  for (const [key, expected] of [['c', 'channel'], ['l', 'cable'], ['m', 'dimension'], ['h', 'pan'], ['v', 'select']]) {
    await page.keyboard.press(key);
    await sleep(70);
    shortcutState.push({ key, expected, actual: await page.evaluate(() => window.BolidGrid.store.tool) });
  }
  check('шорткаты V/C/L/M/H/F переключают инструменты', shortcutState.every((item) => item.actual === item.expected), JSON.stringify(shortcutState));

  await page.evaluate(() => {
    window.BolidGrid.editor.fit();
  });
  const fitWidth = await page.evaluate(() => window.BolidGrid.editor.view.w);
  await page.evaluate(() => window.BolidGrid.editor.zoomBy(2));
  await page.keyboard.press('f');
  await sleep(120);
  const afterFit = await page.evaluate(() => window.BolidGrid.editor.view.w);
  check('F возвращает масштаб «вся стена»', Math.abs(afterFit - fitWidth) < 2, `${fitWidth} → ${afterFit}`);

  /* ---------- Ctrl+Z / Ctrl+Y ---------- */
  const deviceId = await page.evaluate(() => {
    const store = window.BolidGrid.store;
    const device = store.wallDevices[0];
    store.selectOne('device', device.id);
    return device.id;
  });
  await sleep(100);
  const x0 = await page.evaluate((id) => window.BolidGrid.store.getDevice(id).x, deviceId);
  await page.keyboard.press('ArrowRight');
  await sleep(150);
  const x1 = await page.evaluate((id) => window.BolidGrid.store.getDevice(id).x, deviceId);
  await page.keyboard.press('Control+z');
  await sleep(200);
  const x2 = await page.evaluate((id) => window.BolidGrid.store.getDevice(id).x, deviceId);
  await page.keyboard.press('Control+y');
  await sleep(200);
  const x3 = await page.evaluate((id) => window.BolidGrid.store.getDevice(id).x, deviceId);
  check('Ctrl+Z и Ctrl+Y отменяют и повторяют сдвиг', x1 === x0 + 10 && x2 === x0 && x3 === x1, JSON.stringify({ x0, x1, x2, x3 }));

  /* ---------- стрелки и Shift+стрелки ---------- */
  await page.evaluate((id) => window.BolidGrid.store.selectOne('device', id), deviceId);
  const beforeNudge = await page.evaluate((id) => ({ x: window.BolidGrid.store.getDevice(id).x, y: window.BolidGrid.store.getDevice(id).y }), deviceId);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  await sleep(150);
  const afterNudge = await page.evaluate((id) => ({ x: window.BolidGrid.store.getDevice(id).x, y: window.BolidGrid.store.getDevice(id).y }), deviceId);
  check('стрелки двигают на 10 мм, Shift+стрелки — на 1 мм', afterNudge.x === beforeNudge.x + 10 && afterNudge.y === beforeNudge.y + 1, JSON.stringify({ beforeNudge, afterNudge }));

  /* ---------- Delete / Backspace ---------- */
  const beforeDelete = await page.evaluate(() => window.BolidGrid.store.wallDevices.length);
  await page.evaluate((id) => window.BolidGrid.store.selectOne('device', id), deviceId);
  await page.keyboard.press('Delete');
  await sleep(200);
  const afterDelete = await page.evaluate(() => window.BolidGrid.store.wallDevices.length);
  await page.keyboard.press('Control+z');
  await sleep(200);
  const restored = await page.evaluate(() => window.BolidGrid.store.wallDevices.length);
  check('Delete удаляет выбранное, Ctrl+Z возвращает', afterDelete === beforeDelete - 1 && restored === beforeDelete, `${beforeDelete} → ${afterDelete} → ${restored}`);

  /* ---------- Ctrl+S ---------- */
  let downloadName = '';
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 7000 }),
      page.keyboard.press('Control+s'),
    ]);
    downloadName = download.suggestedFilename();
  } catch {
    downloadName = '';
  }
  check('Ctrl+S выгружает резервную копию JSON', /\.json$/i.test(downloadName), downloadName);

  /* ---------- ввод в поле не перехватывается ---------- */
  await page.locator('#palette-search').focus();
  const toolBeforeTyping = await page.evaluate(() => window.BolidGrid.store.tool);
  await page.locator('#palette-search').fill('c');
  await sleep(100);
  const toolAfterTyping = await page.evaluate(() => window.BolidGrid.store.tool);
  await page.locator('#palette-search').fill('');
  await page.locator('#palette-search').press('Escape');
  await page.evaluate(() => document.activeElement?.blur?.());
  check('набор в поиске не переключает инструмент', toolBeforeTyping === toolAfterTyping, `${toolBeforeTyping} → ${toolAfterTyping}`);

  /* ---------- объявления выбора ---------- */
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  await sleep(120);
  const clearedText = await page.locator('#sr-status').textContent();
  await page.evaluate(() => {
    const store = window.BolidGrid.store;
    store.selectOne('device', store.wallDevices[0].id);
  });
  await sleep(150);
  const selectedText = await page.locator('#sr-status').textContent();
  check('смена выбора объявляется скринридеру', /Выделение снято/.test(clearedText) && /Выбран прибор/.test(selectedText), JSON.stringify({ clearedText, selectedText }));

  /* ---------- скрытые элементы ---------- */
  const hiddenState = await page.evaluate(() => {
    const dock = document.getElementById('selection-dock');
    const clear = document.getElementById('palette-search-clear');
    const menu = document.getElementById('menu-sheet');
    const undo = document.querySelector('[data-action="undo"]');
    return {
      dockHidden: dock.hidden,
      dockDisplay: getComputedStyle(dock).display,
      clearHidden: clear.hidden,
      clearDisplay: getComputedStyle(clear).display,
      menuInert: menu.hasAttribute('inert'),
      menuAriaHidden: menu.getAttribute('aria-hidden'),
      undoDisabledMatches: undo.disabled === !window.BolidGrid.store.canUndo,
    };
  });
  // выбран прибор из предыдущей проверки — док должен быть виден
  await page.evaluate(() => window.BolidGrid.store.clearSelection());
  await sleep(120);
  const dockAfterClear = await page.evaluate(() => {
    const dock = document.getElementById('selection-dock');
    return { hidden: dock.hidden, display: getComputedStyle(dock).display };
  });
  check('скрытые элементы реально исключены', hiddenState.clearDisplay === 'none' && dockAfterClear.hidden && dockAfterClear.display === 'none', JSON.stringify({ hiddenState, dockAfterClear }));
  check('закрытое меню исключено из фокуса и дерева доступности', hiddenState.menuInert && hiddenState.menuAriaHidden === 'true', JSON.stringify(hiddenState));
  check('disabled отмены/повтора соответствует истории', hiddenState.undoDisabledMatches, JSON.stringify(hiddenState));

  /* ---------- фокус виден ---------- */
  await page.mouse.click(8, 8);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Tab');
  const focusVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      id: el.id,
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  check('клавиатурный фокус имеет видимый контур', focusVisible?.focusVisible && focusVisible.outlineStyle !== 'none' && focusVisible.outlineWidth !== '0px', JSON.stringify(focusVisible));
  await page.screenshot({ path: `${OUT}w4-focus.png` });

  /* ---------- модальное окно: фокус, ловушка, Escape, возврат ---------- */
  await page.locator('#st-help').focus();
  await page.keyboard.press('F1');
  await page.waitForSelector('#modal:not([hidden])');
  await sleep(180);
  const modalOpen = await page.evaluate(() => ({
    title: document.getElementById('modal-title').textContent,
    role: document.querySelector('#modal .modal')?.getAttribute('role'),
    modal: document.querySelector('#modal .modal')?.getAttribute('aria-modal'),
    focusInside: document.querySelector('#modal').contains(document.activeElement),
    focusId: document.activeElement?.id,
  }));
  check('F1 открывает справку и фокус входит в диалог', modalOpen.title === 'Горячие клавиши' && modalOpen.role === 'dialog' && modalOpen.modal === 'true' && modalOpen.focusInside, JSON.stringify(modalOpen));

  await page.keyboard.press('Shift+Tab');
  await sleep(80);
  const trapBack = await page.evaluate(() => ({
    inside: document.getElementById('modal').contains(document.activeElement),
    label: document.activeElement?.textContent?.trim(),
  }));
  check('Shift+Tab с первого элемента уходит на последний внутри диалога', trapBack.inside && /Закрыть/.test(trapBack.label || ''), JSON.stringify(trapBack));

  await page.keyboard.press('Tab');
  await sleep(80);
  const trapForward = await page.evaluate(() => ({
    inside: document.getElementById('modal').contains(document.activeElement),
    id: document.activeElement?.id,
  }));
  check('Tab с последнего элемента возвращается к первому', trapForward.inside && trapForward.id === 'modal-close', JSON.stringify(trapForward));
  await page.screenshot({ path: `${OUT}w4-dialog.png` });

  await page.keyboard.press('Escape');
  await sleep(200);
  const modalClosed = await page.evaluate(() => ({
    hidden: document.getElementById('modal').hidden,
    focusId: document.activeElement?.id,
  }));
  check('Escape закрывает диалог и возвращает фокус инициатору', modalClosed.hidden && modalClosed.focusId === 'st-help', JSON.stringify(modalClosed));

  await page.keyboard.press('?');
  await page.waitForSelector('#modal:not([hidden])');
  await sleep(180);
  await page.mouse.click(6, 6);
  await sleep(200);
  const backdropClosed = await page.evaluate(() => document.getElementById('modal').hidden);
  check('клик по затемнению закрывает диалог', backdropClosed);

  /* ---------- вкладки стен ---------- */
  const secondWallId = await page.evaluate(() => window.BolidGrid.store.addWall({ name: 'Тест доступности', width: 4000, height: 2700 })?.id);
  await sleep(250);
  const wallTabs = await page.evaluate(() => {
    const box = document.getElementById('wall-tabs');
    const tabs = [...box.querySelectorAll('[data-wall-id]')];
    return {
      role: box.getAttribute('role'),
      count: tabs.length,
      selected: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.dataset.wallId),
      controls: tabs.every((tab) => tab.getAttribute('aria-controls') === 'canvas-wrap'),
      panelRole: document.getElementById('canvas-wrap').getAttribute('role'),
      roving: tabs.every((tab) => (tab.getAttribute('aria-selected') === 'true') === (tab.getAttribute('tabindex') === '0')),
    };
  });
  check('вкладки стен связаны с листом и имеют roving tabindex', wallTabs.role === 'tablist' && wallTabs.count === 2 && wallTabs.selected.length === 1 && wallTabs.controls && wallTabs.panelRole === 'tabpanel' && wallTabs.roving, JSON.stringify(wallTabs));

  await page.locator('#wall-tabs [data-wall-id]').first().focus();
  await page.keyboard.press('ArrowRight');
  await sleep(250);
  const wallArrow = await page.evaluate(() => ({
    active: window.BolidGrid.store.wall?.id,
    focused: document.activeElement?.dataset?.wallId,
  }));
  check('стрелка переключает стену и сохраняет фокус на вкладке', wallArrow.active === secondWallId && wallArrow.focused === secondWallId, JSON.stringify({ wallArrow, secondWallId }));

  /* ---------- счётчик размеров — только активная стена ---------- */
  const dimCounts = await page.evaluate((secondId) => {
    const store = window.BolidGrid.store;
    const firstId = store.project.walls.find((wall) => wall.id !== secondId).id;
    store.project.dimensions.push({ id: 'a11y-dim-other', wallId: secondId, a: [100, 100], b: [900, 100], text: '', offset: 60 });
    store.setActiveWall(firstId);
    store.emit('wall');
    return { firstId, secondId };
  }, secondWallId);
  await sleep(250);
  const firstCount = await page.evaluate(() => {
    const store = window.BolidGrid.store;
    return {
      text: document.getElementById('st-counts').textContent,
      expected: store.project.dimensions.filter((dim) => dim.wallId === store.wall.id).length,
    };
  });
  await page.evaluate((id) => {
    const store = window.BolidGrid.store;
    store.setActiveWall(id);
    store.emit('wall');
  }, dimCounts.secondId);
  await sleep(250);
  const secondCount = await page.evaluate(() => {
    const store = window.BolidGrid.store;
    return {
      text: document.getElementById('st-counts').textContent,
      expected: store.project.dimensions.filter((dim) => dim.wallId === store.wall.id).length,
    };
  });
  check(
    'статусбар считает размеры только активной стены',
    firstCount.text.includes(`размеров: ${firstCount.expected}`) && secondCount.text.includes(`размеров: ${secondCount.expected}`) && firstCount.expected !== secondCount.expected,
    JSON.stringify({ firstCount, secondCount })
  );

  await page.evaluate((id) => {
    const store = window.BolidGrid.store;
    store.project.dimensions = store.project.dimensions.filter((dim) => dim.id !== 'a11y-dim-other');
    store.removeWall(id);
  }, secondWallId);
  await sleep(200);

  /* ---------- меню на компьютере: hidden, фокус, Escape ---------- */
  await page.locator('#desktop-menu-btn').click();
  await sleep(350);
  const desktopMenu = await page.evaluate(() => {
    const menu = document.getElementById('menu-sheet');
    return {
      open: !menu.hidden,
      expanded: document.getElementById('desktop-menu-btn').getAttribute('aria-expanded'),
      focusInside: menu.contains(document.activeElement),
    };
  });
  check('меню на компьютере открывается и получает фокус', desktopMenu.open && desktopMenu.expanded === 'true' && desktopMenu.focusInside, JSON.stringify(desktopMenu));
  await page.keyboard.press('Escape');
  await sleep(300);
  const desktopMenuClosed = await page.evaluate(() => ({
    hidden: document.getElementById('menu-sheet').hidden,
    expanded: document.getElementById('desktop-menu-btn').getAttribute('aria-expanded'),
    focusId: document.activeElement?.id,
  }));
  check('Escape закрывает меню и возвращает фокус на «⋯»', desktopMenuClosed.hidden && desktopMenuClosed.expanded === 'false' && desktopMenuClosed.focusId === 'desktop-menu-btn', JSON.stringify(desktopMenuClosed));

  check('нет ошибок JavaScript на странице', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await context.close();
}

async function mobileChecks(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.__BASE_URL = baseUrl;
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await waitReady(page);
  await mkdir(OUT, { recursive: true });

  const initial = await page.evaluate(() => ({
    leftInert: document.getElementById('left').hasAttribute('inert'),
    rightInert: document.getElementById('right').hasAttribute('inert'),
    menuInert: document.getElementById('menu-sheet').hasAttribute('inert'),
    menuAriaHidden: document.getElementById('menu-sheet').getAttribute('aria-hidden'),
    paletteExpanded: document.querySelector('#mobile-bar [data-sheet="palette"]').getAttribute('aria-expanded'),
  }));
  check('на телефоне закрытые шторки inert и не в фокусе', initial.leftInert && initial.rightInert && initial.menuInert && initial.menuAriaHidden === 'true', JSON.stringify(initial));

  let leakedFocus = null;
  for (let i = 0; i < 36 && !leakedFocus; i++) {
    await page.keyboard.press('Tab');
    leakedFocus = await page.evaluate(() => {
      const active = document.activeElement;
      const inside = (id) => document.getElementById(id).contains(active);
      if (!inside('left') && !inside('right') && !inside('menu-sheet')) return null;
      return {
        inLeft: inside('left'),
        inRight: inside('right'),
        inMenu: inside('menu-sheet'),
        element: active?.outerHTML?.slice(0, 120),
      };
    });
  }
  check('Tab не попадает в закрытые шторки на телефоне', !leakedFocus, JSON.stringify(leakedFocus));

  /* ---------- мобильное меню: отмена и повтор с disabled ---------- */
  const deleteState = await page.evaluate(() => {
    const store = window.BolidGrid.store;
    const before = store.project.devices.length;
    store.selectOne('device', store.wallDevices[0].id);
    store.removeSelection();
    return { before, after: store.project.devices.length, canUndo: store.canUndo };
  });
  check('удаление прибора создаёт шаг истории', deleteState.after === deleteState.before - 1 && deleteState.canUndo, JSON.stringify(deleteState));

  await page.locator('#mobile-menu-btn').tap();
  await sleep(450);
  const menuHistory = await page.evaluate(() => ({
    open: document.body.classList.contains('sheet-menu'),
    undoDisabled: document.querySelector('#menu-sheet [data-menu-action="undo"]').disabled,
    redoDisabled: document.querySelector('#menu-sheet [data-menu-action="redo"]').disabled,
    devices: window.BolidGrid.store.project.devices.length,
  }));
  check('в мобильном меню есть активная «Отменить» и неактивная «Повторить»', menuHistory.open && !menuHistory.undoDisabled && menuHistory.redoDisabled, JSON.stringify(menuHistory));

  await page.locator('#menu-sheet [data-menu-action="undo"]').tap();
  await sleep(600);
  const afterUndo = await page.evaluate(() => ({
    devices: window.BolidGrid.store.project.devices.length,
    open: document.body.classList.contains('sheet-menu'),
    focusId: document.activeElement?.id,
  }));
  check('«Отменить» в меню возвращает удалённый прибор', afterUndo.devices === deleteState.before && !afterUndo.open && afterUndo.focusId === 'mobile-menu-btn', JSON.stringify(afterUndo));

  await page.locator('#mobile-menu-btn').tap();
  await sleep(450);
  const redoState = await page.evaluate(() => ({
    undoDisabled: document.querySelector('#menu-sheet [data-menu-action="undo"]').disabled,
    redoDisabled: document.querySelector('#menu-sheet [data-menu-action="redo"]').disabled,
  }));
  check('после отмены «Повторить» становится доступной', !redoState.redoDisabled, JSON.stringify(redoState));
  await page.locator('#menu-sheet [data-menu-action="redo"]').tap();
  await sleep(600);
  const afterRedo = await page.evaluate(() => window.BolidGrid.store.project.devices.length);
  check('«Повторить» в меню повторяет удаление', afterRedo === deleteState.after, `${deleteState.after} → ${afterRedo}`);
  // вернуть исходное состояние для остальных мобильных сценариев
  await page.evaluate(() => window.BolidGrid.store.undo());
  await sleep(250);

  /* ---------- палитра: открытие, начальный фокус, Escape, возврат ---------- */
  await page.locator('#mobile-bar button[data-sheet="palette"]').tap();
  await sleep(450);
  const paletteOpen = await page.evaluate(() => {
    const left = document.getElementById('left');
    return {
      sheet: document.body.classList.contains('sheet-palette'),
      leftInert: left.hasAttribute('inert'),
      rightInert: document.getElementById('right').hasAttribute('inert'),
      expanded: document.querySelector('#mobile-bar [data-sheet="palette"]').getAttribute('aria-expanded'),
      focusInside: left.contains(document.activeElement),
      focusLabel: document.activeElement?.getAttribute('aria-label'),
    };
  });
  check('палитра открывается, снимает inert и получает фокус', paletteOpen.sheet && !paletteOpen.leftInert && paletteOpen.rightInert && paletteOpen.expanded === 'true' && paletteOpen.focusInside, JSON.stringify(paletteOpen));

  await page.evaluate(() => {
    const root = document.getElementById('left');
    const selector = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    const items = [...root.querySelectorAll(selector)].filter((node) => node.getClientRects().length > 0);
    window.__a11yFirst = items[0];
    window.__a11yLast = items[items.length - 1];
    window.__a11yLast.focus();
  });
  await page.keyboard.press('Tab');
  await sleep(80);
  const trapped = await page.evaluate(() => ({
    inside: document.getElementById('left').contains(document.activeElement),
    isFirst: document.activeElement === window.__a11yFirst,
  }));
  check('Tab не выходит из открытой шторки', trapped.inside && trapped.isFirst, JSON.stringify(trapped));
  await page.screenshot({ path: `${OUT}w4-mobile-sheet.png` });

  await page.keyboard.press('Escape');
  await sleep(350);
  const paletteClosed = await page.evaluate(() => ({
    sheet: document.body.classList.contains('sheet-palette'),
    leftInert: document.getElementById('left').hasAttribute('inert'),
    focusSheet: document.activeElement?.dataset?.sheet,
    expanded: document.querySelector('#mobile-bar [data-sheet="palette"]').getAttribute('aria-expanded'),
  }));
  check('Escape закрывает шторку и возвращает фокус на кнопку', !paletteClosed.sheet && paletteClosed.leftInert && paletteClosed.focusSheet === 'palette' && paletteClosed.expanded === 'false', JSON.stringify(paletteClosed));

  /* ---------- свойства и вложенный диалог ---------- */
  await page.locator('#mobile-bar button[data-sheet="props"]').tap();
  await sleep(450);
  const propsOpen = await page.evaluate(() => ({
    sheet: document.body.classList.contains('sheet-right'),
    focusInside: document.getElementById('right').contains(document.activeElement),
    tab: document.querySelector('#tabs [aria-selected="true"]')?.dataset.tab,
    expanded: document.querySelector('#mobile-bar [data-sheet="props"]').getAttribute('aria-expanded'),
  }));
  check('шторка свойств открывается с фокусом и активной вкладкой', propsOpen.sheet && propsOpen.focusInside && propsOpen.tab === 'props' && propsOpen.expanded === 'true', JSON.stringify(propsOpen));

  await page.evaluate(() => window.BolidGrid.panels.openShortcuts());
  await page.waitForSelector('#modal:not([hidden])');
  await sleep(200);
  const layered = await page.evaluate(() => ({
    modalOpen: !document.getElementById('modal').hidden,
    sheetOpen: document.body.classList.contains('sheet-right'),
    focusInsideModal: document.getElementById('modal').contains(document.activeElement),
  }));
  check('диалог поверх шторки забирает фокус', layered.modalOpen && layered.sheetOpen && layered.focusInsideModal, JSON.stringify(layered));

  await page.keyboard.press('Escape');
  await sleep(200);
  const modalClosed = await page.evaluate(() => ({
    modalHidden: document.getElementById('modal').hidden,
    sheetOpen: document.body.classList.contains('sheet-right'),
    focusInsideSheet: document.getElementById('right').contains(document.activeElement),
  }));
  check('Escape закрывает только верхний слой', modalClosed.modalHidden && modalClosed.sheetOpen && modalClosed.focusInsideSheet, JSON.stringify(modalClosed));

  await page.keyboard.press('Escape');
  await sleep(300);
  check('повторный Escape закрывает шторку', await page.evaluate(() => !document.body.classList.contains('sheet-right')));

  /* ---------- меню ---------- */
  await page.locator('#mobile-menu-btn').tap();
  await sleep(450);
  const menuOpen = await page.evaluate(() => {
    const menu = document.getElementById('menu-sheet');
    return {
      sheet: document.body.classList.contains('sheet-menu'),
      hidden: menu.hidden,
      inert: menu.hasAttribute('inert'),
      ariaHidden: menu.getAttribute('aria-hidden'),
      expanded: document.getElementById('mobile-menu-btn').getAttribute('aria-expanded'),
      focusInside: menu.contains(document.activeElement),
      leftInert: document.getElementById('left').hasAttribute('inert'),
      rightInert: document.getElementById('right').hasAttribute('inert'),
    };
  });
  check('меню открывается без hidden/inert и получает фокус', menuOpen.sheet && !menuOpen.hidden && !menuOpen.inert && menuOpen.ariaHidden === 'false' && menuOpen.expanded === 'true' && menuOpen.focusInside, JSON.stringify(menuOpen));

  await page.screenshot({ path: `${OUT}w4-mobile-menu.png` });
  await page.keyboard.press('Escape');
  await sleep(350);
  const menuClosed = await page.evaluate(() => ({
    sheet: document.body.classList.contains('sheet-menu'),
    hidden: document.getElementById('menu-sheet').hidden,
    inert: document.getElementById('menu-sheet').hasAttribute('inert'),
    ariaHidden: document.getElementById('menu-sheet').getAttribute('aria-hidden'),
    expanded: document.getElementById('mobile-menu-btn').getAttribute('aria-expanded'),
    focusId: document.activeElement?.id,
  }));
  check('Escape закрывает меню, hidden/inert и возвращает фокус', !menuClosed.sheet && menuClosed.hidden && menuClosed.inert && menuClosed.ariaHidden === 'true' && menuClosed.expanded === 'false' && menuClosed.focusId === 'mobile-menu-btn', JSON.stringify(menuClosed));

  check('нет ошибок JavaScript на телефоне', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('нет ошибок в консоли на телефоне', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await context.close();
}

async function main() {
  const { child: server, port } = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const baseUrl = `http://127.0.0.1:${port}/`;
    await desktopChecks(browser, baseUrl);
    await mobileChecks(browser, baseUrl);

    await writeFile(`${OUT}a11y-result.txt`, results.join('\n') + '\n');
    console.log(`\n${results.length - failures}/${results.length} проверок пройдено`);
    if (failures) {
      console.error(`\nПРОВАЛЕНО: ${failures}`);
      process.exitCode = 1;
    } else {
      console.log('Проверки доступности пройдены ✔');
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('Тест доступности упал:', error);
  process.exitCode = 1;
});
