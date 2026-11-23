// build.mjs — 打包成可上傳到靜態託管（Cloudflare Pages / Netlify）的資料夾
//
//   node build.mjs
//
// 產出 dist/ 與 dist.zip。dist/ 裡只有瀏覽器需要的檔案：
// server.mjs、check.mjs、data/ 這些後端與開發用的東西不會進去。
//
// 靜態託管沒有 /api，所以「雲端同步」與「分享連結」在上面不會運作 ——
// 程式偵測得到並會明講。其餘功能（量房、藍牙、面積、DXF/DAE 匯出）全都正常。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const FILES = ['index.html', 'share.html', 'manifest.webmanifest', 'sw.js'];
const DIRS = ['css', 'js', 'img'];

/* Cloudflare Pages / Netlify 都吃這兩個檔 */
const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

# 這兩個一定要拿到最新版，否則改版後使用者會卡在舊快取
/sw.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/share.html
  Cache-Control: no-cache
`;

/* 分享連結頁的網址是 /s/<token>，交給同一份 share.html 處理 */
const REDIRECTS = `/s/*  /share.html  200
`;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
const size = (p) => {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? size(f) : fs.statSync(f).size;
  }
  return n;
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const f of FILES) {
  if (!fs.existsSync(path.join(ROOT, f))) { console.error(`  缺少 ${f}`); process.exit(1); }
  fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
}
for (const d of DIRS) copyDir(path.join(ROOT, d), path.join(DIST, d));
fs.writeFileSync(path.join(DIST, '_headers'), HEADERS);
fs.writeFileSync(path.join(DIST, '_redirects'), REDIRECTS);

/* ── 自己輸出 ZIP ─────────────────────────
   不用 PowerShell 的 Compress-Archive：它把路徑存成反斜線（css\app.css），
   而 ZIP 規格規定必須是正斜線。Cloudflare 之類的上傳器會把它當成
   「檔名含反斜線的根目錄檔」而不是資料夾，結果 css/ 與 js/ 全部 404。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');          // name 一律使用 '/'
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const use = comp.length < data.length ? comp : data;
    const method = use === comp ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // 檔名為 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x2821, 12);       // date（2020-01-01，固定值讓輸出可重現）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(use.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, use);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(use.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + use.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const zip = path.join(ROOT, 'dist.zip');
const entries = [];
(function collect(dir, prefix = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const name = prefix + e.name;
    if (e.isDirectory()) collect(full, name + '/');
    else entries.push({ name, data: fs.readFileSync(full) });
  }
})(DIST);
fs.writeFileSync(zip, makeZip(entries));

const count = (p) => fs.readdirSync(p, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(path.join(p, e.name)) : 1), 0);

console.log(`\n  打包完成\n`);
console.log(`  資料夾  ${DIST}`);
console.log(`  檔案數  ${count(DIST)} 個 · ${(size(DIST) / 1024).toFixed(0)} KB`);
if (fs.existsSync(zip)) console.log(`  壓縮檔  ${zip}（${(fs.statSync(zip).size / 1024).toFixed(0)} KB）`);
console.log(`\n  上傳到 Cloudflare Pages 的既有專案即可沿用原網址。\n`);
