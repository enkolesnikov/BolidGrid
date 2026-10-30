/**
 * panels.js — панели интерфейса: палитра устройств, стены, свойства,
 * объединения (шлейфы/линии), спецификация (BOM) и кабельный журнал.
 */
import {
  MODELS, getModel, KIND_LABELS, KIND_ORDER, CHANNEL_KINDS, GROUP_KINDS, GROUP_COLORS,
  modelThumb,
} from './catalog.js';
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
    this.renderLoops();
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
        this.renderLoops();
        this.renderSpec();
        this.renderJournal();
        this.renderWalls();
        this.renderWallTabs();
        break;
      case 'selection':
        this.renderInspector();
        this.renderLoops();
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
      return;
    }
    const devices = this.store.selectedDevices();
    const channels = this.store.selectedChannels();
    const groups = this.store.selectedGroups();
    if (devices.length === 1 && !channels.length && !groups.length) box.innerHTML = this._deviceInspector(devices[0]);
    else if (channels.length === 1 && !devices.length && !groups.length) box.innerHTML = this._channelInspector(channels[0]);
    else if (groups.length === 1 && !devices.length && !channels.length) box.innerHTML = this._groupInspector(groups[0]);
    else box.innerHTML = this._multiInspector(devices, channels, groups);
    this._wireInspector(box);
  }

  _inspectorEmpty() {
    const stats = this._projectStats();
    return `<div class="prop-title"><h4>Проект</h4></div>
      <dl class="kv">
        <dt>Стен</dt><dd>${stats.walls}</dd>
        <dt>Устройств</dt><dd>${stats.devices}</dd>
        <dt>Кабельных каналов</dt><dd>${stats.channels} · ${m(stats.channelLen)}</dd>
        <dt>Опусков</dt><dd>${stats.drops} · ${m(stats.dropLen)}</dd>
        <dt>Объединений</dt><dd>${stats.groups}</dd>
        <dt>Кабеля всего</dt><dd>${m(stats.channelLen + stats.dropLen)}</dd>
      </dl>
      <div class="hintline" style="color:#6f86a8;font-size:11.5px;line-height:1.6">
        Выберите устройство или канал на стене, чтобы изменить параметры.
        Устройства добавляются из палитры слева: нажмите модель, затем кликните на стене.
      </div>`;
  }

  _projectStats() {
    const st = this.store;
    const drops = st.computeDrops();
    const channelLen = st.project.channels.reduce((a, c) => a + st.channelLength(c), 0);
    const dropLen = drops.reduce((a, d) => a + d.length, 0);
    return {
      walls: st.project.walls.length,
      devices: st.project.devices.length,
      channels: st.project.channels.length,
      channelLen,
      drops: drops.length,
      dropLen,
      groups: st.project.groups.length,
    };
  }

  _deviceInspector(d) {
    const model = getModel(d.modelId);
    const modelOptions = MODELS.map(
      (mm2) => `<option value="${mm2.id}" ${mm2.id === model.id ? 'selected' : ''}>${escAll(mm2.name)}</option>`
    ).join('');
    const groups = this.store.project.groups;
    return `<div class="prop-title"><span class="badge">${escAll(d.tag || '—')}</span><h4>${escAll(model.name)}</h4></div>
      <div class="form">
        <div class="row2">
          <label>Обозначение (позиция)<input data-f="tag" value="${escAll(d.tag)}" placeholder="1.1"></label>
          <label>Адрес / шлейф<input data-f="address" value="${escAll(d.address)}" placeholder="ДПЛС 1, адр. 12"></label>
        </div>
        <label>Модель устройства<select data-f="modelId">${modelOptions}</select></label>
        <div class="row2">
          <label>X, мм<input data-f="x" type="number" step="10" value="${Math.round(d.x)}"></label>
          <label>Высота от пола, мм<input data-f="y" type="number" step="10" value="${Math.round(d.y)}"></label>
        </div>
        <div class="row2">
          <label>Поворот<select data-f="rot">
            ${[0, 90, 180, 270].map((r) => `<option value="${r}" ${r === (d.rot || 0) ? 'selected' : ''}>${r}°</option>`).join('')}
          </select></label>
          <label>Габарит, мм<input value="${model.w} × ${model.h}" disabled></label>
        </div>
        <label>Примечание<input data-f="note" value="${escAll(d.note)}" placeholder="прим."></label>
        <label class="switch" style="color:#9fb6d6"><input type="checkbox" data-f="noDrop" ${d.noDrop ? 'checked' : ''}><span>Не подключать к кабель-каналу (без опуска)</span></label>
        <div>
          <div class="pal-group-title">Шлейфы / линии</div>
          ${groups.length ? groups.map((g) => `<label class="switch" style="display:flex;margin:2px 0;color:#cfe0f5"><input type="checkbox" data-group="${g.id}" ${(d.groupIds || []).includes(g.id) ? 'checked' : ''}><span style="color:${g.color}">■</span><span>${escAll(g.name)}</span></label>`).join('') : '<div class="empty">Объединений пока нет.</div>'}
        </div>
        <div class="section-actions">
          <button class="btn tiny" data-act="dup">Дублировать</button>
          <button class="btn tiny" data-act="rotate">Повернуть</button>
          <button class="btn tiny" data-act="focus">Приблизить</button>
          <button class="btn tiny danger" data-act="del">Удалить</button>
        </div>
      </div>`;
  }

  _channelInspector(c) {
    const def = CHANNEL_KINDS.find((k) => k.id === c.kind) || CHANNEL_KINDS[0];
    const cables = this._cableOptions();
    return `<div class="prop-title"><span class="badge">канал</span><h4>${escAll(c.kind)}</h4></div>
      <div class="form">
        <label>Тип трассы<select data-f="kind">${CHANNEL_KINDS.map((k) => `<option value="${k.id}" ${k.id === c.kind ? 'selected' : ''}>${escAll(k.label)}</option>`).join('')}</select></label>
        <div class="row2">
          <label>Ширина, мм<input data-f="width" type="number" step="5" value="${c.width}"></label>
          <label>Длина, мм<input value="${Math.round(this.store.channelLength(c))}" disabled></label>
        </div>
        <label>Кабель<select data-f="cableModelId">
          <option value="">— не задан —</option>
          ${cables.map((v) => `<option value="${escAll(v)}" ${v === c.cableModelId ? 'selected' : ''}>${escAll(v)}</option>`).join('')}
        </select></label>
        <label>Подпись<input data-f="label" value="${escAll(c.label)}" placeholder="Лоток Л-1"></label>
        <div class="hintline">Точек в трассе: ${c.points.length}. Тяните вершины на стене, чтобы изменить трассу.</div>
        <div class="section-actions">
          <button class="btn tiny" data-act="del">Удалить канал</button>
        </div>
      </div>`;
  }

  _groupInspector(g) {
    const members = g.deviceIds.map((id) => this.store.getDevice(id)).filter(Boolean);
    const len = this._groupLength(g);
    return `<div class="prop-title"><span class="badge" style="background:${g.color}22;border-color:${g.color}66;color:${g.color}">${escAll(g.kind)}</span><h4>${escAll(g.name)}</h4></div>
      <div class="form">
        <label>Название<input data-f="name" value="${escAll(g.name)}"></label>
        <label>Вид<select data-f="kind">${GROUP_KINDS.map((k) => `<option value="${k.id}" ${k.id === g.kind ? 'selected' : ''}>${escAll(k.label)}</option>`).join('')}</select></label>
        <div>
          <div class="pal-group-title">Цвет</div>
          <div class="swatches">${GROUP_COLORS.map((col) => `<button class="swatch ${col === g.color ? 'active' : ''}" data-color="${col}" style="background:${col}" title="${col}"></button>`).join('')}</div>
        </div>
        <label>Примечание<input data-f="note" value="${escAll(g.note)}" placeholder="напр. шлейф №1, ДПЛС-1"></label>
        <dl class="kv">
          <dt>Устройств</dt><dd>${members.length}</dd>
          <dt>Длина линий</dt><dd>${m(len)}</dd>
        </dl>
        <div class="pal-group-title">Состав</div>
        <div class="loop-devices">${members.map((d) => `<span class="chip">${escAll(d.tag || getModel(d.modelId).name)}</span>`).join('') || '<span class="empty">пусто</span>'}</div>
        <div class="section-actions">
          <button class="btn tiny" data-act="add-selected">Добавить выбранные устройства</button>
          <button class="btn tiny" data-act="focus">Показать</button>
          <button class="btn tiny danger" data-act="del">Удалить объединение</button>
        </div>
      </div>`;
  }

  _multiInspector(devices, channels, groups) {
    const total = devices.length + channels.length + groups.length;
    return `<div class="prop-title"><h4>Выбрано: ${total}</h4></div>
      <dl class="kv">
        <dt>Устройств</dt><dd>${devices.length}</dd>
        <dt>Каналов</dt><dd>${channels.length}</dd>
        <dt>Объединений</dt><dd>${groups.length}</dd>
      </dl>
      <div class="form">
        <div class="hintline">Shift+клик — добавить/убрать из выделения, рамка — групповое выделение.</div>
        <div class="section-actions">
          <button class="btn tiny" data-act="group">Объединить в шлейф/линию</button>
          <button class="btn tiny" data-act="dup">Дублировать устройства</button>
          <button class="btn tiny" data-act="rotate">Повернуть устройства</button>
          <button class="btn tiny danger" data-act="del">Удалить выделенное</button>
        </div>
      </div>`;
  }

  _wireInspector(box) {
    const st = this.store;
    const devices = st.selectedDevices();
    const single = devices.length === 1 ? devices[0] : null;
    const channel = st.selectedChannels()[0];
    const group = st.selectedGroups()[0];

    box.querySelectorAll('[data-f]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        if (!single) return;
        let v;
        if (inp.type === 'checkbox') v = inp.checked;
        else if (inp.type === 'number') v = parseFloat(inp.value) || 0;
        else v = inp.value;
        st.updateDevice(single.id, { [f]: v });
      });
    });
    box.querySelectorAll('[data-group]').forEach((inp) => {
      inp.addEventListener('change', () => {
        if (!single) return;
        const gid = inp.dataset.group;
        if (inp.checked) st.addDevicesToGroup(gid, [single.id]);
        else st.removeDevicesFromGroup(gid, [single.id]);
      });
    });
    if (channel) {
      box.querySelectorAll('[data-f]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          let v = inp.type === 'number' ? parseFloat(inp.value) || 0 : inp.value;
          st.updateChannel(channel.id, { [f]: v });
        });
      });
    }
    if (group) {
      box.querySelectorAll('[data-f]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          st.updateGroup(group.id, { [f]: inp.value });
        });
      });
      box.querySelectorAll('[data-color]').forEach((sw) => {
        sw.addEventListener('click', () => st.updateGroup(group.id, { color: sw.dataset.color }));
      });
    }

    for (const btn of box.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => this._inspectorAction(btn.dataset.act, { single, channel, group, devices }));
    }
  }

  _inspectorAction(act, { single, channel, group, devices }) {
    const st = this.store;
    switch (act) {
      case 'dup':
        st.duplicateDevices(devices.map((d) => d.id));
        break;
      case 'rotate':
        st.act('поворот устройств', () => {
          for (const d of devices) st.updateDevice(d.id, { rot: ((d.rot || 0) + 90) % 360 }, { commit: false });
        });
        break;
      case 'del':
        st.removeSelection();
        break;
      case 'group':
        this.openGroupDialog(devices.map((d) => d.id));
        break;
      case 'focus':
        if (single) this.editor.focusOn(single.x, single.y, 900);
        if (group) this.editor.focusOnGroup(group);
        break;
      case 'add-selected': {
        if (!group) break;
        const ids = st.selectedDevices().map((d) => d.id);
        if (!ids.length) {
          this.toast('Выделите устройства на стене (Shift+клик) и нажмите снова', true);
          break;
        }
        st.addDevicesToGroup(group.id, ids);
        this.toast(`В «${group.name}» добавлено устройств: ${ids.length}`);
        break;
      }
      default:
        break;
    }
  }

  _cableOptions() {
    const set = new Set();
    for (const row of this.store.spec?.cables || []) if (row.model) set.add(String(row.model).trim());
    for (const c of this.store.project.channels) if (c.cableModelId) set.add(c.cableModelId);
    return [...set];
  }

  _groupLength(g) {
    const pts = g.deviceIds
      .map((id) => this.store.getDevice(id))
      .filter(Boolean)
      .map((d) => {
        const model = getModel(d.modelId);
        return [d.x + model.w / 2, d.y + model.h / 2];
      });
    return pts.length > 1 ? polylineLength(pts) : 0;
  }

  /* ================= шлейфы / линии ================= */
  renderLoops() {
    const box = this.$('tab-loops');
    if (!box) return;
    const groups = this.store.project.groups;
    const head = `<div class="prop-title"><h4>Объединения устройств</h4><span class="badge">${groups.length}</span></div>
      <div class="hintline" style="color:#6f86a8;font-size:11.5px;line-height:1.55;margin-bottom:10px">
        Выделите устройства на стене (рамкой или Shift+клик) и нажмите «Объединить» — они станут шлейфом,
        линией СОУЭ или адресной линией. Устройства одного объединения связаны цветной линией.
      </div>
      <div class="section-actions" style="margin-bottom:10px">
        <button class="btn tiny" data-loop-act="new">Объединить выделенные (${this.store.selectedDevices().length})</button>
      </div>`;
    if (!groups.length) {
      box.innerHTML = head + `<div class="empty">Объединений пока нет. Создайте шлейф из выделенных устройств.</div>`;
      return;
    }
    box.innerHTML = head + groups
      .map((g) => {
        const devs = g.deviceIds.map((id) => this.store.getDevice(id)).filter(Boolean);
        const len = this._groupLength(g);
        return `<div class="loop-card">
          <div class="loop-head"><span class="loop-dot" style="background:${g.color}"></span><b>${escAll(g.name)}</b>
            <span class="pill">${escAll(g.kind)}</span></div>
          <div class="loop-meta"><span>устройств: ${devs.length}</span><span>длина линий: ${m(len)}</span>${g.note ? `<span>${escAll(g.note)}</span>` : ''}</div>
          <div class="loop-devices">${devs.slice(0, 18).map((d) => `<span class="chip">${escAll(d.tag || getModel(d.modelId).name)}</span>`).join('')}${devs.length > 18 ? `<span class="chip">+${devs.length - 18}</span>` : ''}</div>
          <div class="loop-actions">
            <button class="btn tiny" data-loop-act="select" data-id="${g.id}">Выбрать</button>
            <button class="btn tiny" data-loop-act="add" data-id="${g.id}">+ выделенные</button>
            <button class="btn tiny danger" data-loop-act="del" data-id="${g.id}">Удалить</button>
          </div>
        </div>`;
      })
      .join('');
    box.querySelectorAll('[data-loop-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.loopAct;
        const id = b.dataset.id;
        if (act === 'new') this.openGroupDialog(this.store.selectedDevices().map((d) => d.id));
        else if (act === 'select') {
          this.store.selectOne('group', id);
          this.editor.focusOnGroup(this.store.getGroup(id));
        } else if (act === 'add') {
          const g = this.store.getGroup(id);
          const sel = this.store.selectedDevices().map((d) => d.id);
          if (g && sel.length) this.store.addDevicesToGroup(id, sel);
          else this.toast('Сначала выделите устройства на стене');
        } else if (act === 'del') {
          this.confirm(`Удалить объединение «${this.store.getGroup(id)?.name}»?`, () => this.store.removeGroup(id), 'Удалить');
        }
      });
    });
  }

  openGroupDialog(deviceIds = []) {
    const ids = deviceIds.filter((id) => this.store.getDevice(id));
    const n = this.store.project.groups.length;
    const defaultKind = GROUP_KINDS[0];
    const body = `<div class="form">
      <label>Название<input id="grp-name" value="Шлейф ${n + 1}" autofocus></label>
      <label>Вид объединения<select id="grp-kind">${GROUP_KINDS.map((k, i) => `<option value="${k.id}" ${i === 0 ? 'selected' : ''}>${escAll(k.label)}</option>`).join('')}</select></label>
      <div><div class="pal-group-title">Цвет</div><div class="swatches" id="grp-colors">${GROUP_COLORS.map((c, i) => `<button class="swatch ${i === 0 ? 'active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div></div>
      <label>Примечание<input id="grp-note" placeholder="адрес шлейфа, № ДПЛС"></label>
      <div class="hintline">Устройств в объединении: <b>${ids.length}</b>${ids.length ? '' : ' — выделите устройства на стене, чтобы добавить их в шлейф.'}</div>
    </div>`;
    let color = GROUP_COLORS[0];
    this.openModal('Новое объединение устройств', body, [
      {
        label: 'Создать',
        cls: 'accent',
        onClick: (close) => {
          const name = document.getElementById('grp-name').value.trim() || `Шлейф ${n + 1}`;
          const kind = document.getElementById('grp-kind').value;
          const note = document.getElementById('grp-note').value.trim();
          close();
          this.store.createGroup({ name, kind, color, deviceIds: ids, note });
          this.toast(`Объединение «${name}» создано`);
        },
      },
      { label: 'Отмена', onClick: (close) => close() },
    ]);
    const colors = document.getElementById('grp-colors');
    colors?.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-color]');
      if (!sw) return;
      color = sw.dataset.color;
      colors.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === sw));
    });
  }

  /* ================= спецификация (BOM) ================= */
  renderSpec() {
    const box = this.$('tab-spec');
    if (!box) return;
    const spec = this.store.spec;
    const placed = this.store.placedCountBySpecPos();
    const drops = this.store.computeDrops();
    const journal = this.buildJournalRows();
    const cableIf = new Map(journal.totalsByCable.map((r) => [norm(r.cable), r]));
    const rows = [];
    let equipmentCount = 0;

    if (spec?.equipment?.length) {
      for (const row of spec.equipment) {
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
    const spareRows = (spec?.spares || []).map((row) => ({
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
    const drops = st.computeDrops();
    const dropByChannel = new Map();
    for (const d of drops) {
      if (!dropByChannel.has(d.channelId)) dropByChannel.set(d.channelId, { count: 0, length: 0 });
      const acc = dropByChannel.get(d.channelId);
      acc.count++;
      acc.length += d.length;
    }
    const rows = [];
    for (const c of st.project.channels) {
      const wall = st.project.walls.find((w) => w.id === c.wallId);
      const acc = dropByChannel.get(c.id) || { count: 0, length: 0 };
      rows.push({
        id: c.id,
        wall: wall?.name || '',
        kind: c.kind,
        cable: c.cableModelId || '',
        label: c.label || '',
        length: st.channelLength(c),
        drops: acc.count,
        dropLength: acc.length,
        total: st.channelLength(c) + acc.length,
      });
    }
    const byCable = new Map();
    for (const r of rows) {
      const key = r.cable || '— не задан —';
      byCable.set(key, (byCable.get(key) || 0) + r.total);
    }
    const totalsByCable = [...byCable.entries()].map(([cable, length]) => ({ cable, length }));
    return {
      rows,
      totalsByCable,
      totals: {
        length: rows.reduce((a, r) => a + r.length, 0),
        drops: rows.reduce((a, r) => a + r.drops, 0),
        dropLength: rows.reduce((a, r) => a + r.dropLength, 0),
        total: rows.reduce((a, r) => a + r.total, 0),
      },
    };
  }

  renderJournal() {
    const box = this.$('tab-journal');
    if (!box) return;
    const { rows, totals, totalsByCable } = this.buildJournalRows();
    const st = this.store;
    box.innerHTML = `<div class="prop-title"><h4>Кабельный журнал</h4><span class="badge">${rows.length} трасс</span></div>
      <div class="hintline" style="color:#6f86a8;font-size:11.5px;line-height:1.5;margin-bottom:8px">
        Длина трассы считается по ломаной канала; опуски — кратчайшее расстояние от нижней точки устройства до канала.
      </div>
      <table class="table">
        <thead><tr><th>№</th><th>Стена / тип</th><th>Кабель</th><th class="num">Трасса, м</th><th class="num">Опусков</th><th class="num">Опуски, м</th><th class="num">Итого, м</th></tr></thead>
        <tbody>
        ${rows
          .map(
            (r, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td>${escAll(r.wall)}<br><span class="muted">${escAll(r.kind)}${r.label ? ` · ${escAll(r.label)}` : ''}</span></td>
          <td>${escAll(r.cable || '—')}</td>
          <td class="num">${(r.length / 1000).toFixed(2)}</td>
          <td class="num">${r.drops}</td>
          <td class="num">${(r.dropLength / 1000).toFixed(2)}</td>
          <td class="num"><b>${(r.total / 1000).toFixed(2)}</b></td>
        </tr>`
          )
          .join('')}
        </tbody>
        <tfoot>
          <tr class="total"><td colspan="3">Итого по проекту</td><td class="num">${(totals.length / 1000).toFixed(2)}</td><td class="num">${totals.drops}</td><td class="num">${(totals.dropLength / 1000).toFixed(2)}</td><td class="num">${(totals.total / 1000).toFixed(2)}</td></tr>
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
          ['Кабельный журнал'],
          ['№', 'Стена', 'Тип трассы', 'Кабель', 'Трасса, м', 'Опусков', 'Опуски, м', 'Итого, м'],
          ...rows.map((r, i) => [i + 1, r.wall, r.kind, r.cable, (r.length / 1000).toFixed(2), r.drops, (r.dropLength / 1000).toFixed(2), (r.total / 1000).toFixed(2)]),
          ['', '', '', 'ИТОГО', (totals.length / 1000).toFixed(2), totals.drops, (totals.dropLength / 1000).toFixed(2), (totals.total / 1000).toFixed(2)],
        ];
        const name = (st.project.meta.name || 'project').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
        download(`${name}_кабельный_журнал.csv`, toCSV(lines), 'text/csv');
        this.toast('Кабельный журнал выгружен');
      })
    );
  }

  /* ================= модальные окна ================= */
  openModal(title, bodyHtml, actions = [], { wide = false } = {}) {
    const modal = this.$('modal');
    this.$('modal-title').textContent = title;
    const body = this.$('modal-body');
    body.innerHTML = bodyHtml;
    const actionsBox = this.$('modal-actions');
    actionsBox.innerHTML = '';
    const close = () => {
      modal.hidden = true;
      body.innerHTML = '';
      actionsBox.innerHTML = '';
    };
    for (const a of actions) {
      const b = el(`<button class="btn ${a.cls || ''}">${escAll(a.label)}</button>`);
      b.addEventListener('click', () => (a.onClick ? a.onClick(close) : close()));
      actionsBox.appendChild(b);
    }
    modal.hidden = false;
    modal.querySelector('.modal')?.classList.toggle('wide', wide);
    const firstInput = body.querySelector('input, select, textarea');
    setTimeout(() => firstInput?.focus(), 30);
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

  /* ================= диалоги стены/проекта ================= */
  openWallDialog(wallId = null) {
    const st = this.store;
    const wall = wallId ? st.project.walls.find((w) => w.id === wallId) : null;
    const body = `<div class="form">
      <label>Название стены<input id="wall-name" value="${escAll(wall?.name || `Стена ${st.project.walls.length + 1}`)}"></label>
      <div class="row2">
        <label>Длина стены, м<input id="wall-w" type="number" step="0.1" min="0.5" value="${(wall?.width ?? 6000) / 1000}"></label>
        <label>Высота стены, м<input id="wall-h" type="number" step="0.1" min="0.5" value="${(wall?.height ?? 2700) / 1000}"></label>
      </div>
      <div class="hintline">Высота 2,7 м — типовая стена офиса; устройства ставятся на любой высоте от пола.</div>
    </div>`;
    this.openModal(wall ? 'Параметры стены' : 'Новая стена', body, [
      {
        label: wall ? 'Применить' : 'Создать',
        cls: 'accent',
        onClick: (close) => {
          const name = document.getElementById('wall-name').value.trim();
          const width = Math.round((parseFloat(document.getElementById('wall-w').value) || 6) * 1000);
          const height = Math.round((parseFloat(document.getElementById('wall-h').value) || 2.7) * 1000);
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
