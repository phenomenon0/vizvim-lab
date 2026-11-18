// Imagine surface: Portal. A pointing index fingertip traces a closed loop -> a circle fitted to the loop (centroid, mean radius).
// Closed = the tip comes back within PK.close of an earlier point of the trace with at least PK.minPerim of path in between,
// inside PK.window seconds, and the loop is round enough (radial spread / radius < PK.round) and big enough.
// Not a pointing finger that happens to circle while its owner talks: the point pose must have been held PK.arm before the trace
// starts and through all of it, the loop must take at least PK.minT (a quick "and so on" roll is faster) and be PK.minR across.
import { unproject, centreHu, scaleHu, toHu, present } from './geom.js';
export const PK = { window: 3, close: 0.045, minPerim: 0.42, minR: 0.07, maxR: 0.45, round: 0.3, arm: 0.3, minT: 0.7, step: 0.008, show: 0.12, cool: 0.6 };
function fit(P) { let cx = 0, cy = 0; for (const p of P) { cx += p[0]; cy += p[1]; } cx /= P.length; cy /= P.length;
  let r = 0; for (const p of P) r += Math.hypot(p[0] - cx, p[1] - cy); r /= P.length; let v = 0; for (const p of P) v += (Math.hypot(p[0] - cx, p[1] - cy) - r) ** 2;
  let w = 0; for (let i = 1; i < P.length; i++) { let d = Math.atan2(P[i][1] - cy, P[i][0] - cx) - Math.atan2(P[i - 1][1] - cy, P[i - 1][0] - cx); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; w += d; }
  return { c: [cx, cy], r, dev: Math.sqrt(v / P.length) / Math.max(r, 1e-4), wind: Math.abs(w) }; }
export default {
  id: 'portal', name: 'Portal', code: 3, pinchy: false, hands: 1, behind: true,
  spawn: { gesture: 'one hand: point, draw a loop',
    detect(st, mgr, scr) {
      const t = st.t, A = st.aspect, f = st.focal;
      const h = st.hands.find(h => present(h) && h.pose === 'point' && t - h.poseT >= PK.arm && !h.pinched && mgr.ready(h) && (!scr.id || h.id === scr.id)) || null;
      if (!h || t < (scr.cool || 0)) { scr.id = null; scr.pts = null; return null; }
      if (scr.id !== h.id) { scr.id = h.id; scr.pts = []; scr.lost = 0; }
      // the loop is timed on the frames the tracker really saw: time spent held over a dropout does not count, or a dropout
      // would stretch a quick "and so on" roll of the finger into a slow, deliberate loop
      if (h.state === 'hold') scr.lost += st.dt || 0;
      const te = t - scr.lost, P = scr.pts, p = toHu(h.tips[1], A), last = P[P.length - 1];
      if (h.state !== 'hold' && (!last || Math.hypot(p[0] - last.p[0], p[1] - last.p[1]) > PK.step)) P.push({ p, t: te, s: last ? last.s + Math.hypot(p[0] - last.p[0], p[1] - last.p[1]) : 0 });
      while (P.length && te - P[0].t > PK.window) P.shift();
      if (P.length < 6) return null;
      const end = P[P.length - 1], pose = (F) => { const z = h.depthM; return { c: unproject([F.c[0] / A, F.c[1]], z, f, A), half: [F.r * z / f, F.r * z / f, 0.01], angle: 0 }; };
      for (let j = 0; j < P.length - 5; j++) {                    // earliest point the tip has come back to
        if (end.s - P[j].s < PK.minPerim || end.t - P[j].t < PK.minT) break;
        if (Math.hypot(end.p[0] - P[j].p[0], end.p[1] - P[j].p[1]) > PK.close) continue;
        const F = fit(P.slice(j).map(x => x.p));
        if (F.r >= PK.minR && F.r <= PK.maxR && F.dev < PK.round && F.wind > 5.0) { scr.pts = null; scr.id = null; scr.cool = t + PK.cool; return { progress: 1, pose: pose(F), once: true }; }
      }
      if (end.s - P[0].s < PK.show) return null;
      const F = fit(P.map(x => x.p)); if (F.r < 0.02) return null;
      return { progress: Math.min(0.95, F.wind / 6.2832), pose: pose(F) };
    } },
  seed: (c, k) => ({ c, half: [0.075 * k, 0.075 * k, 0.01], angle: 0 }),
  hit(s, p, f, A) { const c = centreHu(s, f, A); return Math.hypot(p[0] - c[0], p[1] - c[1]) - s.half[0] * scaleHu(s, f); },
  uniforms() { return { d: [0, 0, 0, 0] }; },
  glsl: /* glsl */`
float sf_portal(int i, vec2 p, out vec2 suv, out float z) {
  vec2 q = sfRot(p - sfCentre(i), -uSfB[i].w); float r = uSfC[i].x;
  suv = q / max(r, 1e-4); z = uSfB[i].z; sfN = sfRot(q / max(length(q), 1e-5), uSfB[i].w); sfLens = 1.7;      // a thicker lens than a pane
  return length(q) - r;
}`,
};
