// export-dxf.js — 輸出 AutoCAD DXF (R12，相容性最佳)；單位 mm
import * as G from './geometry.js';
import * as WL from './wall.js';
import { flatten, SYMBOLS } from './catalog.js';
import { fmtLen, getUnit, toM2, toPing, fmt } from './util.js';
import { outerDims, dimSegments } from './autodim.js';

const LAYERS = [
  ['WALL', 7], ['WALL-EXT', 8], ['WALL-CENTER', 253], ['ROOM', 4],
  ['DOOR', 3], ['WINDOW', 5], ['OPENING', 6], ['COLUMN', 9],
  ['DIM', 1], ['TEXT', 2], ['AREA', 30], ['FURNITURE', 251], ['PHOTO', 40], ['BEAM', 34],
];

class Dxf {
  constructor() { this.b = []; }
  c(code, val) { this.b.push(String(code), String(val)); return this; }
  line(layer, a, b) {
    this.c(0, 'LINE').c(8, layer)
      .c(10, a.x.toFixed(3)).c(20, a.y.toFixed(3)).c(30, 0)
      .c(11, b.x.toFixed(3)).c(21, b.y.toFixed(3)).c(31, 0);
  }
  /**
   * 聚合線。用 R12 的 POLYLINE/VERTEX/SEQEND 而不是 LWPOLYLINE：
   * LWPOLYLINE 要 R2000 以上，POLYLINE 從 R12 到最新版都認得，
   * 在 AutoCAD 裡一樣是可以偏移、可以填充、可以查面積的單一物件。
   * @param {number} width 線寬（設了就會依這個寬度往兩側外擴顯示）
   */
  poly(layer, pts, close = true, width = 0) {
    if (pts.length < 2) return;
    this.c(0, 'POLYLINE').c(8, layer).c(66, 1)
      .c(10, 0).c(20, 0).c(30, 0)
      .c(70, close ? 1 : 0);
    if (width > 0) this.c(40, width.toFixed(3)).c(41, width.toFixed(3));
    for (const p of pts) {
      this.c(0, 'VERTEX').c(8, layer)
        .c(10, p.x.toFixed(3)).c(20, p.y.toFixed(3)).c(30, 0);
      if (width > 0) this.c(40, width.toFixed(3)).c(41, width.toFixed(3));
    }
    this.c(0, 'SEQEND').c(8, layer);
  }
  /** 舊寫法：拆成獨立線段（僅剩少數地方用） */
  polyLines(layer, pts, close = true) {
    for (let i = 0; i < pts.length - (close ? 0 : 1); i++) this.line(layer, pts[i], pts[(i + 1) % pts.length]);
  }
  text(layer, p, str, h = 150, rotDeg = 0, align = 1) {
    this.c(0, 'TEXT').c(8, layer)
      .c(10, p.x.toFixed(3)).c(20, p.y.toFixed(3)).c(30, 0)
      .c(40, h.toFixed(2)).c(1, String(str).replace(/\n/g, ' '))
      .c(50, rotDeg.toFixed(2))
      .c(72, align).c(73, 2)
      .c(11, p.x.toFixed(3)).c(21, p.y.toFixed(3)).c(31, 0);
  }
  arc(layer, c, r, a0, a1) {
    this.c(0, 'ARC').c(8, layer)
      .c(10, c.x.toFixed(3)).c(20, c.y.toFixed(3)).c(30, 0)
      .c(40, r.toFixed(3)).c(50, a0.toFixed(2)).c(51, a1.toFixed(2));
  }
  out() { return this.b.join('\r\n') + '\r\n'; }
}

function header(d) {
  d.c(0, 'SECTION').c(2, 'HEADER')
    .c(9, '$ACADVER').c(1, 'AC1009')
    .c(9, '$INSUNITS').c(70, 4)          // 4 = 公釐
    .c(9, '$MEASUREMENT').c(70, 1)
    .c(0, 'ENDSEC');
  d.c(0, 'SECTION').c(2, 'TABLES')
    .c(0, 'TABLE').c(2, 'LAYER').c(70, LAYERS.length);
  for (const [n, col] of LAYERS) d.c(0, 'LAYER').c(2, n).c(70, 0).c(62, col).c(6, 'CONTINUOUS');
  d.c(0, 'ENDTAB').c(0, 'ENDSEC');
}


/**
 * @param {object} floor
 * @param {Array} rooms  detectRooms() 結果
 * @param {object} opt   { name, showDim, showArea }
 */
export function buildDXF(floor, rooms, opt = {}) {
  const d = new Dxf();
  header(d);
  d.c(0, 'SECTION').c(2, 'ENTITIES');

  const unit = getUnit();

  // 牆：每一段實牆輸出成「封閉聚合線」，轉角已斜接不重疊，
  // 在 AutoCAD 裡是單一物件，可直接偏移、填充、查面積。
  const mm = WL.mitreMap(floor.walls);
  for (const w of floor.walls) {
    const layer = w.type === 'exterior' ? 'WALL-EXT' : 'WALL';
    const { d: dir, len: L } = WL.axisOf(w);
    if (L < 1) continue;
    const hiR = WL.faceRange(w, 'hi', mm);
    const loR = WL.faceRange(w, 'lo', mm);

    d.poly('WALL-CENTER', [w.a, w.b], false);

    for (const [s, e] of WL.solidSpans(w, floor.openings, 0, L)) {
      // 兩端貼齊斜接後的實際範圍，中間的開口照原本的 s 參數切
      const s0 = s <= 0.5 ? null : s;
      const e0 = e >= L - 0.5 ? null : e;
      const hs = s0 == null ? hiR.s0 : s0, he = e0 == null ? hiR.s1 : e0;
      const ls = s0 == null ? loR.s0 : s0, le = e0 == null ? loR.s1 : e0;
      d.poly(layer, [
        WL.facePoint(hiR.line, hs), WL.facePoint(hiR.line, he),
        WL.facePoint(loR.line, le), WL.facePoint(loR.line, ls),
      ], true);
    }

    if (opt.showDim !== false && L > 200) {
      const mid = G.lerp(w.a, w.b, 0.5);
      let rotDeg = G.deg(G.angleOf(dir));
      if (rotDeg > 90 || rotDeg < -90) rotDeg += 180;
      const tOff = G.mul(G.leftN(dir), WL.bandOf(w).hi + 90);
      d.text('DIM', G.add(mid, tOff), `${fmtLen(L, unit)}`, 130, rotDeg);
    }
  }

  // 門窗
  for (const o of floor.openings) {
    const w = floor.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const { d: dir } = WL.axisOf(w);
    const bd = WL.bandOf(w);
    const nrm = G.leftN(dir);
    const n = G.mul(nrm, bd.hi);              // hi 側
    const nLo = G.mul(nrm, bd.lo);            // lo 側
    const p1 = G.add(w.a, G.mul(dir, o.offset - o.width / 2));
    const p2 = G.add(w.a, G.mul(dir, o.offset + o.width / 2));
    if (o.kind === 'window') {
      d.poly('WINDOW', [G.add(p1, n), G.add(p2, n), G.add(p2, nLo), G.add(p1, nLo)], true);
      d.line('WINDOW', G.lerp(G.add(p1, n), G.add(p1, nLo), .5), G.lerp(G.add(p2, n), G.add(p2, nLo), .5));
    } else if (o.kind === 'door') {
      const side = o.flip ? -1 : 1;
      const hinge = o.swing >= 0 ? p1 : p2;
      const other = o.swing >= 0 ? p2 : p1;
      const leafEnd = G.add(hinge, G.mul(G.mul(nrm, side), o.width));
      d.line('DOOR', hinge, leafEnd);
      d.line('DOOR', G.add(p1, n), G.add(p1, nLo));
      d.line('DOOR', G.add(p2, n), G.add(p2, nLo));
      const a0 = G.deg(G.angleOf(G.sub(leafEnd, hinge)));
      const a1 = G.deg(G.angleOf(G.sub(other, hinge)));
      d.arc('DOOR', hinge, o.width, Math.min(a0, a1), Math.max(a0, a1));
    } else {
      d.line('OPENING', G.add(p1, n), G.add(p1, nLo));
      d.line('OPENING', G.add(p2, n), G.add(p2, nLo));
    }
  }

  // 樑（虛線慣例在 R12 需要 LTYPE 定義，改以短線段模擬）
  for (const bm of floor.beams || []) {
    const ax = WL.beamAxis(bm);
    const L = G.dist(ax.a, ax.b);
    if (L < 1) continue;
    const n = G.mul(ax.n, bm.width / 2);
    for (const side of [n, G.mul(n, -1)]) {
      const a = G.add(ax.a, side);
      const dash = 120, gap = 80;
      for (let s = 0; s < L; s += dash + gap) {
        d.line('BEAM', G.add(a, G.mul(ax.d, s)), G.add(a, G.mul(ax.d, Math.min(L, s + dash))));
      }
    }
    d.line('BEAM', G.add(ax.a, n), G.sub(ax.a, n));
    d.line('BEAM', G.add(ax.b, n), G.sub(ax.b, n));
    const dep = Math.max(1, (floor.height || 2800) - (bm.clearH ?? 2400));
    const mid = G.lerp(ax.a, ax.b, 0.5);
    let rot2 = G.deg(G.angleOf(ax.d));
    if (rot2 > 90 || rot2 < -90) rot2 += 180;
    d.text('BEAM', mid, `樑${bm.width}x${dep} H${bm.clearH}`, 130, rot2);
  }

  // 柱
  for (const c of floor.columns) {
    const pts = [
      { x: c.x - c.w / 2, y: c.y - c.h / 2 }, { x: c.x + c.w / 2, y: c.y - c.h / 2 },
      { x: c.x + c.w / 2, y: c.y + c.h / 2 }, { x: c.x - c.w / 2, y: c.y + c.h / 2 },
    ].map((p) => (c.rot ? G.add({ x: c.x, y: c.y }, G.rot(G.sub(p, { x: c.x, y: c.y }), c.rot)) : p));
    d.poly('COLUMN', pts, true);
    d.line('COLUMN', pts[0], pts[2]);
    d.line('COLUMN', pts[1], pts[3]);
  }

  // 家具／構件
  for (const it of floor.items || []) {
    const { segs, arcs } = flatten(it);
    for (const [a, b] of segs) d.line('FURNITURE', a, b);
    for (const ar of arcs) {
      if (ar.a0 == null) {
        d.c(0, 'CIRCLE').c(8, 'FURNITURE')
          .c(10, ar.c.x.toFixed(3)).c(20, ar.c.y.toFixed(3)).c(30, 0).c(40, ar.r.toFixed(3));
      } else d.arc('FURNITURE', ar.c, ar.r, ar.a0, ar.a1);
    }
    if (it.showLabel !== false) {
      const name = it.label || SYMBOLS[it.type]?.name || '';
      if (name) d.text('FURNITURE', { x: it.x, y: it.y }, name, 130, G.deg(it.rot || 0));
    }
  }

  // 房間淨空輪廓 + 名稱 + 面積
  for (const r of rooms) {
    d.poly('ROOM', r.inner, true);          // 封閉聚合線，可直接查面積 / 填充
    if (opt.showArea !== false) {
      const m2 = toM2(r.area);
      d.text('TEXT', { x: r.centroid.x, y: r.centroid.y + 120 }, r.name, 220);
      d.text('AREA', { x: r.centroid.x, y: r.centroid.y - 180 }, `${fmt(m2, 2)} m²  (${fmt(toPing(m2), 2)} 坪)`, 150);
    }
  }

  // 手動標註
  for (const dm of floor.dims) {
    const dir = G.norm(G.sub(dm.b, dm.a));
    const n = G.mul(G.leftN(dir), dm.off);
    const a = G.add(dm.a, n), b = G.add(dm.b, n);
    d.line('DIM', a, b); d.line('DIM', dm.a, a); d.line('DIM', dm.b, b);
    let rotDeg = G.deg(G.angleOf(dir));
    if (rotDeg > 90 || rotDeg < -90) rotDeg += 180;
    d.text('DIM', G.add(G.lerp(a, b, .5), G.mul(G.leftN(dir), 80)), fmtLen(G.dist(dm.a, dm.b), unit), 150, rotDeg);
  }

  // 外圍尺寸鏈：內層每一段、外層總長
  for (const g of dimSegments(outerDims(floor, WL.mitreMap(floor.walls)), 480, 900)) {
    const horiz = g.side === 'top' || g.side === 'bottom';
    d.line('DIM', g.a, g.b); d.line('DIM', g.ea, g.a); d.line('DIM', g.eb, g.b);
    for (const p of [g.a, g.b]) d.line('DIM', { x: p.x - 45, y: p.y - 45 }, { x: p.x + 45, y: p.y + 45 });
    const text = fmtLen(g.len, unit);
    if (g.len < text.length * 85) continue;
    const mx = (g.a.x + g.b.x) / 2, my = (g.a.y + g.b.y) / 2;
    if (horiz) d.text('DIM', { x: mx, y: my + 95 }, text, g.tier === 2 ? 140 : 120, 0);
    else d.text('DIM', { x: mx - 95, y: my }, text, g.tier === 2 ? 140 : 120, 90);
  }

  // 註記
  for (const t of floor.texts) d.text('TEXT', { x: t.x, y: t.y }, t.text, t.size || 200);

  // 現場照片位置（編號對應照片清單）
  (floor.photos || []).forEach((ph, i) => {
    d.c(0, 'CIRCLE').c(8, 'PHOTO').c(10, ph.x.toFixed(3)).c(20, ph.y.toFixed(3)).c(30, 0).c(40, '230');
    d.text('PHOTO', { x: ph.x, y: ph.y - 80 }, String(i + 1), 250);
    const a = ph.dir || 0, R = 900;
    d.line('PHOTO', { x: ph.x, y: ph.y }, { x: ph.x + Math.cos(a - 0.45) * R, y: ph.y + Math.sin(a - 0.45) * R });
    d.line('PHOTO', { x: ph.x, y: ph.y }, { x: ph.x + Math.cos(a + 0.45) * R, y: ph.y + Math.sin(a + 0.45) * R });
    if (ph.name) d.text('PHOTO', { x: ph.x, y: ph.y + 400 }, ph.name, 160);
  });

  // 圖框標題
  if (opt.name) {
    const b = G.bbox([...floor.walls.flatMap((w) => [w.a, w.b])]);
    if (b) d.text('TEXT', { x: b.x0, y: b.y0 - 900 }, `${opt.name}${opt.floorName ? ' — ' + opt.floorName : ''}`, 320, 0, 0);
  }

  d.c(0, 'ENDSEC').c(0, 'EOF');
  return d.out();
}
