/**
 * store.js — состояние проекта, история изменений (undo/redo) и автосохранение.
 *
 * Проект целиком сериализуется в JSON: undo — это снимки проекта,
 * поэтому любые правки должны идти через begin()/commit() или act().
 */
import { getModel, MODELS, CHANNEL_KINDS, CHANNEL_KIND_IDS } from './catalog.js';
import { uid, closestOnPolyline, polylineLength, clamp } from './util.js';

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

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
    this.settings = { grid: 50, snap: true, showGrid: true, labels: 'none', channelColor: '#94a3b8', selectionDims: true, smartSnap: true };
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
      this.project.devices = this.project.devices.filter((d) => !devIds.has(d.id));
      this.project.channels = this.project.channels.filter((c) => !chIds.has(c.id));
      this.project.dimensions = (this.project.dimensions || []).filter((d) => !dimIds.has(d.id));
      this.clearSelection();
    });
    return removed;
  }

  /* ---------- короба ---------- */
  addChannel(points, { kind = 'dkc', wallId = this.activeWallId, width = null, color = '', label = '' } = {}) {
    const def = CHANNEL_KINDS.find((k) => k.id === kind) || CHANNEL_KINDS[0];
    let ch;
    this.act('добавление короба', () => {
      ch = {
        id: uid('ch'),
        wallId,
        kind: def.id,
        width: width ?? def.width,
        points: points.map(([x, y]) => [Math.round(x), Math.round(y)]),
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

/** Привести ломаную короба к горизонтальным/вертикальным сегментам. */
function orthoPoints(points) {
  const pts = points.map((p) => [Math.round(+p[0] || 0), Math.round(+p[1] || 0)]);
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
    .filter((d) => {
      const m = MODELS_BY_ID.get(String(d.modelId));
      return m ? !m.hidden : true; // скрытые модели (АКБ, МПН, Маяк, таблички, КМ-О и т.п.) не переносим
    })
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
    .map((c) => {
      // Старые проекты использовали id «кабель-канал»; кабельные поля больше не переносим.
      const kind = c.kind === 'кабель-канал' ? 'dkc' : c.kind;
      return {
        id: String(c.id || uid('ch')),
        wallId: c.wallId,
        kind: CHANNEL_KIND_IDS.includes(kind) ? kind : CHANNEL_KIND_IDS[0],
        width: clamp(+c.width || 100, 5, 600),
        color: /^#[0-9a-fA-F]{3,8}$/.test(String(c.color || '')) ? String(c.color) : '',
        points: orthoPoints(c.points),
      };
    });
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
        offset: clamp(+d.offset || 60, -600, 600),
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
