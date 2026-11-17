// store.js — IndexedDB 本機儲存（離線優先，量房現場常無網路）
const DB = '丈量APP';
const VER = 2;
const ST = 'projects';
const KV = 'kv';
const PH = 'photos';   // 現場照片（Blob 另存，不塞進專案 JSON）

let _db = null;
function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ST)) {
        const s = db.createObjectStore(ST, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(PH)) db.createObjectStore(PH, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      _db = req.result;
      // 別的分頁之後升級版本時，先關掉本分頁的連線，避免對方永遠卡在 blocked
      _db.onversionchange = () => { _db.close(); _db = null; };
      res(_db);
    };
    req.onerror = () => rej(req.error);
    // 另一個分頁還開著舊版本時會走到這裡；不處理的話會無限等待
    req.onblocked = () => rej(new Error('資料庫升級被其他分頁擋住，請關閉其他開著本程式的分頁後重新整理。'));
  });
}
function tx(store, mode = 'readonly') {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export async function saveProject(p) {
  p.updatedAt = Date.now();
  const s = await tx(ST, 'readwrite');
  await wrap(s.put(JSON.parse(JSON.stringify(p))));
  return p;
}
export async function getProject(id) {
  const s = await tx(ST);
  return wrap(s.get(id));
}
export async function listProjects() {
  const s = await tx(ST);
  const all = await wrap(s.getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function deleteProject(id) {
  const s = await tx(ST, 'readwrite');
  return wrap(s.delete(id));
}

/* ── 現場照片 ─────────────────────────
   Blob 存在獨立的 object store：專案 JSON 只留 id，
   避免專案資料被幾十 MB 的照片撐爆。 */
export async function savePhoto(rec) {
  const s = await tx(PH, 'readwrite');
  return wrap(s.put(rec));
}
export async function getPhoto(id) {
  const s = await tx(PH);
  return wrap(s.get(id));
}
export async function deletePhoto(id) {
  const s = await tx(PH, 'readwrite');
  return wrap(s.delete(id));
}
export async function photoUsage() {
  const s = await tx(PH);
  const all = await wrap(s.getAll());
  return { count: all.length, bytes: all.reduce((n, r) => n + (r.blob?.size || 0), 0) };
}

export async function kvSet(k, v) {
  const s = await tx(KV, 'readwrite');
  return wrap(s.put(v, k));
}
export async function kvGet(k, dflt = null) {
  try {
    const s = await tx(KV);
    const v = await wrap(s.get(k));
    return v === undefined ? dflt : v;
  } catch { return dflt; }
}

/* localStorage 用於極小的偏好設定（同步讀取，啟動即可用） */
export const pref = {
  get(k, d = null) {
    try { const v = localStorage.getItem('丈量.' + k); return v == null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('丈量.' + k, JSON.stringify(v)); } catch { /* 隱私模式 */ } },
  del(k) { try { localStorage.removeItem('丈量.' + k); } catch { /* noop */ } },
};
