// Imagine surface: Brush. One hand pinches in empty space, HOLDS STILL for BRK.dwell (a small ring fills at the pinch), then
// drags -> a painted stroke that shows the look. Born after BRK.minDrag of travel from where it armed; the stroke grows until
// the pinch ends, then pinned.
// The stroke (premium pass): the pinch path is sampled every BRK.step with a PRESSURE (a slow, tight pinch presses hard = wide;
// a fast or loosening one skates = thin), smoothed (two 1-2-1 passes), resampled evenly along its length to at most SK.npts
// points and tapered (it lands at BRK.land of its width and lifts off to a point over the last BRK.lift of its length). The
// shader draws it as a chain of round cones with a dry-brush edge (bristle streaks that separate toward the tail), not a tube.
// What makes nothing: a pinch that moves before it has armed (talking hands, a missed grab, a hand on its way somewhere; that
// drag belongs to the one-hand Frame), a pinch that never moves, and any pinch while the other hand is arriving (younger than
// BRK.arrive, moving faster than BRK.otherSpeed, or pinched itself). A second pinch before the stroke is born makes a Box or a
// Frame, never a stroke.
import { unproject, ptsHu, toHu, scaleHu, SK } from './geom.js';
export const BRK = { dwell: 0.35, show: 0.1, arrive: 0.8, otherSpeed: 0.6, minDrag: 0.07, step: 0.012, raw: 96, widthM: 0.028,   // s, s, s, hu / s, hu, hu, samples, metres (half width at full pressure)
  slow: 0.3, fast: 1.5, thin: 0.42, loose: 0.8, land: 0.35, landLen: 0.1, lift: 0.3, seg: 0.022 };   // hu / s, hu / s, x, x, x, of length, of length, hu between drawn points
const sm = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// raw samples [[x, y, pressure], ...] -> at most n evenly spaced [x, y, w] with the taper applied (w = 0..1 of the full half width)
export function stroke(R, n = SK.npts, seg = BRK.seg) {
  if (R.length < 2) return R.map(p => [p[0], p[1], p[2] ?? 1]);
  let P = R.map(p => [p[0], p[1], p[2] ?? 1]);
  for (let pass = 0; pass < 2; pass++) P = P.map((p, i) => (i === 0 || i === P.length - 1 ? p : [0, 1, 2].map(j => (P[i - 1][j] + 2 * p[j] + P[i + 1][j]) / 4)));
  const S = [0]; for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = S[S.length - 1], N = Math.max(2, Math.min(n, Math.ceil(L / seg) + 2)), out = []; let j = 0;
  for (let i = 0; i < N; i++) { const u = i / (N - 1), a = u * L; while (j < P.length - 2 && S[j + 1] < a) j++;
    const h = Math.min(1, Math.max(0, (a - S[j]) / Math.max(S[j + 1] - S[j], 1e-9))), q = [0, 1, 2].map(k => P[j][k] + (P[j + 1][k] - P[j][k]) * h);
    q[2] *= (BRK.land + (1 - BRK.land) * sm(u / BRK.landLen)) * (1 - 0.94 * sm((u - (1 - BRK.lift)) / BRK.lift)); out.push(q); }
  return out;
}
// distance (hu) to the stroke's outline: round cones between consecutive points, P = [[x, y, half width], ...]
export function sdStroke(p, P) { let d = 1e9; for (let i = 0; i + 1 < P.length; i++) { const e = [P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]], w = [p[0] - P[i][0], p[1] - P[i][1]];
  const h = Math.min(1, Math.max(0, (w[0] * e[0] + w[1] * e[1]) / Math.max(e[0] * e[0] + e[1] * e[1], 1e-12))); d = Math.min(d, Math.hypot(w[0] - e[0] * h, w[1] - e[1] * h) - (P[i][2] + (P[i + 1][2] - P[i][2]) * h)); } return d; }
export const sdLine = (p, P) => sdStroke(p, P.map(q => [q[0], q[1], 0]));
export default {
  id: 'brush', name: 'Brush', code: 5, pinchy: true, hands: 1, behind: true,
  spawn: { gesture: 'one hand: pinch, hold still, drag',
    detect(st, mgr, scr) {
      const F = mgr.free, t = st.t, A = st.aspect, f = st.focal;
      const h = F.length === 1 ? F[0] : null;
      if (!h || (scr.id && scr.id !== h.id) || mgr.scr.box?.born || mgr.scr.pframe?.born || mgr.scr.dframe?.born) { scr.id = null; scr.P = null; scr.armed = false; return null; }
      const p = toHu(h.pinchPoint, A);
      if (!scr.id) { scr.id = h.id; scr.P = null; scr.armed = false; scr.dead = false; scr.t0 = t; scr.p0 = p; scr.z = h.depthM; }
      if (scr.dead) return null;
      const dot = (prog) => ({ progress: prog, pose: { c: unproject([p[0] / A, p[1]], scr.z, f, A), half: [BRK.widthM * 1.6, BRK.widthM * 1.6, 0.01], angle: 0, pts: [[-0.002, 0, 1], [0.002, 0, 1]] } });
      if (!scr.armed) {
        if (Math.hypot(p[0] - scr.p0[0], p[1] - scr.p0[1]) > SK.still) { scr.dead = true; return null; }            // it moved before it armed: this pinch paints nothing
        if (st.hands.some(o => o !== h && o.live && (o.age < BRK.arrive || o.speed > BRK.otherSpeed || o.pinched))) { scr.t0 = t; return null; }   // the other hand is on its way
        if (t - scr.t0 < BRK.dwell) return t - scr.t0 > BRK.show ? dot((t - scr.t0) / BRK.dwell * 0.9) : null;
        scr.armed = true; scr.P = [[p[0], p[1], 1]]; scr.step = BRK.step; scr.len = 0; scr.w = 1; scr.lt = t;
      }
      const P = scr.P, last = P[P.length - 1], d = Math.hypot(p[0] - last[0], p[1] - last[1]);
      // pressure now: slow + tight = 1, fast = BRK.thin, a loosening pinch = BRK.loose of that. Eased, so the width breathes rather than steps.
      const press = (dd, dtt) => (1 - (1 - BRK.thin) * sm((dd / Math.max(dtt, 1e-3) - BRK.slow) / (BRK.fast - BRK.slow))) * (BRK.loose + (1 - BRK.loose) * (1 - Math.min(1, h.gap / SK.looseGap)));
      if (h.gap <= SK.looseGap && d > scr.step) { scr.w += (press(d, t - scr.lt) - scr.w) * 0.6; scr.lt = t; P.push([p[0], p[1], scr.w]); scr.len += d;
        if (P.length > BRK.raw) { scr.P = P.filter((_, i) => i % 2 === 0 || i === P.length - 1); scr.step *= 2; } }   // out of samples: thin the record, coarser from here
      if (scr.len < BRK.minDrag) return dot(0.95);                                                                  // armed, waiting for the drag
      const R = scr.P.slice(); if (h.gap <= SK.looseGap && d > 1e-4) R.push([p[0], p[1], scr.w]);
      const Q = stroke(R);
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const q of Q) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, k = scr.z / f, pts = Q.map(q => [(q[0] - cx) * k, (q[1] - cy) * k, q[2]]);
      return { progress: 1, pose: { c: unproject([cx / A, cy], scr.z, f, A), half: [Math.max(0.01, (x1 - x0) / 2 * k) + BRK.widthM, Math.max(0.01, (y1 - y0) / 2 * k) + BRK.widthM, 0.01], angle: 0, pts } };
    } },
  // seeded: one gestural stroke, pressed at the start, skating through the middle, lifting off at the end
  seed: (c, k) => { const R = []; for (let i = 0; i < 40; i++) { const u = i / 39, x = (u - 0.5) * 0.25 * k, y = 0.04 * k * Math.sin(u * 5.4 - 0.5) + 0.03 * k * (u - 0.5); R.push([x, y, 0.72 + 0.28 * Math.cos(u * 6.9)]); }
    return { c, half: [0.125 * k + BRK.widthM, 0.055 * k + BRK.widthM, 0.01], angle: 0, pts: stroke(R, SK.npts, 0) }; },
  width(s, f) { return BRK.widthM * (s.half[0] / (s.h0 || s.half[0])) * scaleHu(s, f); },   // hu, at full pressure
  pts(s, f, A) { const W = this.width(s, f); return ptsHu(s, f, A).map(p => [p[0], p[1], (p[2] ?? 1) * W]); },
  hit(s, p, f, A) { const P = this.pts(s, f, A); return P.length >= 2 ? sdStroke(p, P) : 1; },
  uniforms(s, f, A) { const P = this.pts(s, f, A); return { d: [P.length, this.width(s, f), (s.id * 0.3819) % 1, 0], pts: P }; },
  glsl: /* glsl */`
float sf_brush(int i, vec2 p, out vec2 suv, out float z) {
  int b = i * SF_NPTS, n = int(uSfD[i].x + 0.5); float d = 1e9, acc = 0.0, along = 0.0, side = 0.0; vec2 nn = vec2(0.0, 1.0);
  for (int k = 0; k < SF_NPTS - 1; k++) { if (k + 1 >= n) break;
    vec3 P = uSfP[b + k], Q = uSfP[b + k + 1]; vec2 e = Q.xy - P.xy, w = p - P.xy; float L = max(length(e), 1e-5), h = clamp(dot(w, e) / (L * L), 0.0, 1.0);
    vec2 bb = w - e * h; float r = mix(P.z, Q.z, h), lb = length(bb), dk = lb - r;
    if (dk < d) { d = dk; along = acc + h * L; nn = bb / max(lb, 1e-5); side = (e.x * w.y - e.y * w.x) / (L * max(r, 1e-4)); }
    acc += L; }
  suv = (p - sfCentre(i)) / max(uSfC[i].xy, vec2(1e-4)); z = uSfB[i].z; sfN = nn;
  // dry brush: bristle streaks run along the stroke; they part toward its edges and more and more toward the tail
  float u = along / max(acc, 1e-4), W = max(uSfD[i].y, 1e-4);
  float br = texture(uNoiseL, vec2(along / W * 0.0016 + uSfD[i].z, side * 0.024 + uSfD[i].z * 7.0)).r;      // long streaks: ~1 texel per 25 px along, 2 px across
  float fine = texture(uNoiseL, vec2(along / W * 0.006, side * 0.07 + 0.37)).r;
  float th = 0.16 + 0.42 * smoothstep(0.35, 1.0, u) + 0.3 * smoothstep(0.45, 1.0, abs(side));
  sfMask = smoothstep(th - 0.07, th + 0.07, 0.7 * br + 0.3 * fine);
  return d + (fine - 0.5) * 0.12 * W * smoothstep(0.3, 1.0, abs(side));      // a slightly ragged outline
}`,
};
