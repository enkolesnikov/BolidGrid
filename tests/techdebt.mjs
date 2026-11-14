/**
 * tests/techdebt.mjs — проверки техдолга Store/sanitizeProject/util без браузера.
 *
 * Запуск: node tests/techdebt.mjs
 * Тест не требует Playwright и localStorage браузера: при необходимости
 * localStorage подменяется in-memory polyfill'ом. Ненулевой код возврата — провал.
 */
import assert from 'node:assert/strict';
import {
  Store,
  createProject,
  sanitizeProject,
  sanitizeSettings,
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  LS_KEY,
} from '../js/store.js';
import { uid, mm } from '../js/util.js';

/* ---------- минимальный localStorage ---------- */
const memory = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (memory.has(String(key)) ? memory.get(String(key)) : null),
    setItem: (key, value) => { memory.set(String(key), String(value)); },
    removeItem: (key) => { memory.delete(String(key)); },
    clear: () => { memory.clear(); },
  },
});

/** Store без таймера автосохранения: тест не ждёт setTimeout. */
function newStore() {
  const store = new Store();
  store.scheduleSave = () => {};
  return store;
}

/** Ожидаемые console.warn от битых сохранений не должны шуметь в выводе теста. */
function withoutWarn(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

/** Один проект с валидной стеной, прибором, коробом, размером и связью. */
function validProject(overrides = {}) {
  return {
    version: 1,
    meta: { name: 'Тестовый проект', address: 'г. Тест' },
    walls: [{ id: 'w1', name: 'Стена 1', width: 4000, height: 2700 }],
    devices: [
      { id: 'd1', modelId: 'sp2', wallId: 'w1', x: 100, y: 200, rot: 0, tag: '1.1' },
      { id: 'd2', modelId: 'sp2', wallId: 'w1', x: 600, y: 200, rot: 0, tag: '1.2' },
      { id: 'd3', modelId: 'sp2', wallId: 'w1', x: 1100, y: 200, rot: 0, tag: '1.3' },
    ],
    channels: [
      { id: 'c1', wallId: 'w1', kind: 'dkc', width: 100, points: [[100, 100], [2000, 100]], color: '#f8fafc' },
    ],
    dimensions: [
      { id: 'dim1', wallId: 'w1', a: [0, 200], b: [100, 200], text: '', offset: -55 },
    ],
    connections: [
      { id: 'k1', from: { deviceId: 'd1', terminalId: 't1' }, to: { deviceId: 'd2', terminalId: 't1' }, cableModelId: 'kps-2x075' },
    ],
    ...overrides,
  };
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`FAIL ${name}`);
    console.error(`     ${err && err.message ? err.message : err}`);
  }
}

const ids = (items) => items.map((item) => item.id);
const assertUnique = (items, label) => {
  const list = ids(items);
  assert.equal(new Set(list).size, list.length, `${label}: повторяются id — ${JSON.stringify(list)}`);
};

/* ==================== 1. валидный проект ==================== */
test('валидный проект: состав и id сохраняются', () => {
  const out = sanitizeProject(validProject());
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.walls.length, 1);
  assert.equal(out.walls[0].id, 'w1');
  assert.equal(out.walls[0].width, 4000);
  assert.deepEqual(ids(out.devices), ['d1', 'd2', 'd3']);
  assert.deepEqual(ids(out.channels), ['c1']);
  assert.deepEqual(ids(out.dimensions), ['dim1']);
  assert.deepEqual(ids(out.connections), ['k1']);
  assert.equal(out.connections[0].wallId, 'w1');
  assert.equal(out.connections[0].cableModelId, 'kps-2x075');
  assert.equal(out.meta.name, 'Тестовый проект');
  assert.equal(out.meta.address, 'г. Тест');
});

test('валидный проект: createProject проходит sanitize без потерь', () => {
  const project = createProject();
  const out = sanitizeProject(project);
  assert.deepEqual(out.meta, project.meta);
  assert.equal(out.walls.length, 1);
  assert.equal(out.walls[0].id, project.walls[0].id);
});

/* ==================== 2. дубликаты id ==================== */
test('дубли id: стены, приборы, короба, размеры — новые id, объекты целы', () => {
  const out = sanitizeProject({
    walls: [
      { id: 'dup', name: 'A', width: 4000, height: 2700 },
      { id: 'dup', name: 'B', width: 4000, height: 2700 },
    ],
    devices: [
      { id: 'd', modelId: 'sp2', wallId: 'dup', x: 10, y: 10 },
      { id: 'd', modelId: 'sp2', wallId: 'dup', x: 300, y: 10 },
    ],
    channels: [
      { id: 'c', wallId: 'dup', kind: 'dkc', points: [[0, 0], [100, 0]] },
      { id: 'c', wallId: 'dup', kind: 'dkc', points: [[0, 100], [100, 100]] },
    ],
    dimensions: [
      { id: 'dim', wallId: 'dup', a: [0, 0], b: [10, 0] },
      { id: 'dim', wallId: 'dup', a: [0, 10], b: [20, 10] },
    ],
    connections: [
      { id: 'k', from: { deviceId: 'd', terminalId: 't1' }, to: { deviceId: 'd', terminalId: 't1' } },
      { id: 'k', from: { deviceId: 'd', terminalId: 't1' }, to: { deviceId: 'd', terminalId: 't1' } },
    ],
  });
  assert.equal(out.walls.length, 2, 'вторая стена не потеряна');
  assert.equal(out.devices.length, 2, 'второй прибор не потерян');
  assert.equal(out.channels.length, 2);
  assert.equal(out.dimensions.length, 2);
  assertUnique(out.walls, 'walls');
  assertUnique(out.devices, 'devices');
  assertUnique(out.channels, 'channels');
  assertUnique(out.dimensions, 'dimensions');
  // оба прибора ссылаются на существующую стену
  for (const d of out.devices) assert.ok(out.walls.some((w) => w.id === d.wallId));
  // связь прибор-в-самого-себя недействительна независимо от дублей id
  assert.equal(out.connections.length, 0);
});

test('дубли id связей: уникальные id, связи на сохранённые приборы', () => {
  const out = sanitizeProject(validProject({
    connections: [
      { id: 'k', from: { deviceId: 'd1', terminalId: 't1' }, to: { deviceId: 'd2', terminalId: 't1' } },
      { id: 'k', from: { deviceId: 'd1', terminalId: 't3' }, to: { deviceId: 'd3', terminalId: 't3' } },
    ],
  }));
  assert.equal(out.connections.length, 2);
  assertUnique(out.connections, 'connections');
  const deviceIds = new Set(ids(out.devices));
  for (const c of out.connections) {
    assert.ok(deviceIds.has(c.from.deviceId), 'from ссылается на сохранённый прибор');
    assert.ok(deviceIds.has(c.to.deviceId), 'to ссылается на сохранённый прибор');
  }
});

test('дубль id прибора: связь с неоднозначным id не переносится', () => {
  const out = sanitizeProject(validProject({
    devices: [
      { id: 'd', modelId: 'sp2', wallId: 'w1', x: 10, y: 10 },
      { id: 'd', modelId: 'sp2', wallId: 'w1', x: 300, y: 10 },
      { id: 'd3', modelId: 'sp2', wallId: 'w1', x: 600, y: 10 },
    ],
    connections: [
      { id: 'k1', from: { deviceId: 'd', terminalId: 't1' }, to: { deviceId: 'd3', terminalId: 't1' } },
      { id: 'k2', from: { deviceId: 'd3', terminalId: 't1' }, to: { deviceId: 'd', terminalId: 't1' } },
    ],
  }));
  assert.equal(out.devices.length, 3);
  assertUnique(out.devices, 'devices');
  assert.equal(out.connections.length, 0, 'связи с дублированным id отброшены как неоднозначные');
});

/* ==================== 3. hostile JSON ==================== */
test('hostile JSON: NaN/Infinity, отрицательные координаты, чужая стена, мусор', () => {
  const huge = 'x'.repeat(200000);
  const wallId = 'w1';
  const out = sanitizeProject({
    meta: {
      name: 42,
      object: huge,
      address: { nested: 'object' },
      contractor: ['array'],
      doc: null,
      injected: 'лишний ключ',
    },
    walls: [{ id: wallId, name: huge, width: 'abc', height: Infinity }],
    devices: [
      { id: 'a', modelId: 'sp2', wallId, x: NaN, y: Infinity, tag: huge },
      { id: 'b', modelId: 'sp2', wallId, x: -999, y: -999 },
      { id: 'c', modelId: 'sp2', wallId: 'чужая-стена', x: 1, y: 1 },
      { id: 'd', modelId: 'dip34a', wallId, x: 1, y: 1 },
      { id: 'e', modelId: 'unknown-model', wallId, x: 1, y: 1 },
      null,
      'строка',
      42,
    ],
    channels: [
      { id: 'c1', wallId, kind: 'мусор', width: Infinity, points: [[NaN, Infinity], ['x', 'y'], [100, 100]] },
      { id: 'c2', wallId, kind: 'dkc', points: [[0, 0]] },
      null,
    ],
    dimensions: [
      { id: 'dim1', wallId, a: [NaN, -Infinity], b: ['x', 'y'], offset: 'abc' },
      { id: 'dim2', wallId: 'призрак', a: [0, 0], b: [1, 1] },
    ],
    connections: [
      { id: 'k1', from: { deviceId: 'a', terminalId: 't1' }, to: { deviceId: 'b', terminalId: 't1' } },
      { id: 'k2', from: { deviceId: 'нет-такого', terminalId: 't1' }, to: { deviceId: 'b', terminalId: 't1' } },
      { id: 'k3', from: { deviceId: 'a', terminalId: 'нет-клеммы' }, to: { deviceId: 'b', terminalId: 't1' } },
      { id: 'k4', from: null, to: { deviceId: 'b' } },
    ],
  });

  // meta: известные поля строками с лимитом, произвольные ключи не копируются
  assert.equal(out.meta.name, '42');
  assert.equal(out.meta.object.length, 600);
  assert.ok(!('injected' in out.meta), 'неизвестный ключ meta не переносится');
  assert.equal(typeof out.meta.address, 'string');
  assert.equal(typeof out.meta.contractor, 'string');
  assert.equal(typeof out.meta.doc, 'string');

  // стена: размеры целые в допустимых пределах, имя обрезано
  assert.equal(out.walls[0].width, 6000, 'NaN заменяется шириной по умолчанию');
  assert.equal(out.walls[0].height, 2700, 'Infinity заменяется высотой по умолчанию');
  assert.equal(out.walls[0].name.length, 120);

  // приборы: скрытая/чужая стена/мусор отброшены, координаты в стене
  assert.deepEqual(out.devices.map((d) => d.modelId), ['sp2', 'sp2', 'custom']);
  assert.equal(out.devices[0].x, 0);
  assert.equal(out.devices[0].y, 0);
  assert.equal(out.devices[0].tag.length, 2000);
  assert.equal(out.devices[1].x, 0);
  assert.equal(out.devices[1].y, 0);
  for (const d of out.devices) {
    assert.ok(Number.isInteger(d.x) && d.x >= 0, `x=${d.x}`);
    assert.ok(Number.isInteger(d.y) && d.y >= 0, `y=${d.y}`);
  }

  // короба: Infinity/NaN и строка в точках не ломают геометрию
  assert.equal(out.channels.length, 1);
  assert.ok(out.channels[0].points.length >= 2);
  for (const [x, y] of out.channels[0].points) {
    assert.ok(Number.isFinite(x) && x >= 0 && x <= out.walls[0].width);
    assert.ok(Number.isFinite(y) && y >= 0 && y <= out.walls[0].height);
  }
  assert.equal(out.channels[0].kind, 'dkc');

  // размеры: чужая стена отброшена, координаты конечные
  assert.equal(out.dimensions.length, 1);
  assert.deepEqual(out.dimensions[0].a, [0, 0]);
  assert.equal(typeof out.dimensions[0].text, 'string');

  // связи: остаётся только полностью валидная
  assert.equal(out.connections.length, 1);
  assert.equal(out.connections[0].from.deviceId, 'a');
});

test('hostile JSON: не-объект и пустые коллекции дают проект по умолчанию', () => {
  for (const raw of [null, undefined, 42, 'строка', [], true]) {
    const out = sanitizeProject(raw);
    assert.equal(out.walls.length, 1);
    assert.equal(out.devices.length, 0);
    assert.equal(out.channels.length, 0);
    assert.equal(out.meta.name, createProject().meta.name);
  }
});

test('hostile JSON: коллекции и ломаные ограничены по размеру', () => {
  const manyWalls = Array.from({ length: 300 }, (_, i) => ({ id: `w${i}`, width: 4000, height: 2700 }));
  const out = sanitizeProject({ walls: manyWalls });
  assert.ok(out.walls.length <= 200, `walls=${out.walls.length}`);

  const longLine = Array.from({ length: 5000 }, (_, i) => [i, 100]);
  const lineProject = sanitizeProject({
    walls: [{ id: 'w1', width: 100000, height: 2700 }],
    channels: [{ id: 'c1', wallId: 'w1', points: longLine }],
  });
  assert.ok(lineProject.channels[0].points.length <= 2000);
});

/* ==================== 4. уменьшение стены ==================== */
test('updateWall: уменьшение стены зажимает приборы, короба и размеры', () => {
  const st = newStore();
  st.replaceProject(validProject({
    walls: [{ id: 'w1', name: 'Стена', width: 6000, height: 2700 }],
    devices: [{ id: 'd1', modelId: 'sirius', wallId: 'w1', x: 5400, y: 2200 }],
    channels: [{ id: 'c1', wallId: 'w1', kind: 'dkc', width: 100, points: [[5900, 2600], [5900, 100]] }],
    dimensions: [{ id: 'dim1', wallId: 'w1', a: [5800, 2500], b: [100, 2500] }],
    connections: [],
  }));

  st.updateWall('w1', { width: 3000, height: 2000 });
  const wall = st.project.walls[0];
  const device = st.project.devices[0];
  const channel = st.project.channels[0];
  const dim = st.project.dimensions[0];

  assert.equal(wall.width, 3000);
  assert.equal(wall.height, 2000);
  assert.ok(device.x >= 0 && device.x + 500 <= wall.width, `device.x=${device.x}`);
  assert.ok(device.y >= 0 && device.y + 425 <= wall.height, `device.y=${device.y}`);
  for (const [x, y] of channel.points) {
    assert.ok(x >= 0 && x <= wall.width, `channel.x=${x}`);
    assert.ok(y >= 0 && y <= wall.height, `channel.y=${y}`);
  }
  for (const pt of [dim.a, dim.b]) {
    assert.ok(pt[0] >= 0 && pt[0] <= wall.width, `dim.x=${pt[0]}`);
    assert.ok(pt[1] >= 0 && pt[1] <= wall.height, `dim.y=${pt[1]}`);
  }
  assert.ok(Number.isInteger(wall.width) && Number.isInteger(wall.height));
});

test('импорт: стена 80000 мм переживает импорт, ручная правка ограничена 60000', () => {
  const st = newStore();
  st.replaceProject(validProject({
    walls: [{ id: 'big', name: 'Длинная', width: 80000, height: 30000 }],
    devices: [{ id: 'd1', modelId: 'sp2', wallId: 'big', x: 70000, y: 25000 }],
    channels: [],
    dimensions: [],
    connections: [],
  }));
  assert.equal(st.project.walls[0].width, 80000, 'импорт не урезает длинную стену');
  assert.equal(st.project.walls[0].height, 30000, 'импорт не урезает высокую стену');
  assert.equal(st.getDevice('d1').x, 70000, 'прибор остаётся на длинной стене');
  assert.equal(st.getDevice('d1').y, 25000);

  st.updateWall('big', { width: st.project.walls[0].width, height: st.project.walls[0].height });
  assert.equal(st.project.walls[0].width, 60000, 'ручное изменение ограничено 60 м');
  assert.equal(st.project.walls[0].height, 20000, 'ручное изменение ограничено 20 м');
  assert.ok(st.getDevice('d1').x + 102 <= 60000);
  assert.ok(st.getDevice('d1').y + 107 <= 20000);
});

test('updateWall: мусор в patch не ломает стену, id и имя нормализуются', () => {
  const st = newStore();
  st.replaceProject(validProject());
  st.updateWall('w1', { width: 'abc', height: -5, name: { bad: true } });
  let wall = st.project.walls[0];
  assert.equal(wall.width, 4000, 'нечисловая ширина оставляет прежнее значение');
  assert.equal(wall.height, 500, 'отрицательная высота зажимается минимумом');
  assert.equal(wall.name, 'Стена 1', 'объект вместо имени не затирает название');

  st.updateWall('w1', { name: 'И'.repeat(500), id: 'hack' });
  wall = st.project.walls[0];
  assert.equal(wall.id, 'w1', 'id стены нельзя подменить патчем');
  assert.equal(wall.name.length, 120);

  // уменьшение стены — один шаг истории
  const before = st._undo.length;
  st.updateWall('w1', { width: 2000 });
  assert.equal(st._undo.length, before + 1);
});

test('addWall: размеры и имя нормализуются', () => {
  const st = newStore();
  const wall = st.addWall({ name: 'A'.repeat(500), width: -10, height: Infinity });
  assert.equal(wall.width, 500);
  assert.equal(wall.height, 2700, 'нечисловая высота даёт умолчание');
  assert.equal(wall.name.length, 120);
  assert.ok(st.project.walls.some((w) => w.id === wall.id));
  assert.equal(st.activeWallId, wall.id);

  const plain = st.addWall();
  assert.equal(plain.width, 6000);
  assert.equal(plain.height, 2700);
  assert.equal(plain.name, `Стена ${st.project.walls.length}`);
});

/* ==================== 5. updateDevice ==================== */
test('updateDevice: координаты зажимаются, служебные поля неизменны', () => {
  const st = newStore();
  st.replaceProject(validProject({ walls: [{ id: 'w1', width: 4000, height: 2700 }] }));
  st.updateDevice('d1', { x: -500, y: 99999 });
  let device = st.getDevice('d1');
  assert.equal(device.x, 0);
  assert.equal(device.y, 2700 - 107, 'прибор прижат верхом к потолку');

  st.updateDevice('d1', { id: 'evil', wallId: 'evil', modelId: 'нет-модели', rot: 45, system: 'нет-группы' });
  device = st.getDevice('d1');
  assert.equal(device.id, 'd1');
  assert.equal(device.wallId, 'w1');
  assert.equal(device.modelId, 'sp2', 'неизвестная модель не подменяет текущую');
  assert.equal(device.rot, 0);
  assert.equal(device.system, 'fire');

  st.updateDevice('d1', { address: 'z'.repeat(1000), note: { bad: true } });
  device = st.getDevice('d1');
  assert.equal(device.address.length, 200);
  assert.equal(device.note, '');
});

test('addDevice: patch не обходит границы стены', () => {
  const st = newStore();
  st.replaceProject(validProject({ walls: [{ id: 'w1', width: 4000, height: 2700 }] }));
  const dev = st.addDevice('sp2', 99999, -50, { id: 'evil', wallId: 'evil', tag: 'T'.repeat(500) });
  assert.notEqual(dev.id, 'evil');
  assert.equal(dev.wallId, 'w1');
  assert.equal(dev.x, 4000 - 102);
  assert.equal(dev.y, 0);
  assert.equal(dev.tag.length, 500, 'длинные обозначения не режутся до 64 символов');
});

/* ==================== 6. settings ==================== */
test('sanitizeSettings: мусор заменяется умолчаниями', () => {
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings('мусор'), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings([]), { ...DEFAULT_SETTINGS });
  const bad = sanitizeSettings({
    grid: NaN,
    labels: 'bogus',
    channelColor: 'red',
    snap: 'yes',
    showGrid: false,
    channelKind: 'нет-такого',
    extra: 'не копировать',
  });
  assert.equal(bad.grid, 50);
  assert.equal(bad.labels, 'none');
  assert.equal(bad.channelColor, DEFAULT_SETTINGS.channelColor);
  assert.equal(bad.snap, true, 'небулево значение игнорируется');
  assert.equal(bad.showGrid, false);
  assert.ok(!('channelKind' in bad));
  assert.ok(!('extra' in bad));
});

test('sanitizeSettings: валидные значения сохраняются', () => {
  const good = sanitizeSettings({
    grid: 12.6,
    labels: 'tag',
    channelColor: '#abcdef',
    snap: false,
    showGrid: false,
    selectionDims: false,
    smartSnap: false,
    showLegend: false,
    channelKind: 'лоток',
  });
  assert.equal(good.grid, 13);
  assert.equal(good.labels, 'tag');
  assert.equal(good.channelColor, '#abcdef');
  assert.equal(good.snap, false);
  assert.equal(good.showGrid, false);
  assert.equal(good.selectionDims, false);
  assert.equal(good.smartSnap, false);
  assert.equal(good.showLegend, false);
  assert.equal(good.channelKind, 'лоток');
});

/* ==================== 7. loadSaved ==================== */
test('loadSaved: пустое и битое сохранение не падает', () => {
  const st = newStore();
  memory.clear();
  assert.equal(st.loadSaved(), false);
  withoutWarn(() => {
    memory.set(LS_KEY, '{не json');
    assert.equal(st.loadSaved(), false);
    memory.set(LS_KEY, JSON.stringify({ schema: 1 }));
    assert.equal(st.loadSaved(), false);
    memory.set(LS_KEY, JSON.stringify({ project: 'строка' }));
    assert.equal(st.loadSaved(), false);
  });
  assert.equal(st.project.walls.length, 1);
});

test('loadSaved: settings и schema санитизируются, проект загружается', () => {
  const st = newStore();
  memory.clear();
  memory.set(LS_KEY, JSON.stringify({
    schema: 1,
    project: validProject(),
    activeWallId: 'нет-такой-стены',
    settings: {
      grid: -10,
      labels: 'bogus',
      channelColor: 'javascript:alert(1)',
      snap: 'yes',
      showGrid: false,
      extra: { nested: true },
    },
  }));
  assert.equal(st.loadSaved(), true);
  assert.equal(st.project.walls.length, 1);
  assert.equal(st.project.devices.length, 3);
  assert.equal(st.activeWallId, 'w1', 'неизвестная активная стена заменяется первой');
  assert.equal(st.settings.grid, 1, 'отрицательный шаг зажимается');
  assert.equal(st.settings.labels, 'none');
  assert.equal(st.settings.channelColor, DEFAULT_SETTINGS.channelColor);
  assert.equal(st.settings.snap, true);
  assert.equal(st.settings.showGrid, false);
  assert.ok(!('extra' in st.settings), 'произвольные ключи настроек не копируются');
});

test('loadSaved: чужая схема читается по известным полям, дубли id чинятся', () => {
  const st = newStore();
  memory.clear();
  memory.set(LS_KEY, JSON.stringify({
    schema: 99,
    project: validProject({
      walls: [
        { id: 'w1', width: 4000, height: 2700 },
        { id: 'w1', width: 4000, height: 2700 },
      ],
    }),
    settings: { grid: 25, labels: 'full' },
  }));
  assert.equal(withoutWarn(() => st.loadSaved()), true);
  assert.equal(st.project.walls.length, 2);
  assertUnique(st.project.walls, 'walls');
  assert.equal(st.settings.grid, 25);
  assert.equal(st.settings.labels, 'full');
});
/* ==================== 8. история ==================== */
test('undo/redo: поведение прежнее, метка шага сохраняется', () => {
  const st = newStore();
  st.replaceProject(validProject());
  assert.equal(st.canUndo, false);
  st.addDevice('sp2', 10, 10);
  assert.equal(st.project.devices.length, 4);
  assert.equal(st.canUndo, true);
  assert.equal(st.undo(), true);
  assert.equal(st.project.devices.length, 3);
  assert.equal(st.canRedo, true);
  assert.equal(st.redo(), true);
  assert.equal(st.project.devices.length, 4);
  assert.equal(st._undo[0].label, 'добавление устройства');
  assert.equal(st.undo(), true);
  assert.equal(st.undo(), false, 'история исчерпана');
});

test('undo: снимок истории не разделяется с текущим проектом', () => {
  const st = newStore();
  st.replaceProject(validProject());
  st.updateDevice('d1', { tag: 'новый' });
  assert.equal(st.undo(), true);
  st.project.devices[0].tag = 'испорчен';
  assert.equal(st.redo(), true);
  assert.equal(st.getDevice('d1').tag, 'новый');
});

/* ==================== 9. безопасные id из импорта ==================== */
test('sanitizeProject: id из недоверенного JSON не ломают HTML/CSS-селекторы', () => {
  const unsafe = 'w1" onmouseover="window.__xss=1';
  const out = sanitizeProject({
    walls: [{ id: unsafe, width: 4200, height: 2700 }],
    devices: [{ id: 'd1"><img src=x onerror=alert(1)>', wallId: unsafe, modelId: 'sp2', x: 100, y: 100 }],
    channels: [{ id: "c1' onclick='x'", wallId: unsafe, points: [[0, 0], [3000, 0]] }],
    dimensions: [{ id: 'dim<script>', wallId: unsafe, a: [0, 0], b: [100, 0] }],
  });
  const ids = [
    ...out.walls.map((x) => x.id),
    ...out.devices.map((x) => x.id),
    ...out.channels.map((x) => x.id),
    ...out.dimensions.map((x) => x.id),
  ];
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/, `id=${id}`);
  assert.equal(out.devices[0].wallId, out.walls[0].id);
  assert.equal(out.channels[0].wallId, out.walls[0].id);
  assert.equal(out.dimensions[0].wallId, out.walls[0].id);
});

/* ==================== 10. util ==================== */
test('uid: префикс и уникальность на 1000 вызовов', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = uid('dev');
    assert.ok(id.startsWith('dev_'), `id=${id}`);
    assert.ok(id.length > 4, `id=${id}`);
    assert.match(id, /^dev_[0-9a-z]+$/, `id=${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
  assert.match(uid(), /^id_[0-9a-z]+$/);
});

test('mm: формат миллиметров', () => {
  assert.equal(mm(0), '0 мм');
  assert.match(mm(1250), /^1[\s\u00a0]250 мм$/);
});

/* ==================== итог ==================== */
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`techdebt: ${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) {
  console.error(`Провалено: ${failed.map((r) => r.name).join('; ')}`);
  process.exitCode = 1;
}
