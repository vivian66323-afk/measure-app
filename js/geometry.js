// geometry.js — 2D 幾何運算（單位 mm，模型座標 Y 向上）
export const EPS = 1e-6;

export const V = (x, y) => ({ x, y });
export const add = (a, b) => V(a.x + b.x, a.y + b.y);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y);
export const mul = (a, k) => V(a.x * k, a.y * k);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const norm = (a) => { const l = len(a) || 1; return V(a.x / l, a.y / l); };
/** 逆時針法線（左側） */
export const leftN = (a) => V(-a.y, a.x);
export const angleOf = (a) => Math.atan2(a.y, a.x);
export const rot = (a, r) => V(a.x * Math.cos(r) - a.y * Math.sin(r), a.x * Math.sin(r) + a.y * Math.cos(r));
export const lerp = (a, b, t) => V(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
export const eq = (a, b, e = 1e-3) => Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e;

/** 角度正規化到 (-PI, PI] */
export function normAngle(r) {
  while (r <= -Math.PI) r += Math.PI * 2;
  while (r > Math.PI) r -= Math.PI * 2;
  return r;
}
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/** 點到線段的最近點與距離 */
export function closestOnSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return { pt: a, t: 0, d: dist(p, a) };
  let t = dot(sub(p, a), ab) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const pt = add(a, mul(ab, t));
  return { pt, t, d: dist(p, pt) };
}
export const distToSeg = (p, a, b) => closestOnSeg(p, a, b).d;

/** 兩條「無限直線」交點（p+dir 形式），平行回傳 null */
export function lineLine(p1, d1, p2, d2) {
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(p2, p1), d2) / den;
  return add(p1, mul(d1, t));
}

/** 兩線段交點（含端點，t/u 皆在 [0,1]），無交點回傳 null */
export function segSeg(a1, a2, b1, b2) {
  const r = sub(a2, a1), s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(b1, a1), s) / den;
  const u = cross(sub(b1, a1), r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { pt: add(a1, mul(r, t)), t, u };
}

/** 多邊形有向面積（逆時針為正），單位 mm² */
export function polyArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
export const polyPerimeter = (pts) => {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) s += dist(pts[i], pts[(i + 1) % n]);
  return s;
};
export function polyCentroid(pts) {
  const A = polyArea(pts);
  if (Math.abs(A) < EPS) {
    const c = pts.reduce((m, p) => add(m, p), V(0, 0));
    return mul(c, 1 / (pts.length || 1));
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f; cy += (a.y + b.y) * f;
  }
  return V(cx / (6 * A), cy / (6 * A));
}
export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function bbox(pts) {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** 把方向吸附到最近的 step 角度（弧度） */
export function snapAngle(a, stepDeg = 15) {
  const s = rad(stepDeg);
  return Math.round(a / s) * s;
}
/** 把點吸附成相對於 origin 的正交/等分角方向 */
export function orthoPoint(origin, p, stepDeg = 90) {
  const d = sub(p, origin);
  const l = len(d);
  if (l < EPS) return p;
  const a = snapAngle(Math.atan2(d.y, d.x), stepDeg);
  return add(origin, V(Math.cos(a) * l, Math.sin(a) * l));
}

/**
 * 將封閉多邊形（逆時針）依每邊各自厚度往內側偏移，回傳淨空多邊形。
 * @param {Array<{x,y}>} pts 逆時針點列
 * @param {number[]} offs   每一邊（pts[i]→pts[i+1]）要內縮的距離
 */
export function offsetPolyInward(pts, offs) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  // 每邊內縮後的直線（點 + 方向）
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = norm(sub(b, a));
    const nn = leftN(d);                    // CCW 多邊形：左側即內側
    const o = offs[i] ?? 0;
    lines.push({ p: add(a, mul(nn, o)), d });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n], cur = lines[i];
    const x = lineLine(prev.p, prev.d, cur.p, cur.d);
    out.push(x || cur.p);
  }
  return out;
}

/** 依 CCW 修正方向 */
export function ensureCCW(pts) {
  return polyArea(pts) < 0 ? pts.slice().reverse() : pts.slice();
}

/**
 * 簡單多邊形三角化（耳切法）。房間輪廓可能是 L 形、凹形，不能只當凸多邊形處理。
 * @param {Array<{x,y}>} poly 不自交的多邊形
 * @returns {Array<[number,number,number]>} 三角形的頂點索引（對應輸入陣列，CCW）
 */
export function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = polyArea(poly) >= 0;
  const idx = [...Array(n).keys()];
  if (!ccw) idx.reverse();

  const at = (i) => poly[idx[i]];
  const area2 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p, a, b, c) => {
    const d1 = area2(p, a, b), d2 = area2(p, b, c), d3 = area2(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  const out = [];
  let guard = n * n + 32;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ip = (i - 1 + idx.length) % idx.length, inx = (i + 1) % idx.length;
      const a = at(ip), b = at(i), c = at(inx);
      if (area2(a, b, c) <= 0) continue;                 // 反射角，不是耳朵
      let ok = true;
      for (let j = 0; j < idx.length; j++) {
        if (j === ip || j === i || j === inx) continue;
        if (inTri(at(j), a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push([idx[ip], idx[i], idx[inx]]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;                                  // 退化多邊形，放棄剩餘部分
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
