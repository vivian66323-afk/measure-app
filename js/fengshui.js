// fengshui.js — 八宅 · 二十四山（民俗參考）
//
// 說明：這是華人室內設計軟體（含量房神器）常見的輔助功能，依「八宅明鏡」的
// 傳統規則由坐向推算方位吉凶。屬於民俗參考，不是工程或科學計算，
// 介面上一律標示為「參考」，不做任何斷言。
//
// 資料表與演算法對齊「風水羅盤」專案（C:\風水羅盤），兩邊結論必須一致：
//   · 二十四山：子居正北 0°，順時針每山 15°
//   · 八宅遊年：以「坐山所屬卦」為宅卦
//   · 文昌位：宅卦洛書數入中順飛，四綠所落之宮（落中宮者寄巽方）
// 本檔額外做的是「與平面圖的結合」：由大門推坐向、把房間分配到八方位、
// 標出明財位與文昌位的實際座標。

import * as G from './geometry.js';

const norm360 = (d) => ((d % 360) + 360) % 360;

/* ── 二十四山 ───────────────────────── */
export const MOUNTAINS = ['子', '癸', '丑', '艮', '寅', '甲', '卯', '乙', '辰', '巽', '巳', '丙',
  '午', '丁', '未', '坤', '申', '庚', '酉', '辛', '戌', '乾', '亥', '壬'];

/** 二十四山正五行：地支依本氣、天干依五行、四維依卦 */
export const MOUNT_WX = ['水', '水', '土', '土', '木', '木', '木', '木', '土', '木', '火', '火',
  '火', '火', '土', '土', '金', '金', '金', '金', '土', '金', '水', '水'];

/** 後天八卦（洛書方位） */
export const BAGUA = [
  { name: '坎', sym: '☵', wx: '水', num: 1, dir: '正北', person: '中男', center: 0, key: 'N' },
  { name: '艮', sym: '☶', wx: '土', num: 8, dir: '東北', person: '少男', center: 45, key: 'NE' },
  { name: '震', sym: '☳', wx: '木', num: 3, dir: '正東', person: '長男', center: 90, key: 'E' },
  { name: '巽', sym: '☴', wx: '木', num: 4, dir: '東南', person: '長女', center: 135, key: 'SE' },
  { name: '離', sym: '☲', wx: '火', num: 9, dir: '正南', person: '中女', center: 180, key: 'S' },
  { name: '坤', sym: '☷', wx: '土', num: 2, dir: '西南', person: '母親', center: 225, key: 'SW' },
  { name: '兌', sym: '☱', wx: '金', num: 7, dir: '正西', person: '少女', center: 270, key: 'W' },
  { name: '乾', sym: '☰', wx: '金', num: 6, dir: '西北', person: '父親', center: 315, key: 'NW' },
];

export const YUAN = ['地元龍', '天元龍', '人元龍'];

/* ── 八宅遊年 ───────────────────────── */
export const STARS = {
  生氣: { ji: true, rank: '大吉', star: '貪狼', wx: '木', desc: '旺丁旺財、進取活力', use: '宜大門、主臥、客廳' },
  延年: { ji: true, rank: '大吉', star: '武曲', wx: '金', desc: '健康長壽、感情和睦', use: '宜主臥、餐廳' },
  天醫: { ji: true, rank: '中吉', star: '巨門', wx: '土', desc: '少病消災、貴人扶助', use: '宜主臥、廚房' },
  伏位: { ji: true, rank: '小吉', star: '輔弼', wx: '木', desc: '平穩安定、守成聚氣', use: '宜書房、保險箱' },
  絕命: { ji: false, rank: '大凶', star: '破軍', wx: '金', desc: '損丁重病、意外破敗', use: '宜壓在廁所、儲藏室' },
  五鬼: { ji: false, rank: '大凶', star: '廉貞', wx: '火', desc: '口舌官非、小人火厄', use: '宜配置廁所、雜物間' },
  六煞: { ji: false, rank: '次凶', star: '文曲', wx: '水', desc: '桃花是非、破財爭執', use: '宜配置衛浴、走道' },
  禍害: { ji: false, rank: '小凶', star: '祿存', wx: '土', desc: '爭執退運、諸事不順', use: '宜配置衛浴、儲藏' },
};

/** 遊年盤：宅卦 → 各宮所得之星，順序固定為 BZ_ORDER */
export const BZ_ORDER = ['乾', '坎', '艮', '震', '巽', '離', '坤', '兌'];
export const BAZHAI = {
  乾: ['伏位', '六煞', '天醫', '五鬼', '禍害', '絕命', '延年', '生氣'],
  坎: ['六煞', '伏位', '五鬼', '天醫', '生氣', '延年', '絕命', '禍害'],
  艮: ['天醫', '五鬼', '伏位', '六煞', '絕命', '禍害', '生氣', '延年'],
  震: ['五鬼', '天醫', '六煞', '伏位', '延年', '生氣', '禍害', '絕命'],
  巽: ['禍害', '生氣', '絕命', '延年', '伏位', '天醫', '五鬼', '六煞'],
  離: ['絕命', '延年', '禍害', '生氣', '天醫', '伏位', '六煞', '五鬼'],
  坤: ['延年', '絕命', '生氣', '禍害', '五鬼', '六煞', '伏位', '天醫'],
  兌: ['生氣', '禍害', '延年', '絕命', '六煞', '五鬼', '天醫', '伏位'],
};
export const EAST4 = ['坎', '離', '震', '巽'];
export const isEastHouse = (gua) => EAST4.includes(gua);

/* ── 洛書飛星（文昌位用） ───────────────── */
const LUO_GUA = { 1: '坎', 2: '坤', 3: '震', 4: '巽', 6: '乾', 7: '兌', 8: '艮', 9: '離' };
const GUA_LUO = { 坎: 1, 坤: 2, 震: 3, 巽: 4, 乾: 6, 兌: 7, 艮: 8, 離: 9 };
const wrap9 = (n) => ((n - 1) % 9 + 9) % 9 + 1;

/** 由中宮數與順逆飛佈九宮：回傳 { 洛書數: 星 } */
function flyChart(center, forward = true) {
  const m = {};
  for (let L = 1; L <= 9; L++) {
    const step = ((L - 5) % 9 + 9) % 9;       // 中→乾→兌→艮→離→坎→坤→震→巽
    m[L] = wrap9(center + (forward ? step : -step));
  }
  return m;
}

/** 宅文昌 = 宅卦洛書數入中順飛，四綠所落之宮（落中宮者寄巽方） */
export function wenchangOf(guaName) {
  const chart = flyChart(GUA_LUO[guaName], true);
  for (let L = 1; L <= 9; L++) {
    if (chart[L] === 4) return L === 5 ? { gua: '巽', inCenter: true } : { gua: LUO_GUA[L], inCenter: false };
  }
  return null;
}
/** 流年紫白入中數（1864 甲子＝一白） */
export const yearStar = (y) => ((1864 - y) % 9 + 9) % 9 + 1;
/** 流年文昌 */
export function wenchangYear(y) {
  const chart = flyChart(yearStar(y), true);
  for (let L = 1; L <= 9; L++) {
    if (chart[L] === 4) return L === 5 ? { gua: null, inCenter: true } : { gua: LUO_GUA[L], inCenter: false };
  }
  return null;
}

/* ── 角度換算 ───────────────────────── */
/**
 * 模型座標方向角 → 羅盤方位角。
 * 模型：X 向右、Y 向上、逆時針為正；羅盤：正北 0°、順時針遞增。
 * north = 圖面「正北」相對模型 +Y 軸的旋轉量（弧度，逆時針為正）。
 */
export function toCompass(modelAngleRad, north = 0) {
  let c = norm360(90 - G.deg(modelAngleRad) + G.deg(north));
  if (c > 359.9999) c = 0;         // 浮點誤差別讓正北顯示成 360°
  return c;
}
export const fromCompass = (compassDeg, north = 0) => G.rad(90 - compassDeg + G.deg(north));

/** 角度 → 二十四山資訊（含正五行、元龍、兼向） */
export function mountainOf(deg) {
  const d = norm360(deg);
  const idx = Math.floor(norm360(d + 7.5) / 15) % 24;
  const center = idx * 15;
  let off = d - center;
  if (off > 180) off -= 360;
  if (off < -180) off += 360;

  const g = (idx + 1) % 24;                   // 以壬為八卦組首
  const guaIdx = Math.floor(g / 3);
  const yuanIdx = g % 3;

  // 兼向：偏離山心 3° 以上
  let jian = null;
  if (Math.abs(off) > 3) jian = MOUNTAINS[off > 0 ? (idx + 1) % 24 : (idx + 23) % 24];

  return {
    idx, name: MOUNTAINS[idx], center, off, wx: MOUNT_WX[idx],
    gua: BAGUA[guaIdx], yuan: YUAN[yuanIdx], yuanIdx, jian, deg: d,
  };
}

export const guaOf = (compassDeg) => BAGUA[Math.floor((norm360(compassDeg) + 22.5) % 360 / 45)];
/** 舊名相容 */
export const DIRS = BAGUA.map((b) => ({ key: b.key, name: b.dir.replace('正', ''), gua: b.name, deg: b.center }));
export const dirOf = guaOf;

/* ── 與平面圖結合 ───────────────────── */
/**
 * @param {object} floor
 * @param {Array}  rooms  detectRooms() 結果
 * @param {object} opt    { north:弧度, doorId:大門的 opening id, year:流年 }
 */
export function analyze(floor, rooms, opt = {}) {
  const north = opt.north || 0;
  const door = (floor.openings || []).find((o) => o.id === opt.doorId)
    || (floor.openings || []).find((o) => o.kind === 'door');
  if (!door) return { ok: false, reason: '尚未設定大門。請先在外牆上放一扇門，再於下方選為大門。' };

  const wall = (floor.walls || []).find((w) => w.id === door.wallId);
  if (!wall) return { ok: false, reason: '大門所在的牆已不存在。' };

  // 門的朝外法線：往牆的某一側探 600mm，若落在室內就取反向
  const d = G.norm(G.sub(wall.b, wall.a));
  const n = G.leftN(d);
  const L = G.dist(wall.a, wall.b) || 1;
  const mid = G.add(wall.a, G.mul(d, Math.max(0, Math.min(L, door.offset))));
  const inside = rooms.some((r) => G.pointInPoly(G.add(mid, G.mul(n, 600)), r.inner));
  const outward = inside ? G.mul(n, -1) : n;

  const facingDeg = toCompass(G.angleOf(outward), north);    // 向（大門朝外）
  const sittingDeg = norm360(facingDeg + 180);               // 坐
  const faceM = mountainOf(facingDeg);
  const sitM = mountainOf(sittingDeg);
  const gua = sitM.gua.name;                                 // 宅卦＝坐山所屬卦
  const row = BAZHAI[gua];

  const sectors = BAGUA.map((b) => {
    const star = row[BZ_ORDER.indexOf(b.name)];
    const s = STARS[star];
    // 注意：STARS 內的 star 欄位是九星名（貪狼…），與遊年星名不同，需分開存
    return {
      key: b.key, name: b.dir.replace('正', ''), fullDir: b.dir, gua: b.name, sym: b.sym,
      deg: b.center, person: b.person,
      star, starName: s.star, ji: s.ji, rank: s.rank, wx: s.wx, desc: s.desc, use: s.use,
      luck: s.ji ? 'good' : 'bad',
    };
  });

  // 各房間落在哪個方位（以全宅形心為中心）
  const all = rooms.flatMap((r) => r.inner);
  const c = all.length ? G.polyCentroid(all) : { x: 0, y: 0 };
  const roomDirs = rooms.map((r) => {
    const v = G.sub(r.centroid, c);
    if (G.len(v) < 200) return { room: r, sector: null, star: '中宮', luck: 'mid', rank: '—', use: '中宮宜通透，忌壓迫、忌設廁' };
    const cd = toCompass(G.angleOf(v), north);
    const b = guaOf(cd);
    const sec = sectors.find((x) => x.key === b.key);
    return { room: r, sector: sec, compass: cd, mountain: mountainOf(cd).name, star: sec.star, luck: sec.luck, rank: sec.rank, use: sec.use };
  });

  // 明財位：進門後的斜對角（取客廳中離大門最遠的角，再往形心收 28%）
  const living = rooms.find((r) => /客廳|起居/.test(r.name)) || rooms.slice().sort((a, b) => b.area - a.area)[0];
  let wealth = null;
  if (living) {
    let far = null, fd = -1;
    for (const p of living.inner) { const dd = G.dist(p, mid); if (dd > fd) { fd = dd; far = p; } }
    if (far) wealth = G.lerp(far, living.centroid, 0.28);
  }

  // 文昌位：宅卦飛星四綠所落之宮 → 換算成圖面座標
  const wc = wenchangOf(gua);
  let study = null;
  if (wc) {
    const b = BAGUA.find((x) => x.name === wc.gua);
    const sec = sectors.find((x) => x.key === b.key);
    let R = 2000;
    if (all.length) { const bb = G.bbox(all); R = Math.max(bb.w, bb.h) * 0.34; }
    const a = fromCompass(b.center, north);
    study = { x: c.x + Math.cos(a) * R, y: c.y + Math.sin(a) * R, sector: sec, gua: wc.gua, inCenter: wc.inCenter };
  }
  const year = opt.year || new Date().getFullYear();
  const wcY = wenchangYear(year);

  return {
    ok: true,
    north, center: c,
    door, doorPos: mid, outward,
    facingDeg, sittingDeg, faceM, sitM,
    gua, group: isEastHouse(gua) ? '東四宅' : '西四宅',
    sectors, roomDirs, wealth, study,
    wenchangYear: wcY, year,
    summary: `坐${sitM.gua.dir}朝${faceM.gua.dir}　坐${sitM.name}向${faceM.name}`
      + `${sitM.jian ? `（兼${sitM.jian}）` : ''} · ${gua}宅 · ${isEastHouse(gua) ? '東四宅' : '西四宅'}`,
  };
}

/** 命卦（依出生年與性別）— 看屋主與宅是否同組 */
export function personGua(year, male = true) {
  if (!(year > 1900)) return null;
  const digits = (n) => String(n).split('').reduce((a, b) => a + +b, 0);
  let r = digits(year);
  while (r > 9) r = digits(r);
  let n = male ? (11 - r) % 9 : (4 + r) % 9;
  if (n === 0) n = 9;
  const map = { 1: '坎', 2: '坤', 3: '震', 4: '巽', 5: male ? '坤' : '艮', 6: '乾', 7: '兌', 8: '艮', 9: '離' };
  const gua = map[n];
  return { num: n, gua, group: isEastHouse(gua) ? '東四命' : '西四命' };
}
