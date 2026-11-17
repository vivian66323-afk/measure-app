// server.mjs — 零相依的本機靜態伺服器 + 雲端同步 / 分享連結 API
//
//   node server.mjs                  → http://localhost:5173
//   node server.mjs 8080             → 指定埠號
//   node server.mjs --open           → 啟動後自動開瀏覽器
//   node server.mjs --https          → 同目錄有 cert.pem / key.pem 時啟用 HTTPS
//   SYNC_TOKEN=xxx node server.mjs   → 要求同步 API 附帶 Bearer 權杖
//
// 為什麼需要伺服器：Web Bluetooth 只在 https:// 或 http://localhost 下可用，
// 直接用 file:// 開啟 index.html 會無法連線測距儀，也無法註冊 Service Worker。
//
// 資料放在 ./data/：projects/<id>.json、photos/<id>.jpg、shares.json
// 這是「自架雲端」——同步的目的地就是跑這支程式的機器。要真的上雲，
// 把整包部署到任何 Node 主機（或改寫成 Cloudflare Worker + R2）即可。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PROJ = path.join(DATA, 'projects');
const PHOTO = path.join(DATA, 'photos');
const SHARES = path.join(DATA, 'shares.json');

const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const autoOpen = args.includes('--open');
const port = Number(args.find((a) => /^\d+$/.test(a))) || (useHttps ? 5443 : 5173);
const TOKEN = process.env.SYNC_TOKEN || '';
const MAX_BODY = 32 * 1024 * 1024;      // 32 MB，足夠一個含照片的專案

for (const d of [DATA, PROJ, PHOTO]) fs.mkdirSync(d, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.dxf': 'application/dxf',
};

/* ── 小工具 ─────────────────────────── */
/** id 只允許安全字元，擋掉路徑穿越 */
const safeId = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : null);
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => {
    n += c.length;
    if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const authed = (req) => {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (got.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
};

async function loadShares() {
  try { return JSON.parse(await fsp.readFile(SHARES, 'utf8')); } catch { return {}; }
}
async function saveShares(s) {
  await fsp.writeFile(SHARES, JSON.stringify(s, null, 1));
}

/* ── API ────────────────────────────── */
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  const seg = parts.slice(1);

  // 分享連結的讀取端不需要權杖（拿到網址即可看），其餘一律驗證
  const isPublicRead = req.method === 'GET' && seg[0] === 'shared';
  if (!isPublicRead && !authed(req)) return json(res, 401, { error: '需要有效的存取權杖' });

  /* 專案列表 */
  if (seg[0] === 'projects' && seg.length === 1 && req.method === 'GET') {
    const files = await fsp.readdir(PROJ).catch(() => []);
    const list = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const p = JSON.parse(await fsp.readFile(path.join(PROJ, f), 'utf8'));
        const st = await fsp.stat(path.join(PROJ, f));
        list.push({
          id: p.id, name: p.name, floors: p.floors?.length || 0,
          client: p.client?.name || '', updatedAt: p.updatedAt || st.mtimeMs,
          bytes: st.size,
        });
      } catch { /* 壞檔跳過 */ }
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { projects: list });
  }

  /* 單一專案：上傳 / 下載 / 刪除 */
  if (seg[0] === 'projects' && seg.length === 2) {
    const id = safeId(seg[1]);
    if (!id) return json(res, 400, { error: 'bad id' });
    const file = path.join(PROJ, id + '.json');

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!p || p.id !== id) return json(res, 400, { error: 'id 不一致' });
      p.syncedAt = Date.now();
      await fsp.writeFile(file, JSON.stringify(p));
      return json(res, 200, { ok: true, id, syncedAt: p.syncedAt });
    }
    if (req.method === 'GET') {
      try { return json(res, 200, JSON.parse(await fsp.readFile(file, 'utf8'))); }
      catch { return json(res, 404, { error: '雲端沒有這個專案' }); }
    }
    if (req.method === 'DELETE') {
      await fsp.unlink(file).catch(() => {});
      const s = await loadShares();
      for (const [tok, v] of Object.entries(s)) if (v.projectId === id) delete s[tok];
      await saveShares(s);
      return json(res, 200, { ok: true });
    }
  }

  /* 照片：上傳 / 下載 */
  if (seg[0] === 'photos' && seg.length === 2) {
    const id = safeId(seg[1]);
    if (!id) return json(res, 400, { error: 'bad id' });
    const file = path.join(PHOTO, id + '.jpg');
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      await fsp.writeFile(file, body);
      return json(res, 200, { ok: true, bytes: body.length });
    }
    if (req.method === 'HEAD') {
      const ok = fs.existsSync(file);
      res.writeHead(ok ? 200 : 404); return res.end();
    }
  }

  /* 建立分享連結 */
  if (seg[0] === 'share' && seg.length === 2 && req.method === 'POST') {
    const id = safeId(seg[1]);
    if (!id) return json(res, 400, { error: 'bad id' });
    if (!fs.existsSync(path.join(PROJ, id + '.json'))) return json(res, 404, { error: '請先同步專案到雲端' });
    const s = await loadShares();
    let token = Object.keys(s).find((t) => s[t].projectId === id);
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      s[token] = { projectId: id, createdAt: Date.now(), views: 0 };
      await saveShares(s);
    }
    return json(res, 200, { token, url: `/s/${token}` });
  }
  if (seg[0] === 'share' && seg.length === 2 && req.method === 'DELETE') {
    const s = await loadShares();
    for (const [t, v] of Object.entries(s)) if (v.projectId === seg[1]) delete s[t];
    await saveShares(s);
    return json(res, 200, { ok: true });
  }

  /* 分享連結的公開讀取 */
  if (seg[0] === 'shared' && seg.length >= 2 && req.method === 'GET') {
    const token = safeId(seg[1]);
    const s = await loadShares();
    const rec = token && s[token];
    if (!rec) return json(res, 404, { error: '連結無效或已撤銷' });

    if (seg.length === 2) {
      rec.views = (rec.views || 0) + 1;
      rec.lastView = Date.now();
      saveShares(s).catch(() => {});
      try { return json(res, 200, JSON.parse(await fsp.readFile(path.join(PROJ, rec.projectId + '.json'), 'utf8'))); }
      catch { return json(res, 404, { error: '專案已被刪除' }); }
    }
    // /api/shared/<token>/photo/<photoId>
    if (seg[2] === 'photo' && seg[3]) {
      const pid = safeId(seg[3]);
      const f = pid && path.join(PHOTO, pid + '.jpg');
      if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const buf = await fsp.readFile(f);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }
  }

  return json(res, 404, { error: 'no such endpoint' });
}

/* ── 靜態檔 ─────────────────────────── */
function serveStatic(req, res, urlPath) {
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const full = path.join(ROOT, urlPath);
  if (!full.startsWith(ROOT) || full.startsWith(DATA)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 找不到 ' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { res.writeHead(400); return res.end('Bad Request'); }
  const p = decodeURIComponent(url.pathname);

  try {
    if (p.startsWith('/api/')) return await api(req, res, url);
    // 分享頁：只接受 /s/<token> 這一層，token 由前端從網址讀取。
    // 不能用 startsWith('/s/')，否則 /s/js/share.js 之類的請求也會被回成 HTML。
    if (/^\/s\/[A-Za-z0-9_-]+\/?$/.test(p)) return serveStatic(req, res, '/share.html');
    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
}

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

let server;
const proto = useHttps ? 'https' : 'http';
if (useHttps) {
  const cert = path.join(ROOT, 'cert.pem'), key = path.join(ROOT, 'key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    console.error('\n找不到 cert.pem / key.pem。請先在此資料夾用 Git Bash 執行：\n');
    console.error('  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"\n');
    process.exit(1);
  }
  server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler);
} else {
  server = http.createServer(handler);
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  埠號 ${port} 已被占用 — 伺服器可能已經在跑了。`);
    console.error(`  請直接開啟 ${proto}://localhost:${port}\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(port, () => {
  const url = `${proto}://localhost:${port}`;
  console.log(`\n  丈量APP 已啟動\n`);
  console.log(`  本機      ${url}`);
  for (const ip of lanIPs()) console.log(`  區域網路  ${proto}://${ip}:${port}`);
  console.log(`\n  雲端資料  ${DATA}`);
  console.log(`  存取權杖  ${TOKEN ? '已啟用（SYNC_TOKEN）' : '未設定 — 同一網路的人都能同步，公開部署請務必設定 SYNC_TOKEN'}`);
  console.log(`\n  提示：手機要連測距儀必須用 https（見 README「手機上線」段落）。`);
  console.log(`  結束請按 Ctrl+C（或直接關閉此視窗）\n`);
  if (autoOpen) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 手動開即可 */ }
  }
});
