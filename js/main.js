/**
 * main.js — сборка приложения BolidGrid.
 */
import { Store } from './store.js';
import { WallEditor } from './wall.js';
import { Panels } from './panels.js';
import { buildDemoProject } from './demo.js';
import { getModel, terminalsForModel, CHANNEL_KINDS, CHANNEL_COLORS } from './catalog.js';
import { download, esc } from './util.js';

const $ = (id) => document.getElementById(id);

/* ================== инициализация ================== */
const store = new Store();
const svg = $('wall');
const hintEl = $('canvas-hint');

const editor = new WallEditor({
  store,
  svg,
  hintEl,
  onStatus: (s) => updateStatus(s),
});

const panels = new Panels({ store, editor });

/* ================== статус-бар ================== */
function updateStatus(s) {
  if (!s) return;
  const f = (v) => (v == null ? '—' : Math.round(v).toLocaleString('ru-RU'));
  const coords = $('st-coords');
  if (coords) coords.textContent = `x: ${f(s.x)} · h: ${f(s.y)} мм`;
  const zoom = $('st-zoom');
  if (zoom) zoom.textContent = `${s.zoom}%`;
  const wall = $('st-wall');
  if (wall) wall.textContent = s.wall || '—';
  const counts = $('st-counts');
  if (counts) {
    // Размеры считаем только по активной стене — как приборы и короба.
    const wallId = store.wall?.id;
    const dims = wallId ? (store.project.dimensions || []).filter((d) => d.wallId === wallId).length : 0;
    counts.textContent = `приборов: ${s.counts.devices} · коробов: ${s.counts.channels} · размеров: ${dims}`;
  }
}

/* статус автосохранения */
const saveStatusEl = $('save-status');
function renderSaveStatus(state, at = Date.now()) {
  if (!saveStatusEl) return;
  const label = saveStatusEl.querySelector('b');
  saveStatusEl.classList.toggle('saving', state === 'saving');
  saveStatusEl.classList.toggle('error', state === 'error');
  let text = 'Сохранено';
  if (state === 'saving') text = 'Сохранение…';
  else if (state === 'error') text = 'Не сохранено';
  else {
    const d = new Date(at);
    text = `Сохранено ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (label) label.textContent = text;
  saveStatusEl.title = state === 'error' ? 'Не удалось сохранить — проверьте доступ к хранилищу' : 'Проект сохраняется автоматически';
}
store.on((type, detail) => {
  if (type === 'saving') renderSaveStatus('saving');
  else if (type === 'saved') renderSaveStatus('saved', detail?.at);
  else if (type === 'save-error') renderSaveStatus('error');
});

function updatePlacementStatus() {
  const button = $('st-check');
  if (!button) return;
  const count = store.findPlacementIssues().length;
  button.textContent = count ? `Пересечения: ${count}` : 'Нет пересечений';
  button.classList.toggle('warn', count > 0);
  button.classList.toggle('ok', count === 0);
  button.title = count ? 'Показать места пересечений' : 'Габариты приборов и коробов не пересекаются';
}

$('st-check')?.addEventListener('click', () => panels.openIssuesDialog());

/* ================== уведомления / тосты ================== */
// Ошибки объявляются настойчиво, обычные подсказки — вежливо.
const toastEl = $('toast');
if (toastEl) {
  new MutationObserver(() => {
    const isError = toastEl.classList.contains('err');
    toastEl.setAttribute('role', isError ? 'alert' : 'status');
    toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  }).observe(toastEl, { attributes: true, attributeFilter: ['class'] });
}
store.on((type, detail) => {
  if (type === 'toast') panels.toast(detail?.text || '');
  if (type === 'channel-added') {
    const ch = store.getChannel(detail?.id);
    if (ch) {
      const len = store.channelLength(ch);
      panels.toast(`Короб добавлен: ${(len / 1000).toFixed(2)} м. Цвет — в «Свойствах»`);
      if (isMobile()) setTimeout(() => openSheet('props'), 120);
    }
  }
});

/* ================== реакция на состояние ================== */
store.on((type) => {
  if (['live', 'project', 'all', 'wall'].includes(type)) {
    updateSelectionDock();
    updatePlacementStatus();
  }
  if (type === 'live') {
    editor.render();
    store.scheduleSave();
  } else if (type === 'all' || type === 'project') {
    editor.render();
    panels.renderFor(type);
    updateHistoryButtons();
    renderMenuWalls();
  } else if (type === 'selection') {
    updateSelectionDock();
    const ch = store.selectedChannels()[0];
    if (ch && ch.color) {
      store.settings.channelColor = ch.color;
      renderToolColors();
    }
    editor.render();
    panels.renderFor('selection');
  } else if (type === 'wall') {
    editor.fit();
    panels.renderFor('wall');
    renderMenuWalls();
    syncWallSizeUI();
  } else if (type === 'tool') {
    document.body.classList.toggle('tool-channel', store.tool === 'channel');
    document.body.classList.toggle('tool-cable', store.tool === 'cable');
    updateSelectionDock();
    panels.updateToolButtons();
    syncToolA11y();
    announceTool();
    editor._hint();
    editor.render();
  } else if (type === 'spec') {
    panels.renderFor('spec');
  }
});

/* ================== загрузка данных ================== */
async function loadSpec() {
  try {
    const res = await fetch('data/spec.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const spec = await res.json();
    store.setSpec(spec);
    return spec;
  } catch (err) {
    console.warn('[BolidGrid] спецификация не загружена:', err);
    store.setSpec(null);
    return null;
  }
}

/* ================== действия ================== */
function doExport() {
  const name = (store.project.meta.name || 'bolidgrid').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
  download(`${name}_BolidGrid.json`, store.serialize());
  panels.toast('Проект выгружен в JSON');
}

function applyProjectText(text) {
  const data = JSON.parse(String(text));
  const project = data.project || data;
  if (!project || !Array.isArray(project.walls)) throw new Error('нет массива walls');
  store.replaceProject(project);
  editor.fit();
  panels.toast('Проект загружен из файла');
}

function doImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyProjectText(reader.result);
    } catch (err) {
      panels.toast(`Не удалось прочитать файл: ${err.message}`, true);
    }
  };
  reader.onerror = () => panels.toast('Не удалось прочитать файл', true);
  reader.readAsText(file);
}

function loadDemo(confirmFirst = true) {
  const apply = () => {
    const demo = buildDemoProject();
    store.replaceProject(demo.project, { activeWallId: demo.activeWallId });
    requestAnimationFrame(() => editor.fit());
    panels.toast('Демонстрационный проект загружен');
  };
  if (confirmFirst && store.project.devices.length) {
    panels.confirm('Загрузить демонстрационный проект? Текущий проект будет заменён (его можно сохранить в JSON заранее).', apply);
  } else {
    apply();
  }
}

const actions = {
  undo: () => {
    if (!store.undo()) panels.toast('Уже в начале истории');
  },
  redo: () => {
    if (!store.redo()) panels.toast('Уже в конце истории');
  },
  delete: () => {
    const n = store.removeSelection();
    if (n) panels.toast(`Удалено: ${n}`);
  },
  'export-svg': async () => {
    try {
      const svg = await editor.exportSVGFile();
      const base = (store.project.meta.name || 'bolidgrid').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
      const wall = (editor.wall?.name || 'стена').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
      download(`${base}_${wall}.svg`, svg, 'image/svg+xml');
      panels.toast('Лист стены выгружен в SVG');
    } catch (err) {
      panels.toast(`Не удалось выгрузить SVG: ${err.message}`, true);
    }
  },
  import: () => $('file-input')?.click(),
  'save-project': () => {
    store.save();
    const base = (store.project.meta.name || 'BolidGrid').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    download(`${base}_${stamp}.json`, store.serialize());
    panels.toast(window.BolidGridNative?.saveFile
      ? 'Проект сохраняется в «Загрузки/BolidGrid»'
      : 'Резервная копия проекта сохранена в файл');
  },
  export: doExport,
  print: () => window.print(),
  save: () => {
    const ok = store.save();
    panels.toast(ok ? 'Проект сохранён в браузере' : 'Не удалось сохранить проект', !ok);
  },
  demo: () => loadDemo(true),
  reset: () => {
    panels.confirm('Создать новый пустой проект? Несохранённые изменения будут потеряны.', () => {
      store.clearAll();
      editor.fit();
      panels.toast('Создан новый проект');
    });
  },
  'edit-project': () => panels.openProjectDialog(),
  shortcuts: () => panels.openShortcuts(),
};

for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => {
    const fn = actions[btn.dataset.action];
    if (fn) fn();
  });
}

/* ================== компактная панель выбранного объекта ================== */
function updateSelectionDock() {
  const dock = $('selection-dock');
  if (!dock) return;
  const devices = store.selectedDevices();
  const channels = store.selectedChannels();
  const dims = store.selectedDimensions();
  const total = devices.length + channels.length + dims.length;
  const showDock = total > 0 && store.tool === 'select';
  dock.hidden = !showDock;
  document.body.classList.toggle('has-selection', showDock);
  if (!showDock) {
    if (!total) announce('Выделение снято');
    return;
  }
  if (devices.length === 1 && total === 1) {
    const d = devices[0];
    const name = getModel(d.modelId).name;
    $('dock-title').textContent = name;
    $('dock-position').textContent = `X ${Math.round(d.x)} · низ ${Math.round(d.y)} мм`;
    announce(`Выбран прибор: ${name}`);
  } else if (channels.length === 1 && total === 1) {
    $('dock-title').textContent = 'Выбран короб';
    $('dock-position').textContent = `Длина ${(store.channelLength(channels[0]) / 1000).toFixed(2)} м`;
    announce('Выбран короб');
  } else {
    $('dock-title').textContent = `Выбрано: ${total}`;
    $('dock-position').textContent = devices.length > 1 ? 'Доступно выравнивание' : 'Откройте свойства для редактирования';
    announce(`Выбрано объектов: ${total}`);
  }
}

/* ================== мобильные шторки ================== */
const MOBILE_MQ = window.matchMedia('(max-width: 900px)');
const isMobile = () => MOBILE_MQ.matches;
const bodyEl = document.body;
const scrim = $('scrim');
const menuSheet = $('menu-sheet');
const barButtons = [...document.querySelectorAll('#mobile-bar button')];

function updateBar(active) {
  for (const b of barButtons) {
    const on = b.dataset.sheet === active;
    b.classList.toggle('active', on);
    b.setAttribute('aria-expanded', String(on));
  }
  for (const id of ['mobile-menu-btn', 'desktop-menu-btn']) {
    $(id)?.setAttribute('aria-expanded', String(active === 'menu'));
  }
}

function renderMenuWalls() {
  const box = $('menu-walls');
  if (!box) return;
  const st = store;
  box.innerHTML = st.project.walls
    .map((w) => {
      const n = st.project.devices.filter((d) => d.wallId === w.id).length;
      return `<button class="wall-item ${w.id === st.wall?.id ? 'active' : ''}" data-menu-wall="${w.id}">
        <span class="wname">${esc(w.name)}</span>
        <span class="wdim">${n} устр.</span>
      </button>`;
    })
    .join('');
}

/* ================= доступность: фокус и слои ================= */
const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

function focusableWithin(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
  );
}

function trapFocus(event, root) {
  if (event.key !== 'Tab' || !root) return false;
  const items = focusableWithin(root);
  if (!items.length) {
    event.preventDefault();
    root.focus?.();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!root.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

let sheetTrigger = null;
let lastAnnouncement = '';
let announcementToken = 0;

/** Озвучивание изменений для скринридера — без повторов одного и того же текста. */
function announce(text) {
  const box = $('sr-status');
  if (!box || !text || text === lastAnnouncement) return;
  lastAnnouncement = text;
  const token = ++announcementToken;
  box.textContent = '';
  setTimeout(() => {
    if (box.isConnected && token === announcementToken) box.textContent = text;
  }, 30);
}

function currentSheet() {
  if (bodyEl.classList.contains('sheet-menu')) return 'menu';
  if (bodyEl.classList.contains('sheet-palette')) return 'palette';
  if (bodyEl.classList.contains('sheet-right')) return 'right';
  return null;
}

function sheetRoot(name = currentSheet()) {
  if (!name) return null;
  if (name === 'menu') return menuSheet;
  if (name === 'palette') return $('left');
  // props / spec / journal — все живут в правой шторке.
  return $('right');
}

/** Закрытые шторки на телефоне уезжают за экран, но остаются в DOM: убираем их из фокуса и дерева доступности. */
function syncSheetA11y() {
  const open = currentSheet();
  const mobile = isMobile();
  const left = $('left');
  const right = $('right');
  if (left) left.toggleAttribute('inert', mobile && open !== 'palette');
  if (right) right.toggleAttribute('inert', mobile && open !== 'right');
  if (menuSheet) {
    const closed = open !== 'menu';
    // Не полагаемся на CSS-хак меню: hidden должен реально скрывать слой,
    // в том числе после общего правила [hidden]{display:none!important}.
    menuSheet.hidden = closed;
    menuSheet.toggleAttribute('inert', closed);
    menuSheet.setAttribute('aria-hidden', closed ? 'true' : 'false');
  }
  if (scrim) scrim.hidden = !open;
}

function closeSheets({ restoreFocus = true } = {}) {
  const wasOpen = !!currentSheet();
  bodyEl.classList.remove('sheet-palette', 'sheet-right', 'sheet-menu');
  if (scrim) scrim.hidden = true;
  updateBar(null);
  syncSheetA11y();
  if (wasOpen && restoreFocus) {
    const trigger = sheetTrigger;
    sheetTrigger = null;
    if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus();
  } else if (!wasOpen) {
    sheetTrigger = null;
  }
}

function openSheet(name, trigger = null) {
  const wasOpen = !!currentSheet();
  const opener = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  closeSheets({ restoreFocus: false });
  if (!wasOpen || !sheetTrigger) sheetTrigger = opener;
  if (name === 'palette') bodyEl.classList.add('sheet-palette');
  else if (name === 'menu') {
    updateHistoryButtons();
    bodyEl.classList.add('sheet-menu');
  } else {
    panels.setTab(name);
    bodyEl.classList.add('sheet-right');
    syncTabsA11y();
  }
  if (scrim) scrim.hidden = false;
  updateBar(name);
  syncSheetA11y();
  const focusSheet = () => {
    const root = sheetRoot(name);
    const target = root?.querySelector('.sheet-head [data-sheet-close]') || focusableWithin(root)[0];
    target?.focus();
  };
  if (isMobile() || name === 'menu') {
    focusSheet();
    // Тап по кнопке может вернуть ей фокус уже после обработчика click — повторяем,
    // если фокус остался на инициаторе или на body.
    setTimeout(() => {
      if (document.activeElement === opener || document.activeElement === document.body) focusSheet();
    }, 140);
  }
}

for (const b of barButtons) {
  b.addEventListener('click', () => {
    const name = b.dataset.sheet;
    const open =
      name === 'palette'
        ? bodyEl.classList.contains('sheet-palette')
        : bodyEl.classList.contains('sheet-right') && panels.activeTab === name;
    if (open) closeSheets();
    else openSheet(name, b);
  });
}

for (const id of ['mobile-menu-btn', 'desktop-menu-btn']) {
  $(id)?.addEventListener('click', (e) => {
    if (bodyEl.classList.contains('sheet-menu')) closeSheets();
    else openSheet('menu', e.currentTarget);
  });
}
$('dock-edit')?.addEventListener('click', (e) => {
  openSheet('props', e.currentTarget);
  // «Точно» должно вести к точным координатам, а не просто открывать шторку сверху.
  setTimeout(() => {
    const field = document.querySelector('#tab-props [data-pos-x]');
    field?.closest('.prop-section')?.scrollIntoView({ block: 'center' });
    field?.focus({ preventScroll: true });
  }, 120);
});
$('btn-add-device')?.addEventListener('click', () => {
  if (isMobile()) openSheet('palette', $('btn-add-device'));
  else {
    $('palette-search')?.focus();
    panels.toast('Выберите модель в каталоге слева');
  }
});
scrim?.addEventListener('click', closeSheets);
for (const b of document.querySelectorAll('[data-sheet-close]')) b.addEventListener('click', closeSheets);
$('menu-sheet')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu-action]');
  if (!b) return;
  const fn = actions[b.dataset.menuAction];
  closeSheets();
  if (fn) setTimeout(fn, 0);
});
$('menu-walls')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu-wall]');
  if (!b) return;
  store.setActiveWall(b.dataset.menuWall);
  closeSheets();
  editor.fit();
});
$('btn-add-wall-mobile')?.addEventListener('click', () => {
  closeSheets();
  panels.openWallDialog(null);
});
// при выборе модели из палитры шторка закрывается — сразу видно лист стены
$('palette-list')?.addEventListener('click', (e) => {
  if (isMobile() && e.target.closest('[data-model]')) setTimeout(closeSheets, 60);
});
// вкладки правой панели обновляют подсветку таб-бара
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => updateBar(b.dataset.tab));
}
MOBILE_MQ.addEventListener?.('change', () => {
  closeSheets({ restoreFocus: false });
  syncSheetA11y();
});

/* ================= доступность: вкладки, инструменты, стены ================= */
function syncTabsA11y() {
  const tabs = [...document.querySelectorAll('#tabs [data-tab]')];
  for (const b of tabs) {
    const tab = b.dataset.tab;
    const selected = tab === panels.activeTab;
    b.setAttribute('aria-selected', String(selected));
    b.setAttribute('aria-controls', `tab-${tab}`);
    b.tabIndex = selected ? 0 : -1;
    const panel = $(`tab-${tab}`);
    if (panel) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', b.id || `tab-btn-${tab}`);
    }
  }
}

function moveTab(event) {
  const tabs = [...document.querySelectorAll('#tabs [data-tab]')];
  if (tabs.length < 2) return;
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next == null) return;
  event.preventDefault();
  event.stopPropagation();
  panels.setTab(tabs[next].dataset.tab);
  updateBar(tabs[next].dataset.tab);
  syncTabsA11y();
  tabs[next].focus();
}

for (const b of document.querySelectorAll('#tabs [data-tab]')) {
  b.addEventListener('click', () => syncTabsA11y());
  b.addEventListener('keydown', moveTab);
}

const TOOL_NAMES = {
  select: 'Выбор',
  place: 'Размещение',
  channel: 'Короб',
  cable: 'Связь',
  dimension: 'Размер',
  pan: 'Панорама',
};

function announceTool() {
  announce(`Инструмент: ${TOOL_NAMES[store.tool] || store.tool}`);
}

function syncToolA11y() {
  for (const b of document.querySelectorAll('#stage-toolbar [data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === store.tool));
  }
}

function syncWallTabsA11y() {
  const box = $('wall-tabs');
  if (!box) return;
  const tabs = [...box.querySelectorAll('[data-wall-id]')];
  tabs.forEach((b, i) => {
    b.id = `wall-tab-${i}`;
    b.setAttribute('role', 'tab');
    const selected = b.classList.contains('active');
    b.setAttribute('aria-selected', String(selected));
    b.setAttribute('aria-controls', 'canvas-wrap');
    b.tabIndex = selected ? 0 : -1;
  });
  const active = tabs.find((b) => b.classList.contains('active'));
  const panel = $('canvas-wrap');
  if (panel) {
    panel.setAttribute('role', 'tabpanel');
    if (active) panel.setAttribute('aria-labelledby', active.id);
    panel.setAttribute('aria-label', active ? `Лист стены: ${active.textContent.trim()}` : 'Лист стены');
  }
}

const wallTabsBox = $('wall-tabs');
if (wallTabsBox) {
  new MutationObserver(() => syncWallTabsA11y()).observe(wallTabsBox, { childList: true });
  wallTabsBox.addEventListener('click', () => setTimeout(syncWallTabsA11y, 0));
  wallTabsBox.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...wallTabsBox.querySelectorAll('[data-wall-id]')];
    if (tabs.length < 2) return;
    const index = tabs.indexOf(event.target.closest('[data-wall-id]'));
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    store.setActiveWall(tabs[next].dataset.wallId);
    editor.fit();
    requestAnimationFrame(() => {
      const fresh = [...wallTabsBox.querySelectorAll('[data-wall-id]')][next];
      fresh?.focus();
      syncWallTabsA11y();
    });
  });
}

/* ================== инструменты ================== */
for (const b of document.querySelectorAll('#stage-toolbar [data-tool]')) {
  b.addEventListener('click', () => {
    const tool = b.dataset.tool;
    if (tool === 'select') {
      editor.cancelDraft();
      store.tool = 'select';
      store.armedModelId = null;
      store.emit('tool');
      store.emit('palette');
    } else {
      editor.setTool(tool);
    }
    panels.updateToolButtons();
  });
}

/* тип новой трассы короба */
const chKind = $('sel-channel-kind');
if (chKind) {
  chKind.innerHTML = CHANNEL_KINDS.map((k) => `<option value="${k.id}">${k.label}</option>`).join('');
  store.settings.channelKind = CHANNEL_KINDS[0].id;
  chKind.value = store.settings.channelKind;
  chKind.addEventListener('change', () => {
    store.settings.channelKind = chKind.value;
    panels.toast(`Тип трассы: ${chKind.options[chKind.selectedIndex].textContent}`);
  });
}

/* цвет короба: для новых трасс и для выделенного короба */
function renderToolColors() {
  const active = store.settings.channelColor || CHANNEL_COLORS[0];
  for (const id of ['tool-colors', 'tool-colors-mobile']) {
    const box = $(id);
    if (!box) continue;
    box.innerHTML = CHANNEL_COLORS.map(
      (c) => `<button class="swatch ${c.toLowerCase() === String(active).toLowerCase() ? 'active' : ''}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Цвет ${c}"></button>`
    ).join('');
  }
}
function applyChannelColor(color) {
  store.settings.channelColor = color;
  const sel = store.selectedChannels();
  if (sel.length) store.updateChannel(sel[0].id, { color });
  store.scheduleSave();
  renderToolColors();
  editor.render();
  panels.toast(`Цвет короба: ${color}`);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('#tool-colors [data-color], #tool-colors-mobile [data-color]');
  if (b) applyChannelColor(b.dataset.color);
});

/* размеры активной стены: задаются прямо в панели инструментов (и в меню на телефоне) */
function syncWallSizeUI() {
  const w = store.wall;
  if (!w) return;
  const pairs = [
    ['wall-w', w.width / 1000],
    ['wall-h', w.height / 1000],
    ['wall-w-mobile', w.width / 1000],
    ['wall-h-mobile', w.height / 1000],
  ];
  for (const [id, v] of pairs) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = String(Math.round(v * 10) / 10);
  }
}
function applyWallSize(lenM, heightM) {
  const wall = store.wall;
  if (!wall) return;
  const patch = {};
  if (lenM != null && Number.isFinite(lenM)) patch.width = Math.round(Math.min(60, Math.max(0.5, lenM)) * 1000);
  if (heightM != null && Number.isFinite(heightM)) patch.height = Math.round(Math.min(20, Math.max(0.5, heightM)) * 1000);
  if (!Object.keys(patch).length) return;
  store.updateWall(wall.id, patch);
  editor.fit();
  syncWallSizeUI();
  panels.toast(`Стена: ${(store.wall.width / 1000).toFixed(1)} × ${(store.wall.height / 1000).toFixed(1)} м`);
}
for (const id of ['wall-w', 'wall-h', 'wall-w-mobile', 'wall-h-mobile']) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener('change', () => {
    const mobile = id.endsWith('-mobile');
    const w = $(mobile ? 'wall-w-mobile' : 'wall-w');
    const h = $(mobile ? 'wall-h-mobile' : 'wall-h');
    applyWallSize(parseFloat(w?.value), parseFloat(h?.value));
  });
}

/* подписи на листе: нет / кратко (обозначение) / полные (обозначение + адрес) */
function syncLabelsUI() {
  const v = store.settings.labels || 'none';
  for (const id of ['sel-labels', 'sel-labels-mobile']) {
    const el = $(id);
    if (el) el.value = v;
  }
}
function setLabels(value) {
  if (!['none', 'tag', 'full'].includes(value)) return;
  store.settings.labels = value;
  syncLabelsUI();
  store.scheduleSave();
  editor.render();
  const names = { none: 'подписи скрыты', tag: 'краткие обозначения', full: 'полные подписи' };
  panels.toast(`Подписи: ${names[value]}`);
}
for (const id of ['sel-labels', 'sel-labels-mobile']) {
  const el = $(id);
  if (el) el.addEventListener('change', () => setLabels(el.value));
}

/* доступность кнопок истории */
function updateHistoryButtons() {
  for (const button of document.querySelectorAll('[data-action="undo"], [data-menu-action="undo"]')) {
    button.disabled = !store.canUndo;
    button.setAttribute('aria-disabled', String(!store.canUndo));
  }
  for (const button of document.querySelectorAll('[data-action="redo"], [data-menu-action="redo"]')) {
    button.disabled = !store.canRedo;
    button.setAttribute('aria-disabled', String(!store.canRedo));
  }
}

$('btn-zoom-in')?.addEventListener('click', () => editor.zoomBy(1.25));
$('btn-zoom-out')?.addEventListener('click', () => editor.zoomBy(1 / 1.25));
$('btn-zoom-fit')?.addEventListener('click', () => editor.fit());

function syncLegend() {
  const legend = $('canvas-legend');
  const toggle = $('chk-legend');
  const on = store.settings.showLegend !== false;
  if (legend) legend.hidden = !on;
  if (toggle) toggle.checked = on;
}

function syncViewSettings() {
  for (const id of ['chk-snap', 'chk-snap-mobile']) if ($(id)) $(id).checked = store.settings.snap;
  for (const id of ['chk-grid', 'chk-grid-mobile']) if ($(id)) $(id).checked = store.settings.showGrid;
  if ($('sel-grid')) $('sel-grid').value = String(store.settings.grid || 50);
  syncLegend();
}
for (const id of ['chk-snap', 'chk-snap-mobile']) $(id)?.addEventListener('change', (e) => {
  store.settings.snap = e.target.checked;
  syncViewSettings();
  store.scheduleSave();
  panels.toast(store.settings.snap ? 'Привязка включена' : 'Привязка выключена');
});
for (const id of ['chk-grid', 'chk-grid-mobile']) $(id)?.addEventListener('change', (e) => {
  store.settings.showGrid = e.target.checked;
  syncViewSettings();
  store.scheduleSave();
  editor.render();
});
$('sel-grid')?.addEventListener('change', (e) => {
  store.settings.grid = +e.target.value || 50;
  store.scheduleSave();
  editor.render();
});
$('chk-legend')?.addEventListener('change', (e) => {
  store.settings.showLegend = e.target.checked;
  store.scheduleSave();
  syncLegend();
  panels.toast(e.target.checked ? 'Легенда групп включена' : 'Легенда групп скрыта');
});
$('st-help')?.addEventListener('click', () => panels.openShortcuts());
/* поиск в каталоге: очистка и переход к результатам */
const paletteSearchInput = $('palette-search');
const paletteSearchClear = $('palette-search-clear');
function syncPaletteClear() {
  if (paletteSearchClear) paletteSearchClear.hidden = !paletteSearchInput?.value;
}
paletteSearchInput?.addEventListener('input', syncPaletteClear);
paletteSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (paletteSearchInput.value) {
      paletteSearchInput.value = '';
      paletteSearchInput.dispatchEvent(new Event('input'));
    } else if (isMobile() && currentSheet()) {
      closeSheets();
    }
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    const first = document.querySelector('#palette-list .pal-item');
    if (first) {
      first.focus();
      e.preventDefault();
    }
  }
});
paletteSearchClear?.addEventListener('click', () => {
  if (!paletteSearchInput) return;
  paletteSearchInput.value = '';
  paletteSearchInput.dispatchEvent(new Event('input'));
  paletteSearchInput.focus();
});
syncPaletteClear();
$('file-input')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) doImport(file);
  e.target.value = '';
});

/* подсказка на листе не должна мешать: через 8 секунд притухаем, при действии — снова ярко */
setTimeout(() => $('canvas-hint')?.classList.add('dim'), 8000);
for (const ev of ['pointerdown', 'keydown']) {
  document.addEventListener(
    ev,
    () => $('canvas-hint')?.classList.remove('dim'),
    { passive: true }
  );
}

/* завершение трассы короба кнопкой в подсказке (мобильная версия) */
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#btn-channel-done')) {
    editor.finishChannel();
    panels.toast('Короб добавлен — цвет можно выбрать в «Свойствах»');
  }
  if (e.target.closest?.('#btn-place-done')) {
    editor.cancelDraft();
    panels.toast('Размещение завершено');
  }
  if (e.target.closest?.('#btn-cable-done')) {
    editor.cableDraft = null;
    editor.render();
    panels.toast('Связь отменена');
  }
});

/* ================== клавиатура ================== */
window.addEventListener('keydown', (e) => {
  const modalEl = $('modal');
  if (modalEl && !modalEl.hidden) {
    // Диалог — верхний слой: фокус не уходит в фон, глобальные шорткаты молчат.
    if (e.key === 'Tab') trapFocus(e, modalEl.querySelector('.modal'));
    return;
  }

  const sheet = currentSheet();
  if (sheet && (isMobile() || sheet === 'menu') && e.key === 'Tab') {
    if (trapFocus(e, sheetRoot(sheet))) return;
  }

  const t = e.target;
  const typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  if (typing) {
    // Esc в поле шторки закрывает шторку; поиск сначала очищает запрос сам.
    if (sheet && e.key === 'Escape' && t !== $('palette-search')) {
      e.preventDefault();
      closeSheets();
    }
    return;
  }
  if (sheet && e.key === 'Escape') {
    e.preventDefault();
    closeSheets();
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === '?' || (e.shiftKey && e.key === '/') || e.key === 'F1') {
    e.preventDefault();
    actions.shortcuts();
  } else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    actions.undo();
  } else if ((ctrl && e.key.toLowerCase() === 'y') || (ctrl && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault();
    actions.redo();
  } else if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    actions['save-project']();
  } else if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (store.selectedDevices().length) store.duplicateDevices();
  } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && store.selectedDevices().length) {
    e.preventDefault();
    const step = e.shiftKey ? 1 : 10;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
    store.nudgeDevices(dx, dy);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    actions.delete();
  } else if (e.key === 'Escape') {
    editor.cancelAll();
    store.clearSelection();
    store.tool = 'select';
    store.emit('tool');
  } else if (e.key === 'Enter') {
    if (store.tool === 'channel' && editor.channelDraft) editor._finishChannel();
  } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
    const sel = store.selectedDevices();
    if (sel.length) {
      store.act('поворот устройств', () => {
        for (const d of sel) store.updateDevice(d.id, { rot: ((d.rot || 0) + 90) % 360 }, { commit: false });
      });
    }
  } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
    editor.fit();
  } else if (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М') {
    editor.cancelDraft();
    store.tool = 'select';
    store.emit('tool');
  } else if (e.key === 'l' || e.key === 'L' || e.key === 'д' || e.key === 'Д') {
    editor.setTool('cable');
  } else if (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С') {
    editor.setTool('channel');
  } else if (e.key === 'm' || e.key === 'M' || e.key === 'ь' || e.key === 'Ь') {
    editor.setTool('dimension');
  } else if (e.key === 'h' || e.key === 'H' || e.key === 'р' || e.key === 'Р') {
    editor.setTool('pan');
  } else if (e.key === '+' || e.key === '=') {
    editor.zoomBy(1.25);
  } else if (e.key === '-') {
    editor.zoomBy(1 / 1.25);
  } else if (e.key === '0') {
    editor.fit();
  }
});

window.addEventListener('beforeunload', () => store.save());

/* печать: лист всегда печатается целиком (масштаб «вся стена»), после — прежний вид */
let printView = null;
window.addEventListener('beforeprint', () => {
  printView = { ...editor.view };
  editor.fit();
});
window.addEventListener('afterprint', () => {
  if (!printView) return;
  Object.assign(editor.view, printView);
  printView = null;
  editor.render();
});

/* ================== запуск ================== */
(async function boot() {
  await loadSpec();
  const restored = store.loadSaved();
  if (!restored) {
    const demo = buildDemoProject();
    store.replaceProject(demo.project, { activeWallId: demo.activeWallId });
  }
  store.ensureActiveWall();
  panels.renderAll();
  panels.updateToolButtons();
  syncTabsA11y();
  syncToolA11y();
  syncWallTabsA11y();
  syncSheetA11y();
  updateHistoryButtons();
  renderMenuWalls();
  syncLabelsUI();
  syncWallSizeUI();
  syncViewSettings();
  renderToolColors();
  renderSaveStatus('saved');
  updateSelectionDock();
  updatePlacementStatus();
  document.body.classList.toggle('tool-channel', store.tool === 'channel');
    document.body.classList.toggle('tool-cable', store.tool === 'cable');
  editor._hint();
  requestAnimationFrame(() => {
    editor.fit();
    editor.render();
    // Демо открывается сразу, без перекрывающего лист стартового уведомления.
  });
  console.info('[BolidGrid] готов:', {
    devices: store.project.devices.length,
    channels: store.project.channels.length,
    dims: (store.project.dimensions || []).length,
    spec: !!store.spec,
  });
})();

/* для отладки из консоли и автотестов */
window.BolidGrid = {
  store,
  editor,
  panels,
  getModel,
  terminalsForModel,
  loadDemo,
  /** Загрузка проекта из текста JSON (используется Android-оболочкой при «Открыть/Поделиться»). */
  importProjectText: (text) => {
    try {
      applyProjectText(text);
      return true;
    } catch (err) {
      panels.toast(`Не удалось прочитать файл: ${err.message}`, true);
      return false;
    }
  },
};

/* В Android-оболочке нет window.print — печать отдаём системному PrintManager. */
if (window.BolidGridNative?.printPage) {
  window.print = () => window.BolidGridNative.printPage();
}
