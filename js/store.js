/**
 * store.js — состояние проекта, история изменений (undo/redo) и автосохранение.
 *
 * Проект целиком сериализуется в JSON: undo — это снимки проекта,
 * поэтому любые правки должны идти через begin()/commit() или act().
 */
import { getModel, CHANNEL_KINDS, CHANNEL_KIND_IDS } from './catalog.js';
import { uid, closestOnPolyline, polylineLength, clamp } from './util.js';

export const LS_KEY = 'bolidgrid:project:v1';
export const SCHEMA_VERSION = 1;

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
      { id: uid('wall'), name: 'Стена 1 — пожарный пост', width: 6000, height: 2700 },
    ],
    devices: [],
    channels: [],
    dimensions: [],
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
    this.settings = { grid: 50, snap: true, showGrid: true, labels: 'none' };
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
        if (this._undo.length > 100) this._undo.shift();
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
  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this._redo.push({ label: entry.label, state: JSON.stringify(this.project) });
    this.project = JSON.parse(entry.state);
    this.ensureActiveWall();
    this.clearSelection();
    this.emit('all');
    this.scheduleSave();
    return true;
  }
  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._undo.push({ label: entry.label, state: JSON.stringify(this.project) });
    this.project = JSON.parse(entry.state);
    this.ensureActiveWall();
    this.clearSelection();
    this.emit('all');
    this.scheduleSave();
    return true;
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
  addWall({ name = null, width = 6000, height = 2700 } = {}) {
    let wall;
    this.act('добавление стены', () => {
      wall = {
        id: uid('wall'),
        name: name || `Стена ${this.project.walls.length + 1}`,
        width,
        height,
      };
      this.project.walls.push(wall);
      this.activeWallId = wall.id;
      this.clearSelection();
    });
    this.emit('wall');
    return wall;
  }
  updateWall(id, patch) {
    this.act('изменение стены', () => {
      const w = this.project.walls.find((x) => x.id === id);
      if (!w) return;
      Object.assign(w, patch);
      w.width = clamp(+w.width || 1000, 500, 60000);
      w.height = clamp(+w.height || 1000, 500, 20000);
      // устройства не должны оказаться за пределами стены
      for (const d of this.project.devices.filter((d) => d.wallId === id)) {
        const m = getModel(d.modelId);
        d.x = clamp(d.x, 0, w.width - m.w);
        d.y = clamp(d.y, 0, w.height - m.h);
      }
      for (const c of this.project.channels.filter((c) => c.wallId === id)) {
        c.points = c.points.map(([x, y]) => [clamp(x, 0, w.width), clamp(y, 0, w.height)]);
      }
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
        id: uid('dev'),
        modelId: model.id,
        wallId: wall.id,
        x: Math.round(clamp(x, 0, wall.width - model.w)),
        y: Math.round(clamp(y, 0, wall.height - model.h)),
        rot: 0,
        tag: this.nextTag(wall.id),
        address: '',
        note: '',
        ...patch,
      };
      this.project.devices.push(dev);
      this.selection = [{ type: 'device', id: dev.id }];
    });
    this.emit('selection');
    return dev;
  }
  updateDevice(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const d = this.getDevice(id);
      if (!d) return;
      Object.assign(d, patch);
      const m = getModel(d.modelId);
      const wall = this.project.walls.find((w) => w.id === d.wallId) || this.wall;
      d.x = clamp(+d.x || 0, 0, wall.width - m.w);
      d.y = clamp(+d.y || 0, 0, wall.height - m.h);
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
        this.project.devices.push(copy);
        created.push(copy);
      }
      this.selection = created.map((c) => ({ type: 'device', id: c.id }));
    });
    this.emit('selection');
    return created;
  }
  removeSelection() {
    if (!this.selection.length) return 0;
    const removed = this.selection.length;
    this.act('удаление', () => {
      const devIds = new Set(this.selection.filter((s) => s.type === 'device').map((s) => s.id));
      const chIds = new Set(this.selection.filter((s) => s.type === 'channel').map((s) => s.id));
      const dimIds = new Set(this.selection.filter((s) => s.type === 'dimension').map((s) => s.id));
      this.project.devices = this.project.devices.filter((d) => !devIds.has(d.id));
      this.project.channels = this.project.channels.filter((c) => !chIds.has(c.id));
      this.project.dimensions = (this.project.dimensions || []).filter((d) => !dimIds.has(d.id));
      this.clearSelection();
    });
    return removed;
  }

  /* ---------- кабель-каналы ---------- */
  addChannel(points, { kind = 'кабель-канал', wallId = this.activeWallId, width = null, cableModelId = '', color = '', label = '' } = {}) {
    const def = CHANNEL_KINDS.find((k) => k.id === kind) || CHANNEL_KINDS[0];
    let ch;
    this.act('кабельный канал', () => {
      ch = {
        id: uid('ch'),
        wallId,
        kind: def.id,
        width: width ?? def.width,
        points: points.map(([x, y]) => [Math.round(x), Math.round(y)]),
        cableModelId,
        color,
      };
      this.project.channels.push(ch);
    });
    return ch;
  }
  updateChannel(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const c = this.getChannel(id);
      if (c) Object.assign(c, patch);
    };
    if (commit) this.act('изменение канала', doIt);
    else {
      doIt();
      this.touch();
    }
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
      if (!d) return;
      Object.assign(d, patch);
      if (Array.isArray(d.a)) d.a = d.a.map((v) => Math.round(+v || 0));
      if (Array.isArray(d.b)) d.b = d.b.map((v) => Math.round(+v || 0));
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
      return true;
    } catch (err) {
      console.warn('[store] не удалось сохранить проект', err);
      return false;
    }
  }
  loadSaved() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data?.project) return false;
      this.replaceProject(data.project, { activeWallId: data.activeWallId });
      if (data.settings && typeof data.settings === 'object') {
        this.settings = { ...this.settings, ...data.settings };
        this.settings.labels = ['none', 'tag', 'full'].includes(this.settings.labels) ? this.settings.labels : 'none';
      }
      return true;
    } catch (err) {
      console.warn('[store] не удалось загрузить проект', err);
      return false;
    }
  }
  replaceProject(project, { activeWallId = null } = {}) {
    this.project = sanitizeProject(project);
    this.activeWallId = activeWallId && this.project.walls.some((w) => w.id === activeWallId) ? activeWallId : this.project.walls[0].id;
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

/** Проверка/починка проекта из localStorage/файла. */
export function sanitizeProject(raw) {
  const base = createProject();
  if (!raw || typeof raw !== 'object') return base;
  const walls = Array.isArray(raw.walls) && raw.walls.length
    ? raw.walls.map((w, i) => ({
        id: String(w.id || uid('wall')),
        name: String(w.name || `Стена ${i + 1}`),
        width: clamp(+w.width || 6000, 500, 100000),
        height: clamp(+w.height || 2700, 500, 30000),
      }))
    : base.walls;
  const wallIds = new Set(walls.map((w) => w.id));
  const wallById = new Map(walls.map((w) => [w.id, w]));
  const devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .filter((d) => d && wallIds.has(d.wallId))
    .map((d) => {
      const model = getModel(d.modelId);
      const wall = wallById.get(d.wallId);
      return {
        id: String(d.id || uid('dev')),
        modelId: model.id,
        wallId: d.wallId,
        x: clamp(Math.round(+d.x || 0), 0, Math.max(0, wall.width - model.w)),
        y: clamp(Math.round(+d.y || 0), 0, Math.max(0, wall.height - model.h)),
        rot: [0, 90, 180, 270].includes(+d.rot) ? +d.rot : 0,
        tag: String(d.tag ?? ''),
        address: String(d.address ?? ''),
        note: String(d.note ?? ''),
      };
    });
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .filter((c) => c && wallIds.has(c.wallId) && Array.isArray(c.points) && c.points.length >= 2)
    .map((c) => ({
      id: String(c.id || uid('ch')),
      wallId: c.wallId,
      kind: CHANNEL_KIND_IDS.includes(c.kind) ? c.kind : CHANNEL_KIND_IDS[0],
      width: clamp(+c.width || 100, 5, 600),
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(c.color || '')) ? String(c.color) : '',
      points: c.points.map((p) => [ +p[0] || 0, +p[1] || 0 ]),
      cableModelId: String(c.cableModelId ?? ''),
    }));
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : [])
    .filter((d) => d && wallIds.has(d.wallId) && Array.isArray(d.a) && Array.isArray(d.b))
    .map((d) => {
      const wall = wallById.get(d.wallId);
      const fix = (pt) => [clamp(Math.round(+pt[0] || 0), 0, wall.width), clamp(Math.round(+pt[1] || 0), 0, wall.height)];
      return {
        id: String(d.id || uid('dim')),
        wallId: d.wallId,
        a: fix(d.a),
        b: fix(d.b),
        text: String(d.text ?? ''),
        offset: clamp(+d.offset || 60, 0, 600),
      };
    });
  return {
    version: SCHEMA_VERSION,
    meta: { ...base.meta, ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}) },
    walls,
    devices,
    channels,
    dimensions,
  };
}
