/**
 * wall.js — отрисовка и редактирование «стены» (фронтальная проекция) в SVG.
 *
 * Мир: миллиметры; X — вдоль стены, Y — высота от пола (вверх).
 * Экран: SVG-координаты, y направлен вниз; низ стены — на y = height.
 *
 * Инструменты: выбор (перетаскивание, рамка), кабельный канал (ломаная),
 * панорама, измерение. Опуски к каналам считаются автоматически.
 */
import { getModel, symbolMarkup, CHANNEL_KINDS, KIND_COLORS } from './catalog.js';
import { clamp, snapTo, fmt, m, mm, esc, pathD, closestOnPolyline, orthoPath, uid } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SHEET_PAD = 260; // отступ листа в мм для подписей

export class WallEditor {
  constructor({ store, svg, hintEl, onStatus }) {
    this.store = store;
    this.svg = svg;
    this.hintEl = hintEl;
    this.onStatus = onStatus || (() => {});
    this.view = { x: -300, y: -300, w: 7000, h: 3600 };
    this.pointer = null; // {svg:[x,y], floor:[x,y]}
    this.drag = null;
    this.band = null;
    this.pan = null;
    this.channelDraft = null;
    this.measure = null;
    this.hover = null;
    this.pointers = new Map();
    this.pinch = null;
    this.touchPan = null;
    this.pressStart = null;
    this.longPressTimer = null;
    this.longPressFired = false;
    this.spaceDown = false;
    this._raf = null;
    this._bind();
    this._observeResize();
    this.fit();
  }

  /* ================= служебное ================= */
  get wall() {
    return this.store.wall;
  }
  get tool() {
    return this.store.tool;
  }
  get grid() {
    return this.store.settings.grid || 50;
  }
  snapOn() {
    return !!this.store.settings.snap;
  }
  snap(v) {
    return this.snapOn() ? snapTo(v, this.grid) : Math.round(v);
  }
  toScreenY(y) {
    return this.wall.height - y;
  }
  get pxPerMm() {
    const mtx = this.svg.getScreenCTM?.();
    if (mtx && mtx.a) return mtx.a;
    return this.svg.clientWidth ? this.svg.clientWidth / this.view.w : 0.2;
  }
  scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  _capture(e) {
    try {
      this._capture(e);
    } catch {
      /* синтетические события/неизвестный pointerId — не критично */
    }
  }

  _bind() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this._onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this._onPointerUp(e));
    svg.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    svg.addEventListener('pointerleave', () => {
      this.pointer = null;
      this._updateStatus();
    });
    svg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    svg.addEventListener('dblclick', (e) => this._onDblClick(e));
    svg.addEventListener('contextmenu', (e) => {
      if (this.channelDraft) {
        e.preventDefault();
        this.cancelDraft();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this._isTyping(e)) this.spaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }
  _isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => {
      if (!this.svg.clientWidth || !this.svg.clientHeight) return;
      if (!this._sized) {
        this._sized = true;
        this.fit();
        return;
      }
      const c = this._centerWorld();
      this._recenter(c);
      this.render();
    });
    this._ro.observe(this.svg);
  }
  _centerWorld() {
    return [this.view.x + this.view.w / 2, this.view.y + this.view.h / 2];
  }
  _recenter([cx, cy]) {
    const pxW = this.svg.clientWidth || 1;
    const pxH = this.svg.clientHeight || 1;
    const scale = pxW / this.view.w;
    this.view.w = pxW / scale;
    this.view.h = pxH / scale;
    this.view.x = cx - this.view.w / 2;
    this.view.y = cy - this.view.h / 2;
  }

  /* ================= координаты ================= */
  clientToSvg(clientX, clientY) {
    const pt = this.svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const mtx = this.svg.getScreenCTM();
    if (!mtx) return [0, 0];
    const p = pt.matrixTransform(mtx.inverse());
    return [p.x, p.y];
  }
  /** экранные SVG-координаты → миллиметры стены (x вдоль, y от пола) */
  svgToFloor([sx, sy]) {
    return [sx, this.wall.height - sy];
  }
  screenToFloor(e) {
    return this.svgToFloor(this.clientToSvg(e.clientX, e.clientY));
  }
  clientToFloorPoint(clientX, clientY) {
    return this.svgToFloor(this.clientToSvg(clientX, clientY));
  }

  /* ================= вид ================= */
  fit() {
    if (!this.wall) return;
    const pxW = this.svg.clientWidth || 900;
    const pxH = this.svg.clientHeight || 600;
    const bbox = this.contentBBox();
    const scale = Math.min(pxW / bbox.w, pxH / bbox.h) * 0.96;
    this.view.w = pxW / scale;
    this.view.h = pxH / scale;
    this.view.x = bbox.x + bbox.w / 2 - this.view.w / 2;
    this.view.y = bbox.y + bbox.h / 2 - this.view.h / 2;
    this.render();
  }
  contentBBox() {
    const wall = this.wall;
    return {
      x: -SHEET_PAD,
      y: -SHEET_PAD,
      w: wall.width + SHEET_PAD * 2,
      h: wall.height + SHEET_PAD * 2,
    };
  }
  /** зум без перерисовки (для жестов) — точка под курсором остаётся на месте */
  _applyZoom(clientX, clientY, factor) {
    const [sx, sy] = this.clientToSvg(clientX, clientY);
    const fx = (sx - this.view.x) / this.view.w;
    const fy = (sy - this.view.y) / this.view.h;
    const nw = clamp(this.view.w / factor, 300, 200000);
    const nh = clamp(this.view.h / factor, 200, 100000);
    this.view.w = nw;
    this.view.h = nh;
    this.view.x = sx - fx * nw;
    this.view.y = sy - fy * nh;
  }
  zoomAt(clientX, clientY, factor) {
    this._applyZoom(clientX, clientY, factor);
    this.render();
  }

  _startLongPress(e, info) {
    this._clearLongPress();
    if (e.pointerType === 'mouse') return;
    this.longPressFired = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      try {
        navigator.vibrate?.(12);
      } catch {
        /* необязательно */
      }
      this.store.toggleSelect({ type: info.type, id: info.id });
      this.render();
    }, 480);
  }
  _clearLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  /** два пальца: масштаб + панорама одним движением */
  _beginPinch() {
    this._clearLongPress();
    const pts = [...this.pointers.values()].slice(0, 2);
    const [a, b] = pts;
    const mx = (a.clientX + b.clientX) / 2;
    const my = (a.clientY + b.clientY) / 2;
    this.pinch = {
      dist: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      midX: mx,
      midY: my,
    };
    // одиночные жесты отменяем, но незавершённую правку положения — фиксируем
    if (this.drag?.mode === 'device' && this.drag.moving) this.store.commit('перемещение устройств');
    else this.store._before = null;
    this.drag = null;
    this.band = null;
    this.tapDevice = null;
    this.channelDraft = this.channelDraft || null;
  }

  _pinchMove() {
    const pts = [...this.pointers.values()].slice(0, 2);
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
    const mx = (a.clientX + b.clientX) / 2;
    const my = (a.clientY + b.clientY) / 2;
    const factor = dist / (this.pinch.dist || dist);
    this._applyZoom(mx, my, factor);
    const scale = this.pxPerMm || 0.2;
    this.view.x -= (mx - this.pinch.midX) / scale;
    this.view.y -= (my - this.pinch.midY) / scale;
    this.pinch.dist = dist;
    this.pinch.midX = mx;
    this.pinch.midY = my;
    this.scheduleRender();
  }

  /**
   * Ближайшее устройство/канал в пределах maxPx от точки — для попадания пальцем
   * по мелким элементам на маленьком экране.
   */
  _findNearTarget(floor, maxPx = 30) {
    const tol = maxPx / (this.pxPerMm || 0.2);
    let best = null;
    for (const d of this.store.wallDevices) {
      const model = getModel(d.modelId);
      const dx = Math.max(d.x - floor[0], 0, floor[0] - (d.x + model.w));
      const dy = Math.max(d.y - floor[1], 0, floor[1] - (d.y + model.h));
      const dist = Math.hypot(dx, dy);
      if (dist <= tol && (!best || dist < best.dist)) best = { type: 'device', id: d.id, dist };
    }
    if (!best) {
      for (const c of this.store.wallChannels) {
        const r = closestOnPolyline(floor, c.points);
        if (r && r.dist <= Math.max(tol, (c.width || 40) / 2) && (!best || r.dist < best.dist)) {
          best = { type: 'channel', id: c.id, dist: r.dist };
        }
      }
    }
    return best;
  }
  zoomBy(factor) {
    const r = this.svg.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }
  _onWheel(e) {
    e.preventDefault();
    const factor = Math.pow(1.0016, -e.deltaY);
    this.zoomAt(e.clientX, e.clientY, factor);
  }

  /* ================= инструменты ================= */
  setTool(tool) {
    this.cancelDraft();
    this.store.tool = tool;
    this.store.armedModelId = null;
    this.store.emit('tool');
    this.store.emit('palette');
    this._hint();
    this.render();
  }
  armModel(modelId) {
    this.cancelDraft();
    this.store.armedModelId = this.store.armedModelId === modelId ? null : modelId;
    if (this.store.armedModelId) this.store.tool = 'place';
    else this.store.tool = 'select';
    this.store.emit('tool');
    this.store.emit('palette');
    this._hint();
    this.render();
  }
  cancelDraft() {
    this.channelDraft = null;
    this.measure = null;
    if (!['select', 'pan'].includes(this.store.tool)) this.store.tool = 'select';
    this.store.armedModelId = null;
    this.store.emit('tool');
    this.store.emit('palette');
    this._hint();
    this.render();
  }
  cancelAll() {
    this.drag = null;
    this.band = null;
    this.pan = null;
    this.cancelDraft();
  }

  /* ================= события указателя ================= */
  _targetInfo(e) {
    const el = e.target.closest?.('[data-type]');
    if (!el) return null;
    return { type: el.dataset.type, id: el.dataset.id, index: el.dataset.index != null ? +el.dataset.index : null };
  }

  _onPointerDown(e) {
    this.svg.focus?.();
    this.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (this.pointers.size === 2) {
      this._beginPinch();
      return;
    }
    if (this.pinch) return;
    if (e.button === 1 || this.spaceDown || this.tool === 'pan') {
      this.pan = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.classList.add('panning');
      this._capture(e);
      return;
    }
    if (e.button !== 0) return;
    let info = this._targetInfo(e);
    const floor = this.screenToFloor(e);
    if (!info && e.pointerType !== 'mouse') info = this._findNearTarget(floor, 30);
    this.pressStart = { x: e.clientX, y: e.clientY };

    if (this.tool === 'place' && this.store.armedModelId) {
      this._placeAt(floor);
      return;
    }
    if (this.tool === 'measure') {
      if (!this.measure) this.measure = { a: floor, b: floor, locked: false };
      else if (!this.measure.locked) this.measure.locked = true;
      else this.measure = { a: floor, b: floor, locked: false };
      this.render();
      return;
    }
    if (this.tool === 'channel') {
      this._channelClick(floor);
      return;
    }
    // --- выбор ---
    if (info) {
      const touch = e.pointerType !== 'mouse';
      if (info.type === 'vertex') {
        this.drag = { mode: 'vertex', channelId: info.id, index: info.index };
        this.store.begin();
        this._capture(e);
        return;
      }
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (info.type === 'group') {
        this.store.select([{ type: 'group', id: info.id }], additive);
        return;
      }
      if (info.type === 'channel') {
        this.store.select([{ type: 'channel', id: info.id }], additive);
        this.render();
        return;
      }

      // устройство
      const already = this.store.isSelected('device', info.id);
      if (!touch) {
        if (!already) this.store.select([{ type: 'device', id: info.id }], additive);
        else if (additive) {
          this.store.toggleSelect({ type: 'device', id: info.id });
          return;
        }
      } else {
        // на сенсорном экране выделение меняем по отпусканию пальца,
        // а долгое нажатие добавляет/убирает устройство из выделения
        this.tapDevice = { id: info.id, wasSelected: already };
        if (!already) this._startLongPress(e, info);
        else this._startLongPress(e, info, 'toggle');
      }

      this.store.begin();
      const origins = this.store.selectedDevices().map((d) => ({ id: d.id, x: d.x, y: d.y, wallId: d.wallId }));
      const dev = this.store.getDevice(info.id);
      if (touch && !already && dev && !origins.some((o) => o.id === dev.id)) {
        origins.push({ id: dev.id, x: dev.x, y: dev.y, wallId: dev.wallId });
      }
      this.drag = {
        mode: 'device',
        primaryId: info.id,
        start: floor,
        moving: false,
        origins,
        touchNew: touch && !already,
      };
      this._capture(e);
      this.render();
      return;
    }
    // пустое место: на сенсорном экране — панорама, на десктопе — рамка выделения
    if (e.pointerType !== 'mouse') {
      this.touchPan = { sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      this._capture(e);
      return;
    }
    if (!e.shiftKey) this.store.clearSelection();
    this.band = { a: floor, b: floor, additive: e.shiftKey };
    this.render();
  }

  _onPointerMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      this._pinchMove();
      return;
    }
    const floor = this.screenToFloor(e);
    this.pointer = { floor, clientX: e.clientX, clientY: e.clientY };
    if (this.pan) {
      const scale = this.pxPerMm || 0.2;
      this.view.x = this.pan.vx - (e.clientX - this.pan.sx) / scale;
      this.view.y = this.pan.vy - (e.clientY - this.pan.sy) / scale;
      this.render();
      return;
    }
    if (this.pressStart && Math.hypot(e.clientX - this.pressStart.x, e.clientY - this.pressStart.y) > 8) {
      this._clearLongPress();
    }
    if (this.touchPan) {
      const dx = e.clientX - this.touchPan.sx;
      const dy = e.clientY - this.touchPan.sy;
      if (!this.touchPan.moved && Math.hypot(dx, dy) > 4) this.touchPan.moved = true;
      if (this.touchPan.moved) {
        const scale = this.pxPerMm || 0.2;
        this.view.x = this.touchPan.vx - dx / scale;
        this.view.y = this.touchPan.vy - dy / scale;
        this.scheduleRender();
      }
      return;
    }
    if (this.drag?.mode === 'device') {
      const dx = floor[0] - this.drag.start[0];
      const dy = floor[1] - this.drag.start[1];
      if (!this.drag.moving && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        this.drag.moving = true;
        this._clearLongPress();
        if (this.drag.touchNew) {
          this.drag.touchNew = false;
          this.store.select([{ type: 'device', id: this.drag.primaryId }]);
        }
      }
      if (this.drag.moving) this._moveDevices(dx, dy);
      return;
    }
    if (this.drag?.mode === 'vertex') {
      const ch = this.store.getChannel(this.drag.channelId);
      if (ch) {
        const pts = ch.points.slice();
        pts[this.drag.index] = [Math.round(clamp(this.snap(floor[0]), 0, this.wall.width)), Math.round(clamp(this.snap(floor[1]), 0, this.wall.height))];
        ch.points = pts;
        this.store.emit('live');
      }
      return;
    }
    if (this.band) {
      this.band.b = floor;
      this.scheduleRender();
      return;
    }
    if (this.tool === 'channel' && this.channelDraft) {
      this.channelDraft.cursor = this._orthoPoint(floor);
      this.scheduleRender();
      return;
    }
    if (this.tool === 'measure' && this.measure && !this.measure.locked) {
      this.measure.b = floor;
      this.scheduleRender();
      return;
    }
    if (this.tool === 'place' && this.store.armedModelId) {
      this.scheduleRender();
      return;
    }
    this._updateStatus();
  }

  _onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.render();
      return;
    }
    if (this.touchPan) {
      const tp = this.touchPan;
      this.touchPan = null;
      if (!tp.moved) this.store.clearSelection();
      this.render();
      return;
    }
    this._clearLongPress();
    if (this.pan) {
      this.pan = null;
      this.svg.classList.remove('panning');
      this.render();
      return;
    }
    if (this.drag?.mode === 'device') {
      const d = this.drag;
      this.drag = null;
      const tapped = this.tapDevice;
      const longPressed = this.longPressFired;
      this.tapDevice = null;
      this.longPressFired = false;
      this._clearLongPress();
      if (d.moving) this.store.commit('перемещение устройств');
      else this.store._before = null;
      if (!d.moving && tapped && !longPressed) this.store.select([{ type: 'device', id: tapped.id }]);
      this.render();
      return;
    }
    if (this.drag?.mode === 'vertex') {
      this.drag = null;
      this.store.commit('изменение канала');
      this.render();
      return;
    }
    if (this.band) {
      const band = this.band;
      this.band = null;
      this._finishBand(band);
      this.render();
      return;
    }
    if (this.tool === 'measure' && this.measure) {
      // измерение фиксируется вторым кликом (pointerdown), здесь ничего
    }
    void e;
  }

  _onDblClick(e) {
    if (this.tool === 'channel' && this.channelDraft) {
      e.preventDefault();
      this._finishChannel();
    }
  }

  /* ================= размещение устройств ================= */
  _placeAt(floor) {
    const modelId = this.store.armedModelId;
    if (!modelId) return;
    const model = getModel(modelId);
    let x = this.snap(floor[0] - model.w / 2);
    let y = this.snap(floor[1] - model.h / 2);
    x = clamp(x, 0, this.wall.width - model.w);
    y = clamp(y, 0, this.wall.height - model.h);
    const dev = this.store.addDevice(modelId, x, y);
    this.store.tool = 'select';
    this.store.armedModelId = null;
    this.store.emit('tool');
    this.store.emit('palette');
    this.store.emit('selection');
    this._hint();
    if (dev) this.store.emit('toast', { text: `Добавлено: ${model.name} (${dev.tag})` });
    this.render();
  }

  _moveDevices(dx, dy) {
    const drag = this.drag;
    if (!drag?.origins) return;
    const primary = drag.origins.find((o) => o.id === drag.primaryId) || drag.origins[0];
    if (!primary) return;
    let tx = this.snap(primary.x + dx);
    let ty = this.snap(primary.y + dy);
    // привязка к кабельным каналам по высоте (низ устройства ложится на канал)
    const chans = this.store.wallChannels;
    if (chans.length) {
      for (const ch of chans) {
        for (const p of ch.points) {
          if (Math.abs(ty - p[1]) < Math.max(15, 40)) ty = p[1];
        }
      }
    }
    const primaryModel = getModel(this.store.getDevice(primary.id)?.modelId || 'custom');
    const wall = this.wall;
    tx = clamp(tx, 0, wall.width - primaryModel.w);
    ty = clamp(ty, 0, wall.height - primaryModel.h);
    const ddx = tx - primary.x;
    const ddy = ty - primary.y;
    for (const o of drag.origins) {
      const d = this.store.getDevice(o.id);
      if (!d || d.wallId !== this.wall.id) continue;
      const model = getModel(d.modelId);
      d.x = clamp(Math.round(o.x + ddx), 0, wall.width - model.w);
      d.y = clamp(Math.round(o.y + ddy), 0, wall.height - model.h);
    }
    this.store.emit('live');
  }

  _finishBand(band) {
    const x1 = Math.min(band.a[0], band.b[0]);
    const x2 = Math.max(band.a[0], band.b[0]);
    const y1 = Math.min(band.a[1], band.b[1]);
    const y2 = Math.max(band.a[1], band.b[1]);
    if (x2 - x1 < 5 && y2 - y1 < 5) {
      if (!band.additive) this.store.clearSelection();
      return;
    }
    const items = [];
    for (const d of this.store.wallDevices) {
      const model = getModel(d.modelId);
      const cx = d.x + model.w / 2;
      const cy = d.y + model.h / 2;
      if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) items.push({ type: 'device', id: d.id });
    }
    for (const c of this.store.wallChannels) {
      if (c.points.some(([x, y]) => x >= x1 && x <= x2 && y >= y1 && y <= y2)) items.push({ type: 'channel', id: c.id });
    }
    this.store.select(items, band.additive);
  }

  /* ================= кабельные каналы ================= */
  _orthoPoint(floor) {
    let [x, y] = floor;
    x = clamp(x, 0, this.wall.width);
    y = clamp(y, 0, this.wall.height);
    const pts = this.channelDraft?.points || [];
    if (pts.length) {
      const [lx, ly] = pts[pts.length - 1];
      if (Math.abs(x - lx) >= Math.abs(y - ly)) y = ly;
      else x = lx;
      // привязка к сетке по свободной оси
      if (y === ly) x = clamp(this.snap(x), 0, this.wall.width);
      else y = clamp(this.snap(y), 0, this.wall.height);
    }
    return [x, y];
  }
  _channelClick(floor) {
    if (!this.channelDraft) {
      this.channelDraft = { wallId: this.wall.id, points: [[this.snap(floor[0]), this.snap(floor[1])]], cursor: [this.snap(floor[0]), this.snap(floor[1])] };
      this._hint();
      this.render();
      return;
    }
    const p = this._orthoPoint(floor);
    const last = this.channelDraft.points[this.channelDraft.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 20) return;
    this.channelDraft.points.push(p);
    this._hint();
    this.render();
  }
  _finishChannel() {
    const draft = this.channelDraft;
    this.channelDraft = null;
    if (!draft || draft.points.length < 2) {
      this.store.tool = 'select';
      this.store.emit('tool');
      this._hint();
      this.render();
      return;
    }
    const ch = this.store.addChannel(draft.points, { kind: this.store.settings.channelKind || 'кабель-канал', wallId: draft.wallId });
    this.store.tool = 'select';
    this.store.emit('tool');
    this._hint();
    if (ch) this.store.emit('toast', { text: `Канал добавлен: ${m(this.store.channelLength(ch))}` });
    this.render();
  }

  /* ================= измерение ================= */
  finishMeasure() {
    this.measure = null;
    this.render();
  }

  /* ================= отрисовка ================= */
  render() {
    const wall = this.wall;
    if (!wall) return;
    const { x: vx, y: vy, w: vw, h: vh } = this.view;
    this.svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.classList.toggle('tool-pan', this.tool === 'pan');
    this.svg.classList.toggle('armed', this.tool === 'place');

    const drops = this.store.computeDrops(this.wall.id);
    const parts = [];
    parts.push(this._defs());
    parts.push(`<g id="sheet">${this._sheet()}${this._grid()}</g>`);
    parts.push(`<g id="channels">${this._channels()}</g>`);
    parts.push(`<g id="drops">${this._drops(drops)}</g>`);
    parts.push(`<g id="groups">${this._groupLinks()}</g>`);
    parts.push(`<g id="devices">${this._devices()}</g>`);
    parts.push(`<g id="overlay">${this._overlay()}</g>`);
    this.svg.innerHTML = parts.join('');
    this._updateStatus();
  }

  _defs() {
    return `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#8ea4bf"/>
      </marker>
    </defs>`;
  }

  _sheet() {
    const w = this.wall;
    const capY = w.height + 120;
    return `<rect class="sheet" x="0" y="0" width="${w.width}" height="${w.height}" rx="6"/>
      <line class="ruler-line" x1="0" y1="${w.height}" x2="${w.width}" y2="${w.height}" stroke-width="3"/>
      <text class="wall-caption" x="0" y="-150">${esc(w.name)}</text>
      <text class="wall-sub" x="0" y="-30">${esc(this.store.project.meta?.doc || '')} · стена ${this.store.wallIndex + 1} из ${this.store.project.walls.length} · ${m(w.width)} × ${m(w.height)}</text>
      <!-- размеры -->
      <line class="ruler-line" x1="0" y1="${capY}" x2="${w.width}" y2="${capY}" stroke-width="2" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
      <text class="ruler-label" x="${w.width / 2}" y="${capY + 60}" text-anchor="middle">${m(w.width)}</text>
      <line class="ruler-line" x1="-90" y1="0" x2="-90" y2="${w.height}" stroke-width="2" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
      <text class="ruler-label" x="-120" y="${w.height / 2}" text-anchor="middle" transform="rotate(-90 ${-120} ${w.height / 2})">${m(w.height)}</text>
      <text class="wall-sub" x="0" y="${capY + 150}">Уровень пола 0,000</text>`;
  }

  _grid() {
    if (!this.store.settings.showGrid) return '';
    const wall = this.wall;
    const { x: vx, y: vy, w: vw, h: vh } = this.view;
    const pxPerMm = this.pxPerMm || 0.2;
    let step = this.grid;
    while (step * pxPerMm < 9) step *= 2;
    const x0 = Math.max(0, Math.floor(vx / step) * step);
    const x1 = Math.min(wall.width, vx + vw);
    const y0 = Math.max(0, Math.floor(vy / step) * step);
    const y1 = Math.min(wall.height, vy + vh);
    let out = '';
    for (let x = x0; x <= x1; x += step) {
      const major = Math.round(x / step) % 5 === 0;
      out += `<line class="grid-line${major ? ' major' : ''}" x1="${x}" y1="${Math.max(0, vy)}" x2="${x}" y2="${Math.min(wall.height, vy + vh)}"/>`;
    }
    for (let y = y0; y <= y1; y += step) {
      const major = Math.round(y / step) % 5 === 0;
      out += `<line class="grid-line${major ? ' major' : ''}" x1="${Math.max(0, vx)}" y1="${y}" x2="${Math.min(wall.width, vx + vw)}" y2="${y}"/>`;
    }
    return out;
  }

  _channels() {
    let out = '';
    for (const ch of this.store.wallChannels) {
      const def = CHANNEL_KINDS.find((k) => k.id === ch.kind) || CHANNEL_KINDS[0];
      const d = pathD(ch.points, (y) => this.toScreenY(y));
      const sw = Math.max(ch.width, 6);
      const sel = this.store.isSelected('channel', ch.id) ? ' sel' : '';
      const mid = this._polylineMid(ch.points);
      const label = ch.label || (ch.cableModelId ? ch.cableModelId : def.label);
      out += `<g class="channel${sel}" data-type="channel" data-id="${ch.id}">
        <path class="channel-hit" d="${d}" stroke-width="${Math.max(sw * 2.6, 140)}"/>
        <path class="channel-body" d="${d}" stroke-width="${sw}" stroke="${def.color}"/>
        <path class="channel-inner" d="${d}" stroke-width="${Math.max(sw * 0.26, 2)}"/>
        <text class="channel-label" x="${mid[0] + 40}" y="${this.toScreenY(mid[1]) - 40}">${esc(label)} · ${m(this.store.channelLength(ch))}</text>
      </g>`;
      if (sel) {
        for (let i = 0; i < ch.points.length; i++) {
          const [x, y] = ch.points[i];
          out += `<circle class="channel-vertex" data-type="vertex" data-id="${ch.id}" data-index="${i}" cx="${x}" cy="${this.toScreenY(y)}" r="${Math.max(14, 6 / this.pxPerMm)}" stroke-width="${Math.max(2, 1.4 / this.pxPerMm)}"/>`;
        }
      }
    }
    return out;
  }

  _polylineMid(points) {
    if (!points.length) return [0, 0];
    const total = points.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0), 0);
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (acc + seg >= total / 2) {
        const t = seg ? (total / 2 - acc) / seg : 0;
        return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      }
      acc += seg;
    }
    return points[points.length - 1];
  }

  _drops(drops) {
    let out = '';
    for (const drop of drops) {
      const dev = this.store.getDevice(drop.deviceId);
      if (!dev) continue;
      const model = getModel(dev.modelId);
      const ax = dev.x + model.w / 2;
      const ay = this.toScreenY(dev.y);
      const bx = drop.point[0];
      const by = this.toScreenY(drop.point[1]);
      out += `<path class="drop" d="M${ax} ${ay} L${bx} ${by}"/>
        <circle cx="${bx}" cy="${by}" r="${Math.max(8, 4 / this.pxPerMm)}" fill="#0ea5e9" opacity=".9"/>`;
    }
    return out;
  }

  _groupLinks() {
    let out = '';
    for (const g of this.store.project.groups) {
      const devs = g.deviceIds.map((id) => this.store.getDevice(id)).filter((d) => d && d.wallId === this.wall.id);
      if (devs.length < 2) continue;
      const pts = devs.map((d) => {
        const model = getModel(d.modelId);
        return [d.x + model.w / 2, this.toScreenY(d.y + model.h / 2)];
      });
      let d = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) d += ` L${pts[i][0]} ${pts[i][1]}`;
      const first = pts[0];
      out += `<g class="group-link" data-type="group" data-id="${g.id}">
        <path d="${d}" stroke="${g.color}" pointer-events="stroke" stroke-width="${Math.max(5, 3 / this.pxPerMm)}"/>
        <circle cx="${first[0]}" cy="${first[1]}" r="${Math.max(16, 7 / this.pxPerMm)}" fill="${g.color}" opacity=".9"/>
        <text class="group-label" x="${first[0] + 40}" y="${first[1] - 40}" fill="${g.color}">${esc(g.name)} · ${devs.length}</text>
      </g>`;
    }
    return out;
  }

  _devices() {
    const wallH = this.wall.height;
    let out = '';
    for (const d of this.store.wallDevices) {
      const model = getModel(d.modelId);
      const sel = this.store.isSelected('device', d.id) ? ' sel' : '';
      const groups = (d.groupIds || []).map((id) => this.store.getGroup(id)).filter(Boolean);
      const loopColor = groups.length ? groups[0].color : null;
      const label = d.tag || model.name;
      const yScreen = wallH - (d.y + model.h);
      const rot = d.rot || 0;
      out += `<g class="dev${sel}" data-type="device" data-id="${d.id}" transform="translate(${d.x} ${yScreen})">
        <g transform="rotate(${rot} ${model.w / 2} ${model.h / 2})">
          <g class="dev-symbol">${symbolMarkup(model)}</g>
          <rect class="dev-hit" x="${-16}" y="${-16}" width="${model.w + 32}" height="${model.h + 32}" rx="10"/>
          <rect class="sel-frame" x="${-22}" y="${-22}" width="${model.w + 44}" height="${model.h + 44}" rx="12" vector-effect="non-scaling-stroke"/>
        </g>
        ${loopColor ? `<rect x="${model.w - 46}" y="${-28}" width="72" height="16" rx="4" fill="${loopColor}" vector-effect="non-scaling-stroke"/>` : ''}
        <text class="dev-tag" x="${model.w / 2}" y="${model.h + 120}">${esc(label)}</text>
        ${d.address ? `<text class="dev-sub" x="${model.w / 2}" y="${model.h + 200}">${esc(d.address)}</text>` : ''}
      </g>`;
    }
    return out;
  }

  _overlay() {
    let out = '';
    if (this.band) {
      const x = Math.min(this.band.a[0], this.band.b[0]);
      const yTop = Math.min(this.toScreenY(this.band.a[1]), this.toScreenY(this.band.b[1]));
      const w = Math.abs(this.band.b[0] - this.band.a[0]);
      const h = Math.abs(this.band.b[1] - this.band.a[1]);
      out += `<rect class="band" x="${x}" y="${yTop}" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`;
    }
    if (this.channelDraft) {
      const pts = this.channelDraft.points.slice();
      const cursor = this.channelDraft.cursor;
      const preview = [...pts, cursor];
      const d = pathD(preview, (y) => this.toScreenY(y));
      out += `<path d="${d}" fill="none" stroke="#0ea5e9" stroke-width="${Math.max(6, 3 / this.pxPerMm)}" stroke-dasharray="${Math.max(18, 8 / this.pxPerMm)} ${Math.max(12, 5 / this.pxPerMm)}" vector-effect="non-scaling-stroke"/>`;
      for (const p of pts) {
        out += `<circle cx="${p[0]}" cy="${this.toScreenY(p[1])}" r="${Math.max(16, 6 / this.pxPerMm)}" fill="#0ea5e9" stroke="#fff" stroke-width="${Math.max(3, 1.5 / this.pxPerMm)}"/>`;
      }
    }
    if (this.measure) {
      const a = this.measure.a, b = this.measure.b;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out += `<line class="measure-line" x1="${a[0]}" y1="${this.toScreenY(a[1])}" x2="${b[0]}" y2="${this.toScreenY(b[1])}" vector-effect="non-scaling-stroke"/>
        <text class="measure-label" x="${(a[0] + b[0]) / 2 + 40}" y="${this.toScreenY((a[1] + b[1]) / 2) - 40}">${m(len)} (${mm(len)})</text>`;
    }
    if (this.tool === 'place' && this.store.armedModelId && this.pointer) {
      const model = getModel(this.store.armedModelId);
      const [fx, fy] = this.pointer.floor;
      let x = clamp(this.snap(fx - model.w / 2), 0, this.wall.width - model.w);
      let y = clamp(this.snap(fy - model.h / 2), 0, this.wall.height - model.h);
      out += `<g class="armed-ghost" transform="translate(${x} ${this.toScreenY(y + model.h)})">${symbolMarkup(model)}</g>`;
    }
    return out;
  }

  _updateStatus() {
    const f = this.pointer?.floor;
    const zoom = Math.round((this.svg.clientWidth / this.view.w) * 100);
    this.onStatus({
      x: f ? f[0] : null,
      y: f ? f[1] : null,
      zoom,
      wall: this.wall?.name || '',
      counts: {
        devices: this.store.wallDevices.length,
        channels: this.store.wallChannels.length,
        groups: this.store.project.groups.length,
      },
    });
  }

  _hint() {
    if (!this.hintEl) return;
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    const tool = this.store.tool;
    const modelName = this.store.armedModelId ? getModel(this.store.armedModelId).name : '';
    let text;

    if (tool === 'channel') {
      if (this.channelDraft) {
        const n = this.channelDraft.points.length;
        text = coarse
          ? `Точек трассы: <b>${n}</b> · тап — следующая точка <button class="hint-btn" id="btn-channel-done">Готово</button>`
          : `Точек трассы: <b>${n}</b> · клик — следующая точка · <kbd>Enter</kbd> или двойной клик — завершить · <kbd>Esc</kbd> — отмена`;
      } else {
        text = coarse
          ? 'Кабельный канал: тап — начало трассы. Точки выравниваются по горизонтали/вертикали.'
          : 'Кабельный канал: кликните начало трассы. Точки выравниваются по горизонтали/вертикали.';
      }
    } else if (tool === 'place' && this.store.armedModelId) {
      text = coarse
        ? `Размещение: <b>${esc(modelName)}</b> — тапните по стене.`
        : `Размещение: <b>${esc(modelName)}</b> — кликните на стене. <kbd>Esc</kbd> — отмена`;
    } else if (tool === 'measure') {
      text = coarse
        ? 'Измерение: тап — точка A, второй тап — точка B.'
        : 'Измерение: клик — точка A, второй клик — точка B. <kbd>Esc</kbd> — выход.';
    } else if (tool === 'pan') {
      text = coarse ? 'Панорама: тяните лист одним пальцем, масштаб — двумя.' : 'Панорама: тяните мышью. Колесо — масштаб.';
    } else if (coarse) {
      text = 'Тап — выбрать · удержание — добавить в выделение · два пальца — масштаб.';
    } else {
      text = 'Выбор: клик по устройству/каналу, рамкой — групповое выделение. <kbd>G</kbd> — объединить в шлейф, <kbd>Del</kbd> — удалить.';
    }

    if (text === this._hintCache) return;
    this._hintCache = text;
    this.hintEl.innerHTML = text;
  }


  /* ================= навигация к объекту ================= */
  focusOn(x, yFloor, span = 900) {
    const pxW = this.svg.clientWidth || 900;
    const pxH = this.svg.clientHeight || 600;
    this.view.w = span;
    this.view.h = (span * pxH) / pxW;
    this.view.x = x - this.view.w / 2;
    this.view.y = this.wall.height - yFloor - this.view.h / 2;
    this.render();
  }
  focusOnGroup(group) {
    if (!group) return;
    const devs = group.deviceIds.map((id) => this.store.getDevice(id)).filter((d) => d && d.wallId === this.wall.id);
    if (!devs.length) {
      const any = group.deviceIds.map((id) => this.store.getDevice(id)).filter(Boolean)[0];
      if (any) {
        this.store.setActiveWall(any.wallId);
        requestAnimationFrame(() => this.focusOnGroup(group));
      }
      return;
    }
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (const d of devs) {
      const model = getModel(d.modelId);
      x1 = Math.min(x1, d.x);
      x2 = Math.max(x2, d.x + model.w);
      y1 = Math.min(y1, d.y);
      y2 = Math.max(y2, d.y + model.h);
    }
    const cx = (x1 + x2) / 2;
    const cyS = this.wall.height - (y1 + y2) / 2;
    const span = Math.max(x2 - x1 + 600, 1200);
    const pxW = this.svg.clientWidth || 900;
    const pxH = this.svg.clientHeight || 600;
    this.view.w = span;
    this.view.h = (span * pxH) / pxW;
    this.view.x = cx - this.view.w / 2;
    this.view.y = cyS - this.view.h / 2;
    this.render();
  }
  finishChannel() {
    if (this.channelDraft) this._finishChannel();
  }

  /* ================= экспорт ================= */
  buildExportSVG() {
    const bbox = this.contentBBox();
    const wall = this.wall;
    const walker = this.svg.cloneNode(true);
    walker.setAttribute('id', 'wall');
    walker.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}`);
    walker.setAttribute('width', String(Math.round(bbox.w / 4)));
    walker.setAttribute('height', String(Math.round(bbox.h / 4)));
    walker.removeAttribute('style');
    for (const g of walker.querySelectorAll('.band, .armed-ghost, .measure-line, .measure-label, .channel-vertex')) g.remove();
    const meta = this.store.project.meta || {};
    const title = `${meta.name || 'BolidGrid'} — ${wall.name}`;
    const sub = [meta.doc, meta.address, meta.contractor].filter(Boolean).join(' · ');
    const footer = `<g class="export-footer"><text x="${bbox.x + 40}" y="${bbox.y + bbox.h - 90}" font-size="70" fill="#475569">${esc(title)}</text><text x="${bbox.x + 40}" y="${bbox.y + bbox.h - 30}" font-size="52" fill="#64748b">${esc(sub)}</text></g>`;
    walker.innerHTML += footer;
    return { svg: walker.outerHTML, bbox };
  }

  async exportSVGFile() {
    const { svg, bbox } = this.buildExportSVG();
    let css = '';
    try {
      css = await (await fetch('css/app.css')).text();
    } catch {
      css = '';
    }
    const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const width = Math.round(bbox.w / 4);
    const height = Math.round(bbox.h / 4);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="wall" width="${width}" height="${height}" viewBox="${bbox.x} ${bbox.y} ${bbox.w} ${bbox.h}">
<style><![CDATA[${css}]]></style>
${inner}
</svg>
`;
  }
}
