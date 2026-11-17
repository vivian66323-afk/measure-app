// sync.js — 雲端同步（自架）：專案 JSON + 照片 Blob 上傳／下載、分享連結
import * as DB from './store.js';

const tokenHeader = () => {
  const t = DB.pref.get('sync.token', '');
  return t ? { Authorization: 'Bearer ' + t } : {};
};

async function call(url, opt = {}) {
  const res = await fetch(url, {
    ...opt,
    headers: { ...(opt.headers || {}), ...tokenHeader() },
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const list = () => call('/api/projects').then((r) => r.projects || []);
export const fetchProject = (id) => call('/api/projects/' + encodeURIComponent(id));
export const removeProject = (id) => call('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });

/** 專案裡用到的所有照片 id */
export function photoIdsOf(project) {
  const ids = new Set();
  for (const f of project.floors || []) for (const p of f.photos || []) if (p.photoId) ids.add(p.photoId);
  return [...ids];
}

/**
 * 上傳專案（含尚未上傳的照片）。
 * @param {object} project
 * @param {(msg:string, done:number, total:number)=>void} onProgress
 */
export async function push(project, onProgress = () => {}) {
  const ids = photoIdsOf(project);
  let done = 0;
  const total = ids.length + 1;

  for (const pid of ids) {
    onProgress(`上傳照片 ${done + 1}/${ids.length}`, done, total);
    // 已經在雲端就跳過，避免每次同步都重傳幾十 MB
    const exists = await fetch('/api/photos/' + encodeURIComponent(pid), { method: 'HEAD', headers: tokenHeader() })
      .then((r) => r.ok).catch(() => false);
    if (!exists) {
      const rec = await DB.getPhoto(pid);
      if (rec?.blob) {
        await call('/api/photos/' + encodeURIComponent(pid), {
          method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: rec.blob,
        });
      }
    }
    done++;
  }

  onProgress('上傳專案資料', done, total);
  const r = await call('/api/projects/' + encodeURIComponent(project.id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  });
  onProgress('完成', total, total);
  return r;
}

/** 從雲端取回專案；缺的照片也一併抓回本機 */
export async function pull(id, onProgress = () => {}) {
  onProgress('下載專案資料', 0, 1);
  const p = await fetchProject(id);
  const ids = photoIdsOf(p);
  let done = 0;
  for (const pid of ids) {
    onProgress(`下載照片 ${done + 1}/${ids.length}`, done, ids.length + 1);
    const have = await DB.getPhoto(pid);
    if (!have?.blob) {
      // 用分享端點抓圖（同一份檔案，且不需要權杖也能重用）
      const res = await fetch('/api/photos/' + encodeURIComponent(pid), { headers: tokenHeader() }).catch(() => null);
      if (res?.ok) {
        const blob = await res.blob();
        const thumb = await makeThumb(blob).catch(() => '');
        await DB.savePhoto({ id: pid, blob, thumb, w: 0, h: 0, createdAt: Date.now() });
      }
    }
    done++;
  }
  onProgress('完成', ids.length + 1, ids.length + 1);
  return p;
}

async function makeThumb(blob, edge = 240) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.7);
}

/** 建立（或取回既有的）分享連結 */
export async function share(id) {
  const r = await call('/api/share/' + encodeURIComponent(id), { method: 'POST' });
  return { ...r, full: location.origin + r.url };
}
export const unshare = (id) => call('/api/share/' + encodeURIComponent(id), { method: 'DELETE' });

/**
 * 後端狀態。
 * 這個平台可以部署成純靜態網站（Netlify、GitHub Pages…），那種情況下
 * 沒有 /api，同步與分享連結本來就不會有 —— 要跟「伺服器沒開」分開講，
 * 否則使用者會以為壞了。
 * @returns {'ok'|'auth'|'static'|'offline'}
 */
export async function backendStatus() {
  try {
    const r = await fetch('/api/projects', { headers: tokenHeader() });
    if (r.ok) return 'ok';
    if (r.status === 401) return 'auth';
    return 'static';                    // 404 之類 → 這個網域沒有後端
  } catch {
    return 'offline';                   // 連不上（伺服器沒開 / 斷網）
  }
}
export async function online() {
  const s = await backendStatus();
  return s === 'ok' || s === 'auth';
}
