// app.js — 應用程式進入點：UI 串接、藍牙、匯出、設定
import { $, $$, el, uid, toast, modal, closeModal, modalOpen, confirmBox, download, fmt, fmtLen, parseLen, getUnit, setUnit, UNITS, toM2, toPing, hex } from './util.js';
import * as G from './geometry.js';
import * as M from './model.js';
import * as DB from './store.js';
import { Editor } from './editor.js';
import { detectRooms } from './rooms.js';
import { SYMBOLS, CATS, listByCat, previewSVG, hasStairParams } from './catalog.js';
import * as PH from './photos.js';
import * as FS from './fengshui.js';
import * as SY from './sync.js';
import { Meter, learnProfile, describeErr } from './ble.js';
import { buildDXF } from './export-dxf.js';
import { buildSVG } from './export-svg.js';
import { buildDAE, buildDAEAll, daeStats } from './export-dae.js';
import { floorSchedule, scheduleTable, scheduleCSV, openingTable } from './report.js';
import { render3d } from './view3d.js';
import { createWalk } from './walk3d.js';

/* ── 啟動 ───────────────────────────── */
const meter = new Meter();
let doc, ed, saveTimer = null;

boot();

async function boot() {
  Meter.migratePrefs();   // 舊版誤把裝置名寫進名稱關鍵字，搬回已知清單
  setUnit(DB.pref.get('unit', 'cm'));
  const lastId = DB.pref.get('lastProject', null);
  let p = lastId ? await DB.getProject(lastId).catch(() => null) : null;
  if (!p) {
    const all = await DB.listProjects().catch(() => []);
    p = all[0] || M.newProject('新專案');
    if (!all.length) await DB.saveProject(p);
  }
  doc = new M.Doc(p);
  setUnit(doc.p.unit || 'cm');
  DB.pref.set('lastProject', doc.p.id);

  ed = new Editor($('#cv'), doc);
  window.ed = ed; window.doc = doc; window.meter = meter;      // 除錯用

  doc.addEventListener('change', () => { markDirty(); ed.recompute(); });
  ed.addEventListener('select', () => { renderInspector(); updateSideBtn(); });
  ed.addEventListener('stats', updateStats);
  ed.addEventListener('coord', updateCoord);
  ed.addEventListener('tool', () => { updateHint(); renderWalkPanel(); updateSideBtn(); });
  ed.addEventListener('walk', () => { renderWalkPanel(); updateSideBtn(); });
  ed.addEventListener('stats', updateSideBtn);
  ed.addEventListener('pending', updateDock);
  ed.addEventListener('photoplace', (e) => capturePhoto(e.detail));
  ed.addEventListener('deleteroom', (e) => confirmRoomDelete(e.detail));
  ed.addEventListener('stats', syncUnderlay);
  ed.addEventListener('pick', (e) => onPick(e.detail));

  ed.gridStep = DB.pref.get('gridStep', 100);
  ed.tracking = DB.pref.get('tracking', true);
  ed.autoDims = DB.pref.get('autoDims', true);
  ed.precision = DB.pref.get('precision', 5);
  ed.addEventListener('polar', () => { $('#stSnap').textContent = polarStatus(); });
  wireTopbar(); wireToolbar(); wireStage(); wireKeys(); wireMeter(); wireDock();
  refreshFloors(); renderInspector(); updateStats(); updateHint(); updateSideBtn();
  $('#projName').value = doc.p.name;
  ed.fit();
  registerSW();
  // 不支援時就先講明白，別讓使用者按了才知道
  const blocked = Meter.blockReason;
  if (blocked) {
    $('#btnBle').dataset.state = 'blocked';
    $('#bleLabel').textContent = blocked.code === 'ios' ? '需 Bluefy' : '不支援';
    $('#btnBle').title = blocked.title;
  }
}

/* ── 儲存 ───────────────────────────── */
function markDirty() {
  $('#stSave').textContent = '未儲存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
async function save() {
  doc.p.unit = getUnit();
  await DB.saveProject(doc.p);
  doc.dirty = false;
  $('#stSave').textContent = '已儲存 ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}
window.addEventListener('beforeunload', (e) => { if (doc?.dirty) { save(); } });

/* ── 頂列 ───────────────────────────── */
function wireTopbar() {
  $('#projName').addEventListener('input', (e) => { doc.p.name = e.target.value; markDirty(); });
  $('#btnProjects').onclick = openProjects;
  $('#floorSel').onchange = (e) => { ed.doc.floorIdx = +e.target.value; ed.select(null); ed.recompute(); ed.fit(); };
  $('#btnFloorAdd').onclick = () => {
    const n = doc.p.floors.length + 1;
    doc.edit('新增樓層', () => doc.p.floors.push(M.newFloor(n + 'F')));
    doc.floorIdx = doc.p.floors.length - 1;
    refreshFloors(); ed.recompute(); ed.fit();
  };
  $('#btnFloorDel').onclick = async () => {
    if (doc.p.floors.length <= 1) return toast('至少需保留一個樓層', 'bad');
    if (!await confirmBox('刪除樓層', `確定刪除「${doc.floor.name}」？此樓層所有圖面都會消失。`, '刪除')) return;
    doc.edit('刪除樓層', () => doc.p.floors.splice(doc.floorIdx, 1));
    doc.floorIdx = 0;
    refreshFloors(); ed.recompute(); ed.fit();
  };
  $('#btnBle').onclick = openBle;
  $('#btnReport').onclick = openReport;
  $('#btnFs').onclick = openFengshui;
  $('#btnCloud').onclick = openCloud;
  $('#btnMenu').onclick = openMoreMenu;
  $('#insClose').onclick = () => $('#inspector').classList.remove('open');
  // 轉向或視窗大小改變時，抽屜／固定面板要跟著切換
  window.addEventListener('resize', () => { renderInspector(); ed.resize(); });
  $('#btn3d').onclick = open3d;
  $('#btnExport').onclick = openExport;
  $('#btnSettings').onclick = openSettings;
}

/** 手機頂列塞不下，次要功能收進這裡 */
function openMoreMenu() {
  const item = (label, sub, fn) => el('button', {
    class: 'excard', style: 'display:flex;align-items:center;gap:12px',
    onclick: () => { closeModal(); setTimeout(fn, 60); },
  }, el('div', {}, el('b', {}, label), el('small', {}, sub)));

  modal({
    size: 'sm', title: '功能選單',
    body: el('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      el('div', { class: 'grp', style: 'margin-bottom:2px' },
        el('h4', {}, `樓層　目前：${doc.floor.name}（共 ${doc.p.floors.length} 層）`),
        el('div', { class: 'row' },
          el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { closeModal(); $('#btnFloorAdd').click(); } }, '＋ 新增樓層'),
          el('button', { class: 'btn-w danger', style: 'margin:0', onclick: () => { closeModal(); $('#btnFloorDel').click(); } }, '－ 刪除本層'),
        )),
      item('面積報表', '各區域淨面積、坪數、牆面與工程量', openReport),
      item('風水評測', '八宅／二十四山，民俗參考', openFengshui),
      item('3D 空間簡圖', '即時體塊模型，可旋轉存圖', open3d),
      item('走動視角', '站進房間裡走一圈，看牆、窗、樑的實際高度感', openWalk),
      item('雲端同步 / 分享', '上傳專案、產生給業主看的連結', openCloud),
      item('匯出', 'DXF / DAE / SVG / PNG / CSV / 列印', openExport),
      item('現場照片', '本專案所有照片與標註', openPhotoGallery),
      item('設定', '單位、吸附精度、語音播報、預設值', openSettings),
      item('操作手勢', '手機／平板的平移、縮放與繪製方式', openGestureHelp),
    ),
    footer: [el('button', { class: 'tb', onclick: () => closeModal() }, '關閉')],
  });
}

function openGestureHelp() {
  const row2 = (g, d) => el('div', { class: 'kv', style: 'padding:8px 0;border-bottom:1px solid #3a3632;align-items:flex-start' },
    el('span', { style: 'color:#f3efe8;font-weight:600;min-width:96px' }, g),
    el('b', { style: 'font-weight:400;color:#b3aa9c;text-align:right;flex:1' }, d));
  modal({
    size: 'sm', title: '操作手勢',
    body: el('div', {},
      el('div', { class: 'note' }, '手指沒有游標，所以「按下」不會馬上畫 —— 放開才算數。這樣捏合縮放時就不會誤畫出一段牆。'),
      el('div', { class: 'grp' },
        el('h4', {}, '畫布'),
        row2('單指輕點', '執行目前工具的動作（下點、選取、放置）'),
        row2('單指拖曳', '平移畫面；若按在圖元上則是移動該圖元'),
        row2('雙指捏合', '縮放，以兩指中心為基準'),
        row2('雙指拖曳', '平移畫面'),
        row2('連點兩下', '結束目前這串繪製'),
      ),
      el('div', { class: 'grp' },
        el('h4', {}, '量房'),
        row2('測距儀', '按量測鍵，數值自動進圖面'),
        row2('↶ 鈕', '退回上一個點（量錯時用）'),
        row2('工具列', '可左右滑動，右邊還有更多工具'),
        row2('屬性面板', '選取圖元後由下方滑出，可下拉關閉'),
      ),
    ),
    footer: [el('button', { class: 'md-btn', onclick: () => closeModal() }, '知道了')],
  });
}

function refreshFloors() {
  const s = $('#floorSel');
  s.replaceChildren(...doc.p.floors.map((f, i) => el('option', { value: i, selected: i === doc.floorIdx }, f.name)));
}

/* ── 工具列 ─────────────────────────── */
function wireToolbar() {
  $$('#toolbar .tool[data-tool]').forEach((b) => {
    b.onclick = () => {
      ed.setTool(b.dataset.tool);
      // 用實際生效的工具反白，而不是被按的那顆 ——
      // 「樑」按下去是放置一支樑然後切回選取，不會停留在樑工具上。
      selectToolBtn(ed.tool);
    };
  });
  $('#btnUndo').onclick = () => { doc.undo(); ed.recompute(); renderInspector(); };
  $('#btnRedo').onclick = () => { doc.redo(); ed.recompute(); renderInspector(); };
  $('#btnDel').onclick = () => ed.deleteSel();
}
function selectToolBtn(name) {
  $$('#toolbar .tool').forEach((x) => x.classList.toggle('active', x.dataset.tool === name));
}

function wireStage() {
  $('#btnZoomIn').onclick = () => ed.zoomAt(ed.W / 2, ed.H / 2, 1.25);
  $('#btnZoomOut').onclick = () => ed.zoomAt(ed.W / 2, ed.H / 2, 1 / 1.25);
  $('#btnFit').onclick = () => ed.fit();
  $('#btnGrid').onclick = (e) => { ed.showGrid = !ed.showGrid; e.currentTarget.classList.toggle('on', ed.showGrid); ed.render(); };
  $('#btnDims').onclick = (e) => {
    ed.autoDims = !ed.autoDims;
    DB.pref.set('autoDims', ed.autoDims);
    e.currentTarget.classList.toggle('on', ed.autoDims);
    ed.render();
  };
  $('#btnDims').classList.toggle('on', ed.autoDims);
  $('#btnOrtho').onclick = (e) => { ed.ortho = !ed.ortho; e.currentTarget.classList.toggle('on', ed.ortho); updateSnapStatus(); };
  $('#btnTrack').onclick = (e) => {
    ed.tracking = !ed.tracking;
    DB.pref.set('tracking', ed.tracking);
    e.currentTarget.classList.toggle('on', ed.tracking);
    if (!ed.tracking) { ed.guides = []; ed.render(); }
    updateSnapStatus();
  };
  $('#btnGrid').classList.toggle('on', ed.showGrid);
  $('#btnOrtho').classList.toggle('on', ed.ortho);
  $('#btnTrack').classList.toggle('on', ed.tracking);
  updateSnapStatus();
}
const polarStatus = () => `正交 ${ed.ortho ? '開' : '關'} · 追蹤 ${ed.tracking ? '開' : '關'}`
  + (ed.polar != null ? ` · 極座標 ${ed.polar.toFixed(1)}°` : '');
function updateSnapStatus() {
  $('#stSnap').textContent = polarStatus();
}

const HINTS = {
  select: '選取模式：點擊圖元編輯；點房間內部可整個空間拖曳，門會自動對接',
  wall: '畫牆：點擊起點 →（測距儀按一下 或 輸入長度）→ 自動接續；Esc 結束',
  walk: '導線量房：點一下起點，之後每按一次測距儀就自動畫一面牆並轉角',
  door: '門：點在牆上放置，預設寬 90 cm',
  window: '窗：點在牆上放置，預設寬 150 cm',
  opening: '開口／垭口：點在牆上放置',
  column: '柱體：點擊放置，於右側面板調整尺寸',
  beam: '樑：拖方形掣點改長度、拉圓形把手旋轉、拖樑身搬移；右側面板可改樑寬與高度',
  item: '家具：右側選構件 → 點擊放置。靠近牆會自動貼齊並轉正',
  photo: '現場拍照：先點圖面上「你站的位置」，接著開相機拍照',
  dim: '手動標註：點兩個點',
  text: '註記：點擊位置後輸入文字',
  room: '房間命名：點在已封閉的房間內',
};
function updateHint() { $('#hintChip').textContent = HINTS[ed.tool] || ''; }

/* ── 鍵盤 ───────────────────────────── */
const KEYMAP = { v: 'select', w: 'wall', g: 'walk', d: 'door', n: 'window', o: 'opening', c: 'column', b: 'beam', f: 'item', p: 'photo', m: 'dim', t: 'text', r: 'room' };
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.key === 'Escape') { if (modalOpen()) closeModal(); else ed.cancel(); return; }
    if (modalOpen()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doc.redo() : doc.undo(); ed.recompute(); renderInspector(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doc.redo(); ed.recompute(); renderInspector(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); toast('已儲存', 'ok'); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // 繪製中：Backspace 退回上一個點；否則才是刪除選取的圖元
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (ed.walk || ed.draft || ed.chain.length) ed.undoPoint();
      else ed.deleteSel();
      renderInspector();
      return;
    }
    if (e.key === 'Delete') { e.preventDefault(); ed.deleteSel(); return; }
    if (e.key === 'F8') { e.preventDefault(); $('#btnOrtho').click(); return; }
    if (e.key === 'F9') { e.preventDefault(); $('#btnTrack').click(); return; }
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) { ed.setTool(KEYMAP[k]); selectToolBtn(ed.tool); return; }
    if (k === '0') ed.fit();
    if (k === '+' || k === '=') ed.zoomAt(ed.W / 2, ed.H / 2, 1.25);
    if (k === '-') ed.zoomAt(ed.W / 2, ed.H / 2, 1 / 1.25);
    if (k === ' ') { e.preventDefault(); ed.walk && ed.walkTurn(ed.walk.turn < 0 ? 90 : -90); }
  });
}

/* ── 狀態列 ─────────────────────────── */
function updateCoord() {
  $('#stCoord').textContent = `X ${fmtLen(ed.mouse.x)} · Y ${fmtLen(ed.mouse.y)} ${getUnit()}`;
  const denom = 1 / (ed.scale * 0.2646);
  $('#stScale').textContent = '約 1:' + Math.round(denom);
}
function updateStats() {
  const s = doc.stats(ed.rooms);
  const m2 = toM2(s.area);
  $('#stStats').textContent = `牆 ${s.wallCount} · 房間 ${s.roomCount} · 淨面積 ${fmt(m2, 2)} m² (${fmt(toPing(m2), 2)} 坪)`;
}

/* ── 量測面板 ───────────────────────── */
function wireDock() {
  const inp = $('#mdInput');
  inp.placeholder = `輸入長度 (${getUnit()})`;
  const apply = () => {
    // 輸入框空白時套用目前的讀數 —— 串流機種要重複套用同一個數值時就靠這個
    const mm = inp.value.trim() ? parseLen(inp.value) : (meter.live ?? meter.lastMm);
    if (!(mm > 0)) return toast('請先量測或輸入長度', 'bad');
    ed.applyMeasure(mm);
    inp.value = '';
    inp.blur();
  };
  $('#mdApply').onclick = apply;
  $('#mdBack').onclick = () => { ed.undoPoint(); renderInspector(); updateSideBtn(); };
  $('#mdSide').onclick = () => {
    const v = ed.flipSide();
    updateSideBtn(); renderInspector();
    toast(`牆體改為${v < 0 ? '靠下' : '靠上'}`, 'ok');
  };
  $('#mdDel').onclick = () => { ed.deleteSel(); renderInspector(); updateSideBtn(); };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
    // 輸入框空的時候按倒退鍵 = 退回上一個點，量錯時不用把手移開鍵盤
    if (e.key === 'Backspace' && !inp.value) { e.preventDefault(); ed.undoPoint(); renderInspector(); }
  });
  $('#mdAuto').checked = DB.pref.get('autoApply', true);
  $('#mdAuto').onchange = (e) => DB.pref.set('autoApply', e.target.checked);
}
function updateDock() {
  const p = ed.pendingMm;
  $('#mdCount').textContent = p ? `待用 ${fmtLen(p)} ${getUnit()}` : `已測 ${meter.count} 筆`;
}

/** 量測面板上的「靠上／靠下」鈕，隨目前繪製狀態更新 */
function updateSideBtn() {
  const off = ed.currentOff();
  const btn = $('#mdSide');
  btn.classList.toggle('mixed', off === null);
  btn.querySelector('.ms-ico').textContent = off === null ? '⬔' : (off < 0 ? '⬓' : '⬒');
  $('#mdSideLabel').textContent = off === null ? '混用' : (off < 0 ? '靠下' : '靠上');
  btn.title = ed.sel?.kind === 'wall' ? '切換選取那面牆的牆線側邊'
    : ed.chain.length ? '切換這一串牆的牆線側邊，並成為之後的預設'
      : '切換之後新畫的牆的牆線側邊';
  // 刪除鈕：有選取才亮起
  $('#mdDel').classList.toggle('off', !ed.sel);
}

/* ── 導線量房浮動控制 ─────────────────── */
let walkPanel = null;
function renderWalkPanel() {
  if (!ed.walk) { walkPanel?.remove(); walkPanel = null; return; }
  if (!walkPanel) {
    // 獨立 class：行動版的量測列已改成靜態列，不能沿用它的定位
    walkPanel = el('div', { class: 'measure-dock walk-dock' });
    $('.stage').append(walkPanel);
  }
  const w = ed.walk;
  walkPanel.replaceChildren(
    el('div', { class: 'md-head' }, el('span', { class: 'md-title' }, '導線量房'), el('span', { class: 'md-live', style: 'font-size:15px' }, `第 ${w.count + 1} 面`)),
    el('div', { class: 'row' },
      el('div', { class: 'seg' },
        el('button', { class: w.turn > 0 ? 'on' : '', onclick: () => ed.walkTurn(90) }, '左轉 90°'),
        el('button', { class: w.turn < 0 ? 'on' : '', onclick: () => ed.walkTurn(-90) }, '右轉 90°'),
      )),
    el('div', { class: 'row' },
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => ed.walkRotate(-15) }, '↻ 微調 −15°'),
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => ed.walkRotate(15) }, '↺ 微調 +15°'),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => ed.walkUndo() }, '退回一面'),
      el('button', { class: 'btn-w primary', style: 'margin:0', onclick: () => { ed.walk = null; renderWalkPanel(); ed.render(); } }, '結束'),
    ),
    el('div', { class: 'md-foot' }, el('span', {}, '按測距儀或輸入長度即新增一面牆')),
  );
}

/* ── 屬性面板 ───────────────────────── */
function row(label, ...kids) { return el('div', { class: 'row' }, el('label', {}, label), ...kids); }
function numInput(val, onChange, step = 1) {
  const i = el('input', { type: 'text', value: val });
  const fire = () => onChange(i.value);
  i.addEventListener('change', fire);
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { fire(); i.blur(); } });
  return i;
}

/** 面板是否為滑出／抽屜形式（平板與手機） */
const isDrawer = () => window.innerWidth <= 1100;

function renderInspector() {
  const panel = $('#inspector');
  const box = $('#insBody');
  const sel = ed.sel;
  // 抽屜版面下，只有真的有東西要看時才自動彈出，免得擋住畫布
  if (isDrawer()) panel.classList.toggle('open', !!sel || ed.tool === 'item');
  else panel.classList.remove('open');

  if (!sel) {
    box.replaceChildren(ed.tool === 'item' ? catalogPanel()
      : ['wall', 'walk'].includes(ed.tool) ? el('div', {}, floorPanel(), polarGroup())
        : floorPanel());
    return;
  }
  const e = ed.entity(sel);
  if (!e) { box.replaceChildren(el('div', { class: 'ins-empty' }, '圖元已不存在')); return; }
  const map = { wall: wallPanel, opening: openingPanel, column: columnPanel, beam: beamPanel, item: itemPanel, photo: photoPanel, dim: dimPanel, text: textPanel, room: roomPanel };
  box.replaceChildren(map[sel.kind] ? map[sel.kind](e) : el('div', { class: 'ins-empty' }, '—'));
}

/* ── 現場拍照 ───────────────────────── */
async function capturePhoto({ x, y }) {
  const file = await PH.pickPhoto();
  if (!file) return;
  toast('照片處理中…');
  try {
    const rec = await PH.ingest(file);
    await DB.savePhoto(rec);
    const marker = M.newPhoto(rec.id, x, y);
    doc.edit('新增現場照片', () => doc.photos.push(marker));
    ed.recompute();
    ed.setTool('select'); selectToolBtn('select');
    ed.select({ kind: 'photo', id: marker.id });
    PH.openViewer(marker, { meter, onChange: () => { doc.commit('照片標註'); ed.recompute(); renderInspector(); }, title: `現場照片 ${doc.photos.length}` });
  } catch (err) {
    toast('照片讀取失敗：' + err.message, 'bad', 4000);
  }
}

function photoPanel(ph) {
  const idx = doc.photos.indexOf(ph) + 1;
  const thumb = el('img', { class: 'ph-thumb', alt: ph.name || '現場照片' });
  DB.getPhoto(ph.photoId).then((r) => { if (r?.thumb) thumb.src = r.thumb; });
  return el('div', {},
    head(ph.name || `現場照片 ${idx}`, `${ph.marks?.length || 0} 標註`),
    thumb,
    el('button', { class: 'btn-w primary', onclick: () => PH.openViewer(ph, { meter, onChange: () => { doc.commit('照片標註'); ed.recompute(); renderInspector(); }, title: ph.name || `現場照片 ${idx}` }) }, '開啟標註'),
    el('div', { class: 'grp' },
      el('h4', {}, '資訊'),
      row('說明', numInput(ph.name || '', (v) => upd(() => { ph.name = v; }, '照片說明'))),
      row('視角', numInput(G.deg(ph.dir || 0).toFixed(0), (v) => { const n = parseFloat(v); if (isFinite(n)) upd(() => { ph.dir = G.rad(n); }, '視角'); }), el('span', { class: 'unit' }, '°')),
      el('div', { class: 'row' },
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => upd(() => { ph.dir = G.normAngle((ph.dir || 0) + Math.PI / 4); }, '視角') }, '↺ 45°'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => upd(() => { ph.dir = G.normAngle((ph.dir || 0) - Math.PI / 4); }, '視角') }, '↻ 45°'),
      ),
    ),
    el('button', { class: 'btn-w danger', onclick: async () => {
      if (!await confirmBox('刪除照片', '照片與其標註都會刪除，無法復原。', '刪除')) return;
      PH.forget(ph.photoId);
      await DB.deletePhoto(ph.photoId);
      ed.deleteSel();
    } }, '刪除照片'),
  );
}

/** 全案照片總覽 */
async function openPhotoGallery() {
  const grid = el('div', { class: 'ph-grid' });
  const all = [];
  for (const f of doc.p.floors) for (const ph of f.photos || []) all.push({ f, ph });
  if (!all.length) grid.append(el('div', { class: 'note' }, '尚未拍攝現場照片。切到「拍照」工具，先點圖面上你站的位置即可開相機。'));
  for (const { f, ph } of all) {
    const card = el('button', { class: 'ph-card', onclick: () => PH.openViewer(ph, { meter, onChange: () => doc.commit('照片標註'), title: ph.name || '現場照片' }) },
      el('img', { alt: ph.name || '' }),
      el('small', {}, `${f.name}｜${ph.name || '未命名'}${ph.marks?.length ? ` · ${ph.marks.length} 標註` : ''}`));
    DB.getPhoto(ph.photoId).then((r) => { if (r?.thumb) card.querySelector('img').src = r.thumb; });
    grid.append(card);
  }
  const usage = await DB.photoUsage();
  modal({
    title: '現場照片', size: 'md',
    body: el('div', {},
      el('div', { class: 'note' }, `共 ${all.length} 張，占用約 ${(usage.bytes / 1048576).toFixed(1)} MB。照片存在本機，不會上傳。`),
      grid),
    footer: [el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉')],
  });
}

/* ── 家具圖庫 ───────────────────────── */
let catCur = CATS[0];
function catalogPanel() {
  const grid = el('div', { class: 'cat-grid' });
  const fill = () => {
    grid.replaceChildren(...listByCat(catCur).map((d) => el('button', {
      class: 'cat-item' + (d.key === ed.itemType ? ' on' : ''),
      title: `${d.name}  ${d.w}×${d.h} mm`,
      onclick: () => { ed.itemType = d.key; fill(); toast(`已選「${d.name}」，點擊圖面放置`, ''); },
    },
      el('div', { class: 'cat-pv', html: previewSVG(d.key, 46) }),
      el('span', {}, d.name),
    )));
  };
  fill();
  const tabs = el('div', { class: 'cat-tabs' }, ...CATS.map((c) => el('button', {
    class: c === catCur ? 'on' : '',
    onclick: () => { catCur = c; $$('.cat-tabs button').forEach((b) => b.classList.toggle('on', b.textContent === c)); fill(); },
  }, c)));

  return el('div', {},
    head('家具／構件', `${Object.keys(SYMBOLS).length} 種`),
    tabs, grid,
    el('div', { class: 'note', style: 'margin-top:10px' },
      '點選構件後在圖面上點一下即可放置。<b>靠近牆會自動貼齊並轉正</b>；選取後可拖曳移動、拉上方圓點旋轉。'.replace(/<b>/g, '').replace(/<\/b>/g, '')),
  );
}

/** 樓梯專屬：階數、梯段寬，並即時換算級高與踏面深 */
function stairGroup(it, def) {
  const n = it.steps ?? def.steps;
  const H = doc.floor.height || 2800;
  const riser = H / n;                       // 級高＝樓高 ÷ 階數
  const isL = it.type === 'stairL';
  const isU = it.type === 'stairU';
  // 一字梯的踏面深＝長度÷階數；L/U 型要扣掉平台
  const runLen = isU ? it.h - (it.runW ?? def.runW) : isL ? (it.h - (it.runW ?? def.runW)) + (it.w - (it.runW ?? def.runW)) : it.h;
  const tread = runLen / n;

  const warn = riser < 150 || riser > 210 || tread < 240;
  return el('div', { class: 'grp' },
    el('h4', {}, '梯段'),
    row('階數', numInput(n, (v) => { const k = Math.round(parseFloat(v)); if (k >= 2) upd(() => { it.steps = k; }, '階數'); }), el('span', { class: 'unit' }, '階')),
    (isL || isU) ? row('梯段寬', numInput(it.runW ?? def.runW, (v) => { const k = parseFloat(v); if (k > 100) upd(() => { it.runW = k; }, '梯段寬'); }), el('span', { class: 'unit' }, 'mm')) : null,
    el('div', { class: 'kv' }, el('span', {}, '級高（樓高÷階數）'), el('b', { style: warn ? 'color:#ffd591' : '' }, `${fmt(riser, 0)} mm`)),
    el('div', { class: 'kv' }, el('span', {}, '踏面深'), el('b', { style: warn ? 'color:#ffd591' : '' }, `${fmt(tread, 0)} mm`)),
    el('div', { class: 'md-foot' }, el('span', {},
      warn ? '⚠ 一般住宅級高約 150–200 mm、踏面深 ≥ 240 mm，目前超出常見範圍。'
        : '級高依本層樓高自動換算。改樓高或階數都會即時更新。')),
  );
}

function itemPanel(it) {
  const def = SYMBOLS[it.type];
  const isStair = hasStairParams(it.type);
  return el('div', {},
    head(it.label || def?.name || '構件', def?.cat || ''),
    el('div', { class: 'grp' },
      el('h4', {}, '尺寸'),
      row(isStair ? '寬度' : '寬', numInput(it.w, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { it.w = n; }, '構件寬'); }), el('span', { class: 'unit' }, 'mm')),
      row(isStair ? '長度' : '深', numInput(it.h, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { it.h = n; }, '構件深'); }), el('span', { class: 'unit' }, 'mm')),
      isStair ? null : row('高', numInput(it.h3d, (v) => { const n = parseFloat(v); if (n >= 0) upd(() => { it.h3d = n; }, '構件高'); }), el('span', { class: 'unit' }, 'mm')),
      it.z != null ? row('離地高', numInput(it.z, (v) => { const n = parseFloat(v); if (n >= 0) upd(() => { it.z = n; }, '離地高'); }), el('span', { class: 'unit' }, 'mm')) : null,
      def ? el('button', { class: 'btn-w', onclick: () => upd(() => { it.w = def.w; it.h = def.h; it.h3d = def.h3d; if (def.z != null) it.z = def.z; if (isStair) { it.steps = def.steps; it.runW = def.runW; } }, '還原尺寸') }, '還原預設尺寸') : null,
    ),
    isStair ? stairGroup(it, def) : null,
    el('div', { class: 'grp' },
      el('h4', {}, '方向'),
      row('角度', numInput(G.deg(it.rot || 0).toFixed(1), (v) => { const n = parseFloat(v); if (isFinite(n)) upd(() => { it.rot = G.rad(n); }, '旋轉'); }), el('span', { class: 'unit' }, '°')),
      el('div', { class: 'row' },
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => upd(() => { it.rot = G.normAngle((it.rot || 0) + Math.PI / 2); }, '旋轉') }, '↺ 90°'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => upd(() => { it.rot = G.normAngle((it.rot || 0) - Math.PI / 2); }, '旋轉') }, '↻ 90°'),
      ),
      el('button', { class: 'btn-w', onclick: () => { doc.begin(); ed.snapItemToWall(it, { x: it.x, y: it.y }, 3000) ? doc.commit('貼牆') : (doc.commit(''), toast('附近沒有牆', 'bad')); ed.recompute(); renderInspector(); } }, '貼齊最近的牆'),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '標示'),
      row('名稱', numInput(it.label || '', (v) => upd(() => { it.label = v; }, '名稱'))),
      el('div', { class: 'row' },
        el('label', {}, '顯示標籤'),
        el('input', { type: 'checkbox', checked: it.showLabel !== false, onchange: (e) => upd(() => { it.showLabel = e.target.checked; }, '標籤') }),
      ),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '位置 (mm)'),
      el('div', { class: 'kv' }, el('span', {}, '中心'), el('b', {}, `${it.x.toFixed(0)}, ${it.y.toFixed(0)}`)),
    ),
    el('button', { class: 'btn-w', onclick: () => {
      const c = { ...it, id: uid('it'), x: it.x + 300, y: it.y - 300 };
      doc.edit('複製構件', () => doc.items.push(c));
      ed.recompute(); ed.select({ kind: 'item', id: c.id });
    } }, '複製一份'),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除構件'),
  );
}

function head(title, tag) {
  return el('div', { class: 'ins-h' }, title, tag ? el('span', { class: 'tag' }, tag) : null);
}
const upd = (fn, label = '編輯') => { doc.edit(label, fn); ed.recompute(); renderInspector(); };

function floorPanel() {
  const f = doc.floor;
  const sch = floorSchedule(f, ed.rooms);
  return el('div', {},
    head('樓層資訊', f.name),
    el('div', { class: 'grp' },
      el('h4', {}, '基本'),
      row('名稱', numInput(f.name, (v) => upd(() => { f.name = v || f.name; refreshFloors(); }, '樓層命名'))),
      row('樓高', numInput(f.height, (v) => { const mm = parseFloat(v); if (mm > 0) upd(() => { f.height = mm; }, '樓高'); }), el('span', { class: 'unit' }, 'mm')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '本層統計'),
      el('div', { class: 'kv' }, el('span', {}, '房間數'), el('b', {}, String(sch.rows.length))),
      el('div', { class: 'kv' }, el('span', {}, '室內淨面積'), el('b', {}, `${fmt(sch.sum.area, 2)} m²`)),
      el('div', { class: 'kv' }, el('span', {}, '折合坪數'), el('b', {}, `${fmt(sch.sum.ping, 2)} 坪`)),
      el('div', { class: 'kv' }, el('span', {}, '牆總長'), el('b', {}, `${fmt(sch.wallLen / 1000, 2)} m`)),
      el('div', { class: 'kv' }, el('span', {}, '門 / 窗 / 開口'), el('b', {}, `${sch.openings.door || 0} / ${sch.openings.window || 0} / ${sch.openings.opening || 0}`)),
      el('div', { class: 'kv' }, el('span', {}, '柱體'), el('b', {}, String(sch.columns))),
      el('div', { class: 'kv' }, el('span', {}, '家具構件'), el('b', {}, String(f.items?.length || 0))),
      el('div', { class: 'kv' }, el('span', {}, '現場照片'), el('b', {}, String(f.photos?.length || 0))),
    ),
    underlayGroup(),
    el('div', { class: 'grp' },
      el('h4', {}, '業主資料'),
      row('姓名', numInput(doc.p.client.name, (v) => { doc.p.client.name = v; markDirty(); })),
      row('電話', numInput(doc.p.client.phone, (v) => { doc.p.client.phone = v; markDirty(); })),
      row('地址', numInput(doc.p.client.addr, (v) => { doc.p.client.addr = v; markDirty(); })),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '整層調整'),
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => mirrorFloor('x') }, '↔ 左右鏡像翻轉'),
      el('button', { class: 'btn-w', onclick: () => mirrorFloor('y') }, '↕ 上下鏡像翻轉'),
    ),
    el('button', { class: 'btn-w', onclick: openReport }, '開啟面積報表'),
    el('button', { class: 'btn-w', onclick: openPhotoGallery }, '現場照片總覽'),
  );
}

/* ── 臨摹底圖 ─────────────────────────
   把建商平面圖、舊圖或手繪草圖的照片墊在圖面下方照著描。
   圖檔跟現場照片放同一個 store，樓層只記 id、位置與寬度（mm）。 */
async function syncUnderlay() {
  const id = doc.floor.underlay?.photoId || null;
  if (id === ed.underlayFor) return;
  ed.underlayFor = id; ed.underlayImg = null;
  if (!id) { ed.render(); return; }
  const url = await PH.objectURL(id);
  if (!url || ed.underlayFor !== id) return;
  const img = new Image();
  img.onload = () => { if (ed.underlayFor === id) { ed.underlayImg = img; ed.render(); } };
  img.src = url;
}

function pickImageFile() {
  return new Promise((res) => {
    const inp = el('input', { type: 'file', accept: 'image/*' });
    inp.onchange = () => res(inp.files?.[0] || null);
    inp.click();
  });
}

async function importUnderlay() {
  const file = await pickImageFile();
  if (!file) return;
  let rec;
  try { rec = await PH.ingest(file); } catch { return toast('這個檔案讀不出來，請改用 JPG 或 PNG 圖片', 'bad', 3500); }
  await DB.savePhoto(rec);
  // 先擺在目前畫面正中央、佔六成寬；真正的大小靠「校正比例」決定
  const c = ed.toModel(ed.W / 2, ed.H / 2);
  const w = ed.mm(ed.W * 0.6);
  upd(() => {
    doc.floor.underlay = { photoId: rec.id, cx: c.x, cy: c.y, w, ratio: rec.h / rec.w, opacity: 0.5, visible: true };
  }, '匯入底圖');
  toast('底圖已匯入。下一步請按「校正比例」，在圖上點一段已知長度', 'ok', 4500);
}

function startUnderlayPick(kind) {
  $('#inspector').classList.remove('open');
  ed.startPick(kind);
  $('#hintChip').textContent = kind === 'calib'
    ? '校正比例：在底圖上點一段已知長度的兩端（例如一面牆的頭尾）；右鍵或 Esc 取消'
    : '移動底圖：先點底圖上的一個點，再點它應該在的位置；右鍵或 Esc 取消';
}

function onPick(pk) {
  updateHint();
  const u = doc.floor.underlay;
  if (!pk || !u) return;
  const [p1, p2] = pk.pts;
  if (pk.kind === 'move') {
    upd(() => { u.cx += p2.x - p1.x; u.cy += p2.y - p1.y; }, '移動底圖');
    return;
  }
  const d = G.dist(p1, p2);
  if (d < 1) return toast('兩個點太近了，請重新點', 'bad');
  const inp = el('input', { inputmode: 'decimal', placeholder: `實際長度 (${getUnit()})`, style: 'width:100%;height:40px;font-size:16px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg3)' });
  const apply = () => {
    const real = parseLen(inp.value);
    if (!(real > 0)) return toast('請輸入這一段的實際長度', 'bad');
    const k = real / d;
    closeModal();
    // 以第一個點為基準放大縮小，點過的那個位置不會跑掉
    upd(() => { u.w *= k; u.cx = p1.x + (u.cx - p1.x) * k; u.cy = p1.y + (u.cy - p1.y) * k; }, '校正底圖比例');
    ed.fit();
    toast('比例已校正，可以照著底圖畫牆了', 'ok', 3000);
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  modal({
    size: 'sm', title: '校正底圖比例',
    body: el('div', {},
      el('div', { class: 'note', style: 'margin-bottom:10px' }, '剛剛點的那一段，實際上是多長？'),
      inp),
    footer: [
      el('button', { class: 'tb', onclick: () => closeModal() }, '取消'),
      el('button', { class: 'md-btn', onclick: apply }, '套用'),
    ],
  });
  setTimeout(() => inp.focus(), 60);
}

function underlayGroup() {
  const u = doc.floor.underlay;
  if (!u) {
    return el('div', { class: 'grp' },
      el('h4', {}, '臨摹底圖'),
      el('button', { class: 'btn-w', style: 'margin:0', onclick: importUnderlay }, '匯入底圖照著描'),
      el('div', { class: 'md-foot' }, el('span', {}, '建商平面圖、舊圖或手繪草圖的照片都可以。匯入後墊在圖面下方，校正比例就能照著畫牆。')),
    );
  }
  const op = el('input', { type: 'range', min: 10, max: 100, step: 5, value: Math.round((u.opacity ?? 0.5) * 100), style: 'flex:1' });
  op.oninput = () => { u.opacity = op.value / 100; ed.render(); markDirty(); };
  return el('div', { class: 'grp' },
    el('h4', {}, '臨摹底圖'),
    el('div', { class: 'row' },
      el('label', {}, '顯示'),
      el('input', { type: 'checkbox', checked: u.visible !== false, onchange: (e) => { u.visible = e.target.checked; ed.render(); markDirty(); } })),
    el('div', { class: 'row' }, el('label', {}, '透明度'), op),
    el('div', { class: 'kv' }, el('span', {}, '圖面寬度'), el('b', {}, `${fmtLen(u.w)} ${getUnit()}`)),
    el('button', { class: 'btn-w', onclick: () => startUnderlayPick('calib') }, '校正比例（點兩點＋輸入長度）'),
    el('button', { class: 'btn-w', onclick: () => startUnderlayPick('move') }, '移動底圖（點兩點）'),
    el('div', { class: 'row' },
      el('button', { class: 'btn-w', style: 'margin:0', onclick: importUnderlay }, '更換'),
      el('button', { class: 'btn-w danger', style: 'margin:0', onclick: () => upd(() => { delete doc.floor.underlay; }, '移除底圖') }, '移除'),
    ),
  );
}

/** 整層鏡像翻轉 — 同一棟的鏡像戶型只要量一戶，另一戶翻過來即可 */
function mirrorFloor(axis) {
  const f = doc.floor;
  const k = axis === 'x' ? 'x' : 'y';
  doc.edit('鏡像翻轉', () => {
    for (const w of f.walls) { w.a[k] = -w.a[k]; w.b[k] = -w.b[k]; }
    for (const c of f.columns) { c[k] = -c[k]; c.rot = -(c.rot || 0); }
    for (const bm of f.beams || []) { bm.a[k] = -bm.a[k]; bm.b[k] = -bm.b[k]; }
    for (const d of f.dims) { d.a[k] = -d.a[k]; d.b[k] = -d.b[k]; d.off = -d.off; }
    for (const t of f.texts) t[k] = -t[k];
    for (const l of f.roomLabels) l[k] = -l[k];
    // 反射會保留「距牆起點的距離」，但門的開向側會左右對調
    for (const o of f.openings) if (o.kind === 'door') o.flip = !o.flip;
  });
  ed.recompute(); ed.fit(); renderInspector();
  toast('已鏡像翻轉', 'ok');
}

function wallPanel(w) {
  const L = G.dist(w.a, w.b);
  const ang = G.deg(G.angleOf(G.sub(w.b, w.a)));
  return el('div', {},
    head('牆體', w.type === 'exterior' ? '外牆' : '內牆'),
    el('div', { class: 'grp' },
      el('h4', {}, '尺寸'),
      row('長度', numInput(fmtLen(L), (v) => {
        const mm = parseLen(v);
        if (mm > 0) upd(() => { const d = G.norm(G.sub(w.b, w.a)); w.b = G.add(w.a, G.mul(d, mm)); }, '牆長');
      }), el('span', { class: 'unit' }, getUnit())),
      row('厚度', numInput(w.thickness, (v) => { const mm = parseFloat(v); if (mm > 0) upd(() => { w.thickness = mm; }, '牆厚'); }), el('span', { class: 'unit' }, 'mm')),
      row('角度', numInput(ang.toFixed(1), (v) => {
        const a = parseFloat(v);
        if (isFinite(a)) upd(() => { w.b = G.add(w.a, { x: Math.cos(G.rad(a)) * L, y: Math.sin(G.rad(a)) * L }); }, '牆角度');
      }), el('span', { class: 'unit' }, '°')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '類型'),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        el('button', { class: w.type === 'exterior' ? 'on' : '', onclick: () => upd(() => { w.type = 'exterior'; }, '牆類型') }, '外牆'),
        el('button', { class: w.type === 'interior' ? 'on' : '', onclick: () => upd(() => { w.type = 'interior'; }, '牆類型') }, '內牆'),
      )),
      el('div', { class: 'md-foot' }, el('span', {}, '只影響顯示顏色與 CAD 圖層，厚度請直接在上方調整。')),
    ),
    wallOffGroup(w),
    el('div', { class: 'grp' },
      el('h4', {}, '座標 (mm)'),
      el('div', { class: 'kv' }, el('span', {}, '起點'), el('b', {}, `${w.a.x.toFixed(0)}, ${w.a.y.toFixed(0)}`)),
      el('div', { class: 'kv' }, el('span', {}, '終點'), el('b', {}, `${w.b.x.toFixed(0)}, ${w.b.y.toFixed(0)}`)),
      el('div', { class: 'kv' }, el('span', {}, '牆上開口'), el('b', {}, String(doc.openingsOf(w.id).length))),
    ),
    el('button', { class: 'btn-w', onclick: () => upd(() => { const t = w.a; w.a = w.b; w.b = t; }, '反向') }, '起訖反向'),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除這面牆'),
  );
}

/**
 * 牆線位置。量房用測距儀量到的是室內淨尺寸，不是中心線 ——
 * 把牆線設在內側面，量多少就畫多少，房間淨面積才會等於實測值。
 */
// 量房只有兩種有意義的擺法：牆體長在線的哪一側。
// 「上／下」是以「由左往右畫一面牆」為基準說的（一般化就是行進方向的左手邊／右手邊）。
const OFF_OPTS = [
  { v: -0.5, label: '靠下', hint: '牆體長在線的下方（行進方向右手邊）。逆時針畫房間時＝牆在室外，量到的淨尺寸就是圖上尺寸' },
  { v: 0.5, label: '靠上', hint: '牆體長在線的上方（行進方向左手邊）' },
];
function wallOffGroup(w) {
  const cur = w.off || 0;
  return el('div', { class: 'grp' },
    el('h4', {}, '牆線位置'),
    el('div', { class: 'row' }, el('div', { class: 'seg' },
      ...OFF_OPTS.map((o) => el('button', {
        class: Math.abs(cur - o.v) < 1e-6 ? 'on' : '', title: o.hint,
        onclick: () => upd(() => { w.off = o.v; }, '牆線位置'),
      }, o.label)),
    )),
    el('div', { class: 'md-foot' }, el('span', {},
      '以「由左往右畫」為基準。牆體長在線的外側時，測距儀量到多少，圖上淨尺寸就是多少。')),
    el('button', { class: 'btn-w', onclick: () => upd(() => { w.off = -(w.off || 0.5); }, '換邊') }, '↔ 換到另一邊'),
    el('button', {
      class: 'btn-w',
      onclick: () => {
        const v = w.off || 0;
        upd(() => { for (const x of doc.walls) x.off = v; }, '整層套用牆線位置');
        toast(`本層 ${doc.walls.length} 面牆都改為「${OFF_OPTS.find((o) => Math.abs(o.v - v) < 1e-6)?.label}」`, 'ok');
      },
    }, '整層套用此設定'),
  );
}

function openingPanel(o) {
  const w = doc.wallById(o.wallId);
  const L = w ? G.dist(w.a, w.b) : 0;
  const KN = { door: '門', window: '窗', opening: '開口' };
  return el('div', {},
    head(KN[o.kind] || '開口', w?.type === 'exterior' ? '外牆上' : '內牆上'),
    el('div', { class: 'grp' },
      el('h4', {}, '尺寸'),
      row('寬度', numInput(fmtLen(o.width), (v) => { const mm = parseLen(v); if (mm > 0) upd(() => { o.width = Math.min(mm, L); }, '開口寬'); }), el('span', { class: 'unit' }, getUnit())),
      row('高度', numInput(o.height, (v) => { const mm = parseFloat(v); if (mm > 0) upd(() => { o.height = mm; }, '開口高'); }), el('span', { class: 'unit' }, 'mm')),
      o.kind === 'window' ? row('窗台高', numInput(o.sill, (v) => { const mm = parseFloat(v); if (mm >= 0) upd(() => { o.sill = mm; }, '窗台'); }), el('span', { class: 'unit' }, 'mm')) : null,
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '位置'),
      row('距起點', numInput(fmtLen(o.offset), (v) => { const mm = parseLen(v); if (mm >= 0) upd(() => { o.offset = Math.max(o.width / 2, Math.min(L - o.width / 2, mm)); }, '開口位置'); }), el('span', { class: 'unit' }, getUnit())),
      row('距終點', el('input', { type: 'text', value: fmtLen(Math.max(0, L - o.offset - o.width / 2)), disabled: true }), el('span', { class: 'unit' }, getUnit())),
      el('button', { class: 'btn-w', onclick: () => upd(() => { o.offset = L / 2; }, '置中') }, '於牆上置中'),
    ),
    o.kind === 'door' ? el('div', { class: 'grp' },
      el('h4', {}, '開向'),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        el('button', { class: o.swing >= 0 ? 'on' : '', onclick: () => upd(() => { o.swing = 1; }, '開向') }, '左樞'),
        el('button', { class: o.swing < 0 ? 'on' : '', onclick: () => upd(() => { o.swing = -1; }, '開向') }, '右樞'),
      )),
      el('button', { class: 'btn-w', onclick: () => upd(() => { o.flip = !o.flip; }, '翻面') }, '內開／外開翻轉'),
    ) : null,
    el('div', { class: 'grp' },
      el('h4', {}, '備註'),
      row('標籤', numInput(o.label || '', (v) => upd(() => { o.label = v; }, '標籤'))),
    ),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除' + (KN[o.kind] || '')),
  );
}

function columnPanel(c) {
  return el('div', {},
    head('柱／樑', c.kind === 'beam' ? '樑' : '柱'),
    el('div', { class: 'grp' },
      el('h4', {}, '尺寸'),
      row('寬', numInput(c.w, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { c.w = n; }, '柱寬'); }), el('span', { class: 'unit' }, 'mm')),
      row('深', numInput(c.h, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { c.h = n; }, '柱深'); }), el('span', { class: 'unit' }, 'mm')),
      row('旋轉', numInput(G.deg(c.rot || 0).toFixed(1), (v) => { const n = parseFloat(v); if (isFinite(n)) upd(() => { c.rot = G.rad(n); }, '旋轉'); }), el('span', { class: 'unit' }, '°')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '標示'),
      row('標籤', numInput(c.label || '', (v) => upd(() => { c.label = v; }, '標籤'))),
    ),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除柱體'),
  );
}

const BEAM_OFF_OPTS = [
  { v: -0.5, label: '靠下' }, { v: 0, label: '置中' }, { v: 0.5, label: '靠上' },
];

function beamPanel(bm) {
  const L = G.dist(bm.a, bm.b);
  const floorH = doc.floor.height || 2800;
  const dep = M.beamDepth(bm, floorH);
  const cur = bm.off || 0;
  const ang = G.deg(G.angleOf(G.sub(bm.b, bm.a)));
  const setLen = (mm) => upd(() => {
    const c = G.lerp(bm.a, bm.b, 0.5), d2 = G.norm(G.sub(bm.b, bm.a));
    bm.a = G.sub(c, G.mul(d2, mm / 2));
    bm.b = G.add(c, G.mul(d2, mm / 2));
  }, '樑長');
  const setAngle = (deg) => upd(() => {
    const c = G.lerp(bm.a, bm.b, 0.5), h = L / 2, r = G.rad(deg);
    const v = { x: Math.cos(r) * h, y: Math.sin(r) * h };
    bm.a = G.sub(c, v); bm.b = G.add(c, v);
  }, '樑角度');

  return el('div', {},
    head('樑', `${bm.width}×${dep} mm`),
    el('div', { class: 'grp' },
      el('h4', {}, '尺寸'),
      row('長度', numInput(fmtLen(L), (v) => { const mm = parseLen(v); if (mm > 100) setLen(mm); }),
        el('span', { class: 'unit' }, getUnit())),
      row('樑寬', numInput(bm.width, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { bm.width = n; }, '樑寬'); }),
        el('span', { class: 'unit' }, 'mm')),
      row('樑高', numInput(dep, (v) => {
        const n = parseFloat(v);
        if (n > 0 && n < floorH) upd(() => { bm.clearH = floorH - n; }, '樑高');
        else toast(`樑高要小於樓高 ${floorH} mm`, 'bad');
      }), el('span', { class: 'unit' }, 'mm')),
      row('樑下高度', numInput(bm.clearH, (v) => {
        const n = parseFloat(v);
        if (n > 0 && n < floorH) upd(() => { bm.clearH = n; }, '樑下高度');
        else toast(`樑下高度要小於樓高 ${floorH} mm`, 'bad');
      }), el('span', { class: 'unit' }, 'mm')),
      el('div', { class: 'md-foot' }, el('span', {},
        `樑高 ＋ 樑下高度 = 本層樓高 ${floorH} mm，改其中一個另一個會跟著算。`
        + '樑下高度就是現場從地板量到樑底的數值。')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '角度'),
      row('旋轉', numInput(ang.toFixed(1), (v) => { const n = parseFloat(v); if (isFinite(n)) setAngle(n); }),
        el('span', { class: 'unit' }, '°')),
      el('div', { class: 'row' },
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => setAngle(ang - 15) }, '↺ −15°'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => setAngle(ang + 15) }, '↻ +15°'),
      ),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        ...[0, 45, 90, 135].map((a) => el('button', {
          class: Math.abs(((ang % 180) + 180) % 180 - a) < 0.5 ? 'on' : '',
          onclick: () => setAngle(a),
        }, a + '°')))),
      el('div', { class: 'md-foot' }, el('span', {}, '也可以直接拉圖上的圓形把手旋轉（開正交時吸附 15°）。')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '樑線位置'),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        ...BEAM_OFF_OPTS.map((o) => el('button', {
          class: Math.abs(cur - o.v) < 1e-6 ? 'on' : '',
          onclick: () => upd(() => { bm.off = o.v; }, '樑線位置'),
        }, o.label)))),
      el('div', { class: 'md-foot' }, el('span', {}, '決定樑體長在中心線的哪一側。')),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '標示'),
      row('標籤', numInput(bm.label || '', (v) => upd(() => { bm.label = v; }, '標籤'))),
    ),
    el('button', { class: 'btn-w', onclick: () => {
      const c = { ...bm, id: uid('bm'), a: { x: bm.a.x, y: bm.a.y - 600 }, b: { x: bm.b.x, y: bm.b.y - 600 } };
      doc.edit('複製樑', () => doc.beams.push(c));
      ed.recompute(); ed.select({ kind: 'beam', id: c.id });
    } }, '複製一支'),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除這支樑'),
    el('div', { class: 'note', style: 'margin-top:10px' },
      '再按一次左側「樑」可以放置下一支。圖上：拖<b>方形掣點</b>改長度、拉<b>圓形把手</b>旋轉、拖樑身搬移。'
        .replace(/<\/?b>/g, '')),
  );
}

/** 極座標：鎖定角度後，長度由測距儀或輸入決定 */
function polarGroup() {
  const inp = el('input', { type: 'text', value: ed.polar == null ? '' : ed.polar.toFixed(1), placeholder: '例如 45、-30、120' });
  const apply = () => {
    const v = inp.value.trim();
    ed.setPolar(v === '' ? null : parseFloat(v));
    renderInspector();
  };
  inp.addEventListener('change', apply);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { apply(); inp.blur(); } });

  return el('div', { class: 'grp' },
    el('h4', {}, `極座標繪製${ed.polar != null ? '（已鎖定）' : ''}`),
    el('div', { class: 'row' }, el('label', {}, '角度'), inp, el('span', { class: 'unit' }, '°')),
    el('div', { class: 'row' }, el('div', { class: 'seg' },
      ...[0, 45, 90, 135].map((a) => el('button', {
        class: ed.polar === a ? 'on' : '',
        onclick: () => { ed.setPolar(a); renderInspector(); },
      }, a + '°')))),
    el('div', { class: 'row' }, el('div', { class: 'seg' },
      ...[180, -135, -90, -45].map((a) => el('button', {
        class: ed.polar === a ? 'on' : '',
        onclick: () => { ed.setPolar(a); renderInspector(); },
      }, a + '°')))),
    el('div', { class: 'row' },
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { ed.setPolar((ed.polar ?? 0) - 15); renderInspector(); } }, '−15°'),
      el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { ed.setPolar((ed.polar ?? 0) + 15); renderInspector(); } }, '+15°'),
    ),
    ed.polar != null
      ? el('button', { class: 'btn-w danger', onclick: () => { ed.setPolar(null); renderInspector(); } }, '解除角度鎖定')
      : el('div', { class: 'md-foot' }, el('span', {}, '0°＝向右，逆時針為正。鎖定後畫面會出現金色射線，長度由測距儀決定。')),
  );
}

function dimPanel(d) {
  return el('div', {},
    head('標註'),
    el('div', { class: 'grp' },
      el('div', { class: 'kv' }, el('span', {}, '長度'), el('b', {}, `${fmtLen(G.dist(d.a, d.b))} ${getUnit()}`)),
      row('偏移', numInput(d.off, (v) => { const n = parseFloat(v); if (isFinite(n)) upd(() => { d.off = n; }, '標註偏移'); }), el('span', { class: 'unit' }, 'mm')),
    ),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除標註'),
  );
}

function textPanel(t) {
  return el('div', {},
    head('註記'),
    el('div', { class: 'grp' },
      row('文字', numInput(t.text, (v) => upd(() => { t.text = v; }, '文字'))),
      row('字高', numInput(t.size, (v) => { const n = parseFloat(v); if (n > 0) upd(() => { t.size = n; }, '字高'); }), el('span', { class: 'unit' }, 'mm')),
    ),
    el('button', { class: 'btn-w danger', onclick: () => ed.deleteSel() }, '刪除註記'),
  );
}

function roomPanel(r) {
  const m2 = toM2(r.area);
  const f = doc.floor;
  const wallM2 = toM2(r.edges.reduce((s, e) => s + G.dist(e.a, e.b) * (f.height || 2800), 0));
  return el('div', {},
    head(r.name, '房間'),
    el('div', { class: 'grp' },
      el('h4', {}, '名稱'),
      row('名稱', numInput(r.label?.name || r.name, (v) => {
        upd(() => {
          if (r.label) r.label.name = v;
          else f.roomLabels.push({ id: uid('rl'), x: r.centroid.x, y: r.centroid.y, name: v, note: '' });
        }, '房間命名');
      })),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        ...['客廳', '主臥', '廚房'].map((n) => el('button', {
          onclick: () => upd(() => {
            if (r.label) r.label.name = n;
            else f.roomLabels.push({ id: uid('rl'), x: r.centroid.x, y: r.centroid.y, name: n, note: '' });
          }, '房間命名'),
        }, n)))),
      el('div', { class: 'row' }, el('div', { class: 'seg' },
        ...['次臥', '衛浴', '陽台'].map((n) => el('button', {
          onclick: () => upd(() => {
            if (r.label) r.label.name = n;
            else f.roomLabels.push({ id: uid('rl'), x: r.centroid.x, y: r.centroid.y, name: n, note: '' });
          }, '房間命名'),
        }, n)))),
    ),
    el('div', { class: 'grp' },
      el('h4', {}, '面積'),
      el('div', { class: 'kv' }, el('span', {}, '淨面積'), el('b', {}, `${fmt(m2, 2)} m²`)),
      el('div', { class: 'kv' }, el('span', {}, '坪數'), el('b', {}, `${fmt(toPing(m2), 2)} 坪`)),
      el('div', { class: 'kv' }, el('span', {}, '周長'), el('b', {}, `${fmt(r.perim / 1000, 2)} m`)),
      el('div', { class: 'kv' }, el('span', {}, '牆面積(未扣門窗)'), el('b', {}, `${fmt(wallM2, 2)} m²`)),
      el('div', { class: 'kv' }, el('span', {}, '邊數'), el('b', {}, String(r.edges.length))),
    ),
    r.label ? el('button', { class: 'btn-w', onclick: () => ed.clearRoomLabel(r) }, '只清除房間名稱') : null,
    el('button', { class: 'btn-w danger', onclick: () => confirmRoomDelete(r) }, '刪除整個區域'),
  );
}

/** 刪除整個獨立空間：先算清楚會刪掉什麼再問 */
function confirmRoomDelete(room) {
  if (!room) return;
  const plan = ed.roomDeletePlan(room);
  const n = (a) => a.length;
  const withItems = el('input', { type: 'checkbox', checked: true });

  const lines = [
    plan.drop.length ? `整面刪除的牆 ${n(plan.drop)} 面` : null,
    plan.trim.length ? `裁短的牆 ${n(plan.trim)} 面（與隔壁共用的部分會保留）` : null,
    plan.openings.length ? `門窗 ${n(plan.openings)} 樘` : null,
  ].filter(Boolean);
  if (!lines.length) lines.push('（沒有可刪除的牆體）');

  const inside = n(plan.items) + n(plan.photos) + n(plan.texts);

  modal({
    size: 'sm', title: `刪除區域「${room.name}」`,
    body: el('div', {},
      el('div', { class: 'note warn' },
        el('b', {}, '將刪除：'), el('br'), lines.join('　·　')),
      inside ? el('div', { class: 'row', style: 'margin-top:10px' },
        el('label', { style: 'flex:1;display:flex;gap:8px;align-items:center;cursor:pointer' },
          withItems,
          `一併刪除區域內的家具 ${n(plan.items)} 件、照片 ${n(plan.photos)} 張、註記 ${n(plan.texts)} 筆`)) : null,
      el('div', { class: 'note', style: 'margin-top:10px' }, '可用 Ctrl+Z 復原。'),
    ),
    footer: [
      el('button', { class: 'tb', onclick: () => closeModal() }, '取消'),
      room.label ? el('button', { class: 'tb', onclick: () => { ed.clearRoomLabel(room); closeModal(); } }, '只清名稱') : null,
      el('button', {
        class: 'md-btn', style: 'background:#f04a4a',
        onclick: () => { ed.applyRoomDelete(plan, { withItems: withItems.checked }); closeModal(); renderInspector(); toast('已刪除區域', 'ok'); },
      }, '刪除'),
    ].filter(Boolean),
  });
}

/* ── 專案管理 ───────────────────────── */
async function openProjects() {
  const list = await DB.listProjects();
  const box = el('div', { class: 'plist' });
  const draw = (items) => {
    box.replaceChildren(...items.map((p) => el('div', {
      class: 'pitem' + (p.id === doc.p.id ? ' cur' : ''),
      onclick: async (e) => {
        if (e.target.closest('.pdel')) return;
        await save();
        const full = await DB.getProject(p.id);
        doc = new M.Doc(full);
        setUnit(doc.p.unit || 'cm');
        DB.pref.set('lastProject', doc.p.id);
        ed.doc = doc;
        doc.addEventListener('change', () => { markDirty(); ed.recompute(); });
        $('#projName').value = doc.p.name;
        refreshFloors(); ed.select(null); ed.recompute(); ed.fit(); renderInspector();
        closeModal();
        toast(`已開啟「${doc.p.name}」`, 'ok');
      },
    },
      el('div', { class: 'pn' },
        el('b', {}, p.name),
        el('small', {}, `${p.floors?.length || 1} 層 · ${p.client?.name || '未填業主'} · ${new Date(p.updatedAt || Date.now()).toLocaleString('zh-TW')}`)),
      el('button', {
        class: 'pdel', title: '刪除',
        onclick: async () => {
          if (!await confirmBox('刪除專案', `確定刪除「${p.name}」？無法復原。`, '刪除')) return;
          await DB.deleteProject(p.id);
          draw((await DB.listProjects()));
          toast('已刪除', 'ok');
        },
      }, '✕'),
    )));
    if (!items.length) box.replaceChildren(el('div', { class: 'note' }, '尚無專案。'));
  };
  draw(list);

  modal({
    title: '專案管理', size: 'md',
    body: el('div', {},
      el('div', { class: 'note' }, '所有專案儲存在此瀏覽器（IndexedDB），離線也能用。建議定期用「匯出 → 專案備份」保存 JSON 檔。'),
      box),
    footer: [
      el('button', { class: 'tb', onclick: () => importProject() }, '匯入 JSON'),
      el('button', { class: 'md-btn', onclick: async () => {
        await save();
        const p = M.newProject('新專案 ' + new Date().toLocaleDateString('zh-TW'));
        await DB.saveProject(p);
        doc = new M.Doc(p);
        DB.pref.set('lastProject', p.id);
        ed.doc = doc;
        doc.addEventListener('change', () => { markDirty(); ed.recompute(); });
        $('#projName').value = doc.p.name;
        refreshFloors(); ed.select(null); ed.recompute(); ed.fit(); renderInspector();
        closeModal();
        toast('已建立新專案', 'ok');
      } }, '＋ 新專案'),
    ],
  });
}

function importProject() {
  const inp = el('input', { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const p = M.migrate(JSON.parse(await f.text()));
      p.id = M.newProject().id;
      await DB.saveProject(p);
      toast('匯入成功：' + p.name, 'ok');
      openProjects();
    } catch (err) { toast('匯入失敗：' + err.message, 'bad'); }
  };
  inp.click();
}

/* ── 語音播報 ───────────────────────────
   現場量房時人往往舉著測距儀貼牆、眼睛看不到手機，
   所以收到讀數就唸出來，確認數值不用低頭。 */
const speech = {
  get on() { return DB.pref.get('voice', false); },
  set on(v) { DB.pref.set('voice', !!v); if (!v) try { speechSynthesis.cancel(); } catch { /* noop */ } },
  get supported() { return typeof speechSynthesis !== 'undefined'; },
  say(mm) {
    if (!this.on || !this.supported) return;
    const u = getUnit();
    const unitWord = { mm: '公釐', cm: '公分', m: '公尺' }[u] || '';
    const txt = `${fmtLen(mm)} ${unitWord}`;
    try {
      speechSynthesis.cancel();
      const ut = new SpeechSynthesisUtterance(txt);
      ut.lang = 'zh-TW';
      ut.rate = 1.15;
      const v = speechSynthesis.getVoices().find((x) => /zh[-_]?(TW|HK|CN)/i.test(x.lang));
      if (v) ut.voice = v;
      speechSynthesis.speak(ut);
    } catch { /* 部分瀏覽器不支援 */ }
  },
};

/* ── 藍牙 ───────────────────────────── */
function wireMeter() {
  meter.addEventListener('status', (e) => {
    const b = $('#btnBle'), l = $('#bleLabel');
    const s = e.detail.status;
    b.dataset.state = s === 'connected' ? 'on' : s === 'connecting' ? 'wait' : '';
    l.textContent = s === 'connected' ? (meter.device?.name || '已連線') : s === 'connecting' ? '連線中' : '未連線';
    if (e.detail.msg) toast(e.detail.msg, s === 'error' ? 'bad' : '');
  });
  // 顯示與套用必須用同一個取整後的數值 ——
  // 否則面板顯示 247.3、牆上卻是 247.5，使用者會以為程式量錯。
  const quant = (mm) => (ed.precision > 0 ? Math.round(mm / ed.precision) * ed.precision : mm);

  // 串流機種即使沒有「成立」也要看得到目前讀數，對準時才有回饋
  meter.addEventListener('live', (e) => {
    const live = $('#mdLive');
    live.textContent = `${fmtLen(quant(e.detail.mm))} ${getUnit()}`;
    live.classList.toggle('pending', meter.streaming);
  });
  meter.addEventListener('mode', () => {
    $('#mdCount').textContent = meter.streaming
      ? `串流中 · 已測 ${meter.count} 筆` : `已測 ${meter.count} 筆`;
    if (meter.streaming && !DB.pref.get('hint.stream', false)) {
      DB.pref.set('hint.stream', true);
      toast('這台會持續傳送讀數：數值變動時才自動套用。要重複套用同一個數值請按「套用」', '', 6000);
    }
  });
  meter.addEventListener('reading', (e) => {
    const mm = quant(e.detail.mm);          // 顯示、語音、輸入框、套用全部用同一個值
    const live = $('#mdLive');
    live.textContent = `${fmtLen(mm)} ${getUnit()}`;
    live.classList.remove('pending');
    live.classList.remove('hit'); void live.offsetWidth; live.classList.add('hit');
    $('#mdCount').textContent = meter.streaming ? `串流中 · 已測 ${meter.count} 筆` : `已測 ${meter.count} 筆`;
    speech.say(mm);
    if ($('#mdAuto').checked) ed.applyMeasure(mm);
    else $('#mdInput').value = fmtLen(mm);
  });
  meter.addEventListener('profile', (e) => {
    toast(`已辨識測距儀資料格式（${e.detail.how}）`, 'ok', 3000);
  });
  // 自動辨識是推測出來的，請使用者對一次測距儀螢幕上的數字
  meter.addEventListener('autodetect', (e) => {
    const vals = e.detail.values.slice(-3).map((v) => fmtLen(v) + ' ' + getUnit()).join('、');
    modal({
      size: 'sm', title: '自動辨識到資料格式',
      body: el('div', {},
        el('div', { class: 'note' },
          '這台測距儀不在內建機種清單裡，程式從連續幾包資料推出了距離欄位。', el('br'), el('br'),
          el('b', {}, '最近幾筆解讀為：'), el('br'),
          el('b', { style: 'font-size:17px;color:#dcc08a' }, vals)),
        el('div', { class: 'note warn' }, '請對照測距儀螢幕上的數字。相同就按「正確」，不同請用學習模式輸入實際值。'),
      ),
      footer: [
        el('button', { class: 'tb', onclick: () => { meter.setProfile(null); closeModal(); openLearn(); } }, '不對，改用學習模式'),
        el('button', { class: 'md-btn', onclick: () => { meter.pendingConfirm = null; closeModal(); toast('已鎖定資料格式', 'ok'); } }, '正確'),
      ],
    });
  });
}

/** 瀏覽器不支援時，講清楚原因與做法，而不是只說「不支援」 */
function blockNotice() {
  const b = Meter.blockReason;
  if (!b) return null;
  const box = el('div', { class: 'note warn' },
    el('b', {}, b.title), el('br'),
    el('span', { style: 'color:#b3aa9c' }, b.why), el('br'), el('br'),
    el('b', {}, '怎麼做：'), el('br'),
    el('span', { style: 'color:#b3aa9c' }, b.fix));
  if (b.code === 'ios') {
    box.append(el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', {
        class: 'btn-w', style: 'margin:0',
        onclick: () => { navigator.clipboard?.writeText(location.href); toast('網址已複製，貼到 Bluefy 開啟', 'ok', 3500); },
      }, '複製本頁網址'),
      el('a', {
        class: 'btn-w', style: 'margin:0;display:grid;place-items:center;text-decoration:none',
        href: 'https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055', target: '_blank', rel: 'noopener',
      }, 'App Store 開啟 Bluefy'),
    ));
  }
  return box;
}

/** 裝置結構：連得上卻沒資料時，就是靠這張表找出問題出在哪 */
function deviceMapBlock() {
  if (!meter.map?.length) {
    return meter.status === 'connected' || meter.device
      ? el('div', { class: 'note warn' },
        el('b', {}, '連上了，但列不出任何服務。'),
        '這代表這台測距儀的服務 UUID 不在瀏覽器允許清單內 —— Web Bluetooth 規定只有事先宣告過的服務才看得到。請把下方原始封包區的內容回報給我，或直接告訴我測距儀型號。')
      : null;
  }
  const box = el('div', { class: 'grp' }, el('h4', {}, '裝置結構'));
  for (const s of meter.map) {
    box.append(el('div', { class: 'kv', style: 'border-top:1px solid #3a3632;padding-top:6px;margin-top:6px' },
      el('span', { style: 'color:#b3aa9c' }, '服務'),
      el('b', { style: 'font-family:ui-monospace,monospace;font-size:11px' }, s.uuid.slice(4, 8).toUpperCase())));
    for (const c of s.chars) {
      box.append(el('div', { class: 'kv', style: 'padding-left:10px' },
        el('span', { style: 'font-family:ui-monospace,monospace;font-size:11px' }, c.uuid.slice(4, 8).toUpperCase()),
        el('b', { style: `font-size:11px;font-weight:500;color:${c.subscribed ? '#8ff0c4' : '#7d766b'}` },
          c.flags.join(' · ') + (c.subscribed ? '　✓已訂閱' : ''))));
    }
  }
  if (!meter.chars.length && meter.readable?.length) {
    box.append(el('div', { class: 'note warn', style: 'margin-top:10px' },
      '沒有可訂閱的特徵值，但有可讀取的。試試下方「開始輪詢讀取」。'));
  }
  return box;
}

function openBle() {
  // 連線過程逐步紀錄：連不上時一眼看出卡在哪一步
  const stepBox = el('pre', { class: 'log', style: 'height:auto;max-height:190px;color:#cfd8e3' });
  const drawSteps = () => {
    stepBox.replaceChildren(...(meter.steps.length
      ? meter.steps.map((s) => el('div', { style: `color:${s.ok ? '#9fd3a8' : '#ff9b9b'}` },
        `${new Date(s.t).toLocaleTimeString('zh-TW')}  ${s.msg}`))
      : [el('div', { style: 'color:#7d766b' }, '（尚未嘗試連線）')]));
    stepBox.scrollTop = stepBox.scrollHeight;
  };
  drawSteps();
  const onStep = () => drawSteps();
  meter.addEventListener('step', onStep);
  meter.addEventListener('status', onStep);

  const onlyChk = el('input', { type: 'checkbox', checked: DB.pref.get('ble.onlySupported', false) });
  onlyChk.onchange = () => DB.pref.set('ble.onlySupported', onlyChk.checked);

  const nameInp = el('input', { type: 'text', value: DB.pref.get('ble.namePrefix', ''), placeholder: '留空＝列出全部裝置' });
  nameInp.addEventListener('change', () => DB.pref.set('ble.namePrefix', nameInp.value.trim()));

  /**
   * 連上之後立刻給判斷 —— 逐台試連時最需要的就是「這台到底是不是」。
   * 沒有可訂閱的特徵值幾乎可以確定不是測距儀，不必等 20 秒。
   */
  const verdictBox = el('div', { style: 'display:none' });
  const nextBtn = el('button', { class: 'btn-w', style: 'margin-top:8px', onclick: () => { meter.disconnect(); doConnect(false); } },
    '這台不是 → 換下一台');
  const verdict = () => {
    if (meter.status !== 'connected' && !meter.device) { verdictBox.style.display = 'none'; return; }
    verdictBox.style.display = '';
    if (meter.count > 0) {
      verdictBox.replaceChildren(el('div', { class: 'note', style: 'border-left-color:#2ec27e' },
        el('b', { style: 'color:#8ff0c4' }, `✓ 就是這台 —— 已收到 ${meter.count} 筆資料`), el('br'),
        `裝置名稱「${meter.device?.name || '未命名'}」已記住，下次會自動填進名稱關鍵字。`));
      return;
    }
    if (!meter.chars.length) {
      verdictBox.replaceChildren(el('div', { class: 'note warn' },
        el('b', {}, '✗ 這台幾乎確定不是測距儀'), el('br'),
        meter.map?.length
          ? `連上了，但 ${meter.map.length} 個服務裡沒有任何可接收資料的特徵值。`
          : '連上了，但列不出任何服務。',
        nextBtn));
      return;
    }
    verdictBox.replaceChildren(el('div', { class: 'note' },
      el('b', {}, '已連線，等待資料…'), el('br'),
      `訂閱了 ${meter.chars.length} 個特徵值。`, el('b', {}, '現在按一下測距儀的量測鍵'), '，數值應該馬上出現。',
      nextBtn));
  };
  const onSilent = () => {
    verdictBox.style.display = '';
    verdictBox.replaceChildren(el('div', { class: 'note warn' },
      el('b', {}, '✗ 已連線 20 秒卻收不到任何資料'), el('br'),
      '如果你已經按過量測鍵，那這台應該不是你要的測距儀。',
      nextBtn));
  };
  meter.addEventListener('silent', onSilent);
  meter.addEventListener('reading', verdict);
  meter.addEventListener('status', verdict);
  const silentBox = verdictBox;

  const logBox = el('pre', { class: 'log' }, meter.log.slice(-40).map((r) => `${new Date(r.t).toLocaleTimeString('zh-TW')} ${r.uuid.slice(4, 8)}  ${r.hex}   |${r.ascii}|`).join('\n') || '（尚無資料）');
  const onRaw = (e) => {
    const r = e.detail;
    logBox.textContent += `\n${new Date(r.t).toLocaleTimeString('zh-TW')} ${r.uuid.slice(4, 8)}  ${r.hex}   |${r.ascii}|`;
    logBox.scrollTop = logBox.scrollHeight;
  };
  meter.addEventListener('raw', onRaw);

  const profTxt = () => {
    const p = meter.profile;
    if (!p) return '尚未辨識（收到第一筆資料後會自動判斷）';
    const fmtP = p.mode === 'ascii' ? 'ASCII 文字' : `二進位 offset=${p.offset} ${p.type} ×${p.scale}`;
    return p.uuid ? `${fmtP}　來源 ${p.uuid.slice(4, 8).toUpperCase()}` : fmtP;
  };
  const profEl = el('b', {}, profTxt());

  modal({
    title: '藍牙測距儀', size: 'md',
    body: el('div', {},
      blockNotice(),
      el('div', { class: 'note' },
        '操作步驟：① 開啟測距儀電源並進入藍牙模式 ② 按下方「搜尋並連線」 ③ 在跳出的裝置清單選擇你的測距儀 ④ 按測距儀量測鍵，數值會自動進入畫面。',
      ),
      el('div', { class: 'grp' },
        el('h4', {}, '狀態'),
        el('div', { class: 'kv' }, el('span', {}, '裝置'), el('b', {}, meter.device?.name || '未連線')),
        el('div', { class: 'kv' }, el('span', {}, '服務 / 訂閱'), el('b', {}, `${meter.map?.length || 0} 服務 · 訂閱 ${meter.chars.length} 個`)),
        el('div', { class: 'kv' }, el('span', {}, '資料格式'), profEl),
        el('div', { class: 'kv' }, el('span', {}, '本次已接收'), el('b', {}, String(meter.count) + ' 筆')),
      ),
      el('div', { class: 'grp' },
        el('h4', {}, '裝置清單'),
        el('div', { class: 'row' },
          el('label', { style: 'flex:1;display:flex;gap:9px;align-items:center;cursor:pointer' },
            onlyChk, '只顯示測距儀（預設關閉）')),
        el('div', { class: 'md-foot', style: 'margin-bottom:8px' }, el('span', {},
          '預設列出全部裝置，', el('b', {}, '保證每一台測距儀都找得到'), '。',
          el('br'),
          '勾選後改依廣播內容過濾，清單較短 —— 但有些機種（如 MILESEEY S2）不把名稱與服務放進廣播，',
          '開著它就會整台消失。兩台輪流用的話請保持關閉。')),
      ),
      el('div', { class: 'grp' },
        el('h4', {}, '清單都是十六進位認不出來？'),
        (() => {
          const known = Meter.knownNames;
          return known.length
            ? el('div', { class: 'note', style: 'margin-bottom:8px' },
              '連過的裝置：', el('b', {}, known.join('、')),
              '。這些名稱已自動列入「只顯示測距儀」的篩選，兩台都會出現，不用再輸入。')
            : el('div', { class: 'md-foot', style: 'margin:0 0 8px' }, el('span', {},
              '沒有廣播名稱的裝置在清單裡只會顯示一串十六進位 ID。'
              + '先試連一台 —— 連上後畫面會馬上告訴你是不是；連對過一次就會自動記住名稱。'));
        })(),
        el('div', { class: 'row' }, el('label', {}, '名稱關鍵字'), nameInp),
        el('div', { class: 'md-foot' }, el('span', {},
          '選填。輸入的名稱會「加入」篩選（不會排除其他測距儀）；關掉「只顯示測距儀」時則只列出符合這個開頭的裝置。')),
        Meter.remembered?.id && navigator.bluetooth?.getDevices
          ? el('button', {
            class: 'btn-w primary',
            onclick: async () => {
              try { await meter.reconnectLast(); toast('已連回上次的裝置', 'ok'); }
              catch (e) { meter.step(describeErr(e), false); drawSteps(); toast(e.message, 'bad', 4000); }
            },
          }, `⚡ 直接連回「${Meter.remembered.name || '上次的裝置'}」（不跳清單）`)
          : null,
      ),
      silentBox,
      el('div', { class: 'grp' },
        el('h4', {}, '連線過程'),
        stepBox,
      ),
      deviceMapBlock(),
      el('div', { class: 'grp' },
        el('h4', {}, '原始封包（除錯 / 回報用）'),
        logBox,
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', { class: 'btn-w', style: 'margin:0', onclick: () => {
            const head = `瀏覽器：${navigator.userAgent}\n`
              + `裝置：${meter.device?.name || '?'}\n`
              + `連線過程：\n${meter.steps.map((s) => '  ' + s.msg).join('\n')}\n`
              + (meter.map || [])
              .map((s) => `服務 ${s.uuid}\n` + s.chars.map((c) => `  ${c.uuid}  ${c.flags.join(',')}${c.subscribed ? ' [訂閱中]' : ''}`).join('\n'))
              .join('\n');
            const txt = head + '\n\n封包：\n' + meter.log.map((r) => `${r.uuid} ${r.hex} |${r.ascii}|`).join('\n');
            navigator.clipboard?.writeText(txt); toast('已複製裝置結構與封包紀錄', 'ok');
          } }, '複製診斷資訊'),
          el('button', { class: 'btn-w', style: 'margin:0', onclick: () => openLearn() }, '學習模式'),
        ),
      ),
      el('div', { class: 'grp' },
        el('h4', {}, '收不到資料時的處理'),
        el('div', { class: 'row' },
          el('button', {
            class: 'btn-w', style: 'margin:0',
            onclick: (e) => {
              if (meter._poll) { meter.stopPolling(); e.target.textContent = '開始輪詢讀取'; toast('已停止輪詢'); }
              else if (meter.startPolling(400)) { e.target.textContent = '停止輪詢讀取'; toast('已開始輪詢，請按測距儀量測鍵', 'ok'); }
              else toast('這台裝置沒有可讀取的特徵值', 'bad');
            },
          }, meter._poll ? '停止輪詢讀取' : '開始輪詢讀取'),
        ),
        el('div', { class: 'md-foot' }, el('span', {}, '有些機種不會主動推播，要靠主動讀取才拿得到數值。')),
        (() => {
          const cmd = el('input', { type: 'text', placeholder: '十六進位指令，例如 AA 01 00', style: 'flex:1' });
          return el('div', { class: 'row', style: 'margin-top:8px' }, cmd,
            el('button', {
              class: 'md-btn',
              onclick: async () => {
                try { const u = await meter.write(cmd.value); toast('已送出到 ' + u.slice(4, 8).toUpperCase(), 'ok'); }
                catch (err) { toast(err.message, 'bad', 4000); }
              },
            }, '送出'));
        })(),
        el('div', { class: 'md-foot' }, el('span', {}, '部分機種需要先收到喚醒指令才會開始傳資料。')),
      ),
    ),
    footer: [
      meter.status === 'connected'
        ? el('button', { class: 'tb', onclick: () => { meter.disconnect(); closeModal(); } }, '中斷連線')
        : el('button', {
          class: 'tb', title: '把廠商自訂服務整段列入後重試，用於「連得上卻列不出服務」',
          onclick: () => doConnect(true),
        }, '全掃描重試'),
      el('button', { class: 'tb', onclick: () => { meter.setProfile(null); profEl.textContent = profTxt(); toast('已清除格式設定'); } }, '重設格式'),
      el('button', { class: 'md-btn', onclick: () => doConnect(false) },
        meter.status === 'connected' ? '重新選擇裝置' : '搜尋並連線'),
    ],
    onClose: () => {
      meter.removeEventListener('raw', onRaw);
      meter.removeEventListener('step', onStep);
      meter.removeEventListener('status', onStep);
      meter.removeEventListener('silent', onSilent);
    },
  });

  async function doConnect(wide) {
    silentBox.style.display = 'none';
    try {
      await meter.connect({ wide, namePrefix: nameInp.value, onlySupported: onlyChk.checked });
      toast('連線成功', 'ok');
    } catch (err) {
      // 錯誤要留在畫面上，手機的 toast 一閃就沒了
      meter.step(`連線結束：${describeErr(err)}`, false);
      drawSteps();
      // 篩選後找不到裝置是最常見的狀況，直接給一鍵解法
      if (onlyChk.checked) {
        verdictBox.style.display = '';
        verdictBox.replaceChildren(el('div', { class: 'note warn' },
          el('b', {}, '清單是空的或找不到裝置？'), el('br'),
          '「只顯示測距儀」是依廣播內容過濾的，你的測距儀可能沒把服務 UUID 放進廣播。',
          el('button', {
            class: 'btn-w', style: 'margin-top:8px',
            onclick: () => { onlyChk.checked = false; DB.pref.set('ble.onlySupported', false); doConnect(false); },
          }, '關掉篩選，顯示全部裝置')));
      }
    }
  }
}

/** 學習模式：量一段已知距離，反推封包格式 */
function openLearn() {
  const samples = [];
  let lastRaw = null;
  const onRaw = (e) => { lastRaw = e.detail; status.textContent = `已收到封包：${e.detail.hex}`; };
  meter.addEventListener('raw', onRaw);

  const status = el('div', { class: 'kv' }, el('span', {}, '等待封包…'));
  const listEl = el('div', {});
  const inp = el('input', { type: 'text', placeholder: '例如 1.234 或 1234mm' });

  const addSample = () => {
    if (!lastRaw) return toast('尚未收到封包，請先按一次測距儀', 'bad');
    const mm = parseLen(inp.value, 'm');
    const mm2 = /mm|cm/i.test(inp.value) ? parseLen(inp.value) : mm;
    if (!(mm2 > 0)) return toast('請輸入測距儀螢幕上顯示的數值', 'bad');
    samples.push({ bytes: lastRaw.bytes, mm: mm2 });
    listEl.append(el('div', { class: 'kv' }, el('span', {}, lastRaw.hex.slice(0, 40)), el('b', {}, `${mm2} mm`)));
    inp.value = ''; lastRaw = null;
    if (samples.length >= 2) {
      const p = learnProfile(samples);
      if (p) {
        meter.setProfile(p);
        toast('學習成功！已鎖定資料格式', 'ok', 4000);
        meter.removeEventListener('raw', onRaw);
        closeModal();
      } else {
        toast(`目前 ${samples.length} 組樣本仍無法判斷，請再量一段不同距離`, '', 4000);
      }
    } else {
      toast('已記錄 1 組，請再量一段「不同的距離」', '', 4000);
    }
  };

  modal({
    title: '學習模式 — 讓程式認識你的測距儀', size: 'sm',
    body: el('div', {},
      el('div', { class: 'note' },
        el('b', {}, '做法：'), '① 用測距儀量一段距離 ② 把測距儀螢幕上顯示的數值輸入下方 ③ 按「記錄」。',
        el('br'), '換一段明顯不同的距離再做一次，程式就能自動反推資料格式並永久記住。'),
      status, listEl,
      el('div', { class: 'row', style: 'margin-top:10px' }, inp,
        el('button', { class: 'md-btn', onclick: addSample }, '記錄')),
    ),
    footer: [el('button', { class: 'tb', onclick: () => closeModal() }, '關閉')],
    onClose: () => meter.removeEventListener('raw', onRaw),
  });
}

/* ── 報表 ───────────────────────────── */
function openReport() {
  const all = doc.p.floors.map((f) => {
    const rooms = detectFor(f);
    return { floor: f, rooms, sch: floorSchedule(f, rooms) };
  });
  const body = el('div', {});
  for (const { floor, sch } of all) {
    body.append(el('h4', { style: 'margin:16px 0 8px;font-size:13px;color:#b3aa9c' }, `【${floor.name}】樓高 ${floor.height} mm`));
    body.append(scheduleTable(sch));
  }
  const grand = all.reduce((s, x) => s + x.sch.sum.area, 0);
  body.append(el('div', { class: 'note', style: 'margin-top:16px' },
    el('b', {}, '全案合計：'), `室內淨面積 ${fmt(grand, 2)} m²（${fmt(toPing(grand), 2)} 坪）· 共 ${doc.p.floors.length} 層`));
  body.append(el('h4', { style: 'margin:18px 0 8px;font-size:13px;color:#b3aa9c' }, '本層門窗清單'));
  body.append(openingTable(doc.floor));

  const photos = doc.p.floors.flatMap((f) => (f.photos || []).map((ph) => ({ f, ph })));
  if (photos.length) {
    body.append(el('h4', { style: 'margin:18px 0 8px;font-size:13px;color:#b3aa9c' }, `現場照片（${photos.length} 張）`));
    const grid = el('div', { class: 'ph-grid' });
    photos.forEach(({ f, ph }, i) => {
      const card = el('button', { class: 'ph-card', onclick: () => PH.openViewer(ph, { meter, onChange: () => doc.commit('照片標註'), title: ph.name || '現場照片' }) },
        el('img', { alt: '' }),
        el('small', {}, `${i + 1}. ${f.name}｜${ph.name || '未命名'}${ph.marks?.length ? ` · ${ph.marks.length} 標註` : ''}`));
      DB.getPhoto(ph.photoId).then((r) => { if (r?.thumb) card.querySelector('img').src = r.thumb; });
      grid.append(card);
    });
    body.append(grid);
  }

  modal({
    title: '面積 / 工程量報表',
    body,
    footer: [
      el('button', { class: 'tb', onclick: () => download(`${doc.p.name}_面積表.csv`, scheduleCSV(doc.p, all), 'text/csv;charset=utf-8') }, '下載 CSV'),
      el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉'),
    ],
  });
}
/** 取得任一樓層的房間（不影響目前編輯狀態） */
function detectFor(f) {
  return f === doc.floor ? ed.rooms : detectRooms(f);
}

/* ── 雲端同步 / 分享 ─────────────────── */
async function openCloud() {
  const status = el('div', { class: 'kv' }, el('span', {}, '伺服器'), el('b', {}, '檢查中…'));
  const bar = el('div', { class: 'md-foot' }, el('span', {}, ''));
  const listBox = el('div', { class: 'plist' });
  const linkBox = el('div', {});

  const tokenInp = el('input', { type: 'password', value: DB.pref.get('sync.token', ''), placeholder: '未設定則留空' });
  tokenInp.addEventListener('change', () => { DB.pref.set('sync.token', tokenInp.value.trim()); refresh(); });

  const prog = (msg, done, total) => {
    bar.firstChild.textContent = total ? `${msg}　${done}/${total}` : msg;
  };

  const refresh = async () => {
    const st = await SY.backendStatus();
    const ok = st === 'ok' || st === 'auth';
    const TXT = {
      ok: ['已連線', '#8ff0c4'],
      auth: ['需要存取權杖', '#ffd591'],
      static: ['此網站沒有後端（靜態託管）', '#b3aa9c'],
      offline: ['連不上伺服器', '#ffb3b3'],
    }[st];
    status.querySelector('b').textContent = TXT[0];
    status.querySelector('b').style.color = TXT[1];

    if (st === 'static') {
      listBox.replaceChildren(el('div', { class: 'note' },
        el('b', {}, '這個網址是靜態託管（Cloudflare Pages 之類），沒有 /api 後端。'), el('br'),
        '量房、繪圖、面積、DXF／DAE 匯出、藍牙測距全部照常運作，只有「雲端同步」與「分享連結」需要後端。', el('br'), el('br'),
        el('b', {}, '要用同步：'), '在自己的電腦執行 ', el('b', {}, 'node server.mjs'), '，改用 ',
        el('b', {}, 'http://localhost:5173'), ' 開啟即可。專案備份也可以直接用「匯出 → 專案備份 JSON」。'));
      return;
    }
    if (st === 'offline') {
      listBox.replaceChildren(el('div', { class: 'note warn' }, '無法連線到同步伺服器。請確認 server.mjs 正在執行。'));
      return;
    }
    try {
      const items = await SY.list();
      const rows = items.map((it) => {
        const pull = async () => {
          if (!await confirmBox('從雲端取回', `會以雲端版本覆蓋本機的「${it.name}」，本機未同步的修改會遺失。`, '取回')) return;
          try {
            const p = await SY.pull(it.id, prog);
            await DB.saveProject(M.migrate(p));
            await openProjectById(it.id);
            closeModal();
            toast('已從雲端取回', 'ok');
          } catch (e) { toast('取回失敗：' + e.message, 'bad', 4000); }
        };
        const del = async () => {
          if (!await confirmBox('從雲端刪除', `「${it.name}」的雲端副本與分享連結都會刪除。本機資料不受影響。`, '刪除')) return;
          try { await SY.removeProject(it.id); } catch (e) { toast(e.message, 'bad'); }
          refresh();
        };
        const meta = `${it.floors} 層 · ${it.client || '未填業主'} · ${(it.bytes / 1024).toFixed(0)} KB · ${new Date(it.updatedAt).toLocaleString('zh-TW')}`;
        return el('div', { class: 'pitem' + (it.id === doc.p.id ? ' cur' : '') },
          el('div', { class: 'pn' }, el('b', {}, it.name), el('small', {}, meta)),
          el('button', { class: 'tb', onclick: pull }, '取回'),
          el('button', { class: 'pdel', title: '從雲端刪除', onclick: del }, '✕'),
        );
      });
      listBox.replaceChildren(...(rows.length
        ? rows
        : [el('div', { class: 'note' }, '雲端還沒有專案。按下方「上傳目前專案」開始。')]));
    } catch (e) {
      listBox.replaceChildren(el('div', { class: 'note warn' }, '讀取失敗：' + e.message + (/401/.test(e.message) ? '（請填入正確的存取權杖）' : '')));
    }
  };

  modal({
    title: '雲端同步 / 分享', size: 'md',
    body: el('div', {},
      el('div', { class: 'note' },
        el('b', {}, '這是自架雲端 —— '), '同步的目的地就是跑 server.mjs 的那台機器（目前是 ',
        el('b', {}, location.host), '）。同一網路的手機、平板都能存取同一份資料。要真的上公網，把整包部署到任何 Node 主機即可。'),
      el('div', { class: 'grp' },
        el('h4', {}, '狀態'), status,
        row('存取權杖', tokenInp),
        el('div', { class: 'md-foot' }, el('span', {}, '伺服器以 SYNC_TOKEN 環境變數啟動時才需要填。')),
      ),
      el('div', { class: 'grp' }, el('h4', {}, '目前專案'),
        el('div', { class: 'kv' }, el('span', {}, '名稱'), el('b', {}, doc.p.name)),
        el('div', { class: 'row' },
          el('button', {
            class: 'btn-w primary', style: 'margin:0',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await save();
                await SY.push(doc.p, prog);
                toast('已上傳到雲端', 'ok');
                refresh();
              } catch (err) { toast('上傳失敗：' + err.message, 'bad', 4000); }
              e.target.disabled = false;
            },
          }, '⬆ 上傳目前專案'),
          el('button', {
            class: 'btn-w', style: 'margin:0',
            onclick: async () => {
              try {
                const r = await SY.share(doc.p.id);
                linkBox.replaceChildren(el('div', { class: 'grp' },
                  el('h4', {}, '分享連結（唯讀）'),
                  el('div', { class: 'row' },
                    el('input', { type: 'text', value: r.full, readonly: true, onclick: (e) => e.target.select() }),
                    el('button', { class: 'md-btn', onclick: () => { navigator.clipboard?.writeText(r.full); toast('已複製', 'ok'); } }, '複製')),
                  el('div', { class: 'md-foot' }, el('span', {}, '業主用瀏覽器打開即可看平面圖、面積表與現場照片，可列印或存 PDF。')),
                  el('button', { class: 'btn-w danger', onclick: async () => { await SY.unshare(doc.p.id); linkBox.replaceChildren(); toast('已撤銷連結', 'ok'); } }, '撤銷這個連結'),
                ));
              } catch (err) { toast('建立失敗：' + err.message, 'bad', 4000); }
            },
          }, '🔗 產生分享連結'),
        ),
        bar,
      ),
      linkBox,
      el('div', { class: 'grp' }, el('h4', {}, '雲端上的專案'), listBox),
    ),
    footer: [el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉')],
  });
  refresh();
}

/** 依 id 切換到某個本機專案（開啟雲端取回後重用） */
async function openProjectById(id) {
  const full = await DB.getProject(id);
  if (!full) return;
  doc = new M.Doc(full);
  setUnit(doc.p.unit || 'cm');
  DB.pref.set('lastProject', doc.p.id);
  ed.doc = doc;
  doc.addEventListener('change', () => { markDirty(); ed.recompute(); });
  $('#projName').value = doc.p.name;
  refreshFloors(); ed.select(null); ed.recompute(); ed.fit(); renderInspector();
}

/* ── 風水評測（民俗參考） ───────────────── */
function openFengshui() {
  const f = doc.floor;
  const doors = f.openings.filter((o) => o.kind === 'door');
  const body = el('div', {});

  const render = () => {
    const res = FS.analyze(f, ed.rooms, { north: f.north || 0, doorId: f.mainDoorId });
    ed.fs = res.ok ? res : null;
    ed.render();

    const northRow = el('div', { class: 'grp' },
      el('h4', {}, '正北方向'),
      el('div', { class: 'row' },
        el('label', {}, '北向角度'),
        (() => {
          const i = el('input', { type: 'text', value: G.deg(f.north || 0).toFixed(0) });
          const fire = () => { const n = parseFloat(i.value); if (isFinite(n)) { doc.edit('設定北向', () => { f.north = G.rad(n); }); render(); } };
          i.addEventListener('change', fire);
          i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { fire(); i.blur(); } });
          return i;
        })(),
        el('span', { class: 'unit' }, '°'),
      ),
      el('div', { class: 'row' },
        ...[-90, -15, 15, 90].map((d) => el('button', {
          class: 'btn-w', style: 'margin:0',
          onclick: () => { doc.edit('設定北向', () => { f.north = G.normAngle((f.north || 0) + G.rad(d)); }); render(); },
        }, (d > 0 ? '+' : '') + d + '°')),
      ),
      el('div', { class: 'md-foot' }, el('span', {}, '預設圖面上方為正北。用手機指北針對照現場後在此校正。')),
    );

    const doorSel = el('select', {}, ...doors.map((o, i) => {
      const w = f.walls.find((x) => x.id === o.wallId);
      return el('option', { value: o.id, selected: o.id === (f.mainDoorId || doors[0]?.id) },
        `門 M${String(i + 1).padStart(2, '0')}${w?.type === 'exterior' ? '（外牆）' : '（內牆）'}${o.label ? ' ' + o.label : ''}`);
    }));
    doorSel.onchange = () => { doc.edit('設定大門', () => { f.mainDoorId = doorSel.value; }); render(); };

    body.replaceChildren(
      el('div', { class: 'note warn' },
        el('b', {}, '民俗參考功能。'), '依「八宅明鏡」的傳統規則由坐向推算，供設計溝通參考，不代表任何科學或工程結論。'),
      northRow,
      el('div', { class: 'grp' }, el('h4', {}, '大門'),
        doors.length ? row('選擇大門', doorSel) : el('div', { class: 'kv' }, el('span', {}, '尚未有門，請先在外牆放一扇門'))),
      res.ok ? resultBlock(res) : el('div', { class: 'note' }, res.reason),
    );
  };

  const lc = (l) => (l === 'good' ? '#2ec27e' : l === 'bad' ? '#f04a4a' : '#b3aa9c');

  const resultBlock = (res) => {
    const tbl = el('table', { class: 'tbl' });
    tbl.innerHTML = '<thead><tr><th>方位</th><th>卦</th><th>遊年星</th><th>九星</th><th>吉凶</th><th>建議配置</th></tr></thead>';
    const tb = el('tbody');
    for (const s of res.sectors) {
      tb.append(el('tr', {},
        el('td', {}, `${s.fullDir}`),
        el('td', {}, `${s.gua} ${s.sym}`),
        el('td', { style: `color:${lc(s.luck)};font-weight:600` }, s.star),
        el('td', {}, `${s.starName}·${s.wx}`),
        el('td', { style: `color:${lc(s.luck)};font-weight:600` }, s.rank),
        el('td', { style: 'color:#b3aa9c;font-size:12px' }, s.use),
      ));
    }
    tbl.append(tb);

    const rt = el('table', { class: 'tbl' });
    rt.innerHTML = '<thead><tr><th>房間</th><th>方位</th><th>山</th><th>遊年星</th><th>吉凶</th></tr></thead>';
    const rb = el('tbody');
    for (const r of res.roomDirs) {
      rb.append(el('tr', {},
        el('td', {}, r.room.name),
        el('td', {}, r.sector ? `${r.sector.fullDir} ${r.sector.gua}` : '中宮'),
        el('td', {}, r.mountain || '—'),
        el('td', { style: `color:${lc(r.luck)};font-weight:600` }, r.star),
        el('td', { style: `color:${lc(r.luck)};font-weight:600` }, r.rank),
      ));
    }
    rt.append(rb);

    // 屋主命卦（選填）
    const yInp = el('input', { type: 'text', placeholder: '例如 1985', style: 'flex:1' });
    const gSel = el('select', {}, el('option', { value: '1' }, '男'), el('option', { value: '0' }, '女'));
    const gOut = el('div', { class: 'kv' }, el('span', {}, '命卦'), el('b', {}, '—'));
    const calc = () => {
      const p = FS.personGua(parseInt(yInp.value, 10), gSel.value === '1');
      gOut.querySelector('b').textContent = p
        ? `${p.gua}命（${p.group}）· 與本宅${p.group.replace('命', '宅') === res.group ? '相配 ✓' : '不同組'}`
        : '—';
    };
    yInp.addEventListener('input', calc); gSel.onchange = calc;

    return el('div', {},
      el('div', { class: 'grp' },
        el('h4', {}, '坐向'),
        el('div', { class: 'kv' }, el('span', {}, '結論'), el('b', {}, res.summary)),
        el('div', { class: 'kv' }, el('span', {}, '向（大門朝外）'),
          el('b', {}, `${res.faceM.name}山 ${res.facingDeg.toFixed(1)}° · ${res.faceM.gua.dir} · ${res.faceM.yuan} · ${res.faceM.wx}`)),
        el('div', { class: 'kv' }, el('span', {}, '坐'),
          el('b', {}, `${res.sitM.name}山 ${res.sittingDeg.toFixed(1)}° · ${res.sitM.gua.dir} · ${res.sitM.yuan} · ${res.sitM.wx}`)),
        res.sitM.jian ? el('div', { class: 'kv' }, el('span', {}, '兼向'),
          el('b', {}, `坐${res.sitM.name}兼${res.sitM.jian}（偏 ${res.sitM.off.toFixed(1)}°）`)) : null,
        el('div', { class: 'kv' }, el('span', {}, '宅卦'), el('b', {}, `${res.gua}宅 · ${res.group}`)),
        el('div', { class: 'kv' }, el('span', {}, '文昌位'),
          el('b', {}, res.study ? `${res.study.gua}方${res.study.inCenter ? '（入中，寄巽）' : ''}` : '—')),
        res.wenchangYear?.gua ? el('div', { class: 'kv' }, el('span', {}, `${res.year} 流年文昌`), el('b', {}, `${res.wenchangYear.gua}方`)) : null,
      ),
      el('h4', { style: 'margin:16px 0 8px;font-size:13px;color:#b3aa9c' }, '八方位吉凶'),
      tbl,
      el('h4', { style: 'margin:16px 0 8px;font-size:13px;color:#b3aa9c' }, '各房間所在方位'),
      rt,
      el('div', { class: 'grp', style: 'margin-top:14px' },
        el('h4', {}, '屋主命卦（選填）'),
        el('div', { class: 'row' }, el('label', {}, '出生年'), yInp, gSel),
        gOut,
      ),
      el('div', { class: 'note', style: 'margin-top:12px' },
        `已在平面圖疊上八方位與 明財位／文昌位 標示。${res.wealth ? '' : '（未偵測到客廳，明財位未標示）'}`),
    );
  };

  render();
  modal({
    title: '風水評測（參考）',
    body,
    footer: [
      el('button', { class: 'tb', onclick: () => { ed.fs = null; ed.render(); closeModal(); } }, '關閉疊圖'),
      el('button', { class: 'md-btn', onclick: () => closeModal() }, '保留疊圖並關閉'),
    ],
  });
}

/* ── 3D ─────────────────────────────── */
function open3d() {
  const cv = el('canvas', { style: 'width:100%;height:min(58vh,520px);border-radius:8px;display:block' });
  const view = { rotY: 0, zoom: 1 };
  const draw = () => render3d(cv, doc.floor, ed.rooms, view);
  const m = modal({
    title: '3D 空間簡圖 — ' + doc.floor.name,
    body: el('div', {}, cv,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { view.rotY -= Math.PI / 12; draw(); } }, '↶ 左轉'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { view.rotY += Math.PI / 12; draw(); } }, '↷ 右轉'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { view.zoom *= 1.15; draw(); } }, '＋'),
        el('button', { class: 'btn-w', style: 'margin:0', onclick: () => { view.zoom /= 1.15; draw(); } }, '－'),
      ),
      el('div', { class: 'note', style: 'margin-top:10px' }, '依牆體、門窗高度即時生成的體塊模型。可用「匯出 → DXF」帶進 AutoCAD / SketchUp 續作。'),
    ),
    footer: [
      el('button', { class: 'tb', onclick: () => { closeModal(); setTimeout(openWalk, 60); } }, '走進去看'),
      el('button', { class: 'tb', onclick: () => cv.toBlob((b) => download(`${doc.p.name}_${doc.floor.name}_3D.png`, b, 'image/png')) }, '存成圖片'),
      el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉'),
    ],
  });
  requestAnimationFrame(draw);
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { drag = e.clientX; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => { if (drag == null) return; view.rotY += (e.clientX - drag) * 0.008; drag = e.clientX; draw(); });
  cv.addEventListener('pointerup', () => { drag = null; });
  new ResizeObserver(draw).observe(m);
}

/* ── 走動視角 ─────────────────────────── */
function openWalk() {
  if (!doc.floor.walls.length) return toast('請先畫牆，才有房間可以走進去', 'bad', 3000);
  const cv = el('canvas', { tabindex: 0, style: 'width:100%;height:100%;display:block;border-radius:8px;touch-action:none;outline:none;cursor:grab' });
  const map = el('canvas', { class: 'walk-map', title: '點一下就走到那裡' });
  const pad = (label, f, t, title) => {
    const b = el('button', { class: 'walk-key', title }, label);
    const on = (e) => { e.preventDefault(); walk.hold(f, t); b.classList.add('on'); };
    const off = () => { walk.hold(0, 0); b.classList.remove('on'); };
    b.addEventListener('pointerdown', on);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, off);
    return b;
  };
  const wrap = el('div', { class: 'walk-wrap' }, cv, map);
  const walk = createWalk(cv, map, doc.floor, ed.rooms);
  if (!walk.ok) return toast('這個瀏覽器不支援 3D 顯示（WebGL），無法使用走動視角', 'bad', 4000);
  wrap.append(el('div', { class: 'walk-pad' },
    pad('↶', 0, 1, '左轉'), pad('▲', 1, 0, '前進'), pad('↷', 0, -1, '右轉'), pad('▼', -1, 0, '後退')));
  modal({
    title: '走動視角 — ' + doc.floor.name,
    size: 'lg',
    body: el('div', {}, wrap,
      el('div', { class: 'note', style: 'margin-top:10px' },
        '拖曳畫面轉頭；方向鍵或 W A S D 走動、Q E 轉身，滾輪前進後退。手機用右下角的按鈕。點右上角小地圖可以直接走到那個位置。視線高度 150 cm。')),
    footer: [
      el('button', { class: 'tb', onclick: () => cv.toBlob((b) => download(`${doc.p.name}_${doc.floor.name}_走動視角.png`, b, 'image/png')) }, '存成圖片'),
      el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉'),
    ],
    onClose: () => walk.destroy(),
  });
}

/* ── 匯出 ───────────────────────────── */
function openExport() {
  const f = doc.floor, rooms = ed.rooms;
  const base = `${doc.p.name}_${f.name}`;
  const opt = { name: doc.p.name, floorName: f.name };
  const card = (title, desc, fn) => el('button', {
    class: 'excard',
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { await fn(); } catch (err) { toast('匯出失敗：' + err.message, 'bad', 4500); }
      b.disabled = false;
    },
  }, el('b', {}, title), el('small', {}, desc));

  let dstat = { tris: 0, parts: 0 };
  try { dstat = daeStats(f, rooms, {}); } catch { /* 沒有幾何 */ }

  modal({
    title: '匯出', size: 'md',
    body: el('div', {},
      el('div', { class: 'note' },
        `目前樓層：${f.name}．共 ${rooms.length} 個房間、${f.walls.length} 面牆、`
        + `${f.items?.length || 0} 件家具．3D 三角面 ${dstat.tris} 個。`),
      el('div', { class: 'exgrid' },
        card('AutoCAD DXF（本層）', '2D 平面圖。雙線牆體、門窗符號、尺寸與面積文字，分圖層（WALL / DOOR / WINDOW / DIM / ROOM / FURNITURE…）。',
          () => download(`${base}.dxf`, buildDXF(f, rooms, opt), 'application/dxf')),
        card('COLLADA DAE — 純牆體（SketchUp 用）',
          '只有牆。轉角已斜接不重疊，門窗只留孔洞、不含門片與玻璃，方便在 SketchUp 裡自己放門窗元件。',
          () => download(`${base}_牆體.dae`, buildDAE(f, rooms, { ...opt, wallsOnly: true }), 'model/vnd.collada+xml')),
        card('COLLADA DAE — 完整場景',
          '牆體 + 門窗玻璃 + 家具 + 地板與天花樓板（同厚 120mm），分材質。適合直接看整體效果。',
          () => download(`${base}.dae`, buildDAE(f, rooms, opt), 'model/vnd.collada+xml')),
        card('COLLADA DAE（全案）', `所有 ${doc.p.floors.length} 個樓層依樓高堆疊成一份 3D 模型。`,
          () => {
            const roomsBy = doc.p.floors.map((x) => detectFor(x));
            download(`${doc.p.name}_全案.dae`, buildDAEAll(doc.p, roomsBy, {}), 'model/vnd.collada+xml');
          }),
        card('向量 SVG', '可直接列印或匯入 Illustrator / Figma 的彩現平面圖。',
          () => download(`${base}.svg`, buildSVG(f, rooms, opt), 'image/svg+xml')),
        card('目前畫面 PNG', '把畫布現況輸出成圖片，方便傳 LINE 給業主。',
          async () => { const b = await ed.toPNG(); download(`${base}.png`, b, 'image/png'); }),
        card('面積表 CSV', 'Excel 可直接開啟的房間面積、牆面、天花、踢腳統計。',
          () => {
            const all = doc.p.floors.map((x) => ({ floor: x, sch: floorSchedule(x, x === f ? rooms : detectFor(x)) }));
            download(`${doc.p.name}_面積表.csv`, scheduleCSV(doc.p, all), 'text/csv;charset=utf-8');
          }),
        card('專案備份 JSON', '完整專案（含所有樓層）備份，可在其他裝置匯入。',
          () => download(`${doc.p.name}.json`, JSON.stringify(doc.p, null, 1), 'application/json')),
        card('列印平面圖', '開新視窗排版後直接列印或另存 PDF。',
          () => printPlan(f, rooms, opt)),
      ),
    ),
    footer: [el('button', { class: 'md-btn', onclick: () => closeModal() }, '關閉')],
  });
}

function printPlan(f, rooms, opt) {
  const svg = buildSVG(f, rooms, opt);
  const w = window.open('', '_blank');
  if (!w) return toast('瀏覽器阻擋了新視窗，請改用「向量 SVG」下載', 'bad', 4000);
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${opt.name} — ${opt.floorName}</title>
  <style>@page{size:A3 landscape;margin:8mm}body{margin:0;display:grid;place-items:center}svg{width:100%;height:auto;max-height:98vh}</style>
  ${svg}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script>`);
  w.document.close();
}

/* ── 設定 ───────────────────────────── */
function openSettings() {
  const unitSel = el('select', {}, ...Object.entries(UNITS).map(([k, v]) => el('option', { value: k, selected: k === getUnit() }, v.label)));
  unitSel.onchange = () => {
    setUnit(unitSel.value); doc.p.unit = unitSel.value; markDirty();
    $('#mdInput').placeholder = `輸入長度 (${getUnit()})`;
    ed.render(); renderInspector(); updateStats();
  };
  const mk = (key, label, unitTxt = 'mm') => row(label, numInput(M.DEFAULTS[key], (v) => {
    const n = parseFloat(v); if (n > 0) { M.DEFAULTS[key] = n; DB.pref.set('def.' + key, n); }
  }), el('span', { class: 'unit' }, unitTxt));

  // 吸附精度：自由拖曳畫牆時，長度會吸到這個倍數上（精確值之後由測距儀覆蓋）
  const SNAPS = [[0, '關閉'], [10, '1 cm'], [50, '5 cm'], [100, '10 cm'], [500, '50 cm']];
  const snapSel = el('select', {}, ...SNAPS.map(([v, t]) => el('option', { value: v, selected: v === ed.gridStep }, t)));
  snapSel.onchange = () => { ed.gridStep = +snapSel.value; DB.pref.set('gridStep', ed.gridStep); ed.render(); };

  // 刻度精密度：量測值取整到這個刻度再套用
  const PRECS = [[1, '0.1 cm'], [2, '0.2 cm'], [5, '0.5 cm（預設）'], [10, '1 cm']];
  const precSel = el('select', {}, ...PRECS.map(([v, t]) => el('option', { value: v, selected: v === ed.precision }, t)));
  precSel.onchange = () => {
    ed.precision = +precSel.value;
    DB.pref.set('precision', ed.precision);
    // 面板上正在顯示的讀值立刻依新刻度重新取整，兩邊才不會對不上
    if (meter.live != null) {
      const q = ed.precision > 0 ? Math.round(meter.live / ed.precision) * ed.precision : meter.live;
      $('#mdLive').textContent = `${fmtLen(q)} ${getUnit()}`;
    }
  };

  const voiceChk = el('input', { type: 'checkbox', checked: speech.on });
  voiceChk.onchange = () => {
    speech.on = voiceChk.checked;
    if (voiceChk.checked) speech.say(3579);      // 立即試聽
  };

  modal({
    title: '設定', size: 'sm',
    body: el('div', {},
      el('div', { class: 'grp' }, el('h4', {}, '顯示'),
        row('長度單位', unitSel),
        row('吸附精度', snapSel),
        row('刻度精密度', precSel),
        el('div', { class: 'md-foot' }, el('span', {}, '測距儀量到的數值會先取整到這個刻度再套用，例如 247.34 cm → 247.5 cm。')),
      ),
      el('div', { class: 'grp' }, el('h4', {}, '現場輔助'),
        el('div', { class: 'row' },
          el('label', {}, '語音播報'),
          el('label', { style: 'flex:1;display:flex;gap:7px;align-items:center;cursor:pointer' },
            voiceChk, speech.supported ? '收到讀數時唸出數值' : '此瀏覽器不支援語音'),
        ),
      ),
      el('div', { class: 'grp' }, el('h4', {}, '新牆的牆線位置'),
        el('div', { class: 'row' }, el('div', { class: 'seg' },
          ...OFF_OPTS.map((o) => el('button', {
            class: Math.abs((M.DEFAULTS.wallOff || 0) - o.v) < 1e-6 ? 'on' : '', title: o.hint,
            onclick: (e) => {
              M.DEFAULTS.wallOff = o.v; DB.pref.set('def.wallOff', o.v);
              [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target));
            },
          }, o.label)))),
        el('div', { class: 'md-foot' }, el('span', {}, '量室內淨尺寸請用「靠下」並逆時針畫房間 —— 量多少，圖上就是多少。')),
      ),
      el('div', { class: 'grp' }, el('h4', {}, '預設值'),
        mk('wallThick', '牆厚'), mk('wallHeight', '樓高'),
        mk('doorWidth', '門寬'), mk('doorHeight', '門高'),
        mk('windowWidth', '窗寬'), mk('windowHeight', '窗高'), mk('windowSill', '窗台高'),
      ),
      el('div', { class: 'grp' }, el('h4', {}, '關於'),
        el('div', { class: 'kv' }, el('span', {}, '版本'), el('b', {}, '1.0')),
        el('div', { class: 'kv' }, el('span', {}, 'Web Bluetooth'), el('b', {}, Meter.supported ? '支援' : '不支援')),
        el('div', { class: 'kv' }, el('span', {}, '離線快取'), el('b', {}, 'serviceWorker' in navigator ? '已啟用' : '不支援')),
      ),
    ),
    footer: [el('button', { class: 'md-btn', onclick: () => closeModal() }, '完成')],
  });
}

// 載入使用者自訂預設值。wallOff 合法值含 0 與負數，不能用 v > 0 過濾。
for (const k of Object.keys(M.DEFAULTS)) {
  const v = DB.pref.get('def.' + k, null);
  if (v == null || !isFinite(v)) continue;
  if (k === 'wallOff' || k === 'beamOff') { if (v >= -0.5 && v <= 0.5) M.DEFAULTS[k] = v; }
  else if (v > 0) M.DEFAULTS[k] = v;
}

/* ── PWA ────────────────────────────── */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* 開發模式忽略 */ });
}
