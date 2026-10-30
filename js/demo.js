/**
 * demo.js — демонстрационный проект BolidGrid.
 *
 * Монтажный план по документации «ДФО .... СПС.СОУЭ» (доп. офис Банка,
 * г. Елизово, ул. Ленина, д.15а).
 *
 * Задача плана: приборы БОЛИД в реальном масштабе, короба DKC 100×40
 * (ширина 100 мм) и размерные линии — чтобы понять, сколько короба нужно
 * и как он пройдёт по стене. Извещатели и объединения в план не входят.
 */
import { getModel } from './catalog.js';
import { uid } from './util.js';

const model = (id) => getModel(id);

function device(modelId, wallId, x, y, tag, extra = {}) {
  const m = model(modelId);
  return {
    id: uid('dev'),
    modelId: m.id,
    wallId,
    x,
    y,
    rot: 0,
    tag,
    address: '',
    note: '',
    ...extra,
  };
}

export function buildDemoProject() {
  const wallA = { id: uid('wall'), name: 'Стена 1 — пожарный пост (приборы)', width: 4200, height: 2700 };
  const wallB = { id: uid('wall'), name: 'Стена 2 — оповещение (СОУЭ)', width: 6400, height: 2700 };

  const devices = [];

  /* ---------- стена 1: приборы и питание ---------- */
  const sirius = device('sirius', wallA.id, 260, 1250, '1.1', { address: 'ППКУП «Сириус»' });
  const sp2_1 = device('sp2', wallA.id, 900, 1750, '1.2', { address: 'СП2 №1' });
  const sp2_2 = device('sp2', wallA.id, 1150, 1750, '1.3', { address: 'СП2 №2' });
  const sp4 = device('sp4_220', wallA.id, 1450, 1650, '1.4', { address: 'СП4/220 — клапаны' });
  const ar2 = device('ar2', wallA.id, 1800, 1780, '1.5', { address: 'АР2 исп.02' });
  const rip12 = device('rip12', wallA.id, 3600, 1700, '1.6', { address: 'РИП-12 исп.50' });
  const bp12 = device('bp12', wallA.id, 3600, 1350, '1.7', { address: 'БП 12 В / 5 А' });
  devices.push(sirius, sp2_1, sp2_2, sp4, ar2, rip12, bp12);

  /* ---------- стена 2: контроллер и прочее оборудование ---------- */
  const kdl = device('kdl', wallB.id, 600, 1800, '2.1', { address: 'С2000-КДЛ' });
  const sw = device('switch', wallB.id, 1000, 1800, '2.2', { address: 'коммутатор' });
  const socket = device('socket', wallB.id, 1500, 2000, '2.3', { address: 'розетка 220 В' });
  devices.push(kdl, sw, socket);

  /* ---------- кабельные трассы: короба DKC 100×40 (ширина 100 мм) ---------- */
  const channels = [
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'кабель-канал',
      width: 100,
      points: [[120, 2580], [4080, 2580]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,75',
      color: '#94a3b8',
    },
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'кабель-канал',
      width: 100,
      points: [[120, 2580], [120, 1000]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,75',
      color: '#64748b',
    },
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'кабель-канал',
      width: 100,
      points: [[3000, 2250], [4080, 2250]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      color: '#0ea5e9',
    },
    {
      id: uid('ch'),
      wallId: wallB.id,
      kind: 'лоток',
      width: 100,
      points: [[160, 2600], [6240, 2600]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      color: '#94a3b8',
    },
    {
      id: uid('ch'),
      wallId: wallB.id,
      kind: 'кабель-канал',
      width: 100,
      points: [[6240, 2600], [6240, 1200]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      color: '#22c55e',
    },
  ];

  /* ---------- размерные линии ---------- */
  const dimensions = [
    // ширина стены 1
    { id: uid('dim'), wallId: wallA.id, a: [0, 0], b: [4200, 0], text: '', offset: 70 },
    // высота короба (стояк) на стене 1
    { id: uid('dim'), wallId: wallA.id, a: [120, 0], b: [120, 2580], text: '', offset: 90 },
    // высота установки прибора «Сириус» (низ 1250, верх 1605)
    { id: uid('dim'), wallId: wallA.id, a: [260, 1605], b: [260, 0], text: 'высота установки', offset: 120 },
    // ширина стены 2
    { id: uid('dim'), wallId: wallB.id, a: [0, 0], b: [6400, 0], text: '', offset: 70 },
  ];

  const project = {
    version: 1,
    meta: {
      name: 'ДФО .... СПС и СОУЭ — г. Елизово',
      object: 'Комплекс ремонтно-строительных работ и оборудования нежилых помещений для временного размещения дополнительного офиса Банка',
      address: 'г. Елизово, ул. Ленина, д.15а',
      contractor: 'ООО «РитейлСтройСервис»',
      doc: 'ДФО .... СПС.СОУЭ',
    },
    walls: [wallA, wallB],
    devices,
    channels,
    dimensions,
  };

  return { project, activeWallId: wallA.id };
}
