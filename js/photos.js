// photos.js — 現場拍照與照片上標註距離
//
// 量房現場最容易漏掉的是「那面牆的插座在哪、樑有多低、水管走哪」，
// 這些用平面圖畫不出來。做法是：在平面圖上放一個相機標記記錄拍攝位置，
// 照片本身則可以直接點一下 → 按測距儀，把量到的距離標上去。

import * as DB from './store.js';
import { el, uid, toast, modal, closeModal, fmtLen, getUnit, parseLen, download } from './util.js';

const MAX_EDGE = 2000;      // 存檔前縮到最長邊 2000px，現場拍幾十張也不會爆
const THUMB_EDGE = 240;
const JPEG_Q = 0.82;

/** 讀圖 → 縮圖 → 產生主圖 Blob 與縮圖 dataURL */
export async function ingest(file) {
  const bmp = await createImageBitmap(file);
  const draw = (edge) => {
    const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  };
  const main = draw(MAX_EDGE);
  const blob = await new Promise((r) => main.toBlob(r, 'image/jpeg', JPEG_Q));
  const thumb = draw(THUMB_EDGE).toDataURL('image/jpeg', 0.7);
  bmp.close?.();
  return {
    id: uid('img'), blob, thumb,
    w: main.width, h: main.height, createdAt: Date.now(),
  };
}

/** 開啟系統相機／檔案選擇（手機上 capture 會直接叫相機） */
export function pickPhoto() {
  return new Promise((res) => {
    const inp = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    inp.onchange = () => res(inp.files?.[0] || null);
    // 使用者按取消時 change 不會觸發，靠 focus 回來偵測
    window.addEventListener('focus', () => setTimeout(() => { if (!inp.files?.length) res(null); }, 700), { once: true });
    inp.click();
  });
}

const urlCache = new Map();
export async function objectURL(photoId) {
  if (urlCache.has(photoId)) return urlCache.get(photoId);
  const rec = await DB.getPhoto(photoId);
  if (!rec?.blob) return null;
  const u = URL.createObjectURL(rec.blob);
  urlCache.set(photoId, u);
  return u;
}
export function forget(photoId) {
  const u = urlCache.get(photoId);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(photoId); }
}

/**
 * 照片標註檢視器。
 * @param {object} ph        floor.photos 裡的標記物件
 * @param {object} opts      { meter, onChange, title }
 */
export async function openViewer(ph, { meter, onChange, title = '現場照片' } = {}) {
  const url = await objectURL(ph.photoId);
  if (!url) { toast('找不到照片檔', 'bad'); return; }

  let pending = null;          // 使用者剛點的位置（0~1）
  const stage = el('div', { class: 'ph-stage' });
  const img = el('img', { src: url, alt: ph.name || '現場照片' });
  const layer = el('div', { class: 'ph-layer' });
  stage.append(img, layer);

  const hint = el('div', { class: 'note' },
    '點照片上的位置 → 按測距儀（或在下方輸入）→ 距離就標在那個點上。再點一次標記可刪除。');

  const redraw = () => {
    layer.replaceChildren(...ph.marks.map((m, i) => {
      const n = el('button', {
        class: 'ph-mark', style: `left:${m.x * 100}%;top:${m.y * 100}%`,
        title: '點擊刪除',
        onclick: (e) => {
          e.stopPropagation();
          ph.marks.splice(i, 1);
          redraw(); onChange?.();
        },
      }, m.text);
      return n;
    }), pending ? el('div', { class: 'ph-pending', style: `left:${pending.x * 100}%;top:${pending.y * 100}%` }) : null);
    countEl.textContent = `${ph.marks.length} 個標註`;
  };

  stage.onclick = (e) => {
    if (e.target.closest('.ph-mark')) return;
    const r = img.getBoundingClientRect();
    pending = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    pending.x = Math.max(0, Math.min(1, pending.x));
    pending.y = Math.max(0, Math.min(1, pending.y));
    redraw();
    inp.focus();
  };

  const addMark = (text) => {
    if (!pending) { toast('請先點照片上的位置', 'bad'); return; }
    if (!text) return;
    ph.marks.push({ x: pending.x, y: pending.y, text });
    pending = null;
    redraw(); onChange?.();
  };

  const onReading = (e) => addMark(`${fmtLen(e.detail.mm)} ${getUnit()}`);
  meter?.addEventListener('reading', onReading);

  const inp = el('input', { type: 'text', placeholder: `長度 (${getUnit()}) 或任意文字` });
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const mm = parseLen(inp.value);
    addMark(isFinite(mm) && mm > 0 ? `${fmtLen(mm)} ${getUnit()}` : inp.value.trim());
    inp.value = '';
  });
  const countEl = el('span', {}, '0 個標註');

  const nameInp = el('input', { type: 'text', value: ph.name || '', placeholder: '照片說明，例如「主臥西牆插座」' });
  nameInp.addEventListener('change', () => { ph.name = nameInp.value; onChange?.(); });

  modal({
    title, size: 'md',
    body: el('div', {}, hint, stage,
      el('div', { class: 'row', style: 'margin-top:10px' }, nameInp),
      el('div', { class: 'row' }, inp,
        el('button', { class: 'md-btn', onclick: () => { const mm = parseLen(inp.value); addMark(isFinite(mm) && mm > 0 ? `${fmtLen(mm)} ${getUnit()}` : inp.value.trim()); inp.value = ''; } }, '標上去')),
      el('div', { class: 'md-foot' }, countEl, el('span', {}, meter?.status === 'connected' ? '測距儀已連線，按下量測鍵即可標註' : '測距儀未連線，可手動輸入')),
    ),
    footer: [
      el('button', { class: 'tb', onclick: async () => {
        try {
          const b = await exportAnnotated(ph);
          download(`${ph.name || '現場照片'}.jpg`, b, 'image/jpeg');
        } catch (err) { toast('輸出失敗：' + err.message, 'bad'); }
      } }, '下載標註後照片'),
      el('button', { class: 'md-btn', onclick: () => closeModal() }, '完成'),
    ],
    onClose: () => meter?.removeEventListener('reading', onReading),
  });
  redraw();
}

/**
 * 把標註燒進照片，輸出可直接傳給業主／工班的 JPEG。
 * 刻意用 createImageBitmap 直接解碼 Blob，而不是 <img> + decode()：
 * 分頁在背景時 <img> 的 decode() 可能永遠不會 resolve。
 */
export async function exportAnnotated(ph) {
  const rec = await DB.getPhoto(ph.photoId);
  if (!rec?.blob) throw new Error('找不到照片檔');
  const bmp = await createImageBitmap(rec.blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const fs = Math.max(18, Math.round(c.width / 34));
  g.font = `700 ${fs}px system-ui,"Noto Sans TC",sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const m of ph.marks) {
    const x = m.x * c.width, y = m.y * c.height;
    const w = g.measureText(m.text).width + fs * 0.9;
    const h = fs * 1.7;
    g.beginPath();
    g.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    g.fillStyle = 'rgba(232,133,58,.94)'; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(2, fs / 9); g.stroke();
    g.fillStyle = '#fff';
    g.fillText(m.text, x, y + 1);
  }
  if (ph.name) {
    g.font = `600 ${fs}px system-ui,"Noto Sans TC",sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'top';
    const pad = fs * 0.5;
    const tw = g.measureText(ph.name).width;
    g.fillStyle = 'rgba(20,26,34,.75)';
    g.fillRect(pad, pad, tw + pad * 2, fs * 1.8);
    g.fillStyle = '#fff';
    g.fillText(ph.name, pad * 2, pad + fs * 0.4);
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
}
