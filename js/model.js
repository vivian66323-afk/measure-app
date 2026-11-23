// model.js — 資料模型與編輯狀態（單位 mm）
import { uid } from './util.js';
import * as G from './geometry.js';

export const DEFAULTS = {
  wallThick: 120,      // 牆厚（內外牆共用同一個預設值）
  wallHeight: 2800,    // 樓高（淨高）
  doorWidth: 900, doorHeight: 2100,
  windowWidth: 1500, windowHeight: 1500, windowSill: 900,
  openingWidth: 1200, openingHeight: 2100,
  // 新牆的牆線位置。量房量到的是室內淨尺寸，牆體要長在線的外側，
  // 所以預設 -0.5（逆時針畫房間時＝牆在線的下方／外側），量多少就是多少。
  wallOff: -0.5,
  beamWidth: 300,      // 樑寬（平面上）
  beamLen: 3000,       // 新樑的預設長度
  beamClearH: 2400,    // 樑底的室內淨高（地板到樑底），樑深由樓高反推
  beamOff: 0,          // 樑線位置：0 置中 / -0.5 靠下 / +0.5 靠上
};

export const newFloor = (name = '1F') => ({
  id: uid('fl'), name,
  height: DEFAULTS.wallHeight,
  north: 0,          // 圖面正北相對 +Y 軸的旋轉量（弧度，逆時針為正）
  mainDoorId: null,  // 指定為大門的 opening id（風水評測用）
  walls: [], openings: [], columns: [], beams: [], dims: [], texts: [], items: [], photos: [],
  // 房間標記：一個放在房間內的標籤點。房間是由牆體自動偵測出來的封閉區域，
  // 用「點落在哪個區域內」來對應名稱，牆體被修改後名稱也不會跑掉。
  roomLabels: [],
});

export const newProject = (name = '未命名專案') => ({
  id: uid('pj'), name,
  client: { name: '', phone: '', addr: '', note: '' },
  createdAt: Date.now(), updatedAt: Date.now(),
  unit: 'cm',
  floors: [newFloor('1F')],
  version: 1,
});

/**
 * off = 參考線（a→b）在牆體上的位置，單位為牆厚的倍數：
 *   0 = 置中、-0.5 = 線在左側面（牆長在右邊）、+0.5 = 線在右側面（牆長在左邊）。
 * 量室內淨尺寸時設 -0.5（逆時針畫），量到多少畫多少，淨面積才會正確。
 */
export const newWall = (a, b, thickness = DEFAULTS.wallThick, type = 'interior', off = DEFAULTS.wallOff) => ({
  id: uid('w'), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, thickness, type, off,
});

export const newOpening = (wallId, kind, offset, width) => ({
  id: uid('op'), wallId, kind, offset, width,
  height: kind === 'window' ? DEFAULTS.windowHeight : kind === 'door' ? DEFAULTS.doorHeight : DEFAULTS.openingHeight,
  sill: kind === 'window' ? DEFAULTS.windowSill : 0,
  flip: false, swing: 1, label: '',
});

export const newColumn = (x, y, w = 400, h = 400) => ({ id: uid('c'), x, y, w, h, rot: 0, kind: 'column', label: '' });

/**
 * 樑：像牆一樣以線段描述，但掛在天花下方。
 *
 * clearH = 樑底下的**室內淨高**（不含樓板），也就是現場拿測距儀從地板量到樑底的數值。
 *          這才是量房時真正會量到的東西，樑深由「樓高 − clearH」反推。
 * off    = 樑線在樑體的哪一側：0 置中、-0.5 靠下（樑體長在線的右手邊）、+0.5 靠上。
 */
export const newBeam = (a, b, width = DEFAULTS.beamWidth, clearH = DEFAULTS.beamClearH, off = DEFAULTS.beamOff) => ({
  id: uid('bm'), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y },
  width, clearH, off, label: '',
});

/** 樑深（從天花往下垂多少）＝ 樓高 − 室內淨高 */
export const beamDepth = (bm, floorHeight) => Math.max(1, (floorHeight || DEFAULTS.wallHeight) - (bm.clearH ?? DEFAULTS.beamClearH));

/**
 * 現場照片標記。photoId 指向 IndexedDB 的 photos store。
 * marks 內的座標是相對照片的 0~1 比例，照片縮放後標註仍對得上。
 */
export const newPhoto = (photoId, x, y) => ({
  id: uid('ph'), photoId, x, y, dir: 0, name: '', note: '', marks: [],
});

/** 家具／構件實例。type 對應 catalog.js 的 SYMBOLS key */
export const newItem = (type, x, y, def) => ({
  id: uid('it'), type, x, y, rot: 0,
  w: def?.w ?? 600, h: def?.h ?? 600, h3d: def?.h3d ?? 700,
  // 樓梯專屬：階數與梯段淨寬。非樓梯構件為 undefined，不會出現在面板上。
  ...(def?.steps != null ? { steps: def.steps, runW: def.runW } : {}),
  // 電器／水路這類貼牆或吊在天花的構件才有離地高度，家具一律落地
  ...(def?.z != null ? { z: def.z } : {}),
  label: '', showLabel: true,
});
export const newDim = (a, b, off = 400) => ({ id: uid('d'), a: { ...a }, b: { ...b }, off });
export const newText = (x, y, text = '文字') => ({ id: uid('t'), x, y, text, size: 200 });

/* ── 專案 ↔ 純資料 ───────────────────── */
export function migrate(p) {
  if (!p || typeof p !== 'object') return newProject();
  p.floors ||= [newFloor()];
  p.client ||= { name: '', phone: '', addr: '', note: '' };
  p.unit ||= 'cm';
  for (const f of p.floors) {
    f.walls ||= []; f.openings ||= []; f.columns ||= []; f.dims ||= []; f.texts ||= [];
    f.roomLabels ||= []; f.items ||= []; f.photos ||= []; f.beams ||= [];
    for (const b of f.beams) {
      b.width ||= DEFAULTS.beamWidth;
      b.off ??= 0;
      // 舊檔存的是 depth（從天花往下），換算成室內淨高
      if (b.clearH == null) b.clearH = Math.max(1, (f.height || DEFAULTS.wallHeight) - (b.depth ?? 400));
      delete b.depth;
    }
    f.height ||= DEFAULTS.wallHeight;
    f.north ??= 0;
    f.mainDoorId ??= null;
    for (const w of f.walls) { w.thickness ||= DEFAULTS.wallThick; w.type ||= 'interior'; w.off ??= 0; }
  }
  return p;
}

/* ── 編輯狀態（含 undo/redo） ─────────── */
export class Doc extends EventTarget {
  constructor(project) {
    super();
    this.p = migrate(project || newProject());
    this.floorIdx = 0;
    this._undo = []; this._redo = [];
    this._pending = null;
    this.dirty = false;
  }
  get floor() { return this.p.floors[this.floorIdx] || this.p.floors[0]; }
  get walls() { return this.floor.walls; }
  get openings() { return this.floor.openings; }
  get columns() { return this.floor.columns; }

  emit(type = 'change') { this.dispatchEvent(new CustomEvent(type)); }

  /** 開始一次可復原的變更 */
  begin() { if (!this._pending) this._pending = this.snapshot(); }
  /** 結束並提交（若無 begin 會自動補） */
  commit(label = '') {
    const before = this._pending ?? this.snapshot();
    this._pending = null;
    const after = this.snapshot();
    if (before === after) return;
    this._undo.push({ label, state: before });
    if (this._undo.length > 120) this._undo.shift();
    this._redo.length = 0;
    this.dirty = true;
    this.emit('change');
  }
  /** begin+動作+commit 的簡寫 */
  edit(label, fn) { this.begin(); const r = fn(); this.commit(label); return r; }
  /** 放棄尚未提交的變更（例如拖曳到一半被第二根手指打斷） */
  abort() {
    if (!this._pending) return;
    const s = this._pending; this._pending = null;
    this.restore(s);
    this.emit('change');
  }

  snapshot() { return JSON.stringify({ p: this.p, f: this.floorIdx }); }
  restore(json) {
    const s = JSON.parse(json);
    this.p = migrate(s.p);
    this.floorIdx = Math.min(s.f ?? 0, this.p.floors.length - 1);
  }
  undo() {
    if (!this._undo.length) return false;
    const cur = this.snapshot();
    const e = this._undo.pop();
    this._redo.push({ label: e.label, state: cur });
    this.restore(e.state);
    this.dirty = true;
    this.emit('change');
    return true;
  }
  redo() {
    if (!this._redo.length) return false;
    const cur = this.snapshot();
    const e = this._redo.pop();
    this._undo.push({ label: e.label, state: cur });
    this.restore(e.state);
    this.dirty = true;
    this.emit('change');
    return true;
  }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  /* ── 查詢輔助 ── */
  wallById(id) { return this.walls.find((w) => w.id === id); }
  openingsOf(wallId) { return this.openings.filter((o) => o.wallId === wallId); }

  /** 刪除牆時，一併移除其上的門窗 */
  removeWall(id) {
    const i = this.walls.findIndex((w) => w.id === id);
    if (i < 0) return;
    this.walls.splice(i, 1);
    this.floor.openings = this.openings.filter((o) => o.wallId !== id);
  }
  removeEntity(sel) {
    if (!sel) return;
    if (sel.kind === 'wall') this.removeWall(sel.id);
    else if (sel.kind === 'opening') this.floor.openings = this.openings.filter((o) => o.id !== sel.id);
    else if (sel.kind === 'column') this.floor.columns = this.columns.filter((c) => c.id !== sel.id);
    else if (sel.kind === 'dim') this.floor.dims = this.floor.dims.filter((d) => d.id !== sel.id);
    else if (sel.kind === 'text') this.floor.texts = this.floor.texts.filter((t) => t.id !== sel.id);
    else if (sel.kind === 'item') this.floor.items = this.floor.items.filter((i) => i.id !== sel.id);
    else if (sel.kind === 'photo') this.floor.photos = this.floor.photos.filter((p) => p.id !== sel.id);
    else if (sel.kind === 'beam') this.floor.beams = this.floor.beams.filter((b) => b.id !== sel.id);
  }
  get items() { return this.floor.items; }
  get photos() { return this.floor.photos; }
  get beams() { return this.floor.beams; }

  /** 所有頂點（用於吸附） */
  vertices() {
    const out = [];
    for (const w of this.walls) { out.push({ ...w.a, wid: w.id, end: 'a' }, { ...w.b, wid: w.id, end: 'b' }); }
    return out;
  }

  /** 圖面外框（mm） */
  extent() {
    const pts = [];
    for (const w of this.walls) pts.push(w.a, w.b);
    for (const c of this.columns) pts.push({ x: c.x - c.w / 2, y: c.y - c.h / 2 }, { x: c.x + c.w / 2, y: c.y + c.h / 2 });
    for (const t of this.floor.texts) pts.push({ x: t.x, y: t.y });
    for (const i of this.items) {
      const r = Math.max(i.w, i.h) / 2;
      pts.push({ x: i.x - r, y: i.y - r }, { x: i.x + r, y: i.y + r });
    }
    for (const b of this.beams) pts.push(b.a, b.b);
    return G.bbox(pts);
  }

  /** 全案統計 */
  stats(roomsOfFloor) {
    let wallLen = 0;
    for (const w of this.walls) wallLen += G.dist(w.a, w.b);
    const rooms = roomsOfFloor || [];
    const area = rooms.reduce((s, r) => s + r.area, 0);
    return { wallCount: this.walls.length, wallLen, roomCount: rooms.length, area };
  }
}
