// assemble.js — 以「空間為單位」拼裝平面圖
//
// 實際量房的習慣是：一個房間一個房間量完（含它的門），
// 最後再把各個空間拖過來，讓門對門或門對走道接起來、合併成完整平面圖。
//
// 這支檔負責三件事：
//   1. 算出「一個空間包含哪些東西」（只屬於它的牆、牆上的門窗、裡面的家具照片）
//   2. 拖曳時計算吸附：門對門優先，其次牆面對牆面
//   3. 放開後把重合的牆合併掉，避免兩間房中間留下兩道疊在一起的牆

import * as G from './geometry.js';
import * as WL from './wall.js';

const TOL = 1;

/** 空間裡「只屬於它」的牆；與別的空間共用的牆不搬（搬了會把隔壁扯壞） */
export function moveSetOf(doc, room, rooms) {
  const mine = new Set();
  for (const e of room.edges) if (e.wallId) mine.add(e.wallId);
  const shared = new Set();
  for (const r of rooms) {
    if (r === room) continue;
    for (const e of r.edges) if (e.wallId && mine.has(e.wallId)) shared.add(e.wallId);
  }
  const wallIds = [...mine].filter((id) => !shared.has(id));
  const f = doc.floor;
  const walls = wallIds.map((id) => doc.wallById(id)).filter(Boolean);
  return {
    walls,
    wallIds: new Set(wallIds),
    openings: f.openings.filter((o) => wallIds.includes(o.wallId)),
    items: f.items.filter((it) => G.pointInPoly({ x: it.x, y: it.y }, room.inner)),
    photos: f.photos.filter((p) => G.pointInPoly(p, room.inner)),
    texts: f.texts.filter((t) => G.pointInPoly(t, room.inner)),
    label: room.label || null,
    sharedIds: shared,
  };
}

/** 門（或開口）在圖面上的位置與朝向 */
function doorAnchors(doc, openings, wallFilter) {
  const out = [];
  for (const o of openings) {
    if (o.kind === 'window') continue;                 // 窗不拿來對接
    const w = doc.wallById(o.wallId);
    if (!w || (wallFilter && !wallFilter(w))) continue;
    const { d, n } = WL.axisOf(w);
    const L = G.dist(w.a, w.b) || 1;
    const c = G.add(w.a, G.mul(d, Math.max(0, Math.min(L, o.offset))));
    out.push({ o, wall: w, center: c, dir: d, normal: n, width: o.width });
  }
  return out;
}

/**
 * 拖曳中的吸附計算。
 * @param {number} snapMm 吸附距離（螢幕上約 20px 換算成 mm）
 * @returns {{delta:{x,y}, kind:string, from:object, to:object}|null}
 */
export function findSnap(doc, set, rooms, snapMm) {
  const movingIds = set.wallIds;
  const isMoving = (w) => movingIds.has(w.id);
  const isStatic = (w) => !movingIds.has(w.id);

  const movDoors = doorAnchors(doc, set.openings, isMoving);
  const staDoors = doorAnchors(doc, doc.floor.openings.filter((o) => !movingIds.has(o.wallId)), isStatic);

  // ── 門對門：中心對齊即可，兩扇門的牆自然貼在一起 ──
  let best = null;
  for (const a of movDoors) {
    for (const b of staDoors) {
      // 兩面牆要接得起來，方向必須平行（同向或反向都可以）
      const par = Math.abs(G.cross(a.dir, b.dir));
      if (par > 0.18) continue;                         // 約 10° 內
      const d = G.dist(a.center, b.center);
      if (d > snapMm) continue;
      // 寬度差太多的門多半不是同一個通道
      if (Math.abs(a.width - b.width) > Math.max(150, a.width * 0.35)) continue;
      if (!best || d < best.dist) {
        best = { dist: d, delta: G.sub(b.center, a.center), kind: 'door', from: a, to: b };
      }
    }
  }
  if (best) return best;

  // ── 門對牆：把門貼到走道的牆面上（門會落在那面牆上） ──
  for (const a of movDoors) {
    for (const w of doc.walls) {
      if (isMoving(w)) continue;
      const c = G.closestOnSeg(a.center, w.a, w.b);
      if (c.d > snapMm) continue;
      const par = Math.abs(G.cross(a.dir, WL.axisOf(w).d));
      if (par > 0.18) continue;
      if (!best || c.d < best.dist) {
        best = { dist: c.d, delta: G.sub(c.pt, a.center), kind: 'doorwall', from: a, to: { wall: w, center: c.pt } };
      }
    }
  }
  if (best) return best;

  // ── 牆端點對端點：一般的拼接 ──
  const movPts = [];
  for (const w of set.walls) movPts.push(w.a, w.b);
  const staPts = [];
  for (const w of doc.walls) if (isStatic(w)) staPts.push(w.a, w.b);
  for (const p of movPts) {
    for (const q of staPts) {
      const d = G.dist(p, q);
      if (d > snapMm) continue;
      if (!best || d < best.dist) best = { dist: d, delta: G.sub(q, p), kind: 'vertex', from: { center: p }, to: { center: q } };
    }
  }
  return best;
}

/** 兩面牆是否幾乎重合（共線且區間重疊） */
function coincident(a, b, tol = 60) {
  const da = G.norm(G.sub(a.b, a.a));
  const db = G.norm(G.sub(b.b, b.a));
  if (Math.abs(G.cross(da, db)) > 0.05) return false;                 // 不平行
  if (G.distToSeg(a.a, b.a, b.b) > tol && G.distToSeg(a.b, b.a, b.b) > tol) return false;
  // 投影後區間要有重疊
  const s = (p) => G.dot(G.sub(p, b.a), db);
  const lo = Math.min(s(a.a), s(a.b)), hi = Math.max(s(a.a), s(a.b));
  const L = G.dist(b.a, b.b);
  return hi > 20 && lo < L - 20;
}

/**
 * 合併重合的牆：搬過來的牆若與既有的牆疊在一起，就刪掉搬過來的那面，
 * 並把它上面的門窗改掛到留下來的那面牆上。
 * 不做的話，兩間房中間會有兩道疊合的牆，房間偵測會出錯。
 * @returns {{merged:number, movedOpenings:number}}
 */
export function mergeOverlaps(doc, set) {
  const f = doc.floor;
  let merged = 0, movedOpenings = 0;

  for (const mw of [...set.walls]) {
    const keep = doc.walls.find((w) => !set.wallIds.has(w.id) && w.id !== mw.id && coincident(mw, w));
    if (!keep) continue;

    // 門窗改掛到保留的那面牆，位置沿牆長重新換算
    const kd = G.norm(G.sub(keep.b, keep.a));
    for (const o of f.openings.filter((x) => x.wallId === mw.id)) {
      const md = G.norm(G.sub(mw.b, mw.a));
      const c = G.add(mw.a, G.mul(md, o.offset));
      const s = G.dot(G.sub(c, keep.a), kd);
      const L = G.dist(keep.a, keep.b);
      o.wallId = keep.id;
      o.offset = Math.max(o.width / 2, Math.min(L - o.width / 2, s));
      movedOpenings++;
    }
    doc.removeWall(mw.id);
    set.wallIds.delete(mw.id);
    merged++;
  }
  return { merged, movedOpenings };
}
