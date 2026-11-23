// walk3d.js — 走動視角（第一人稱），純 WebGL、零相依、離線可用
//
// 幾何完全沿用 solid.js 的體塊（跟 3D 簡圖、DAE 匯出同一份），這裡只負責
// 「站在房間裡往四周看」：透視投影、深度測試、簡單的面向明暗與遠處霧化。
import * as G from './geometry.js';
import { solidsOf } from './solid.js';

const EYE = 1500;            // 視線高度 mm
const RADIUS = 180;          // 人的半徑，離牆面至少這麼遠
const SPEED = 1900;          // 走路 mm/s
const TURN = 1.7;            // 轉身 rad/s
const FOV = 72 * Math.PI / 180;

const COLORS = {
  wall: [0.93, 0.92, 0.90], wallExt: [0.86, 0.85, 0.83],
  column: [0.60, 0.62, 0.66], beam: [0.82, 0.76, 0.68], item: [0.79, 0.66, 0.43],
  floor: [0.76, 0.70, 0.62], ceil: [0.97, 0.97, 0.96], glass: [0.62, 0.80, 0.93],
};
const LIGHT = (() => { const v = [0.38, 0.56, 0.74]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

const VS = `
attribute vec3 p; attribute vec4 c; uniform mat4 m;
varying vec4 vc; varying float vd;
void main(){ gl_Position = m * vec4(p, 1.0); vc = c; vd = gl_Position.w; }`;
const FS = `
precision mediump float;
varying vec4 vc; varying float vd; uniform vec3 fog;
void main(){ float f = clamp(vd / 26000.0, 0.0, 0.5); gl_FragColor = vec4(mix(vc.rgb, fog, f), vc.a); }`;

/** 把場景攤成兩包三角形：不透明的、玻璃（要最後畫且混色） */
function buildMesh(floor, rooms) {
  const H = floor.height || 2800;
  const solid = [], glass = [];
  const tri = (dst, a, b, c, col, alpha = 1) => {
    // 面法線 → 明暗。不分正反面（關掉背面剔除），所以取絕對值
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const k = 0.6 + 0.4 * Math.abs(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    // 直立面（牆、柱、家具側面）越靠近地板越暗一點：少了這個，整面牆是同一個顏色，看不出牆腳在哪
    const vert = Math.abs(nz) < 0.5;
    for (const q of [a, b, c]) {
      const g = vert ? k * (0.8 + 0.2 * Math.min(1, Math.max(0, q.z / 2600))) : k;
      dst.push(q.x, q.y, q.z, col[0] * g, col[1] * g, col[2] * g, alpha);
    }
  };
  const quad = (dst, a, b, c, d, col, alpha) => { tri(dst, a, b, c, col, alpha); tri(dst, a, c, d, col, alpha); };
  const P = (p, z) => ({ x: p.x, y: p.y, z });

  const boxes = solidsOf(floor);
  for (const b of boxes) {
    const isGlass = b.kind === 'glass';
    const col = isGlass ? COLORS.glass : b.kind === 'wall' ? (b.ext ? COLORS.wallExt : COLORS.wall) : (COLORS[b.kind] || COLORS.item);
    const dst = isGlass ? glass : solid;
    const al = isGlass ? 0.32 : 1;
    const q = b.quad;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(dst, P(q[i], b.z0), P(q[j], b.z0), P(q[j], b.z1), P(q[i], b.z1), col, al);
    }
    if (!isGlass) {
      quad(dst, P(q[0], b.z1), P(q[1], b.z1), P(q[2], b.z1), P(q[3], b.z1), col, 1);
      if (b.z0 > 1) quad(dst, P(q[0], b.z0), P(q[1], b.z0), P(q[2], b.z0), P(q[3], b.z0), col, 1);
    }
  }

  // 地板與天花：依房間輪廓三角化（L 形之類的凹多邊形也對）
  for (const r of rooms) {
    const poly = G.ensureCCW(r.inner);
    for (const [i, j, k] of G.triangulate(poly)) {
      tri(solid, P(poly[i], 0), P(poly[j], 0), P(poly[k], 0), COLORS.floor);
      tri(solid, P(poly[i], H), P(poly[j], H), P(poly[k], H), COLORS.ceil);
    }
  }
  // 沒有圍成房間的地方也要有地可踩：整張圖底下鋪一片大地板（略低，不跟房間地板打架）
  const pts = [];
  for (const w of floor.walls) pts.push(w.a, w.b);
  const bb = G.bbox(pts);
  if (bb) {
    const m = 3000, z = -6;
    quad(solid, { x: bb.x0 - m, y: bb.y0 - m, z }, { x: bb.x1 + m, y: bb.y0 - m, z }, { x: bb.x1 + m, y: bb.y1 + m, z }, { x: bb.x0 - m, y: bb.y1 + m, z }, [0.66, 0.67, 0.68]);
  }

  // 會擋路的東西：視線高度範圍內的牆與柱。門洞只剩門楣（z0 很高）所以走得過去
  const blockers = boxes.filter((b) => (b.kind === 'wall' || b.kind === 'column') && b.z0 < 1400 && b.z1 > 250).map((b) => b.quad);
  return { solid: new Float32Array(solid), glass: new Float32Array(glass), blockers, bb, boxes };
}

function blocked(p, blockers) {
  for (const q of blockers) {
    if (G.pointInPoly(p, q)) return true;
    for (let i = 0; i < 4; i++) if (G.distToSeg(p, q[i], q[(i + 1) % 4]) < RADIUS) return true;
  }
  return false;
}

const mul4 = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};

/**
 * 建立走動視角。
 * @param {HTMLCanvasElement} cv   主畫面（WebGL）
 * @param {HTMLCanvasElement} map  右上角小地圖（2D），可為 null
 * @returns {{ok:boolean, destroy:Function, hold:Function, teleport:Function}}
 */
export function createWalk(cv, map, floor, rooms) {
  const gl = cv.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })
    || cv.getContext('experimental-webgl', { preserveDrawingBuffer: true });
  if (!gl) return { ok: false, destroy() {}, hold() {}, teleport() {} };

  const mesh = buildMesh(floor, rooms);
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const aP = gl.getAttribLocation(prog, 'p'), aC = gl.getAttribLocation(prog, 'c');
  const uM = gl.getUniformLocation(prog, 'm'), uFog = gl.getUniformLocation(prog, 'fog');
  const mkBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const bufSolid = mkBuf(mesh.solid), bufGlass = mkBuf(mesh.glass);
  const SKY = [0.74, 0.83, 0.91];

  // 起點：最大那間房的中心；沒有房間就站在圖面正中央
  const big = rooms[0];
  const start = big ? big.centroid : mesh.bb ? { x: mesh.bb.cx, y: mesh.bb.cy } : { x: 0, y: 0 };
  const cam = { x: start.x, y: start.y, yaw: Math.PI / 2, pitch: 0 };
  // 起點若剛好卡在牆裡，先不做碰撞，走出來之後才開始擋
  let collide = !blocked(cam, mesh.blockers);

  const keys = new Set();
  const held = { f: 0, t: 0 };       // 螢幕方向鍵：前後、轉向
  let dirty = true, alive = true, last = performance.now();

  const drawMap = () => {
    if (!map || !mesh.bb) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = map.clientWidth, Hh = map.clientHeight;
    if (map.width !== W * dpr) { map.width = W * dpr; map.height = Hh * dpr; }
    const g = map.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, Hh);
    g.fillStyle = 'rgba(250,249,247,.92)'; g.fillRect(0, 0, W, Hh);
    const bb = mesh.bb, pad = 8;
    const s = Math.min((W - pad * 2) / Math.max(bb.w, 1), (Hh - pad * 2) / Math.max(bb.h, 1));
    const X = (x) => W / 2 + (x - bb.cx) * s, Y = (y) => Hh / 2 - (y - bb.cy) * s;
    g.fillStyle = '#3a3a3a';
    for (const b of mesh.boxes) {
      if (b.kind !== 'wall' || b.z0 > 1) continue;
      g.beginPath(); b.quad.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.closePath(); g.fill();
    }
    // 視角扇形 + 人
    const cx = X(cam.x), cy = Y(cam.y), R = 22;
    g.fillStyle = 'rgba(201,169,110,.45)';
    g.beginPath(); g.moveTo(cx, cy);
    g.arc(cx, cy, R, -(cam.yaw + FOV / 2), -(cam.yaw - FOV / 2)); g.closePath(); g.fill();
    g.fillStyle = '#a8843f'; g.beginPath(); g.arc(cx, cy, 4, 0, 7); g.fill();
    map._toModel = (mx, my) => ({ x: bb.cx + (mx - W / 2) / s, y: bb.cy - (my - Hh / 2) / s });
  };

  const draw = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(SKY[0], SKY[1], SKY[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const f = [cp * cy, cp * sy, sp];
    const r = [sy, -cy, 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const e = [cam.x, cam.y, EYE];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const V = new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, e), -dot(u, e), dot(f, e), 1]);
    const near = 40, far = 200000, t = 1 / Math.tan(FOV / 2);
    const Pm = new Float32Array([t / (w / h), 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    gl.uniformMatrix4fv(uM, false, mul4(Pm, V));
    gl.uniform3fv(uFog, SKY);

    const pass = (buf, n) => {
      if (!n) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(gl.TRIANGLES, 0, n);
    };
    gl.disable(gl.BLEND); gl.depthMask(true);
    pass(bufSolid, mesh.solid.length / 7);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    pass(bufGlass, mesh.glass.length / 7);
    gl.depthMask(true);
    drawMap();
  };

  const step = (dx, dy) => {
    const tryAt = (x, y) => {
      if (collide && blocked({ x, y }, mesh.blockers)) return false;
      cam.x = x; cam.y = y;
      if (!collide && !blocked(cam, mesh.blockers)) collide = true;
      return true;
    };
    // 撞牆時沿牆滑行，不要整個卡死
    return tryAt(cam.x + dx, cam.y + dy) || tryAt(cam.x + dx, cam.y) || tryAt(cam.x, cam.y + dy);
  };

  const tick = (now) => {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const has = (...k) => k.some((x) => keys.has(x));
    const fwd = (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0) + held.f;
    const side = (has('d') ? 1 : 0) - (has('a') ? 1 : 0);
    const turn = (has('arrowleft', 'q') ? 1 : 0) - (has('arrowright', 'e') ? 1 : 0) + held.t;
    if (turn) { cam.yaw += turn * TURN * dt; dirty = true; }
    if (fwd || side) {
      const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
      const d = SPEED * dt;
      if (step((c * fwd + s * side) * d, (s * fwd - c * side) * d)) dirty = true;
    }
    if (dirty) { dirty = false; draw(); }
    requestAnimationFrame(tick);
  };

  // 拖曳＝轉頭（抓著畫面拉的手感：往右拖，畫面跟著往右，等於視線往左轉）
  let drag = null;
  const onDown = (e) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); cv.focus?.(); };
  const onMove = (e) => {
    if (!drag) return;
    cam.yaw += (e.clientX - drag.x) * 0.005;
    cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch + (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
    dirty = true;
  };
  const onUp = () => { drag = null; };
  const onWheel = (e) => {
    e.preventDefault();
    const d = e.deltaY < 0 ? 350 : -350;
    if (step(Math.cos(cam.yaw) * d, Math.sin(cam.yaw) * d)) dirty = true;
  };
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  const onKey = (e) => {
    if (e.target?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (!MOVE_KEYS.has(k)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'keydown') keys.add(k); else keys.delete(k);
  };
  const onBlur = () => keys.clear();
  const onMap = (e) => {
    if (!map?._toModel) return;
    const r = map.getBoundingClientRect();
    const p = map._toModel(e.clientX - r.left, e.clientY - r.top);
    cam.x = p.x; cam.y = p.y; collide = !blocked(cam, mesh.blockers); dirty = true;
  };

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', onBlur);
  map?.addEventListener('pointerdown', onMap);
  const ro = new ResizeObserver(() => { dirty = true; });
  ro.observe(cv);
  requestAnimationFrame(tick);

  return {
    ok: true,
    /** 螢幕方向鍵按住／放開：f = 前(+1) 後(-1)，t = 左轉(+1) 右轉(-1) */
    hold(f, t) { held.f = f; held.t = t; },
    teleport(p) { cam.x = p.x; cam.y = p.y; collide = !blocked(cam, mesh.blockers); dirty = true; },
    destroy() {
      alive = false; ro.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
