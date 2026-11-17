// report.js — 面積明細表 / 工程量統計
import * as G from './geometry.js';
import { wallAreaOf } from './rooms.js';
import { el, toM2, toPing, fmt, fmtLen, getUnit } from './util.js';

/** 單層統計 */
export function floorSchedule(floor, rooms) {
  const rows = rooms.map((r) => {
    const m2 = toM2(r.area);
    const wallM2 = toM2(wallAreaOf(r, floor));
    return {
      name: r.name,
      area: m2,
      ping: toPing(m2),
      perim: r.perim,                    // mm
      wall: wallM2,                      // 牆面積（扣門窗）
      ceil: m2,
      skirt: r.perim / 1000,             // 踢腳線長 m（未扣門）
    };
  });
  const sum = rows.reduce((s, r) => ({
    area: s.area + r.area, ping: s.ping + r.ping, perim: s.perim + r.perim,
    wall: s.wall + r.wall, ceil: s.ceil + r.ceil, skirt: s.skirt + r.skirt,
  }), { area: 0, ping: 0, perim: 0, wall: 0, ceil: 0, skirt: 0 });

  const openings = { door: 0, window: 0, opening: 0 };
  for (const o of floor.openings) openings[o.kind] = (openings[o.kind] || 0) + 1;
  let wallLen = 0;
  for (const w of floor.walls) wallLen += G.dist(w.a, w.b);

  return { rows, sum, openings, wallLen, wallCount: floor.walls.length, columns: floor.columns.length, height: floor.height };
}

/** 產生 HTML 表格節點 */
export function scheduleTable(sch) {
  const t = el('table', { class: 'tbl' });
  t.innerHTML = `<thead><tr>
    <th>區域</th><th class="n">淨面積 m²</th><th class="n">坪</th>
    <th class="n">周長 m</th><th class="n">牆面 m²</th><th class="n">天花 m²</th><th class="n">踢腳 m</th>
  </tr></thead>`;
  const tb = el('tbody');
  for (const r of sch.rows) {
    tb.append(el('tr', {},
      el('td', {}, r.name),
      el('td', { class: 'n' }, fmt(r.area, 2)),
      el('td', { class: 'n' }, fmt(r.ping, 2)),
      el('td', { class: 'n' }, fmt(r.perim / 1000, 2)),
      el('td', { class: 'n' }, fmt(r.wall, 2)),
      el('td', { class: 'n' }, fmt(r.ceil, 2)),
      el('td', { class: 'n' }, fmt(r.skirt, 2)),
    ));
  }
  t.append(tb);
  t.append(el('tfoot', {}, el('tr', {},
    el('td', {}, `合計 ${sch.rows.length} 區`),
    el('td', { class: 'n' }, fmt(sch.sum.area, 2)),
    el('td', { class: 'n' }, fmt(sch.sum.ping, 2)),
    el('td', { class: 'n' }, fmt(sch.sum.perim / 1000, 2)),
    el('td', { class: 'n' }, fmt(sch.sum.wall, 2)),
    el('td', { class: 'n' }, fmt(sch.sum.ceil, 2)),
    el('td', { class: 'n' }, fmt(sch.sum.skirt, 2)),
  )));
  return t;
}

/** CSV（含 BOM，Excel 開啟不亂碼） */
export function scheduleCSV(project, all) {
  const L = [];
  L.push(`專案,${project.name}`);
  L.push(`業主,${project.client?.name || ''}`);
  L.push(`地址,${project.client?.addr || ''}`);
  L.push(`匯出時間,${new Date().toLocaleString('zh-TW')}`);
  L.push('');
  for (const { floor, sch } of all) {
    L.push(`【${floor.name}】樓高 ${floor.height} mm`);
    L.push('區域,淨面積(m²),坪,周長(m),牆面(m²),天花(m²),踢腳(m)');
    for (const r of sch.rows) {
      L.push([r.name, fmt(r.area, 2), fmt(r.ping, 2), fmt(r.perim / 1000, 2), fmt(r.wall, 2), fmt(r.ceil, 2), fmt(r.skirt, 2)].join(','));
    }
    L.push(['合計', fmt(sch.sum.area, 2), fmt(sch.sum.ping, 2), fmt(sch.sum.perim / 1000, 2), fmt(sch.sum.wall, 2), fmt(sch.sum.ceil, 2), fmt(sch.sum.skirt, 2)].join(','));
    L.push(`門,${sch.openings.door || 0},窗,${sch.openings.window || 0},開口,${sch.openings.opening || 0},牆總長(m),${fmt(sch.wallLen / 1000, 2)}`);
    L.push('');
  }
  const grand = all.reduce((s, x) => s + x.sch.sum.area, 0);
  L.push(`全案室內淨面積(m²),${fmt(grand, 2)}`);
  L.push(`全案室內淨面積(坪),${fmt(toPing(grand), 2)}`);
  return '﻿' + L.join('\r\n');
}

/** 門窗清單 */
export function openingTable(floor) {
  const t = el('table', { class: 'tbl' });
  t.innerHTML = `<thead><tr><th>編號</th><th>類型</th><th class="n">寬 ${getUnit()}</th><th class="n">高 mm</th><th class="n">窗台 mm</th><th>備註</th></tr></thead>`;
  const tb = el('tbody');
  const kindName = { door: '門', window: '窗', opening: '開口' };
  const cnt = {};
  for (const o of floor.openings) {
    cnt[o.kind] = (cnt[o.kind] || 0) + 1;
    const code = { door: 'M', window: 'C', opening: 'K' }[o.kind] + String(cnt[o.kind]).padStart(2, '0');
    tb.append(el('tr', {},
      el('td', {}, code),
      el('td', {}, kindName[o.kind] || o.kind),
      el('td', { class: 'n' }, fmtLen(o.width)),
      el('td', { class: 'n' }, String(o.height || '')),
      el('td', { class: 'n' }, o.kind === 'window' ? String(o.sill || 0) : '—'),
      el('td', {}, o.label || ''),
    ));
  }
  t.append(tb);
  if (!floor.openings.length) return el('div', { class: 'note' }, '此樓層尚未加入門窗。');
  return t;
}
