// hand-wipe — the look-switching system of DecGDxGue_s.
// Measured from the six switches (frames 77-89, 198-214, 299-313, 420-434, 534-547, 637-649):
//  * it is NOT a linear wipe following hand x. The new look opens as a disc centred on the palm
//    and grows to cover the frame: front radius ~75 px/frame at 60 fps (about 4.2 frame-widths/s),
//    whole switch 12-14 frames (0.20-0.23 s), front softness ~150 px (20-80 %) at 1080 wide.
//  * the outgoing image is displaced while it dies (scanlines bend into arcs round the palm, the
//    green look's black border curls 30-80 px inward): a displace driven by the same growing matte.
//  * trigger: the hand sweeps across the frame, comes to rest open, and ~0.4-0.6 s after it settles
//    the switch fires from where the palm is. Order is fixed: clean, depth, teal, thermal, dither, green.
// Pixels are all shader; the gesture state machine (a dozen scalars) runs in frame().

import depthMap from './depth-map.js';
import depthThermal from './depth-thermal.js';
import crtTeal from './crt-teal.js';
import grainDither from './grain-dither.js';
import greenBleach from './green-bleach.js';

// Embed a sibling look as buffer passes of this module: its params become consts at their defaults,
// its buffers get a prefix, its screen pass becomes the buffer uBuf_<pfx>.
const hex3 = (h) => { const n = parseInt(String(h).replace('#', ''), 16); return `vec3(${((n >> 16) / 255).toFixed(4)}, ${(((n >> 8) & 255) / 255).toFixed(4)}, ${((n & 255) / 255).toFixed(4)})`; };
function embed(mod, pfx) {
  const consts = mod.params.map((p) => p.type === 'color' ? `const vec3 u_${p.id} = ${hex3(p.default)};` : `const float u_${p.id} = ${(+p.default).toFixed(5)};`).join('\n') + '\n';
  const names = mod.passes.filter((p) => !p.screen).map((p) => p.name);
  return mod.passes.map((p) => {
    let frag = p.frag;
    for (const n of names) frag = frag.replace(new RegExp(`uBuf_${n}\\b`, 'g'), `uBuf_${pfx}${n}`);
    const { screen, ...rest } = p;
    return { ...rest, name: screen ? pfx : pfx + p.name, frag: consts + frag };
  });
}

export const LOOKS = ['Clean', 'Depth', 'Teal CRT', 'Thermal', 'Dither', 'Green'];

// ---------------------------------------------------------------- gesture (pure, unit-testable)
export function makeGesture(look = 0) {
  return { look, from: look, q: 1, origin: [0.5, 0.5], swipe: [0, 0], dx: 0, dy: 0, slowT: 0, armed: 0, still: 0, cool: 0, lost: 0, fires: 0 };
}
const lerp = (a, b, t) => a + (b - a) * t;
// inp: { on, c:[x,y] uv, v:[vx,vy] uv/s, open 0..1 }   opt: { sens 0..1, aspect w/h, dur s, n looks }
// Speeds/distances are in frame-widths so a vertical sweep counts the same as a horizontal one.
export function gestureStep(s, inp, dt, opt) {
  const sens = opt.sens ?? 0.5, n = opt.n ?? LOOKS.length;
  const vHi = lerp(1.4, 0.5, sens);        // a sweep peaks at least this fast (widths/s)
  const travelMin = lerp(0.24, 0.06, sens); // ...and nets at least this far in one direction
  const latMin = lerp(0.16, 0.05, sens);    // ...and the gesture as a whole travelled this far sideways (a raise does not)
  const vMove = 0.45;                        // "in motion"
  const vLo = 0.30;                         // "came to rest"
  const dwell = 0.20;                       // rest must hold this long, palm open
  const openMin = 0.55;
  let fired = false;
  s.cool = Math.max(0, s.cool - dt);
  if (s.q < 1) s.q = Math.min(1, s.q + dt / Math.max(opt.dur ?? 0.28, 0.03));
  if (!inp || !inp.on) {
    s.lost += dt;
    if (s.lost > 0.25) { s.dx = s.dy = 0; s.lat = 0; s.armed = 0; s.still = 0; }
    return fired;
  }
  if (s.lost > 0) { s.seen = 0; s.lost = 0; }
  s.seen = (s.seen || 0) + dt;
  const vx = inp.v[0], vy = inp.v[1] / (opt.aspect || 1.78), sp = Math.hypot(vx, vy);
  // a tracker teleport (identity swap, re-detect) is not a sweep; nor is a hand still arriving in frame
  if (sp > 9 || s.seen < 0.25) { s.dx = s.dy = 0; s.lat = 0; s.peak = 0; s.armed = 0; s.still = 0; return fired; }
  // a stroke = continuous motion above vMove; it counts as a sweep if it nets travelMin and peaked above vHi
  // a reversal starts a new stroke (down-then-up must not cancel to zero)
  if (sp > vMove && Math.hypot(s.dx, s.dy) > 0.03 && vx * s.dx + vy * s.dy < 0) { s.dx = s.dy = 0; s.peak = 0; }
  if (sp > vMove) { s.dx += vx * dt; s.dy += vy * dt; s.lat = (s.lat || 0) + Math.abs(vx) * dt; s.peak = Math.max(s.peak || 0, sp); s.slowT = 0; }
  else { s.slowT += dt; if (s.slowT > 0.2 && s.armed <= 0) { s.dx = s.dy = 0; s.lat = 0; s.peak = 0; } }
  const net = Math.hypot(s.dx, s.dy);
  if (s.cool <= 0 && s.q >= 1 && net >= travelMin && (s.peak || 0) >= vHi && (s.lat || 0) >= latMin) {
    s.armed = 0.9;                          // must settle within this window or the sweep is forgotten
    s.swipe = [s.dx / net, s.dy / net];
    s.stroke = [s.dx, s.dy];
  }
  if (s.armed > 0) {
    s.armed -= dt;
    if (sp < vLo && inp.open >= openMin) s.still += dt; else s.still = 0;
    if (s.still >= dwell) {
      s.from = s.look; s.look = (s.look + 1) % n; s.q = 0; s.origin = [inp.c[0], inp.c[1]];
      s.armed = 0; s.still = 0; s.dx = s.dy = 0; s.lat = 0; s.peak = 0; s.cool = 0.6; s.fires++; fired = true;
    } else if (s.armed <= 0) { s.dx = s.dy = 0; s.lat = 0; s.peak = 0; s.still = 0; }
  }
  return fired;
}

// ---------------------------------------------------------------- shaders
const COMMON = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// One shader, six looks: every look is its sibling module embedded at its defaults (see embed()), so the wipe
// shows exactly what the standalone effects show (depth-map brings its own temporal pass and scale hold).
const LOOK = (idExpr) => COMMON + /* glsl */ `
vec3 lookClean(vec2 uv){ return texture(uCam, uv).rgb; }
vec3 lookDepth(vec2 uv){ return texture(uBuf_dm, uv).rgb; }
vec3 lookTeal(vec2 uv){ return texture(uBuf_ct, uv).rgb; }
vec3 lookThermal(vec2 uv){ return texture(uBuf_th, uv).rgb; }
vec3 lookDither(vec2 uv){ return texture(uBuf_gd, uv).rgb; }
vec3 lookGreen(vec2 uv){ return texture(uBuf_gb, uv).rgb; }
void main(){
  int id = int(${idExpr} + 0.5);
  vec3 c;
  if (id == 0) c = lookClean(vUv);
  else if (id == 1) c = lookDepth(vUv);
  else if (id == 2) c = lookTeal(vUv);
  else if (id == 3) c = lookThermal(vUv);
  else if (id == 4) c = lookDither(vUv);
  else c = lookGreen(vUv);
  fragColor = vec4(c, 1.0);
}`;

const OUT = COMMON + /* glsl */ `
vec2 mir(vec2 u){ return 1.0 - abs(1.0 - mod(u, 2.0)); }
float front(float r, float R, float w){ return 1.0 - smoothstep(R - w, R, r); }
// Displaced fetch. Past the frame edge the image continues mirrored, and the edge itself is a thin
// black line (the reference's frame line): where the ring magnifies, that line swells into the
// curling black border / "eye" seen in the reference. on = 0 at rest so a still frame has no line.
vec3 fetch(sampler2D t, vec2 u, float on){
  float asp = uRes.x / uRes.y;
  vec2 b = vec2(0.0035, 0.0035 * asp);
  vec2 e = min(abs(u), abs(u - 1.0));
  vec2 fw = min(fwidth(u), vec2(0.02));
  vec2 l = 1.0 - smoothstep(b, b + fw + 1e-5, e);
  vec2 inr = step(-b, u) * step(u, 1.0 + b);
  float line = max(l.x * inr.y, l.y * inr.x);
  return mix(texture(t, mir(u)).rgb, vec3(0.0), line * on);
}
void main(){
  if (uQ >= 1.0) { fragColor = vec4(texture(uBuf_lb, vUv).rgb, 1.0); return; }
  float asp = uRes.x / uRes.y;
  vec2 d = (vUv - uOrigin) * vec2(1.0, 1.0 / asp);          // frame-width units
  float r = length(d); vec2 n = d / max(r, 1e-4);
  // farthest corner from the palm, so the disc always clears the frame at q = 1
  vec2 far = max(uOrigin, 1.0 - uOrigin) * vec2(1.0, 1.0 / asp);
  float w = u_soft;
  // Beyond (Seam): the front inherits the sweep - it runs ahead along the direction the hand was moving.
  float lead = 1.0 + 0.25 * u_seam * dot(n, uSwipe);
  // measured: the outer edge is already ~0.11 widths out on the first frame, then ~0.078 widths per 60 fps frame
  float R = (0.045 + uQ * (length(far) + w - 0.045)) / (1.0 - 0.25 * u_seam) * lead;
  // the first frame is all warp: the incoming look only starts to show from the second frame
  float m = front(r, R, w) * smoothstep(0.02, 0.13, uQ);
  // The warp, as measured on the reference (see breakdowns/hand-wipe.md): ONE travelling ring, not a
  // lens and not feedback. Radial displacement D(r) = k*h*tent((r - Rc)/h): a tent of half-width h
  // riding just inside the outer edge. Sampling goes OUTWARD by D, so on the ring's outer flank the
  // source radius is k*R + (1-k)*r: for k near 1 every pixel of the flank reads almost the same
  // circle -> straight rays / stretched faces / moire rings from scanlines; on the inner flank the
  // image is squeezed by (1+k). k starts near 1 and decays as the ring travels.
  float h = 0.17;
  float Rc = R - h;
  float ang = atan(n.y, n.x);
  float wob = 1.0 + 0.10 * sin(ang * 3.0 + uOrigin.x * 17.0) + 0.06 * sin(ang * 5.0 - uOrigin.y * 23.0);
  float k = 1.55 * u_warp * (1.0 - smoothstep(0.35, 0.8, uQ)) * wob;   // slope at the ring's outer edge
  // outer flank: half-width h. inner flank: stretched all the way back to the palm, so the centre
  // keeps a mild squeeze (the fine rings around the hand) until the ring has left the frame
  float x = (r - Rc) / (r > Rc ? h : max(h, Rc));
  float D = 0.5 * k * h * max(0.0, 1.0 - x * x);
  vec2 off = n * vec2(1.0, asp) * D;
  float on = smoothstep(0.0, 0.004, D);
  vec2 uvS = vUv + off;
  // the black frame line exists only on the Green look (it is that look's own border in the reference)
  float gA = on * step(4.5, uLookA), gB = on * step(4.5, uLookB);
  vec3 A = fetch(uBuf_la, uvS, gA), B = fetch(uBuf_lb, uvS, gB);
  vec3 col = mix(A, B, m);
  if (u_seam > 0.0) {
    // dispersion: each channel's front sits at a slightly different radius -> a prismatic lip
    float dR = 0.022 * u_seam;
    vec3 mm = vec3(front(r, R + dR, w * 0.8), m, front(r, R - dR, w * 0.8));
    vec2 kk = n * vec2(1.0, asp) * 0.02 * u_seam * 4.0 * m * (1.0 - m);
    vec3 A2 = vec3(fetch(uBuf_la, uvS - kk, gA).r, A.g, fetch(uBuf_la, uvS + kk, gA).b);
    vec3 B2 = vec3(fetch(uBuf_lb, uvS - kk, gB).r, B.g, fetch(uBuf_lb, uvS + kk, gB).b);
    col = mix(A2, B2, mm);
    // thin lit lip on the leading edge, coloured by what is arriving
    float lip = smoothstep(0.0, 1.0, 1.0 - abs(r - (R - w * 0.12)) / (w * 0.16));
    col += lip * lip * u_seam * 0.55 * (1.0 - smoothstep(0.8, 1.0, uQ)) * (0.35 + B2);
  }
  fragColor = vec4(col, 1.0);
}`;

const DECL = 'uniform float uLookA; uniform float uLookB; uniform float uQ; uniform vec2 uOrigin; uniform vec2 uSwipe;\n';

let G = null, lastLookParam = -1;

export default {
  id: 'hand-wipe',
  name: 'Hand Wipe',
  ref: { clip: 'DecGDxGue_s', t: [4.95, 5.2] },
  needs: ['depth', 'hands', 'person'],
  depthBlend: 1,
  params: [
    { id: 'look', label: 'Look', type: 'enum', options: LOOKS, default: 1 },
    { id: 'speed', label: 'Speed', type: 'float', min: 0.08, max: 0.9, default: 0.28 },
    { id: 'soft', label: 'Soft', type: 'float', min: 0.02, max: 0.8, default: 0.42 },
    { id: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'sens', label: 'Sensitivity', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'seam', label: 'Seam', type: 'float', min: 0, max: 1, default: 0 },
    // headless / debugging: scrub > 0 pins a transition look -> look+1 at that progress from (ox, oy)
    { id: 'scrub', label: 'Scrub', type: 'float', min: 0, max: 1, default: 0, more: true },
    { id: 'ox', label: 'Origin X', type: 'float', min: 0, max: 1, default: 0.5, more: true },
    { id: 'oy', label: 'Origin Y', type: 'float', min: 0, max: 1, default: 0.5, more: true },
    { id: 'sx', label: 'Sweep X', type: 'float', min: -1, max: 1, default: 0, more: true },
  ],
  passes: [
    ...embed(depthMap, 'dm'), ...embed(depthThermal, 'th'),
    ...embed(crtTeal, 'ct'), ...embed(grainDither, 'gd'), ...embed(greenBleach, 'gb'),
    { name: 'la', frag: DECL + LOOK('uLookA') },
    { name: 'lb', frag: DECL + LOOK('uLookB') },
    { name: 'out', frag: DECL + OUT, screen: true },
  ],
  init() { G = null; lastLookParam = -1; },
  frame(ctx) {
    const P = ctx.params || {}, hs = ctx.hands || [];
    const carve = depthMap.frame ? depthMap.frame(ctx) : {};          // the embedded depth look's own uniform
    // which hand gestures: stay with the current one; hand over only while idle, to a hand that is clearly sweeping
    // (the tracker's slot order is arbitrary with two hands). Identity = nearest palm centre to the last one.
    let h0 = hs[0];
    if (hs.length > 1 && G) {
      const asp = (ctx.res || [16, 9])[0] / (ctx.res || [16, 9])[1];
      const sp = (h) => Math.hypot(h.vel[0], h.vel[1] / asp), dc = (h) => G.hc ? Math.hypot(h.center[0] - G.hc[0], h.center[1] - G.hc[1]) : 0;
      const cur = dc(hs[0]) <= dc(hs[1]) ? hs[0] : hs[1], oth = cur === hs[0] ? hs[1] : hs[0];
      h0 = (G.armed <= 0 && sp(oth) > 0.45 && sp(cur) < 0.3) ? oth : cur;
      if (h0 !== cur) { G.dx = G.dy = 0; G.lat = 0; G.peak = 0; G.still = 0; }
    }
    if (h0 && G) G.hc = [h0.center[0], h0.center[1]];
    const look = Math.round(P.look ?? 0);
    if (!G) G = makeGesture(look);
    if (look !== lastLookParam) { if (lastLookParam !== -1 || G.look !== look) { G.look = G.from = look; G.q = 1; } lastLookParam = look; }
    if ((P.scrub ?? 0) > 0) {
      return { ...carve, uLookA: look, uLookB: (look + 1) % LOOKS.length, uQ: Math.min(P.scrub, 0.9999), uOrigin: [P.ox ?? 0.5, P.oy ?? 0.5], uSwipe: [P.sx ?? 0, 0] };
    }
    const res = ctx.res || [16, 9];
    const inp = h0 ? { on: true, c: [h0.center[0], h0.center[1]], v: [h0.vel[0], h0.vel[1]], open: h0.open } : { on: false };
    gestureStep(G, inp, Math.min(ctx.dt ?? 1 / 60, 0.1), { sens: P.sens ?? 0.5, aspect: res[0] / res[1], dur: P.speed ?? 0.28 });
    return { ...carve, uLookA: G.from, uLookB: G.look, uQ: G.q, uOrigin: G.origin, uSwipe: G.swipe };
  },
};
