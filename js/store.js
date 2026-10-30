/**
 * store.js — состояние проекта, история изменений (undo/redo) и автосохранение.
 *
 * Проект целиком сериализуется в JSON: undo — это снимки проекта,
 * поэтому любые правки должны идти через begin()/commit() или act().
 */
import { getModel, CHANNEL_KINDS, GROUP_COLORS } from './catalog.js';
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
    groups: [],
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
    this.settings = { grid: 50, snap: true, showGrid: true, dropMax: 1200 };
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
      this.syncGroups();
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
  selectedGroups() {
    return this.selection
      .filter((s) => s.type === 'group')
      .map((s) => this.project.groups.find((g) => g.id === s.id))
      .filter(Boolean);
  }

  /* ---------- устройства ---------- */
  getDevice(id) {
    return this.project.devices.find((d) => d.id === id);
  }
  getChannel(id) {
    return this.project.channels.find((c) => c.id === id);
  }
  getGroup(id) {
    return this.project.groups.find((g) => g.id === id);
  }
  nextTag(wallId = this.activeWallId) {
    const wallNo = Math.max(1, this.project.walls.findIndex((w) => w.id === wallId) + 1);
    const tags = this.project.devices
      .filter((d) => d.wallId === wallId)
      .map((d) => {
        const mm = /^(\d+)\.(\d+)/.exec(d.tag || '');
        return mm && +mm[1] === wallNo ? +mm[2] : 0;
      });
    return `${wallNo}.${(tags.length ? Math.max(...tags) : 0) + 1}`;
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
        groupIds: [],
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
          groupIds: [],
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
      const grIds = new Set(this.selection.filter((s) => s.type === 'group').map((s) => s.id));
      this.project.devices = this.project.devices.filter((d) => !devIds.has(d.id));
      this.project.channels = this.project.channels.filter((c) => !chIds.has(c.id));
      for (const g of this.project.groups) {
        if (grIds.has(g.id)) continue;
        g.deviceIds = g.deviceIds.filter((id) => !devIds.has(id));
      }
      this.project.groups = this.project.groups.filter((g) => !grIds.has(g.id));
      for (const d of this.project.devices) {
        d.groupIds = (d.groupIds || []).filter((id) => !grIds.has(id));
      }
      this.syncGroups();
      this.clearSelection();
    });
    return removed;
  }

  /* ---------- кабель-каналы ---------- */
  addChannel(points, { kind = 'кабель-канал', wallId = this.activeWallId, width = null, cableModelId = '', label = '' } = {}) {
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
        label,
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

  /* ---------- объединения (шлейфы/линии) ---------- */
  createGroup({ name, kind = 'ШС', color = null, deviceIds = [], note = '' } = {}) {
    let group;
    this.act('объединение устройств', () => {
      group = {
        id: uid('grp'),
        name: name || `Шлейф ${this.project.groups.length + 1}`,
        kind,
        color: color || GROUP_COLORS[this.project.groups.length % GROUP_COLORS.length],
        note,
        deviceIds: deviceIds.filter((id) => this.getDevice(id)),
      };
      this.project.groups.push(group);
      for (const d of this.project.devices) {
        if (group.deviceIds.includes(d.id)) {
          d.groupIds = [...new Set([...(d.groupIds || []), group.id])];
        }
      }
      this.selection = [{ type: 'group', id: group.id }];
    });
    this.emit('selection');
    return group;
  }
  updateGroup(id, patch, { commit = true } = {}) {
    const doIt = () => {
      const g = this.getGroup(id);
      if (!g) return;
      Object.assign(g, patch);
      // синхронизировать членство устройств
      if (Array.isArray(patch.deviceIds)) {
        const ids = new Set(patch.deviceIds.filter((i) => this.getDevice(i)));
        g.deviceIds = [...ids];
        for (const d of this.project.devices) {
          const has = (d.groupIds || []).includes(id);
          const want = ids.has(d.id);
          if (want && !has) d.groupIds = [...(d.groupIds || []), id];
          if (!want && has) d.groupIds = d.groupIds.filter((x) => x !== id);
        }
      }
    };
    if (commit) this.act('изменение объединения', doIt);
    else {
      doIt();
      this.touch();
    }
  }
  removeGroup(id) {
    this.act('удаление объединения', () => {
      this.project.groups = this.project.groups.filter((g) => g.id !== id);
      for (const d of this.project.devices) d.groupIds = (d.groupIds || []).filter((g) => g !== id);
      this.selection = this.selection.filter((s) => !(s.type === 'group' && s.id === id));
    });
  }
  addDevicesToGroup(groupId, deviceIds) {
    const g = this.getGroup(groupId);
    if (!g) return;
    this.updateGroup(groupId, { deviceIds: [...new Set([...g.deviceIds, ...deviceIds])] });
  }
  removeDevicesFromGroup(groupId, deviceIds) {
    const g = this.getGroup(groupId);
    if (!g) return;
    const rm = new Set(deviceIds);
    this.updateGroup(groupId, { deviceIds: g.deviceIds.filter((id) => !rm.has(id)) });
  }
  /** Убрать из групп устройства/каналы, которых больше нет. */
  syncGroups() {
    for (const g of this.project.groups) {
      g.deviceIds = (g.deviceIds || []).filter((id) => this.getDevice(id));
    }
    for (const d of this.project.devices) {
      d.groupIds = (d.groupIds || []).filter((id) => this.getGroup(id));
    }
  }

  /* ---------- вычисления ---------- */
  /**
   * Опуски: для каждого устройства — ближайший кабель-канал на той же стене.
   * Возвращает [{deviceId, channelId, point:[x,y], length}]
   */
  computeDrops(wallId = null) {
    const byWall = new Map();
    for (const c of this.project.channels) {
      if (!byWall.has(c.wallId)) byWall.set(c.wallId, []);
      byWall.get(c.wallId).push(c);
    }
    const drops = [];
    for (const d of this.project.devices) {
      if (d.noDrop) continue;
      if (wallId && d.wallId !== wallId) continue;
      const channels = byWall.get(d.wallId) || [];
      if (!channels.length) continue;
      const m = getModel(d.modelId);
      const anchor = [d.x + m.w / 2, d.y];
      let best = null;
      for (const c of channels) {
        if (!c.points || c.points.length < 2) continue;
        const r = closestOnPolyline(anchor, c.points);
        if (!r) continue;
        if (!best || r.dist < best.dist) best = { channelId: c.id, point: r.point, dist: r.dist };
      }
      if (best && best.dist <= this.settings.dropMax) {
        drops.push({ deviceId: d.id, channelId: best.channelId, point: best.point, length: best.dist });
      }
    }
    return drops;
  }
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
        JSON.stringify({ schema: SCHEMA_VERSION, savedAt: new Date().toISOString(), project: this.project, activeWallId: this.activeWallId })
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
  const devices = (Array.isArray(raw.devices) ? raw.devices : [])
    .filter((d) => d && wallIds.has(d.wallId))
    .map((d) => {
      const model = getModel(d.modelId);
      return {
        id: String(d.id || uid('dev')),
        modelId: model.id,
        wallId: d.wallId,
        x: +d.x || 0,
        y: +d.y || 0,
        rot: [0, 90, 180, 270].includes(+d.rot) ? +d.rot : 0,
        tag: String(d.tag ?? ''),
        address: String(d.address ?? ''),
        note: String(d.note ?? ''),
        groupIds: Array.isArray(d.groupIds) ? d.groupIds.map(String) : [],
        noDrop: !!d.noDrop,
      };
    });
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .filter((c) => c && wallIds.has(c.wallId) && Array.isArray(c.points) && c.points.length >= 2)
    .map((c) => ({
      id: String(c.id || uid('ch')),
      wallId: c.wallId,
      kind: String(c.kind || 'кабель-канал'),
      width: clamp(+c.width || 40, 5, 600),
      points: c.points.map((p) => [ +p[0] || 0, +p[1] || 0 ]),
      cableModelId: String(c.cableModelId ?? ''),
      label: String(c.label ?? ''),
    }));
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((g) => g && Array.isArray(g.deviceIds))
    .map((g, i) => ({
      id: String(g.id || uid('grp')),
      name: String(g.name || `Шлейф ${i + 1}`),
      kind: String(g.kind || 'ШС'),
      color: String(g.color || GROUP_COLORS[i % GROUP_COLORS.length]),
      note: String(g.note ?? ''),
      deviceIds: g.deviceIds.map(String).filter((id) => devices.some((d) => d.id === id)),
    }));
  for (const d of devices) d.groupIds = d.groupIds.filter((id) => groups.some((g) => g.id === id));
  return {
    version: SCHEMA_VERSION,
    meta: { ...base.meta, ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}) },
    walls,
    devices,
    channels,
    groups,
  };
}
