// view3d.js — 3D 空間簡圖（等角投影，純 Canvas，離線可用）
import * as G from './geometry.js';
import { solidsOf } from './solid.js';

const ISO = { cx: Math.cos(Math.PI / 6), sy: Math.sin(Math.PI / 6) };

function project(p, s, ox, oy) {
  // 等角：x 向右下、y 向左下、z 向上
  return {
    x: ox + (p.x - p.y) * ISO.cx * s,
    y: oy + (p.x + p.y) * ISO.sy * s - p.z * s,
    d: p.x + p.y + p.z * 0.6,   // 畫家演算法深度
  };
}

/**
 * 繪製 3D 簡圖。
 * @param {HTMLCanvasElement} cv
 * @param {object} floor
 * @param {Array} rooms
 * @param {object} view { rotY: 弧度, zoom }
 */
export function render3d(cv, floor, rooms, view = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, r.width, r.height);

  const rot = view.rotY || 0;
  const boxes = solidsOf(floor);
  const all = [];
  for (const w of floor.walls) all.push(w.a, w.b);
  const bb = G.bbox(all);
  if (!bb) {
    ctx.fillStyle = '#7d766b'; ctx.font = '14px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('尚未繪製牆體', r.width / 2, r.height / 2);
    return;
  }
  const ctr = { x: bb.cx, y: bb.cy };
  const rp = (p) => {
    const q = G.rot(G.sub(p, ctr), rot);
    return { x: q.x, y: q.y };
  };
  // 自動縮放
  const corners = [{ x: bb.x0, y: bb.y0 }, { x: bb.x1, y: bb.y0 }, { x: bb.x1, y: bb.y1 }, { x: bb.x0, y: bb.y1 }];
  let maxr = 0;
  for (const c of corners) maxr = Math.max(maxr, G.len(G.sub(c, ctr)));
  const s = ((Math.min(r.width, r.height) * 0.36) / Math.max(maxr, 800)) * (view.zoom || 1);
  const ox = r.width / 2, oy = r.height / 2 + (floor.height || 2800) * s * 0.28;

  const P = (x, y, z) => project({ ...rp({ x, y }), z }, s, ox, oy);

  // 地板
  ctx.save();
  for (const room of rooms) {
    ctx.beginPath();
    room.inner.forEach((p, i) => {
      const q = P(p.x, p.y, 0);
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.fillStyle = '#22201d'; ctx.fill();
    ctx.strokeStyle = '#3a3632'; ctx.lineWidth = 1; ctx.stroke();
    const c = P(room.centroid.x, room.centroid.y, 0);
    ctx.fillStyle = '#8f8676'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(room.name, c.x, c.y);
  }
  ctx.restore();

  // 盒體：三個可見面
  const faces = [];
  for (const b of boxes) {
    const q = b.quad.map(rp);
    const top = q.map((p) => ({ ...p, z: b.z1 }));
    const bot = q.map((p) => ({ ...p, z: b.z0 }));
    faces.push({ pts: top, shade: 1.0, kind: b.kind, ext: b.ext });
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const side = [bot[i], bot[j], top[j], top[i]];
      // 只畫朝向觀者的面
      const nx = q[j].y - q[i].y, ny = -(q[j].x - q[i].x);
      const facing = nx * 1 + ny * 1;   // 投影方向 (1,1)
      if (facing <= 0) continue;
      faces.push({ pts: side, shade: i % 2 ? 0.72 : 0.86, kind: b.kind, ext: b.ext });
    }
  }
  faces.sort((a, b) => {
    const da = a.pts.reduce((s2, p) => s2 + p.x + p.y + p.z * .6, 0) / a.pts.length;
    const db = b.pts.reduce((s2, p) => s2 + p.x + p.y + p.z * .6, 0) / b.pts.length;
    return da - db;
  });

  for (const f of faces) {
    ctx.beginPath();
    f.pts.forEach((p, i) => { const q = project(p, s, ox, oy); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    let base = f.kind === 'glass' ? [110, 170, 230]
      : f.kind === 'item' ? [196, 174, 140]
        : f.kind === 'beam' ? [172, 152, 126]
          : f.kind === 'column' ? [120, 130, 145]
            : f.ext ? [150, 158, 172] : [178, 186, 198];
    const k = f.shade;
    ctx.fillStyle = f.kind === 'glass'
      ? `rgba(${base.map((c) => Math.round(c * k)).join(',')},0.42)`
      : `rgb(${base.map((c) => Math.round(c * k)).join(',')})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,34,.55)'; ctx.lineWidth = .8; ctx.stroke();
  }
}
