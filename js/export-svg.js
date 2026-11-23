// export-svg.js — 輸出向量平面圖 SVG（可直接印製 / 匯入 Illustrator）
import * as G from './geometry.js';
import * as WL from './wall.js';
import { flatten, SYMBOLS } from './catalog.js';
import { fmtLen, getUnit, toM2, toPing, fmt } from './util.js';
import { outerDims, dimSegments } from './autodim.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildSVG(floor, rooms, opt = {}) {
  const pts = [];
  for (const w of floor.walls) pts.push(w.a, w.b);
  for (const c of floor.columns) pts.push({ x: c.x - c.w, y: c.y - c.h }, { x: c.x + c.w, y: c.y + c.h });
  for (const it of floor.items || []) {
    const r = Math.max(it.w, it.h) / 2;
    pts.push({ x: it.x - r, y: it.y - r }, { x: it.x + r, y: it.y + r });
  }
  const b = G.bbox(pts) || { x0: 0, y0: 0, x1: 1000, y1: 1000, w: 1000, h: 1000 };
  const pad = 1500;      // 四邊要留給兩層外圍尺寸
  const W = b.w + pad * 2, H = b.h + pad * 2 + 700;
  // SVG 以 Y 向下，模型 Y 向上 → 轉換
  const X = (x) => (x - b.x0 + pad).toFixed(1);
  const Y = (y) => (b.y1 - y + pad).toFixed(1);
  const P = (p) => `${X(p.x)},${Y(p.y)}`;

  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${(W / 10).toFixed(0)}mm" height="${(H / 10).toFixed(0)}mm">`);
  o.push(`<style>
    text{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;text-anchor:middle;dominant-baseline:middle}
    .wall{fill:#2b3442}.wallx{fill:#161616}.room{fill:#c9a96e11}
    .dim{fill:#c0392b;font-size:130px}.rn{fill:#26313f;font-size:230px;font-weight:600}
    .ra{fill:#6b7a8d;font-size:150px}.sym{stroke:#2f6fb5;fill:none;stroke-width:20}
    .door{stroke:#3b4757;fill:none;stroke-width:20}.col{fill:#4a5568}
    .note{fill:#22303f;font-size:180px}.frame{fill:none;stroke:#c9d3df;stroke-width:12}
    .fnP{fill:#f2f5f9;stroke:#5a6b80;stroke-width:16}.fnL{stroke:#5a6b80;stroke-width:16;fill:none}
    .fnT{fill:#8f8676;font-size:130px}
    .od{stroke:#93a0b2;stroke-width:10;fill:none}.odT{stroke:#3d4a5c;stroke-width:12;fill:none}
    .odx{fill:#55627a;font-size:125px;stroke:none}.odTx{fill:#3d4a5c;font-size:140px;font-weight:700;stroke:none}
  </style>`);
  o.push(`<rect width="100%" height="100%" fill="#fff"/>`);

  for (const r of rooms) o.push(`<polygon class="room" points="${r.inner.map(P).join(' ')}"/>`);

  // 牆（含門窗斷開）
  for (const w of floor.walls) {
    const dir = G.norm(G.sub(w.b, w.a));
    const n = G.mul(G.leftN(dir), w.thickness / 2);
    const L = G.dist(w.a, w.b);
    const holes = floor.openings.filter((x) => x.wallId === w.id)
      .map((x) => [Math.max(0, x.offset - x.width / 2), Math.min(L, x.offset + x.width / 2)])
      .sort((p, q) => p[0] - q[0]);
    let cur = 0;
    const spans = [];
    for (const [s, e] of holes) { if (s > cur) spans.push([cur, s]); cur = Math.max(cur, e); }
    if (cur < L) spans.push([cur, L]);
    for (const [s, e] of spans) {
      const p1 = G.add(w.a, G.mul(dir, s)), p2 = G.add(w.a, G.mul(dir, e));
      const q = [G.add(p1, n), G.add(p2, n), G.sub(p2, n), G.sub(p1, n)];
      o.push(`<polygon class="${w.type === 'exterior' ? 'wallx' : 'wall'}" points="${q.map(P).join(' ')}"/>`);
    }
  }

  // 門窗符號
  for (const op of floor.openings) {
    const w = floor.walls.find((x) => x.id === op.wallId); if (!w) continue;
    const dir = G.norm(G.sub(w.b, w.a));
    const n = G.mul(G.leftN(dir), w.thickness / 2);
    const p1 = G.add(w.a, G.mul(dir, op.offset - op.width / 2));
    const p2 = G.add(w.a, G.mul(dir, op.offset + op.width / 2));
    if (op.kind === 'window') {
      o.push(`<polyline class="sym" points="${P(G.add(p1, n))} ${P(G.add(p2, n))}"/>`);
      o.push(`<polyline class="sym" points="${P(G.sub(p1, n))} ${P(G.sub(p2, n))}"/>`);
      o.push(`<polyline class="sym" points="${P(p1)} ${P(p2)}"/>`);
    } else if (op.kind === 'door') {
      const side = op.flip ? -1 : 1;
      const hinge = op.swing >= 0 ? p1 : p2;
      const other = op.swing >= 0 ? p2 : p1;
      const leaf = G.add(hinge, G.mul(G.mul(G.leftN(dir), side), op.width));
      o.push(`<polyline class="door" points="${P(hinge)} ${P(leaf)}"/>`);
      o.push(`<path class="door" d="M ${P(leaf).replace(',', ' ')} A ${op.width} ${op.width} 0 0 ${side > 0 ? 1 : 0} ${P(other).replace(',', ' ')}" stroke-dasharray="60 40"/>`);
    } else {
      o.push(`<polyline class="door" stroke-dasharray="80 50" points="${P(p1)} ${P(p2)}"/>`);
    }
  }

  for (const c of floor.columns) {
    const q = [
      { x: c.x - c.w / 2, y: c.y - c.h / 2 }, { x: c.x + c.w / 2, y: c.y - c.h / 2 },
      { x: c.x + c.w / 2, y: c.y + c.h / 2 }, { x: c.x - c.w / 2, y: c.y + c.h / 2 },
    ];
    o.push(`<polygon class="col" points="${q.map(P).join(' ')}"/>`);
  }

  // 樑：虛線框
  for (const bm of floor.beams || []) {
    const ax = WL.beamAxis(bm);
    const q = WL.beamQuad(bm);
    const dep = Math.max(1, (floor.height || 2800) - (bm.clearH ?? 2400));
    o.push(`<polygon points="${q.map(P).join(' ')}" fill="rgba(138,90,43,.08)" stroke="#8a5a2b" stroke-width="16" stroke-dasharray="120 80"/>`);
    const mid = G.lerp(ax.a, ax.b, 0.5);
    let a2 = G.deg(G.angleOf(ax.d));
    if (a2 > 90 || a2 < -90) a2 += 180;
    o.push(`<text x="${X(mid.x)}" y="${Y(mid.y)}" style="font-size:140px;fill:#8a5a2b" transform="rotate(${(-a2).toFixed(1)} ${X(mid.x)} ${Y(mid.y)})">樑${bm.width}×${dep} H${bm.clearH}</text>`);
  }

  // 家具／構件（先填多邊形面，再補線段與圓）
  for (const it of floor.items || []) {
    const { segs, arcs, polys } = flatten(it);
    for (const p of polys) o.push(`<polygon class="fnP" points="${p.map(P).join(' ')}"/>`);
    for (const [a, b] of segs) o.push(`<line class="fnL" x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}"/>`);
    for (const ar of arcs) o.push(`<circle class="fnL" cx="${X(ar.c.x)}" cy="${Y(ar.c.y)}" r="${ar.r}"/>`);
    if (it.showLabel !== false) {
      const name = SYMBOLS[it.type]?.tag ?? (it.label || SYMBOLS[it.type]?.name || '');
      const a = -G.deg(it.rot || 0);
      if (name) o.push(`<text class="fnT" x="${X(it.x)}" y="${Y(it.y)}" transform="rotate(${a.toFixed(1)} ${X(it.x)} ${Y(it.y)})">${esc(name)}</text>`);
    }
  }

  // 牆長標註
  const unit = getUnit();
  for (const w of floor.walls) {
    const L = G.dist(w.a, w.b);
    if (L < 300) continue;
    const dir = G.norm(G.sub(w.b, w.a));
    let a = G.deg(G.angleOf(dir));
    if (a > 90 || a < -90) a += 180;
    const mid = G.add(G.lerp(w.a, w.b, .5), G.mul(G.leftN(dir), w.thickness / 2 + 110));
    o.push(`<text class="dim" x="${X(mid.x)}" y="${Y(mid.y)}" transform="rotate(${(-a).toFixed(1)} ${X(mid.x)} ${Y(mid.y)})">${esc(fmtLen(L, unit))}</text>`);
  }

  // 外圍尺寸鏈：內層每一段、外層總長
  for (const g of dimSegments(outerDims(floor, WL.mitreMap(floor.walls)), 480, 900)) {
    const horiz = g.side === 'top' || g.side === 'bottom';
    const cls = g.tier === 2 ? 'odT' : 'od';
    o.push(`<line class="${cls}" x1="${X(g.a.x)}" y1="${Y(g.a.y)}" x2="${X(g.b.x)}" y2="${Y(g.b.y)}"/>`);
    for (const [e, p] of [[g.ea, g.a], [g.eb, g.b]]) {
      o.push(`<line class="od" x1="${X(e.x)}" y1="${Y(e.y)}" x2="${X(p.x)}" y2="${Y(p.y)}"/>`);
      o.push(`<line class="${cls}" x1="${X(p.x - 45)}" y1="${Y(p.y - 45)}" x2="${X(p.x + 45)}" y2="${Y(p.y + 45)}"/>`);
    }
    const text = fmtLen(g.len, unit);
    if (g.len < text.length * 85) continue;
    const mx = (g.a.x + g.b.x) / 2, my = (g.a.y + g.b.y) / 2;
    if (horiz) o.push(`<text class="${cls}x" x="${X(mx)}" y="${Y(my + 95)}">${esc(text)}</text>`);
    else o.push(`<text class="${cls}x" x="${X(mx - 95)}" y="${Y(my)}" transform="rotate(-90 ${X(mx - 95)} ${Y(my)})">${esc(text)}</text>`);
  }

  // 房間名稱與面積
  for (const r of rooms) {
    const m2 = toM2(r.area);
    o.push(`<text class="rn" x="${X(r.centroid.x)}" y="${Y(r.centroid.y + 130)}">${esc(r.name)}</text>`);
    o.push(`<text class="ra" x="${X(r.centroid.x)}" y="${Y(r.centroid.y - 130)}">${fmt(m2, 2)} m² · ${fmt(toPing(m2), 2)} 坪</text>`);
    o.push(`<text class="ra" x="${X(r.centroid.x)}" y="${Y(r.centroid.y - 330)}">H=${esc(fmtLen(floor.height || 2800, unit))} ${unit}</text>`);
  }
  for (const t of floor.texts) o.push(`<text class="note" x="${X(t.x)}" y="${Y(t.y)}">${esc(t.text)}</text>`);

  // 現場照片位置（含視角扇形）
  (floor.photos || []).forEach((ph, i) => {
    const R = 900, a = ph.dir || 0, sp = 0.45;
    const p1 = { x: ph.x + Math.cos(a - sp) * R, y: ph.y + Math.sin(a - sp) * R };
    const p2 = { x: ph.x + Math.cos(a + sp) * R, y: ph.y + Math.sin(a + sp) * R };
    o.push(`<path d="M ${X(ph.x)} ${Y(ph.y)} L ${X(p1.x)} ${Y(p1.y)} A ${R} ${R} 0 0 0 ${X(p2.x)} ${Y(p2.y)} Z" fill="rgba(232,133,58,.18)" stroke="#e8853a" stroke-width="14"/>`);
    o.push(`<circle cx="${X(ph.x)}" cy="${Y(ph.y)}" r="230" fill="#e8853a" stroke="#fff" stroke-width="45"/>`);
    o.push(`<text x="${X(ph.x)}" y="${Y(ph.y)}" style="font-size:270px;font-weight:700;fill:#fff">${i + 1}</text>`);
  });

  // 標題列
  const total = rooms.reduce((s, r) => s + r.area, 0);
  o.push(`<text x="${(W / 2).toFixed(0)}" y="${(H - 300).toFixed(0)}" style="font-size:280px;font-weight:700;fill:#26313f">${esc(opt.name || '平面圖')}${opt.floorName ? ' — ' + esc(opt.floorName) : ''}</text>`);
  o.push(`<text x="${(W / 2).toFixed(0)}" y="${(H - 90).toFixed(0)}" style="font-size:170px;fill:#6b7a8d">共 ${rooms.length} 區域 · 室內淨面積 ${fmt(toM2(total), 2)} m² (${fmt(toPing(toM2(total)), 2)} 坪) · 單位 ${unit}</text>`);
  o.push('</svg>');
  return o.join('\n');
}
