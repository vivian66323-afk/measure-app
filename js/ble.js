// ble.js — 藍牙測距儀連線層（Web Bluetooth）
//
// 為什麼要做「協定自動辨識 / 學習模式」：
// 各家藍牙測距儀（Kcsoft/科創、Mileseey、深達威、Bosch…）的 GATT UUID 與封包格式
// 並未公開統一。本層的做法是：連上後訂閱所有可 notify 的特徵值，把原始位元組
// 丟進一串解析器；若都無法辨識，使用者可用「學習模式」量一段已知距離、輸入
// 測距儀螢幕上的讀數，程式即自動反推欄位位置、編碼與倍率並鎖定為裝置設定檔。

import { pref } from './store.js';
import { hex, ascii } from './util.js';

/**
 * 服務 UUID 候選清單。
 *
 * 這裡列得很誇張是有原因的：Web Bluetooth 規定 getPrimaryServices() 只會回傳
 * 「事先在 optionalServices 宣告過」的服務。沒宣告的服務即使裝置有提供，
 * 也完全看不到 —— 這正是「連得上卻收不到資料」最常見的原因。
 * 由於各家測距儀用哪個 UUID 沒有標準，乾脆把廠商自訂常用的 16-bit 區段整段列出來。
 */
/**
 * 一律輸出完整的 128-bit 字串 UUID。
 * 規格雖然允許直接傳 16-bit 數字，但像 iOS 上的 Bluefy 這種
 * 「JS 橋接到原生 CoreBluetooth」的實作，數字經過橋接常常不被接受
 * —— 症狀是 requestDevice 立刻失敗、裝置清單根本不跳出來。
 */
export const toUuid = (v) => (typeof v === 'number'
  ? `${v.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`
  : String(v).toLowerCase());

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => toUuid(a + i));

/** 128-bit 的知名自訂服務（無法用區段涵蓋，只能逐一列） */
export const KNOWN_128 = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip / ISSC Transparent
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  'f000c0e0-0451-4000-b000-000000000000',
  '569a1101-b87f-490c-92cb-11ba5ea5167c', // Laird
  'be940000-7333-be46-b7ae-689e71722bd5',
];

/** 標準服務（少數機種把資料塞在標準服務底下） */
const STANDARD = [0x1800, 0x1801, 0x1802, 0x1803, 0x1804, 0x1805, 0x180a, 0x180f, 0x181a, 0x1819].map(toUuid);

/**
 * 預設清單：涵蓋絕大多數測距儀，同時控制長度。
 * 超長的 optionalServices 要經過 JS↔原生的橋接（iOS 上的 Bluefy 就是這樣做的），
 * 太長可能變慢甚至失敗，所以分成兩級：先用這份，不夠再用下面的全掃描。
 */
export const CANDIDATE_SERVICES = [
  ...range(0xffe0, 0xffef),   // HM-10 系列（FFE0/FFE1）
  ...range(0xfff0, 0xffff),   // 另一個常見自訂區段
  ...range(0xff00, 0xff10),
  ...[0xffa0, 0xffb0, 0xffc0, 0xffd0, 0xfee0, 0xfee1, 0xfee7, 0xfd00, 0xf000, 0xf0ff].map(toUuid),
  ...STANDARD,
  ...KNOWN_128,
];

/** 全掃描：連上卻列不出服務時才用，把廠商自訂區段整段列入 */
export const CANDIDATE_WIDE = [
  ...range(0xff00, 0xffff),
  ...range(0xfe00, 0xfeff),
  ...range(0xfd00, 0xfdff),
  ...range(0xf000, 0xf0ff),
  ...STANDARD,
  ...KNOWN_128,
];

/**
 * 「只顯示測距儀」用的篩選條件。
 *
 * 重要限制：Web Bluetooth 的 filters 只能比對**廣播封包**裡的內容。
 * 有些測距儀不在廣播裡放服務 UUID（要連上才看得到），那種機種一旦開啟篩選
 * 就會整台消失。所以這個功能一定要能一鍵關掉，不能寫死。
 */
const METER_SERVICES = [
  0xffe0,   // HM-10 系列，最常見（本專案實測的 MILESEEY S2 即為此系列）
  0xfff0, 0xff00, 0xffb0, 0xffe5, 0xffa0, 0xfee7,
].map(toUuid);

const METER_NAMES = [
  'S2', 'Mileseey', 'MILESEEY', 'LDM', 'SW-', 'Sndway', 'ATD', 'Kcsoft',
  'Laser', 'DISTO', 'GLM', 'Dist', 'Meter', 'JRT', 'BT-LDM',
];

/** 產生 filters 陣列；符合任一條就會出現在清單裡 */
export function meterFilters(extraNames = []) {
  const names = [...new Set([...extraNames.filter(Boolean), ...METER_NAMES])];
  return [
    ...METER_SERVICES.map((s) => ({ services: [s] })),
    ...names.map((n) => ({ namePrefix: n })),
  ];
}

/** 最保守版（瀏覽器連預設清單都不接受時的退路） */
export const CANDIDATE_FALLBACK = [
  ...[0xffe0, 0xffe5, 0xfff0, 0xff00, 0xffa0, 0xffb0, 0xffc0, 0xffd0, 0xfff6,
    0xfee0, 0xfee1, 0xfee7, 0xfd00, 0xf000, 0x180a, 0x180f, 0x1800, 0x1801].map(toUuid),
  ...KNOWN_128,
];

/**
 * 把任何被丟出來的東西轉成看得懂的字串。
 * 有些瀏覽器（iOS 的 Web BLE 橋接尤其如此）reject 的不是 Error 物件，
 * 直接讀 e.name / e.message 只會得到 undefined，等於什麼線索都沒有。
 */
export function describeErr(e) {
  if (e == null) return `(${e === null ? 'null' : 'undefined'})`;
  if (typeof e === 'string') return e;
  const name = e.name || e.code || e.constructor?.name;
  const msg = e.message || e.description || e.reason;
  if (name || msg) return [name, msg].filter(Boolean).join(' — ');
  try { const j = JSON.stringify(e); if (j && j !== '{}') return j.slice(0, 200); } catch { /* 循環參照 */ }
  return `${typeof e}: ${String(e)}`;
}

export const MIN_MM = 30;        // 3 cm
export const MAX_MM = 300000;    // 300 m
/** 設定檔結構版本；改變欄位語意時 +1，舊存檔會自動作廢 */
export const PROFILE_VER = 3;

const BIN_TYPES = {
  u16le: (d, o) => (o + 2 <= d.byteLength ? d.getUint16(o, true) : null),
  u16be: (d, o) => (o + 2 <= d.byteLength ? d.getUint16(o, false) : null),
  u24le: (d, o) => (o + 3 <= d.byteLength ? d.getUint8(o) | (d.getUint8(o + 1) << 8) | (d.getUint8(o + 2) << 16) : null),
  u24be: (d, o) => (o + 3 <= d.byteLength ? (d.getUint8(o) << 16) | (d.getUint8(o + 1) << 8) | d.getUint8(o + 2) : null),
  u32le: (d, o) => (o + 4 <= d.byteLength ? d.getUint32(o, true) : null),
  u32be: (d, o) => (o + 4 <= d.byteLength ? d.getUint32(o, false) : null),
  f32le: (d, o) => (o + 4 <= d.byteLength ? d.getFloat32(o, true) : null),
  f32be: (d, o) => (o + 4 <= d.byteLength ? d.getFloat32(o, false) : null),
};
/** 欄位值 × scale = mm */
const SCALES = [1, 0.1, 0.01, 10, 100, 1000];

/* ── ASCII 解析 ──────────────────────── */
export function parseAscii(text) {
  if (!text) return null;
  const t = text.replace(/[\r\n\0]+/g, ' ').trim();
  if (!/\d/.test(t)) return null;
  // 抓最後一個數字與「緊接在它後面」的單位（多數機種格式為 "D: 3.257 m" 或 "3.257M"）。
  // 單位必須貼著數字，不能在整串文字裡隨便找 —— 二進位封包被當成文字解讀時，
  // 常常混進 ' 或 " 這種字元，之前會被誤判成英尺／英吋，量到的長度就整個跑掉。
  const all = [...t.matchAll(/(-?\d+(?:\.\d+)?)\s*(mm|cm|m|ft|in)?\b/gi)];
  if (!all.length) return null;
  const last = all[all.length - 1];
  const raw = last[1];
  const unit = (last[2] || '').toLowerCase();
  const v = parseFloat(raw);
  if (!isFinite(v) || v <= 0) return null;
  const U = { mm: 1, cm: 10, m: 1000, ft: 304.8, in: 25.4 };
  const mm = unit ? v * U[unit]
    : (raw.includes('.') && v <= 300 ? v * 1000 : v);      // 沒單位：有小數點且 ≤300 視為公尺
  return mm >= MIN_MM && mm <= MAX_MM ? Math.round(mm) : null;
}

/* ── 內建二進位機種樣板 ───────────────── */
//
// 設定檔（spec）欄位：
//   offset/type/scale  取值位置、編碼、倍率（值 × scale = mm）
//   len                固定封包長度
//   head               標頭位元組
//   tail               結尾位元組
//   sum                檢查碼 { from, to, at }：bytes[from..to] 相加 & 0xFF 應等於 bytes[at]
// head / tail / sum 都是選填；有填就會在每一包做驗證，
// 避免電量、狀態之類的封包被誤判成距離。
const KNOWN_BIN = [
  {
    // Kcsoft（科創）等機種：ATD 標頭 + 4 bytes 大端距離（0.1 mm）+ 累加檢查碼 + '#'
    //   41 54 44 | 00 00 49 20 | 69 | 23
    name: 'ATD/32BE@3×0.1',
    spec: {
      mode: 'bin', offset: 3, type: 'u32be', scale: 0.1,
      len: 9, head: [0x41, 0x54, 0x44], tail: 0x23, sum: { from: 3, to: 6, at: 7 },
    },
  },
  // 0xAA 起始，第 3~6 byte 為距離（mm，大端）
  { name: 'AA/32BE@3', spec: { mode: 'bin', offset: 3, type: 'u32be', scale: 1, head: [0xaa] } },
  // 0x55 起始，距離 4 bytes 小端（0.1 mm）
  { name: '55/32LE@2×0.1', spec: { mode: 'bin', offset: 2, type: 'u32le', scale: 0.1, head: [0x55] } },
  // Nordic 直傳 4 bytes float（公尺）
  { name: 'F32LE@0(m)', spec: { mode: 'bin', offset: 0, type: 'f32le', scale: 1000, len: 4 } },
];

/** 封包是否符合設定檔宣告的框架（長度／標頭／結尾／檢查碼） */
export function frameOk(spec, b) {
  if (spec.len != null && b.length !== spec.len) return false;
  if (spec.head) {
    if (b.length < spec.head.length) return false;
    for (let i = 0; i < spec.head.length; i++) if (b[i] !== spec.head[i]) return false;
  }
  if (spec.tail != null && b[b.length - 1] !== spec.tail) return false;
  if (spec.sum) {
    const { from, to, at } = spec.sum;
    if (b.length <= Math.max(to, at)) return false;
    let s = 0;
    for (let i = from; i <= to; i++) s += b[i];
    if ((s & 0xff) !== b[at]) return false;
  }
  return true;
}

/** 用設定檔解析原始位元組 → mm */
export function applyProfile(profile, bytes, text) {
  if (!profile) return null;
  if (profile.mode === 'ascii') return parseAscii(text);
  if (profile.mode === 'bin') {
    if (!frameOk(profile, bytes)) return null;
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fn = BIN_TYPES[profile.type];
    if (!fn) return null;
    const v = fn(d, profile.offset);
    if (v == null || !isFinite(v)) return null;
    const mm = v * profile.scale;
    return mm >= MIN_MM && mm <= MAX_MM ? Math.round(mm) : null;
  }
  return null;
}

/** 未鎖定設定檔時的推測解析：回傳 {mm, profile} 或 null */
export function guess(bytes, text) {
  // 二進位樣板優先：有標頭與檢查碼可驗證，比 ASCII 猜測可靠得多
  for (const k of KNOWN_BIN) {
    const mm = applyProfile(k.spec, bytes, text);
    if (mm != null) return { mm, profile: k.spec, how: k.name };
  }
  const a = parseAscii(text);
  if (a != null) return { mm: a, profile: { mode: 'ascii' }, how: 'ASCII' };
  return null;
}

/**
 * 串流自動辨識：沒有已知樣板時，用「連續幾包資料」自己推出距離欄位。
 *
 * 原理：測距儀每量一次就送一包，包長固定、距離欄位會變、其他欄位多半不變。
 * 所以掃描所有 (位置, 編碼, 倍率) 組合，挑出「每包都落在合理距離範圍、
 * 且各包數值不同」的欄位。再加上檢查碼、欄位穩定度等加分，取最高分者。
 *
 * 這是猜測，所以辨識後會請使用者確認一次；不對就用學習模式輸入實際值。
 *
 * @param {Uint8Array[]} packets 至少 3 包、長度相同
 * @returns {{spec:object, values:number[], score:number}|null}
 */
/** 自動辨識的最少樣本數。太少會把心跳封包誤認成距離。 */
export const AUTO_MIN_PACKETS = 6;
/** 樣本值至少要有這麼大的差距，才像是「量了不同的地方」而不是心跳的微幅跳動 */
export const AUTO_MIN_SPREAD = 100;   // mm

export function autoDetect(packets) {
  const pk = packets.filter((p) => p && p.byteLength === packets[0].byteLength);
  if (pk.length < AUTO_MIN_PACKETS) return null;
  const len = pk[0].byteLength;
  if (len < 2) return null;

  const sizeOf = (type) => (type.includes('16') ? 2 : type.includes('24') ? 3 : 4);

  // 會變動的位元組。距離欄位必須「涵蓋全部」——
  // 只蓋到一部分的候選（例如把 4 byte 欄位當成 3 byte 讀）一定是錯的，
  // 這是最有鑑別力的篩選條件。
  let varying = [];
  for (let i = 0; i < len; i++) if (pk.some((p) => p[i] !== pk[0][i])) varying.push(i);
  if (!varying.length) return null;

  // 先找累加檢查碼：它也會跟著變，要先排除，否則沒有欄位涵蓋得了它
  let sum = null;
  outer:
  for (const at of varying) {
    for (let from = 0; from < len; from++) {
      for (let to = from + 1; to < len; to++) {
        if (at >= from && at <= to) continue;
        if (pk.every((p) => {
          let s = 0;
          for (let i = from; i <= to; i++) s += p[i];
          return (s & 0xff) === p[at];
        })) { sum = { from, to, at }; break outer; }
      }
    }
  }
  if (sum) varying = varying.filter((i) => i !== sum.at);
  if (!varying.length) return null;
  const vMin = Math.min(...varying), vMax = Math.max(...varying);

  const cands = [];
  for (const [type, fn] of Object.entries(BIN_TYPES)) {
    const size = sizeOf(type);
    for (let off = 0; off + size <= len; off++) {
      if (off > vMin || off + size <= vMax) continue;     // 必須完整涵蓋所有變動位元組
      // 先把這個位置／編碼的原始值取出來，倍率之後再套
      const raws = [];
      let readable = true;
      for (const p of pk) {
        const v = fn(new DataView(p.buffer, p.byteOffset, p.byteLength), off);
        if (v == null || !isFinite(v)) { readable = false; break; }
        raws.push(v);
      }
      if (!readable) continue;
      if (new Set(raws).size < 2) continue;               // 都一樣就不是距離

      // 位元組序猜錯時，原始值會散布到整個欄位空間；正確的解讀通常只用到一部分
      const fieldMax = type.startsWith('f') ? 0 : 2 ** (size * 8) - 1;
      const fillBonus = fieldMax ? 4 * (1 - Math.max(...raws) / fieldMax) : 0;
      // 無號距離欄位裡若含「固定不變且非零」的位元組，代表把旁邊的旗標欄位也吃進來了
      let constNonZero = 0;
      if (fieldMax) {
        for (let i = off; i < off + size; i++) {
          if (pk.every((p) => p[i] === pk[0][i]) && pk[0][i] !== 0) constNonZero++;
        }
      }
      // 後面幾個位元組固定為 0 → 多半是同一個欄位的高位，欄位取大一點比較安全
      const zeroTail = fieldMax && pk.every((p) => {
        for (let i = off + size; i < len; i++) if (p[i] !== 0) return false;
        return off + size < len;
      }) ? 2 : 0;

      for (const scale of SCALES) {
        const vals = raws.map((v) => Math.round(v * scale));
        if (vals.some((mm) => mm < MIN_MM || mm > MAX_MM)) continue;

        let score = new Set(vals).size * 4 + fillBonus + zeroTail - constNonZero * 12;
        if (scale === 1 || scale === 0.1) score += 10;     // mm / 0.1mm 最常見
        if (type.startsWith('u')) score += 3;
        // 檢查碼保護的範圍通常就是資料欄位本身，命中是很強的證據
        if (sum && off === sum.from && off + size - 1 === sum.to) score += 25;
        else if (sum && off >= sum.from && off + size - 1 <= sum.to) score += 8;
        // 倍率單靠封包無法斷定（187 mm 與 1872 mm 都合理），
        // 只能用「室內量房的典型量程 0.5–15 m」當先驗，最後仍請使用者確認。
        const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
        if (med >= 500 && med <= 15000) score += 14;
        else if (med >= 200 && med <= 50000) score += 5;
        score -= off * 0.3;
        if (vals.every((v) => v % 10 === 0)) score += 2;
        cands.push({ spec: { mode: 'bin', offset: off, type, scale }, values: vals, score });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);

  const best = cands[0];
  // 心跳／狀態封包的數值只會微幅跳動（實測 MILESEEY S2 的心跳是 2470→2471→2473），
  // 拿它當距離會鎖出一個看似合理卻永遠不變的假讀數。
  // 真的在量房，前後幾筆一定差很多，用這點把兩者分開。
  const spread = Math.max(...best.values) - Math.min(...best.values);
  const distinct = new Set(best.values).size;
  if (spread < AUTO_MIN_SPREAD || distinct < 3) return null;
  // 補上可驗證的框架，之後每一包都會檢查
  const head = [];
  for (let i = 0; i < Math.min(4, len); i++) {
    if (pk.every((p) => p[i] === pk[0][i])) head.push(pk[0][i]); else break;
  }
  if (head.length) best.spec.head = head;
  if (pk.every((p) => p[len - 1] === pk[0][len - 1])) best.spec.tail = pk[0][len - 1];
  best.spec.len = len;
  if (sum) best.spec.sum = sum;
  best.runnerUp = cands[1] ? { spec: cands[1].spec, gap: +(best.score - cands[1].score).toFixed(1) } : null;
  return best;
}

/**
 * 學習模式：由多組 (原始位元組, 實際 mm) 樣本反推設定檔。
 * @param {Array<{bytes:Uint8Array, mm:number}>} samples
 */
export function learnProfile(samples) {
  if (!samples.length) return null;
  // 先試 ASCII
  if (samples.every((s) => {
    const v = parseAscii(new TextDecoder().decode(s.bytes));
    return v != null && Math.abs(v - s.mm) <= Math.max(5, s.mm * 0.01);
  })) return { mode: 'ascii' };

  const maxLen = Math.min(...samples.map((s) => s.bytes.byteLength));
  const cands = [];
  for (const [type, fn] of Object.entries(BIN_TYPES)) {
    for (let off = 0; off < maxLen; off++) {
      for (const scale of SCALES) {
        let ok = true;
        for (const s of samples) {
          const d = new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
          const v = fn(d, off);
          if (v == null || !isFinite(v)) { ok = false; break; }
          const mm = v * scale;
          if (Math.abs(mm - s.mm) > Math.max(3, s.mm * 0.005)) { ok = false; break; }
        }
        if (ok) cands.push({ mode: 'bin', offset: off, type, scale });
      }
    }
  }
  if (!cands.length) return null;
  // 偏好整數 mm、低偏移、短欄位
  const rank = (c) => (c.scale === 1 ? 0 : 1) * 10 + c.offset + (c.type.startsWith('f') ? 5 : 0);
  cands.sort((a, b) => rank(a) - rank(b));
  return cands[0];
}

/* ── 連線管理 ────────────────────────── */
export class Meter extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.chars = [];
    this.status = 'idle';           // idle | connecting | connected | error
    // 資料格式檔「每台裝置各存一份」，連線時才載入那一台的（見 _openGatt）。
    // 舊版全域只存一份且綁死特徵值 UUID：用過 S2 之後再連 Kcsoft，
    // Kcsoft 的封包全被當雜訊丟掉 —— 連得上卻永遠沒有讀值（實際發生過）。
    this.profile = null;
    this.lastMm = null;
    this.count = 0;
    this.log = [];                  // 原始封包紀錄（除錯 / 學習用）
    this.steps = [];                // 連線過程逐步紀錄
    this._auto = {};                // 自動辨識用的封包緩衝（依特徵值分開）
    this.pendingConfirm = null;     // 自動辨識結果，等使用者確認
    this.textBuf = {};              // ASCII 重組緩衝（依特徵值分開）
    this._lastAt = 0;
    this._connectedAt = 0;
    this._autoReconnect = true;
  }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  /** 上次連過的裝置（顯示用） */
  static get remembered() { return pref.get('ble.lastDevice', null); }

  /** 連過的裝置名稱（自動加入篩選） */
  static get knownNames() { return pref.get('ble.knownNames', []); }

  /**
   * 舊版把上次的裝置名稱直接寫進「名稱關鍵字」，會把別台測距儀濾掉。
   * 這裡把舊資料搬到已知清單，並清空關鍵字欄位還給使用者。
   */
  static migratePrefs() {
    const legacy = pref.get('ble.namePrefix', '');
    const last = pref.get('ble.lastDevice', null);
    if (legacy && legacy === last?.name) {
      const names = pref.get('ble.knownNames', []);
      if (!names.includes(legacy)) { names.push(legacy); pref.set('ble.knownNames', names); }
      pref.del('ble.namePrefix');
    }
    // 「只顯示測距儀」原本預設開啟，但過濾比對的是廣播封包 ——
    // 有些測距儀（實測 MILESEEY S2）不把名稱與服務放進廣播，開著就整台消失。
    // 保證每台都找得到比清單短更重要，改成預設關閉；已存的設定強制重設一次。
    if (!pref.get('ble.filterDefaultFix', false)) {
      pref.set('ble.onlySupported', false);
      pref.set('ble.filterDefaultFix', true);
    }
    // 舊版全域格式檔直接作廢，不搬移 —— 沒辦法確定它屬於哪一台，
    // 搬錯台反而把那台鎖死。代價只是每台下次連線時重新辨識一次（內建
    // 樣板與 ASCII 都是即時認出，使用者無感）。
    pref.del('ble.profile');
  }

  /** 這台裝置的格式檔存放鍵：優先用瀏覽器給的裝置 id，沒有就用名稱 */
  _profKey() { return this.device?.id || this.device?.name || ''; }

  /** 把目前的格式檔存回「每台一份」的清單（null＝清除這台的） */
  _saveProfile() {
    const all = pref.get('ble.profiles', {});
    const key = this._profKey();
    if (this.profile) all[key] = this.profile; else delete all[key];
    pref.set('ble.profiles', all);
  }

  /**
   * 直接連回上次那台，不跳裝置清單。
   * 需要瀏覽器支援 getDevices()（已授權過的裝置才會列出來）。
   */
  async reconnectLast() {
    const last = Meter.remembered;
    if (!last?.id) throw new Error('還沒有連過任何裝置');
    if (!navigator.bluetooth.getDevices) throw new Error('這個瀏覽器不支援「記住裝置」，請用名稱關鍵字篩選');
    this.steps = [];
    this.step(`尋找已授權的裝置：${last.name || last.id.slice(0, 8)}`);
    const devs = await navigator.bluetooth.getDevices();
    const dev = devs.find((d) => d.id === last.id) || devs.find((d) => d.name && d.name === last.name);
    if (!dev) throw new Error('找不到上次那台，請改用「搜尋並連線」重新選擇');
    this.step(`找到 ${dev.name || '(未命名)'}，直接連線`);
    this.device = dev;
    dev.addEventListener?.('gattserverdisconnected', () => this._onDrop());
    await this._openGatt();
  }

  /**
   * 為什麼不支援 —— 「此瀏覽器不支援」對使用者沒有幫助，要講出原因與做法。
   * @returns {{code:string, title:string, why:string, fix:string}|null}
   */
  static get blockReason() {
    if (Meter.supported) return null;
    const ua = navigator.userAgent || '';
    // iPadOS 會偽裝成 Mac，用觸控點數辨識
    const iOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|KAKAOTALK/i.test(ua);

    if (iOS) {
      return {
        code: 'ios',
        title: 'iPhone / iPad 需要另一個瀏覽器',
        why: 'Apple 規定 iOS 上所有瀏覽器都必須使用 WebKit 引擎，'
          + '所以 iOS 版的 Chrome、Edge、Firefox 其實都是 Safari —— 而 Safari 至今沒有實作 Web Bluetooth。換瀏覽器沒有用。',
        fix: 'App Store 搜尋並安裝免費的「Bluefy – Web BLE Browser」，用它開啟本網址即可連線測距儀。'
          + '其餘功能（繪圖、面積、匯出、拍照）在 Safari 上都正常，只有藍牙需要 Bluefy。',
      };
    }
    if (!window.isSecureContext) {
      return {
        code: 'insecure',
        title: '網址不是 HTTPS',
        why: `Web Bluetooth 只在 https:// 或 localhost 下可用，目前是 ${location.protocol}//${location.host}。`,
        fix: '改用 https 網址，或在自己電腦上以 http://localhost:5173 開啟。',
      };
    }
    if (inApp) {
      return {
        code: 'inapp',
        title: '請用瀏覽器開啟，不要用 App 內建的瀏覽器',
        why: 'LINE、Facebook 等 App 內建的瀏覽器不提供 Web Bluetooth。',
        fix: '點右上角選單選「用瀏覽器開啟」，或把網址複製到 Chrome 貼上。',
      };
    }
    return {
      code: 'other',
      title: '此瀏覽器不支援 Web Bluetooth',
      why: '目前支援的是 Android 的 Chrome / Edge，以及 Windows、macOS 的 Chrome / Edge。',
      fix: '請改用上述瀏覽器；iPhone / iPad 請安裝「Bluefy」。',
    };
  }

  _set(status, msg = '') {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, msg } }));
  }

  /** 連線過程的逐步紀錄，出問題時使用者可以直接看到卡在哪一步 */
  step(msg, ok = true) {
    const rec = { t: Date.now(), msg, ok };
    this.steps.push(rec);
    if (this.steps.length > 40) this.steps.shift();
    this.dispatchEvent(new CustomEvent('step', { detail: rec }));
  }

  async connect({ wide = false, namePrefix = '', onlySupported = false } = {}) {
    const blocked = Meter.blockReason;
    if (blocked) throw Object.assign(new Error(blocked.title), { blocked });

    this.steps = [];
    this._set('connecting', '請在裝置清單中選擇測距儀');

    // 不同瀏覽器接受的呼叫形式不一樣，由寬到窄依序嘗試。
    // 尤其 iOS 上的第三方 Web BLE 瀏覽器，對 optionalServices 的長度與
    // acceptAllDevices 的支援程度都不同，逐一試過才知道哪一種可行。
    const main = wide ? CANDIDATE_WIDE : CANDIDATE_SERVICES;
    const attempts = [];
    const np = namePrefix.trim();

    if (onlySupported) {
      // 「只顯示測距儀」＝服務 UUID + 常見機種名 + 連過的裝置名 + 使用者輸入的關鍵字。
      // 關鍵字是「加進」篩選，不是取代 —— 取代會把另一台測距儀濾掉（發生過）。
      const f = meterFilters([np, ...Meter.knownNames]);
      attempts.push([`只顯示測距儀（${f.length} 條比對規則）`, { filters: f, optionalServices: main }]);
    } else if (np) {
      attempts.push([`名稱以「${np}」開頭`, { filters: [{ namePrefix: np }], optionalServices: main }]);
    }

    attempts.push(
      [`全部裝置 ＋ ${main.length} 個服務`, { acceptAllDevices: true, optionalServices: main }],
      [`全部裝置 ＋ ${CANDIDATE_FALLBACK.length} 個服務`, { acceptAllDevices: true, optionalServices: CANDIDATE_FALLBACK }],
      [`全部裝置 ＋ ${CANDIDATE_FALLBACK.length} 個服務`, { acceptAllDevices: true, optionalServices: CANDIDATE_FALLBACK }],
      ['全部裝置（不指定服務）', { acceptAllDevices: true }],
    );

    let dev = null, lastErr = null;
    for (const [name, opts] of attempts) {
      try {
        this.step(`requestDevice — ${name}`);
        dev = await navigator.bluetooth.requestDevice(opts);
        this.step(`已選擇裝置：${dev?.name || '(未命名)'}`);
        break;
      } catch (e) {
        lastErr = e;
        const d = describeErr(e);
        this.step(`失敗：${d}`, false);
        // 使用者自己按取消就別再試了；其餘情況繼續往下一種形式
        if (/NotFoundError|cancel/i.test(d)) {
          this.step(opts.filters
            ? '（篩選後沒有符合的裝置，或你按了取消。可關掉「只顯示測距儀」再試）'
            : '（判定為使用者取消或找不到裝置，停止嘗試）');
          break;
        }
      }
    }
    if (!dev) {
      this._set('idle', '');
      throw lastErr instanceof Error ? lastErr : new Error(describeErr(lastErr));
    }

    this.device = dev;
    dev.addEventListener?.('gattserverdisconnected', () => this._onDrop());
    await this._openGatt();
  }

  async _openGatt() {
    const dev = this.device;
    // 載入「這一台」的格式檔，並清空上一台留下的辨識緩衝 ——
    // 必須在訂閱通知之前做，否則第一批封包會被舊格式檔擋掉。
    const saved = pref.get('ble.profiles', {})[this._profKey()];
    this.profile = saved?.v === PROFILE_VER ? saved : null;
    this._auto = {}; this.textBuf = {}; this.pendingConfirm = null;
    this.step(this.profile ? '已載入這台的資料格式檔' : '這台還沒有格式檔，收到資料後自動辨識');
    this._set('connecting', '連線中…');
    this.step('gatt.connect()…');
    let server;
    try {
      server = await dev.gatt.connect();
      this.step('GATT 已連線');
    } catch (e) {
      this.step(`GATT 連線失敗：${describeErr(e)}`, false);
      this._set('error', `連線失敗：${e.message}`);
      throw e;
    }
    let services = [];
    try {
      services = await server.getPrimaryServices();
      this.step(`列出服務：${services.length} 個`);
    } catch (e) {
      this.step(`列出服務失敗：${describeErr(e)}`, false);
    }
    this.chars = [];
    this.readable = [];
    this.writable = [];
    this.map = [];                       // 裝置結構，供診斷面板顯示

    for (const s of services) {
      const cs = await s.getCharacteristics().catch(() => []);
      const entry = { uuid: s.uuid, chars: [] };
      for (const c of cs) {
        const p = c.properties;
        const flags = [
          p.notify && 'notify', p.indicate && 'indicate', p.read && 'read',
          p.write && 'write', p.writeWithoutResponse && 'writeNR',
        ].filter(Boolean);
        let subscribed = false;
        if (p.notify || p.indicate) {
          try {
            await c.startNotifications();
            c.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target));
            this.chars.push(c);
            subscribed = true;
          } catch { /* 部分特徵值宣告了 notify 卻不允許訂閱 */ }
        }
        if (p.read) this.readable.push(c);
        if (p.write || p.writeWithoutResponse) this.writable.push(c);
        entry.chars.push({ uuid: c.uuid, flags, subscribed });
      }
      this.map.push(entry);
      this.step(`　服務 ${s.uuid.slice(4, 8).toUpperCase()}：${entry.chars.length} 個特徵值`
        + `，訂閱 ${entry.chars.filter((c) => c.subscribed).length} 個`);
    }

    this.dispatchEvent(new CustomEvent('map', { detail: this.map }));

    if (!services.length) {
      this._set('error', '已連線，但列不出任何服務。這台裝置的服務 UUID 不在允許清單內。');
      this.dispatchEvent(new CustomEvent('noservice'));
      return;
    }
    if (!this.chars.length) {
      this._set('error', `已連線（${services.length} 個服務），但沒有可訂閱的特徵值。可改用「輪詢讀取」。`);
      this.dispatchEvent(new CustomEvent('nochar'));
      return;
    }
    this._connectedAt = Date.now();
    // 記住這台：名稱「加入」已知清單，讓它之後都會出現在篩選裡。
    // 千萬不能寫進「名稱關鍵字」—— 那會把清單縮到只剩這一台，
    // 使用者換另一支測距儀時就再也看不到它了（實際發生過）。
    if (dev.name) {
      const names = pref.get('ble.knownNames', []);
      if (!names.includes(dev.name)) {
        names.push(dev.name);
        pref.set('ble.knownNames', names.slice(-8));   // 最多記 8 台
      }
    }
    pref.set('ble.lastDevice', { id: dev.id || '', name: dev.name || '' });
    this._set('connected', `${dev.name || '測距儀'}（${services.length} 服務／訂閱 ${this.chars.length} 個特徵值）`);

    // 連上不代表選對了裝置。給一段時間等第一筆資料，沒來就提醒使用者換一台。
    clearTimeout(this._silentTimer);
    const before = this.count;
    this._silentTimer = setTimeout(() => {
      if (this.count === before && this.status === 'connected') {
        this.step('已連線 20 秒仍未收到任何資料', false);
        this.dispatchEvent(new CustomEvent('silent'));
      }
    }, 20000);
  }

  /**
   * 輪詢模式：有些機種不主動推播，要靠主動讀取。
   * 每 interval 毫秒把所有可讀特徵值讀一遍，讀到的位元組走同一套解析流程。
   */
  startPolling(interval = 400) {
    this.stopPolling();
    if (!this.readable?.length) return false;
    this._poll = setInterval(async () => {
      for (const c of this.readable) {
        try { this._onData({ uuid: c.uuid, value: await c.readValue() }); }
        catch { /* 讀取失敗就跳過 */ }
      }
    }, interval);
    this.dispatchEvent(new CustomEvent('status', { detail: { status: this.status, msg: '已開始輪詢讀取' } }));
    return true;
  }
  stopPolling() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
  }

  async _onDrop() {
    this._set('idle', '連線已中斷');
    if (!this._autoReconnect || !this.device) return;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      if (this.status === 'connected') return;
      try { await this._openGatt(); return; } catch { /* 重試 */ }
    }
  }

  disconnect() {
    this._autoReconnect = false;
    this.stopPolling();
    clearTimeout(this._silentTimer);
    try { this.device?.gatt?.disconnect(); } catch { /* 已斷線 */ }
    this.device = null; this.chars = []; this.readable = []; this.writable = []; this.map = [];
    this._set('idle', '已中斷連線');
  }

  _onData(char) {
    const bytes = new Uint8Array(char.value.buffer.slice(0));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const uuid = char.uuid || '';
    const rec = { t: Date.now(), uuid, bytes, hex: hex(bytes), ascii: ascii(bytes) };
    this.log.push(rec);
    if (this.log.length > 400) this.log.shift();
    this.dispatchEvent(new CustomEvent('raw', { detail: rec }));

    // 測距儀通常同時推播好幾種封包：距離、電量、傾角、心跳…
    // 認出距離來自哪個特徵值之後就只聽那一個，否則心跳封包會被當成距離。
    // 例外：別的特徵值送來「有標頭＋檢查碼」都驗證通過的內建樣板封包，
    // 代表距離其實走那條通道（格式檔存錯了），就地改綁；驗不過才丟。
    if (this.profile?.uuid && uuid !== this.profile.uuid) {
      const k = KNOWN_BIN.find((k) => k.spec.sum && applyProfile(k.spec, bytes, text) != null);
      if (!k) return;
      this._lockProfile({ ...k.spec, uuid }, `${k.name}（改綁特徵值）`);
    }

    let mm = null;

    if (this.profile?.mode === 'bin') {
      mm = applyProfile(this.profile, bytes, text);
    } else if (this.profile?.mode === 'ascii') {
      mm = this._asciiFeed(uuid, text);
    } else {
      // 尚未鎖定格式。二進位樣板先試（有標頭／檢查碼可驗證，比猜 ASCII 可靠），
      // 都不符合才走 ASCII 的跨封包重組。
      for (const k of KNOWN_BIN) {
        const v = applyProfile(k.spec, bytes, text);
        if (v != null) { mm = v; this._lockProfile({ ...k.spec, uuid }, k.name); break; }
      }
      if (mm == null) {
        const v = this._asciiFeed(uuid, text);
        if (v != null) { mm = v; this._lockProfile({ mode: 'ascii', uuid }, 'ASCII 文字'); }
      }
      // 已知樣板與 ASCII 都不符 → 累積幾包後自己推。
      // 緩衝區依特徵值分開，否則不同種類的封包混在一起永遠推不出東西，
      // 更糟的是可能從心跳封包推出一組看似合理卻完全錯誤的格式。
      // 連線後先留一段時間給 ASCII 與已知樣板；MILESEEY S2 這類機種的
      // 距離是 ASCII，但心跳封包來得更早，太早啟動猜測就會猜到心跳上。
      if (mm == null && Date.now() - this._connectedAt > 12000) {
        const buf = (this._auto[uuid] ||= []);
        buf.push(bytes);
        if (buf.length > 14) buf.shift();
        const r = autoDetect(buf);
        if (r) {
          this._lockProfile({ ...r.spec, uuid }, `自動辨識（${r.values.length} 包比對）`);
          this.pendingConfirm = r;
          this.dispatchEvent(new CustomEvent('autodetect', { detail: r }));
          mm = applyProfile(this.profile, bytes, text);
        }
      }
    }
    if (mm == null) return;

    const now = Date.now();
    this.live = mm;                       // 即時值：畫面隨時顯示，但不一定會被採用
    this.dispatchEvent(new CustomEvent('live', { detail: { mm } }));

    if (!this._accept(mm, now)) return;
    this.lastMm = mm; this._lastAt = now; this.count++;
    this.dispatchEvent(new CustomEvent('reading', { detail: { mm, raw: rec } }));
  }

  /**
   * 判斷這筆數值算不算「一次新的量測」。
   *
   * 有些測距儀是按一次送一筆，有些（例如 MILESEEY S2）會持續串流目前讀數。
   * 串流機種若照單全收，一次量測就會產生上百筆、把圖面畫爛，
   * 所以偵測到串流時改成：數值要先穩定下來，而且與上次採用的不同，才算數。
   */
  _accept(mm, now) {
    this._rate = (this._rate || []).filter((t) => now - t < 1000);
    this._rate.push(now);
    this.rate = this._rate.length;                       // 每秒封包數，UI 會顯示

    // 連續 6 包同值也視為串流（有些機種送得慢但一直重送）
    if (mm === this._pendVal) this._pendCount = (this._pendCount || 0) + 1;
    else { this._pendVal = mm; this._pendCount = 1; }
    const wasStreaming = this.streaming;
    this.streaming = this.rate >= 3 || this._pendCount >= 6;
    if (this.streaming !== wasStreaming) this.dispatchEvent(new CustomEvent('mode'));

    if (!this.streaming) {
      // 一般機種：按一次送一筆，只要擋掉短時間內的重複封包
      return !(this.lastMm === mm && now - this._lastAt < 500);
    }

    // 串流機種（例如 MILESEEY S2，每秒重送三次目前讀數）：
    //   · 數值要先穩定下來（連續 3 包相同）才算量好了
    //   · 而且必須與上次採用的不同 —— 沒變就不是新的一次量測，
    //     否則同一個讀數會每隔幾百毫秒就被塞進圖面一次
    // 需要重複套用同一個數值時，按量測面板的「套用」鈕即可。
    if (this._pendCount !== 3) return false;
    return mm !== this.lastMm;
  }

  _lockProfile(spec, how) {
    this.profile = { ...spec, v: PROFILE_VER };
    this._saveProfile();
    this.dispatchEvent(new CustomEvent('profile', { detail: { profile: this.profile, how } }));
  }

  /** ASCII 跨封包重組：測距儀常把一行拆成兩包送。緩衝區依特徵值分開。 */
  _asciiFeed(uuid, text) {
    const buf = ((this.textBuf[uuid] || '') + text).slice(-160);
    const lines = buf.split(/[\r\n]+/);
    if (lines.length > 1) {
      this.textBuf[uuid] = lines.pop();
      for (const ln of lines.reverse()) { const v = parseAscii(ln); if (v != null) return v; }
    } else this.textBuf[uuid] = buf;
    return parseAscii(text);
  }

  /** 手動注入一筆讀數（手動輸入 / 測試用） */
  inject(mm) {
    this.live = mm;                        // 與 _onData 一致，設定切換時的重新取整才有值可用
    this.lastMm = mm; this._lastAt = Date.now(); this.count++;
    this.dispatchEvent(new CustomEvent('live', { detail: { mm } }));
    this.dispatchEvent(new CustomEvent('reading', { detail: { mm, raw: null, manual: true } }));
  }

  setProfile(p) {
    this._auto = {};
    this.textBuf = {};
    this.pendingConfirm = null;
    this.profile = p ? { ...p, v: PROFILE_VER } : null;
    this._saveProfile();
    this.dispatchEvent(new CustomEvent('profile', { detail: { profile: this.profile, how: '手動設定' } }));
  }

  /**
   * 送出指令（例如喚醒或觸發測量）。各機種指令不同，於藍牙面板可自行輸入 hex。
   * @param {string} hexStr 例如 "AA 01 00"
   * @param {string} [uuid] 指定寫入哪個特徵值；省略則逐一嘗試
   */
  async write(hexStr, uuid = null) {
    const bytes = Uint8Array.from(hexStr.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16)));
    if (!bytes.length || [...bytes].some((b) => !isFinite(b))) throw new Error('指令格式錯誤，請輸入十六進位如 AA 01 00');
    const targets = uuid ? this.writable.filter((c) => c.uuid === uuid) : this.writable;
    if (!targets.length) throw new Error('這台裝置沒有可寫入的特徵值');
    const failed = [];
    for (const w of targets) {
      try {
        if (w.properties.writeWithoutResponse) await w.writeValueWithoutResponse(bytes);
        else await w.writeValueWithResponse(bytes);
        return w.uuid;
      } catch (e) { failed.push(`${w.uuid.slice(4, 8)}:${e.name}`); }
    }
    throw new Error('寫入失敗 — ' + failed.join(', '));
  }
}
