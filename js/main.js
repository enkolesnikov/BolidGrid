/**
 * main.js — сборка приложения BolidGrid.
 */
import { Store } from './store.js';
import { WallEditor } from './wall.js';
import { Panels } from './panels.js';
import { buildDemoProject } from './demo.js';
import { getModel, CHANNEL_KINDS } from './catalog.js';
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
  if (counts) counts.textContent = `устройств: ${s.counts.devices} · каналов: ${s.counts.channels} · шлейфов: ${s.counts.groups}`;
}

/* ================== уведомления / тосты ================== */
store.on((type, detail) => {
  if (type === 'toast') panels.toast(detail?.text || '');
});

/* ================== реакция на состояние ================== */
store.on((type) => {
  if (type === 'live') {
    editor.render();
    store.scheduleSave();
  } else if (type === 'all' || type === 'project') {
    editor.render();
    panels.renderFor(type);
    updateHistoryButtons();
    renderMenuWalls();
  } else if (type === 'selection') {
    editor.render();
    panels.renderFor('selection');
  } else if (type === 'wall') {
    editor.fit();
    panels.renderFor('wall');
    renderMenuWalls();
  } else if (type === 'tool') {
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
  group: () => {
    const ids = store.selectedDevices().map((d) => d.id);
    if (!ids.length) return panels.toast('Сначала выделите устройства на стене', true);
    panels.openGroupDialog(ids);
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

$('mobile-menu-btn')?.addEventListener('click', () => {
  if (bodyEl.classList.contains('sheet-menu')) closeSheets();
  else openSheet('menu');
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

$('chk-snap')?.addEventListener('change', (e) => {
  store.settings.snap = e.target.checked;
  panels.toast(store.settings.snap ? 'Привязка включена' : 'Привязка выключена');
});
$('chk-grid')?.addEventListener('change', (e) => {
  store.settings.showGrid = e.target.checked;
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
    panels.toast('Кабельный канал добавлен');
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
  } else if (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П') {
    actions.group();
  } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
    editor.fit();
  } else if (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М') {
    editor.cancelDraft();
    store.tool = 'select';
    store.emit('tool');
  } else if (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С') {
    editor.setTool('channel');
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
  editor._hint();
  requestAnimationFrame(() => {
    editor.fit();
    editor.render();
    if (!restored) panels.toast('Загружен демонстрационный проект — нажмите «Демо-проект», чтобы вернуть его позже');
  });
  console.info('[BolidGrid] готов:', {
    devices: store.project.devices.length,
    channels: store.project.channels.length,
    groups: store.project.groups.length,
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
