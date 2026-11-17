// export-dae.js — 輸出 COLLADA (.dae) 3D 模型
//
// SketchUp / Blender / 3ds Max / Cinema 4D 都能直接匯入。
// 幾何來源與畫面上的 3D 預覽完全相同（solid.js），所以看到什麼就匯出什麼。
//
// 座標：模型 X/Y 為平面、Z 為高度，正好對應 COLLADA 的 Z_UP。
// 單位：內部是 mm，輸出時換算成公尺並宣告 <unit name="meter" meter="1"/>，
//       即使匯入端忽略單位宣告，數值仍是常見的公制尺度。

import * as G from './geometry.js';
import { solidsOf, slabsOf, ceilingsOf, cleanWallMesh } from './solid.js';

const MM2M = 0.001;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** 材質：漫射色 + 不透明度 */
const MATERIALS = {
  wallExt: { name: '外牆', rgb: [0.78, 0.78, 0.75], a: 1 },
  wall: { name: '內牆', rgb: [0.90, 0.90, 0.88], a: 1 },
  column: { name: '柱體', rgb: [0.62, 0.64, 0.67], a: 1 },
  beam: { name: '樑', rgb: [0.68, 0.63, 0.57], a: 1 },
  glass: { name: '玻璃', rgb: [0.55, 0.75, 0.90], a: 0.32 },
  item: { name: '家具', rgb: [0.76, 0.66, 0.52], a: 1 },
  floor: { name: '地板樓板', rgb: [0.86, 0.84, 0.80], a: 1 },
  ceil: { name: '天花樓板', rgb: [0.93, 0.93, 0.91], a: 1 },
};

/** 一種材質對應一份三角網格 */
class Mesh {
  constructor() { this.pos = []; this.nrm = []; this.tri = []; }
  get empty() { return this.tri.length === 0; }
  get triCount() { return this.tri.length / 6; }

  /** 加一個三角形（世界座標，mm）；法線由頂點順序（右手定則）決定 */
  tri3(a, b, c) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;                       // 退化三角形直接丟掉
    nx /= L; ny /= L; nz /= L;
    const ni = this.nrm.length / 3;
    this.nrm.push(nx, ny, nz);
    const base = this.pos.length / 3;
    for (const p of [a, b, c]) this.pos.push(p.x, p.y, p.z);
    this.tri.push(base, ni, base + 1, ni, base + 2, ni);
  }
  quad(a, b, c, d) { this.tri3(a, b, c); this.tri3(a, c, d); }

  /** 把平面多邊形（CCW）擠出成封閉柱體 */
  extrude(poly, z0, z1) {
    const n = poly.length;
    if (n < 3 || z1 - z0 < 1e-6) return;
    const P = (i, z) => ({ x: poly[i].x, y: poly[i].y, z });
    const tris = G.triangulate(poly);
    for (const [i, j, k] of tris) this.tri3(P(i, z1), P(j, z1), P(k, z1));   // 頂面 +Z
    for (const [i, j, k] of tris) this.tri3(P(k, z0), P(j, z0), P(i, z0));   // 底面 -Z
    for (let i = 0; i < n; i++) {                                            // 側面，外側朝外
      const j = (i + 1) % n;
      this.quad(P(i, z0), P(j, z0), P(j, z1), P(i, z1));
    }
  }
}

const source = (id, arr, params) => `<source id="${id}">
<float_array id="${id}-a" count="${arr.length}">${arr.join(' ')}</float_array>
<technique_common><accessor source="#${id}-a" count="${arr.length / params.length}" stride="${params.length}">${
  params.map((p) => `<param name="${p}" type="float"/>`).join('')}</accessor></technique_common>
</source>`;

/** 把各材質的網格組裝成一份 COLLADA 文件 */
function assemble(meshes, opt = {}) {
  const used = Object.entries(meshes).filter(([, m]) => !m.empty);
  if (!used.length) throw new Error('沒有可匯出的 3D 幾何，請先畫牆。');

  const geoms = [], nodes = [], effects = [], mats = [];

  for (const [key, m] of used) {
    const mat = MATERIALS[key] || MATERIALS.wall;
    const gid = `geo-${key}`;

    geoms.push(`<geometry id="${gid}" name="${esc(mat.name)}"><mesh>
${source(`${gid}-pos`, m.pos.map((v) => +(v * MM2M).toFixed(6)), ['X', 'Y', 'Z'])}
${source(`${gid}-nrm`, m.nrm.map((v) => +v.toFixed(6)), ['X', 'Y', 'Z'])}
<vertices id="${gid}-vtx"><input semantic="POSITION" source="#${gid}-pos"/></vertices>
<triangles count="${m.triCount}" material="sym-${key}">
<input semantic="VERTEX" source="#${gid}-vtx" offset="0"/>
<input semantic="NORMAL" source="#${gid}-nrm" offset="1"/>
<p>${m.tri.join(' ')}</p>
</triangles></mesh></geometry>`);

    nodes.push(`<node id="node-${key}" name="${esc(mat.name)}" type="NODE">
<instance_geometry url="#${gid}"><bind_material><technique_common>
<instance_material symbol="sym-${key}" target="#mat-${key}"/>
</technique_common></bind_material></instance_geometry></node>`);

    const [r, g, b] = mat.rgb;
    effects.push(`<effect id="fx-${key}"><profile_COMMON><technique sid="common"><lambert>
<diffuse><color sid="diffuse">${r} ${g} ${b} ${mat.a}</color></diffuse>
<transparent opaque="A_ONE"><color>1 1 1 ${mat.a}</color></transparent>
<transparency><float>1</float></transparency>
</lambert></technique></profile_COMMON></effect>`);

    mats.push(`<material id="mat-${key}" name="${esc(mat.name)}"><instance_effect url="#fx-${key}"/></material>`);
  }

  const title = [opt.name, opt.floorName].filter(Boolean).join(' — ') || '丈量APP 模型';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset>
<contributor><authoring_tool>丈量APP</authoring_tool></contributor>
<created>${now}</created><modified>${now}</modified>
<unit name="meter" meter="1"/>
<up_axis>Z_UP</up_axis>
</asset>
<library_effects>
${effects.join('\n')}
</library_effects>
<library_materials>
${mats.join('\n')}
</library_materials>
<library_geometries>
${geoms.join('\n')}
</library_geometries>
<library_visual_scenes>
<visual_scene id="scene" name="${esc(title)}">
${nodes.join('\n')}
</visual_scene>
</library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
}

/** 把一層樓的體塊累積到 meshes（zBase 供多層堆疊使用） */
function collect(meshes, floor, rooms, opt, zBase = 0) {
  const get = (k) => (meshes[k] ||= new Mesh());

  // 乾淨牆體模式：只有牆，轉角斜接不重疊，門窗只留孔洞、不產生門片與玻璃。
  // 這是要匯進 SketchUp 續作時該用的形式。
  if (opt.wallsOnly) {
    const m = get('wall');
    for (const [a, b, c] of cleanWallMesh(floor)) {
      m.tri3(
        { x: a.x, y: a.y, z: a.z + zBase },
        { x: b.x, y: b.y, z: b.z + zBase },
        { x: c.x, y: c.y, z: c.z + zBase },
      );
    }
    return;
  }

  for (const s of solidsOf(floor)) {
    if (s.kind === 'item' && opt.includeItems === false) continue;
    if (s.kind === 'glass' && opt.includeGlass === false) continue;
    const key = s.kind === 'wall' ? (s.ext ? 'wallExt' : 'wall') : s.kind;
    get(key).extrude(G.ensureCCW(s.quad), s.z0 + zBase, s.z1 + zBase);
  }
  const thick = opt.slabThick ?? 120;        // 地板與天花同一個厚度
  if (opt.includeFloor !== false) {
    for (const sl of slabsOf(rooms, thick)) get('floor').extrude(sl.poly, sl.z0 + zBase, sl.z1 + zBase);
  }
  if (opt.includeCeiling !== false) {
    for (const sl of ceilingsOf(rooms, floor.height || 2800, thick)) {
      get('ceil').extrude(sl.poly, sl.z0 + zBase, sl.z1 + zBase);
    }
  }
}

/**
 * 單一樓層。
 * @param {object} opt { name, floorName, includeFloor=true, includeItems=true }
 */
export function buildDAE(floor, rooms, opt = {}) {
  const meshes = {};
  collect(meshes, floor, rooms, opt);
  return assemble(meshes, opt);
}

/** 全案：各層依樓高往上堆疊成一份模型 */
export function buildDAEAll(project, roomsByFloor, opt = {}) {
  const meshes = {};
  const thick = opt.slabThick ?? 120;
  let z = 0;
  const last = project.floors.length - 1;
  project.floors.forEach((floor, i) => {
    // 中間樓層不放天花：上一層的地板樓板就是這一層的天花，
    // 兩片都放會完全重合（Z-fighting），只有最頂層才需要自己的天花。
    collect(meshes, floor, roomsByFloor[i] || [], { ...opt, includeCeiling: i === last && opt.includeCeiling !== false }, z);
    z += (floor.height || 2800) + thick;    // 樓高 + 樓板厚
  });
  return assemble(meshes, { ...opt, name: project.name, floorName: '全案' });
}

/** 匯出前的統計，讓 UI 可以先顯示三角面數 */
export function daeStats(floor, rooms, opt = {}) {
  const meshes = {};
  collect(meshes, floor, rooms, opt);
  let tris = 0, parts = 0;
  for (const m of Object.values(meshes)) { tris += m.triCount; parts++; }
  return { tris, parts };
}
