// hand-region — shared by hand-webs.js and prism.js (not an effect: no default export, reindex skips it).
// One region = up to four quads strung between matching fingertips of two hands; each quad is a window onto a look.
// In the app this is one Group/Region with shapes Webs / Ribbon / Box hosting any look; the lab's two modules are
// two presets of it. Three parts:
//   trackRegion()  CPU: ten points. Hand-to-side assignment by continuity, occlusion-robust tips (chirality +
//                  palm-frame hold on low-score frames), 0.25 s hold through tracking dropouts, critically damped
//                  follow, retract when a hand really leaves, one-hand fan, raised-finger latch, draw order.
//   REGION_GLSL    shader: uniforms + inverse bilinear + anti-aliased coverage and edge line per quad.
//   hostSlots()    look slots: built-in GLSL looks by name, or ANY lab effect id hosted through the harness's
//                  __lab.hostEffect (its passes, params, init/frame run under a prefix).

export const TIP5 = [4, 8, 12, 16, 20], BASE5 = [2, 5, 9, 13, 17];
const MIRR5 = [4, 20, 16, 12, 8];
export const FINGER_SETS = [[0, 1, 2, 3, 4], [0, 1, 2, 4]];     // Adjacent (thumb..pinky) | Skip ring (the prism reel)
export const FINGER_SET_NAMES = ['Adjacent', 'Skip ring'];
const HOLD = 0.25;      // s a lost hand's corners stay where they were before the region lets go
const MEMORY = 1.0;     // s a lost hand's side is remembered for re-assignment

// ---------------------------------------------------------------- look slots
// ids: look names per quad. builtin: { name: glsl expression of `uv` }. Unknown names are hosted lab effects.
// Returns { ids, exprs, hosted, passes, needs, init(), frame() }; spread passes before your own, call init/frame.
export async function hostSlots(ids, builtin, { tag = 'region', deny = ['hand-webs', 'prism'], fallback } = {}) {
  const exprs = [], hosted = [], seen = new Map();
  const names = Object.keys(builtin), fb = fallback || ((i) => builtin[names[i % names.length]]);
  const lab = typeof window !== 'undefined' ? window.__lab : null;
  for (const id of ids) {
    if (id in builtin) { exprs.push(builtin[id]); continue; }
    if (seen.has(id)) { exprs.push(seen.get(id)); continue; }
    try {
      if (deny.includes(id)) throw new Error('a region cannot host a region');
      if (!lab || !lab.hostEffect) throw new Error('harness has no hostEffect');
      const h = await lab.hostEffect(id, { prefix: `rg${hosted.length}` });
      hosted.push(h);
      const e = `texture(${h.out}, uv).rgb`; seen.set(id, e); exprs.push(e);
    } catch (e) { console.warn(`[${tag}] cannot host "${id}": ${e.message}; using a built-in look`); exprs.push(fb(exprs.length)); }
  }
  return {
    ids, exprs, hosted,
    passes: hosted.flatMap((h) => h.passes),
    needs: [...new Set(hosted.flatMap((h) => h.needs || []))],
    async init() { for (const h of hosted) await h.init(); },
    frame() { const u = {}; for (const h of hosted) { try { Object.assign(u, h.frame()); } catch (e) { if (!h.err) console.warn(`[${tag}] ${h.id}.frame threw: ${e.message}`); h.err = true; Object.assign(u, h.uniforms()); } } return u; },
  };
}

// ---------------------------------------------------------------- shader
// p is (vUv.x * aspect, vUv.y). Quad k: a = A_i, b = B_i, c = B_j, d = A_j (i, j = neighbouring fingers; A, B = hands).
// st.x runs hand A -> hand B, st.y finger i -> finger j. cov = anti-aliased coverage. line = hairline on the four
// sides: full strength on the two finger-to-finger strings, sideK on the two hand-side edges; s 0..1 sets its width.
export const REGION_GLSL = /* glsl */`
uniform vec2 uRgQ[16];
uniform vec4 uRgP[4];     // x = quad index (thumb web = 0), y = alpha
uniform float uRgN;
const vec3 RG_LINE = vec3(0.965, 0.975, 0.975);
float rgCrs(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
vec2 rgInvBil(vec2 p, vec2 a, vec2 e, vec2 f, vec2 g, out bool ok) {
  vec2 h = p - a;
  float k2 = rgCrs(g, f), k1 = rgCrs(e, f) + rgCrs(h, g), k0 = rgCrs(h, e);
  ok = true;
  float v0, v1;
  if (abs(k2) < 1e-4 * abs(k1) + 1e-9) { v0 = v1 = -k0 / k1; }
  else {
    float w = k1 * k1 - 4.0 * k0 * k2;
    if (w < 0.0) { ok = false; return vec2(-1.0); }
    w = sqrt(w); float ik = 0.5 / k2;
    v0 = (-k1 - w) * ik; v1 = (-k1 + w) * ik;
  }
  vec2 d0 = e + v0 * g, d1 = e + v1 * g;
  float u0 = dot(h - v0 * f, d0) / max(dot(d0, d0), 1e-12), u1 = dot(h - v1 * f, d1) / max(dot(d1, d1), 1e-12);
  vec2 r0 = vec2(u0, v0), r1 = vec2(u1, v1);
  vec2 o0 = max(max(-r0, r0 - 1.0), 0.0), o1 = max(max(-r1, r1 - 1.0), 0.0);
  return (o0.x + o0.y <= o1.x + o1.y) ? r0 : r1;
}
bool rgQuad(int k, vec2 p, float s, float sideK, out vec2 st, out float cov, out float line) {
  vec2 a = uRgQ[4 * k], b = uRgQ[4 * k + 1], c = uRgQ[4 * k + 2], d = uRgQ[4 * k + 3];
  cov = 0.0; line = 0.0; st = vec2(0.0);
  vec2 lo = min(min(a, b), min(c, d)) - 0.01, hi = max(max(a, b), max(c, d)) + 0.01;
  if (p.x < lo.x || p.y < lo.y || p.x > hi.x || p.y > hi.y) return false;
  vec2 e = b - a, f = d - a, g = a - b + c - d;
  bool ok; st = rgInvBil(p, a, e, f, g, ok);
  if (!ok) return false;
  vec2 Pu = e + st.y * g, Pv = f + st.x * g;           // patch tangents -> pixel distances to the four edges
  float J = abs(rgCrs(Pu, Pv)) * uRes.y;
  float su = J / max(length(Pv), 1e-6), sv = J / max(length(Pu), 1e-6);
  float dU = min(st.x, 1.0 - st.x) * su, dV = min(st.y, 1.0 - st.y) * sv;
  cov = clamp(min(dU, dV) + 0.5, 0.0, 1.0);
  float lw = (0.55 + 0.75 * s) * max(uRes.x / 1080.0, 0.75);
  float sL = (1.0 - smoothstep(lw - 0.6, lw + 0.6, abs(dV))) * clamp(dU + 1.0, 0.0, 1.0);
  float hL = (1.0 - smoothstep(lw - 0.6, lw + 0.6, abs(dU))) * clamp(dV + 1.0, 0.0, 1.0);
  line = max(sL, hL * sideK);
  return true;
}`;

// ---------------------------------------------------------------- CPU: ten points
const mkPts = () => Array.from({ length: 5 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, z: 0 }));
const mkSide = () => ({ pts: mkPts(), tgt: null, base: null, c: null, lost: 9, h: null, chir: 0, off: [], have: false });
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function step(pts, tgt, om, dt, snap) {
  for (let i = 0; i < 5; i++) {
    const s = pts[i], t = tgt[i];
    if (snap) { s.x = t.x; s.y = t.y; s.vx = s.vy = 0; s.z = t.z; continue; }
    let rem = dt;
    while (rem > 1e-5) {                              // critically damped, semi-implicit Euler, <= 4 ms substeps
      const h = Math.min(rem, 0.004); rem -= h;
      s.vx += (om * om * (t.x - s.x) - 2 * om * s.vx) * h; s.vy += (om * om * (t.y - s.y) - 2 * om * s.vy) * h;
      s.x += s.vx * h; s.y += s.vy * h;
    }
    s.z += (t.z - s.z) * Math.min(1, dt * 8);
  }
}
// Occlusion-robust fingertips (x in aspect units). When a hand is half hidden MediaPipe's score drops (~0.6) and
// the finger order can come back mirrored (index <-> pinky), or single tips land far from the hand. The hand's
// chirality in the image is tracked while the score is good; a low-score frame whose chirality disagrees is read
// with mirrored ids. While confident, each tip's offset in the palm frame (origin wrist, axis wrist -> middle
// knuckle, unit = that length) is remembered; on a low-score frame a tip more than 0.45 palm lengths from its
// remembered place is replaced by the remembered one. A real palm / back flip arrives with a good score and re-learns.
export function robustTips(H, S, asp) {
  const lm = H.lm, ox = lm[0].x * asp, oy = lm[0].y;
  let ux = lm[9].x * asp - ox, uy = lm[9].y - oy; const len = Math.hypot(ux, uy) || 1e-4; ux /= len; uy /= len;
  const score = H.score == null ? 1 : H.score, good = score >= 0.85;
  const ch = Math.sign((lm[5].x * asp - ox) * (lm[17].y - oy) - (lm[5].y - oy) * (lm[17].x * asp - ox));
  if (good) S.chir = S.chir * 0.9 + ch;
  const mirrored = !good && Math.abs(S.chir) > 3 && ch !== Math.sign(S.chir), ids = mirrored ? MIRR5 : TIP5;
  const rel = (t) => { const dx = lm[t].x * asp - ox, dy = lm[t].y - oy; return [(dx * ux + dy * uy) / len, (-dx * uy + dy * ux) / len]; };
  const out = ids.map((t) => ({ x: lm[t].x * asp, y: lm[t].y, z: lm[t].z || 0 }));
  if (good) {
    ids.forEach((t, i) => { const r = rel(t); S.off[i] = S.have ? [S.off[i][0] + (r[0] - S.off[i][0]) * 0.5, S.off[i][1] + (r[1] - S.off[i][1]) * 0.5] : r; });
    S.have = true;
  } else if (S.have) {
    ids.forEach((t, i) => {
      const r = rel(t);
      if (Math.hypot(r[0] - S.off[i][0], r[1] - S.off[i][1]) > 0.45) {
        const a = S.off[i][0] * len, b = S.off[i][1] * len;
        out[i] = { x: ox + a * ux - b * uy, y: oy + a * uy + b * ux, z: lm[t].z || 0 };
      }
    });
  }
  return out;
}

// o: { n quads 1..4, set index into FINGER_SETS, trail 0..1, oneHand bool, curl bool, order 'fixed' | 'depth' }
// Returns { uRgQ, uRgP, uRgN } and leaves st.rg (alpha, sides) for the caller to read.
export function trackRegion(ctx, st, o = {}) {
  const asp = ctx.res ? ctx.res[0] / ctx.res[1] : 16 / 9;
  const dt = Math.min(0.1, Math.max(1e-3, ctx.dt || 1 / 60));
  const fresh = !st.rg || ctx.frame < st.rg.frame || Math.abs(ctx.time - st.rg.time) > 0.5;
  if (fresh) st.rg = { side: [mkSide(), mkSide()], alpha: 0, ext: [1, 1, 1, 1, 1], up: [1, 1, 1, 1, 1], order: null, first: true };
  const w = st.rg, S = w.side; w.frame = ctx.frame; w.time = ctx.time;
  const hands = (ctx.hands || []).filter((h) => h && h.lm).slice(0, 2);

  // which hand is which side: continuity with the remembered palm centres, never the tracker's slot order
  const asg = [null, null], mem = [0, 1].filter((s) => S[s].c);
  if (hands.length === 2) {
    let sw;
    if (mem.length === 2) sw = d2(hands[0].center, S[1].c) + d2(hands[1].center, S[0].c) < d2(hands[0].center, S[0].c) + d2(hands[1].center, S[1].c);
    else if (mem.length === 1) { const near = d2(hands[0].center, S[mem[0]].c) <= d2(hands[1].center, S[mem[0]].c) ? 0 : 1; sw = near !== mem[0]; }
    else sw = hands[0].center[0] > hands[1].center[0];                   // first sight: left hand in the picture = side 0
    asg[0] = hands[sw ? 1 : 0]; asg[1] = hands[sw ? 0 : 1];
  } else if (hands.length === 1) {
    const h = hands[0];
    if (mem.length === 2) asg[d2(h.center, S[0].c) <= d2(h.center, S[1].c) ? 0 : 1] = h;
    else if (mem.length === 1) asg[d2(h.center, S[mem[0]].c) < 0.35 * 0.35 ? mem[0] : 1 - mem[0]] = h;
    else asg[0] = h;
  }
  for (let s = 0; s < 2; s++) {
    const sd = S[s], h = asg[s]; sd.h = h;
    if (h) {
      sd.tgt = robustTips(h, sd, asp);
      sd.base = BASE5.map((i) => ({ x: h.lm[i].x * asp, y: h.lm[i].y, z: h.lm[i].z || 0 }));
      sd.c = [h.center[0], h.center[1]]; sd.lost = 0;
    } else { sd.lost = Math.min(sd.lost + dt, 9); if (sd.lost > MEMORY) sd.c = null; }
    sd.active = !!sd.tgt && sd.lost < HOLD;        // a short tracking miss: corners stay put, nothing fades
  }
  const one = !!o.oneHand, both = S[0].active && S[1].active, any = S[0].active || S[1].active;
  const alphaT = both || (any && one) ? 1 : 0;
  const born = w.first || w.alpha < 0.01;           // nothing on screen: appear on the hands, no fly-in
  const om = 70 - 50 * Math.min(Math.max(o.trail ?? 0.3, 0), 1);          // 14 ms .. 50 ms time constant
  for (let s = 0; s < 2; s++) {
    const sd = S[s], ot = S[1 - s];
    const T = sd.active ? sd.tgt : ot.active ? (one ? ot.base : ot.tgt) : null;   // a hand that left: its corners retract to the other hand
    if (T) step(sd.pts, T, om, dt, born);
  }
  w.alpha += (alphaT - w.alpha) * (w.first ? 1 : Math.min(1, dt / (alphaT > w.alpha ? 0.08 : 0.16)));
  w.first = false;

  // a quad exists only while its two fingers are held out on the visible hands (curl from the 3D world landmarks,
  // latched so there are no half-open quads). Thumb counts as always out.
  for (let i = 1; i < 5; i++) {
    let e = 9, n = 0;
    for (const sd of S) {
      const h = sd.h; if (!h) continue; n++;
      const L = h.world && h.world.length > 20 ? h.world : Array.from({ length: 21 }, (_, q) => ({ x: h.lm[q].x * asp, y: h.lm[q].y, z: 0 }));
      const D = (i0, i1) => Math.hypot(L[i0].x - L[i1].x, L[i0].y - L[i1].y, (L[i0].z || 0) - (L[i1].z || 0));
      e = Math.min(e, D(TIP5[i], 0) / Math.max(1e-6, D(BASE5[i], 0)));
    }
    if (!o.curl) w.up[i] = 1; else if (n) w.up[i] = born ? +(e > 1.4) : e > 1.5 ? 1 : e < 1.3 ? 0 : w.up[i];
    w.ext[i] += (w.up[i] - w.ext[i]) * (born ? 1 : Math.min(1, dt * 12));
  }

  const set = FINGER_SETS[Math.min(Math.max(Math.round(o.set ?? 0), 0), FINGER_SETS.length - 1)];
  const n = Math.max(1, Math.min(set.length - 1, Math.round(o.n ?? 3)));
  let order = Array.from({ length: n }, (_, s) => n - 1 - s);           // fixed: thumb quad on top, drawn last
  if (o.order === 'depth') {
    const z = (k) => (S[0].pts[set[k]].z + S[0].pts[set[k + 1]].z + S[1].pts[set[k]].z + S[1].pts[set[k + 1]].z) / 4;
    const sorted = [...order].sort((a, b) => z(b) - z(a));              // farther first
    // keep the last order unless some pair is clearly the other way round (no flicker from depth noise)
    const prev = w.order && w.order.length === n ? w.order : sorted;
    let keep = true;
    for (let i = 0; i < n - 1 && keep; i++) for (let j = i + 1; j < n; j++) if (z(prev[j]) - z(prev[i]) > 0.012) { keep = false; break; }
    order = keep ? prev : sorted;
  }
  w.order = order;
  const Q = new Array(32).fill(0), P = new Array(16).fill(0);
  order.forEach((k, s) => {
    const i = set[k], j = set[k + 1], c = [S[0].pts[i], S[1].pts[i], S[1].pts[j], S[0].pts[j]];
    c.forEach((pt, q) => { Q[s * 8 + q * 2] = pt.x; Q[s * 8 + q * 2 + 1] = pt.y; });
    P[s * 4] = k; P[s * 4 + 1] = w.alpha * Math.min(w.ext[i], w.ext[j]);
  });
  return { uRgQ: Q, uRgP: P, uRgN: n };
}
