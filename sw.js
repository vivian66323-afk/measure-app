// sw.js — 離線快取（量房現場常常沒有網路）
const CACHE = '丈量app-v4';
const ASSETS = [
  './', './index.html', './share.html', './manifest.webmanifest', './css/app.css', './img/logo-puyu.png',
  './lib/pdfjs/pdf.min.mjs', './lib/pdfjs/pdf.worker.min.mjs',
  './js/app.js', './js/util.js', './js/geometry.js', './js/model.js', './js/store.js',
  './js/editor.js', './js/rooms.js', './js/ble.js', './js/catalog.js', './js/photos.js',
  './js/fengshui.js', './js/sync.js', './js/share.js', './js/solid.js', './js/wall.js',
  './js/assemble.js',
  './js/export-dxf.js', './js/export-svg.js', './js/export-dae.js',
  './js/report.js', './js/view3d.js', './js/walk3d.js', './js/autodim.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 網路優先、失敗回快取：確保開發時改檔案立即生效，離線時仍可運作
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) return;    // 同步 API 一律走網路，不快取
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
  );
});
