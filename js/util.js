// util.js — DOM 小工具、格式化、事件
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
}

export const uid = (p = 'x') =>
  p + '_' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ── 單位 ────────────────────────────────
   內部一律以 mm 為單位儲存，顯示時再換算。 */
export const UNITS = {
  mm: { label: '公釐 mm', f: 1, dp: 0 },
  cm: { label: '公分 cm', f: 10, dp: 1 },
  m:  { label: '公尺 m',  f: 1000, dp: 3 },
};
let _unit = 'cm';
export const getUnit = () => _unit;
export const setUnit = (u) => { if (UNITS[u]) _unit = u; };

/** mm → 目前單位的數字字串 */
export function fmtLen(mm, unit = _unit) {
  const u = UNITS[unit] || UNITS.cm;
  const v = mm / u.f;
  return v.toFixed(u.dp).replace(/\.?0+$/, (m) => (unit === 'm' ? m : ''));
}
export const fmtLenU = (mm, unit = _unit) => `${fmtLen(mm, unit)} ${unit}`;
/** 使用者輸入 → mm（支援 "350"、"3.5m"、"350cm"、"3500mm"、"3m50"） */
export function parseLen(str, unit = _unit) {
  if (str == null) return NaN;
  const s = String(str).trim().toLowerCase().replace(/[，,\s]/g, '');
  if (!s) return NaN;
  let m;
  if ((m = s.match(/^(-?[\d.]+)m(?:m)?$/))) {
    return s.endsWith('mm') ? +m[1] : +m[1] * 1000;
  }
  if ((m = s.match(/^(-?[\d.]+)cm$/))) return +m[1] * 10;
  if ((m = s.match(/^(-?[\d.]+)m(\d+)$/))) return +m[1] * 1000 + +m[2] * 10; // 3m50 = 3.50 m
  const n = parseFloat(s);
  if (!isFinite(n)) return NaN;
  return n * (UNITS[unit] || UNITS.cm).f;
}
/** mm² → m² */
export const toM2 = (mm2) => mm2 / 1e6;
/** m² → 坪 */
export const toPing = (m2) => m2 / 3.305785;
export const fmt = (n, dp = 2) => (isFinite(n) ? n.toFixed(dp) : '—');

/* ── Toast ───────────────────────────── */
export function toast(msg, kind = '', ms = 2200) {
  const box = $('#toasts');
  if (!box) return;
  const t = el('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, ms);
}

/* ── Modal ───────────────────────────── */
let _modalClose = null;
export function modal({ title, body, footer, size = 'md', onClose }) {
  closeModal();
  const root = $('#modalRoot');
  const x = el('button', { class: 'x', onclick: () => closeModal() }, '×');
  const m = el('div', { class: 'modal ' + size },
    el('header', {}, el('h3', {}, title), x),
    el('div', { class: 'body' }, body),
    footer ? el('footer', {}, footer) : null,
  );
  root.replaceChildren(m);
  root.hidden = false;
  root.onclick = (e) => { if (e.target === root) closeModal(); };
  _modalClose = onClose || null;
  return m;
}
export function closeModal() {
  const root = $('#modalRoot');
  if (!root || root.hidden) return;
  root.hidden = true;
  root.replaceChildren();
  const cb = _modalClose; _modalClose = null;
  cb?.();
}
export const modalOpen = () => !$('#modalRoot').hidden;

/** 簡易確認框（回傳 Promise<boolean>） */
export function confirmBox(title, msg, okLabel = '確定') {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; closeModal(); res(v); };
    modal({
      size: 'sm', title,
      body: el('div', { class: 'note' }, msg),
      footer: [
        el('button', { class: 'tb', onclick: () => fin(false) }, '取消'),
        el('button', { class: 'md-btn', onclick: () => fin(true) }, okLabel),
      ],
      onClose: () => fin(false),
    });
  });
}

/** 檔案下載 */
export function download(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 節流至下一動畫影格 */
export function raf(fn) {
  let q = false, lastArgs;
  return (...a) => {
    lastArgs = a;
    if (q) return;
    q = true;
    requestAnimationFrame(() => { q = false; fn(...lastArgs); });
  };
}

export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
export const ascii = (u8) => [...u8].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
