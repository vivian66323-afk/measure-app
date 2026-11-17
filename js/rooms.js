// rooms.js — 由牆體中心線自動偵測封閉房間（平面圖 face 擷取）
import * as G from './geometry.js';
import { inwardOffset } from './wall.js';

const TOL = 25;          // 節點合併容差 (mm)
const MIN_AREA = 4e5;    // 忽略小於 0.4 m² 的碎面

/** 依交點把所有牆切成不重疊的小線段 */
function splitSegments(walls) {
  const segs = [];
  for (const w of walls) {
    if (G.dist(w.a, w.b) < TOL) continue;
    segs.push({ a: { ...w.a }, b: { ...w.b }, wall: w });
  }
  const cuts = segs.map(() => []);           // 每段的切點參數 t
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const x = G.segSeg(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (!x) continue;
      cuts[i].push(x.t); cuts[j].push(x.u);
    }
  }
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const L = G.dist(s.a, s.b);
    const ts = [0, 1, ...cuts[i]]
      .filter((t) => t > -1e-9 && t < 1 + 1e-9)
      .sort((p, q) => p - q);
    let prev = null;
    for (const t of ts) {
      if (prev != null && (t - prev) * L < TOL) continue;
      if (prev != null) out.push({ a: G.lerp(s.a, s.b, prev), b: G.lerp(s.a, s.b, t), wall: s.wall });
      prev = t;
    }
  }
  return out;
}

/** 建立平面圖（節點合併 + 半邊） */
function buildGraph(segs) {
  const nodes = [];
  const find = (p) => {
    for (const n of nodes) if (Math.abs(n.x - p.x) < TOL && Math.abs(n.y - p.y) < TOL) return n;
    const n = { id: nodes.length, x: p.x, y: p.y, out: [] };
    nodes.push(n);
    return n;
  };
  const half = [];
  for (const s of segs) {
    const u = find(s.a), v = find(s.b);
    if (u === v) continue;
    const h1 = { id: half.length, from: u, to: v, wall: s.wall, ang: Math.atan2(v.y - u.y, v.x - u.x), twin: -1, used: false };
    half.push(h1);
    const h2 = { id: half.length, from: v, to: u, wall: s.wall, ang: Math.atan2(u.y - v.y, u.x - v.x), twin: h1.id, used: false };
    half.push(h2);
    h1.twin = h2.id;
    u.out.push(h1.id); v.out.push(h2.id);
  }
  for (const n of nodes) n.out.sort((a, b) => half[a].ang - half[b].ang);   // 逆時針排序
  return { nodes, half };
}

/** 擷取所有 face；逆時針（正面積）者即為內部房間 */
function faces(graph) {
  const { half } = graph;
  const res = [];
  for (const h0 of half) {
    if (h0.used) continue;
    const loop = [];
    let h = h0, guard = 0;
    while (!h.used && guard++ < 4000) {
      h.used = true;
      loop.push(h);
      const twin = half[h.twin];
      const outs = h.to.out;
      const k = outs.indexOf(twin.id);
      // 取反向邊在逆時針順序中的「前一條」→ 沿著 face 內側前進
      const next = outs[(k - 1 + outs.length) % outs.length];
      h = half[next];
      if (h === h0) break;
    }
    if (loop.length >= 3) res.push(loop);
  }
  return res;
}

/**
 * 偵測房間。
 * @returns {Array<{id,poly,inner,area,areaGross,perim,centroid,edges,label}>}
 *  poly  = 牆中心線多邊形（CCW）
 *  inner = 扣掉牆厚後的淨空多邊形
 *  area  = 淨面積 (mm²)
 */
export function detectRooms(floor) {
  const walls = floor.walls || [];
  if (walls.length < 3) return [];
  const segs = splitSegments(walls);
  const g = buildGraph(segs);
  const out = [];
  let idx = 0;

  for (const loop of faces(g)) {
    const pts = loop.map((h) => ({ x: h.from.x, y: h.from.y }));
    const A = G.polyArea(pts);
    if (A <= MIN_AREA) continue;                       // 負面積 = 外框；過小 = 碎面

    // 去掉零長度邊（點與邊必須保持一一對應：clean[i] → clean[i+1] 由 keep[i] 這面牆構成）
    const clean = [], keep = [];
    for (let i = 0; i < loop.length; i++) {
      const p = pts[i], q = pts[(i + 1) % loop.length];
      if (G.dist(p, q) < 1) continue;
      clean.push(p); keep.push(loop[i]);
    }
    if (clean.length < 3) continue;

    // 內縮量要看牆線位置，而且半邊的行進方向可能與牆的儲存方向相反
    const offs = keep.map((h) => {
      if (!h.wall) return 60;
      const wd = G.norm(G.sub(h.wall.b, h.wall.a));
      const hd = G.norm({ x: h.to.x - h.from.x, y: h.to.y - h.from.y });
      return inwardOffset(h.wall, G.dot(wd, hd) >= 0);
    });
    const inner = G.offsetPolyInward(clean, offs);
    const innerArea = Math.abs(G.polyArea(inner));
    const c = G.polyCentroid(clean);

    out.push({
      id: 'room' + idx++,
      poly: clean,
      inner,
      area: innerArea,
      areaGross: A,
      perim: G.polyPerimeter(inner),
      centroid: G.pointInPoly(c, inner) ? c : G.polyCentroid(inner),
      edges: keep.map((h) => ({ wallId: h.wall?.id, a: { x: h.from.x, y: h.from.y }, b: { x: h.to.x, y: h.to.y }, thickness: h.wall?.thickness ?? 120 })),
      label: null,
    });
  }

  // 依面積由大到小，讓「最大者」通常是整層外框時被排除（外框為負面積已排除，此處僅排序）
  out.sort((a, b) => b.area - a.area);

  // 綁定房間標記
  for (const lb of floor.roomLabels || []) {
    const hit = out.find((r) => G.pointInPoly(lb, r.inner));
    if (hit && !hit.label) hit.label = lb;
  }
  let n = 1;
  for (const r of out) if (!r.label) r.name = `區域${n++}`; else r.name = r.label.name || '未命名';
  return out;
}

/** 牆面面積（扣門窗），用於估算油漆/壁紙 */
export function wallAreaOf(room, floor) {
  const h = floor.height || 2800;
  let gross = 0, deduct = 0;
  for (const e of room.edges) {
    const L = G.dist(e.a, e.b);
    gross += L * h;
    for (const o of (floor.openings || []).filter((x) => x.wallId === e.wallId)) {
      // 洞口是否落在這一段上
      const w = (floor.walls || []).find((x) => x.id === o.wallId);
      if (!w) continue;
      const p = G.lerp(w.a, w.b, o.offset / Math.max(1, G.dist(w.a, w.b)));
      if (G.distToSeg(p, e.a, e.b) < 60) deduct += o.width * (o.height || 2100);
    }
  }
  return Math.max(0, gross - deduct);
}
