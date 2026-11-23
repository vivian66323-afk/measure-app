// catalog.js — 家具／建築構件圖庫
//
// 每個符號以「圖元清單」描述，而不是直接畫在 canvas 上。
// 這樣同一份定義可以同時輸出到 畫布 / DXF / SVG / 3D，四邊永遠一致。
//
// 圖元格式（座標以構件中心為原點、mm、Y 向上）：
//   ['r', cx, cy, w, h, mode]            矩形（中心點 + 寬高）
//   ['c', cx, cy, r, mode]               圓
//   ['e', cx, cy, rx, ry, mode]          橢圓
//   ['l', x1, y1, x2, y2]                線段
//   ['a', cx, cy, r, a0deg, a1deg]       圓弧（逆時針，角度）
//   ['p', [x1,y1, x2,y2, …], close, mode] 折線／多邊形
// mode：'f' 只填色、's' 只描邊、'fs' 兩者（預設 'fs'）

const F = 'f', S = 's', FS = 'fs';

/** 常用組合：外框 + 內部分隔 */
const box = (w, h, m = FS) => ['r', 0, 0, w, h, m];

export const CATS = ['客廳', '臥室', '廚房', '衛浴', '收納', '樓梯', '電器', '水路', '建築'];

export const SYMBOLS = {
  /* ── 客廳 ───────────────────────── */
  sofa3: {
    name: '三人沙發', cat: '客廳', w: 2100, h: 900, h3d: 800,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['r', 0, h / 2 - h * 0.18, w, h * 0.36, S],           // 椅背
      ['l', -w / 6, -h / 2, -w / 6, h / 2 - h * 0.36],
      ['l', w / 6, -h / 2, w / 6, h / 2 - h * 0.36],
      ['r', -w / 2 + w * 0.05, 0, w * 0.1, h, S],           // 扶手
      ['r', w / 2 - w * 0.05, 0, w * 0.1, h, S],
    ],
  },
  sofa2: {
    name: '雙人沙發', cat: '客廳', w: 1500, h: 900, h3d: 800,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['r', 0, h / 2 - h * 0.18, w, h * 0.36, S],
      ['l', 0, -h / 2, 0, h / 2 - h * 0.36],
      ['r', -w / 2 + w * 0.07, 0, w * 0.14, h, S],
      ['r', w / 2 - w * 0.07, 0, w * 0.14, h, S],
    ],
  },
  sofaL: {
    name: 'L型沙發', cat: '客廳', w: 2600, h: 1900, h3d: 800,
    parts: (w, h) => [
      ['p', [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, w / 2 - 900, h / 2, w / 2 - 900, -h / 2 + 900, -w / 2, -h / 2 + 900], true, FS],
      ['l', -w / 2, -h / 2 + 250, w / 2 - 900, -h / 2 + 250],
      ['l', w / 2 - 250, -h / 2 + 900, w / 2 - 250, h / 2],
    ],
  },
  armchair: {
    name: '單人椅', cat: '客廳', w: 800, h: 800, h3d: 800,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['r', 0, h / 2 - h * 0.15, w, h * 0.3, S]],
  },
  teaTable: {
    name: '茶几', cat: '客廳', w: 1200, h: 600, h3d: 420,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['r', 0, 0, w - 120, h - 120, S]],
  },
  tvCabinet: {
    name: '電視櫃', cat: '客廳', w: 1800, h: 450, h3d: 500,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['l', -w / 6, -h / 2, -w / 6, h / 2], ['l', w / 6, -h / 2, w / 6, h / 2],
    ],
  },
  tv: {
    name: '電視', cat: '客廳', w: 1200, h: 120, h3d: 700,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, 0, w / 2, 0]],
  },
  diningT: {
    name: '餐桌(6人)', cat: '客廳', w: 1600, h: 900, h3d: 750,
    parts: (w, h) => {
      const p = [box(w, h, FS)];
      for (const sx of [-1, 1]) for (const i of [-1, 0, 1]) p.push(['r', i * w * 0.3, sx * (h / 2 + 240), 450, 450, S]);
      return p;
    },
  },
  diningR: {
    name: '圓餐桌', cat: '客廳', w: 1200, h: 1200, h3d: 750,
    parts: (w) => {
      const p = [['c', 0, 0, w / 2, FS]];
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        p.push(['r', Math.cos(a) * (w / 2 + 240), Math.sin(a) * (w / 2 + 240), 420, 420, S]);
      }
      return p;
    },
  },

  /* ── 臥室 ───────────────────────── */
  bedD: {
    name: '雙人床(標準)', cat: '臥室', w: 1520, h: 1880, h3d: 500,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['r', 0, h / 2 - 60, w, 120, S],                    // 床頭板
      ['r', -w / 4, h / 2 - 400, w * 0.42, 480, S],       // 枕頭
      ['r', w / 4, h / 2 - 400, w * 0.42, 480, S],
      ['l', -w / 2, -h / 2 + 500, w / 2, -h / 2 + 500],   // 被緣
    ],
  },
  bedK: {
    name: '雙人床(加大)', cat: '臥室', w: 1820, h: 1880, h3d: 500,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['r', 0, h / 2 - 60, w, 120, S],
      ['r', -w / 4, h / 2 - 420, w * 0.44, 500, S],
      ['r', w / 4, h / 2 - 420, w * 0.44, 500, S],
      ['l', -w / 2, -h / 2 + 520, w / 2, -h / 2 + 520],
    ],
  },
  bedS: {
    name: '單人床', cat: '臥室', w: 1050, h: 1880, h3d: 500,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['r', 0, h / 2 - 60, w, 120, S],
      ['r', 0, h / 2 - 400, w * 0.75, 460, S],
      ['l', -w / 2, -h / 2 + 480, w / 2, -h / 2 + 480],
    ],
  },
  nightstand: {
    name: '床頭櫃', cat: '臥室', w: 450, h: 400, h3d: 550,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, 0, w / 2, 0]],
  },
  wardrobe: {
    name: '衣櫃', cat: '臥室', w: 1800, h: 600, h3d: 2400,
    parts: (w, h) => {
      const p = [box(w, h, FS)];
      const n = Math.max(2, Math.round(w / 600));
      for (let i = 1; i < n; i++) p.push(['l', -w / 2 + (w / n) * i, -h / 2, -w / 2 + (w / n) * i, h / 2]);
      p.push(['l', -w / 2, -h / 2 + 60, w / 2, -h / 2 + 60]);
      return p;
    },
  },
  desk: {
    name: '書桌', cat: '臥室', w: 1200, h: 600, h3d: 750,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['r', w / 2 - 250, 0, 460, h - 80, S], ['r', 0, -h / 2 - 250, 450, 450, S]],
  },
  dresser: {
    name: '梳妝台', cat: '臥室', w: 1000, h: 450, h3d: 750,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['e', 0, h / 2 - 40, w * 0.3, 60, S], ['r', 0, -h / 2 - 220, 400, 400, S]],
  },

  /* ── 廚房 ───────────────────────── */
  counter: {
    name: '流理台', cat: '廚房', w: 2400, h: 600, h3d: 850,
    parts: (w, h) => {
      const p = [box(w, h, FS)];
      const n = Math.max(2, Math.round(w / 600));
      for (let i = 1; i < n; i++) p.push(['l', -w / 2 + (w / n) * i, -h / 2, -w / 2 + (w / n) * i, h / 2]);
      return p;
    },
  },
  sink: {
    name: '水槽', cat: '廚房', w: 800, h: 500, h3d: 850,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['r', 0, -40, w - 120, h - 160, S],
      ['c', 0, 0, 45, S], ['c', 0, h / 2 - 70, 55, S],
    ],
  },
  stove: {
    name: '瓦斯爐', cat: '廚房', w: 750, h: 500, h3d: 850,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['c', -w / 4, 0, Math.min(w, h) * 0.19, S], ['c', w / 4, 0, Math.min(w, h) * 0.19, S],
      ['c', -w / 4, 0, Math.min(w, h) * 0.09, S], ['c', w / 4, 0, Math.min(w, h) * 0.09, S],
    ],
  },
  fridge: {
    name: '冰箱', cat: '廚房', w: 700, h: 700, h3d: 1800,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['l', -w / 2, h / 6, w / 2, h / 6],
      ['l', w / 2 - 90, -h / 2 + 80, w / 2 - 90, h / 6 - 80],
    ],
  },
  island: {
    name: '中島', cat: '廚房', w: 1800, h: 900, h3d: 900,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['r', 0, 0, w - 160, h - 160, S]],
  },
  hood: {
    name: '抽油煙機', cat: '廚房', w: 900, h: 500, h3d: 600,
    parts: (w, h) => [['r', 0, 0, w, h, S], ['l', -w / 2, -h / 2, w / 2, h / 2], ['l', -w / 2, h / 2, w / 2, -h / 2]],
  },

  /* ── 衛浴 ───────────────────────── */
  toilet: {
    name: '馬桶', cat: '衛浴', w: 400, h: 700, h3d: 750,
    parts: (w, h) => [
      ['r', 0, h / 2 - 100, w, 200, FS],                       // 水箱
      ['e', 0, -h / 2 + 230, w / 2 - 15, 230, FS],             // 座體
      ['e', 0, -h / 2 + 230, w / 2 - 75, 175, S],
    ],
  },
  basin: {
    name: '洗手台', cat: '衛浴', w: 600, h: 450, h3d: 850,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['e', 0, -30, w * 0.36, h * 0.34, S],
      ['c', 0, h / 2 - 70, 40, S],
    ],
  },
  bathtub: {
    name: '浴缸', cat: '衛浴', w: 1600, h: 800, h3d: 550,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS], ['r', -30, 0, w - 200, h - 160, S],
      ['c', w / 2 - 130, 0, 45, S],
    ],
  },
  shower: {
    name: '淋浴間', cat: '衛浴', w: 900, h: 900, h3d: 2000,
    parts: (w, h) => [
      ['r', 0, 0, w, h, FS],
      ['l', -w / 2, -h / 2, w / 2, h / 2],
      ['c', w / 2 - 140, h / 2 - 140, 60, S],
    ],
  },
  washer: {
    name: '洗衣機', cat: '衛浴', w: 600, h: 600, h3d: 900,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['c', 0, 0, Math.min(w, h) * 0.3, S], ['c', 0, 0, Math.min(w, h) * 0.18, S]],
  },

  /* ── 收納 ───────────────────────── */
  shoeCab: {
    name: '鞋櫃', cat: '收納', w: 900, h: 350, h3d: 1200,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', 0, -h / 2, 0, h / 2]],
  },
  bookshelf: {
    name: '書櫃', cat: '收納', w: 1200, h: 350, h3d: 2000,
    parts: (w, h) => {
      const p = [box(w, h, FS)];
      for (let i = 1; i < 4; i++) p.push(['l', -w / 2 + (w / 4) * i, -h / 2, -w / 2 + (w / 4) * i, h / 2]);
      return p;
    },
  },
  cabinet: {
    name: '收納櫃', cat: '收納', w: 900, h: 450, h3d: 900,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', 0, -h / 2, 0, h / 2], ['l', -w / 2, -h / 2 + 50, w / 2, -h / 2 + 50]],
  },

  /* ── 樓梯 ───────────────────────── */
  // 樓梯的階數不是固定的，會依實際長度與使用者設定改變，
  // 所以 parts 接第三個參數 opt（來自構件實例的 steps / runW 等欄位）。
  stairStraight: {
    name: '一字樓梯', cat: '樓梯', w: 1100, h: 3000, h3d: 0,
    steps: 12,
    parts: (w, h, opt = {}) => {
      const n = Math.max(2, Math.round(opt.steps || 12));
      const p = [box(w, h, FS)];
      for (let i = 1; i < n; i++) {
        const y = -h / 2 + (h / n) * i;
        p.push(['l', -w / 2, y, w / 2, y]);
      }
      // 上行方向線 + 箭頭（往 +y 為上樓）
      p.push(['l', 0, -h / 2 + h / n / 2, 0, h / 2 - 160]);
      p.push(['p', [-140, h / 2 - 400, 0, h / 2 - 160, 140, h / 2 - 400], false, S]);
      return p;
    },
  },
  stairL: {
    name: 'L型樓梯', cat: '樓梯', w: 2400, h: 2400, h3d: 0,
    steps: 14, runW: 1000,
    parts: (w, h, opt = {}) => {
      const rw = Math.min(opt.runW || 1000, Math.min(w, h) - 200);   // 梯段淨寬
      const n = Math.max(4, Math.round(opt.steps || 14));
      // L 形外框：右下角挖掉
      const p = [['p', [
        -w / 2, -h / 2, -w / 2 + rw, -h / 2, -w / 2 + rw, h / 2 - rw,
        w / 2, h / 2 - rw, w / 2, h / 2, -w / 2, h / 2,
      ], true, FS]];
      // 平台（轉角）為正方形 rw×rw，兩段梯各分一半階數
      const upLen = h - rw;                    // 直行段長度
      const runLen = w - rw;                   // 橫行段長度
      const n1 = Math.max(1, Math.round(n * upLen / (upLen + runLen)));
      const n2 = Math.max(1, n - n1);
      for (let i = 1; i < n1; i++) {
        const y = -h / 2 + (upLen / n1) * i;
        p.push(['l', -w / 2, y, -w / 2 + rw, y]);
      }
      for (let i = 1; i < n2; i++) {
        const x = -w / 2 + rw + (runLen / n2) * i;
        p.push(['l', x, h / 2 - rw, x, h / 2]);
      }
      p.push(['l', -w / 2, h / 2 - rw, -w / 2 + rw, h / 2 - rw]);   // 平台起線
      p.push(['p', [w / 2 - 340, h / 2 - rw + 140, w / 2 - 120, h / 2 - rw / 2, w / 2 - 340, h / 2 - 140], false, S]);
      return p;
    },
  },
  stairU: {
    name: 'U型樓梯', cat: '樓梯', w: 2400, h: 3200, h3d: 0,
    steps: 16, runW: 1000,
    parts: (w, h, opt = {}) => {
      const rw = Math.min(opt.runW || 1000, w / 2 - 60);            // 單側梯段淨寬
      const n = Math.max(4, Math.round(opt.steps || 16));
      const gap = w - rw * 2;                                        // 中間梯井
      const land = rw;                                               // 平台深度
      const runLen = h - land;                                       // 每段梯的長度
      const half = Math.max(1, Math.round(n / 2));

      const p = [box(w, h, FS)];
      if (gap > 40) p.push(['r', 0, -h / 2 + runLen / 2, gap, runLen, S]);   // 梯井
      // 左段：由下往上
      for (let i = 1; i < half; i++) {
        const y = -h / 2 + (runLen / half) * i;
        p.push(['l', -w / 2, y, -w / 2 + rw, y]);
      }
      // 右段：由上往下
      for (let i = 1; i < n - half; i++) {
        const y = -h / 2 + (runLen / (n - half)) * i;
        p.push(['l', w / 2 - rw, y, w / 2, y]);
      }
      p.push(['l', -w / 2, h / 2 - land, w / 2, h / 2 - land]);      // 平台起線
      p.push(['l', -w / 2 + rw / 2, -h / 2 + 200, -w / 2 + rw / 2, h / 2 - land - 160]);
      p.push(['p', [-w / 2 + rw / 2 - 130, h / 2 - land - 400, -w / 2 + rw / 2, h / 2 - land - 160,
        -w / 2 + rw / 2 + 130, h / 2 - land - 400], false, S]);
      return p;
    },
  },

  /* ── 電器設備 ─────────────────────
     平面上的尺寸是「符號大小」不是實物大小 —— 一個 86mm 的面板照實畫，在 1:50 的圖上只剩一個點。
     tag  ＝畫在符號中央的縮寫字，一眼分得出是插座還是開關
     z    ＝離地高度（mm），放進圖面後可在面板改
     d3d  ＝3D 時實際凸出牆面的厚度（貼牆的面板類才有） */
  outlet: {
    name: '插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 300, d3d: 12, tag: '插',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  outletHigh: {
    name: '高位插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 1100, d3d: 12, tag: '高',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  outlet220: {
    name: '220V 專用插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 2100, d3d: 12, tag: '220',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['c', 0, 0, w / 2 - 34, S], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  outletFloor: {
    name: '地板插座', cat: '電器', w: 240, h: 240, h3d: 8, z: 0, tag: '地',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['c', 0, 0, w / 2 - 30, S]],
  },
  switch1: {
    name: '開關', cat: '電器', w: 220, h: 220, h3d: 120, z: 1200, d3d: 12, tag: 'S',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  netOutlet: {
    name: '網路插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 300, d3d: 12, tag: '網',
    parts: (w, h) => [['p', [-w / 2, h / 2, w / 2, h / 2, 0, -h / 2], true, FS]],
  },
  tvOutlet: {
    name: '電視插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 300, d3d: 12, tag: 'TV',
    parts: (w, h) => [['p', [-w / 2, h / 2, w / 2, h / 2, 0, -h / 2], true, FS]],
  },
  telOutlet: {
    name: '電話插座', cat: '電器', w: 220, h: 220, h3d: 90, z: 300, d3d: 12, tag: 'T',
    parts: (w, h) => [['p', [-w / 2, h / 2, w / 2, h / 2, 0, -h / 2], true, FS]],
  },
  panelBox: {
    name: '配電箱', cat: '電器', w: 500, h: 180, h3d: 600, z: 1400, d3d: 100, tag: '電',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, -h / 2, w / 2, h / 2]],
  },
  weakBox: {
    name: '弱電箱', cat: '電器', w: 400, h: 180, h3d: 300, z: 300, d3d: 100, tag: '弱',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, h / 2, w / 2, -h / 2]],
  },
  intercom: {
    name: '對講機', cat: '電器', w: 240, h: 200, h3d: 220, z: 1300, d3d: 30, tag: '對',
    parts: (w, h) => [['r', 0, 0, w, h, FS]],
  },
  smoke: {
    name: '偵煙器', cat: '電器', w: 260, h: 260, h3d: 50, z: 2700, tag: '煙',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['c', 0, 0, w / 4, S]],
  },
  camera: {
    name: '攝影機', cat: '電器', w: 260, h: 260, h3d: 120, z: 2400, tag: '攝',
    parts: (w, h) => [['c', 0, 0, w / 2, FS]],
  },
  lightPoint: {
    name: '燈具出線口', cat: '電器', w: 260, h: 260, h3d: 40, z: 2740,
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['l', -w / 2, 0, w / 2, 0], ['l', 0, -h / 2, 0, h / 2]],
  },
  gasMeter: {
    name: '瓦斯表', cat: '電器', w: 320, h: 200, h3d: 300, z: 1200, d3d: 150, tag: '瓦',
    parts: (w, h) => [['r', 0, 0, w, h, FS]],
  },

  /* ── 水路 ───────────────────────── */
  waterCold: {
    name: '冷水出水口', cat: '水路', w: 200, h: 200, h3d: 60, z: 600, d3d: 30, tag: '冷',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  waterHot: {
    name: '熱水出水口', cat: '水路', w: 200, h: 200, h3d: 60, z: 600, d3d: 30, tag: '熱',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['c', 0, 0, w / 2 - 34, S], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  drainFloor: {
    name: '地板排水', cat: '水路', w: 220, h: 220, h3d: 6, z: 0, tag: '排',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['c', 0, 0, w / 2 - 24, S]],
  },
  drainWall: {
    name: '壁排水口', cat: '水路', w: 200, h: 200, h3d: 60, z: 450, d3d: 30, tag: '排',
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, h / 2, w / 2, h / 2]],
  },
  soilPipe: {
    name: '糞管', cat: '水路', w: 260, h: 260, h3d: 6, z: 0, tag: '糞',
    parts: (w, h) => [['c', 0, 0, w / 2, FS], ['c', 0, 0, w / 2 - 40, S]],
  },
  waterMeter: {
    name: '水表', cat: '水路', w: 300, h: 200, h3d: 200, z: 300, d3d: 150, tag: '水',
    parts: (w, h) => [['r', 0, 0, w, h, FS]],
  },
  valve: {
    name: '止水閥', cat: '水路', w: 220, h: 220, h3d: 60, z: 300, d3d: 60,
    parts: (w, h) => [['p', [-w / 2, h / 2, -w / 2, -h / 2, w / 2, h / 2, w / 2, -h / 2], true, FS]],
  },
  waterHeater: {
    name: '熱水器', cat: '水路', w: 450, h: 250, h3d: 650, z: 1300, d3d: 250, tag: '熱水器',
    parts: (w, h) => [['r', 0, 0, w, h, FS]],
  },
  washerTap: {
    name: '洗衣機給排水', cat: '水路', w: 300, h: 200, h3d: 150, z: 1100, d3d: 40, tag: '洗',
    parts: (w, h) => [['r', 0, 0, w, h, FS]],
  },

  /* ── 建築 ───────────────────────── */
  ac: {
    name: '冷氣(壁掛)', cat: '建築', w: 900, h: 250, h3d: 300,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2 + 60, -h / 2 + 60, w / 2 - 60, -h / 2 + 60]],
  },
  acOut: {
    name: '冷氣室外機', cat: '建築', w: 900, h: 350, h3d: 700,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['c', 0, 0, Math.min(w, h) * 0.32, S]],
  },
  pipe: {
    name: '管道間', cat: '建築', w: 600, h: 600, h3d: 2800,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', -w / 2, -h / 2, w / 2, h / 2], ['l', -w / 2, h / 2, w / 2, -h / 2]],
  },
  meter: {
    name: '配電箱', cat: '建築', w: 400, h: 150, h3d: 400,
    parts: (w, h) => [['r', 0, 0, w, h, FS], ['l', 0, -h / 2, 0, h / 2]],
  },
};

/** 產生圖庫縮圖 SVG（給選單用）。Y 軸翻轉以符合模型座標。 */
export function previewSVG(key, px = 56) {
  const def = SYMBOLS[key];
  if (!def) return '';
  const { w, h } = def;
  const pad = Math.max(w, h) * 0.12;
  const W = w + pad * 2, H = h + pad * 2;
  const o = [];
  for (const pr of def.parts(w, h, { steps: def.steps, runW: def.runW })) {
    const [k] = pr;
    const mode = (k === 'r' ? pr[5] : k === 'c' ? pr[4] : k === 'e' ? pr[5] : k === 'p' ? pr[3] : 's') || 'fs';
    const st = `fill="${mode.includes('f') ? '#e8eef6' : 'none'}" stroke="${mode.includes('s') || mode.includes('f') ? '#64748b' : 'none'}" stroke-width="${Math.max(w, h) / 45}"`;
    if (k === 'r') o.push(`<rect x="${pr[1] - pr[3] / 2}" y="${pr[2] - pr[4] / 2}" width="${pr[3]}" height="${pr[4]}" ${st}/>`);
    else if (k === 'c') o.push(`<circle cx="${pr[1]}" cy="${pr[2]}" r="${pr[3]}" ${st}/>`);
    else if (k === 'e') o.push(`<ellipse cx="${pr[1]}" cy="${pr[2]}" rx="${pr[3]}" ry="${pr[4]}" ${st}/>`);
    else if (k === 'l') o.push(`<line x1="${pr[1]}" y1="${pr[2]}" x2="${pr[3]}" y2="${pr[4]}" stroke="#64748b" stroke-width="${Math.max(w, h) / 45}"/>`);
    else if (k === 'p') {
      const pts = [];
      for (let i = 0; i < pr[1].length; i += 2) pts.push(`${pr[1][i]},${pr[1][i + 1]}`);
      o.push(`<poly${pr[2] ? 'gon' : 'line'} points="${pts.join(' ')}" ${st}/>`);
    }
  }
  return `<svg viewBox="${-W / 2} ${-H / 2} ${W} ${H}" width="${px}" height="${px}" preserveAspectRatio="xMidYMid meet">`
    + `<g transform="scale(1,-1)">${o.join('')}</g></svg>`;
}

export const listByCat = (cat) =>
  Object.entries(SYMBOLS).filter(([, v]) => v.cat === cat).map(([k, v]) => ({ key: k, ...v }));

/**
 * 取得構件的圖元清單（已依實際 w/h 產生）。
 * 樓梯這類構件的樣子還會受階數、梯段寬影響，一併傳給 parts()。
 */
export function partsOf(item) {
  const def = SYMBOLS[item.type];
  if (!def) return [['r', 0, 0, item.w, item.h, FS]];
  return def.parts(item.w, item.h, { steps: item.steps ?? def.steps, runW: item.runW ?? def.runW });
}

/** 這個構件有沒有「階數／梯段寬」這類額外參數 */
export const hasStairParams = (type) => SYMBOLS[type]?.steps != null;

/** 構件四角（模型座標），用於外框計算與命中測試 */
export function cornersOf(it) {
  const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0);
  const hw = it.w / 2, hh = it.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    .map(([x, y]) => ({ x: it.x + x * c - y * s, y: it.y + x * s + y * c }));
}

/** 把構件的圖元展平成世界座標的線段／圓弧，供 DXF / SVG / 3D 使用 */
export function flatten(it) {
  const c = Math.cos(it.rot || 0), s = Math.sin(it.rot || 0);
  const T = (x, y) => ({ x: it.x + x * c - y * s, y: it.y + x * s + y * c });
  const segs = [], arcs = [], polys = [];

  const rect = (cx, cy, w, h) => {
    const p = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]].map(([x, y]) => T(x, y));
    for (let i = 0; i < 4; i++) segs.push([p[i], p[(i + 1) % 4]]);
    polys.push(p);
  };
  const ellipse = (cx, cy, rx, ry, n = 24) => {
    const p = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push(T(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)); }
    for (let i = 0; i < n; i++) segs.push([p[i], p[(i + 1) % n]]);
    polys.push(p);
  };

  for (const pr of partsOf(it)) {
    const [k] = pr;
    if (k === 'r') rect(pr[1], pr[2], pr[3], pr[4]);
    else if (k === 'c') arcs.push({ c: T(pr[1], pr[2]), r: pr[3] });
    else if (k === 'e') ellipse(pr[1], pr[2], pr[3], pr[4]);
    else if (k === 'l') segs.push([T(pr[1], pr[2]), T(pr[3], pr[4])]);
    else if (k === 'a') {
      const rot = ((it.rot || 0) * 180) / Math.PI;
      arcs.push({ c: T(pr[1], pr[2]), r: pr[3], a0: pr[4] + rot, a1: pr[5] + rot });
    } else if (k === 'p') {
      const pts = [];
      for (let i = 0; i < pr[1].length; i += 2) pts.push(T(pr[1][i], pr[1][i + 1]));
      const n = pr[2] ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) segs.push([pts[i], pts[(i + 1) % pts.length]]);
      if (pr[2]) polys.push(pts);
    }
  }
  return { segs, arcs, polys };
}
