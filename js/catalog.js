/**
 * catalog.js — библиотека устройств для расстановки на стене.
 *
 * Модели из спецификации проекта ДФО .... СПС.СОУЭ (г. Елизово, ул. Ленина, д.15а):
 * позиции 1–12 совпадают с таблицей «Спецификация оборудования, изделий и материалов»
 * (лист 9.1), поэтому у моделей есть поле specPos.
 * Дополнительно добавлены типовые устройства БОЛИД и прочие, которых нет в этой
 * спецификации (specPos: null) — их можно ставить на стену вручную.
 *
 * Единицы: миллиметры. Габариты (w, h) — монтажный габарит устройства на стене.
 */

export const KIND_LABELS = {
  ppkup: 'Приборы приёмно-контрольные',
  detektor_dym: 'Извещатели дымовые',
  detektor_ruchn: 'Извещатели ручные',
  opoveshchatel_svet: 'Оповещатели световые',
  opoveshchatel_zvuk: 'Оповещатели звуковые',
  blok_sp: 'Блоки сигнально-пусковые',
  blok_kpb: 'Блоки контрольно-пусковые',
  rasshiritel: 'Расширители адресные',
  modul: 'Модули',
  bp: 'Питание, АКБ',
  korobka: 'Коробки, крепление',
  other: 'Прочие устройства',
};

export const KIND_COLORS = {
  ppkup: '#0ea5e9',
  detektor_dym: '#f59e0b',
  detektor_ruchn: '#ef4444',
  opoveshchatel_svet: '#22c55e',
  opoveshchatel_zvuk: '#a855f7',
  blok_sp: '#0891b2',
  blok_kpb: '#0d9488',
  rasshiritel: '#6366f1',
  modul: '#14b8a6',
  bp: '#64748b',
  korobka: '#94a3b8',
  other: '#475569',
};

export const KIND_ORDER = [
  'ppkup', 'detektor_dym', 'detektor_ruchn', 'opoveshchatel_svet', 'opoveshchatel_zvuk',
  'blok_sp', 'blok_kpb', 'rasshiritel', 'modul', 'bp', 'korobka', 'other',
];

/* ---------- примитивы отрисовки (SVG, координаты 0..w/0..h, y вниз) ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const R = (x, y, w, h, o = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 0}" fill="${o.fill ?? '#fff'}" stroke="${o.stroke ?? '#334155'}" stroke-width="${o.sw ?? 3}"/>`;
const C = (cx, cy, r, o = {}) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${o.fill ?? '#fff'}" stroke="${o.stroke ?? '#334155'}" stroke-width="${o.sw ?? 3}"/>`;
const T = (x, y, size, text, o = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${o.fill ?? '#0f172a'}" text-anchor="${o.anchor ?? 'middle'}"` +
  `${o.weight ? ` font-weight="${o.weight}"` : ''}${o.mono ? ' font-family="ui-monospace,monospace"' : ''}>${esc(text)}</text>`;
const L = (x1, y1, x2, y2, o = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.stroke ?? '#334155'}" stroke-width="${o.sw ?? 2.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const P = (d, o = {}) =>
  `<path d="${d}" fill="${o.fill ?? 'none'}" stroke="${o.stroke ?? '#334155'}" stroke-width="${o.sw ?? 3}" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
/** ряд клемм вдоль нижнего края блока */
const terminals = (w, h, n, size = 14) => {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = (w / (n + 1)) * (i + 1);
    out += `<rect x="${x - size / 2}" y="${h - size - 4}" width="${size}" height="${size}" rx="2" fill="#e2e8f0" stroke="#334155" stroke-width="2"/>`;
  }
  return out;
};

/* ---------- символы ---------- */
const SYMBOLS = {
  sirius: (w, h) => {
    const p = 0.06 * w;
    return R(0, 0, w, h, { rx: 8, fill: '#f8fafc' }) + R(p, p, w - 2 * p, h * 0.42, { rx: 4, fill: '#0f2b46', stroke: '#334155' }) +
      L(p, h * 0.42 + p * 1.6, w - p, h * 0.42 + p * 1.6, { stroke: '#94a3b8', sw: 2 }) +
      R(p * 1.4, h * 0.52, w * 0.44, h * 0.2, { rx: 3, fill: '#e2e8f0', stroke: '#94a3b8', sw: 2 }) +
      C(w * 0.78, h * 0.62, w * 0.055, { fill: '#22c55e', stroke: '#166534', sw: 2 }) +
      C(w * 0.78, h * 0.62, w * 0.055, { fill: 'none', stroke: '#166534', sw: 2 }) +
      T(w / 2, h * 0.9, w * 0.11, 'СИРИУС', { weight: 700, fill: '#334155' });
  },
  s2000m: (w, h) => R(0, 0, w, h, { rx: 8, fill: '#f8fafc' }) +
    R(w * 0.08, h * 0.06, w * 0.84, h * 0.32, { rx: 4, fill: '#0b3b2e', stroke: '#334155' }) +
    T(w / 2, h * 0.76, w * 0.11, 'С2000М', { weight: 700, fill: '#334155' }),
  dip34a: (w, h) => C(w / 2, h / 2, w * 0.47, { fill: '#fffbeb', stroke: '#b45309', sw: 3.5 }) +
    C(w / 2, h / 2, w * 0.28, { fill: '#fff', stroke: '#b45309', sw: 3 }) +
    C(w / 2, h / 2, w * 0.12, { fill: '#f59e0b', stroke: '#92400e', sw: 2.5 }) +
    L(w * 0.5, h * 0.04, w * 0.5, h * 0.13, { stroke: '#b45309', sw: 3 }),
  ipr513: (w, h) => R(w * 0.03, h * 0.03, w * 0.94, h * 0.94, { rx: 6, fill: '#fef2f2', stroke: '#b91c1c', sw: 3.5 }) +
    R(w * 0.16, h * 0.16, w * 0.68, h * 0.68, { rx: 3, fill: '#fff', stroke: '#b91c1c', sw: 2.5 }) +
    C(w / 2, h * 0.44, w * 0.1, { fill: '#ef4444', stroke: '#7f1d1d', sw: 2 }) +
    L(w / 2, h * 0.54, w / 2, h * 0.78, { stroke: '#b91c1c', sw: 5 }),
  molnia: (w, h, txt, color = '#16a34a') => R(0, 0, w, h, { rx: 5, fill: '#f0fdf4', stroke: color, sw: 3.5 }) +
    R(w * 0.04, h * 0.1, w * 0.2, h * 0.8, { rx: 3, fill: '#dcfce7', stroke: color, sw: 2 }) +
    T(w * 0.58, h * 0.62, h * 0.34, txt, { fill: '#14532d', weight: 700 }) +
    P(`M${w * 0.28} ${h * 0.5} l${w * 0.1} -${h * 0.2} v${h * 0.14} h${w * 0.06} l-${w * 0.1} ${h * 0.24} v-${h * 0.14} z`,
      { fill: color, stroke: color, sw: 1 }),
  mayak: (w, h) => P(`M${w * 0.12} ${h * 0.18} h${w * 0.5} l${w * 0.28} -${h * 0.1} v${h * 0.66} l-${w * 0.28} -${h * 0.1} h-${w * 0.5} z`,
    { fill: '#faf5ff', stroke: '#7e22ce', sw: 3.5 }) +
    R(w * 0.12, h * 0.18, w * 0.08, h * 0.46, { fill: '#a855f7', stroke: '#6b21a8', sw: 2 }) +
    P(`M${w * 0.82} ${h * 0.28} q${w * 0.1} ${h * 0.22} 0 ${h * 0.44}`, { stroke: '#a855f7', sw: 3 }) +
    P(`M${w * 0.9} ${h * 0.18} q${w * 0.12} ${h * 0.32} 0 ${h * 0.64}`, { stroke: '#a855f7', sw: 2.5 }),
  block: (w, h, label, color, nTerm = 4) => R(0, 0, w, h, { rx: 5, fill: '#f0f9ff', stroke: color, sw: 3.5 }) +
    R(w * 0.06, h * 0.08, w * 0.88, h * 0.42, { rx: 3, fill: '#fff', stroke: color, sw: 2 }) +
    T(w / 2, h * 0.4, h * 0.22, label, { fill: '#0c4a6e', weight: 700 }) + terminals(w, h, nTerm),
  korobka: (w, h) => R(w * 0.06, h * 0.06, w * 0.88, h * 0.88, { rx: 8, fill: '#f8fafc', stroke: '#475569', sw: 3.5 }) +
    C(w / 2, h / 2, w * 0.16, { fill: '#e2e8f0', stroke: '#475569', sw: 2 }) +
    L(w * 0.2, h * 0.2, w * 0.8, h * 0.8, { stroke: '#94a3b8', sw: 2, dash: '8 6' }),
  akb: (w, h) => R(0, h * 0.12, w, h * 0.76, { rx: 6, fill: '#f1f5f9', stroke: '#334155', sw: 3.5 }) +
    R(w * 0.22, h * 0.02, w * 0.16, h * 0.12, { rx: 2, fill: '#94a3b8', stroke: '#334155', sw: 2 }) +
    R(w * 0.62, h * 0.02, w * 0.16, h * 0.12, { rx: 2, fill: '#94a3b8', stroke: '#334155', sw: 2 }) +
    T(w * 0.3, h * 0.36, h * 0.16, '+', { fill: '#334155', weight: 700 }) +
    T(w * 0.7, h * 0.36, h * 0.16, '−', { fill: '#334155', weight: 700 }) +
    T(w / 2, h * 0.7, h * 0.13, '12 В', { fill: '#475569' }),
  generic: (w, h, label = '?') => R(0, 0, w, h, { rx: 8, fill: '#f8fafc', stroke: '#475569', sw: 3, dash: '10 7' }) +
    T(w / 2, h * 0.62, h * 0.34, label, { fill: '#475569', weight: 700 }),
  socket: (w, h) => R(0, 0, w, h, { rx: 6, fill: '#f8fafc' }) +
    C(w / 2, h / 2, w * 0.32, { fill: '#fff', stroke: '#334155', sw: 3.5 }) +
    C(w * 0.38, h * 0.5, w * 0.05, { fill: '#334155', stroke: '#334155', sw: 1 }) +
    C(w * 0.62, h * 0.5, w * 0.05, { fill: '#334155', stroke: '#334155', sw: 1 }),
  switch: (w, h) => R(0, 0, w, h, { rx: 5, fill: '#f8fafc' }) +
    R(w * 0.08, h * 0.2, w * 0.84, h * 0.6, { rx: 4, fill: '#e2e8f0', stroke: '#334155', sw: 2.5 }) +
    [0.2, 0.4, 0.6, 0.8].map((k) => P(`M${w * k} ${h * 0.32} l${w * 0.06} ${h * 0.18} l-${w * 0.12} 0 z`, { fill: '#94a3b8', stroke: '#334155', sw: 1.5 })).join(''),
  rip: (w, h) => R(0, 0, w, h, { rx: 6, fill: '#f8fafc' }) +
    R(w * 0.08, h * 0.08, w * 0.84, h * 0.34, { rx: 3, fill: '#0f172a', stroke: '#334155', sw: 2 }) +
    R(w * 0.1, h * 0.56, w * 0.35, h * 0.3, { rx: 3, fill: '#fef3c7', stroke: '#b45309', sw: 2 }) +
    T(w * 0.66, h * 0.78, h * 0.2, 'РИП', { fill: '#334155', weight: 700 }),
};

/** Вернуть SVG-разметку символа модели в габарите 0..w / 0..h. */
export function symbolMarkup(model) {
  const w = model.w, h = model.h;
  const color = KIND_COLORS[model.kind] || '#475569';
  switch (model.symbol) {
    case 'sirius': return SYMBOLS.sirius(w, h);
    case 's2000m': return SYMBOLS.s2000m(w, h);
    case 'dip': return SYMBOLS.dip34a(w, h);
    case 'ipr': return SYMBOLS.ipr513(w, h);
    case 'molnia': return SYMBOLS.molnia(w, h, model.tagText || 'ВЫХОД');
    case 'mayak': return SYMBOLS.mayak(w, h);
    case 'block': return SYMBOLS.block(w, h, model.tagText || '', color, model.terminals || 4);
    case 'korobka': return SYMBOLS.korobka(w, h);
    case 'akb': return SYMBOLS.akb(w, h);
    case 'socket': return SYMBOLS.socket(w, h);
    case 'switch': return SYMBOLS.switch(w, h);
    case 'rip': return SYMBOLS.rip(w, h);
    default: return SYMBOLS.generic(w, h, model.tagText || '?');
  }
}

/** Миниатюра для палитры. */
export function modelThumb(model, size = 40) {
  const pad = Math.max(model.w, model.h) * 0.12;
  return `<svg viewBox="${-pad} ${-pad} ${model.w + 2 * pad} ${model.h + 2 * pad}" width="${size}" height="${(size * model.h) / model.w}" preserveAspectRatio="xMidYMid meet">${symbolMarkup(model)}</svg>`;
}

/* ---------- модели ---------- */
const M = (o) => ({
  w: 150, h: 110, unit: 'шт.', specPos: null, mount: 'wall', ...o,
});

export const MODELS = [
  /* --- позиции спецификации 1–12 --- */
  M({
    id: 'sirius', specPos: 1, kind: 'ppkup', symbol: 'sirius', w: 300, h: 355,
    name: 'ППКУП «Сириус»', model: 'ППКУП «Сириус»',
    full: 'Прибор приёмно-контрольный и управления пожарный «Сириус»',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'dip34a', specPos: 2, kind: 'detektor_dym', symbol: 'dip', w: 100, h: 100, hidden: true,
    name: 'ДИП-34А-04', model: 'ДИП-34А-04',
    full: 'Извещатель пожарный дымовой оптико-электронный адресный ДИП-34А-04',
    vendor: 'ЗАО НВП «БОЛИД»', mount: 'ceiling',
  }),
  M({
    id: 'ipr513', specPos: 3, kind: 'detektor_ruchn', symbol: 'ipr', w: 95, h: 95, hidden: true,
    name: 'ИПР-513-3АМ исп.01', model: 'ИПР-513-3АМ исп.01',
    full: 'Извещатель пожарный ручной адресный ИПР-513-3АМ исп.01',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'sp2', specPos: 4, kind: 'blok_sp', symbol: 'block', tagText: 'СП2', terminals: 4, w: 156, h: 107,
    name: 'С2000-СП2', model: 'С2000-СП2',
    full: 'Блок сигнально-пусковой адресный С2000-СП2',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'sp4_220', specPos: 5, kind: 'blok_kpb', symbol: 'block', tagText: 'СП4/220', terminals: 4, w: 220, h: 180,
    name: 'С2000-СП4/220 исп.01', model: 'С2000-СП4/220 исп.01',
    full: 'Блок контрольно-пусковой адресный С2000-СП4/220 исп.01',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'ar2', specPos: 6, kind: 'rasshiritel', symbol: 'block', tagText: 'АР2', terminals: 2, w: 156, h: 107,
    name: 'С2000-АР2 исп.02', model: 'С2000-АР2 исп.02',
    full: 'Адресный расширитель С2000-АР2 исп.02',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'mpn', specPos: 7, kind: 'modul', symbol: 'block', tagText: 'МПН', terminals: 2, w: 100, h: 70,
    name: 'МПН', model: 'МПН',
    full: 'Модуль подключения нагрузки МПН',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'molnia_exit', specPos: 8, kind: 'opoveshchatel_svet', symbol: 'molnia', tagText: 'ВЫХОД', w: 235, h: 95,
    name: 'Молния-24 Ultra «ВЫХОД»', model: 'Молния-24 Ultra',
    full: 'Оповещатель охранно-пожарный световой «ВЫХОД» Молния-24 Ultra',
    vendor: 'ИП Раченков А. В.',
  }),
  M({
    id: 'molnia_dir', specPos: 9, kind: 'opoveshchatel_svet', symbol: 'molnia', tagText: '→', w: 235, h: 95,
    name: 'Молния-24 Ultra «НАПРАВЛЕНИЕ»', model: 'Молния-24 Ultra',
    full: 'Оповещатель охранно-пожарный световой «НАПРАВЛЕНИЕ ДВИЖЕНИЯ» Молния-24 Ultra',
    vendor: 'ИП Раченков А. В.',
  }),
  M({
    id: 'mayak', specPos: 10, kind: 'opoveshchatel_zvuk', symbol: 'mayak', w: 95, h: 115,
    name: 'Маяк-24-3М', model: 'Маяк-24-3М',
    full: 'Оповещатель охранно-пожарный звуковой Маяк-24-3М',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'kmo2k', specPos: 11, kind: 'korobka', symbol: 'korobka', w: 100, h: 100,
    name: 'КМ-О(2К) исп.1', model: 'КМ-О(2К) исп.1',
    full: 'Коробка монтажная огнестойкая КМ-О(2К) исп.1',
    vendor: 'ЛТ «ГЕФЕСТ»',
  }),
  M({
    id: 'akb', specPos: 12, kind: 'bp', symbol: 'akb', w: 181, h: 167,
    name: 'АКБ 12 В, 18 Ач', model: 'Delta HRL 12-18',
    full: 'Аккумуляторная батарея 12 В, 18 Ач Delta HRL 12-18',
    vendor: 'Delta',
  }),

  /* --- дополнительные устройства вне спецификации --- */
  M({
    id: 'kdl', kind: 'rasshiritel', symbol: 'block', tagText: 'КДЛ', terminals: 2, w: 156, h: 107,
    name: 'С2000-КДЛ', model: 'С2000-КДЛ',
    full: 'Контроллер двухпроводной линии С2000-КДЛ',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'sp1', kind: 'blok_sp', symbol: 'block', tagText: 'СП1', terminals: 2, w: 156, h: 107,
    name: 'С2000-СП1 исп.02', model: 'С2000-СП1 исп.02',
    full: 'Блок сигнально-пусковой адресный С2000-СП1 исп.02',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 's2000m', kind: 'ppkup', symbol: 's2000m', w: 245, h: 300,
    name: 'С2000М', model: 'С2000М',
    full: 'Пульт контроля и управления С2000М',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'rip12', kind: 'bp', symbol: 'rip', w: 255, h: 190,
    name: 'РИП-12 исп.50', model: 'РИП-12 исп.50',
    full: 'Резервированный источник питания РИП-12 исп.50',
    vendor: 'ЗАО НВП «БОЛИД»',
  }),
  M({
    id: 'bp12', kind: 'bp', symbol: 'rip', w: 250, h: 190,
    name: 'Блок питания 12 В / 5 А', model: 'БП 12/5',
    full: 'Блок питания резервированный 12 В, 5 А',
    vendor: '—',
  }),
  M({
    id: 'switch', kind: 'other', symbol: 'switch', w: 250, h: 150,
    name: 'Коммутатор / прочее', model: '—',
    full: 'Коммутатор сети, прочее оборудование',
    vendor: '—',
  }),
  M({
    id: 'socket', kind: 'other', symbol: 'socket', w: 80, h: 80,
    name: 'Розетка 220 В', model: 'РС 220',
    full: 'Розетка электрическая 220 В',
    vendor: '—',
  }),
  M({
    id: 'custom', kind: 'other', symbol: 'generic', w: 150, h: 150,
    name: 'Прочее устройство', model: '—',
    full: 'Прочее устройство (размеры и наименование задаются в свойствах)',
    vendor: '—',
  }),
];

export const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id) {
  return MODEL_BY_ID.get(id) || MODEL_BY_ID.get('custom');
}

/** Модели, сгруппированные для палитры (по порядку KIND_ORDER). */
export function modelsByKind() {
  const groups = new Map();
  for (const m of MODELS) {
    if (!groups.has(m.kind)) groups.set(m.kind, []);
    groups.get(m.kind).push(m);
  }
  return KIND_ORDER.filter((k) => groups.has(k)).map((k) => ({ kind: k, label: KIND_LABELS[k], models: groups.get(k) }));
}

/** Типы кабельных каналов / трасс. */
export const CHANNEL_KINDS = [
  { id: 'кабель-канал', label: 'Короб DKC 100×40', width: 100, color: '#94a3b8' },
  { id: 'короб-60', label: 'Короб DKC 60×40', width: 60, color: '#9aa9bb' },
  { id: 'короб-40', label: 'Короб DKC 40×25', width: 40, color: '#a3b2c4' },
  { id: 'лоток', label: 'Лоток металлический 100', width: 100, color: '#7c8fa8' },
  { id: 'гофра', label: 'Гофротруба Ø20', width: 20, color: '#a3b2c4' },
  { id: 'труба', label: 'Труба стальная Ø25', width: 25, color: '#8b9bb0' },
];

/** Допустимые id типов трасс (для валидации импорта). */
export const CHANNEL_KIND_IDS = CHANNEL_KINDS.map((k) => k.id);

/** Цвета короба (быстрый выбор в свойствах трассы). */
export const CHANNEL_COLORS = ['#94a3b8', '#64748b', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#475569'];
