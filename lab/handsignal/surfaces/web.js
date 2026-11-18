// Imagine surface: Web. Three quads strung between the two hands' fingertips, thumb / index / middle / ring (MediaPipe 4, 8, 12, 16):
// quad k has corners  A[k], B[k], B[k+1], A[k+1]  (A = one hand's tips, B = the other's), the geometry of lab/effects/hand-webs.js
// (breakdowns/hand-webs.md). It is DRAWN as one membrane with three look bands (no pane edges, no shadow seams, the strings of
// hand-webs.js on the finger-to-finger edges) but KEPT as three surfaces, one per band, each with its own look, so a folded
// finger can pin the bands that used it. The three share a group, so a web counts as one
// thing against the cap, and a new web retires what is left of the old one (three of the six looks is all a web may hold).
//
// Spawn (deliberate, unlike the always-on effect): both hands open, index / middle / ring fingertips TOUCHING for WK.dwell,
// then pulled apart by WK.pull over at least WK.stretch. A tap, or hands flying apart from a steeple, makes nothing.
// While it lives the eight points follow the fingertips through a critically damped spring (the reel's trail). A quad exists
// only while both of its fingers are raised on both hands (latched, WK.up / WK.down): folding a finger PINS the quads that
// used it where they were just before it began to fold; fists, a pinch, or a hand leaving pins whatever is left. A pinned quad is an ordinary surface.
import { unproject, ptsHu, toHu, sdPoly, present } from './geom.js';
export const WK = { touch: 0.1, clear: 0.025, dwell: 0.3, pull: 0.1, stretch: 0.35, maxSpeed: 1.3, maxSpan: 0.5, grace: 0.15,
  up: 0.3, down: 0.5, clean: 0.2, start: 0.15, back: 0.5,     // a folding finger drags its tip in before it counts as folded: its points stop
                                                 // following once it curls (start above its straightest, or up) and go back to where they were while it was last straight (< clean, within back s)
            // normalised curl: a finger is raised below up, folded above down (kept in between)
  om: 55 };                      // rad / s, critically damped follow (hand-webs: 70 - 50 * trail, trail 0.3)
let GID = 1;
function follow(S, T, dt, snap, hold) {                  // semi-implicit Euler, <= 4 ms substeps (hand-webs step())
  for (let i = 0; i < T.length; i++) { const s = S[i], t = T[i]; if (hold && hold[i % 4]) { s[2] = s[3] = 0; continue; } if (snap) { s[0] = t[0]; s[1] = t[1]; s[2] = s[3] = 0; continue; }
    for (let rem = Math.min(dt, 0.1); rem > 1e-5;) { const h = Math.min(rem, 0.004); rem -= h;
      s[2] += (WK.om * WK.om * (t[0] - s[0]) - 2 * WK.om * s[2]) * h; s[3] += (WK.om * WK.om * (t[1] - s[1]) - 2 * WK.om * s[3]) * h; s[0] += s[2] * h; s[1] += s[3] * h; } }
}
const stop = (W) => { W.phase = 'idle'; W.born = false; W.prog = 0; };
// the shared state of the web being made, advanced once per frame whichever quad asks first
function tick(st, mgr) {
  const W = mgr.shared.web || (mgr.shared.web = { phase: 'idle', up: [1, 1, 1, 1], done: [0, 0, 0], pts: Array.from({ length: 8 }, () => [0, 0, 0, 0]), prog: 0, born: false });
  if (W.t === st.t) return W; W.t = st.t;
  const L = st.L, R = st.R, t = st.t, A = st.aspect;
  const ok = mgr.ready(L) && mgr.ready(R) && present(L) && present(R) && !L.pinched && !R.pinched;
  if (!ok) { if (W.phase !== 'idle' && t - W.okT > WK.grace) stop(W); return W; }      // a short dropout: hold the last pose
  for (let i = 1; i < 4; i++) { const c = Math.max(L.curl[i], R.curl[i]); W.up[i] = c < WK.up ? 1 : c > WK.down ? 0 : W.up[i]; }
  const all = W.up[1] && W.up[2] && W.up[3];
  const tl = [0, 1, 2, 3].map(i => toHu(L.tips[i], A)), tr = [0, 1, 2, 3].map(i => toHu(R.tips[i], A));
  const near = (Math.hypot(tl[1][0] - tr[1][0], tl[1][1] - tr[1][1]) + Math.hypot(tl[2][0] - tr[2][0], tl[2][1] - tr[2][1]) + Math.hypot(tl[3][0] - tr[3][0], tl[3][1] - tr[3][1])) / 3;
  const sp = W.near === undefined || !(st.dt > 0) ? 0 : (near - W.near) / st.dt; W.sp = (W.sp || 0) + (sp - (W.sp || 0)) * 0.5; W.near = near;
  let snap = false;
  if (W.phase === 'idle') { if (!all || near > WK.touch) return W; W.phase = 'touch'; W.t0 = t; W.pullT = t; W.arm = near; W.gid = GID++; W.done = [0, 0, 0]; W.born = false; W.prog = 0; W.sp = 0; snap = true; }
  W.okT = t;
  if (!W.born) {
    W.arm = Math.min(W.arm, near);
    if (near <= W.arm + WK.clear) W.pullT = t;                                         // still touching
    const dwell = Math.min(1, (W.pullT - W.t0) / WK.dwell);
    if (!all || (near > W.arm + WK.clear && dwell < 1) || near > WK.maxSpan || W.sp > WK.maxSpeed) { stop(W); return W; }   // a tap / hands flying apart / a finger folded
    const pull = Math.min((near - W.arm) / WK.pull, (t - W.pullT) / WK.stretch);
    W.prog = 0.3 * dwell + 0.7 * Math.max(0, pull); if (pull >= 1) { W.born = true; W.prog = 1; }
  } else if (W.done[0] && W.done[1] && W.done[2]) { stop(W); return W; }
  const cu = [0, 1, 2, 3].map(i => Math.max(L.curl[i], R.curl[i])); cu[0] = Math.max(cu[0], cu[1]);       // the thumb also goes with the index finger
  if (snap || !W.hold) { W.hold = [0, 0, 0, 0]; W.clean = [null, null, null, null]; W.base = [1, 1, 1, 1]; }
  for (let i = 0; i < 4; i++) { W.base[i] = Math.min(W.base[i], cu[i]); const h = cu[i] > Math.min(WK.up, W.base[i] + WK.start) ? 1 : 0;
    if (h && !W.hold[i] && W.clean[i] && t - W.clean[i].t < WK.back) { const c = W.clean[i]; W.pts[i][0] = c.a[0]; W.pts[i][1] = c.a[1]; W.pts[4 + i][0] = c.b[0]; W.pts[4 + i][1] = c.b[1]; }
    W.hold[i] = h; }
  follow(W.pts, [...tl, ...tr], st.dt, snap, W.hold);
  for (let i = 0; i < 4; i++) if (cu[i] < Math.min(WK.clean, W.base[i] + WK.start / 3)) W.clean[i] = { t, a: [W.pts[i][0], W.pts[i][1]], b: [W.pts[4 + i][0], W.pts[4 + i][1]] };
  W.z = (L.depthM + R.depthM) / 2;
  return W;
}
const quad = (k) => ({
  id: 'web' + k, name: 'Web', code: 4, fn: 'sf_web', pinchy: false, group: 'web', hands: 2, behind: false,
  spawn: { gesture: 'both hands: touch fingertips, hold, pull apart',
    detect(st, mgr) {
      const W = tick(st, mgr); if (W.phase === 'idle' || W.done[k]) return null;
      if (!(k === 0 ? W.up[1] : W.up[k] && W.up[k + 1])) { if (W.born) W.done[k] = 1; return null; }      // a folded finger pins this quad
      const P = W.pts, Q = [P[k], P[4 + k], P[5 + k], P[k + 1]], f = st.focal, A = st.aspect, z = W.z + 0.0005 * k, s = z / f;   // thumb web nearest: drawn on top
      const cx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, cy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
      let hx = 0.004, hy = 0.004; const pts = Q.map(q => { const r = [(q[0] - cx) * s, (q[1] - cy) * s]; hx = Math.max(hx, Math.abs(r[0])); hy = Math.max(hy, Math.abs(r[1])); return r; });
      return { progress: W.born ? 1 : Math.min(0.97, W.prog), pose: { c: unproject([cx / A, cy], z, f, A), half: [hx, hy, 0.01], angle: 0, pts }, group: W.gid };
    } },
  // seeded: the three quads of one web around c, as two open hands facing each other would string it: thumbs low and wide
  // apart, index / middle / ring fanned above them (tips on an arc), hands 2 * w apart
  seed: (c, m) => { const w = 0.1 * m, Y = [-0.085, -0.012, 0.045, 0.092].map(v => -v * m), X = [0.018, 0.0, 0.006, 0.02].map(v => w - v * m), cy = (Y[k] + Y[k + 1]) / 2;
    const pts = [[-X[k], Y[k] - cy], [X[k], Y[k] + 0.006 * m - cy], [X[k + 1], Y[k + 1] + 0.006 * m - cy], [-X[k + 1], Y[k + 1] - cy]];
    return { c: [c[0], c[1] + cy, c[2] + 0.0005 * k], half: [w, Math.abs(Y[k] - Y[k + 1]) / 2 + 0.003 * m, 0.01], angle: 0, pts }; },
  hit(s, p, f, A) { const P = ptsHu(s, f, A); return P.length >= 3 ? sdPoly(p, P) : 1; },
  uniforms(s, f, A) { return { d: [4, 0, 0, 0], pts: ptsHu(s, f, A) }; },
  glsl: /* glsl */`
float sf_web(int i, vec2 p, out vec2 suv, out float z) {
  int b = i * SF_NPTS; float d = 1e9, s = 1.0, px = 1.0 / uRes.y, str = 0.0; vec2 nb = vec2(0.0, 1.0);
  for (int k = 0, j = 3; k < 4; j = k, k++) {
    vec2 P = uSfP[b + k].xy, Q = uSfP[b + j].xy, e = Q - P, w = p - P;
    vec2 bb = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0); float dk = dot(bb, bb);
    if (dk < d) { d = dk; nb = bb; }
    // the strings: finger to finger (edges 0-1 and 2-3) drawn firm, the hand sides (3-0, 1-2) fine  (hand-webs.js)
    float lw = (k == 1 || k == 3) ? 1.15 * px : 0.6 * px, la = (k == 1 || k == 3) ? 1.0 : 0.55;
    str = max(str, la * (1.0 - smoothstep(lw - 0.6 * px, lw + 0.6 * px, sqrt(dk))));
    bvec3 c = bvec3(p.y >= P.y, p.y < Q.y, e.x * w.y > e.y * w.x); if (all(c) || all(not(c))) s = -s;
  }
  suv = (p - sfCentre(i)) / max(uSfC[i].xy, vec2(1e-4)); z = uSfB[i].z;
  sfN = s * nb / max(length(nb), 1e-5); sfAux = str;
  return s * sqrt(d);
}`,
});
export const webs = [quad(0), quad(1), quad(2)];
export default webs;
