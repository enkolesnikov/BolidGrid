/**
 * demo.js — демонстрационный проект по спецификации
 * «ДФО .... СПС.СОУЭ» (доп. офис Банка, г. Елизово, ул. Ленина, д.15а).
 *
 * Показывает: устройства БОЛИД из спецификации на стене, кабельные каналы,
 * автоматические опуски, объединение устройств в шлейфы и линии СОУЭ.
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
    groupIds: [],
    ...extra,
  };
}

export function buildDemoProject() {
  const wallA = { id: uid('wall'), name: 'Стена 1 — пожарный пост (ППКУП «Сириус»)', width: 4200, height: 2700 };
  const wallB = { id: uid('wall'), name: 'Стена 2 — операционный зал (СПС и СОУЭ)', width: 6400, height: 2700 };

  const devices = [];

  /* ---------- стена 1: приборы ---------- */
  const sirius = device('sirius', wallA.id, 260, 1250, '1.1', { note: 'ППКУП «Сириус», пожарный пост' });
  const akb = device('akb', wallA.id, 260, 780, '1.2', { address: 'АКБ 12 В 18 Ач' });
  const sp2_1 = device('sp2', wallA.id, 900, 1750, '1.3', { address: 'СП2 №1' });
  const sp2_2 = device('sp2', wallA.id, 1140, 1750, '1.4', { address: 'СП2 №2' });
  const sp2_3 = device('sp2', wallA.id, 1380, 1750, '1.5', { address: 'СП2 №3' });
  const sp2_4 = device('sp2', wallA.id, 1620, 1750, '1.6', { address: 'СП2 №4' });
  const sp4 = device('sp4_220', wallA.id, 1980, 1650, '1.7', { address: 'СП4/220, клапаны' });
  const ar2 = device('ar2', wallA.id, 2340, 1780, '1.8', { address: 'АР2 исп.02' });
  const mpn1 = device('mpn', wallA.id, 2620, 1860, '1.9');
  const mpn2 = device('mpn', wallA.id, 2780, 1860, '1.10');
  const kmo1 = device('kmo2k', wallA.id, 3300, 2350, '1.11', { note: 'огнестойкая коробка' });
  const kmo2 = device('kmo2k', wallA.id, 3520, 2350, '1.12', { note: 'огнестойкая коробка' });
  const exit1 = device('molnia_exit', wallA.id, 320, 2320, '1.13', { address: 'ВЫХОД, выход 1' });
  const dir1 = device('molnia_dir', wallA.id, 620, 2320, '1.14', { address: 'направление движения' });
  const mayak1 = device('mayak', wallA.id, 3660, 2380, '1.15', { address: 'звуковое оповещение' });
  devices.push(sirius, akb, sp2_1, sp2_2, sp2_3, sp2_4, sp4, ar2, mpn1, mpn2, kmo1, kmo2, exit1, dir1, mayak1);

  /* ---------- стена 2: извещатели и оповещатели ---------- */
  const detectors = [];
  for (let i = 1; i <= 8; i++) {
    const d = device('dip34a', wallB.id, 380 + (i - 1) * 720, 2480, `2.${i}`, { address: `ДПЛС-1, адр. ${i}` });
    detectors.push(d);
    devices.push(d);
  }
  const ipr1 = device('ipr513', wallB.id, 300, 1450, '2.9', { address: 'ИПР у выхода' });
  const ipr2 = device('ipr513', wallB.id, 6000, 1450, '2.10', { address: 'ИПР у выхода' });
  const exit2 = device('molnia_exit', wallB.id, 240, 2250, '2.11');
  const dir2 = device('molnia_dir', wallB.id, 1400, 2250, '2.12', { address: 'направление движения' });
  const dir3 = device('molnia_dir', wallB.id, 4900, 2250, '2.13', { address: 'направление движения' });
  const mayak2 = device('mayak', wallB.id, 2100, 2380, '2.14');
  const mayak3 = device('mayak', wallB.id, 5600, 2380, '2.15');
  devices.push(ipr1, ipr2, exit2, dir2, dir3, mayak2, mayak3);

  /* ---------- кабельные каналы ---------- */
  const channels = [
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'кабель-канал',
      width: 40,
      points: [[120, 2580], [4080, 2580]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,75',
      label: 'КК-1',
    },
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'кабель-канал',
      width: 40,
      points: [[120, 2580], [120, 1000]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,75',
      label: 'КК-1 (стояк)',
    },
    {
      id: uid('ch'),
      wallId: wallA.id,
      kind: 'лоток',
      width: 100,
      points: [[3880, 2580], [3880, 1500]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      label: 'Лоток к оповещателям',
    },
    {
      id: uid('ch'),
      wallId: wallB.id,
      kind: 'лоток',
      width: 100,
      points: [[160, 2600], [6240, 2600]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      label: 'Лоток Л-1 (СПС)',
    },
    {
      id: uid('ch'),
      wallId: wallB.id,
      kind: 'кабель-канал',
      width: 40,
      points: [[6240, 2600], [6240, 1200]],
      cableModelId: 'КПСнг(А)-FRHF 1x2x0,5',
      label: 'КК-2 (СОУЭ)',
    },
  ];

  /* ---------- объединения ---------- */
  const groupA = {
    id: uid('grp'),
    name: 'Питание 12 В',
    kind: 'Питание',
    color: '#ef4444',
    note: 'АКБ + приборы',
    deviceIds: [sirius.id, akb.id],
  };
  const groupB = {
    id: uid('grp'),
    name: 'ШС-1 (ДПЛС-1)',
    kind: 'Адрес',
    color: '#8b5cf6',
    note: 'адресная линия, 8 извещателей',
    deviceIds: [...detectors.map((d) => d.id), ipr1.id],
  };
  const groupC = {
    id: uid('grp'),
    name: 'ШС-2 (ДПЛС-2)',
    kind: 'Адрес',
    color: '#f59e0b',
    note: 'ручной извещатель',
    deviceIds: [ipr2.id, sp2_1.id, sp2_2.id],
  };
  const groupD = {
    id: uid('grp'),
    name: 'Линия СОУЭ-1',
    kind: 'СОУЭ',
    color: '#22c55e',
    note: 'световые и звуковые оповещатели',
    deviceIds: [exit1.id, dir1.id, exit2.id, dir2.id, dir3.id, mayak1.id, mayak2.id, mayak3.id],
  };
  const groups = [groupA, groupB, groupC, groupD];

  for (const g of groups) {
    for (const id of g.deviceIds) {
      const d = devices.find((x) => x.id === id);
      if (d) d.groupIds = [...new Set([...(d.groupIds || []), g.id])];
    }
  }

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
    groups,
  };

  return { project, activeWallId: wallA.id };
}
