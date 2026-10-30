/** util.js — мелкая геометрия и форматирование. Единицы проекта — миллиметры. */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const snapTo = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Точка на отрезке, ближайшая к p. */
export function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { point: [a[0], a[1]], t: 0, dist: dist(p, a) };
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = clamp(t, 0, 1);
  const point = [a[0] + dx * t, a[1] + dy * t];
  return { point, t, dist: dist(p, point) };
}

/** Ближайшая точка ломаной к p. */
export function closestOnPolyline(p, points) {
  let best = null;
  for (let i = 0; i < points.length - 1; i++) {
    const r = closestOnSegment(p, points[i], points[i + 1]);
    if (!best || r.dist < best.dist) best = { ...r, index: i };
  }
  return best;
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  return total;
}

/** Прямоугольная (ортогональная) трассировка между двумя точками: Г-образно. */
export function orthoPath(a, b) {
  if (Math.abs(a[1] - b[1]) < 1 || Math.abs(a[0] - b[0]) < 1) return [a, b];
  return [a, [b[0], a[1]], b];
}

/** Преобразовать ломаную в SVG path (в экранных координатах y вниз). */
export function pathD(points, toScreenY) {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  let d = `M${x0} ${toScreenY(y0)}`;
  for (let i = 1; i < points.length; i++) {
    d += `L${points[i][0]} ${toScreenY(points[i][1])}`;
  }
  return d;
}

const NF = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export const fmt = (v) => NF.format(v);
export const fmt0 = (v) => NF0.format(v);

/** 12500 → «12,5 м» */
export function m(v) {
  return `${NF.format(Math.round((v / 1000) * 1000) / 1000)} м`;
}
/** 1250 → «1 250 мм» */
export function mm(v) {
  return `${fmt0(v)} мм`;
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}`;

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows, sep = ';') {
  return '\uFEFF' + rows.map((r) => r.map(csvEscape).join(sep)).join('\r\n');
}
