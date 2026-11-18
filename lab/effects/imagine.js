// Imagine — free play. Hands MAKE surfaces (frame, box, portal, web of three bands, brush stroke); up to four things live at
// once, every surface holding its own look; a fifth retires the oldest.   ?fx=imagine   (&hs=off;track=syn-imagine-three;skel=1 replays a synthetic track)
//   hs options:  seed=frame,box,portal,web,brush   pre-pin surfaces (no hands needed; web = its three bands)
//                looks=crt-teal,risograph,halftone   look order (pool ids)      pool=a,b,c   audit: host only these pool ids
// Gestures, thresholds and the surface registry: lab/handsignal/surfaces/index.js. This file hosts the looks and composites.
// In the app a surface is a "Region" row (a Group that hosts a look, max 4) placed by hand; see breakdowns/hand-signal-v2.md.
//
// How a surface holds a look (premium pass). Every look in POOL is a sibling effect module hosted through the harness
// (`__lab.hostEffect`), so a look may have init() / frame() / its own uniforms / uPrev. What is new is WHAT the look is run on:
//   - not the whole picture but a CROP of it: the union of the footprints of the surfaces showing that look (Surfaces.lookUse:
//     bounding circle * SK.cropPad, never under SK.cropMin of the picture height, same aspect as the picture). The look's
//     passes read the crop (im_cam) wherever they read uCam, and uDepth / uPerson through the same window. So a look's dots,
//     lines and auto-levels are relative to the SURFACE: a small frame gets the same number of halftone dots across as a big
//     one, and a look that levels itself levels over the surface's content, not the room's.
//   - per-surface normalisation: im_st (one texel) keeps the crop's luma and depth range (mean +- 1.7 sigma, eased). Depth is
//     re-ranged to it for every look (Thermal over a far wall still has a gradient to colour); luma is stretched toward it for
//     looks marked `levels` (they have no auto-level of their own).
//   - cost: a look renders ONCE, at V = 0.5 of the picture per side (its passes keep their own scales under that), and only
//     while a surface shows it (handle.on; the parked-program hack is gone). Four surfaces = four looks at a quarter of the
//     pixels each = about one full-frame look in total, where it used to be four.
//   - no pops: a look change cross-fades (SK.xfade) from the previous look, which keeps rendering until the fade is over; the
//     looks a swipe could bring next (the neighbours of a surface a hand rests over or holds) are rendered ahead of time.
//     Those warm looks tick every 4th frame only (enough to keep their feedback state converged).
// A look that cannot be hosted, or whose hosted shader does not compile, is LEFT OUT loudly: console.warn, `leftOut` on the
// module, and the Hand signals panel note lists the pool and what is missing (surfaces never take a left-out look).
// Idle (nothing made yet, no pinch): a demonstration loop draws the one-hand Frame being made (pinch, drag a corner, hold),
// so the default picture shows what the mode is and how to start. It is drawn by the same compositor from a fake slot.
import { Surfaces, TYPES, SK, popScale, settleScale } from '../handsignal/surfaces/index.js';
import { SF_DECL, sfDispatch, SF_COMPOSITE } from '../handsignal/surfaces/glsl.js';
import { HS_DECL, HS_BOX, HS_HUD } from '../handsignal/glsl.js';

const V = 0.5;                 // hosted looks render at this fraction of the picture, per side
const LAB = typeof window !== 'undefined' ? window.__lab : null;
const QHS = typeof location !== 'undefined' ? Object.fromEntries((new URLSearchParams(location.search).get('hs') || '').split(';').map(s => s.split('=')).filter(a => a.length === 2)) : {};
// ride: [param id, value at 0, value at 1, start 0..1]  (the off-surface pinch-drag)      set: fixed overrides of the look's defaults
// levels: 0..1 = stretch the crop's luma toward its own range before the look sees it (looks with no auto-level of their own)
const POOL_ALL = [
  { id: 'halftone', pfx: 'ht', ride: ['cell', 10, 30, 0.22], rideName: 'cell', set: { style: 1, backdrop: 1 }, levels: 0.5 },      // Rosette CMYK: prints dots over a blank wall too; cell is in 1080-wide units of the CROP, so ~50 dots across a surface
  { id: 'depth-thermal', pfx: 'th', name: 'Thermal', ride: ['level', -0.6, 0.6, 0.5], rideName: 'level', set: { soften: 3 } },
  { id: 'cyanotype', pfx: 'cy', ride: ['exposure', -0.8, 0.8, 0.5], rideName: 'exposure', set: { border: 0 }, levels: 0.5 },
  { id: 'crt-teal', pfx: 'crt', ride: ['lines', 50, 200, 0.35], rideName: 'lines', set: { field: 0 }, levels: 0.6 },
  { id: 'risograph', pfx: 'ri', name: 'Riso', ride: ['misreg', 0, 1, 0.4], rideName: 'misregister', levels: 0.8 },
  { id: 'grain-dither', pfx: 'gd', name: 'Dither', ride: ['cell', 4.2, 10, 0.08], rideName: 'cell', levels: 0.8 },     // its error-diffusion grid (1080 / cell
  // cells wide) lives in a half-scale buffer, a quarter of the picture here: below cell 4 the grid no longer fits and the right of the look goes black
  { id: 'tv-scan', pfx: 'tv', ride: ['pitch', 2.4, 9, 0.25], rideName: 'pitch', audit: true },
  { id: 'quadtree', pfx: 'qt', ride: ['detail', 0, 1, 0.55], rideName: 'detail', levels: 0.6, audit: true },
  { id: 'green-bleach', pfx: 'gb', name: 'Bleach', ride: ['threshold', 0, 1, 0.5], rideName: 'threshold', audit: true },
];
const POOL = QHS.pool ? QHS.pool.split(',').map(id => POOL_ALL.find(L => L.id === id)).filter(Boolean) : POOL_ALL.filter(L => !L.audit);
const LOOKS = [], LEFT_OUT = [];
const leaveOut = (L, why) => { if (LEFT_OUT.some(x => x.id === L.id)) return; LEFT_OUT.push({ id: L.id, name: L.name || L.id, why }); console.warn(`[imagine] look ${L.id} LEFT OUT: ${why}`); };

const IM_DECL = /* glsl */`
uniform vec4 uImCrop;          // the window of the picture this look runs on: u0, v0, size (of the picture, both axes), luma stretch 0..1
uniform vec2 uImRes;           // the look's "screen" in pixels (picture * V)
vec4 imCrop(sampler2D s, vec2 uv) { return texture(s, uImCrop.xy + uv * uImCrop.z); }
vec4 imDepth(sampler2D s, vec2 uv) {      // depth through the window, re-ranged to what the window holds
  vec4 d = texture(s, uImCrop.xy + uv * uImCrop.z), st = texelFetch(uBuf_imst, ivec2(0), 0);
  float w = max(st.w - st.z, 0.14); d.r = clamp((d.r - 0.5 * (st.z + st.w)) / w * 0.8 + 0.5, 0.0, 1.0); return d;
}
`;
const IM_PASSES = [
  { name: 'imst', size: [1, 1], feedback: true, filter: 'nearest', frag: /* glsl */`
uniform vec4 uImCrop;
void main() {      // luma and depth range of the window: mean -+ 1.7 sigma over a 10 x 10 grid, eased over ~8 frames
  float sl = 0.0, sl2 = 0.0, sd = 0.0, sd2 = 0.0;
  for (int j = 0; j < 10; j++) for (int i = 0; i < 10; i++) {
    vec2 uv = uImCrop.xy + (vec2(float(i), float(j)) + 0.5) / 10.0 * uImCrop.z;
    float l = dot(texture(uCam, uv).rgb, vec3(0.2126, 0.7152, 0.0722)), d = texture(uDepth, uv).r; sl += l; sl2 += l * l; sd += d; sd2 += d * d;
  }
  sl /= 100.0; sd /= 100.0; float gl = sqrt(max(sl2 / 100.0 - sl * sl, 0.0)), gd = sqrt(max(sd2 / 100.0 - sd * sd, 0.0));
  vec4 now = vec4(sl - 1.7 * gl, sl + 1.7 * gl, sd - 1.7 * gd, sd + 1.7 * gd), prev = texelFetch(uSelf, ivec2(0), 0);
  fragColor = prev.y > prev.x + 1e-4 ? mix(prev, now, 0.12) : now;
}` },
  { name: 'imcam', scale: 1, frag: /* glsl */`
uniform vec4 uImCrop;
void main() {
  vec3 c = texture(uCam, uImCrop.xy + vUv * uImCrop.z).rgb;
  if (uImCrop.w > 0.0) { vec4 st = texelFetch(uBuf_imst, ivec2(0), 0); float w = max(st.y - st.x, 0.42); c = mix(c, clamp((c - 0.5 * (st.x + st.y)) / w * 0.88 + 0.5, 0.0, 1.0), uImCrop.w); }
  fragColor = vec4(c, 1.0);
}` },
];
// a copy of the look's module that reads the crop instead of the picture
function windowed(mod) {
  const rw = (frag) => IM_DECL + String(frag)
    .replace(/\btexture\s*\(\s*uDepth\s*,/g, 'imDepth(uDepth,').replace(/\btexture\s*\(\s*(uPerson|uHandMask)\s*,/g, 'imCrop($1,')
    .replace(/\buCam\b/g, 'uBuf_imcam').replace(/\b(uRes|uCamRes)\b/g, 'uImRes').replace(/\buHandCount\b/g, '0');
  return { ...mod, passes: [...IM_PASSES.map(p => ({ ...p })), ...mod.passes.map(p => ({ ...p, frag: rw(p.frag) }))] };
}
for (const L of POOL) {
  try { const mod = (await import(`./${L.id}.js?v=${Date.now()}`)).default;
    const why = !LAB?.hostEffect ? 'no harness to host it (window.__lab.hostEffect)' : !mod || !Array.isArray(mod.passes) || !Array.isArray(mod.params) ? 'not an effect module'
      : mod.passes.filter(p => p.screen).length !== 1 ? 'needs exactly one screen pass' : mod.hosts?.length ? 'hosts other looks itself'
      : !mod.params.some(p => p.id === L.ride[0]) ? `no param "${L.ride[0]}" to ride` : Object.keys(L.set || {}).find(k => !mod.params.some(p => p.id === k)) ? `no param "${Object.keys(L.set).find(k => !mod.params.some(p => p.id === k))}" to set`
      : (mod.needs || []).some(n => !['hands', 'depth', 'person'].includes(n)) ? `needs ${(mod.needs || []).join(', ')}` : null;
    if (why) { leaveOut(L, why); continue; }
    const h = await LAB.hostEffect(L.id, { prefix: L.pfx, outName: 'lk_' + L.pfx, module: windowed(mod) });
    for (const p of h.passes) if (!p.size) p.scale = (p.scale ?? 1) * V;                    // (the out pass arrives with no scale: V)
    for (const k in (L.set || {})) h.set(k, L.set[k]);
    h.on = false; LOOKS.push({ ...L, mod, h, name: L.name || mod.name, crop: [0, 0, 1] }); }
  catch (e) { leaveOut(L, 'did not load: ' + e.message); }
}

const COMPOSITE = HS_DECL + SF_DECL + /* glsl */`
const vec3 ACC = vec3(0.098, 0.878, 0.784);
uniform vec4 uImHand[2];       // own pinch rings (drawn when the hand-signal HUD is off): pinch point x, y, gap, presence
uniform vec2 uImRole[2];       // 0 idle, 1 holding a surface, 2 riding a param, 3 making one; pinched 0 / 1
uniform vec3 uImCropL[${Math.max(1, LOOKS.length)}];   // per look: the window its buffer covers (u0, v0, size)
uniform vec4 uImDemo;          // idle demonstration: pinch point x, y, gap 0..1, alpha
vec3 sfLook(int k, vec2 uv) {
${LOOKS.map((L, i) => `  if (k == ${i}) return texture(${L.h.out}, clamp((uv - uImCropL[${i}].xy) / uImCropL[${i}].z, 0.0, 1.0)).rgb;`).join('\n')}
  return texture(uCam, uv).rgb;
}
` + sfDispatch(TYPES) + SF_COMPOSITE + HS_BOX + HS_HUD + /* glsl */`
void imRing(inout vec3 col, vec2 q, float gap, float on, float fill, float al) {
  float px = 1.0 / uRes.y, r = mix(0.012, 0.03, clamp(gap, 0.0, 1.0));
  col *= 1.0 - 0.3 * al * hsAA(abs(length(q) - r), 2.6 * px);                                // a dark under-stroke: the ring reads on a white wall too
  hsStroke(col, abs(length(q) - r), mix(0.9 * px, 1.5 * px, on), mix(vec3(1.0), ACC, on), al * mix(0.55, 1.0, on));
  hsOver(col, ACC, al * on * fill * hsAA(length(q), 2.2 * px));
}
// the same ghost skeleton and pinch rings the hand-signal HUD draws, for when no config is on (hs=off / replayed tracks)
vec3 imHands(vec3 col, vec2 uv) {
  float px = 1.0 / uRes.y, lw = 0.9 * px; vec2 A = vec2(uRes.x / uRes.y, 1.0), p = uv * A;
  if (uHSSkel > 0.003) for (int h = 0; h < 2; h++) {
    int b = h * 21; float pr = uHSLm[b].z * uHSSkel; if (pr < 0.01) continue;
    float d = 1e3;
    for (int f = 0; f < 5; f++) {
      int k = b + 1 + f * 4;
      if (f == 0 || f == 1 || f == 4) d = min(d, hsSeg(p, uHSLm[b].xy * A, uHSLm[k].xy * A));
      for (int j = 0; j < 3; j++) d = min(d, hsSeg(p, uHSLm[k + j].xy * A, uHSLm[k + j + 1].xy * A));
      if (f > 0 && f < 4) d = min(d, hsSeg(p, uHSLm[k].xy * A, uHSLm[k + 4].xy * A));
    }
    hsStroke(col, d, lw, vec3(1.0), 0.6 * pr);
    for (int i = 0; i < 21; i++) hsOver(col, vec3(1.0), 0.9 * pr * hsAA(length(p - uHSLm[b + i].xy * A), 1.9 * px));
  }
  for (int h = 0; h < 2; h++) {
    vec4 H = uImHand[h]; if (H.w < 0.01) continue;
    imRing(col, p - H.xy * A, H.z, uImRole[h].y, step(0.5, uImRole[h].x), H.w);
  }
  return col;
}
void main() {
  vec3 cam = texture(uCam, vUv).rgb;
  vec3 col = sfComposite(cam, vUv, u_dim, u_border, u_occlude);
  if (uHSHud < 0.5) col = imHands(col, vUv);
  if (uImDemo.w > 0.003) imRing(col, (vUv - uImDemo.xy) * vec2(uRes.x / uRes.y, 1.0), uImDemo.z, 1.0 - smoothstep(0.3, 0.6, uImDemo.z), 1.0, uImDemo.w);
  fragColor = vec4(hsHud(col, vUv), 1.0);
}`;

let mgr = null, lastT = -1, seeded = false, lastScene = 0, idle = 1, checked = false, tick = 0;
const ROLE = { grab: 1, ride: 2, free: 3, none: 0 };
const ss = (a, b, x) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
// The idle demonstration: a 5.2 s loop of the one-hand Frame. Returns the fake slot (packed like Surfaces.uniforms) + the ring.
const DEMO = { p0: [0.335, 0.75], p1: [0.665, 0.29], len: 5.2 };
function demo(t, A, look, behind) {
  const ph = ((t % DEMO.len) + DEMO.len) % DEMO.len, drag = ss(0.45, 1.5, ph), born = 2.0, pin = 2.6, out = 1 - ss(4.5, 5.1, ph), inn = ss(0.0, 0.25, ph);
  const q = [DEMO.p0[0] + (DEMO.p1[0] - DEMO.p0[0]) * drag, DEMO.p0[1] + (DEMO.p1[1] - DEMO.p0[1]) * drag];
  const v = ph >= born ? popScale((ph - born) / SK.pop) * (ph >= pin ? settleScale((ph - pin) / SK.settle) : 1) : 1;
  const c = [(DEMO.p0[0] + q[0]) / 2, (DEMO.p0[1] + q[1]) / 2], hb = [Math.abs(q[0] - DEMO.p0[0]) / 2 * A * v, Math.abs(q[1] - DEMO.p0[1]) / 2 * v];
  const state = ph < born ? 2 : ph < pin ? 1 : 0, prog = ph < 1.5 ? 0.25 * drag : Math.min(1, 0.25 + 0.75 * (ph - 1.5) / (born - 1.5));
  const show = drag > 0.12 ? 1 : 0, gap = ph < pin ? 1 - ss(0.15, 0.4, ph) : ss(pin, pin + 0.25, ph);
  return { A: [show, look, out * show, state], B: [c[0], c[1], 0.6, 0], C: [hb[0], hb[1], prog, 0], E: [0.1, 0.1, 0.01, 0],
    F: [behind ? ss(pin, pin + SK.behind, ph) : 0, ph >= born && ph < pin ? 1 : ph >= pin ? 1 - ss(pin, pin + SK.liftDown, ph) : 0, 0, 0],
    G: [0, 0, ph >= pin ? Math.max(0, 1 - (ph - pin) / SK.glint) : 0, Math.hypot(hb[0], hb[1]) * 1.05 + 0.01],
    ring: [q[0], q[1], gap, inn * (ph < pin + 0.5 ? 1 : 0) * (1 - ss(pin + 0.2, pin + 0.5, ph)) * out],
    foot: [(DEMO.p0[0] + DEMO.p1[0]) / 2, (DEMO.p0[1] + DEMO.p1[1]) / 2, Math.hypot((DEMO.p1[0] - DEMO.p0[0]) / 2 * A, (DEMO.p1[1] - DEMO.p0[1]) / 2)] };
}
// first frame with compiled programs: a hosted pass without a program = its shader did not compile -> that look is left out
function audit() {
  const P = LAB?.state?.passes; if (!Array.isArray(P) || !P.length || !mgr) return false;
  LOOKS.forEach((L, i) => { const names = L.h.passes.map(p => p.name);
    const bad = P.find(r => !r.prog && names.some(n => r.def?.name === n || String(r.def?.name).endsWith('_' + n)));
    if (bad) { leaveOut(L, `pass "${bad.def.name}" did not compile`); mgr.banned.add(i); L.h.on = false; L.dead = true; } });
  return true;
}

const M = {
  id: 'imagine', name: 'Imagine', ownsHands: true,
  ref: null,
  needs: ['hands', 'depth', 'person'],
  params: [
    { id: 'dim', label: 'Outside dim', type: 'float', min: 0, max: 0.8, default: 0.22 },
    { id: 'border', label: 'Glass edge', type: 'float', min: 0, max: 1, default: 0.75 },
    { id: 'occlude', label: 'Behind you', type: 'bool', default: true },
    { id: 'scene', label: 'Scene', type: 'enum', options: ['Free', 'Seed 3', 'Clear'], default: 0 },
  ],
  passes: [...LOOKS.flatMap(L => L.h.passes), { name: 'out', screen: true, frag: COMPOSITE }],
  looks: LOOKS.map(L => L.id), lookNames: LOOKS.map(L => L.name), leftOut: LEFT_OUT, hostedPasses: LOOKS.reduce((n, L) => n + L.h.passes.length, 0), running: 0, lookScale: V,
  async init() { for (const x of LEFT_OUT.filter(x => /did not compile/.test(x.why))) LEFT_OUT.splice(LEFT_OUT.indexOf(x), 1);
    mgr = new Surfaces(LOOKS.map(L => ({ id: L.id, name: L.name, param: L.rideName, def: L.ride[3] }))); lastT = -1; seeded = false; lastScene = 0; idle = 1; checked = false;
    for (const L of LOOKS) { L.dead = false; L.h.on = false; try { await L.h.init(); } catch (e) { leaveOut(L, 'init() threw: ' + e.message); L.dead = true; } }
    LOOKS.forEach((L, i) => { if (L.dead) mgr.banned.add(i); }); },
  frame(ctx) {
    const H = typeof window !== 'undefined' ? window.__hs : null, st = H?.last?.st, o = H?.opts || {}, A = ctx.res[0] / ctx.res[1], P = ctx.params || {};
    if (!mgr) { mgr = new Surfaces(LOOKS.map(L => ({ id: L.id, name: L.name, param: L.rideName, def: L.ride[3] }))); }
    if (!checked) checked = audit();
    mgr.behind = !(P.occlude === false || P.occlude === 0);
    // how much of a surface the person covers (0..1; null = no matte yet): a 5 x 5 grid over the inner 70 % of its bounding box.
    // Asked once per pin (not per frame, not per pixel): natively a 25-texel read of the matte, or a 1 x 1 reduction pass.
    mgr.cover = (s) => { const D = ctx.person; if (!D || !D.has || !D.data) return null; const o = s.out || s, k = (st?.focal || 1.2) / o.c[2], AA = st?.aspect || A;
      const cu = 0.5 + o.c[0] * k / AA, cv = 0.5 + o.c[1] * k, hu = o.half[0] * k / AA * 0.7, hv = o.half[1] * k * 0.7; let n = 0;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) { const x = Math.min(D.w - 1, Math.max(0, Math.round((cu + hu * (i / 2 - 1)) * D.w))), y = Math.min(D.h - 1, Math.max(0, Math.round((cv + hv * (j / 2 - 1)) * D.h))); if (D.data[y * D.w + x] > 0.5) n++; }
      return n / 25; };
    const dt = st?.dt ?? ctx.dt ?? 1 / 60; let reset = false;
    if (st) {
      if (st.t < lastT - 1e-4 || st.t - lastT > 1) { mgr.reset(); seeded = false; reset = true; }       // a seek: start over
      if (!seeded) { seeded = true; if (o.looks) mgr.setOrder(String(o.looks).split(',')); if (o.seed) mgr.seed(String(o.seed).split(','), st.aspect || A, st.focal); }
      const sc = Math.round(P.scene || 0);
      if (sc !== lastScene) { lastScene = sc; if (sc >= 1) mgr.clear(); if (sc === 1) mgr.seed(['frame', 'box', 'portal'], st.aspect || A, st.focal); }
      if (st.t !== lastT) mgr.update(st);
      lastT = st.t; H.imagine = mgr.publish();
    }
    const f = st?.focal || 1.2, AA = st?.aspect || A, u = { ...mgr.uniforms(f, AA), uSfFocal: f };
    const hand = new Float32Array(8), role = new Float32Array(4);
    if (st) [st.L, st.R].forEach((T, i) => { if (!T) return; const r = mgr.roles[T.id]?.role;
      hand.set([T.pinchPoint[0], T.pinchPoint[1], T.gap, T.presence * (T.pinched || T.gap < 0.6 ? 1 : 0.0)], i * 4); role.set([ROLE[r] || 0, T.pinched ? 1 : 0], i * 2); });
    u.uImHand = hand; u.uImRole = role;
    const use = mgr.lookUse(f, AA);
    // idle: nothing made, nobody pinching -> the demonstration (eases in after a clear, is simply there after a seek / at load)
    const busy = mgr.list.length > 0 || (st ? st.hands.some(h => h.live && h.pinched) : false) || o.demo === '0';
    idle = reset || lastT < 0 ? (busy ? 0 : 1) : Math.min(1, Math.max(0, idle + (busy ? -dt / 0.25 : dt / 1.2)));
    u.uImDemo = [0, 0, 1, 0];
    if (idle > 0.003 && LOOKS.length && !mgr.list.length) {
      const look = mgr.freeLook(), d = demo(st?.t ?? ctx.time ?? 0, AA, look, mgr.behind);
      d.A[2] *= idle; ['A', 'B', 'C', 'E', 'F', 'G'].forEach(k => u['uSf' + k].set(d[k], 0)); u.uImDemo = [d.ring[0], d.ring[1], d.ring[2], d.ring[3] * idle];
      const sz = Math.min(1, Math.max(SK.cropMin, 2 * d.foot[2] * SK.cropPad));
      use.set(look, { crop: [Math.min(1 - sz, Math.max(0, d.foot[0] - sz / 2)), Math.min(1 - sz, Math.max(0, d.foot[1] - sz / 2)), sz], warm: false });
    }
    const cropL = new Float32Array(Math.max(1, LOOKS.length) * 3); let on = 0; tick++;
    LOOKS.forEach((L, i) => {
      // a warm look (not shown, a swipe could bring it next) renders every 4th frame: enough to keep its feedback passes
      // (auto-levels, cell state) converged, a quarter of the cost; the 0.45 s cross-fade covers what is left
      const e = use.get(i); L.h.on = !!e && !L.dead && (!e.warm || (tick + i) % 4 === 0); if (e) L.crop = e.crop; if (L.h.on) on++;
      cropL.set(L.crop, i * 3);
      const [id, a, b] = L.ride; L.h.set(id, a + (b - a) * mgr.val[i]);
      Object.assign(u, L.h.frame());
      u[`uImCrop_${L.pfx}`] = [L.crop[0], L.crop[1], L.crop[2], L.levels || 0]; u[`uImRes_${L.pfx}`] = [ctx.res[0] * V, ctx.res[1] * V];
    });
    u.uImCropL = cropL; M.running = on; M.use = [...use].map(([i, e]) => ({ look: LOOKS[i]?.id, crop: e.crop, warm: e.warm }));
    return u;
  },
};
export default M;
