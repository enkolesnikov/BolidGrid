/**
 * main.js — сборка приложения BolidGrid.
 */
import { Store } from './store.js';
import { WallEditor } from './wall.js';
import { Panels } from './panels.js';
import { buildDemoProject } from './demo.js';
import { getModel, CHANNEL_KINDS, CHANNEL_COLORS } from './catalog.js';
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
  if (counts) counts.textContent = `приборов: ${s.counts.devices} · коробов: ${s.counts.channels} · размеров: ${s.counts.dims || 0}`;
}

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
    updateSelectionDock();
    panels.updateToolButtons();
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

function doImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const project = data.project || data;
      if (!project || !Array.isArray(project.walls)) throw new Error('нет массива walls');
      store.replaceProject(project);
      editor.fit();
      panels.toast('Проект загружен из файла');
    } catch (err) {
      panels.toast(`Не удалось прочитать файл: ${err.message}`, true);
    }
  };
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
  if (!showDock) return;
  if (devices.length === 1 && total === 1) {
    const d = devices[0];
    $('dock-title').textContent = getModel(d.modelId).name;
    $('dock-position').textContent = `X ${Math.round(d.x)} · низ ${Math.round(d.y)} мм`;
  } else if (channels.length === 1 && total === 1) {
    $('dock-title').textContent = 'Выбран короб';
    $('dock-position').textContent = `Длина ${(store.channelLength(channels[0]) / 1000).toFixed(2)} м`;
  } else {
    $('dock-title').textContent = `Выбрано: ${total}`;
    $('dock-position').textContent = devices.length > 1 ? 'Доступно выравнивание' : 'Откройте свойства для редактирования';
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
  for (const b of barButtons) b.classList.toggle('active', b.dataset.sheet === active);
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

function closeSheets() {
  bodyEl.classList.remove('sheet-palette', 'sheet-right', 'sheet-menu');
  if (scrim) scrim.hidden = true;
  updateBar(null);
}

function openSheet(name) {
  closeSheets();
  if (name === 'palette') bodyEl.classList.add('sheet-palette');
  else if (name === 'menu') bodyEl.classList.add('sheet-menu');
  else {
    panels.setTab(name);
    bodyEl.classList.add('sheet-right');
  }
  if (scrim) scrim.hidden = false;
  updateBar(name);
}

for (const b of barButtons) {
  b.addEventListener('click', () => {
    const name = b.dataset.sheet;
    const open =
      name === 'palette'
        ? bodyEl.classList.contains('sheet-palette')
        : bodyEl.classList.contains('sheet-right') && panels.activeTab === name;
    if (open) closeSheets();
    else openSheet(name);
  });
}

for (const id of ['mobile-menu-btn', 'desktop-menu-btn']) {
  $(id)?.addEventListener('click', () => {
    if (bodyEl.classList.contains('sheet-menu')) closeSheets();
    else openSheet('menu');
  });
}
$('dock-edit')?.addEventListener('click', () => openSheet('props'));
$('btn-add-device')?.addEventListener('click', () => {
  if (isMobile()) openSheet('palette');
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
MOBILE_MQ.addEventListener?.('change', closeSheets);

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

/* тип новой трассы кабельного канала */
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
  const undo = document.querySelector('[data-action="undo"]');
  const redo = document.querySelector('[data-action="redo"]');
  if (undo) undo.disabled = !store.canUndo;
  if (redo) redo.disabled = !store.canRedo;
}

$('btn-zoom-in')?.addEventListener('click', () => editor.zoomBy(1.25));
$('btn-zoom-out')?.addEventListener('click', () => editor.zoomBy(1 / 1.25));
$('btn-zoom-fit')?.addEventListener('click', () => editor.fit());

function syncViewSettings() {
  for (const id of ['chk-snap', 'chk-snap-mobile']) if ($(id)) $(id).checked = store.settings.snap;
  for (const id of ['chk-grid', 'chk-grid-mobile']) if ($(id)) $(id).checked = store.settings.showGrid;
  if ($('sel-grid')) $('sel-grid').value = String(store.settings.grid || 50);
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

/* завершение трассы кабельного канала кнопкой в подсказке (мобильная версия) */
document.addEventListener('click', (e) => {
  if (e.target.closest?.('#btn-channel-done')) {
    editor.finishChannel();
    panels.toast('Короб добавлен — цвет можно выбрать в «Свойствах»');
  }
  if (e.target.closest?.('#btn-place-done')) {
    editor.cancelDraft();
    panels.toast('Размещение завершено');
  }
});

/* ================== клавиатура ================== */
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    actions.undo();
  } else if ((ctrl && e.key.toLowerCase() === 'y') || (ctrl && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault();
    actions.redo();
  } else if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    actions.save();
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
  updateHistoryButtons();
  renderMenuWalls();
  syncLabelsUI();
  syncWallSizeUI();
  syncViewSettings();
  renderToolColors();
  updateSelectionDock();
  updatePlacementStatus();
  document.body.classList.toggle('tool-channel', store.tool === 'channel');
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
  loadDemo,
};
