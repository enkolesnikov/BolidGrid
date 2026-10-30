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
          groups: s.project.groups.length,
          walls: s.project.walls.length,
          tool: s.tool,
          selection: s.selection.length,
          spec: !!s.spec,
          wall: s.wall?.name,
        };
      });

    const s0 = await state();
    check('демо-проект загружен', s0.devices >= 20 && s0.walls === 2, JSON.stringify(s0));
    check('спецификация загружена из data/spec.json', s0.spec);

    const paletteCount = await page.locator('#palette-list .pal-item').count();
    check('палитра устройств содержит модели', paletteCount >= 18, `items=${paletteCount}`);
    const specBadge = await page.locator('#palette-list .pal-item[data-model="dip34a"]').innerText();
    check('в палитре показано «размещено / по спецификации»', /\/\s*32/.test(specBadge), specBadge.replace(/\s+/g, ' '));

    // --- размещение устройства из палитры ---
    await page.locator('#palette-list .pal-item[data-model="ipr513"]').click();
    const toolAfterArm = (await state()).tool;
    check('выбор модели в палитре включает режим размещения', toolAfterArm === 'place', toolAfterArm);
    const wallBox = await page.locator('#wall').boundingBox();
    await page.mouse.click(wallBox.x + wallBox.width * 0.45, wallBox.y + wallBox.height * 0.5);
    await sleep(200);
    const afterPlace = await state();
    check('клик по стене добавляет устройство', afterPlace.devices === s0.devices + 1, `${s0.devices} → ${afterPlace.devices}`);
    check('после размещения включается инструмент «выбор»', afterPlace.tool === 'select', afterPlace.tool);

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

    // --- объединение устройств в шлейф ---
    await page.locator('.dev-hit').nth(0).click();
    await page.keyboard.down('Shift');
    await page.locator('.dev-hit').nth(1).click();
    await page.keyboard.up('Shift');
    const selTwo = (await state()).selection;
    check('Shift+клик добавляет второе устройство', selTwo >= 2, `selection=${selTwo}`);
    await page.keyboard.press('g');
    await page.waitForSelector('#modal:not([hidden])', { timeout: 4000 });
    await page.fill('#grp-name', 'Тест-шлейф');
    await page.locator('#modal-actions button', { hasText: 'Создать' }).click();
    await sleep(250);
    const afterGroup = await state();
    check('создание объединения из выделенных устройств', afterGroup.groups === s0.groups + 1, `${s0.groups} → ${afterGroup.groups}`);

    // --- undo ---
    await page.keyboard.press('Control+z');
    await sleep(250);
    const afterUndo = await state();
    check('Ctrl+Z отменяет создание объединения', afterUndo.groups === s0.groups, `${afterGroup.groups} → ${afterUndo.groups}`);

    // --- спецификация ---
    await page.locator('#tabs button[data-tab="spec"]').click();
    await page.waitForSelector('#tab-spec table');
    const specTables = await page.locator('#tab-spec table').count();
    const specText = await page.locator('#tab-spec').innerText();
    check('вкладка «Спецификация» отрисована', specTables >= 2, `tables=${specTables}`);
    check('в спецификации есть позиция «Сириус» и «ДИП-34А-04»', /Сириус/.test(specText) && /ДИП-34А-04/.test(specText));
    check('в спецификации есть сопоставление факта и количества', /по\s*спец\./i.test(specText) && /факт/i.test(specText));
    check('в спецификации посчитана длина кабеля по журналу', /КПСнг/.test(specText), '');

    // --- кабельный журнал ---
    await page.locator('#tabs button[data-tab="journal"]').click();
    await page.waitForSelector('#tab-journal table');
    const journalRows = await page.locator('#tab-journal table').first().locator('tbody tr').count();
    check('кабельный журнал содержит строки трасс', journalRows === afterUndo.channels, `rows=${journalRows}, channels=${afterUndo.channels}`);
    const journalText = await page.locator('#tab-journal').innerText();
    check('кабельный журнал содержит итог и опуски', /Итого/.test(journalText) && /Опуск/i.test(journalText));

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
    check('опуски устройств к каналам рассчитаны и нарисованы', dom.drops > 0 && dom.drops <= dom.wallDevices, `drops=${dom.drops}, devices=${dom.wallDevices}`);
    check('объединения показаны цветными линиями', dom.groupLinks > 0, `links=${dom.groupLinks}`);

    // --- экспорт ---
    const svg = await page.evaluate(async () => (await window.BolidGrid.editor.exportSVGFile()).length);
    check('экспорт SVG формирует документ', svg > 5000, `chars=${svg}`);
    const svgValid = await page.evaluate(async () => {
      const s = await window.BolidGrid.editor.exportSVGFile();
      const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
      return !doc.querySelector('parsererror') && doc.documentElement.tagName === 'svg' && doc.querySelectorAll('.dev').length > 0;
    });
    check('экспортированный SVG — корректный XML с устройствами', svgValid);
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
