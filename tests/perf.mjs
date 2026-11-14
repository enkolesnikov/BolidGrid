/**
 * tests/perf.mjs — производительность панелей и U-08 (клавиатурный доступ к стенам).
 *
 * Требуется Playwright:  npm install && npx playwright install chromium
 * Запуск:                node tests/perf.mjs
 *
 * Тест поднимает собственный сервер на случайном порту, чтобы не конфликтовать
 * с smoke/qa/mobile. Бюджеты времени намеренно с большим запасом: на этом
 * окружении (headless Chromium, Node 20+) renderAll на ~100 приборах занимает
 * единицы миллисекунд, renderFor('project') — доли миллисекунды. Порог ловит
 * регресс «снова пересобираем всю палитру и скрытые вкладки на каждый commit»,
 * а не шум измерений.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('./output/', import.meta.url).pathname;
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
  await mkdir(OUT, { recursive: true });
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

    /* ---------- 1. время рендера на демо и на ~100 приборах ---------- */
    const medians = await page.evaluate(async () => {
      const p = window.BolidGrid.panels;
      const store = window.BolidGrid.store;
      const { getModel } = await import('/js/catalog.js');
      const time = (fn, n = 9) => {
        fn();
        const samples = [];
        for (let i = 0; i < n; i++) {
          const t = performance.now();
          fn();
          samples.push(performance.now() - t);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)];
      };
      const demo = {
        renderAll: time(() => p.renderAll()),
        renderFor: time(() => p.renderFor('project')),
        palette: time(() => p.renderPalette()),
      };
      // 100 приборов добавляем одним act, чтобы не мерить 100 отдельных commit.
      store.act('наполнение для замера', (s) => {
        const wall = store.wall;
        const ids = ['sp2', 'sp4_220', 'ar2', 'sirius', 'mpn', 'molnia_exit'];
        for (let i = 0; i < 100; i++) {
          const m = getModel(ids[i % ids.length]);
          s.project.devices.push({
            id: `perf${i}`,
            modelId: m.id,
            wallId: wall.id,
            x: Math.max(0, Math.min(wall.width - m.w, 200 + (i % 10) * 300)),
            y: Math.max(0, Math.min(wall.height - m.h, 100 + Math.floor(i / 10) * 240)),
            rot: 0,
            tag: `P${i}`,
            address: '',
            note: '',
            system: 'other',
          });
        }
      });
      const heavy = {
        count: store.project.devices.length,
        renderAll: time(() => p.renderAll()),
        renderFor: time(() => p.renderFor('project')),
        palette: time(() => p.renderPalette()),
      };
      return { demo, heavy };
    });
    console.log(`  demo: ${JSON.stringify(medians.demo)}`);
    console.log(`  heavy: ${JSON.stringify(medians.heavy)}`);

    check('renderAll на демо укладывается в бюджет 300 мс', medians.demo.renderAll < 300, `${medians.demo.renderAll.toFixed(1)} мс`);
    check('renderAll на ~100 приборах укладывается в бюджет 300 мс', medians.heavy.renderAll < 300, `${medians.heavy.renderAll.toFixed(1)} мс, приборов=${medians.heavy.count}`);
    check('renderFor("project") на ~100 приборах < 50 мс', medians.heavy.renderFor < 50, `${medians.heavy.renderFor.toFixed(2)} мс`);
    check('renderPalette без изменений — no-op < 2 мс', medians.heavy.palette < 2, `${medians.heavy.palette.toFixed(2)} мс`);

    /* ---------- 2. палитра не пересобирается на commit без изменений ---------- */
    const churn = await page.evaluate(async () => {
      const p = window.BolidGrid.panels;
      const box = document.getElementById('palette-list');
      let added = 0;
      let addedElements = 0;
      const obs = new MutationObserver((recs) => {
        for (const r of recs) {
          added += r.addedNodes.length;
          for (const n of r.addedNodes) if (n.nodeType === 1) addedElements++;
        }
      });
      obs.observe(box, { childList: true, subtree: true });
      p.renderFor('project');
      await new Promise((r) => setTimeout(r, 0));
      obs.disconnect();
      return { added, addedElements };
    });
    check('палитра не пересоздаёт DOM на commit без изменений', churn.added === 0, JSON.stringify(churn));

    /* ---------- 3. поиск: ожидаемый состав ---------- */
    const search = await page.evaluate(async () => {
      const p = window.BolidGrid.panels;
      const { MODELS, modelHaystack, SYSTEM_ORDER } = await import('/js/catalog.js');
      const input = document.getElementById('palette-search');
      input.value = '2000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const domIds = [...document.querySelectorAll('#palette-list .pal-item')].map((el) => el.dataset.model);
      // Порядок палитры — по группам SYSTEM_ORDER, внутри группы — порядок MODELS.
      const expected = [];
      for (const sys of SYSTEM_ORDER) {
        for (const m of MODELS) {
          if (m.hidden || m.system !== sys) continue;
          if (modelHaystack(m).includes('2000')) expected.push(m.id);
        }
      }
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { domIds, expected };
    });
    check(
      'палитра после поиска содержит ровно ожидаемые модели',
      search.domIds.length > 3 && JSON.stringify(search.domIds) === JSON.stringify(search.expected),
      `dom=${search.domIds.length}, expected=${search.expected.length}`
    );
    check('поиск «2000» находит С2000-СП2 и С2000М', search.domIds.includes('sp2') && search.domIds.includes('s2000m'), search.domIds.join(','));

    /* ---------- 4. скрытая спецификация не рендерится на каждый commit ---------- */
    const hidden = await page.evaluate(() => {
      const p = window.BolidGrid.panels;
      const origSpec = p.renderSpec;
      const origJournal = p.renderJournal;
      let spec = 0;
      let journal = 0;
      p.renderSpec = function (...args) { spec++; return origSpec.apply(this, args); };
      p.renderJournal = function (...args) { journal++; return origJournal.apply(this, args); };
      for (let i = 0; i < 3; i++) p.renderFor('project');
      p.renderSpec = origSpec;
      p.renderJournal = origJournal;
      return { spec, journal, activeTab: p.activeTab };
    });
    check('скрытые вкладки не рендерятся на commit (spec/journal = 0)', hidden.spec === 0 && hidden.journal === 0, JSON.stringify(hidden));

    const readFacts = () =>
      page.evaluate(() => {
        const sum = [...document.querySelectorAll('#tab-spec tbody tr')].reduce((a, tr) => {
          const cells = tr.querySelectorAll('td');
          const v = cells[6] ? parseFloat(cells[6].textContent.replace(/\s/g, '')) : NaN;
          return a + (Number.isFinite(v) ? v : 0);
        }, 0);
        return { sum, html: document.getElementById('tab-spec').innerHTML };
      });

    // Открываем спецификацию после наполнения: она должна догнать 100 приборов.
    await page.locator('#tabs button[data-tab="spec"]').click();
    await page.waitForSelector('#tab-spec table', { timeout: 5000 });
    const factsBefore = await readFacts();
    check('после наполнения открытая спецификация актуальна', factsBefore.sum > 0, `факт=${factsBefore.sum}`);

    // Скрываем вкладку, меняем проект и убеждаемся, что DOM не тронут.
    await page.locator('#tabs button[data-tab="props"]').click();
    await page.evaluate(() => {
      const store = window.BolidGrid.store;
      store.act('добавление для спецификации', (s) => {
        const wall = store.wall;
        for (let i = 0; i < 3; i++) {
          s.project.devices.push({
            id: `specdirty${i}`,
            modelId: 'sp2',
            wallId: wall.id,
            x: 300 + i * 140,
            y: 300,
            rot: 0,
            tag: `S${i}`,
            address: '',
            note: '',
            system: 'other',
          });
        }
      });
    });
    await sleep(80);
    const hiddenAfterCommit = await readFacts();
    check('DOM спецификации не меняется, пока вкладка скрыта', factsBefore.html === hiddenAfterCommit.html && factsBefore.html.length > 0);
    check('скрытая спецификация не отстала по «Факту» в DOM', hiddenAfterCommit.sum === factsBefore.sum, `${factsBefore.sum} → ${hiddenAfterCommit.sum}`);

    await page.locator('#tabs button[data-tab="spec"]').click();
    await page.waitForSelector('#tab-spec table', { timeout: 5000 });
    const factsAfter = await readFacts();
    check('при открытии вкладки спецификация догоняет изменения (+3)', factsAfter.sum === factsBefore.sum + 3, `${factsBefore.sum} → ${factsAfter.sum}`);

    // Возвращаемся на «Свойства» для проверки фокуса.
    await page.locator('#tabs button[data-tab="props"]').click();

    /* ---------- 5. фокус и курсор в инспекторе переживают commit ---------- */
    const focus = await page.evaluate(() => {
      const store = window.BolidGrid.store;
      const device = store.wallDevices[0];
      store.selectOne('device', device.id);
      const input = document.querySelector('#tab-props [data-f="tag"]');
      if (!input) return { error: 'нет поля обозначения' };
      input.focus();
      input.value = `${device.tag}Z`;
      input.setSelectionRange(2, 2);
      const expectedTag = input.value;
      const before = { start: input.selectionStart, end: input.selectionEnd };
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const fresh = document.querySelector('#tab-props [data-f="tag"]');
      const after = {
        focused: document.activeElement === fresh,
        field: document.activeElement?.dataset?.f,
        start: fresh?.selectionStart,
        end: fresh?.selectionEnd,
        committed: store.getDevice(device.id)?.tag === expectedTag,
      };
      store.updateDevice(device.id, { tag: device.tag });
      return { before, after };
    });
    check('фокус остаётся в поле инспектора после commit', focus.after?.focused === true && focus.after.field === 'tag', JSON.stringify(focus.after));
    check('позиция курсора сохраняется', focus.after?.start === focus.before.start && focus.after?.end === focus.before.end, JSON.stringify({ before: focus.before, after: focus.after }));
    check('значение поля действительно сохранено в проекте', focus.after?.committed === true);

    /* ---------- 6. U-08: строки стен доступны с клавиатуры ---------- */
    const wallA11y = await page.evaluate(() => {
      const store = window.BolidGrid.store;
      store.addWall({ name: 'Стена для клавиатуры', width: 5000, height: 2700 });
      const items = [...document.querySelectorAll('#walls-list .wall-item')];
      return {
        count: items.length,
        role: items[0]?.getAttribute('role'),
        tabindex: items[0]?.getAttribute('tabindex'),
        ids: items.map((el) => el.dataset.wallId),
        active: store.wall.id,
      };
    });
    check('строки стен имеют role="button" и tabindex="0"', wallA11y.role === 'button' && wallA11y.tabindex === '0', JSON.stringify({ role: wallA11y.role, tabindex: wallA11y.tabindex }));

    const wallKeys = await page.evaluate(() => document.querySelectorAll('#walls-list .wall-item').length);
    if (wallKeys >= 2) {
      await page.locator('#walls-list .wall-item').first().focus();
      await page.keyboard.press('Enter');
      await sleep(120);
      const afterEnter = await page.evaluate(() => window.BolidGrid.store.wall.id);
      check('Enter на строке стены переключает активную стену', afterEnter === wallA11y.ids[0], `${wallA11y.active} → ${afterEnter}`);

      await page.locator('#walls-list .wall-item').nth(1).focus();
      await page.keyboard.press(' ');
      await sleep(120);
      const afterSpace = await page.evaluate(() => window.BolidGrid.store.wall.id);
      check('Space на строке стены переключает активную стену', afterSpace === wallA11y.ids[1], `${afterEnter} → ${afterSpace}`);

      // Вложенная кнопка удаления не должна активировать стену, но должна открыть подтверждение.
      await page.locator('#walls-list .wall-item').first().locator('.wdel').click();
      await sleep(120);
      const modal = await page.evaluate(() => ({
        open: document.getElementById('modal')?.hidden === false,
        title: document.getElementById('modal-title')?.textContent,
        activeWall: window.BolidGrid.store.wall.id,
      }));
      check('кнопка удаления внутри строки по-прежнему открывает подтверждение', modal.open && modal.title === 'Подтверждение', JSON.stringify(modal));
      await page.locator('#modal-actions button', { hasText: 'Отмена' }).click();
      await sleep(80);
    } else {
      check('удалось создать вторую стену для проверки клавиатуры', false, `wall-items=${wallKeys}`);
    }

    check('нет pageerror', pageErrors.length === 0, pageErrors.join(' | '));
    check('нет console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

    await page.screenshot({ path: `${OUT}perf.png` });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log(`\n${failures ? `${failures} FAIL` : 'все проверки пройдены'}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
