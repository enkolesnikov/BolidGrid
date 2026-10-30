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

  const devices = [];

  /* ---------- стена: приборы по заданию ---------- */
  const sirius = device('sirius', wallA.id, 300, 1300, '1.1', { address: 'ППКУП «Сириус»' });
  const ar2 = device('ar2', wallA.id, 950, 1800, '1.2', { address: 'С2000-АР2 исп.02' });
  const sp2_1 = device('sp2', wallA.id, 1150, 1800, '1.3', { address: 'С2000-СП2 №1' });
  const sp2_2 = device('sp2', wallA.id, 1350, 1800, '1.4', { address: 'С2000-СП2 №2' });
  const sp2_3 = device('sp2', wallA.id, 1550, 1800, '1.5', { address: 'С2000-СП2 №3' });
  const sp2_4 = device('sp2', wallA.id, 1750, 1800, '1.6', { address: 'С2000-СП2 №4' });
  devices.push(sirius, ar2, sp2_1, sp2_2, sp2_3, sp2_4);

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
  ];

  /* ---------- размерные линии ---------- */
  const dimensions = [
    // ширина стены 1
    { id: uid('dim'), wallId: wallA.id, a: [0, 0], b: [4200, 0], text: '', offset: 70 },
    // высота короба (стояк) на стене 1
    { id: uid('dim'), wallId: wallA.id, a: [120, 0], b: [120, 2580], text: '', offset: 90 },
    // высота установки прибора «Сириус» (низ 1250, верх 1605)
    { id: uid('dim'), wallId: wallA.id, a: [260, 1605], b: [260, 0], text: 'высота установки', offset: 120 },
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
    walls: [wallA],
    devices,
    channels,
    dimensions,
  };

  return { project, activeWallId: wallA.id };
}
