// wall.js — 牆體幾何：對齊方式、轉角斜接、開口分段
//
// 這裡是「一面牆實際占據哪塊空間」的唯一定義，畫布、DXF、SVG、3D 全部共用，
// 避免各處各算一套而對不起來。
//
// ── 牆線位置（align / off）────────────────────────────
// 現場用測距儀量到的是「室內淨尺寸」，不是牆中心線。所以每面牆可以指定
// 參考線（a→b 這條線）落在牆體的哪個位置：
//   off = 0     參考線在牆中心（CAD 習慣）
//   off = -0.5  參考線在左側面 → 牆體整個長在右邊
//   off = +0.5  參考線在右側面 → 牆體整個長在左邊
// 「左」是相對 a→b 方向的左手邊。逆時針畫房間時左手邊即室內，
// 因此量淨尺寸時把 off 設成 -0.5，量到多少畫多少，房間淨面積就完全正確。

import * as G from './geometry.js';

const NODE_TOL = 25;   // 端點視為同一節點的容差 (mm)

/** 牆體相對參考線的佔用區間（沿左法線） */
export function bandOf(w) {
  const t = w.thickness || 120;
  const off = (w.off || 0) * t;
  return { lo: off - t / 2, hi: off + t / 2, t, off };
}

/** 牆的方向與左法線 */
export function axisOf(w) {
  const d = G.norm(G.sub(w.b, w.a));
  return { d, n: G.leftN(d), len: G.dist(w.a, w.b) };
}

/**
 * 某一側牆面的直線。side: 'hi' = 左法線正向那一面，'lo' = 反向那一面。
 * 回傳 origin（s=0 處，對應 wall.a 的投影）與方向，s 與牆長參數同一套座標。
 */
export function faceLineOf(w, side) {
  const { d, n } = axisOf(w);
  const b = bandOf(w);
  return { origin: G.add(w.a, G.mul(n, side === 'hi' ? b.hi : b.lo)), d };
}
/** 面上的 s 參數 → 點 */
export const facePoint = (line, s) => G.add(line.origin, G.mul(line.d, s));

/* ── 轉角斜接 ───────────────────────── */
const key = (p) => `${Math.round(p.x / NODE_TOL)}|${Math.round(p.y / NODE_TOL)}`;

/**
 * 計算每面牆兩端的斜接點。
 * 只有「恰好兩面牆共用同一端點」時才斜接；T 形接頭或端點自由則保持平口，
 * 因為三面以上交會沒有唯一解，硬接反而會produce破面。
 * @returns {Map<string, {hi:{x,y}, lo:{x,y}}>} key = `${wallId}:a` / `${wallId}:b`
 */
export function mitreMap(walls) {
  const nodes = new Map();
  for (const w of walls) {
    if (G.dist(w.a, w.b) < 1) continue;
    for (const end of ['a', 'b']) {
      const k = key(w[end]);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push({ w, end });
    }
  }

  const out = new Map();
  for (const [, list] of nodes) {
    if (list.length !== 2) continue;
    const [A, B] = list;
    const P = A.w[A.end];

    // 以「背離節點」的方向為基準
    const arm = ({ w, end }) => {
      const { d, n } = axisOf(w);
      const fwd = end === 'a';                 // 端點在 a → 往 b 走，與儲存方向一致
      const u = fwd ? d : G.mul(d, -1);
      const nu = G.leftN(u);                   // = fwd ? n : -n
      const b = bandOf(w);
      // band 是沿 n 量的；換成沿 nu 量
      return { w, end, u, nu, hiU: fwd ? b.hi : -b.lo, loU: fwd ? b.lo : -b.hi, fwd };
    };
    const a = arm(A), b = arm(B);

    // 轉角的同一側：A 的 +nu 對應 B 的 −nu
    const c1 = G.lineLine(G.add(P, G.mul(a.nu, a.hiU)), a.u, G.add(P, G.mul(b.nu, b.loU)), b.u);
    const c2 = G.lineLine(G.add(P, G.mul(a.nu, a.loU)), a.u, G.add(P, G.mul(b.nu, b.hiU)), b.u);
    if (!c1 || !c2) continue;                  // 兩牆共線，維持平口

    // 換回各自 hi / lo（沿自身左法線 n）的說法
    out.set(`${A.w.id}:${A.end}`, A.end === 'a' ? { hi: c1, lo: c2 } : { hi: c2, lo: c1 });
    out.set(`${B.w.id}:${B.end}`, B.end === 'a' ? { hi: c2, lo: c1 } : { hi: c1, lo: c2 });
  }
  return out;
}

/**
 * 一面牆的四個角（依 hi 面 a→b、lo 面 b→a 排列，逆時針或順時針視方向而定）。
 * @param {Map} mm mitreMap() 結果；省略則不斜接
 */
export function quadOf(w, mm = null) {
  const { n } = axisOf(w);
  const b = bandOf(w);
  let aHi = G.add(w.a, G.mul(n, b.hi)), aLo = G.add(w.a, G.mul(n, b.lo));
  let bHi = G.add(w.b, G.mul(n, b.hi)), bLo = G.add(w.b, G.mul(n, b.lo));
  const ma = mm?.get(`${w.id}:a`), mb = mm?.get(`${w.id}:b`);
  if (ma) { aHi = ma.hi; aLo = ma.lo; }
  if (mb) { bHi = mb.hi; bLo = mb.lo; }
  return [aHi, bHi, bLo, aLo];
}

/** 某一側牆面被斜接後的 s 起訖（s 與牆長同一套參數） */
export function faceRange(w, side, mm = null) {
  const line = faceLineOf(w, side);
  const q = quadOf(w, mm);
  const pa = side === 'hi' ? q[0] : q[3];
  const pb = side === 'hi' ? q[1] : q[2];
  return {
    line,
    s0: G.dot(G.sub(pa, line.origin), line.d),
    s1: G.dot(G.sub(pb, line.origin), line.d),
  };
}

/* ── 開口分段 ───────────────────────── */
/** 這面牆上的門窗，換算成 [起, 迄] 區間並排序 */
export function holesOf(w, openings) {
  const L = G.dist(w.a, w.b);
  return (openings || [])
    .filter((o) => o.wallId === w.id)
    .map((o) => ({ ...o, s: Math.max(0, o.offset - o.width / 2), e: Math.min(L, o.offset + o.width / 2) }))
    .sort((x, y) => x.s - y.s);
}

/** 扣掉門窗後仍是實牆的區間 */
export function solidSpans(w, openings, s0 = 0, s1 = null) {
  const L = s1 == null ? G.dist(w.a, w.b) : s1;
  const out = [];
  let cur = s0;
  for (const h of holesOf(w, openings)) {
    if (h.s > cur) out.push([cur, h.s]);
    cur = Math.max(cur, h.e);
  }
  if (cur < L) out.push([cur, L]);
  return out.filter(([s, e]) => e - s > 1);
}

/** 端點是否為自由端（沒有其他牆接上來）→ 需要封口 */
export function freeEnds(walls) {
  const cnt = new Map();
  for (const w of walls) for (const end of ['a', 'b']) {
    const k = key(w[end]);
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const free = new Set();
  for (const w of walls) for (const end of ['a', 'b']) {
    if (cnt.get(key(w[end])) === 1) free.add(`${w.id}:${end}`);
  }
  return free;
}

/* ── 樑 ─────────────────────────────── */
/** 樑的實際軸線：跟牆一樣支援 off（線在樑體的哪一側） */
export function beamAxis(bm) {
  const d = G.norm(G.sub(bm.b, bm.a));
  const n = G.leftN(d);
  const sh = G.mul(n, (bm.off || 0) * bm.width);
  return { d, n, a: G.add(bm.a, sh), b: G.add(bm.b, sh) };
}
/** 樑的四個角（含 off 位移） */
export function beamQuad(bm) {
  const { d, n, a, b } = beamAxis(bm);
  const half = G.mul(n, bm.width / 2);
  return [G.add(a, half), G.add(b, half), G.sub(b, half), G.sub(a, half)];
}

/**
 * 房間偵測用：某條半邊（可能與牆的儲存方向相反）要往內縮多少。
 * 室內在半邊行進方向的左側，牆體佔到 hi（沿牆自身左法線）為止，
 * 因此內縮量 = off*t + t/2，方向相反時 off 要取負。
 */
export function inwardOffset(w, forward) {
  const t = w.thickness || 120;
  const off = (w.off || 0) * (forward ? 1 : -1);
  return off * t + t / 2;
}
