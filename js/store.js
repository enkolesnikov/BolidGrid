/**
 * store.js — состояние проекта, история изменений (undo/redo) и автосохранение.
 *
 * Проект целиком сериализуется в JSON: undo — это снимки проекта,
 * поэтому любые правки должны идти через begin()/commit() или act().
 */
import { getModel, MODELS, CHANNEL_KINDS, CHANNEL_KIND_IDS, terminalsForModel, CABLE_BY_ID, defaultCableForTerminals, SYSTEM_ORDER } from './catalog.js';
import { uid, polylineLength, clamp } from './util.js';

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export const LS_KEY = 'bolidgrid:project:v1';
export const SCHEMA_VERSION = 1;

/* ---------- пределы и умолчания (одно место вместо магических чисел) ---------- */
const WALL_MIN_SIZE = 500;
const WALL_MAX_WIDTH = 60000;
const WALL_MAX_HEIGHT = 20000;
// Импорт остаётся совместимым со старыми проектами: файл мог содержать стену до 100 × 30 м.
const IMPORT_MAX_WIDTH = 100000;
const IMPORT_MAX_HEIGHT = 30000;
const WALL_DEFAULT_WIDTH = 6000;
const WALL_DEFAULT_HEIGHT = 2700;
const HISTORY_LIMIT = 100;
const MAX_WALLS = 200;
const MAX_DEVICES = 5000;
const MAX_CHANNELS = 2000;
const MAX_DIMENSIONS = 5000;
const MAX_CONNECTIONS = 5000;
const MAX_CHANNEL_POINTS = 2000;
const LIMITS = {
  wallName: 120,
  meta: { name: 200, object: 600, address: 300, contractor: 200, doc: 200 },
  tag: 2000, // QA-контракт: длинные обозначения (400+ симв.) сохраняются
  address: 200,
  note: 300,
  dimensionText: 200,
  id: 80,
};
const LABEL_MODES = ['none', 'tag', 'full'];
const DEVICE_ROTATIONS = [0, 90, 180, 270];
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  grid: 50,
  snap: true,
  showGrid: true,
  labels: 'none',
  channelColor: '#94a3b8',
  selectionDims: true,
  smartSnap: true,
  showLegend: true,
});

/** Строка с ограничением длины; объекты и прочий мусор отбрасываются. */
function cleanText(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

/** Идентификатор из недоверенных данных: только строка/число, обрезка, безопасный charset. */
function cleanId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  // id попадает в HTML/SVG-атрибуты и CSS-селекторы: кавычки, `<`, `>`,
  // пробелы и прочие символы недопустимы (stored XSS через импорт).
  return value.trim().slice(0, LIMITS.id).replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Целая координата в миллиметрах, ограниченная [0, max]. */
function clampCoord(value, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? clamp(n, 0, Math.max(0, max)) : 0;
}

/** Размер стены: целые миллиметры в допустимом диапазоне, иначе прежнее/умолчание. */
function normalizeWallSize(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return clamp(n, min, max);
}

/**
 * Выдать уникальные id внутри коллекции. Первое вхождение сохраняет id,
 * повторы получают новый uid (объект не теряется).
 * Возвращает множество исходных id, которые встретились больше одного раза.
 */
function assignUniqueIds(items, prefix) {
  const used = new Set();
  const duplicated = new Set();
  for (const item of items) {
    let id = item.id;
    if (!id) id = uid(prefix);
    if (used.has(id)) {
      duplicated.add(id);
      do {
        id = uid(prefix);
      } while (used.has(id));
    }
    item.id = id;
    used.add(id);
  }
  return duplicated;
}

/** Настройки отображения из localStorage: только известные ключи и допустимые значения. */
export function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of ['snap', 'showGrid', 'selectionDims', 'smartSnap', 'showLegend']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  if (raw.grid !== undefined) {
    const grid = Math.round(Number(raw.grid));
    if (Number.isFinite(grid)) out.grid = clamp(grid, 1, 1000);
  }
  if (LABEL_MODES.includes(raw.labels)) out.labels = raw.labels;
  if (HEX_COLOR.test(String(raw.channelColor || ''))) out.channelColor = String(raw.channelColor);
  if (CHANNEL_KIND_IDS.includes(raw.channelKind)) out.channelKind = raw.channelKind;
  return out;
}

export function createProject(meta = {}) {
  return {
    version: SCHEMA_VERSION,
    meta: {
      name: 'ДФО .... СПС и СОУЭ',
      object: 'Комплекс ремонтно-строительных работ и оборудования нежилых помещений для временного размещения дополнительного офиса Банка',
      address: 'г. Елизово, ул. Ленина, д.15а',
      contractor: 'ООО «РитейлСтройСервис»',
      doc: 'ДФО .... СПС.СОУЭ',
      ...meta,
    },
    walls: [
      { id: uid('wall'), name: 'Стена 1 — пожарный пост', width: WALL_DEFAULT_WIDTH, height: WALL_DEFAULT_HEIGHT },
    ],
    devices: [],
    channels: [],
    dimensions: [],
    connections: [],
  };
}

export class Store {
  constructor() {
    this.project = createProject();
    this.spec = null;
    this.activeWallId = this.project.walls[0].id;
    this.selection = [];
    this.tool = 'select';
    this.armedModelId = null;
    this.placeSystem = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this._undo = [];
    this._redo = [];
    this._before = null;
    this._listeners = new Set();
    this._saveTimer = null;
  }

  /* ---------- подписка ---------- */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  emit(type = 'project', detail = {}) {
    for (const fn of this._listeners) {
      try {
        fn(type, detail);
      } catch (err) {
        console.error('[store] listener failed', err);
      }
    }
  }

  /* ---------- история ---------- */
  begin() {
    this._before = JSON.stringify(this.project);
  }
  /** Изменение без записи в историю (перетаскивание, живой ввод). */
  touch(type = 'project') {
    this.emit(type);
    this.scheduleSave();
  }
  commit(label = 'изменение') {
    if (this._before) {
      const after = JSON.stringify(this.project);
      if (after !== this._before) {
        this._undo.push({ label, state: this._before });
        if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
        this._redo.length = 0;
      }
      this._before = null;
    }
    this.emit('project');
    this.scheduleSave();
  }
  act(label, fn) {
    this.begin();
    try {
      fn(this);
    } finally {
      this.commit(label);
    }
  }
  get canUndo() {
    return this._undo.length > 0;
  }
  get canRedo() {
    return this._redo.length > 0;
  }
  /** Переставить снимок истории: текущее состояние уходит в обратный стек. */
  _restore(entry, target) {
    target.push({ label: entry.label, state: JSON.stringify(this.project) });
    this.project = JSON.parse(entry.state);
    this.ensureActiveWall();
    this.clearSelection();
    this.emit('all');
    this.scheduleSave();
    return true;
  }
  undo() {
    const entry = this._undo.pop();
    return entry ? this._restore(entry, this._redo) : false;
  }
  redo() {
    const entry = this._redo.pop();
    return entry ? this._restore(entry, this._undo) : false;
  }

  /* ---------- стены ---------- */
  get wall() {
    return this.project.walls.find((w) => w.id === this.activeWallId) || this.project.walls[0];
  }
  get wallIndex() {
    return Math.max(0, this.project.walls.findIndex((w) => w.id === this.activeWallId));
  }
  get wallDevices() {
    const id = this.wall?.id;
    return this.project.devices.filter((d) => d.wallId === id);
  }
  get wallChannels() {
    const id = this.wall?.id;
    return this.project.channels.filter((c) => c.wallId === id);
  }
  ensureActiveWall() {
    if (!this.project.walls.some((w) => w.id === this.activeWallId)) {
      this.activeWallId = this.project.walls[0]?.id ?? null;
    }
  }
  setActiveWall(id) {
    if (this.project.walls.some((w) => w.id === id)) {
      this.activeWallId = id;
      this.clearSelection();
      this.emit('wall');
    }
  }
  addWall({ name = null, width = WALL_DEFAULT_WIDTH, height = WALL_DEFAULT_HEIGHT } = {}) {
    let wall;
    this.act('добавление стены', () => {
      wall = {
        id: uid('wall'),
        name: cleanText(name, LIMITS.wallName) || `Стена ${this.project.walls.length + 1}`,
        width: normalizeWallSize(width, WALL_MIN_SIZE, WALL_MAX_WIDTH, WALL_DEFAULT_WIDTH),
        height: normalizeWallSize(height, WALL_MIN_SIZE, WALL_MAX_HEIGHT, WALL_DEFAULT_HEIGHT),
      };
      this.project.walls.push(wall);
      this.activeWallId = wall.id;
      this.clearSelection();
    });
    this.emit('wall');
    return wall;
  }
  /** Зажать содержимое стены в её новые границы (приборы, трассы и размеры). */
  _clampWallContent(wallId, wall) {
    for (const d of this.project.devices.filter((d) => d.wallId === wallId)) {
      const m = getModel(d.modelId);
      d.x = clampCoord(d.x, wall.width - m.w);
      d.y = clampCoord(d.y, wall.height - m.h);
    }
    for (const c of this.project.channels.filter((c) => c.wallId === wallId)) {
      if (Array.isArray(c.points)) c.points = c.points.map(([x, y]) => [clampCoord(x, wall.width), clampCoord(y, wall.height)]);
    }
    for (const d of (this.project.dimensions || []).filter((d) => d.wallId === wallId)) {
      if (Array.isArray(d.a)) d.a = [clampCoord(d.a[0], wall.width), clampCoord(d.a[1], wall.height)];
      if (Array.isArray(d.b)) d.b = [clampCoord(d.b[0], wall.width), clampCoord(d.b[1], wall.height)];
    }
  }
  updateWall(id, patch) {
    this.act('изменение стены', () => {
      const w = this.project.walls.find((x) => x.id === id);
      if (!w || !patch || typeof patch !== 'object') return;
      if (patch.name !== undefined) w.name = cleanText(patch.name, LIMITS.wallName) || w.name;
      const nextWidth = patch.width !== undefined ? normalizeWallSize(patch.width, WALL_MIN_SIZE, WALL_MAX_WIDTH, w.width) : w.width;
      const nextHeight = patch.height !== undefined ? normalizeWallSize(patch.height, WALL_MIN_SIZE, WALL_MAX_HEIGHT, w.height) : w.height;
      const sizeChanged = nextWidth !== w.width || nextHeight !== w.height;
      w.width = nextWidth;
      w.height = nextHeight;
      w.id = id; // id стены не меняется патчем
      // Устройства, трассы и размеры не должны оказаться за пределами стены.
      // Переименование большой импортированной стены не должно её ужимать.
      if (sizeChanged) this._clampWallContent(id, w);
    });
    this.emit('wall');
  }
  removeWall(id) {
    if (this.project.walls.length <= 1) return false;
    this.act('удаление стены', () => {
      this.project.walls = this.project.walls.filter((w) => w.id !== id);
      this.project.devices = this.project.devices.filter((d) => d.wallId !== id);
      this.project.channels = this.project.channels.filter((c) => c.wallId !== id);
      this.project.dimensions = (this.project.dimensions || []).filter((d) => d.wallId !== id);
      this.project.connections = (this.project.connections || []).filter((c) => c.wallId !== id);
      this.ensureActiveWall();
      this.clearSelection();
    });
    this.emit('wall');
    return true;
  }

  /* ---------- выбор ---------- */
  get selectionItems() {
    return this.selection.slice();
  }
  isSelected(type, id) {
    return this.selection.some((s) => s.type === type && s.id === id);
  }
  select(items, additive = false) {
    const next = additive ? this.selection.slice() : [];
    for (const it of items) {
      const exists = next.some((s) => s.type === it.type && s.id === it.id);
      if (exists && additive) continue;
      if (!exists) next.push({ type: it.type, id: it.id });
    }
    this.selection = next;
    this.emit('selection');
  }
  toggleSelect(item) {
    if (this.isSelected(item.type, item.id)) {
      this.selection = this.selection.filter((s) => !(s.type === item.type && s.id === item.id));
    } else {
      this.selection = [...this.selection, item];
    }
    this.emit('selection');
  }
  selectOne(type, id) {
    this.selection = id ? [{ type, id }] : [];
    this.emit('selection');
  }
  clearSelection() {
    if (!this.selection.length) return;
    this.selection = [];
    this.emit('selection');
  }
  selectedDevices() {
    return this.selection
      .filter((s) => s.type === 'device')
      .map((s) => this.project.devices.find((d) => d.id === s.id))
      .filter(Boolean);
  }
  selectedChannels() {
    return this.selection
      .filter((s) => s.type === 'channel')
      .map((s) => this.project.channels.find((c) => c.id === s.id))
      .filter(Boolean);
  }
  selectedDimensions() {
    return this.selection
      .filter((s) => s.type === 'dimension')
      .map((s) => this.project.dimensions.find((d) => d.id === s.id))
      .filter(Boolean);
  }
  selectedConnections() {
    return this.selection
      .filter((s) => s.type === 'connection')
      .map((s) => this.getConnection(s.id))
      .filter(Boolean);
  }
  getConnection(id) {
    return (this.project.connections || []).find((c) => c.id === id);
  }
  get wallConnections() {
    const id = this.wall?.id;
    return (this.project.connections || []).filter((c) => c.wallId === id);
  }

  /* ---------- устройства ---------- */
  getDevice(id) {
    return this.project.devices.find((d) => d.id === id);
  }
  getChannel(id) {
    return this.project.channels.find((c) => c.id === id);
  }
  nextTag(wallId = this.activeWallId) {
    const wallNo = Math.max(1, this.project.walls.findIndex((w) => w.id === wallId) + 1);
    // если на стене уже есть обозначения — продолжаем их нумерацию, а не нумерацию по индексу
    const byPrefix = new Map();
    for (const d of this.project.devices.filter((d) => d.wallId === wallId)) {
      const mm = /^(\d+)\.(\d+)/.exec(d.tag || '');
      if (!mm) continue;
      const prefix = +mm[1];
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(+mm[2]);
    }
    if (byPrefix.size) {
      const [prefix, nums] = [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
      return `${prefix}.${Math.max(...nums) + 1}`;
    }
    return `${wallNo}.1`;
  }
  /** Добавить устройство; координаты — левый нижний угол габарита, мм от пола. */
  addDevice(modelId, x, y, patch = {}) {
    const model = getModel(modelId);
    let dev;
    this.act('добавление устройства', () => {
      const wall = this.wall;
      dev = {
        modelId: model.id,
        wallId: wall.id,
        x: 0,
        y: 0,
        rot: 0,
        tag: this.nextTag(wall.id),
        address: '',
        note: '',
        system: patch.system || this.placeSystem || model.system || 'other',
        ...patch,
      };
      // служебные поля и геометрия важнее переданного patch
      dev.id = uid('dev');
      dev.modelId = model.id;
      dev.wallId = wall.id;
      dev.x = clampCoord(x, wall.width - model.w);
      dev.y = clampCoord(y, wall.height - model.h);
      dev.rot = DEVICE_ROTATIONS.includes(+dev.rot) ? +dev.rot : 0;
      dev.system = SYSTEM_ORDER.includes(String(dev.system)) ? String(dev.system) : (model.system || 'other');
      dev.tag = cleanText(dev.tag, LIMITS.tag);
      dev.address = cleanText(dev.address, LIMITS.address);
      dev.note = cleanText(dev.note, LIMITS.note);
      this.project.devices.push(dev);
      this.selection = [{ type: 'device', id: dev.id }];
    });
    this.emit('selection');
    return dev;
  }
  updateDevice(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const d = this.getDevice(id);
      if (!d || !patch || typeof patch !== 'object') return;
      const prev = { id: d.id, wallId: d.wallId, modelId: d.modelId };
      Object.assign(d, patch);
      d.id = prev.id;
      d.wallId = prev.wallId;
      if (!MODELS_BY_ID.has(String(d.modelId))) d.modelId = prev.modelId;
      const m = getModel(d.modelId);
      const wall = this.project.walls.find((w) => w.id === d.wallId) || this.wall;
      d.x = clampCoord(d.x, wall.width - m.w);
      d.y = clampCoord(d.y, wall.height - m.h);
      d.rot = DEVICE_ROTATIONS.includes(+d.rot) ? +d.rot : 0;
      d.system = SYSTEM_ORDER.includes(String(d.system)) ? String(d.system) : (m.system || 'other');
      d.tag = cleanText(d.tag, LIMITS.tag);
      d.address = cleanText(d.address, LIMITS.address);
      d.note = cleanText(d.note, LIMITS.note);
    };
    if (commit) this.act('изменение устройства', doIt);
    else {
      doIt();
      this.touch();
    }
  }
  duplicateDevices(ids = this.selectedDevices().map((d) => d.id)) {
    const created = [];
    this.act('копирование устройств', () => {
      for (const id of ids) {
        const d = this.getDevice(id);
        if (!d) continue;
        const copy = {
          ...JSON.parse(JSON.stringify(d)),
          id: uid('dev'),
          x: d.x + 150,
          y: d.y - 150,
          tag: this.nextTag(d.wallId),
        };
        const model = getModel(copy.modelId);
        const wall = this.project.walls.find((w) => w.id === copy.wallId) || this.wall;
        // У края стены пробуем сместить копию в противоположную сторону,
        // чтобы она не легла ровно на оригинал.
        if (copy.x + model.w > wall.width) copy.x = d.x - 150;
        if (copy.y < 0) copy.y = d.y + 150;
        copy.x = clampCoord(copy.x, wall.width - model.w);
        copy.y = clampCoord(copy.y, wall.height - model.h);
        this.project.devices.push(copy);
        created.push(copy);
      }
      this.selection = created.map((c) => ({ type: 'device', id: c.id }));
    });
    this.emit('selection');
    return created;
  }
  /** Выровнять приборы друг относительно друга; один прибор — относительно стены. */
  alignDevices(mode) {
    const devices = this.selectedDevices().filter((d) => d.wallId === this.activeWallId);
    if (!devices.length) return false;
    const rect = (d) => {
      const m0 = getModel(d.modelId);
      return { d, l: d.x, r: d.x + m0.w, b: d.y, t: d.y + m0.h, cx: d.x + m0.w / 2, cy: d.y + m0.h / 2, w: m0.w, h: m0.h };
    };
    const items = devices.map(rect);
    const wall = this.wall;
    const bounds = devices.length === 1
      ? { l: 0, r: wall.width, b: 0, t: wall.height, cx: wall.width / 2, cy: wall.height / 2 }
      : {
          l: Math.min(...items.map((r) => r.l)), r: Math.max(...items.map((r) => r.r)),
          b: Math.min(...items.map((r) => r.b)), t: Math.max(...items.map((r) => r.t)),
          cx: (Math.min(...items.map((r) => r.l)) + Math.max(...items.map((r) => r.r))) / 2,
          cy: (Math.min(...items.map((r) => r.b)) + Math.max(...items.map((r) => r.t))) / 2,
        };
    this.act('выравнивание приборов', () => {
      if (mode === 'distribute-x' && items.length >= 3) {
        const sorted = items.slice().sort((a, b) => a.cx - b.cx);
        const first = sorted[0].cx;
        const last = sorted[sorted.length - 1].cx;
        sorted.forEach((r, i) => { r.d.x = Math.round(first + ((last - first) * i) / (sorted.length - 1) - r.w / 2); });
      } else if (mode === 'distribute-y' && items.length >= 3) {
        const sorted = items.slice().sort((a, b) => a.cy - b.cy);
        const first = sorted[0].cy;
        const last = sorted[sorted.length - 1].cy;
        sorted.forEach((r, i) => { r.d.y = Math.round(first + ((last - first) * i) / (sorted.length - 1) - r.h / 2); });
      } else {
        for (const r of items) {
          if (mode === 'left') r.d.x = bounds.l;
          else if (mode === 'right') r.d.x = bounds.r - r.w;
          else if (mode === 'center-x') r.d.x = Math.round(bounds.cx - r.w / 2);
          else if (mode === 'bottom') r.d.y = bounds.b;
          else if (mode === 'top') r.d.y = bounds.t - r.h;
          else if (mode === 'center-y') r.d.y = Math.round(bounds.cy - r.h / 2);
        }
      }
      for (const d of devices) {
        const m0 = getModel(d.modelId);
        d.x = clamp(Math.round(d.x), 0, Math.max(0, wall.width - m0.w));
        d.y = clamp(Math.round(d.y), 0, Math.max(0, wall.height - m0.h));
      }
    });
    return true;
  }

  nudgeDevices(dx, dy) {
    const devices = this.selectedDevices();
    if (!devices.length) return false;
    this.act('точное перемещение', () => {
      for (const d of devices) {
        const m0 = getModel(d.modelId);
        const wall = this.project.walls.find((w) => w.id === d.wallId) || this.wall;
        d.x = clamp(Math.round(d.x + dx), 0, Math.max(0, wall.width - m0.w));
        d.y = clamp(Math.round(d.y + dy), 0, Math.max(0, wall.height - m0.h));
      }
    });
    return true;
  }

  /** Установить одинаковый свободный зазор между приборами, сохранив первый на месте. */
  setDeviceGap(axis, gap) {
    const devices = this.selectedDevices().filter((d) => d.wallId === this.activeWallId);
    const value = Math.round(Number(gap));
    if (devices.length < 2 || !['x', 'y'].includes(axis) || !Number.isFinite(value) || value < 0) return false;
    const horizontal = axis === 'x';
    const items = devices.map((d) => {
      const model = getModel(d.modelId);
      return { d, model, start: horizontal ? d.x : d.y, size: horizontal ? model.w : model.h };
    }).sort((a, b) => a.start - b.start);
    let cursor = items[0].start;
    const targets = items.map((item, index) => {
      if (index) cursor += items[index - 1].size + value;
      return { item, position: cursor };
    });
    const wallSize = horizontal ? this.wall.width : this.wall.height;
    const end = targets[targets.length - 1];
    if (end.position + end.item.size > wallSize) return false;
    this.act('точный зазор между приборами', () => {
      for (const { item, position } of targets) item.d[axis] = Math.round(position);
    });
    return true;
  }

  /** Найти реальные пересечения габаритов приборов и полос коробов на активной стене. */
  findPlacementIssues(wallId = this.activeWallId) {
    const devices = this.project.devices.filter((d) => d.wallId === wallId);
    const channels = this.project.channels.filter((c) => c.wallId === wallId);
    const rects = new Map(devices.map((d) => {
      const model = getModel(d.modelId);
      return [d.id, { l: d.x, r: d.x + model.w, b: d.y, t: d.y + model.h }];
    }));
    const overlaps = (a, b) => Math.max(a.l, b.l) < Math.min(a.r, b.r) && Math.max(a.b, b.b) < Math.min(a.t, b.t);
    const issues = [];
    for (let i = 0; i < devices.length; i++) {
      for (let j = i + 1; j < devices.length; j++) {
        const a = devices[i];
        const b = devices[j];
        if (!overlaps(rects.get(a.id), rects.get(b.id))) continue;
        issues.push({
          id: `devices:${a.id}:${b.id}`,
          type: 'device-device',
          wallId,
          deviceIds: [a.id, b.id],
          channelId: null,
          message: `${a.tag || a.id} пересекается с ${b.tag || b.id}`,
        });
      }
    }
    for (const d of devices) {
      const rect = rects.get(d.id);
      for (const c of channels) {
        const half = (c.width || 40) / 2;
        const hit = (c.points || []).slice(1).some((p, i) => {
          const a = c.points[i];
          const band = {
            l: Math.min(a[0], p[0]) - half,
            r: Math.max(a[0], p[0]) + half,
            b: Math.min(a[1], p[1]) - half,
            t: Math.max(a[1], p[1]) + half,
          };
          return overlaps(rect, band);
        });
        if (!hit) continue;
        issues.push({
          id: `channel:${d.id}:${c.id}`,
          type: 'device-channel',
          wallId,
          deviceIds: [d.id],
          channelId: c.id,
          message: `${d.tag || d.id} пересекается с коробом`,
        });
      }
    }
    return issues;
  }

  /** Добавить постоянные размеры «слева» и «от пола» для выбранного прибора. */
  addDeviceDimensions(id) {
    const d = this.getDevice(id);
    if (!d) return 0;
    const m0 = getModel(d.modelId);
    let count = 0;
    this.act('размеры положения прибора', () => {
      if (!Array.isArray(this.project.dimensions)) this.project.dimensions = [];
      if (d.x > 0) {
        this.project.dimensions.push({ id: uid('dim'), wallId: d.wallId, a: [0, d.y], b: [d.x, d.y], text: '', offset: -55 });
        count++;
      }
      if (d.y > 0) {
        this.project.dimensions.push({ id: uid('dim'), wallId: d.wallId, a: [d.x, 0], b: [d.x, d.y], text: '', offset: -55 });
        count++;
      }
    });
    return count;
  }

  removeSelection() {
    if (!this.selection.length) return 0;
    const removed = this.selection.length;
    this.act('удаление', () => {
      const devIds = new Set(this.selection.filter((s) => s.type === 'device').map((s) => s.id));
      const chIds = new Set(this.selection.filter((s) => s.type === 'channel').map((s) => s.id));
      const dimIds = new Set(this.selection.filter((s) => s.type === 'dimension').map((s) => s.id));
      const connIds = new Set(this.selection.filter((s) => s.type === 'connection').map((s) => s.id));
      this.project.devices = this.project.devices.filter((d) => !devIds.has(d.id));
      this.project.channels = this.project.channels.filter((c) => !chIds.has(c.id));
      this.project.dimensions = (this.project.dimensions || []).filter((d) => !dimIds.has(d.id));
      this.project.connections = (this.project.connections || []).filter(
        (c) => !connIds.has(c.id) && !devIds.has(c.from?.deviceId) && !devIds.has(c.to?.deviceId),
      );
      this.clearSelection();
    });
    return removed;
  }

  /* ---------- короба ---------- */
  addChannel(points, { kind = 'dkc', wallId = this.activeWallId, width = null, color = '', label = '' } = {}) {
    const def = CHANNEL_KINDS.find((k) => k.id === kind) || CHANNEL_KINDS[0];
    const wall = this.project.walls.find((w) => w.id === wallId) || this.wall;
    let ch;
    this.act('добавление короба', () => {
      ch = {
        id: uid('ch'),
        wallId,
        kind: def.id,
        width: width ?? def.width,
        points: points.map(([x, y]) => [clampCoord(x, wall.width), clampCoord(y, wall.height)]),
        color: color || this.settings.channelColor || '',
      };
      this.project.channels.push(ch);
      this.selection = [{ type: 'channel', id: ch.id }];
    });
    this.emit('selection');
    this.emit('channel-added', { id: ch.id });
    return ch;
  }
  updateChannel(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const c = this.getChannel(id);
      if (!c || !patch || typeof patch !== 'object') return;
      if (patch.points !== undefined) {
        const wall = this.project.walls.find((w) => w.id === c.wallId) || this.wall;
        if (!Array.isArray(patch.points) || patch.points.length < 2) return;
        c.points = patch.points.map(([x, y]) => [clampCoord(x, wall.width), clampCoord(y, wall.height)]);
      }
      if (patch.width !== undefined) c.width = clamp(Math.round(Number(patch.width) || c.width), 5, 600);
      if (patch.color !== undefined) c.color = HEX_COLOR.test(String(patch.color || '')) ? String(patch.color) : '';
      if (patch.kind !== undefined && CHANNEL_KIND_IDS.includes(patch.kind)) c.kind = patch.kind;
    };
    if (commit) this.act('изменение канала', doIt);
    else {
      doIt();
      this.touch();
    }
  }

  /* ---------- соединения приборов (клеммы + кабели) ---------- */
  addConnection(from, to, cableModelId = null) {
    const a = this.getDevice(from?.deviceId);
    const b = this.getDevice(to?.deviceId);
    if (!a || !b) return null;
    if (a.id === b.id) return null;
    if (a.wallId !== b.wallId) return null;
    const ta = terminalsForModel(getModel(a.modelId)).find((t) => t.id === from.terminalId);
    const tb = terminalsForModel(getModel(b.modelId)).find((t) => t.id === to.terminalId);
    if (!ta || !tb) return null;
    const exists = (this.project.connections || []).some(
      (c) => (c.from.deviceId === a.id && c.from.terminalId === ta.id && c.to.deviceId === b.id && c.to.terminalId === tb.id)
        || (c.from.deviceId === b.id && c.from.terminalId === tb.id && c.to.deviceId === a.id && c.to.terminalId === ta.id),
    );
    if (exists) return null;
    const cable = cableModelId ?? defaultCableForTerminals(ta, tb);
    const conn = {
      id: uid('conn'),
      wallId: a.wallId,
      from: { deviceId: a.id, terminalId: ta.id },
      to: { deviceId: b.id, terminalId: tb.id },
      cableModelId: cable && CABLE_BY_ID.has(cable) ? cable : '',
    };
    this.act('соединение приборов', () => {
      if (!Array.isArray(this.project.connections)) this.project.connections = [];
      this.project.connections.push(conn);
      this.selection = [{ type: 'connection', id: conn.id }];
    });
    this.emit('selection');
    return conn;
  }
  updateConnection(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const c = this.getConnection(id);
      if (!c) return;
      if (patch.cableModelId !== undefined) {
        c.cableModelId = CABLE_BY_ID.has(patch.cableModelId) ? patch.cableModelId : '';
      }
    };
    if (commit) this.act('изменение кабеля', doIt);
    else {
      doIt();
      this.touch();
    }
  }
  removeConnection(id) {
    this.act('удаление кабеля', () => {
      this.project.connections = (this.project.connections || []).filter((c) => c.id !== id);
      this.clearSelection();
    });
    return true;
  }

  /* ---------- размерные линии ---------- */
  getDimension(id) {
    return (this.project.dimensions || []).find((d) => d.id === id);
  }
  addDimension(a, b, { wallId = this.activeWallId, text = '', offset = 60 } = {}) {
    let dim;
    this.act('размерная линия', () => {
      dim = {
        id: uid('dim'),
        wallId,
        a: [Math.round(a[0]), Math.round(a[1])],
        b: [Math.round(b[0]), Math.round(b[1])],
        text: text || '',
        offset,
      };
      if (!Array.isArray(this.project.dimensions)) this.project.dimensions = [];
      this.project.dimensions.push(dim);
      this.selection = [{ type: 'dimension', id: dim.id }];
    });
    this.emit('selection');
    return dim;
  }
  updateDimension(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const d = this.getDimension(id);
      if (!d || !patch || typeof patch !== 'object') return;
      const wall = this.project.walls.find((w) => w.id === d.wallId) || this.wall;
      if (patch.a !== undefined && Array.isArray(patch.a)) d.a = [clampCoord(patch.a[0], wall.width), clampCoord(patch.a[1], wall.height)];
      if (patch.b !== undefined && Array.isArray(patch.b)) d.b = [clampCoord(patch.b[0], wall.width), clampCoord(patch.b[1], wall.height)];
      if (patch.text !== undefined) d.text = cleanText(patch.text, LIMITS.dimensionText);
      if (patch.offset !== undefined) d.offset = clamp(Math.round(Number(patch.offset) || 0), -600, 600);
    };
    if (commit) this.act('изменение размера', doIt);
    else {
      doIt();
      this.emit('live');
    }
  }

  /* ---------- вычисления ---------- */
  channelLength(ch) {
    return polylineLength(ch.points || []);
  }

  /* ---------- спецификация ---------- */
  setSpec(spec) {
    this.spec = spec || null;
    this.emit('spec');
  }
  placedCountBySpecPos() {
    const counts = new Map();
    for (const d of this.project.devices) {
      const m = getModel(d.modelId);
      if (m.specPos == null) continue;
      counts.set(m.specPos, (counts.get(m.specPos) || 0) + 1);
    }
    return counts;
  }
  placedCountByModel() {
    const counts = new Map();
    for (const d of this.project.devices) {
      counts.set(d.modelId, (counts.get(d.modelId) || 0) + 1);
    }
    return counts;
  }

  /* ---------- сохранение ---------- */
  serialize() {
    return JSON.stringify({ app: 'BolidGrid', schema: SCHEMA_VERSION, project: this.project }, null, 2);
  }
  scheduleSave() {
    clearTimeout(this._saveTimer);
    this.emit('saving');
    this._saveTimer = setTimeout(() => this.save(), 500);
  }
  save() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          schema: SCHEMA_VERSION,
          savedAt: new Date().toISOString(),
          project: this.project,
          activeWallId: this.activeWallId,
          settings: this.settings,
        })
      );
      this.emit('saved', { at: Date.now() });
      return true;
    } catch (err) {
      console.warn('[store] не удалось сохранить проект', err);
      this.emit('save-error', { message: String(err?.message || err) });
      return false;
    }
  }
  loadSaved() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.project || typeof data.project !== 'object') return false;
      const schema = Number(data.schema);
      if (Number.isFinite(schema) && schema > SCHEMA_VERSION) {
        console.warn(`[store] сохранение схемы ${schema} новее поддерживаемой ${SCHEMA_VERSION}; загружаем известные поля`);
      }
      // настройки — до replaceProject, чтобы первый же рендер увидел валидные значения
      this.settings = sanitizeSettings(data.settings, this.settings);
      this.replaceProject(data.project, { activeWallId: data.activeWallId });
      return true;
    } catch (err) {
      console.warn('[store] не удалось загрузить проект', err);
      return false;
    }
  }
  replaceProject(project, { activeWallId = null } = {}) {
    this.project = sanitizeProject(project);
    const wanted = cleanId(activeWallId);
    this.activeWallId = wanted && this.project.walls.some((w) => w.id === wanted) ? wanted : this.project.walls[0].id;
    this.selection = [];
    this._undo = [];
    this._redo = [];
    this.emit('all');
    this.scheduleSave();
  }
  clearAll() {
    this.replaceProject(createProject({ ...this.project.meta }));
  }
}

/** Привести ломаную короба к горизонтальным/вертикальным сегментам. */
function orthoPoints(points) {
  const pts = points.slice(0, MAX_CHANNEL_POINTS).map((p) => {
    const x = Math.round(Number(p?.[0]));
    const y = Math.round(Number(p?.[1]));
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0];
  });
  if (!pts.length) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = out[out.length - 1];
    let [x, y] = pts[i];
    if (x === px && y === py) continue;
    if (Math.abs(x - px) >= Math.abs(y - py)) y = py;
    else x = px;
    out.push([x, y]);
  }
  return out;
}

/** Только известные поля meta, каждый — строкой с ограничением длины. */
function sanitizeMeta(raw, base) {
  const meta = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return meta;
  for (const [key, max] of Object.entries(LIMITS.meta)) {
    const value = raw[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      meta[key] = cleanText(value, max);
    }
  }
  return meta;
}

/** Проверка/починка проекта из localStorage/файла. */
export function sanitizeProject(raw) {
  const base = createProject();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  // --- стены: id уникальны, повторы получают новый id (объект остаётся) ---
  let walls = (Array.isArray(raw.walls) ? raw.walls : [])
    .slice(0, MAX_WALLS)
    .filter((w) => w && typeof w === 'object' && !Array.isArray(w))
    .map((w, i) => ({
      id: cleanId(w.id),
      name: cleanText(w.name, LIMITS.wallName) || `Стена ${i + 1}`,
      width: normalizeWallSize(w.width, WALL_MIN_SIZE, IMPORT_MAX_WIDTH, WALL_DEFAULT_WIDTH),
      height: normalizeWallSize(w.height, WALL_MIN_SIZE, IMPORT_MAX_HEIGHT, WALL_DEFAULT_HEIGHT),
    }));
  if (!walls.length) walls = base.walls;
  assignUniqueIds(walls, 'wall');
  const wallIds = new Set(walls.map((w) => w.id));
  const wallById = new Map(walls.map((w) => [w.id, w]));

  // --- приборы: только стены проекта, уникальные id, координаты в габаритах стены ---
  const devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .slice(0, MAX_DEVICES)
    .filter((d) => d && typeof d === 'object' && !Array.isArray(d) && wallIds.has(cleanId(d.wallId)))
    .map((d) => {
      const wallId = cleanId(d.wallId);
      const model = getModel(cleanId(d.modelId));
      const wall = wallById.get(wallId);
      return {
        id: cleanId(d.id),
        modelId: model.id,
        wallId,
        x: clampCoord(d.x, wall.width - model.w),
        y: clampCoord(d.y, wall.height - model.h),
        rot: DEVICE_ROTATIONS.includes(+d.rot) ? +d.rot : 0,
        system: SYSTEM_ORDER.includes(String(d.system)) ? String(d.system) : (model.system || 'other'),
        tag: cleanText(d.tag, LIMITS.tag),
        address: cleanText(d.address, LIMITS.address),
        note: cleanText(d.note, LIMITS.note),
      };
    })
    // скрытые модели (АКБ, МПН, Маяк, таблички, КМ-О и т.п.) не переносим
    .filter((d) => !MODELS_BY_ID.get(d.modelId)?.hidden);
  const duplicateDeviceIds = assignUniqueIds(devices, 'dev');

  // --- короба: стена существует, точки ограничены стеной, id уникальны ---
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .slice(0, MAX_CHANNELS)
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c)
      && wallIds.has(cleanId(c.wallId)) && Array.isArray(c.points) && c.points.length >= 2)
    .map((c) => {
      // Старые проекты использовали id «кабель-канал»; кабельные поля больше не переносим.
      const kind = c.kind === 'кабель-канал' ? 'dkc' : c.kind;
      const wallId = cleanId(c.wallId);
      const wall = wallById.get(wallId);
      const width = Math.round(Number(c.width));
      return {
        id: cleanId(c.id),
        wallId,
        kind: CHANNEL_KIND_IDS.includes(kind) ? kind : CHANNEL_KIND_IDS[0],
        width: Number.isFinite(width) && width > 0 ? clamp(width, 5, 600) : 100,
        color: HEX_COLOR.test(String(c.color || '')) ? String(c.color) : '',
        points: orthoPoints(c.points).map(([x, y]) => [clampCoord(x, wall.width), clampCoord(y, wall.height)]),
      };
    })
    .filter((c) => c.points.length >= 2);
  assignUniqueIds(channels, 'ch');

  // --- размеры: концы в стене, id уникальны ---
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : [])
    .slice(0, MAX_DIMENSIONS)
    .filter((d) => d && typeof d === 'object' && !Array.isArray(d)
      && wallIds.has(cleanId(d.wallId)) && Array.isArray(d.a) && Array.isArray(d.b))
    .map((d) => {
      const wallId = cleanId(d.wallId);
      const wall = wallById.get(wallId);
      const offset = Number(d.offset);
      return {
        id: cleanId(d.id),
        wallId,
        a: [clampCoord(d.a[0], wall.width), clampCoord(d.a[1], wall.height)],
        b: [clampCoord(d.b[0], wall.width), clampCoord(d.b[1], wall.height)],
        text: cleanText(d.text, LIMITS.dimensionText),
        offset: Number.isFinite(offset) ? clamp(Math.round(offset), -600, 600) : 60,
      };
    });
  assignUniqueIds(dimensions, 'dim');

  // --- связи по клеммам: только на сохранённые приборы одной стены и с существующими клеммами ---
  const devById = new Map(devices.map((d) => [d.id, d]));
  const terminalsOf = (dev) => {
    const list = terminalsForModel(getModel(dev.modelId));
    return new Map(list.map((t) => [t.id, t]));
  };
  const connections = (Array.isArray(raw.connections) ? raw.connections : [])
    .slice(0, MAX_CONNECTIONS)
    .map((c) => {
      const fromId = cleanId(c?.from?.deviceId);
      const toId = cleanId(c?.to?.deviceId);
      // повтор id прибора делает связь неоднозначной — такую связь не переносим
      if (duplicateDeviceIds.has(fromId) || duplicateDeviceIds.has(toId)) return null;
      const from = devById.get(fromId);
      const to = devById.get(toId);
      if (!from || !to || from.id === to.id || from.wallId !== to.wallId) return null;
      const terminalFrom = cleanId(c.from.terminalId);
      const terminalTo = cleanId(c.to.terminalId);
      if (!terminalsOf(from).has(terminalFrom) || !terminalsOf(to).has(terminalTo)) return null;
      const cable = CABLE_BY_ID.has(cleanId(c.cableModelId)) ? cleanId(c.cableModelId) : '';
      return {
        id: cleanId(c.id),
        wallId: from.wallId,
        from: { deviceId: from.id, terminalId: terminalFrom },
        to: { deviceId: to.id, terminalId: terminalTo },
        cableModelId: cable,
      };
    })
    .filter(Boolean);
  assignUniqueIds(connections, 'conn');

  return {
    version: SCHEMA_VERSION,
    meta: sanitizeMeta(raw.meta, base.meta),
    walls,
    devices,
    channels,
    dimensions,
    connections,
  };
}
