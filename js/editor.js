// editor.js — 畫布視埠、繪製、工具與互動
import * as G from './geometry.js';
import * as M from './model.js';
import { detectRooms } from './rooms.js';
import { SYMBOLS, partsOf, cornersOf } from './catalog.js';
import * as WL from './wall.js';
import { moveSetOf, findSnap, mergeOverlaps } from './assemble.js';
import { fmtLen, getUnit, toM2, toPing, fmt, uid, raf, toast } from './util.js';

const C = {
  paper: '#ffffff',
  grid: '#eef2f7', gridMajor: '#dde5ef',
  wall: '#2b3442', wallExt: '#1b222c',
  roomFill: 'rgba(46,124,246,0.07)', roomFill2: 'rgba(46,124,246,0.12)',
  roomText: '#33415a', roomSub: '#7d8b9f',
  dim: '#c0392b', dimText: '#a5301f',
  sel: '#2e7cf6', selSoft: 'rgba(46,124,246,.25)',
  snap: '#ff9f0a', ghost: '#2e7cf6',
  column: '#4a5568', text: '#22303f',
  door: '#3b4757', window: '#2f6fb5',
  itemFill: '#f2f5f9', itemLine: '#5a6b80', itemText: '#7d8b9f',
  photo: '#e8853a', photoCone: 'rgba(232,133,58,.16)',
  beam: '#8a5a2b', beamFill: 'rgba(138,90,43,.10)',
};

const HIT_PX = 10;
const SNAP_PX = 14;

/* CAD 式游標。選取模式用「拾取框」（小正方形），不用箭頭 ——
   白底黑框各描一次，在白色圖紙與深色牆體上都看得清楚。 */
const cursorOf = (svg, x, y, fallback) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CURSOR_PICK = cursorOf(
  `<svg xmlns='http://www.w3.org/2000/svg' width='17' height='17'>`
  + `<rect x='3.5' y='3.5' width='10' height='10' fill='none' stroke='white' stroke-width='3'/>`
  + `<rect x='3.5' y='3.5' width='10' height='10' fill='none' stroke='#22303f' stroke-width='1.5'/></svg>`,
  8, 8, 'default');
/* 繪圖模式：十字 + 中央拾取框，跟 AutoCAD 一樣 */
const CURSOR_DRAW = cursorOf(
  `<svg xmlns='http://www.w3.org/2000/svg' width='33' height='33'>`
  + `<g stroke='white' stroke-width='3'><path d='M16.5 0v11M16.5 22v11M0 16.5h11M22 16.5h11'/>`
  + `<rect x='11.5' y='11.5' width='10' height='10' fill='none'/></g>`
  + `<g stroke='#22303f' stroke-width='1.3'><path d='M16.5 0v11M16.5 22v11M0 16.5h11M22 16.5h11'/>`
  + `<rect x='11.5' y='11.5' width='10' height='10' fill='none'/></g></svg>`,
  16, 16, 'crosshair');

export class Editor extends EventTarget {
  constructor(canvas, doc) {
    super();
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.doc = doc;
    this.scale = 0.035;          // 螢幕 px / 模型 mm
    this.ox = 80; this.oy = 400; // 模型原點的螢幕座標
    this.tool = 'select';
    this.sel = null;             // {kind, id}
    this.hover = null;
    this.rooms = [];
    this.showGrid = true;
    this.ortho = true;
    this.gridStep = 100;         // mm
    this.mouse = { x: 0, y: 0 }; // 模型座標
    this.snapPt = null;

    // 繪製狀態
    this.draft = null;           // { anchor, chain:bool }
    this.walk = null;            // 導線量房 { pos, heading, turn, segs }
    this.pendingMm = null;       // 待用量測值
    this.drag = null;
    this.itemType = 'sofa3';     // 家具工具目前選定的構件
    this.fs = null;              // 風水疊圖資料（由 app.js 填入 analyze() 結果）
    this.tracking = true;        // 自動正交追蹤
    this.precision = 5;          // 刻度精密度 (mm)：量測值先取整到這個刻度再套用
    this.guides = [];            // 目前生效的追蹤輔助線（畫面提示用）
    this.chain = [];             // 這一串連續繪製產生的牆 id，供「退回上一個點」使用
    this.beamChain = [];         // 同上，但屬於樑
    // 極座標繪製：鎖定下一段的方向角（度，0＝+X 向右，逆時針為正）。
    // 樑常常是斜的或非 90°，光靠正交鎖定畫不出來。
    this.polar = null;

    this._layer = document.createElement('canvas');
    this.render = raf(() => this._render());
    this.cv.style.cursor = CURSOR_PICK;      // 預設工具是選取
    this._bind();
    this.resize();
    this.recompute();
  }

  /* ── 座標轉換 ─────────────────────── */
  toScreen(p) { return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale }; }
  toModel(sx, sy) { return { x: (sx - this.ox) / this.scale, y: (this.oy - sy) / this.scale }; }
  px(mm) { return mm * this.scale; }
  mm(px) { return px / this.scale; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this._layer.width = this.cv.width; this._layer.height = this.cv.height;
    this.W = w; this.H = h; this.dpr = dpr;
    this.render();
  }

  fit(pad = 70) {
    const b = this.doc.extent();
    if (!b || b.w + b.h === 0) { this.scale = 0.035; this.ox = this.W / 2; this.oy = this.H / 2; this.render(); return; }
    const s = Math.min((this.W - pad * 2) / Math.max(b.w, 1000), (this.H - pad * 2) / Math.max(b.h, 1000));
    this.scale = Math.max(0.002, Math.min(s, 0.6));
    this.ox = this.W / 2 - b.cx * this.scale;
    this.oy = this.H / 2 + b.cy * this.scale;
    this.render();
  }

  zoomAt(sx, sy, k) {
    const before = this.toModel(sx, sy);
    this.scale = Math.max(0.0015, Math.min(this.scale * k, 1.2));
    const after = this.toModel(sx, sy);
    this.ox += (after.x - before.x) * this.scale;
    this.oy -= (after.y - before.y) * this.scale;
    this.render();
  }

  recompute() {
    this.rooms = detectRooms(this.doc.floor);
    this.mitre = WL.mitreMap(this.doc.walls);      // 轉角斜接，畫布與匯出共用同一份
    this.dispatchEvent(new CustomEvent('stats'));
    this.render();
  }

  setTool(t) {
    // 樑不用「畫」的：按下工具就在畫面中央放一支水平樑並選取，
    // 之後靠掣點調長度、旋轉把手轉角度、面板改尺寸 —— 比拉線直覺得多。
    if (t === 'beam') { this.placeBeam(); return; }
    this.tool = t;
    this.cv.style.cursor = t === 'select' ? CURSOR_PICK : CURSOR_DRAW;
    this.draft = null;
    this.chain = [];
    this.beamChain = [];
    this.guides = [];
    if (t !== 'walk') this.walk = null;
    this.sel = this.sel && t === 'select' ? this.sel : null;
    this.dispatchEvent(new CustomEvent('tool'));
    this.dispatchEvent(new CustomEvent('select'));
    this.render();
  }

  select(s) {
    this.sel = s;
    this.dispatchEvent(new CustomEvent('select'));
    this.render();
  }

  /* ── 吸附 ─────────────────────────── */
  /** 可用來做對齊追蹤的參考點：所有牆端點與柱心 */
  trackAnchors() {
    const out = [];
    for (const w of this.doc.walls) { out.push(w.a, w.b); }
    for (const c of this.doc.columns) out.push({ x: c.x, y: c.y });
    return out;
  }

  /**
   * 自動正交追蹤。
   * 沒有起點時：游標靠近某個既有點的水平／垂直延伸線就吸上去，兩線交會則吸到交點。
   * 有起點且開著正交時：先鎖在 90° 的射線上，再吸到射線與其他點對齊線的交會處
   * —— 這正是「牆要跟對面那根柱子對齊」的情境。
   */
  track(p) {
    this.guides = [];
    if (!this.tracking) return null;
    const tol = this.mm(SNAP_PX);
    const anchors = this.trackAnchors();
    if (!anchors.length) return null;

    // 情境二：沿著正交射線追蹤
    if (this.draft?.anchor && this.ortho) {
      const o = this.draft.anchor;
      const target = G.orthoPoint(o, p, 90);
      const d = G.norm(G.sub(target, o));
      if (G.len(G.sub(target, o)) < 1) return null;
      let best = null, bd = tol;
      for (const a of anchors) {
        if (G.dist(a, o) < 1) continue;
        // 射線與 x=a.x、y=a.y 兩條對齊線的交點
        for (const hit of [
          Math.abs(d.x) > 1e-6 ? G.add(o, G.mul(d, (a.x - o.x) / d.x)) : null,
          Math.abs(d.y) > 1e-6 ? G.add(o, G.mul(d, (a.y - o.y) / d.y)) : null,
        ]) {
          if (!hit) continue;
          if (G.dot(G.sub(hit, o), d) <= 0) continue;      // 只取射線前方
          const dist = G.dist(hit, target);
          if (dist < bd) { bd = dist; best = { pt: hit, from: a }; }
        }
      }
      if (best) {
        this.guides.push({ a: best.from, b: best.pt });
        return best.pt;
      }
      return null;
    }

    // 情境一：自由追蹤（水平／垂直對齊線）
    let hx = null, hy = null;
    for (const a of anchors) {
      if (Math.abs(p.x - a.x) < tol && (!hx || Math.abs(p.x - a.x) < Math.abs(p.x - hx.x))) hx = a;
      if (Math.abs(p.y - a.y) < tol && (!hy || Math.abs(p.y - a.y) < Math.abs(p.y - hy.y))) hy = a;
    }
    if (!hx && !hy) return null;
    const pt = { x: hx ? hx.x : p.x, y: hy ? hy.y : p.y };
    if (hx) this.guides.push({ a: hx, b: pt });
    if (hy) this.guides.push({ a: hy, b: pt });
    return pt;
  }

  snap(p, { skipWall = null, allowOrtho = true } = {}) {
    const tolMm = this.mm(SNAP_PX);
    let best = null, bd = tolMm;
    for (const w of this.doc.walls) {
      if (w.id === skipWall) continue;
      for (const e of ['a', 'b']) {
        const d = G.dist(p, w[e]);
        if (d < bd) { bd = d; best = { pt: { ...w[e] }, type: 'vertex' }; }
      }
    }
    if (!best) {
      for (const w of this.doc.walls) {
        if (w.id === skipWall) continue;
        const c = G.closestOnSeg(p, w.a, w.b);
        if (c.d < bd) { bd = c.d; best = { pt: c.pt, type: 'edge', wall: w }; }
      }
    }
    if (best) { this.snapPt = best; this.guides = []; return best.pt; }
    this.snapPt = null;

    // 追蹤優先於單純的正交／格線，因為它是「對齊既有圖元」，資訊量更高
    const t = allowOrtho ? this.track(p) : (this.guides = [], null);
    if (t) return t;

    if (allowOrtho && this.ortho && this.draft?.anchor) {
      return G.orthoPoint(this.draft.anchor, p, 90);
    }
    // 吸附精度獨立於格線顯示：格線關掉時仍照設定吸附
    if (this.gridStep > 0) {
      const g = this.gridStep;
      return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
    }
    return p;
  }

  /* ── 命中測試 ─────────────────────── */
  hitTest(p) {
    const tol = this.mm(HIT_PX);
    // 相機標記（最上層）
    for (let i = this.doc.photos.length - 1; i >= 0; i--) {
      const ph = this.doc.photos[i];
      if (G.dist(p, ph) < this.mm(16)) return { kind: 'photo', id: ph.id };
    }
    // 樑（畫在最上層的虛線，優先於家具與牆）
    for (const bm of this.doc.beams) {
      if (G.distToSeg(p, bm.a, bm.b) < Math.max(tol, bm.width / 2)) return { kind: 'beam', id: bm.id };
    }
    // 家具（在牆之上，先測；由後往前，後放的優先）
    for (let i = this.doc.items.length - 1; i >= 0; i--) {
      const it = this.doc.items[i];
      if (G.pointInPoly(p, cornersOf(it))) return { kind: 'item', id: it.id };
    }
    // 門窗
    for (const o of this.doc.openings) {
      const w = this.doc.wallById(o.wallId); if (!w) continue;
      const L = G.dist(w.a, w.b) || 1;
      const d = G.norm(G.sub(w.b, w.a));
      const c = G.add(w.a, G.mul(d, Math.min(o.offset, L)));
      if (G.dist(p, c) < Math.max(tol, o.width / 2)) return { kind: 'opening', id: o.id };
    }
    // 柱
    for (const c of this.doc.columns) {
      const dx = Math.abs(p.x - c.x), dy = Math.abs(p.y - c.y);
      if (dx < c.w / 2 + tol && dy < c.h / 2 + tol) return { kind: 'column', id: c.id };
    }
    // 牆
    let bw = null, bd = Infinity;
    for (const w of this.doc.walls) {
      const d = G.distToSeg(p, w.a, w.b);
      if (d < Math.max(tol, w.thickness / 2) && d < bd) { bd = d; bw = w; }
    }
    if (bw) return { kind: 'wall', id: bw.id };
    // 標註 / 文字
    for (const d of this.doc.floor.dims) if (G.distToSeg(p, d.a, d.b) < tol * 1.5) return { kind: 'dim', id: d.id };
    for (const t of this.doc.floor.texts) if (G.dist(p, { x: t.x, y: t.y }) < tol * 3) return { kind: 'text', id: t.id };
    // 房間
    for (const r of this.rooms) if (G.pointInPoly(p, r.inner)) return { kind: 'room', id: r.id };
    return null;
  }

  entity(sel) {
    if (!sel) return null;
    const f = this.doc.floor;
    switch (sel.kind) {
      case 'wall': return f.walls.find((x) => x.id === sel.id);
      case 'opening': return f.openings.find((x) => x.id === sel.id);
      case 'column': return f.columns.find((x) => x.id === sel.id);
      case 'dim': return f.dims.find((x) => x.id === sel.id);
      case 'text': return f.texts.find((x) => x.id === sel.id);
      case 'item': return f.items.find((x) => x.id === sel.id);
      case 'photo': return f.photos.find((x) => x.id === sel.id);
      case 'beam': return f.beams.find((x) => x.id === sel.id);
      case 'room': return this.rooms.find((x) => x.id === sel.id);
      default: return null;
    }
  }

  /* ── 量測值套用 ───────────────────── */
  applyMeasure(mm) {
    if (!(mm > 0)) return;
    // 雷射測距會給到 mm 甚至 0.1mm，但量房不需要那麼細 ——
    // 取整到設定的刻度（預設 0.5cm），圖上才不會滿是 247.34 這種毛邊數字。
    if (this.precision > 0) mm = Math.round(mm / this.precision) * this.precision;
    if (!(mm > 0)) return;
    const d = this.doc;

    if (this.tool === 'walk' && this.walk) { this.walkStep(mm); return; }

    if (this.tool === 'beam' && this.draft?.anchor) {
      this.commitBeam(this.draft.anchor, G.add(this.draft.anchor, G.mul(this.aimDir(), mm)));
      return;
    }
    const selBeam = this.sel?.kind === 'beam' ? this.entity(this.sel) : null;
    if (selBeam) {
      d.edit('設定樑長', () => {
        const dir = G.norm(G.sub(selBeam.b, selBeam.a));
        selBeam.b = G.add(selBeam.a, G.mul(dir, mm));
      });
      this.recompute();
      toast(`樑長設為 ${fmtLen(mm)} ${getUnit()}`, 'ok');
      return;
    }

    if (this.tool === 'wall' && this.draft?.anchor) {
      this.commitWall(this.draft.anchor, G.add(this.draft.anchor, G.mul(this.aimDir(), mm)));
      return;
    }
    const e = this.entity(this.sel);
    if (e && this.sel.kind === 'wall') {
      d.edit('設定牆長', () => {
        const dir = G.norm(G.sub(e.b, e.a));
        e.b = G.add(e.a, G.mul(dir, mm));
      });
      this.recompute();
      toast(`牆長設為 ${fmtLen(mm)} ${getUnit()}`, 'ok');
      return;
    }
    if (e && this.sel.kind === 'opening') {
      d.edit('設定寬度', () => { e.width = mm; });
      this.recompute();
      toast(`寬度設為 ${fmtLen(mm)} ${getUnit()}`, 'ok');
      return;
    }
    if (e && this.sel.kind === 'column') {
      d.edit('設定柱寬', () => { e.w = mm; });
      this.recompute();
      return;
    }
    if (e && this.sel.kind === 'item') {
      d.edit('設定家具寬', () => { e.w = mm; });
      this.recompute();
      toast(`寬度設為 ${fmtLen(mm)} ${getUnit()}`, 'ok');
      return;
    }
    this.pendingMm = mm;
    this.dispatchEvent(new CustomEvent('pending'));
    toast(`已記錄 ${fmtLen(mm)} ${getUnit()}，點擊起點開始畫`, '');
  }

  /**
   * 下一段要往哪個方向畫（單位向量）。
   *   1. 極座標鎖定了角度 → 就照那個角度
   *   2. 否則以游標指向為準（正交模式吸到 90° 倍數）
   *   3. 游標離起點太近就沿用上一段的方向
   */
  aimDir() {
    if (this.polar != null) {
      const r = G.rad(this.polar);
      return { x: Math.cos(r), y: Math.sin(r) };
    }
    const o = this.draft?.anchor;
    if (!o) return { x: 1, y: 0 };
    const v = G.sub(this.mouse, o);
    if (G.len(v) <= this.mm(18)) return G.norm(this.draft.dir || { x: 1, y: 0 });
    const a = this.ortho ? G.snapAngle(G.angleOf(v), 90) : G.angleOf(v);
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  /** 設定／解除極座標角度（度）。null＝解除 */
  setPolar(deg) {
    // 取到小數一位就好：rad↔deg 來回會產生 29.999999996 這種值，
    // 讓「45°」之類的預設按鈕比對不到而無法反白。
    this.polar = deg == null || !isFinite(deg)
      ? null : Math.round(G.deg(G.normAngle(G.rad(deg))) * 10) / 10;
    this.dispatchEvent(new CustomEvent('polar'));
    this.render();
  }

  /* ── 畫牆 ─────────────────────────── */
  defaultThickness() { return M.DEFAULTS.wallThick; }
  commitWall(a, b) {
    if (G.dist(a, b) < 20) return;
    const d = this.doc;
    let id = null;
    d.edit('畫牆', () => {
      const w = M.newWall(a, b, this._nextThick ?? this.defaultThickness(), this._nextType ?? (d.walls.length === 0 ? 'exterior' : 'interior'));
      d.walls.push(w);
      id = w.id;
    });
    this.chain.push(id);
    this.draft = { anchor: b, dir: G.norm(G.sub(b, a)), chain: true };
    this.recompute();
  }

  /** 在畫面中央放一支水平樑並直接選取 */
  placeBeam() {
    const c = this.toModel(this.W / 2, this.H / 2);
    const L = M.DEFAULTS.beamLen;
    const g = this.gridStep > 0 ? this.gridStep : 1;
    const cx = Math.round(c.x / g) * g, cy = Math.round(c.y / g) * g;
    let id = null;
    this.doc.edit('放置樑', () => {
      const bm = M.newBeam({ x: cx - L / 2, y: cy }, { x: cx + L / 2, y: cy },
        M.DEFAULTS.beamWidth, M.DEFAULTS.beamClearH, M.DEFAULTS.beamOff);
      this.doc.beams.push(bm);
      id = bm.id;
    });
    // 切回選取，掣點與旋轉把手立刻可用
    this.tool = 'select';
    this.cv.style.cursor = CURSOR_PICK;
    this.draft = null; this.chain = []; this.beamChain = []; this.guides = [];
    this.recompute();
    this.select({ kind: 'beam', id });
    this.dispatchEvent(new CustomEvent('tool'));
    toast('已放置一支水平樑：拖端點改長度、拉圓點旋轉', 'ok', 3500);
  }

  /** 樑的旋轉把手（從中點往側邊伸出） */
  _beamRotGrip(bm) {
    const ax = WL.beamAxis(bm);
    const mid = G.lerp(ax.a, ax.b, 0.5);
    return G.add(mid, G.mul(ax.n, bm.width / 2 + this.mm(26)));
  }

  commitBeam(a, b) {
    if (G.dist(a, b) < 20) return;
    const d = this.doc;
    let id = null;
    d.edit('畫樑', () => {
      const bm = M.newBeam(a, b, M.DEFAULTS.beamWidth, M.DEFAULTS.beamClearH, M.DEFAULTS.beamOff);
      d.beams.push(bm);
      id = bm.id;
    });
    this.beamChain.push(id);
    this.draft = { anchor: b, dir: G.norm(G.sub(b, a)), kind: 'beam' };
    this.recompute();
  }

  /**
   * 退回上一個點 —— 量錯一段時最常用的動作。
   * 依目前狀態決定退什麼：導線量房退一面牆、連續畫牆退回上一個節點、
   * 都不是的話就退回一步編輯。
   */
  undoPoint() {
    if (this.tool === 'walk' && this.walk) { this.walkUndo(); return true; }

    if (this.beamChain.length) {
      const id = this.beamChain.pop();
      const bm = this.doc.beams.find((x) => x.id === id);
      const back = bm ? { ...bm.a } : null;
      this.doc.edit('退回上一個點', () => { this.doc.floor.beams = this.doc.beams.filter((x) => x.id !== id); });
      this.draft = back ? { anchor: back, dir: this.draft?.dir || { x: 1, y: 0 }, kind: 'beam' } : null;
      this.recompute();
      toast('已退回上一個點', '');
      return true;
    }

    if (this.chain.length) {
      const id = this.chain.pop();
      const w = this.doc.wallById(id);
      const back = w ? { ...w.a } : null;
      this.doc.edit('退回上一個點', () => this.doc.removeWall(id));
      if (back) this.draft = { anchor: back, dir: this.draft?.dir || { x: 1, y: 0 }, chain: true };
      else this.draft = null;
      this.recompute();
      toast('已退回上一個點', '');
      return true;
    }

    if (this.draft?.anchor) { this.draft = null; this.render(); toast('已取消起點', ''); return true; }

    if (this.doc.undo()) { this.recompute(); toast('已復原', ''); return true; }
    return false;
  }

  /* ── 家具自動靠牆 ───────────────────
     沙發、床、櫥櫃這類東西幾乎都是靠牆擺的。所有符號的「背面」統一朝
     局部 +y，因此只要把 +y 轉向牆的方向，再把中心退開半個深度即可貼齊。 */
  snapItemToWall(it, p, maxDist = 900) {
    let best = null, bd = maxDist;
    for (const w of this.doc.walls) {
      const c = G.closestOnSeg(p, w.a, w.b);
      if (c.d < bd) { bd = c.d; best = { w, pt: c.pt }; }
    }
    if (!best) return false;
    const toWall = G.norm(G.sub(best.pt, p));
    if (!isFinite(toWall.x)) return false;
    it.rot = G.normAngle(G.angleOf(toWall) - Math.PI / 2);
    const back = G.mul(toWall, best.w.thickness / 2 + it.h / 2);
    it.x = best.pt.x - back.x;
    it.y = best.pt.y - back.y;
    return true;
  }

  /* ── 導線量房 ─────────────────────── */
  walkStart(p) {
    this.walk = { pos: { ...p }, heading: 0, turn: -Math.PI / 2, first: true, count: 0 };
    this.dispatchEvent(new CustomEvent('walk'));
    this.render();
  }
  walkStep(mm) {
    if (!this.walk) return;
    const w = this.walk;
    const dir = { x: Math.cos(w.heading), y: Math.sin(w.heading) };
    const next = G.add(w.pos, G.mul(dir, mm));
    const d = this.doc;
    // 起點自動吸附回第一點以閉合
    const first = w.firstPt || w.pos;
    const closing = w.count >= 2 && G.dist(next, first) < 300;
    const end = closing ? { ...first } : next;
    d.edit('導線量房', () => {
      d.walls.push(M.newWall(w.pos, end, this._nextThick ?? M.DEFAULTS.wallThick, 'exterior'));
    });
    this.chain.push(d.walls[d.walls.length - 1].id);
    if (!w.firstPt) w.firstPt = { ...w.pos };
    w.pos = end;
    w.heading = G.normAngle(w.heading + w.turn);
    w.count++;
    this.recompute();
    this.dispatchEvent(new CustomEvent('walk'));
    if (closing) { toast(`已閉合，共 ${w.count} 面牆`, 'ok'); this.walk = null; this.dispatchEvent(new CustomEvent('walk')); }
  }
  walkTurn(deg) {
    if (!this.walk) return;
    this.walk.turn = G.rad(deg);
    this.dispatchEvent(new CustomEvent('walk'));
    this.render();
  }
  walkRotate(deg) {
    if (!this.walk) return;
    this.walk.heading = G.normAngle(this.walk.heading + G.rad(deg));
    this.dispatchEvent(new CustomEvent('walk'));
    this.render();
  }
  walkUndo() {
    if (!this.walk) return;
    if (this.doc.undo()) {
      this.chain.pop();
      this.walk.count = Math.max(0, this.walk.count - 1);
      const last = this.doc.walls[this.doc.walls.length - 1];
      if (last) { this.walk.pos = { ...last.b }; this.walk.heading = G.angleOf(G.sub(last.b, last.a)); }
      this.recompute();
      this.dispatchEvent(new CustomEvent('walk'));
    }
  }

  /* ── 事件 ─────────────────────────────
     滑鼠與觸控的操作邏輯刻意不同：

     滑鼠：按下即動作（游標精準，所見即所點）。

     觸控：按下時不動作，等放開才判定。
       · 單指輕點        → 執行工具動作
       · 單指拖曳        → 平移畫面（或拖曳按住的圖元）
       · 雙指            → 捏合縮放 ＋ 平移
       · 雙擊            → 結束目前繪製
     手指沒有游標，若按下就畫，捏合時第一指落下就會先畫出一段牆。
     改成放開才判定，第二指一來就能乾淨地取消。 */
  _bind() {
    const cv = this.cv;
    const ptrs = new Map();
    let pinch = null;
    let touch = null;          // 單指觸控的待判定狀態
    const TAP_MOVE = 10;       // 位移超過這個像素就算拖曳，不再是輕點
    const TAP_MS = 600;

    const rect = () => cv.getBoundingClientRect();
    const localXY = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    const startPinch = () => {
      const [p1, p2] = [...ptrs.values()];
      pinch = {
        d: Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY),
        cx: (p1.clientX + p2.clientX) / 2, cy: (p1.clientY + p2.clientY) / 2,
      };
      // 取消單指可能已經起頭的動作，圖形回到手指落下前的狀態
      if (touch?.entityDrag) this.doc.abort();
      touch = null;
      this.drag = null;
      this.snapPt = null; this.guides = [];
      this.render();
    };

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, e);

      if (ptrs.size === 2) { startPinch(); return; }
      if (ptrs.size > 2) return;

      // 中鍵／右鍵一律平移
      if (e.button === 1 || e.button === 2) {
        this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy };
        return;
      }

      if (e.pointerType === 'touch') {
        const raw = this._pt(e);
        const hit = this.tool === 'select' ? this.hitTest(raw) : null;
        touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, t: Date.now(), moved: false, hit, ev: e, entityDrag: false };
        this.mouse = raw;
        return;                                   // 先不動作，等放開
      }
      this._down(e);
    });

    cv.addEventListener('pointermove', (e) => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, e);

      if (ptrs.size >= 2 && pinch) {
        const [p1, p2] = [...ptrs.values()];
        const d = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
        const cx = (p1.clientX + p2.clientX) / 2, cy = (p1.clientY + p2.clientY) / 2;
        const r = rect();
        this.ox += cx - pinch.cx; this.oy += cy - pinch.cy;      // 雙指拖曳＝平移
        if (pinch.d > 8 && d > 8) this.zoomAt(cx - r.left, cy - r.top, d / pinch.d);
        pinch = { d, cx, cy };
        this.render();
        return;
      }

      if (touch && e.pointerId === touch.id) {
        const dx = e.clientX - touch.sx, dy = e.clientY - touch.sy;
        if (!touch.moved && Math.hypot(dx, dy) > TAP_MOVE) {
          touch.moved = true;
          // 按住圖元拖曳 → 移動圖元；否則拖曳畫面
          if (touch.hit) {
            this.select(touch.hit);
            this._down(touch.ev);                 // 沿用滑鼠那套建立 drag
            touch.entityDrag = true;
          } else {
            this.drag = { mode: 'pan', sx: touch.sx, sy: touch.sy, ox: this.ox, oy: this.oy };
          }
        }
        if (touch.moved) this._move(e);
        return;
      }
      this._move(e);
    });

    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;

      if (touch && e.pointerId === touch.id) {
        if (!touch.moved && Date.now() - touch.t < TAP_MS) {
          // 觸控沒有 dblclick 事件，自己判定雙擊 = 結束目前繪製
          const now = Date.now();
          const dbl = this._lastTap && now - this._lastTap.t < 320
            && Math.hypot(e.clientX - this._lastTap.x, e.clientY - this._lastTap.y) < 26;
          this._down(touch.ev);
          if (dbl) {
            this.draft = null; this.chain = []; this.guides = [];
            this._lastTap = null;
            this.render();
          } else this._lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
        touch = null;
      }
      this._up(e);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (touch?.entityDrag) this.doc.abort();
      if (touch && e.pointerId === touch.id) touch = null;       // 取消就當沒發生
      this.drag = null;
      this.render();
    });

    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cancel(); });
    cv.addEventListener('dblclick', () => { this.draft = null; this.chain = []; this.guides = []; this.render(); });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = localXY(e);
      this.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(cv);
  }

  _pt(e) {
    const r = this.cv.getBoundingClientRect();
    return this.toModel(e.clientX - r.left, e.clientY - r.top);
  }

  _down(e) {
    const raw = this._pt(e);
    const p = this.snap(raw);
    const t = this.tool;

    if (t === 'select') {
      // 旋轉把手位在物件「外側」，一般的命中測試抓不到，必須先單獨檢查，
      // 否則點下去會被當成點在空白處而變成平移畫面。
      const cur = this.entity(this.sel);
      if (cur) {
        const grip = this.mm(16);
        if (this.sel.kind === 'beam' && G.dist(raw, this._beamRotGrip(cur)) < grip) {
          this.doc.begin();
          this.drag = { mode: 'beamRot', bm: cur, c: G.lerp(cur.a, cur.b, 0.5), len: G.dist(cur.a, cur.b) };
          return;
        }
        if (this.sel.kind === 'item' && G.dist(raw, this._rotGrip(cur)) < grip) {
          this.doc.begin();
          this.drag = { mode: 'rotate', o: cur };
          return;
        }
      }
      const hit = this.hitTest(raw);
      this.select(hit);
      if (hit && hit.kind === 'wall') {
        const w = this.entity(hit);
        const ta = G.dist(raw, w.a), tb = G.dist(raw, w.b);
        const grip = this.mm(12);
        this.doc.begin();
        if (ta < grip) this.drag = { mode: 'vertex', w, end: 'a' };
        else if (tb < grip) this.drag = { mode: 'vertex', w, end: 'b' };
        else this.drag = { mode: 'wall', w, from: raw, a0: { ...w.a }, b0: { ...w.b } };
      } else if (hit && hit.kind === 'beam') {
        const bm = this.entity(hit);
        const grip = this.mm(14);
        this.doc.begin();
        const rg = this._beamRotGrip(bm);
        if (G.dist(raw, rg) < grip) {
          this.drag = { mode: 'beamRot', bm, c: G.lerp(bm.a, bm.b, 0.5), len: G.dist(bm.a, bm.b) };
        } else if (G.dist(raw, bm.a) < grip) {
          this.drag = { mode: 'beamLen', bm, end: 'a' };
        } else if (G.dist(raw, bm.b) < grip) {
          this.drag = { mode: 'beamLen', bm, end: 'b' };
        } else {
          this.drag = { mode: 'beamMove', bm, from: raw, a0: { ...bm.a }, b0: { ...bm.b } };
        }
      } else if (hit && hit.kind === 'item') {
        const o = this.entity(hit);
        this.doc.begin();
        // 先看有沒有抓到旋轉把手
        const grip = this._rotGrip(o);
        if (grip && G.dist(raw, grip) < this.mm(14)) this.drag = { mode: 'rotate', o };
        else this.drag = { mode: 'moveItem', o, from: raw, x0: o.x, y0: o.y };
      } else if (hit && hit.kind === 'room') {
        // 整個空間一起搬 —— 量房是一間一間量完再拼起來的
        const room = this.entity(hit);
        if (room) {
          const set = moveSetOf(this.doc, room, this.rooms);
          if (set.walls.length) {
            this.doc.begin();
            this.drag = { mode: 'room', set, from: raw, snap: null, orig: this._snapshotSet(set) };
          }
        }
      } else if (hit && hit.kind === 'photo') {
        const o = this.entity(hit);
        this.doc.begin();
        this.drag = { mode: 'move', o, from: raw, x0: o.x, y0: o.y };
      } else if (hit && (hit.kind === 'column' || hit.kind === 'text')) {
        const o = this.entity(hit);
        this.doc.begin();
        this.drag = { mode: 'move', o, from: raw, x0: o.x, y0: o.y };
      } else if (hit && hit.kind === 'opening') {
        const o = this.entity(hit);
        this.doc.begin();
        this.drag = { mode: 'slide', o };
      } else if (!hit) {
        this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy };
      }
      return;
    }

    if (t === 'wall') {
      if (this.pendingMm && !this.draft) {
        this.draft = { anchor: p, dir: { x: 1, y: 0 } };
        const mm = this.pendingMm; this.pendingMm = null;
        this.dispatchEvent(new CustomEvent('pending'));
        this.applyMeasure(mm);
        return;
      }
      if (!this.draft) { this.draft = { anchor: p, dir: { x: 1, y: 0 } }; this.chain = []; }
      else this.commitWall(this.draft.anchor, p);
      this.render();
      return;
    }

    if (t === 'walk') {
      if (!this.walk) this.walkStart(p);
      return;
    }

    if (t === 'beam') {
      if (!this.draft) { this.draft = { anchor: p, dir: { x: 1, y: 0 }, kind: 'beam' }; this.chain = []; }
      else this.commitBeam(this.draft.anchor, p);
      this.render();
      return;
    }

    if (t === 'door' || t === 'window' || t === 'opening') {
      const hit = this.hitTest(raw);
      let w = null, off = 0;
      if (hit?.kind === 'wall') w = this.entity(hit);
      else {
        let bd = this.mm(28);
        for (const x of this.doc.walls) { const d = G.distToSeg(raw, x.a, x.b); if (d < bd) { bd = d; w = x; } }
      }
      if (!w) { toast('請點在牆上', 'bad'); return; }
      const c = G.closestOnSeg(raw, w.a, w.b);
      off = c.t * G.dist(w.a, w.b);
      const width = t === 'door' ? M.DEFAULTS.doorWidth : t === 'window' ? M.DEFAULTS.windowWidth : M.DEFAULTS.openingWidth;
      const op = M.newOpening(w.id, t, off, this.pendingMm || width);
      if (this.pendingMm) { this.pendingMm = null; this.dispatchEvent(new CustomEvent('pending')); }
      this.doc.edit('新增' + (t === 'door' ? '門' : t === 'window' ? '窗' : '開口'), () => this.doc.openings.push(op));
      this.recompute();
      this.select({ kind: 'opening', id: op.id });
      return;
    }

    if (t === 'photo') {
      // 實際開相機由 app.js 處理（需要 DOM 的 file input），這裡只回報位置
      this.dispatchEvent(new CustomEvent('photoplace', { detail: { x: p.x, y: p.y } }));
      return;
    }

    if (t === 'item') {
      const def = SYMBOLS[this.itemType];
      const it = M.newItem(this.itemType, p.x, p.y, def);
      this.snapItemToWall(it, raw);
      this.doc.edit('放置' + (def?.name || '構件'), () => this.doc.items.push(it));
      this.recompute();
      this.select({ kind: 'item', id: it.id });
      return;
    }

    if (t === 'column') {
      const c = M.newColumn(p.x, p.y);
      this.doc.edit('新增柱', () => this.doc.columns.push(c));
      this.recompute();
      this.select({ kind: 'column', id: c.id });
      return;
    }

    if (t === 'dim') {
      if (!this.draft) this.draft = { anchor: p, kind: 'dim' };
      else {
        const d = M.newDim(this.draft.anchor, p);
        this.doc.edit('新增標註', () => this.doc.floor.dims.push(d));
        this.draft = null;
        this.recompute();
      }
      this.render();
      return;
    }

    if (t === 'text') {
      const s = prompt('註記文字：', '');
      if (s) {
        const tt = M.newText(p.x, p.y, s);
        this.doc.edit('新增註記', () => this.doc.floor.texts.push(tt));
        this.recompute();
      }
      return;
    }

    if (t === 'room') {
      const r = this.rooms.find((x) => G.pointInPoly(raw, x.inner));
      if (!r) { toast('請點在已封閉的房間內', 'bad'); return; }
      const cur = r.label?.name || '';
      const name = prompt('房間名稱：', cur || '客廳');
      if (name == null) return;
      this.doc.edit('房間命名', () => {
        if (r.label) r.label.name = name;
        else this.doc.floor.roomLabels.push({ id: uid('rl'), x: r.centroid.x, y: r.centroid.y, name, note: '' });
      });
      this.recompute();
    }
  }

  _move(e) {
    const raw = this._pt(e);
    this.mouse = raw;
    this.dispatchEvent(new CustomEvent('coord'));

    if (this.drag?.mode === 'pan') {
      this.ox = this.drag.ox + (e.clientX - this.drag.sx);
      this.oy = this.drag.oy + (e.clientY - this.drag.sy);
      this.render();
      return;
    }
    if (this.drag) {
      const d = this.drag;
      if (d.mode === 'vertex') {
        d.w[d.end] = this.snap(raw, { skipWall: d.w.id, allowOrtho: false });
      } else if (d.mode === 'wall') {
        const dx = raw.x - d.from.x, dy = raw.y - d.from.y;
        d.w.a = { x: d.a0.x + dx, y: d.a0.y + dy };
        d.w.b = { x: d.b0.x + dx, y: d.b0.y + dy };
      } else if (d.mode === 'move') {
        const dx = raw.x - d.from.x, dy = raw.y - d.from.y;
        d.o.x = d.x0 + dx; d.o.y = d.y0 + dy;
      } else if (d.mode === 'beamLen') {
        // 掣點只調長度：投影到樑的軸線上，角度保持不變
        const fixed = d.end === 'a' ? d.bm.b : d.bm.a;
        const dir = G.norm(G.sub(d.bm[d.end], fixed));
        let L = G.dot(G.sub(raw, fixed), dir);
        if (this.gridStep > 0) L = Math.round(L / this.gridStep) * this.gridStep;
        d.bm[d.end] = G.add(fixed, G.mul(dir, Math.max(100, L)));
      } else if (d.mode === 'beamRot') {
        // 繞中點旋轉，長度不變
        let a = G.angleOf(G.sub(raw, d.c)) - Math.PI / 2;   // 把手在側邊，減 90° 回到軸向
        if (this.ortho) a = G.snapAngle(a, 15);
        const h = G.mul({ x: Math.cos(a), y: Math.sin(a) }, d.len / 2);
        d.bm.a = G.sub(d.c, h);
        d.bm.b = G.add(d.c, h);
      } else if (d.mode === 'beamMove') {
        const dx = raw.x - d.from.x, dy = raw.y - d.from.y;
        d.bm.a = { x: d.a0.x + dx, y: d.a0.y + dy };
        d.bm.b = { x: d.b0.x + dx, y: d.b0.y + dy };
      } else if (d.mode === 'moveItem') {
        const dx = raw.x - d.from.x, dy = raw.y - d.from.y;
        d.o.x = d.x0 + dx; d.o.y = d.y0 + dy;
        this.snapItemToWall(d.o, { x: d.o.x, y: d.o.y }, 450);   // 靠近牆就自動貼齊
      } else if (d.mode === 'rotate') {
        const a = G.angleOf(G.sub(raw, { x: d.o.x, y: d.o.y })) - Math.PI / 2;
        d.o.rot = G.normAngle(this.ortho ? G.snapAngle(a, 15) : a);
      } else if (d.mode === 'room') {
        // 先整體平移，再看門對門／門對牆／端點有沒有吸附機會
        const dx = raw.x - d.from.x, dy = raw.y - d.from.y;
        this._placeSet(d.set, d.orig, dx, dy);
        d.snap = findSnap(this.doc, d.set, this.rooms, this.mm(22));
        if (d.snap) this._placeSet(d.set, d.orig, dx + d.snap.delta.x, dy + d.snap.delta.y);
      } else if (d.mode === 'slide') {
        const w = this.doc.wallById(d.o.wallId);
        if (w) {
          const c = G.closestOnSeg(raw, w.a, w.b);
          const L = G.dist(w.a, w.b);
          d.o.offset = Math.max(d.o.width / 2, Math.min(L - d.o.width / 2, c.t * L));
        }
      }
      this.rooms = detectRooms(this.doc.floor);
      this.render();
      return;
    }

    if (this.tool === 'select') {
      const h = this.hitTest(raw);
      const changed = JSON.stringify(h) !== JSON.stringify(this.hover);
      this.hover = h;
      if (changed) this.render();
      return;
    }
    this.snap(raw);
    this.render();
  }

  /** 記下整組圖元的原始座標，拖曳時才能用「原始位置＋位移」重算，避免累積誤差 */
  _snapshotSet(set) {
    return {
      walls: set.walls.map((w) => ({ a: { ...w.a }, b: { ...w.b } })),
      items: set.items.map((i) => ({ x: i.x, y: i.y })),
      photos: set.photos.map((p) => ({ x: p.x, y: p.y })),
      texts: set.texts.map((t) => ({ x: t.x, y: t.y })),
      label: set.label ? { x: set.label.x, y: set.label.y } : null,
    };
  }
  _placeSet(set, orig, dx, dy) {
    set.walls.forEach((w, i) => {
      w.a = { x: orig.walls[i].a.x + dx, y: orig.walls[i].a.y + dy };
      w.b = { x: orig.walls[i].b.x + dx, y: orig.walls[i].b.y + dy };
    });
    set.items.forEach((it, i) => { it.x = orig.items[i].x + dx; it.y = orig.items[i].y + dy; });
    set.photos.forEach((p, i) => { p.x = orig.photos[i].x + dx; p.y = orig.photos[i].y + dy; });
    set.texts.forEach((t, i) => { t.x = orig.texts[i].x + dx; t.y = orig.texts[i].y + dy; });
    if (set.label && orig.label) { set.label.x = orig.label.x + dx; set.label.y = orig.label.y + dy; }
  }

  _up() {
    if (this.drag?.mode === 'room') {
      // 放開後把疊在一起的牆合併掉，否則兩間房中間會留下兩道重合的牆
      const r = mergeOverlaps(this.doc, this.drag.set);
      this.doc.commit('搬移空間');
      this.recompute();
      if (r.merged) toast(`已接合，合併 ${r.merged} 面重合的牆`, 'ok');
      else if (this.drag.snap) toast(this.drag.snap.kind === 'door' ? '門對門已對齊' : '已吸附對齊', 'ok');
      this.drag = null;
      return;
    }
    if (this.drag && this.drag.mode !== 'pan') {
      this.doc.commit('編輯');
      this.recompute();
    }
    this.drag = null;
  }

  cancel() {
    if (this.draft) { this.draft = null; this.chain = []; this.beamChain = []; this.guides = []; this.render(); return; }
    if (this.walk) { this.walk = null; this.dispatchEvent(new CustomEvent('walk')); this.render(); return; }
    if (this.sel) this.select(null);
  }

  /**
   * 選取的房間會刪掉哪些東西 —— 先算給使用者看，再由 app.js 確認後執行。
   *
   * 重點：一面長牆常常同時是兩個房間的邊（例如整排外牆），
   * 所以不是「整面刪或整面留」，而是只裁掉屬於這個房間的那一段。
   * 隔壁房間用到的部分會原地保留成較短的牆。
   */
  roomDeletePlan(room) {
    const f = this.doc.floor;
    const TOL = 1;

    // 把房間的每條邊換算成「在哪面牆的哪一段」
    const intervalsOf = (rm) => {
      const m = new Map();
      for (const e of rm.edges) {
        if (!e.wallId) continue;
        const w = this.doc.wallById(e.wallId);
        if (!w) continue;
        const d = G.norm(G.sub(w.b, w.a));
        const s = G.dot(G.sub(e.a, w.a), d);
        const t = G.dot(G.sub(e.b, w.a), d);
        if (!m.has(w.id)) m.set(w.id, []);
        m.get(w.id).push([Math.min(s, t), Math.max(s, t)]);
      }
      return m;
    };
    const merge = (ivs) => {
      const s = ivs.slice().sort((a, b) => a[0] - b[0]);
      const out = [];
      for (const iv of s) {
        const last = out[out.length - 1];
        if (last && iv[0] <= last[1] + TOL) last[1] = Math.max(last[1], iv[1]);
        else out.push([iv[0], iv[1]]);
      }
      return out;
    };
    /** a 扣掉 b */
    const subtract = (a, b) => {
      let cur = merge(a);
      for (const [bs, be] of merge(b)) {
        const next = [];
        for (const [s, e] of cur) {
          if (be <= s + TOL || bs >= e - TOL) { next.push([s, e]); continue; }
          if (bs - s > TOL) next.push([s, bs]);
          if (e - be > TOL) next.push([be, e]);
        }
        cur = next;
      }
      return cur;
    };

    const mine = intervalsOf(room);
    // 其他房間也在用的區間必須留著，否則刪一間會把隔壁的牆一起拆掉
    const others = new Map();
    for (const r of this.rooms) {
      if (r === room) continue;
      for (const [id, ivs] of intervalsOf(r)) {
        if (!others.has(id)) others.set(id, []);
        others.get(id).push(...ivs);
      }
    }

    const drop = [];      // 整面刪除
    const trim = [];      // 只裁掉一段，剩下的保留
    const byWall = new Map();
    for (const [id, ivs] of mine) {
      const w = this.doc.wallById(id);
      const L = G.dist(w.a, w.b);
      const removeIvs = subtract(ivs, others.get(id) || []);
      if (!removeIvs.length) continue;                 // 整面都被隔壁用到 → 完全不動
      byWall.set(id, removeIvs);
      const keep = subtract([[0, L]], removeIvs);
      if (!keep.length) drop.push(w);
      else trim.push({ wall: w, keep, L });
    }

    const dropIds = new Set(drop.map((w) => w.id));
    const keptOpeningIds = new Set();
    for (const t of trim) {
      for (const o of f.openings.filter((x) => x.wallId === t.wall.id)) {
        const s = o.offset - o.width / 2, e = o.offset + o.width / 2;
        if (t.keep.some(([ks, ke]) => s >= ks - TOL && e <= ke + TOL)) keptOpeningIds.add(o.id);
      }
    }
    const openings = f.openings.filter((o) => (dropIds.has(o.wallId)
      || (byWall.has(o.wallId) && !keptOpeningIds.has(o.id))));

    const items = f.items.filter((it) => G.pointInPoly({ x: it.x, y: it.y }, room.inner));
    const photos = f.photos.filter((p) => G.pointInPoly(p, room.inner));
    const texts = f.texts.filter((t) => G.pointInPoly(t, room.inner));
    return { room, drop, trim, openings, items, photos, texts };
  }

  /** 依 roomDeletePlan 的結果實際刪除 */
  applyRoomDelete(plan, { withItems = true } = {}) {
    const f = this.doc.floor;
    this.doc.edit('刪除區域', () => {
      // 整面刪
      for (const w of plan.drop) this.doc.removeWall(w.id);

      // 部分保留：原牆改成第一段，其餘段落複製成新牆
      for (const t of plan.trim) {
        const w = this.doc.wallById(t.wall.id);
        if (!w) continue;
        const a0 = { ...w.a };
        const d = G.norm(G.sub(w.b, w.a));
        const seg = ([s, e]) => ({ a: G.add(a0, G.mul(d, s)), b: G.add(a0, G.mul(d, e)), s, e });
        const parts = t.keep.map(seg);
        const first = parts.shift();
        w.a = first.a; w.b = first.b;
        const shift = first.s;
        for (const o of f.openings.filter((x) => x.wallId === w.id)) o.offset -= shift;
        for (const p of parts) {
          const nw = M.newWall(p.a, p.b, w.thickness, w.type, w.off);
          f.walls.push(nw);
          // 落在這一段裡的門窗跟著搬過去
          for (const o of f.openings.filter((x) => x.wallId === w.id)) {
            const os = o.offset + shift;
            if (os - o.width / 2 >= p.s - 1 && os + o.width / 2 <= p.e + 1) {
              o.wallId = nw.id;
              o.offset = os - p.s;
            }
          }
        }
      }

      // 被刪掉那一段上的門窗
      const oi = new Set(plan.openings.map((x) => x.id));
      f.openings = f.openings.filter((o) => !oi.has(o.id));

      if (plan.room.label) f.roomLabels = f.roomLabels.filter((l) => l.id !== plan.room.label.id);
      if (withItems) {
        const ii = new Set(plan.items.map((x) => x.id));
        const pi = new Set(plan.photos.map((x) => x.id));
        const ti = new Set(plan.texts.map((x) => x.id));
        f.items = f.items.filter((x) => !ii.has(x.id));
        f.photos = f.photos.filter((x) => !pi.has(x.id));
        f.texts = f.texts.filter((x) => !ti.has(x.id));
      }
    });
    this.select(null);
    this.recompute();
  }

  /** 只清掉房間名稱，牆體保留 */
  clearRoomLabel(room) {
    if (!room?.label) return;
    this.doc.edit('清除房間名稱', () => {
      this.doc.floor.roomLabels = this.doc.floor.roomLabels.filter((l) => l.id !== room.label.id);
    });
    this.recompute();
    this.select(null);
  }

  deleteSel() {
    if (!this.sel) return;
    if (this.sel.kind === 'room') {
      // 房間要刪的東西比較多，交給 app.js 跳確認視窗
      this.dispatchEvent(new CustomEvent('deleteroom', { detail: this.entity(this.sel) }));
      return;
    }
    this.doc.edit('刪除', () => this.doc.removeEntity(this.sel));
    this.select(null);
    this.recompute();
  }

  /* ── 繪製 ─────────────────────────── */
  _render() {
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);

    if (this.showGrid) this._grid(ctx);
    if (this.fs?.ok) this._fengshui(ctx);
    this._rooms(ctx);
    this._wallLayer();
    ctx.drawImage(this._layer, 0, 0, W, H);
    this._openingSymbols(ctx);
    this._items(ctx);
    this._columns(ctx);
    this._wallDims(ctx);
    this._dims(ctx);
    this._texts(ctx);
    this._roomLabels(ctx);
    this._beams(ctx);
    this._photos(ctx);
    this._overlay(ctx);
    // 畫面重畫完才通知，跟著畫面走的浮動控制項才不會跟圖形對不齊
    this.dispatchEvent(new CustomEvent('painted'));
  }

  /**
   * 繪製工具列要貼在哪裡（模型座標）。
   * 依序取：正在畫的起點 → 導線目前位置 → 選取中的牆的中點；都沒有就不顯示。
   */
  drawAnchor() {
    if (this.tool === 'walk' && this.walk) return { p: this.walk.pos, why: 'walk' };
    if (this.draft?.anchor) return { p: this.draft.anchor, why: 'draft' };
    if (this.sel?.kind === 'wall') {
      const w = this.entity(this.sel);
      if (w) return { p: G.lerp(w.a, w.b, 0.5), why: 'wall' };
    }
    if (this.chain.length) {
      const w = this.doc.wallById(this.chain[this.chain.length - 1]);
      if (w) return { p: { ...w.b }, why: 'chain' };
    }
    return null;
  }

  /** 目前這一串（或選取的牆）的牆線位置；混用時回傳 null */
  currentOff() {
    const ws = this.sel?.kind === 'wall' ? [this.entity(this.sel)]
      : this.chain.map((id) => this.doc.wallById(id)).filter(Boolean);
    if (!ws.length) return M.DEFAULTS.wallOff;
    const v = ws[0].off ?? 0;
    return ws.every((w) => (w.off ?? 0) === v) ? v : null;
  }

  /**
   * 切換牆線位置。選取中的牆就只改那一面；
   * 正在畫的話整串一起改，並把新的方向記成之後的預設 —— 畫到一半發現畫錯邊時最需要這個。
   */
  flipSide() {
    const cur = this.currentOff();
    const next = cur === null ? -0.5 : -cur || 0.5;   // 混用時先統一成靠下
    if (this.sel?.kind === 'wall') {
      const w = this.entity(this.sel);
      if (w) this.doc.edit('牆線位置', () => { w.off = next; });
    } else {
      const ws = this.chain.map((id) => this.doc.wallById(id)).filter(Boolean);
      if (ws.length) this.doc.edit('牆線位置', () => { for (const w of ws) w.off = next; });
      M.DEFAULTS.wallOff = next;
      this.dispatchEvent(new CustomEvent('defaults', { detail: { wallOff: next } }));
    }
    this.recompute();
    return next;
  }

  _grid(ctx) {
    const step = this.px(1000);                 // 1 m
    if (step < 6) return;
    const sub = step >= 46 ? this.px(100) : 0;  // 10 cm
    const x0 = this.ox % step, y0 = this.oy % step;
    ctx.lineWidth = 1;
    if (sub > 5) {
      ctx.strokeStyle = C.grid; ctx.beginPath();
      for (let x = this.ox % sub; x < this.W; x += sub) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, this.H); }
      for (let y = this.oy % sub; y < this.H; y += sub) { ctx.moveTo(0, y + .5); ctx.lineTo(this.W, y + .5); }
      ctx.stroke();
    }
    ctx.strokeStyle = C.gridMajor; ctx.beginPath();
    for (let x = x0; x < this.W; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, this.H); }
    for (let y = y0; y < this.H; y += step) { ctx.moveTo(0, y + .5); ctx.lineTo(this.W, y + .5); }
    ctx.stroke();
  }

  _polyPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => { const s = this.toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath();
  }

  _rooms(ctx) {
    for (const r of this.rooms) {
      const isSel = this.sel?.kind === 'room' && this.sel.id === r.id;
      ctx.fillStyle = isSel ? C.roomFill2 : C.roomFill;
      this._polyPath(ctx, r.inner);
      ctx.fill();
      if (isSel) { ctx.strokeStyle = C.sel; ctx.lineWidth = 2; ctx.stroke(); }
    }
  }

  /** 牆體用離屏圖層繪製，門窗以 destination-out 打洞 */
  _wallLayer() {
    const g = this._layer.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    g.globalCompositeOperation = 'source-over';

    for (const w of this.doc.walls) {
      const quad = this._wallQuad(w);
      g.fillStyle = w.type === 'exterior' ? C.wallExt : C.wall;
      this._polyPath(g, quad);
      g.fill();
    }
    // 打洞
    g.globalCompositeOperation = 'destination-out';
    for (const o of this.doc.openings) {
      const q = this._openingQuad(o);
      if (!q) continue;
      this._polyPath(g, q);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  _wallQuad(w) { return WL.quadOf(w, this.mitre); }

  _openingQuad(o, extra = 6) {
    const w = this.doc.wallById(o.wallId);
    if (!w) return null;
    const L = G.dist(w.a, w.b) || 1;
    const { d, n } = WL.axisOf(w);
    const b = WL.bandOf(w);
    const off = Math.max(0, Math.min(L, o.offset));
    const p1 = G.add(w.a, G.mul(d, Math.max(0, off - o.width / 2)));
    const p2 = G.add(w.a, G.mul(d, Math.min(L, off + o.width / 2)));
    const hi = G.mul(n, b.hi + extra), lo = G.mul(n, b.lo - extra);
    return [G.add(p1, hi), G.add(p2, hi), G.add(p2, lo), G.add(p1, lo)];
  }

  _openingSymbols(ctx) {
    for (const o of this.doc.openings) {
      const w = this.doc.wallById(o.wallId); if (!w) continue;
      const L = G.dist(w.a, w.b) || 1;
      const d = G.norm(G.sub(w.b, w.a));
      const n = G.leftN(d);
      const off = Math.max(0, Math.min(L, o.offset));
      const p1 = G.add(w.a, G.mul(d, off - o.width / 2));
      const p2 = G.add(w.a, G.mul(d, off + o.width / 2));
      const s1 = this.toScreen(p1), s2 = this.toScreen(p2);
      const sel = this.sel?.kind === 'opening' && this.sel.id === o.id;
      ctx.lineWidth = sel ? 2.5 : 1.4;

      if (o.kind === 'window') {
        const bd = WL.bandOf(w);
        const hi = G.mul(n, bd.hi), lo = G.mul(n, bd.lo);
        const a1 = this.toScreen(G.add(p1, hi)), a2 = this.toScreen(G.add(p2, hi));
        const b1 = this.toScreen(G.add(p1, lo)), b2 = this.toScreen(G.add(p2, lo));
        ctx.strokeStyle = sel ? C.sel : C.window;
        ctx.beginPath();
        ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y);
        ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y);
        ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      } else if (o.kind === 'door') {
        const side = o.flip ? -1 : 1;
        const hinge = o.swing >= 0 ? p1 : p2;
        const leafDir = G.mul(n, side);
        const leafEnd = G.add(hinge, G.mul(leafDir, o.width));
        const h = this.toScreen(hinge), le = this.toScreen(leafEnd);
        ctx.strokeStyle = sel ? C.sel : C.door;
        ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(le.x, le.y); ctx.stroke();
        const r = this.px(o.width);
        const a0 = Math.atan2(le.y - h.y, le.x - h.x);
        const other = o.swing >= 0 ? p2 : p1;
        const so = this.toScreen(other);
        const a1 = Math.atan2(so.y - h.y, so.x - h.x);
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.arc(h.x, h.y, r, a0, a1, G.normAngle(a1 - a0) < 0);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = sel ? C.sel : '#9aa7b6';
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (this.px(o.width) > 34) {
        const mid = G.lerp(p1, p2, .5);
        this._label(ctx, this.toScreen(mid), fmtLen(o.width), sel ? C.sel : '#59667a', 10);
      }
    }
  }

  /** 旋轉把手的模型座標（構件背面外側） */
  _rotGrip(it) {
    const d = { x: -Math.sin(it.rot || 0), y: Math.cos(it.rot || 0) };   // 局部 +y
    return G.add({ x: it.x, y: it.y }, G.mul(d, it.h / 2 + this.mm(22)));
  }

  _drawPart(g, pr) {
    const [k] = pr;
    const mode = (k === 'r' ? pr[5] : k === 'c' ? pr[4] : k === 'e' ? pr[5] : k === 'p' ? pr[3] : 's') || 'fs';
    g.beginPath();
    if (k === 'r') g.rect(pr[1] - pr[3] / 2, pr[2] - pr[4] / 2, pr[3], pr[4]);
    else if (k === 'c') g.arc(pr[1], pr[2], pr[3], 0, Math.PI * 2);
    else if (k === 'e') g.ellipse(pr[1], pr[2], pr[3], pr[4], 0, 0, Math.PI * 2);
    else if (k === 'l') { g.moveTo(pr[1], pr[2]); g.lineTo(pr[3], pr[4]); }
    else if (k === 'a') g.arc(pr[1], pr[2], pr[3], G.rad(pr[4]), G.rad(pr[5]));
    else if (k === 'p') {
      const a = pr[1];
      for (let i = 0; i < a.length; i += 2) (i ? g.lineTo(a[i], a[i + 1]) : g.moveTo(a[i], a[i + 1]));
      if (pr[2]) g.closePath();
    }
    if (mode.includes('f')) g.fill();
    if (mode.includes('s')) g.stroke();
  }

  _items(ctx) {
    for (const it of this.doc.items) {
      const sel = this.sel?.kind === 'item' && this.sel.id === it.id;
      const hov = this.hover?.kind === 'item' && this.hover.id === it.id;
      const s = this.toScreen({ x: it.x, y: it.y });
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(-(it.rot || 0));           // 畫布 Y 向下，旋轉取負
      ctx.scale(this.scale, -this.scale);   // 之後即可直接用 mm、Y 向上作圖
      ctx.lineWidth = (sel ? 2.2 : 1.3) / this.scale;
      ctx.strokeStyle = sel ? C.sel : hov ? '#8aa6c8' : C.itemLine;
      ctx.fillStyle = C.itemFill;
      ctx.lineJoin = 'round';
      for (const pr of partsOf(it)) this._drawPart(ctx, pr);
      ctx.restore();

      const def = SYMBOLS[it.type];
      if (it.showLabel !== false && this.px(Math.min(it.w, it.h)) > 42) {
        this._label(ctx, { x: s.x, y: s.y }, it.label || def?.name || '', sel ? C.sel : C.itemText, 10, false);
      }
      if (sel) {
        const gp = this.toScreen(this._rotGrip(it));
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(gp.x, gp.y);
        ctx.strokeStyle = C.sel; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(gp.x, gp.y, 7, 0, 7);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = C.sel; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(gp.x, gp.y, 3, 0, 7); ctx.fillStyle = C.sel; ctx.fill();
      }
    }
  }

  _columns(ctx) {
    for (const c of this.doc.columns) {
      const sel = this.sel?.kind === 'column' && this.sel.id === c.id;
      const pts = [
        { x: c.x - c.w / 2, y: c.y - c.h / 2 }, { x: c.x + c.w / 2, y: c.y - c.h / 2 },
        { x: c.x + c.w / 2, y: c.y + c.h / 2 }, { x: c.x - c.w / 2, y: c.y + c.h / 2 },
      ].map((p) => (c.rot ? G.add({ x: c.x, y: c.y }, G.rot(G.sub(p, { x: c.x, y: c.y }), c.rot)) : p));
      this._polyPath(ctx, pts);
      ctx.fillStyle = C.column; ctx.fill();
      if (sel) { ctx.strokeStyle = C.sel; ctx.lineWidth = 2.5; ctx.stroke(); }
      // 斜線表示柱
      const s0 = this.toScreen(pts[0]), s2 = this.toScreen(pts[2]);
      ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
    }
  }

  /** 每面牆的長度標籤 */
  _wallDims(ctx) {
    for (const w of this.doc.walls) {
      const L = G.dist(w.a, w.b);
      if (this.px(L) < 34) continue;
      const mid = G.lerp(w.a, w.b, .5);
      const sel = this.sel?.kind === 'wall' && this.sel.id === w.id;
      this._label(ctx, this.toScreen(mid), fmtLen(L), sel ? C.sel : C.dimText, sel ? 12 : 11, true);
    }
  }

  _label(ctx, s, text, color, size = 11, box = true) {
    ctx.font = `600 ${size}px ui-monospace,"Segoe UI",system-ui,sans-serif`;
    const w = ctx.measureText(text).width;
    if (box) {
      ctx.fillStyle = '#ffffffdd';
      ctx.beginPath();
      const r = 3, x = s.x - w / 2 - 4, y = s.y - size / 2 - 3, ww = w + 8, hh = size + 6;
      ctx.roundRect(x, y, ww, hh, r);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, s.x, s.y);
  }

  _dims(ctx) {
    for (const d of this.doc.floor.dims) {
      const sel = this.sel?.kind === 'dim' && this.sel.id === d.id;
      const dir = G.norm(G.sub(d.b, d.a));
      const n = G.mul(G.leftN(dir), d.off);
      const a = G.add(d.a, n), b = G.add(d.b, n);
      const sa = this.toScreen(a), sb = this.toScreen(b);
      const ea = this.toScreen(d.a), eb = this.toScreen(d.b);
      ctx.strokeStyle = sel ? C.sel : C.dim; ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y);
      ctx.moveTo(ea.x, ea.y); ctx.lineTo(sa.x, sa.y);
      ctx.moveTo(eb.x, eb.y); ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      this._arrow(ctx, sa, sb); this._arrow(ctx, sb, sa);
      this._label(ctx, { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 }, fmtLen(G.dist(d.a, d.b)), sel ? C.sel : C.dimText, 11);
    }
  }
  _arrow(ctx, from, to) {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    const L = 7;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(from.x + Math.cos(a - .35) * L, from.y + Math.sin(a - .35) * L);
    ctx.lineTo(from.x + Math.cos(a + .35) * L, from.y + Math.sin(a + .35) * L);
    ctx.closePath(); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  }

  _texts(ctx) {
    for (const t of this.doc.floor.texts) {
      const s = this.toScreen(t);
      const sel = this.sel?.kind === 'text' && this.sel.id === t.id;
      ctx.font = `500 ${Math.max(10, Math.min(this.px(t.size), 26))}px system-ui,sans-serif`;
      ctx.fillStyle = sel ? C.sel : C.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t.text, s.x, s.y);
    }
  }

  _roomLabels(ctx) {
    for (const r of this.rooms) {
      const s = this.toScreen(r.centroid);
      const m2 = toM2(r.area);
      if (this.px(Math.sqrt(r.area)) < 46) continue;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 13px system-ui,sans-serif';
      ctx.fillStyle = C.roomText;
      ctx.fillText(r.name, s.x, s.y - 9);
      ctx.font = '11px ui-monospace,system-ui,sans-serif';
      ctx.fillStyle = C.roomSub;
      ctx.fillText(`${fmt(m2, 2)} m² · ${fmt(toPing(m2), 2)} 坪`, s.x, s.y + 8);
    }
  }

  /** 樑：建築慣例用虛線框表示（在天花下方、剖切面之上的構件） */
  _beams(ctx) {
    for (const bm of this.doc.beams) {
      const L = G.dist(bm.a, bm.b);
      if (L < 1) continue;
      const sel = this.sel?.kind === 'beam' && this.sel.id === bm.id;
      const q = WL.beamQuad(bm);
      this._polyPath(ctx, q);
      ctx.fillStyle = C.beamFill; ctx.fill();
      ctx.strokeStyle = sel ? C.sel : C.beam;
      ctx.lineWidth = sel ? 2.2 : 1.4;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (this.px(L) > 60) {
        const ax = WL.beamAxis(bm);
        const mid = G.lerp(ax.a, ax.b, 0.5);
        const dep = M.beamDepth(bm, this.doc.floor.height);
        this._label(ctx, this.toScreen(mid), `樑 ${bm.width}×${dep}　淨高 ${bm.clearH}`, sel ? C.sel : C.beam, 10);
      }
      if (sel) {
        // 兩端的長度掣點：方形，跟旋轉把手（圓形）明顯區隔
        for (const e of ['a', 'b']) {
          const s = this.toScreen(bm[e]);
          ctx.beginPath(); ctx.rect(s.x - 5.5, s.y - 5.5, 11, 11);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.strokeStyle = C.sel; ctx.lineWidth = 2.2; ctx.stroke();
        }
        // 旋轉把手
        const ax = WL.beamAxis(bm);
        const mid = this.toScreen(G.lerp(ax.a, ax.b, 0.5));
        const gp = this.toScreen(this._beamRotGrip(bm));
        ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.lineTo(gp.x, gp.y);
        ctx.strokeStyle = C.sel; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(gp.x, gp.y, 7.5, 0, 7);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = C.sel; ctx.lineWidth = 2.2; ctx.stroke();
        ctx.beginPath(); ctx.arc(gp.x, gp.y, 3, 0, 7);
        ctx.fillStyle = C.sel; ctx.fill();
        // 拖曳中即時顯示長度與角度
        if (this.drag?.bm === bm) {
          const L2 = G.dist(bm.a, bm.b);
          let deg = G.deg(G.angleOf(G.sub(bm.b, bm.a)));
          if (deg > 90 || deg < -90) deg += 180;
          this._label(ctx, { x: mid.x, y: mid.y - 24 },
            `${fmtLen(L2)} ${getUnit()}  ∠${deg.toFixed(1)}°`, C.sel, 12);
        }
      }
    }
  }

  /** 現場照片：畫成帶視角扇形的相機標記，一眼看出是站哪、朝哪拍的 */
  _photos(ctx) {
    this.doc.photos.forEach((ph, i) => {
      const sel = this.sel?.kind === 'photo' && this.sel.id === ph.id;
      const s = this.toScreen(ph);
      const r = 34;
      const a = -(ph.dir || 0);            // 畫布 Y 向下
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, r, a - 0.45, a + 0.45);
      ctx.closePath();
      ctx.fillStyle = C.photoCone; ctx.fill();
      ctx.strokeStyle = C.photo; ctx.lineWidth = 1; ctx.stroke();

      ctx.beginPath(); ctx.arc(s.x, s.y, sel ? 11 : 9, 0, 7);
      ctx.fillStyle = C.photo; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), s.x, s.y + .5);
      if (ph.marks?.length) {
        ctx.beginPath(); ctx.arc(s.x + 9, s.y - 9, 5.5, 0, 7);
        ctx.fillStyle = '#2ec27e'; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '700 8px system-ui';
        ctx.fillText(String(ph.marks.length), s.x + 9, s.y - 8.5);
      }
    });
  }

  /** 風水八方位疊圖（民俗參考用，畫在最底層不干擾製圖） */
  _fengshui(ctx) {
    const fs = this.fs;
    const c = this.toScreen(fs.center);
    const b = this.doc.extent();
    const R = b ? this.px(Math.max(b.w, b.h) * 0.72) : 240;
    ctx.save();
    for (const s of fs.sectors) {
      // 羅盤方位 → 螢幕角度（畫布 Y 向下）
      const mid = -(Math.PI / 2 - G.rad(s.deg) + fs.north);
      const a0 = mid - Math.PI / 8, a1 = mid + Math.PI / 8;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.arc(c.x, c.y, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = s.luck === 'good' ? 'rgba(46,194,126,.09)' : 'rgba(240,74,74,.09)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,140,165,.30)';
      ctx.lineWidth = 1; ctx.stroke();
      const tp = { x: c.x + Math.cos(mid) * R * 0.82, y: c.y + Math.sin(mid) * R * 0.82 };
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 12px system-ui,sans-serif';
      ctx.fillStyle = s.luck === 'good' ? '#1a8f5b' : '#c0392b';
      ctx.fillText(`${s.name} ${s.star}`, tp.x, tp.y);
    }
    if (fs.wealth) this._fsMark(ctx, this.toScreen(fs.wealth), '明財位', '#d4a017');
    if (fs.study) this._fsMark(ctx, this.toScreen(fs.study), '文昌位', '#2f6fb5');
    ctx.restore();
  }
  _fsMark(ctx, s, text, color) {
    ctx.beginPath(); ctx.arc(s.x, s.y, 14, 0, 7);
    ctx.fillStyle = color + '2e'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '600 11px system-ui,sans-serif'; ctx.fillStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, s.x, s.y + 26);
  }

  /** 指北針（固定在畫面左上角，跟著樓層的 north 轉） */
  _compass(ctx) {
    const x = 40, y = 46, r = 17;
    const a = -Math.PI / 2 - (this.doc.floor.north || 0);   // 螢幕上「北」的方向
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, 7);
    ctx.fillStyle = '#ffffffcc'; ctx.fill();
    ctx.strokeStyle = '#c9d3df'; ctx.lineWidth = 1; ctx.stroke();
    const tip = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    const bk = { x: -tip.x * 0.55, y: -tip.y * 0.55 };
    const pl = { x: Math.cos(a + Math.PI / 2) * r * 0.34, y: Math.sin(a + Math.PI / 2) * r * 0.34 };
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y); ctx.lineTo(pl.x, pl.y); ctx.lineTo(bk.x, bk.y); ctx.lineTo(-pl.x, -pl.y);
    ctx.closePath();
    ctx.fillStyle = '#2e7cf6'; ctx.fill();
    ctx.font = '700 10px system-ui,sans-serif';
    ctx.fillStyle = '#33415a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('北', Math.cos(a) * (r + 13), Math.sin(a) * (r + 13));
    ctx.restore();
  }

  _overlay(ctx) {
    // 選取的牆加亮
    if (this.sel?.kind === 'wall') {
      const w = this.entity(this.sel);
      if (w) {
        this._polyPath(ctx, this._wallQuad(w));
        ctx.strokeStyle = C.sel; ctx.lineWidth = 2; ctx.stroke();
        for (const e of ['a', 'b']) {
          const s = this.toScreen(w[e]);
          ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
          ctx.strokeStyle = C.sel; ctx.lineWidth = 2; ctx.stroke();
        }
      }
    }
    // hover
    if (this.tool === 'select' && this.hover && JSON.stringify(this.hover) !== JSON.stringify(this.sel)) {
      const e = this.entity(this.hover);
      if (this.hover.kind === 'wall' && e) {
        this._polyPath(ctx, this._wallQuad(e));
        ctx.strokeStyle = C.selSoft; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    // 畫牆／畫樑預覽
    if (this.draft?.anchor) {
      let target;
      if (this.polar != null) {
        // 極座標鎖定：預覽線固定在該角度上，長度取游標的投影
        const dir = this.aimDir();
        const L = Math.max(0, G.dot(G.sub(this.mouse, this.draft.anchor), dir));
        target = G.add(this.draft.anchor, G.mul(dir, L));
      } else if (this.ortho && (this.tool === 'wall' || this.tool === 'beam')) {
        target = G.orthoPoint(this.draft.anchor, this.mouse, 90);
      } else target = this.snapPt?.pt || this.mouse;
      const a = this.toScreen(this.draft.anchor), b = this.toScreen(target);
      ctx.strokeStyle = C.ghost; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      const L = G.dist(this.draft.anchor, target);
      const ang = G.deg(G.angleOf(G.sub(target, this.draft.anchor)));
      this._label(ctx, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        `${fmtLen(L)} ${getUnit()}${this.polar != null ? `  ∠${this.polar.toFixed(1)}°` : (L > 1 ? `  ∠${ang.toFixed(0)}°` : '')}`,
        this.polar != null ? '#d4a017' : C.ghost, 12);
      ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, 7); ctx.fillStyle = C.ghost; ctx.fill();
      // 極座標鎖定時把整條角度射線畫出來
      if (this.polar != null) {
        const far = G.add(this.draft.anchor, G.mul(this.aimDir(), this.mm(Math.max(this.W, this.H))));
        const f2 = this.toScreen(far);
        ctx.strokeStyle = '#d4a01766'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(f2.x, f2.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // 導線量房預覽
    if (this.walk) {
      const w = this.walk;
      const s = this.toScreen(w.pos);
      const dir = { x: Math.cos(w.heading), y: Math.sin(w.heading) };
      const tip = this.toScreen(G.add(w.pos, G.mul(dir, this.mm(70))));
      ctx.strokeStyle = C.ghost; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      this._arrow(ctx, tip, s);
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, 7);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = C.ghost; ctx.lineWidth = 2.5; ctx.stroke();
      const tl = w.turn < 0 ? '下一角：右轉' : '下一角：左轉';
      this._label(ctx, { x: s.x, y: s.y - 22 }, `${tl} ${Math.abs(Math.round(G.deg(w.turn)))}°`, C.ghost, 11);
    }
    // 搬移空間時的吸附提示
    if (this.drag?.mode === 'room') {
      const s = this.drag.snap;
      const moving = this.drag.set.walls;
      ctx.save();
      ctx.strokeStyle = C.sel; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]);
      for (const w of moving) { this._polyPath(ctx, this._wallQuad(w)); ctx.stroke(); }
      ctx.setLineDash([]);
      if (s) {
        const a = this.toScreen(s.from.center), b = this.toScreen(s.to.center);
        ctx.strokeStyle = '#2ec27e'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, 14, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const label = { door: '門對門', doorwall: '門貼牆面', vertex: '端點對齊' }[s.kind] || '對齊';
        this._label(ctx, { x: b.x, y: b.y - 26 }, label, '#1a8f5b', 12);
      }
      ctx.restore();
    }
    // 自動正交追蹤的對齊輔助線
    if (this.guides.length && this.tool !== 'select') {
      ctx.save();
      ctx.strokeStyle = C.snap;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      for (const g of this.guides) {
        const a = this.toScreen(g.a), b = this.toScreen(g.b);
        // 兩端各延長一點，看起來才像 CAD 的追蹤線
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.hypot(dx, dy) || 1;
        const ex = (dx / L) * 26, ey = (dy / L) * 26;
        ctx.beginPath();
        ctx.moveTo(a.x - ex, a.y - ey);
        ctx.lineTo(b.x + ex, b.y + ey);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(a.x, a.y, 3, 0, 7);
        ctx.fillStyle = C.snap; ctx.fill();
      }
      ctx.restore();
    }
    // 吸附標記
    if (this.snapPt && this.tool !== 'select') {
      const s = this.toScreen(this.snapPt.pt);
      ctx.strokeStyle = C.snap; ctx.lineWidth = 2;
      ctx.beginPath();
      if (this.snapPt.type === 'vertex') ctx.rect(s.x - 5, s.y - 5, 10, 10);
      else { ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x, s.y - 6); ctx.lineTo(s.x + 6, s.y); ctx.lineTo(s.x, s.y + 6); ctx.closePath(); }
      ctx.stroke();
    }
    // 比例尺與指北針
    this._scaleBar(ctx);
    this._compass(ctx);
  }

  _scaleBar(ctx) {
    const targets = [100, 200, 500, 1000, 2000, 5000, 10000];
    let mmv = targets.find((t) => this.px(t) > 60) || 10000;
    const w = this.px(mmv);
    const x = 14, y = this.H - 18;
    ctx.strokeStyle = '#8595a8'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5);
    ctx.stroke();
    ctx.font = '10px ui-monospace,system-ui'; ctx.fillStyle = '#6b7a8d';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(mmv >= 1000 ? `${mmv / 1000} m` : `${mmv / 10} cm`, x + w + 6, y + 3);
  }

  /** 輸出目前視圖為 PNG blob */
  toPNG(scale = 2) {
    return new Promise((res) => this.cv.toBlob(res, 'image/png', 1));
  }
}
