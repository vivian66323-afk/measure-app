// autodim.js — 自動外圍尺寸鏈（畫布、SVG、DXF 共用同一份計算）
//
// 量房圖四邊各排兩層尺寸：
//   內層 = 每一段（牆厚、房間淨寬交替），斷點取自「垂直於這一邊」的牆的兩個牆面
//   外層 = 這一邊的總長
// 現場最常用它來核對：各段加起來要等於總長，對不上就是某一段量錯了。
import * as WL from './wall.js';

const TOL = 2;          // mm，兩個斷點差在這以內視為同一個
const AXIS = 0.035;     // 牆方向與座標軸的夾角容許值（約 2°），超過就不算正交牆

function uniqSorted(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > TOL) out.push(v);
  return out;
}

/**
 * @returns {null | { box:{x0,y0,x1,y1}, sides:Array<{side:'top'|'bottom'|'left'|'right', ticks:number[]}> }}
 *   top/bottom 的 ticks 是 x 座標，left/right 是 y 座標（模型座標，mm）。
 */
export function outerDims(floor, mitre = null) {
  const walls = floor.walls || [];
  if (!walls.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const info = [];
  for (const w of walls) {
    const q = WL.quadOf(w, mitre);
    for (const p of q) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    // 牆面位置用未斜接的四角：斜接只會把角點沿牆面延伸，不影響牆面所在的座標
    const f = WL.quadOf(w, null);
    const xs = f.map((p) => p.x), ys = f.map((p) => p.y);
    const { d } = WL.axisOf(w);
    info.push({
      vert: Math.abs(d.x) < AXIS, horz: Math.abs(d.y) < AXIS,
      xa: Math.min(...xs), xb: Math.max(...xs), ya: Math.min(...ys), yb: Math.max(...ys),
    });
  }
  if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  // 某一邊只取「伸到這半邊」的橫向牆 —— 房子另一頭的短隔間不該把這一邊的尺寸鏈切碎
  const pick = (side) => {
    const t = side === 'top' || side === 'bottom' ? [x0, x1] : [y0, y1];
    for (const i of info) {
      if (side === 'top' && i.vert && i.yb >= cy) t.push(i.xa, i.xb);
      else if (side === 'bottom' && i.vert && i.ya <= cy) t.push(i.xa, i.xb);
      else if (side === 'right' && i.horz && i.xb >= cx) t.push(i.ya, i.yb);
      else if (side === 'left' && i.horz && i.xa <= cx) t.push(i.ya, i.yb);
    }
    return uniqSorted(t);
  };

  return {
    box: { x0, y0, x1, y1 },
    sides: ['top', 'bottom', 'left', 'right'].map((side) => ({ side, ticks: pick(side) })),
  };
}

/**
 * 展開成一條條尺寸線（模型座標）。off1 / off2 = 內層、外層離外框的距離（mm）。
 * 每筆：{ a, b, len, tier, side, ea, eb }；a→b 是尺寸線，ea/eb 是外框上對應的兩個起點。
 */
export function dimSegments(od, off1, off2) {
  if (!od) return [];
  const { x0, y0, x1, y1 } = od.box;
  const out = [];
  for (const { side, ticks } of od.sides) {
    const horiz = side === 'top' || side === 'bottom';
    const base = side === 'top' ? y1 : side === 'bottom' ? y0 : side === 'right' ? x1 : x0;
    const sgn = side === 'top' || side === 'right' ? 1 : -1;
    const P = (t, off) => (horiz ? { x: t, y: base + sgn * off } : { x: base + sgn * off, y: t });
    const push = (t0, t1, off, tier) => out.push({
      a: P(t0, off), b: P(t1, off), ea: P(t0, 0), eb: P(t1, 0), len: t1 - t0, tier, side,
    });
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    if (ticks.length > 2) for (let i = 0; i < ticks.length - 1; i++) push(ticks[i], ticks[i + 1], off1, 1);
    push(lo, hi, ticks.length > 2 ? off2 : off1, 2);
  }
  return out;
}
