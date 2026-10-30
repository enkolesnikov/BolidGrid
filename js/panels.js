/**
 * panels.js — панели интерфейса: каталог устройств, стены, точные свойства,
 * спецификация (BOM) и ведомость кабельных трасс.
 */
import { MODELS, getModel, KIND_LABELS, KIND_ORDER, CHANNEL_KINDS, CHANNEL_COLORS, modelThumb } from './catalog.js';
import { fmt, fmt0, m, mm, esc, download, toCSV, uid, polylineLength } from './util.js';

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const escAll = esc;

export class Panels {
  constructor({ store, editor, onRequestProjectDialog }) {
    this.store = store;
    this.editor = editor;
    this.onRequestProjectDialog = onRequestProjectDialog || (() => {});
    this.activeTab = 'props';
    this.search = '';
    this.anchorX = 'left';
    this.anchorY = 'bottom';
    this._bind();
    this.renderAll();
  }

  $(id) {
    return document.getElementById(id);
  }

  /* ================= инициализация связок ================= */
  _bind() {
    // поля объекта
    const map = {
      'meta-name': 'name',
      'meta-address': 'address',
      'meta-contractor': 'contractor',
      'meta-doc': 'doc',
    };
    for (const [id, key] of Object.entries(map)) {
      const input = this.$(id);
      if (!input) continue;
      input.addEventListener('change', () => {
        this.store.act('изменение данных объекта', () => {
          this.store.project.meta[key] = input.value.trim();
        });
      });
    }
    const nameInput = this.$('project-name');
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        this.store.act('название проекта', () => {
          this.store.project.meta.name = nameInput.value.trim();
        });
      });
    }

    // поиск по палитре
    const search = this.$('palette-search');
    if (search) {
      search.addEventListener('input', () => {
        this.search = search.value.trim().toLowerCase();
        this.renderPalette();
      });
    }

    // добавление стены
    this.$('btn-add-wall')?.addEventListener('click', () => this.openWallDialog(null));

    // вкладки правой панели
    for (const btn of document.querySelectorAll('#tabs button')) {
      btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
    }

    // Диалоги: явная кнопка закрытия, Esc и возврат фокуса.
    this.$('modal-close')?.addEventListener('click', () => this._modalClose?.());
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.$('modal')?.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this._modalClose?.();
    }, true);

    // удаление стены (делегирование)
    this.$('walls-list')?.addEventListener('click', (e) => {
      const del = e.target.closest('[data-wall-del]');
      if (!del) return;
      const id = del.dataset.wallDel;
      const wall = this.store.project.walls.find((w) => w.id === id);
      if (!wall) return;
      const count = this.store.project.devices.filter((d) => d.wallId === id).length;
      this.confirm(
        `Удалить стену «${wall.name}»?${count ? ` Вместе с ней удалятся ${count} устройств.` : ''}`,
        () => {
          this.store.removeWall(id);
          this.editor.fit();
        },
        'Удалить'
      );
    });

    // смена стены
    this.$('walls-list')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-wall-id]');
      if (!item || e.target.closest('[data-wall-del]')) return;
      this.store.setActiveWall(item.dataset.wallId);
      this.editor.fit();
    });
    this.$('wall-tabs')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wall-id]');
      if (!b) return;
      this.store.setActiveWall(b.dataset.wallId);
      this.editor.fit();
    });
  }

  setTab(tab) {
    this.activeTab = tab;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of document.querySelectorAll('.tabpanel')) p.classList.toggle('active', p.id === `tab-${tab}`);
  }

  /* ================= глобальная перерисовка ================= */
  renderAll() {
    this.renderMeta();
    this.renderWalls();
    this.renderWallTabs();
    this.renderPalette();
    this.renderInspector();
    this.renderSpec();
    this.renderJournal();
    this.updateToolButtons();
  }

  renderFor(type) {
    switch (type) {
      case 'all':
        this.renderAll();
        break;
      case 'project':
        this.renderPalette();
        this.renderInspector();
            this.renderSpec();
        this.renderJournal();
        this.renderWalls();
        this.renderWallTabs();
        break;
      case 'selection':
        this.renderInspector();
            break;
      case 'wall':
        this.renderWalls();
        this.renderWallTabs();
        this.renderInspector();
        this.renderPalette();
        break;
      case 'tool':
      case 'palette':
        this.renderPalette();
        this.updateToolButtons();
        break;
      case 'spec':
        this.renderSpec();
        break;
      default:
        break;
    }
  }

  /* ================= объект ================= */
  renderMeta() {
    const meta = this.store.project.meta;
    const set = (id, v) => {
      const inp = this.$(id);
      if (inp) inp.value = v ?? '';
    };
    set('meta-name', meta.name);
    set('meta-address', meta.address);
    set('meta-contractor', meta.contractor);
    set('meta-doc', meta.doc);
    set('project-name', meta.name);
  }

  /* ================= стены ================= */
  renderWalls() {
    const box = this.$('walls-list');
    if (!box) return;
    const activeId = this.store.wall?.id;
    box.innerHTML = this.store.project.walls
      .map((w, i) => {
        const n = this.store.project.devices.filter((d) => d.wallId === w.id).length;
        const ch = this.store.project.channels.filter((c) => c.wallId === w.id).length;
        return `<div class="wall-item ${w.id === activeId ? 'active' : ''}" data-wall-id="${w.id}" title="${escAll(w.name)}">
          <span class="wname">${escAll(w.name)}</span>
          <span class="wdim">${m(w.width)}×${m(w.height)} · ${n}у · ${ch}к</span>
          <button class="wdel" data-wall-del="${w.id}" title="Удалить стену">✕</button>
        </div>`;
      })
      .join('');
  }

  renderWallTabs() {
    const box = this.$('wall-tabs');
    if (!box) return;
    const activeId = this.store.wall?.id;
    box.innerHTML = this.store.project.walls
      .map((w, i) => `<button class="wall-tab ${w.id === activeId ? 'active' : ''}" data-wall-id="${w.id}" title="${escAll(w.name)}">${i + 1}. ${escAll(w.name.replace(/^Стена\s*\d+\s*—?\s*/, ''))}</button>`)
      .join('');
  }

  /* ================= палитра ================= */
  renderPalette() {
    const box = this.$('palette-list');
    if (!box) return;
    const counts = this.store.placedCountByModel();
    const specQty = new Map();
    if (this.store.spec?.equipment) {
      for (const row of this.store.spec.equipment) specQty.set(row.pos, +row.qty || 0);
    }
    const armed = this.store.armedModelId;
    const q = this.search;
    const groups = new Map();
    for (const model of MODELS) {
      if (model.hidden) continue;
      if (q) {
        const hay = `${model.name} ${model.model} ${model.full} ${model.vendor}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (!groups.has(model.kind)) groups.set(model.kind, []);
      groups.get(model.kind).push(model);
    }
    if (!groups.size) {
      box.innerHTML = `<div class="empty">Ничего не найдено по запросу «${escAll(this.search)}».</div>`;
      return;
    }
    let html = '';
    for (const kind of KIND_ORDER) {
      const models = groups.get(kind);
      if (!models?.length) continue;
      html += `<div class="pal-group-title">${escAll(KIND_LABELS[kind] || kind)}</div>`;
      for (const model of models) {
        const placed = counts.get(model.id) || 0;
        const qty = model.specPos != null ? specQty.get(model.specPos) : null;
        const over = qty != null && placed > qty;
        html += `<button class="pal-item ${armed === model.id ? 'armed' : ''}" data-model="${model.id}" title="${escAll(model.full)}">
          <span class="thumb">${modelThumb(model, 40)}</span>
          <span class="pname">${escAll(model.name)}<small>${escAll(model.vendor || '')}${model.specPos != null ? ` · поз. ${model.specPos}` : ''}</small></span>
          <span class="pcount">${qty != null ? `<b class="${over ? 'over' : ''}">${placed}</b> / ${qty}` : placed}<small>${model.unit || 'шт.'}</small></span>
        </button>`;
      }
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-model]').forEach((btn) => {
      btn.addEventListener('click', () => this.editor.armModel(btn.dataset.model));
    });
  }

  updateToolButtons() {
    for (const b of document.querySelectorAll('#stage-toolbar [data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === this.store.tool);
    }
  }

  /* ================= инспектор ================= */
  renderInspector() {
    const box = this.$('tab-props');
    if (!box) return;
    const sel = this.store.selection;
    if (!sel.length) {
      box.innerHTML = this._inspectorEmpty();
      this._wireInspector(box);
      return;
    }
    const devices = this.store.selectedDevices();
    const channels = this.store.selectedChannels();
    const dims = this.store.selectedDimensions();
    if (devices.length === 1 && !channels.length && !dims.length) box.innerHTML = this._deviceInspector(devices[0]);
    else if (channels.length === 1 && !devices.length && !dims.length) box.innerHTML = this._channelInspector(channels[0]);
    else if (dims.length === 1 && !devices.length && !channels.length) box.innerHTML = this._dimensionInspector(dims[0]);
    else box.innerHTML = this._multiInspector(devices, channels, dims);
    this._wireInspector(box);
  }

  _inspectorEmpty() {
    const stats = this._projectStats();
    const issues = this.store.findPlacementIssues();
    return `<div class="selection-empty">
      <div class="prop-title"><h4>Ничего не выбрано</h4><span class="badge">${stats.devices} приборов</span></div>
      <p>Коснитесь прибора или короба на стене. Здесь появятся точные размеры и действия.</p>
      <div class="empty-steps">
        <div><span>1</span>Добавьте прибор из каталога</div>
        <div><span>2</span>Перетащите или задайте координаты</div>
        <div><span>3</span>Проведите короб и добавьте размеры</div>
      </div>
      <button class="review-summary ${issues.length ? 'warn' : 'ok'}" data-act="review"><span>Проверка стены</span><b>${issues.length ? `Пересечений: ${issues.length}` : 'Пересечений нет'}</b></button>
      <div class="measure-preview"><span>Общая длина трасс</span><b>${m(stats.channelLen)}</b></div>
    </div>`;
  }

  _projectStats() {
    const st = this.store;
    const channelLen = st.project.channels.reduce((a, c) => a + st.channelLength(c), 0);
    return {
      walls: st.project.walls.length,
      devices: st.project.devices.length,
      channels: st.project.channels.length,
      channelLen,
      dims: (st.project.dimensions || []).length,
    };
  }

  _deviceInspector(d) {
    const model = getModel(d.modelId);
    const modelOptions = MODELS.filter((m0) => !m0.hidden).map(
      (m0) => `<option value="${m0.id}" ${m0.id === model.id ? 'selected' : ''}>${escAll(m0.name)}</option>`
    ).join('');
    const xValue = this.anchorX === 'right' ? d.x + model.w : this.anchorX === 'center' ? d.x + model.w / 2 : d.x;
    const yValue = this.anchorY === 'top' ? d.y + model.h : this.anchorY === 'center' ? d.y + model.h / 2 : d.y;
    const horizontalChannels = this.store.wallChannels.filter((c) => c.points.some((p, i) => i && p[1] === c.points[i - 1][1]));
    return `<div class="prop-title"><span class="badge">${escAll(d.tag || '—')}</span><h4>${escAll(model.name)}</h4></div>
      <div class="form">
        <div class="row2">
          <label>Обозначение<input data-f="tag" value="${escAll(d.tag)}" placeholder="1.1"></label>
          <label>Модель<select data-f="modelId">${modelOptions}</select></label>
        </div>
        <section class="prop-section">
          <h5>Точное положение</h5>
          <div class="position-grid">
            <div class="position-field"><span>По горизонтали</span><div class="position-input"><input data-pos-x type="number" step="1" min="0" inputmode="numeric" value="${Math.round(xValue)}"><i>мм</i></div>
              <select class="anchor-select" data-anchor-x aria-label="Точка отсчёта по горизонтали"><option value="left" ${this.anchorX === 'left' ? 'selected' : ''}>слева до прибора</option><option value="center" ${this.anchorX === 'center' ? 'selected' : ''}>до центра</option><option value="right" ${this.anchorX === 'right' ? 'selected' : ''}>справа до прибора</option></select></div>
            <div class="position-field"><span>От пола</span><div class="position-input"><input data-pos-y type="number" step="1" min="0" inputmode="numeric" value="${Math.round(yValue)}"><i>мм</i></div>
              <select class="anchor-select" data-anchor-y aria-label="Точка отсчёта по вертикали"><option value="bottom" ${this.anchorY === 'bottom' ? 'selected' : ''}>до низа прибора</option><option value="center" ${this.anchorY === 'center' ? 'selected' : ''}>до центра</option><option value="top" ${this.anchorY === 'top' ? 'selected' : ''}>до верха прибора</option></select></div>
          </div>
          <div class="measure-preview"><span>Габарит</span><b>${model.w} × ${model.h} мм</b></div>
        </section>
        <section class="prop-section">
          <h5>Высота низа от пола</h5>
          <div class="quick-values">${[900, 1200, 1500, 1800].map((v) => `<button class="btn tiny ${d.y === v ? 'active' : ''}" data-height="${v}">${fmt0(v)}</button>`).join('')}</div>
        </section>
        <section class="prop-section">
          <h5>${this.store.selectedDevices().length > 1 ? 'Выровнять выбранные' : 'Выровнять на стене'}</h5>
          ${this._alignmentButtons()}
        </section>
        ${horizontalChannels.length ? `<section class="prop-section"><h5>По высоте горизонтального короба</h5><div class="section-actions"><button class="btn tiny" data-act="device-above-channel">Низ на верх короба</button><button class="btn tiny" data-act="device-below-channel">Верх к низу короба</button></div></section>` : ''}
        <section class="prop-section">
          <button class="btn tiny ${this.store.settings.selectionDims ? 'active' : ''}" data-act="toggle-guides">${this.store.settings.selectionDims ? '✓ ' : ''}Показывать отступы на листе</button>
          <div class="section-actions"><button class="btn accent" data-act="add-dims">Добавить размеры</button><button class="btn tiny" data-act="focus">Приблизить</button></div>
        </section>
        <details><summary class="hintline">Обозначение, адрес и примечание</summary><label>Адрес<input data-f="address" value="${escAll(d.address)}"></label><label>Примечание<input data-f="note" value="${escAll(d.note)}"></label></details>
        <div class="section-actions"><button class="btn tiny" data-act="dup">Дублировать</button><button class="btn tiny danger" data-act="del">Удалить</button></div>
      </div>`;
  }

  _alignmentButtons() {
    const n = this.store.selectedDevices().length;
    return `<div class="align-grid">
      <button class="btn tiny" data-align="left" title="По левому краю">Слева</button><button class="btn tiny" data-align="center-x" title="По центрам по вертикали">Центр X</button><button class="btn tiny" data-align="right" title="По правому краю">Справа</button>
      <button class="btn tiny" data-align="top" title="По верхнему краю">Сверху</button><button class="btn tiny" data-align="center-y" title="По центрам по горизонтали">Центр Y</button><button class="btn tiny" data-align="bottom" title="По нижнему краю">Снизу</button>
    </div>${n >= 3 ? `<div class="section-actions"><button class="btn tiny" data-align="distribute-x">Равномерно по X</button><button class="btn tiny" data-align="distribute-y">Равномерно по Y</button></div>` : ''}`;
  }

  _channelInspector(c) {
    const def = CHANNEL_KINDS.find((k) => k.id === c.kind) || CHANNEL_KINDS[0];
    const cables = this._cableOptions();
    const simple = c.points.length === 2;
    const horizontal = simple && c.points[0][1] === c.points[1][1];
    const vertical = simple && c.points[0][0] === c.points[1][0];
    let position = '';
    if (simple) {
      const [a, b] = c.points;
      position = `<section class="prop-section"><h5>Точные координаты трассы</h5>
        <div class="position-grid">
          <label>${vertical ? 'X трассы' : 'X начала'}<div class="position-input"><input type="number" data-ch-point="0" data-axis="0" value="${Math.round(a[0])}"><i>мм</i></div></label>
          <label>${horizontal ? 'Высота трассы' : 'H начала'}<div class="position-input"><input type="number" data-ch-point="0" data-axis="1" value="${Math.round(a[1])}"><i>мм</i></div></label>
          <label>X конца<div class="position-input"><input type="number" data-ch-point="1" data-axis="0" value="${Math.round(b[0])}"><i>мм</i></div></label>
          <label>H конца<div class="position-input"><input type="number" data-ch-point="1" data-axis="1" value="${Math.round(b[1])}"><i>мм</i></div></label>
        </div><div class="channel-position-note">${horizontal ? 'Горизонтальный участок' : vertical ? 'Вертикальный участок' : 'Прямой участок'} · при изменении координат направление сохраняется.</div></section>`;
    } else {
      position = `<div class="channel-position-note">Ломаная трасса: ${c.points.length} точек. Тяните линию, чтобы сдвинуть участок, или вершины — чтобы изменить маршрут.</div>`;
    }
    return `<div class="prop-title"><span class="badge">короб</span><h4>${escAll(def.label)}</h4></div>
      <div class="form">
        <div class="measure-preview"><span>Длина трассы</span><b>${m(this.store.channelLength(c))}</b></div>
        <div class="row2"><label>Тип<select data-f="kind">${CHANNEL_KINDS.map((k) => `<option value="${k.id}" ${k.id === c.kind ? 'selected' : ''}>${escAll(k.label)}</option>`).join('')}</select></label><label>Ширина, мм<input data-f="width" type="number" min="5" max="600" step="5" value="${c.width}"></label></div>
        ${position}
        <section class="prop-section"><h5>Цвет на согласовании</h5><div class="swatches">${CHANNEL_COLORS.map((col) => `<button class="swatch ${(c.color || def.color).toLowerCase() === col ? 'active' : ''}" data-ch-color="${col}" style="background:${col}" title="${col}" aria-label="Цвет ${col}"></button>`).join('')}<label class="swatch-custom" title="Свой цвет"><input type="color" data-f="color" value="${escAll(c.color || def.color)}"></label></div></section>
        <details><summary class="hintline">Марка кабеля</summary><label>Кабель<select data-f="cableModelId"><option value="">— не задан —</option>${cables.map((v) => `<option value="${escAll(v)}" ${v === c.cableModelId ? 'selected' : ''}>${escAll(v)}</option>`).join('')}</select></label></details>
        <div class="section-actions"><button class="btn tiny" data-act="focus-channel">Приблизить</button><button class="btn tiny danger" data-act="del">Удалить короб</button></div>
      </div>`;
  }

  _dimensionInspector(dim) {
    const len = Math.hypot(dim.b[0] - dim.a[0], dim.b[1] - dim.a[1]);
    return `<div class="prop-title"><span class="badge">размер</span><h4>${escAll(fmt0(Math.round(len)))} мм</h4></div>
      <div class="form">
        <div class="row2">
          <label>X₁, мм<input data-f="ax" type="number" step="10" value="${Math.round(dim.a[0])}"></label>
          <label>H₁, мм<input data-f="ay" type="number" step="10" value="${Math.round(dim.a[1])}"></label>
        </div>
        <div class="row2">
          <label>X₂, мм<input data-f="bx" type="number" step="10" value="${Math.round(dim.b[0])}"></label>
          <label>H₂, мм<input data-f="by" type="number" step="10" value="${Math.round(dim.b[1])}"></label>
        </div>
        <label>Текст на линии<input data-f="text" value="${escAll(dim.text || '')}" placeholder="${escAll(fmt0(Math.round(len)))} мм (авто)"></label>
        <label>Отступ линии, мм<input data-f="offset" type="number" step="10" value="${dim.offset ?? 60}"></label>
        <div class="hintline">Пусто в тексте — размер показывается автоматически. Концы линии тянутся за маркеры на стене.</div>
        <div class="section-actions">
          <button class="btn tiny" data-act="del">Удалить размер</button>
        </div>
      </div>`;
  }

  _multiInspector(devices, channels, dims = []) {
    const total = devices.length + channels.length + dims.length;
    return `<div class="prop-title"><h4>Выбрано: ${total}</h4><span class="badge">${devices.length} приборов</span></div>
      <div class="form">
        ${devices.length ? `<section class="prop-section"><h5>Выравнивание приборов</h5>${this._alignmentButtons()}</section>` : ''}
        ${devices.length >= 2 ? `<section class="prop-section"><h5>Свободный зазор между приборами</h5><div class="gap-control"><div class="position-input"><input data-gap-value type="number" min="0" step="1" inputmode="numeric" value="100" aria-label="Зазор в миллиметрах"><i>мм</i></div><select data-gap-direction aria-label="Направление зазора"><option value="x">по горизонтали</option><option value="y">по вертикали</option></select><button class="btn" data-act="apply-gap">Применить</button></div><div class="hintline">Первый прибор остаётся на месте, остальные выстраиваются с одинаковым зазором.</div></section>` : ''}
        <div class="multi-summary">${channels.length ? `Коробов: ${channels.length}. ` : ''}${dims.length ? `Размеров: ${dims.length}.` : ''}На телефоне удерживайте прибор, чтобы добавить его в выделение.</div>
        <div class="section-actions">${devices.length ? '<button class="btn tiny" data-act="dup">Дублировать приборы</button>' : ''}<button class="btn tiny danger" data-act="del">Удалить выбранное</button></div>
      </div>`;
  }

  _wireInspector(box) {
    const st = this.store;
    const devices = st.selectedDevices();
    const single = devices.length === 1 ? devices[0] : null;
    const channel = st.selectedChannels().length === 1 ? st.selectedChannels()[0] : null;
    const dim = st.selectedDimensions().length === 1 ? st.selectedDimensions()[0] : null;

    if (single && !channel && !dim) {
      box.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
        st.updateDevice(single.id, { [inp.dataset.f]: inp.type === 'number' ? parseFloat(inp.value) || 0 : inp.value });
      }));
      const updatePosition = (axis, input) => {
        const model = getModel(single.modelId);
        const value = Math.max(0, parseFloat(input.value) || 0);
        if (axis === 'x') {
          const x = this.anchorX === 'right' ? value - model.w : this.anchorX === 'center' ? value - model.w / 2 : value;
          st.updateDevice(single.id, { x: Math.round(x) });
        } else {
          const y = this.anchorY === 'top' ? value - model.h : this.anchorY === 'center' ? value - model.h / 2 : value;
          st.updateDevice(single.id, { y: Math.round(y) });
        }
      };
      box.querySelector('[data-pos-x]')?.addEventListener('change', (e) => updatePosition('x', e.target));
      box.querySelector('[data-pos-y]')?.addEventListener('change', (e) => updatePosition('y', e.target));
      box.querySelector('[data-anchor-x]')?.addEventListener('change', (e) => { this.anchorX = e.target.value; this.renderInspector(); });
      box.querySelector('[data-anchor-y]')?.addEventListener('change', (e) => { this.anchorY = e.target.value; this.renderInspector(); });
      box.querySelectorAll('[data-height]').forEach((b) => b.addEventListener('click', () => {
        this.anchorY = 'bottom';
        st.updateDevice(single.id, { y: +b.dataset.height });
      }));
    }

    if (channel) {
      box.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
        st.updateChannel(channel.id, { [inp.dataset.f]: inp.type === 'number' ? parseFloat(inp.value) || 0 : inp.value });
      }));
      box.querySelectorAll('[data-ch-color]').forEach((sw) => sw.addEventListener('click', () => st.updateChannel(channel.id, { color: sw.dataset.chColor })));
      box.querySelectorAll('[data-ch-point]').forEach((inp) => inp.addEventListener('change', () => {
        const index = +inp.dataset.chPoint;
        const axis = +inp.dataset.axis;
        const value = parseFloat(inp.value) || 0;
        const points = channel.points.map((p) => [...p]);
        const horizontal = points[0][1] === points[1][1];
        const vertical = points[0][0] === points[1][0];
        if ((horizontal && axis === 1) || (vertical && axis === 0)) {
          points[0][axis] = value;
          points[1][axis] = value;
        } else points[index][axis] = value;
        points.forEach((p) => { p[0] = Math.max(0, Math.min(st.wall.width, p[0])); p[1] = Math.max(0, Math.min(st.wall.height, p[1])); });
        st.updateChannel(channel.id, { points });
      }));
    }

    if (dim) {
      box.querySelectorAll('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        const patch = {};
        if (f === 'ax') patch.a = [parseFloat(inp.value) || 0, dim.a[1]];
        else if (f === 'ay') patch.a = [dim.a[0], parseFloat(inp.value) || 0];
        else if (f === 'bx') patch.b = [parseFloat(inp.value) || 0, dim.b[1]];
        else if (f === 'by') patch.b = [dim.b[0], parseFloat(inp.value) || 0];
        else if (f === 'offset') patch.offset = parseFloat(inp.value) || 0;
        else patch[f] = inp.value;
        st.updateDimension(dim.id, patch);
      }));
    }

    box.querySelectorAll('[data-align]').forEach((btn) => btn.addEventListener('click', () => st.alignDevices(btn.dataset.align)));
    box.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => this._inspectorAction(btn.dataset.act, { single, channel, devices })));
  }

  _inspectorAction(act, { single, channel, devices }) {
    const st = this.store;
    switch (act) {
      case 'dup': st.duplicateDevices(devices.map((d) => d.id)); break;
      case 'del': st.removeSelection(); break;
      case 'review': this.openIssuesDialog(); break;
      case 'apply-gap': {
        const input = this.$('tab-props')?.querySelector('[data-gap-value]');
        const direction = this.$('tab-props')?.querySelector('[data-gap-direction]')?.value || 'x';
        const value = Number(input?.value);
        const ok = st.setDeviceGap(direction, value);
        this.toast(ok ? `Зазор ${Math.round(value)} мм применён` : 'Не хватает места на стене или выбрано меньше двух приборов', !ok);
        break;
      }
      case 'focus': if (single) this.editor.focusOn(single.x, single.y, 900); break;
      case 'focus-channel': if (channel) { const mid = channel.points[Math.floor(channel.points.length / 2)]; this.editor.focusOn(mid[0], mid[1], 1400); } break;
      case 'toggle-guides':
        st.settings.selectionDims = !st.settings.selectionDims;
        st.scheduleSave(); this.renderInspector(); this.editor.render();
        break;
      case 'add-dims': {
        const count = single ? st.addDeviceDimensions(single.id) : 0;
        this.toast(count ? 'Размеры слева и от пола добавлены на лист' : 'Прибор совпадает с краем или полом — размеры не нужны');
        break;
      }
      case 'device-above-channel':
      case 'device-below-channel': {
        if (!single) break;
        const model = getModel(single.modelId);
        const candidates = st.wallChannels.filter((c) => c.points.some((p, i) => i && p[1] === c.points[i - 1][1]));
        if (!candidates.length) break;
        const levels = candidates.flatMap((c) => c.points.slice(1).filter((p, i) => p[1] === c.points[i][1]).map((p) => ({ y: p[1], width: c.width || 40 })));
        const targetY = act === 'device-above-channel' ? single.y : single.y + model.h;
        const nearest = levels.sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY))[0];
        const y = act === 'device-above-channel' ? nearest.y + nearest.width / 2 : nearest.y - nearest.width / 2 - model.h;
        st.updateDevice(single.id, { y });
        break;
      }
      default: break;
    }
  }

  _cableOptions() {
    const set = new Set();
    for (const row of this.store.spec?.cables || []) if (row.model) set.add(String(row.model).trim());
    for (const c of this.store.project.channels) if (c.cableModelId) set.add(c.cableModelId);
    return [...set];
  }

  /* ================= спецификация (BOM) ================= */
  renderSpec() {
    const box = this.$('tab-spec');
    if (!box) return;
    const spec = this.store.spec;
    // позиции, которые заказчик исключил из работы: не показываем их в спецификации/CSV
    const HIDDEN_SPEC = ['ДИП-34', 'ИПР', 'МОЛНИЯ', 'МАЯК', 'КМ-О', 'АКБ', 'DELTA', 'МПН'];
    const isHiddenSpecRow = (row) => {
      const hay = `${row.model || ''} ${row.name || ''}`.toUpperCase();
      return HIDDEN_SPEC.some((k) => hay.includes(k));
    };
    const placed = this.store.placedCountBySpecPos();
    const journal = this.buildJournalRows();
    const cableIf = new Map(journal.totalsByCable.map((r) => [norm(r.cable), r]));
    const rows = [];
    let equipmentCount = 0;

    if (spec?.equipment?.length) {
      for (const row of spec.equipment) {
        if (isHiddenSpecRow(row)) continue;
        const fact = placed.get(+row.pos) || 0;
        equipmentCount += fact;
        rows.push({
          pos: row.pos,
          name: row.name,
          model: row.model,
          vendor: row.vendor,
          unit: row.unit || 'шт.',
          plan: +row.qty || 0,
          fact,
          kind: row.kind || '',
          section: row.group || 'Оборудование',
        });
      }
    } else {
      // без загруженной спецификации — по размещённым моделям
      const counts = this.store.placedCountByModel();
      let i = 0;
      for (const [modelId, count] of counts) {
        const model = getModel(modelId);
        equipmentCount += count;
        rows.push({ pos: ++i, name: model.full, model: model.model, vendor: model.vendor, unit: 'шт.', plan: null, fact: count, kind: model.kind, section: 'Размещено на стенах' });
      }
    }

    const cableRows = [];
    for (const row of spec?.cables || []) {
      const key = norm(row.model || row.name);
      // длина в журнале считается в мм, количество в спецификации — в метрах
      const fact = (cableIf.get(key)?.length || 0) / 1000;
      cableRows.push({ pos: row.pos, name: row.name, model: row.model, vendor: row.vendor, unit: row.unit || 'м', plan: +row.qty || 0, fact, section: row.group || 'Кабельная продукция' });
    }
    if (!cableRows.length) {
      for (const r of journal.totalsByCable) {
        cableRows.push({ pos: cableRows.length + 1, name: `Кабель по кабельному журналу`, model: r.cable, vendor: '—', unit: 'м', plan: null, fact: r.length / 1000, section: 'Кабельная продукция (расчёт)' });
      }
    }

    const materialRows = (spec?.materials || []).map((row) => ({
      pos: row.pos, name: row.name, model: row.model, vendor: row.vendor, unit: row.unit || 'шт.', plan: +row.qty || 0, fact: null, section: row.group || 'Изделия и материалы',
    }));
    const spareRows = (spec?.spares || []).filter((row) => !isHiddenSpecRow(row)).map((row) => ({
      pos: row.pos, name: row.name, model: row.model, vendor: row.vendor, unit: row.unit || 'шт.', plan: +row.qty || 0, fact: placed.get(+row.pos) || 0, section: row.group || 'Запасные изделия и принадлежности',
    }));

    const table = (list, { showFact = true, showPlan = true } = {}) => `<table class="table">
      <thead><tr><th>Поз.</th><th>Наименование и техническая характеристика</th><th>Тип, марка</th><th>Завод</th><th>Ед.</th>${showPlan ? '<th class="num">По спец.</th>' : ''}${showFact ? '<th class="num">Факт</th>' : ''}${showFact && showPlan ? '<th class="num">Расхожд.</th>' : ''}</tr></thead>
      <tbody>${list
        .map((r) => {
          const diff = r.plan != null && r.fact != null ? r.fact - r.plan : null;
          const cls = diff == null ? '' : diff === 0 ? 'ok' : diff < 0 ? 'warn' : 'bad';
          const pill = diff == null ? '' : `<span class="pill ${cls}">${diff > 0 ? '+' : ''}${fmt(diff)}</span>`;
          return `<tr>
            <td class="num">${r.pos ?? ''}</td>
            <td>${escAll(r.name)}</td>
            <td>${escAll(r.model || '')}</td>
            <td>${escAll(r.vendor || '')}</td>
            <td>${escAll(r.unit)}</td>
            ${showPlan ? `<td class="num">${r.plan == null ? '—' : fmt(r.plan)}</td>` : ''}
            ${showFact ? `<td class="num">${r.fact == null ? '—' : fmt(r.fact)}</td>` : ''}
            ${showFact && showPlan ? `<td class="num">${pill}</td>` : ''}
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;

    box.innerHTML = `<div class="prop-title"><h4>Спецификация</h4>
        <span class="badge">${spec ? 'из проекта' : 'по размещённым'}</span></div>
      ${spec ? `<div class="hintline" style="color:#6f86a8;font-size:11.5px;line-height:1.5;margin-bottom:8px">Источник: ${escAll(spec.meta?.docCode || '')} · ${escAll(spec.metaInfo?.source || '')}. «Факт» — количество, размещённое на стенах.</div>` : ''}
      <div class="pal-group-title">Оборудование</div>
      ${table(rows)}
      <div class="pal-group-title">Кабельная продукция</div>
      ${table(cableRows)}
      ${materialRows.length ? `<div class="pal-group-title">Изделия и материалы</div>${table(materialRows, { showFact: false })}` : ''}
      ${spareRows.length ? `<div class="pal-group-title">Запасные изделия</div>${table(spareRows)}` : ''}
      <div class="section-actions">
        <button class="btn tiny" data-spec-act="csv">Экспорт CSV</button>
        <button class="btn tiny" data-spec-act="md">Экспорт Markdown</button>
        <button class="btn tiny" data-spec-act="print">Печать</button>
      </div>`;
    box.querySelectorAll('[data-spec-act]').forEach((b) =>
      b.addEventListener('click', () => this._specExport(b.dataset.specAct, { rows, cableRows, materialRows, spareRows, equipmentCount }))
    );
  }

  _specExport(act, data) {
    const { rows, cableRows, materialRows, spareRows } = data;
    const name = (this.store.project.meta.name || 'project').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
    const header = ['Поз.', 'Наименование', 'Тип, марка', 'Завод', 'Ед.', 'По спецификации', 'Факт', 'Расхождение'];
    const toRow = (r) => [r.pos ?? '', r.name ?? '', r.model ?? '', r.vendor ?? '', r.unit ?? '', r.plan ?? '', r.fact ?? '', r.plan != null && r.fact != null ? r.fact - r.plan : ''];
    if (act === 'csv') {
      const lines = [
        ['Спецификация оборудования, изделий и материалов'],
        [this.store.project.meta.name || ''],
        [],
        ['Оборудование'],
        header, ...rows.map(toRow),
        [],
        ['Кабельная продукция'],
        header, ...cableRows.map(toRow),
      ];
      if (materialRows.length) lines.push([], ['Изделия и материалы'], header, ...materialRows.map(toRow));
      if (spareRows.length) lines.push([], ['Запасные изделия и принадлежности'], header, ...spareRows.map(toRow));
      download(`${name}_спецификация.csv`, toCSV(lines), 'text/csv');
      this.toast('Спецификация выгружена в CSV');
    } else if (act === 'md') {
      const tbl = (list) => ['| Поз. | Наименование | Тип, марка | Завод | Ед. | По спец. | Факт |', '|---:|---|---|---|---:|---:|---:|', ...list.map((r) => `| ${r.pos ?? ''} | ${r.name ?? ''} | ${r.model ?? ''} | ${r.vendor ?? ''} | ${r.unit ?? ''} | ${r.plan ?? ''} | ${r.fact ?? ''} |`)].join('\n');
      const md = [`# Спецификация — ${this.store.project.meta.name || ''}`, '', this.store.project.meta.address || '', '', '## Оборудование', tbl(rows), '', '## Кабельная продукция', tbl(cableRows), materialRows.length ? `\n## Изделия и материалы\n${tbl(materialRows)}` : '', spareRows.length ? `\n## Запасные изделия\n${tbl(spareRows)}` : ''].join('\n');
      download(`${name}_спецификация.md`, md, 'text/markdown');
      this.toast('Спецификация выгружена в Markdown');
    } else if (act === 'print') {
      window.print();
    }
  }

  /* ================= кабельный журнал ================= */
  buildJournalRows() {
    const st = this.store;
    const rows = [];
    for (const c of st.project.channels) {
      const wall = st.project.walls.find((w) => w.id === c.wallId);
      const length = st.channelLength(c);
      rows.push({
        id: c.id,
        wall: wall?.name || '',
        kind: c.kind,
        width: c.width,
        color: c.color || (CHANNEL_KINDS.find((k) => k.id === c.kind) || CHANNEL_KINDS[0]).color,
        cable: c.cableModelId || '',
        length,
      });
    }
    const byCable = new Map();
    for (const r of rows) {
      const key = r.cable || '— не задан —';
      byCable.set(key, (byCable.get(key) || 0) + r.length);
    }
    const totalsByCable = [...byCable.entries()].map(([cable, length]) => ({ cable, length }));
    return {
      rows,
      totalsByCable,
      totals: { length: rows.reduce((a, r) => a + r.length, 0) },
    };
  }

  renderJournal() {
    const box = this.$('tab-journal');
    if (!box) return;
    const { rows, totals, totalsByCable } = this.buildJournalRows();
    const st = this.store;
    box.innerHTML = `<div class="prop-title"><h4>Длина короба</h4><span class="badge">${rows.length} трасс</span></div>
      <div class="hintline" style="color:#6f86a8;font-size:11.5px;line-height:1.5;margin-bottom:8px">
        Длина трассы считается по ломаной линии короба с учётом реальной ширины. Итог — сколько короба нужно закупить.
      </div>
      <table class="table">
        <thead><tr><th>№</th><th>Стена / трасса</th><th>Кабель</th><th class="num">Длина, м</th></tr></thead>
        <tbody>
        ${rows
          .map(
            (r, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td><span class="color-dot" style="background:${r.color}"></span>${escAll(r.wall)}<br><span class="muted">${escAll((CHANNEL_KINDS.find((k) => k.id === r.kind) || CHANNEL_KINDS[0]).label)} · ${r.width ?? ''}</span></td>
          <td>${escAll(r.cable || '—')}</td>
          <td class="num"><b>${(r.length / 1000).toFixed(2)}</b></td>
        </tr>`
          )
          .join('')}
        </tbody>
        <tfoot>
          <tr class="total"><td colspan="3">Итого короба</td><td class="num">${(totals.length / 1000).toFixed(2)} м</td></tr>
        </tfoot>
      </table>
      ${totalsByCable.length ? `<div class="pal-group-title">По маркам кабеля</div>
        <table class="table"><thead><tr><th>Кабель</th><th class="num">Длина, м</th></tr></thead><tbody>
        ${totalsByCable.map((t) => `<tr><td>${escAll(t.cable)}</td><td class="num">${(t.length / 1000).toFixed(2)}</td></tr>`).join('')}
        </tbody></table>` : ''}
      <div class="section-actions">
        <button class="btn tiny" data-journal-act="csv">Экспорт CSV</button>
      </div>`;
    box.querySelectorAll('[data-journal-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const lines = [
          ['Ведомость короба'],
          ['№', 'Стена', 'Тип трассы', 'Кабель', 'Длина, м'],
          ...rows.map((r, i) => [
            i + 1,
            r.wall,
            (CHANNEL_KINDS.find((k) => k.id === r.kind) || CHANNEL_KINDS[0]).label,
            r.cable,
            (r.length / 1000).toFixed(2),
          ]),
          ['', '', '', 'ИТОГО', (totals.length / 1000).toFixed(2)],
        ];
        const name = (st.project.meta.name || 'project').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
        download(`${name}_короб.csv`, toCSV(lines), 'text/csv');
        this.toast('Ведомость короба выгружена');
      })
    );
  }

  /* ================= модальные окна ================= */
  openModal(title, bodyHtml, actions = [], { wide = false } = {}) {
    const modal = this.$('modal');
    const previousFocus = document.activeElement;
    this.$('modal-title').textContent = title;
    const body = this.$('modal-body');
    body.innerHTML = bodyHtml;
    const actionsBox = this.$('modal-actions');
    actionsBox.innerHTML = '';
    const close = () => {
      modal.hidden = true;
      body.innerHTML = '';
      actionsBox.innerHTML = '';
      this._modalClose = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    this._modalClose = close;
    for (const a of actions) {
      const b = el(`<button class="btn ${a.cls || ''}">${escAll(a.label)}</button>`);
      b.addEventListener('click', () => (a.onClick ? a.onClick(close) : close()));
      actionsBox.appendChild(b);
    }
    modal.hidden = false;
    modal.querySelector('.modal')?.classList.toggle('wide', wide);
    const firstInput = body.querySelector('input, select, textarea');
    setTimeout(() => (firstInput || this.$('modal-close'))?.focus(), 30);
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
    return { close };
  }

  confirm(text, onYes, yesLabel = 'Подтвердить') {
    this.openModal('Подтверждение', `<div style="font-size:13px;line-height:1.6">${escAll(text)}</div>`, [
      { label: yesLabel, cls: 'danger', onClick: (close) => { close(); onYes(); } },
      { label: 'Отмена', onClick: (close) => close() },
    ]);
  }

  toast(text, isErr = false) {
    const box = this.$('toast');
    if (!box) return;
    box.textContent = text;
    box.classList.toggle('err', !!isErr);
    box.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (box.hidden = true), 2600);
  }

  /* ================= проверка размещения ================= */
  openIssuesDialog() {
    const st = this.store;
    const issues = st.findPlacementIssues();
    const body = issues.length
      ? `<p class="review-intro">Проверяются габариты приборов и фактическая ширина коробов на активной стене. Выберите строку, чтобы перейти к месту пересечения.</p><div class="review-list">${issues.map((issue, index) => `<button class="review-item" data-review-index="${index}"><span class="review-kind">${issue.type === 'device-device' ? 'Приборы' : 'Прибор и короб'}</span><b>${escAll(issue.message)}</b><span>Показать на листе</span></button>`).join('')}</div>`
      : `<div class="review-empty"><b>Пересечений не найдено</b><p>Габариты приборов и полосы коробов на активной стене не пересекаются.</p></div>`;
    const dialog = this.openModal('Проверка размещения', body, [{ label: 'Закрыть' }]);
    this.$('modal-body')?.querySelectorAll('[data-review-index]').forEach((button) => button.addEventListener('click', () => {
      const issue = st.findPlacementIssues()[+button.dataset.reviewIndex];
      if (!issue) return;
      const id = issue.deviceIds[0];
      const device = st.getDevice(id);
      dialog.close();
      if (device) {
        st.selectOne('device', id);
        const model = getModel(device.modelId);
        this.editor.focusOn(device.x + model.w / 2, device.y + model.h / 2, 1400);
      } else if (issue.channelId) {
        st.selectOne('channel', issue.channelId);
      }
    }));
  }

  /* ================= диалоги стены/проекта ================= */
  openWallDialog(wallId = null) {
    const st = this.store;
    const wall = wallId ? st.project.walls.find((w) => w.id === wallId) : null;
    const body = `<div class="form">
      <label>Название стены<input id="dlg-wall-name" value="${escAll(wall?.name || `Стена ${st.project.walls.length + 1}`)}"></label>
      <div class="row2">
        <label>Длина стены, м<input id="dlg-wall-w" type="number" step="0.1" min="0.5" value="${(wall?.width ?? 6000) / 1000}"></label>
        <label>Высота стены, м<input id="dlg-wall-h" type="number" step="0.1" min="0.5" value="${(wall?.height ?? 2700) / 1000}"></label>
      </div>
      <div class="hintline">Высота 2,7 м — типовая стена офиса; устройства ставятся на любой высоте от пола.</div>
    </div>`;
    this.openModal(wall ? 'Параметры стены' : 'Новая стена', body, [
      {
        label: wall ? 'Применить' : 'Создать',
        cls: 'accent',
        onClick: (close) => {
          const name = document.getElementById('dlg-wall-name').value.trim();
          const width = Math.round((parseFloat(document.getElementById('dlg-wall-w').value) || 6) * 1000);
          const height = Math.round((parseFloat(document.getElementById('dlg-wall-h').value) || 2.7) * 1000);
          close();
          if (wall) st.updateWall(wall.id, { name, width, height });
          else st.addWall({ name, width, height });
          this.editor.fit();
        },
      },
      { label: 'Отмена', onClick: (close) => close() },
    ]);
  }

  openProjectDialog() {
    const st = this.store;
    const m0 = st.project.meta;
    const body = `<div class="form">
      <label>Название проекта<input id="prj-name" value="${escAll(m0.name)}"></label>
      <label>Наименование объекта<input id="prj-object" value="${escAll(m0.object)}"></label>
      <label>Адрес<input id="prj-address" value="${escAll(m0.address)}"></label>
      <div class="row2">
        <label>Организация<input id="prj-contractor" value="${escAll(m0.contractor)}"></label>
        <label>Шифр документа<input id="prj-doc" value="${escAll(m0.doc)}"></label>
      </div>
    </div>`;
    this.openModal('Свойства проекта', body, [
      {
        label: 'Сохранить',
        cls: 'accent',
        onClick: (close) => {
          st.act('свойства проекта', () => {
            st.project.meta.name = document.getElementById('prj-name').value.trim();
            st.project.meta.object = document.getElementById('prj-object').value.trim();
            st.project.meta.address = document.getElementById('prj-address').value.trim();
            st.project.meta.contractor = document.getElementById('prj-contractor').value.trim();
            st.project.meta.doc = document.getElementById('prj-doc').value.trim();
          });
          close();
        },
      },
      { label: 'Отмена', onClick: (close) => close() },
    ]);
  }
}

/** нормализация марки кабеля для сопоставления спецификации и журнала */
function norm(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[\s«»"'()]/g, '')
    .replace(/[хx*]/g, 'x');
}
