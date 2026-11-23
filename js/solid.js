// solid.js — 由平面圖產生 3D 體塊（3D 預覽與 DAE 匯出共用同一份幾何）
import * as G from './geometry.js';
import * as WL from './wall.js';
import { SYMBOLS } from './catalog.js';

/**
 * 乾淨牆體：轉角斜接不重疊、門窗只留孔洞、不含門片窗框。
 * 這是匯進 SketchUp 時要的形式 —— 牆是牆，門窗自己放。
 *
 * 每面牆輸出：
 *   · hi / lo 兩側牆面（依開口切成數塊矩形）
 *   · 開口四周的洞口內壁（門樘／窗樘的厚度面）
 *   · 頂面
 *   · 只有自由端才封口，接到別面牆的那端不封，才不會在轉角產生內部面
 * @returns {Array<{tri:[{x,y,z},{x,y,z},{x,y,z}]}>} 三角形清單
 */
export function cleanWallMesh(floor) {
  const H = floor.height || 2800;
  const walls = floor.walls || [];
  const mm = WL.mitreMap(walls);
  const free = WL.freeEnds(walls);
  const tris = [];
  const T = (a, b, c) => tris.push([a, b, c]);
  const quad = (a, b, c, d) => { T(a, b, c); T(a, c, d); };
  const P3 = (p, z) => ({ x: p.x, y: p.y, z });

  for (const w of walls) {
    const L = G.dist(w.a, w.b);
    if (L < 1) continue;
    const hi = WL.faceRange(w, 'hi', mm);
    const lo = WL.faceRange(w, 'lo', mm);
    const holes = WL.holesOf(w, floor.openings);

    // 沿長度方向的實牆區間（含斜接後的兩端）
    const segs = [];
    let cur = 0;
    for (const h of holes) { if (h.s > cur) segs.push([cur, h.s]); cur = Math.max(cur, h.e); }
    if (cur < L) segs.push([cur, L]);

    const HP = (s, z) => P3(WL.facePoint(hi.line, s <= 0.5 ? hi.s0 : (s >= L - 0.5 ? hi.s1 : s)), z);
    const LP = (s, z) => P3(WL.facePoint(lo.line, s <= 0.5 ? lo.s0 : (s >= L - 0.5 ? lo.s1 : s)), z);

    // 整段實牆：兩側牆面 + 頂面
    for (const [s, e] of segs) {
      if (e - s < 1) continue;
      quad(HP(s, 0), HP(e, 0), HP(e, H), HP(s, H));               // hi 面
      quad(LP(e, 0), LP(s, 0), LP(s, H), LP(e, H));               // lo 面（反向，法線朝外）
      quad(HP(s, H), HP(e, H), LP(e, H), LP(s, H));               // 頂
    }

    // 開口：上下方的牆面（門只有門楣，窗有窗下牆與窗上牆）
    for (const h of holes) {
      const bands = h.kind === 'window'
        ? [[0, h.sill || 900], [(h.sill || 900) + (h.height || 1500), H]]
        : [[h.height || 2100, H]];
      for (const [z0, z1] of bands) {
        if (z1 - z0 < 1) continue;
        quad(HP(h.s, z0), HP(h.e, z0), HP(h.e, z1), HP(h.s, z1));
        quad(LP(h.e, z0), LP(h.s, z0), LP(h.s, z1), LP(h.e, z1));
        quad(HP(h.s, z1), HP(h.e, z1), LP(h.e, z1), LP(h.s, z1));   // 洞口上緣內壁
        if (z0 > 0.5) quad(LP(h.s, z0), LP(h.e, z0), HP(h.e, z0), HP(h.s, z0)); // 窗台內壁
      }
      // 左右洞口側壁（門樘厚度面）
      const zTop = h.kind === 'window' ? (h.sill || 900) + (h.height || 1500) : (h.height || 2100);
      const zBot = h.kind === 'window' ? (h.sill || 900) : 0;
      quad(HP(h.s, zBot), LP(h.s, zBot), LP(h.s, zTop), HP(h.s, zTop));
      quad(LP(h.e, zBot), HP(h.e, zBot), HP(h.e, zTop), LP(h.e, zTop));
    }

    // 自由端封口（接到別面牆的那端不封，避免轉角內部多一片面）
    if (free.has(`${w.id}:a`)) quad(LP(0, 0), HP(0, 0), HP(0, H), LP(0, H));
    if (free.has(`${w.id}:b`)) quad(HP(L, 0), LP(L, 0), LP(L, H), HP(L, H));
  }
  return tris;
}

/**
 * 把平面圖轉成一組帶高度的柱體。
 * 牆體會依門窗切開：門留門楣、窗留窗下牆與窗上牆，玻璃另成一塊。
 * @returns {Array<{quad:Array<{x,y}>, z0:number, z1:number, kind:string, ext:boolean, name:string}>}
 */
export function solidsOf(floor) {
  const H = floor.height || 2800;
  const out = [];
  const mm = WL.mitreMap(floor.walls || []);

  for (const w of floor.walls || []) {
    const L = G.dist(w.a, w.b);
    if (L < 5) continue;
    const dir = WL.axisOf(w).d;
    const hi = WL.faceRange(w, 'hi', mm), lo = WL.faceRange(w, 'lo', mm);
    const ops = WL.holesOf(w, floor.openings);

    const push = (s, e, z0, z1, kind, name) => {
      if (e - s < 2 || z1 - z0 < 2) return;
      const hs = s <= 0.5 ? hi.s0 : s, he = e >= L - 0.5 ? hi.s1 : e;
      const ls = s <= 0.5 ? lo.s0 : s, le = e >= L - 0.5 ? lo.s1 : e;
      out.push({
        quad: [
          WL.facePoint(hi.line, hs), WL.facePoint(hi.line, he),
          WL.facePoint(lo.line, le), WL.facePoint(lo.line, ls),
        ],
        z0, z1, kind, ext: w.type === 'exterior', name,
      });
    };

    let cur = 0;
    for (const o of ops) {
      if (o.s > cur) push(cur, o.s, 0, H, 'wall', '牆');
      const oh = o.height || 2100;
      if (o.kind === 'window') {
        const sill = o.sill || 900;
        push(o.s, o.e, 0, sill, 'wall', '窗下牆');
        push(o.s, o.e, sill + oh, H, 'wall', '窗上牆');
        push(o.s, o.e, sill, sill + oh, 'glass', '窗');
      } else {
        push(o.s, o.e, oh, H, 'wall', o.kind === 'door' ? '門楣' : '開口上緣');
      }
      cur = Math.max(cur, o.e);
    }
    if (cur < L) push(cur, L, 0, H, 'wall', '牆');
  }

  for (const c of floor.columns || []) {
    const cs = Math.cos(c.rot || 0), sn = Math.sin(c.rot || 0);
    const T = (x, y) => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs });
    out.push({
      quad: [T(-c.w / 2, -c.h / 2), T(c.w / 2, -c.h / 2), T(c.w / 2, c.h / 2), T(-c.w / 2, c.h / 2)],
      z0: 0, z1: H, kind: 'column', ext: false, name: c.label || '柱',
    });
  }

  // 樑：沿線段的長方體。底部就是使用者量到的室內淨高，頂端接到天花。
  for (const bm of floor.beams || []) {
    if (G.dist(bm.a, bm.b) < 5) continue;
    out.push({
      quad: WL.beamQuad(bm),
      z0: Math.max(0, Math.min(H - 1, bm.clearH ?? 2400)), z1: H,
      kind: 'beam', ext: false, name: bm.label || '樑',
    });
  }

  for (const it of floor.items || []) {
    const hh = it.h3d ?? 700;
    if (hh <= 0) continue;
    const cs = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0);
    const T = (x, y) => ({ x: it.x + x * cs - y * sn, y: it.y + x * sn + y * cs });
    // 貼牆的面板類（插座、開關…）：平面上的符號比實物大，3D 改用實際厚度，
    // 貼在符號的背面（+y 側，也就是牆面），並抬到離地高度。
    const d3 = SYMBOLS[it.type]?.d3d;
    const y0 = d3 ? it.h / 2 - d3 : -it.h / 2;
    const hw = d3 && it.w <= 300 ? 45 : it.w / 2;
    const z0 = Math.max(0, it.z || 0);
    out.push({
      quad: [T(-hw, y0), T(hw, y0), T(hw, it.h / 2), T(-hw, it.h / 2)],
      z0, z1: z0 + hh, kind: 'item', ext: false, name: it.label || it.type,
    });
  }

  return out;
}

/** 地板樓板（0 往下長 thickness），回傳可三角化的多邊形柱體 */
export function slabsOf(rooms, thickness = 120) {
  return rooms.map((r) => ({
    poly: G.ensureCCW(r.inner),
    z0: -thickness, z1: 0,
    kind: 'floor', name: r.name || '樓板',
  }));
}

/** 天花樓板：同一份房間輪廓、同一個厚度，放在樓高之上 */
export function ceilingsOf(rooms, height, thickness = 120) {
  return rooms.map((r) => ({
    poly: G.ensureCCW(r.inner),
    z0: height, z1: height + thickness,
    kind: 'ceil', name: (r.name || '') + '天花',
  }));
}
