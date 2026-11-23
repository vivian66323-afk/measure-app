// share.js — 分享連結的唯讀檢視頁
//
// 這頁不載入編輯器，只用既有的 rooms / export-svg / report 模組，
// 從伺服器取回專案 JSON 後直接把平面圖與面積表算出來。
import { $, el, fmt, toM2, toPing, setUnit, fmtLen, getUnit } from './util.js';
import { migrate } from './model.js';
import { detectRooms } from './rooms.js';
import { buildSVG } from './export-svg.js';
import { floorSchedule, scheduleTable, scheduleCSV, openingTable } from './report.js';
import { download } from './util.js';

const token = (location.pathname.match(/\/s\/([A-Za-z0-9_-]+)/) || [])[1];
const root = $('#root');

boot();

async function boot() {
  if (!token) return fail('連結格式不正確。');
  let p;
  try {
    const res = await fetch('/api/shared/' + token);
    const data = await res.json();
    if (!res.ok) return fail(data.error || '無法載入');
    p = migrate(data);
  } catch (e) {
    return fail('無法連線到伺服器：' + e.message);
  }
  setUnit(p.unit || 'cm');
  render(p);
}

function fail(msg) {
  root.replaceChildren(el('div', { class: 'sh-loading' },
    el('div', { style: 'font-size:17px;color:#f3efe8;margin-bottom:8px' }, '無法開啟'),
    msg));
}

function render(p) {
  const floors = p.floors.map((f) => {
    const rooms = detectRooms(f);
    return { f, rooms, sch: floorSchedule(f, rooms) };
  });
  // 注意：floorSchedule 回傳的 sum.area 已經是 m²，不要再 toM2()
  const grandM2 = floors.reduce((s, x) => s + x.sch.sum.area, 0);
  const totalRooms = floors.reduce((s, x) => s + x.rooms.length, 0);
  const totalPhotos = p.floors.reduce((s, f) => s + (f.photos?.length || 0), 0);

  const parts = [
    el('div', { class: 'sh-head' },
      el('div', {},
        el('h1', {}, p.name || '丈量成果'),
        el('div', { class: 'meta' },
          [p.client?.name && `業主：${p.client.name}`, p.client?.addr, p.client?.phone]
            .filter(Boolean).join('　·　') || '　',
          el('br'),
          `更新於 ${new Date(p.updatedAt || Date.now()).toLocaleString('zh-TW')}`)),
      el('span', { class: 'sh-badge' }, '唯讀分享'),
    ),
    el('div', { class: 'sh-stats' },
      stat(fmt(grandM2, 2), '室內淨面積 m²'),
      stat(fmt(toPing(grandM2), 2), '折合坪數'),
      stat(String(p.floors.length), '樓層'),
      stat(String(totalRooms), '區域'),
      totalPhotos ? stat(String(totalPhotos), '現場照片') : null,
    ),
  ];

  for (const { f, rooms, sch } of floors) {
    const sec = el('section', { class: 'sh-sec' }, el('h2', {}, `${f.name}　樓高 ${f.height} mm`));
    const plan = el('div', { class: 'sh-plan' });
    plan.innerHTML = buildSVG(f, rooms, { name: p.name, floorName: f.name });
    sec.append(plan);
    if (sch.rows.length) sec.append(el('div', { style: 'margin-top:14px' }, scheduleTable(sch)));
    if (f.openings?.length) {
      sec.append(el('h2', { style: 'margin-top:20px' }, `${f.name} 門窗清單`));
      sec.append(openingTable(f));
    }
    parts.push(sec);
  }

  if (totalPhotos) {
    const sec = el('section', { class: 'sh-sec' }, el('h2', {}, '現場照片'));
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px' });
    let n = 0;
    for (const f of p.floors) {
      for (const ph of f.photos || []) {
        n++;
        const box = el('div', { class: 'sh-photo' },
          el('img', { src: `/api/shared/${token}/photo/${encodeURIComponent(ph.photoId)}`, alt: ph.name || '', loading: 'lazy' }),
          ...(ph.marks || []).map((m) => el('div', { class: 'm', style: `left:${m.x * 100}%;top:${m.y * 100}%` }, m.text)),
        );
        grid.append(el('div', {}, box, el('div', { class: 'sh-cap' }, `${n}. ${f.name}｜${ph.name || '未命名'}`)));
      }
    }
    sec.append(grid);
    parts.push(sec);
  }

  parts.push(el('div', { class: 'sh-noprint', style: 'display:flex;gap:8px;margin-top:30px;flex-wrap:wrap' },
    el('button', { class: 'tb', onclick: () => window.print() }, '列印 / 存成 PDF'),
    el('button', { class: 'tb', onclick: () => download(`${p.name}_面積表.csv`, scheduleCSV(p, floors), 'text/csv;charset=utf-8') }, '下載面積表 CSV'),
  ));
  parts.push(el('div', { style: 'margin-top:26px;color:#5a544b;font-size:11px;text-align:center' },
    `由 丈量APP 產生　·　單位 ${getUnit()}　·　面積為扣除牆體後的室內淨面積`));

  root.replaceChildren(...parts.filter(Boolean));
  document.title = `${p.name || '丈量成果'} — 丈量APP`;
}

const stat = (v, label) => el('div', { class: 'sh-stat' }, el('b', {}, v), el('span', {}, label));
