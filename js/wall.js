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
import { clamp, snapTo, fmt, fmt0, m, mm, esc, pathD, closestOnPolyline, closestOnSegment, orthoPath, uid } from './util.js';

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
    this.dimDraft = null;
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
    this.dimDraft = null;
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
    if (!info) info = this._findNearDimension(floor, 14);
    if (!info) info = this._findNearHandle(floor, 14);
    if (!info && e.pointerType !== 'mouse') info = this._findNearTarget(floor, 30);
    this.pressStart = { x: e.clientX, y: e.clientY };

    if (this.tool === 'place' && this.store.armedModelId) {
      this._placeAt(floor);
      return;
    }
    if (this.tool === 'dimension') {
      const p = this._dimPoint(floor);
      if (!this.dimDraft) {
        this.dimDraft = { a: p, b: p };
      } else {
        const a = this.dimDraft.a;
        if (Math.hypot(p[0] - a[0], p[1] - a[1]) > 20) {
          this.store.addDimension(a, p);
          this.dimDraft = null;
          this.store.tool = 'select';
          this.store.emit('tool');
          this._hint();
        }
      }
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
      if (info.type === 'dim-handle') {
        this.drag = { mode: 'dim', dimId: info.id, index: info.index };
        this.store.begin();
        this._capture(e);
        return;
      }
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (info.type === 'channel') {
        this.store.select([{ type: 'channel', id: info.id }], additive);
        this.render();
        return;
      }
      if (info.type === 'dimension') {
        this.store.select([{ type: 'dimension', id: info.id }], additive);
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
    if (this.drag?.mode === 'dim') {
      const dim = this.store.getDimension(this.drag.dimId);
      if (dim) {
        const pt = [
          Math.round(clamp(this.snap(floor[0]), 0, this.wall.width)),
          Math.round(clamp(this.snap(floor[1]), 0, this.wall.height)),
        ];
        this.store.updateDimension(dim.id, { [this.drag.index === 0 ? 'a' : 'b']: pt }, { commit: false });
        this.scheduleRender();
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
    if (this.tool === 'dimension' && this.dimDraft) {
      this.dimDraft.b = this._dimPoint(floor);
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
    if (this.drag?.mode === 'dim') {
      this.drag = null;
      this.store.commit('изменение размера');
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
  finishDimension() {
    this.dimDraft = null;
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

    const parts = [];
    parts.push(this._defs());
    parts.push(`<g id="sheet">${this._sheet()}${this._grid()}</g>`);
    parts.push(`<g id="channels">${this._channels()}</g>`);
    parts.push(`<g id="dimensions">${this._dimensions()}</g>`);
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
      const color = ch.color || def.color;
      out += `<g class="channel${sel}" data-type="channel" data-id="${ch.id}">
        <path class="channel-hit" d="${d}" stroke-width="${Math.max(sw * 2.6, 140)}"/>
        <path class="channel-body" d="${d}" stroke-width="${sw}" stroke="${color}"/>
        <path class="channel-inner" d="${d}" stroke-width="${Math.max(sw * 0.26, 2)}"/>
      </g>`;

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

  _devices() {
    const wallH = this.wall.height;
    const ppm = this.pxPerMm || 0.2;
    const labelMode = this.store.settings.labels || 'none';
    const showTag = labelMode !== 'none' && ppm >= 0.075;
    const showSub = labelMode === 'full' && ppm >= 0.13;
    let out = '';
    for (const d of this.store.wallDevices) {
      const model = getModel(d.modelId);
      const sel = this.store.isSelected('device', d.id) ? ' sel' : '';
      const label = d.tag || model.name;
      const yScreen = wallH - (d.y + model.h);
      const rot = d.rot || 0;
      out += `<g class="dev${sel}" data-type="device" data-id="${d.id}" transform="translate(${d.x} ${yScreen})">
        <g transform="rotate(${rot} ${model.w / 2} ${model.h / 2})">
          <g class="dev-symbol">${symbolMarkup(model)}</g>
          <rect class="dev-hit" x="${-16}" y="${-16}" width="${model.w + 32}" height="${model.h + 32}" rx="10"/>
          <rect class="sel-frame" x="${-22}" y="${-22}" width="${model.w + 44}" height="${model.h + 44}" rx="12" vector-effect="non-scaling-stroke"/>
        </g>
        ${showTag ? `<text class="dev-tag" x="${model.w / 2}" y="${model.h + 90}">${esc(label)}</text>` : ''}
        ${showSub ? `<text class="dev-sub" x="${model.w / 2}" y="${model.h + 152}">${esc(d.address || model.model)}</text>` : ''}
      </g>`;
    }
    return out;
  }

  /** маркеры вершин каналов и концов размеров — поверх остальных слоёв */
  _handles() {
    const ppm = this.pxPerMm || 0.2;
    let out = '';
    for (const ch of this.store.wallChannels) {
      if (!this.store.isSelected('channel', ch.id)) continue;
      for (let i = 0; i < ch.points.length; i++) {
        const [x, y] = ch.points[i];
        out += `<circle class="channel-vertex" data-type="vertex" data-id="${ch.id}" data-index="${i}" cx="${x}" cy="${this.toScreenY(y)}" r="${Math.max(16, 7 / ppm)}" stroke-width="${Math.max(2, 1.4 / ppm)}"/>`;
      }
    }
    for (const dim of this.store.project.dimensions || []) {
      if (dim.wallId !== this.wall.id || !this.store.isSelected('dimension', dim.id)) continue;
      const g = this._dimGeom(dim);
      const r = Math.max(18, 8 / ppm);
      out += `<circle class="dim-handle" data-type="dim-handle" data-id="${dim.id}" data-index="0" cx="${g.sa[0]}" cy="${g.sa[1]}" r="${r}"/>`;
      out += `<circle class="dim-handle" data-type="dim-handle" data-id="${dim.id}" data-index="1" cx="${g.sb[0]}" cy="${g.sb[1]}" r="${r}"/>`;
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
    out += this._handles();
    if (this.dimDraft) {
      const a = this.dimDraft.a;
      const b = this.dimDraft.b;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const sa = [a[0], this.toScreenY(a[1])];
      const sb = [b[0], this.toScreenY(b[1])];
      out += `<line class="dim-preview" x1="${sa[0]}" y1="${sa[1]}" x2="${sb[0]}" y2="${sb[1]}" vector-effect="non-scaling-stroke"/>
        <text class="dim-text preview" x="${(sa[0] + sb[0]) / 2}" y="${(sa[1] + sb[1]) / 2 - 30}">${len > 5 ? this._fmtDim(len) : ''}</text>`;
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
        dims: (this.store.project.dimensions || []).length,
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
    } else if (tool === 'dimension') {
      text = coarse
        ? 'Размер: тап — первая точка, второй тап — вторая. Размер подпишется автоматически.'
        : 'Размер: клик — первая точка, второй клик — вторая (по горизонтали/вертикали). <kbd>Esc</kbd> — выход.';
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


  /* ================= размерные линии ================= */
  _fmtDim(lenMm) {
    return `${fmt0(Math.round(lenMm))} мм`;
  }
  /** точка размера: привязка к сетке и выравнивание по горизонтали/вертикали */
  _dimPoint(floor) {
    let [x, y] = [this.snap(floor[0]), this.snap(floor[1])];
    const a = this.dimDraft?.a;
    if (a) {
      if (Math.abs(x - a[0]) >= Math.abs(y - a[1])) y = a[1];
      else x = a[0];
    }
    return [clamp(x, 0, this.wall.width), clamp(y, 0, this.wall.height)];
  }
  _dimensions() {
    const dims = (this.store.project.dimensions || []).filter((d) => d.wallId === this.wall.id);
    return dims.map((dim) => this._dimensionMarkup(dim, this.store.isSelected('dimension', dim.id))).join('');
  }
  _dimGeom(dim) {
    const sa = [dim.a[0], this.toScreenY(dim.a[1])];
    const sb = [dim.b[0], this.toScreenY(dim.b[1])];
    const dx = sb[0] - sa[0];
    const dy = sb[1] - sa[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let nx = -uy;
    let ny = ux;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = dim.offset ?? 60;
    return {
      sa,
      sb,
      a2: [sa[0] + nx * off, sa[1] + ny * off],
      b2: [sb[0] + nx * off, sb[1] + ny * off],
      ux,
      uy,
      nx,
      ny,
      len,
    };
  }
  /** ближайшая ручка (вершина выделенного канала или конец размера) в пределах maxPx */
  _findNearHandle(floor, maxPx = 14) {
    const tol = maxPx / (this.pxPerMm || 0.2);
    const pt = [floor[0], this.toScreenY(floor[1])];
    let best = null;
    for (const ch of this.store.wallChannels) {
      if (!this.store.isSelected('channel', ch.id)) continue;
      ch.points.forEach(([x, y], i) => {
        const d = Math.hypot(pt[0] - x, pt[1] - this.toScreenY(y));
        if (d <= tol && (!best || d < best.dist)) best = { type: 'vertex', id: ch.id, index: i, dist: d };
      });
    }
    for (const dim of this.store.project.dimensions || []) {
      if (dim.wallId !== this.wall.id || !this.store.isSelected('dimension', dim.id)) continue;
      const g = this._dimGeom(dim);
      [g.sa, g.sb].forEach((p, i) => {
        const d = Math.hypot(pt[0] - p[0], pt[1] - p[1]);
        if (d <= tol && (!best || d < best.dist)) best = { type: 'dim-handle', id: dim.id, index: i, dist: d };
      });
    }
    return best;
  }

  /** ближайшая размерная линия в пределах maxPx — выделение без перехвата кликов каналами */
  _findNearDimension(floor, maxPx = 14) {
    const tol = maxPx / (this.pxPerMm || 0.2);
    const screenPt = [floor[0], this.toScreenY(floor[1])];
    let best = null;
    for (const dim of (this.store.project.dimensions || []).filter((d) => d.wallId === this.wall.id)) {
      const g = this._dimGeom(dim);
      const d = Math.min(closestOnSegment(screenPt, g.a2, g.b2).dist, closestOnSegment(screenPt, g.sa, g.sb).dist);
      if (d <= tol && (!best || d < best.dist)) best = { type: 'dimension', id: dim.id, dist: d };
    }
    return best;
  }
  _dimensionMarkup(dim, sel) {
    const g = this._dimGeom(dim);
    const { a2, b2, ux, uy, nx, ny } = g;
    const angle = (Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) * 180) / Math.PI;
    const textAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
    const mid = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
    const lenMm = Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1]);
    const label = (dim.text || '').trim() || this._fmtDim(lenMm);

    const al = 70; // длина стрелки, мм
    const aw = 22; // полуширина стрелки, мм
    const arrow = (tip, dirX, dirY) => {
      const baseX = tip[0] + dirX * al;
      const baseY = tip[1] + dirY * al;
      const px = -dirY * aw;
      const py = dirX * aw;
      return `<polygon points="${tip[0]},${tip[1]} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}" class="dim-arrow"/>`;
    };
    const sw = Math.max(2.5, 1.6 / (this.pxPerMm || 0.2));

    let out = `<g class="dimension${sel ? ' sel' : ''}" data-type="dimension" data-id="${dim.id}">
      <line class="dim-ext" x1="${g.sa[0]}" y1="${g.sa[1]}" x2="${a2[0]}" y2="${a2[1]}" vector-effect="non-scaling-stroke"/>
      <line class="dim-ext" x1="${g.sb[0]}" y1="${g.sb[1]}" x2="${b2[0]}" y2="${b2[1]}" vector-effect="non-scaling-stroke"/>
      <line class="dim-line" x1="${a2[0]}" y1="${a2[1]}" x2="${b2[0]}" y2="${b2[1]}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>
      ${arrow(a2, ux, uy)}
      ${arrow(b2, -ux, -uy)}
      <text class="dim-text" transform="translate(${mid[0] - nx * 45} ${mid[1] - ny * 45}) rotate(${textAngle})" text-anchor="middle">${esc(label)}</text>
    </g>`;

    return out;
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
    for (const g of walker.querySelectorAll('.band, .armed-ghost, .dim-preview, .channel-vertex, .dim-handle, .sel-frame')) g.remove();
    for (const g of walker.querySelectorAll('.sel')) g.classList.remove('sel');
    const meta = this.store.project.meta || {};
    const title = `${meta.name || 'BolidGrid'} — ${wall.name}`;
    const sub = [meta.doc, meta.address, meta.contractor].filter(Boolean).join(' · ');
    const footer = `<g class="export-footer"><text x="${bbox.x + 40}" y="${bbox.y + bbox.h - 90}" font-size="70" fill="#475569">${esc(title)}</text><text x="${bbox.x + 40}" y="${bbox.y + bbox.h - 30}" font-size="52" fill="#64748b">${esc(sub)}</text></g>`;
    walker.innerHTML += footer;
    // outerHTML — HTML-сериализация: &nbsp; и прочие сущности невалидны в XML.
    const svg = typeof XMLSerializer !== 'undefined' ? new XMLSerializer().serializeToString(walker) : walker.outerHTML;
    return { svg, bbox };
  }

  async exportSVGFile() {
    const { svg, bbox } = this.buildExportSVG();
    let css = '';
    try {
      css = await (await fetch('css/app.css')).text();
    } catch {
      css = '';
    }
    const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/&nbsp;/g, '&#160;');
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
