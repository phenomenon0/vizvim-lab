// Imagine surface: Frame. Two hands hold a director's frame (thumb + index "L"s, other fingers folded) for FK.hold seconds ->
// a floating pane: a rotated rectangle on a camera-facing plane at the hands' depth. Pushing it away shrinks it.
// Fallback spawn (pframe, same surface): both hands pinch at least PFK.minSpan apart and hold STILL for PFK.hold -> a pane as
// wide as the gap between the pinches (height PFK.aspect of that, turned to the line between them). It does not need the "L"
// classifier. Pulling the pinches apart instead makes a Box (box.js), so stillness is what picks the frame.
// One-hand spawn (dframe, same surface; the phone path): pinch, DRAG out a rectangle (the pinch start is one corner, the pinch the
// opposite one), then hold still DFK.hold -> born; it keeps resizing with the pinch until the fingers open. "Brush = hold then
// drag, Frame = drag then hold": a pinch that sat still first is the brush's, one that moved first can only be a frame.
// What makes nothing: a drag shorter than DFK.minW x DFK.minH (a beat, a 1D slide), a path that wanders (longer than DFK.wander
// times the diagonal), a drag with no pause at the end, anything while the other hand is arriving or pinching.
import { unproject, centreHu, scaleHu, rot2, toHu, SK, present } from './geom.js';
export const FK = { hold: 0.5, grace: 0.15, folded: 0.45, index: 0.3, strict: 0.55, minW: 0.12, minH: 0.08 };
const folded = (h) => (h.curl[2] + h.curl[3] + h.curl[4]) / 3 > FK.folded && h.curl[1] < FK.index;   // tells the frame from two open hands (the web)
// signed distance (hu) to a rotated box
export function sdRect(p, c, hb, ang) { const q = rot2([p[0] - c[0], p[1] - c[1]], -ang), dx = Math.abs(q[0]) - hb[0], dy = Math.abs(q[1]) - hb[1]; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0); }
export const PFK = { hold: 0.6, minSpan: 0.3, aspect: 0.62, show: 0.15, pulled: 0.02 };
const frame = {
  id: 'frame', name: 'Frame', code: 1, pinchy: false, hands: 2, behind: true,
  spawn: { gesture: 'both hands: make a frame, hold',
    detect(st, mgr, scr) {
      const F = st.two.frame, L = st.L, R = st.R, t = st.t, A = st.aspect, f = st.focal;
      const ok = F.on && mgr.ready(L) && mgr.ready(R) && present(L) && present(R) && !L.pinched && !R.pinched && folded(L) && folded(R) && F.w * A > FK.minW && F.h > FK.minH
        && (scr.born || F.strict > FK.strict);      // to arm, both hands must read as an "L" (two pointing hands do not); once born it only has to stay a frame
      if (ok) { scr.okT = t; if (scr.t0 === undefined) scr.t0 = t; const z = (L.depthM + R.depthM) / 2, k = z / f;
        scr.pose = { c: unproject([F.cx, F.cy], z, f, A), half: [F.w * A / 2 * k, F.h / 2 * k, 0.01], angle: F.angle }; }
      else if (scr.t0 === undefined || t - scr.okT > FK.grace) { scr.t0 = undefined; return null; }
      return { progress: (t - scr.t0) / FK.hold, pose: scr.pose };
    } },
  seed: (c, k) => ({ c, half: [0.085 * k, 0.06 * k, 0.01], angle: -0.06 }),
  hit(s, p, f, A) { const k = scaleHu(s, f); return sdRect(p, centreHu(s, f, A), [s.half[0] * k, s.half[1] * k], s.angle); },
  uniforms() { return { d: [0, 0, 0, 0] }; },
  glsl: /* glsl */`
float sf_frame(int i, vec2 p, out vec2 suv, out float z) {
  vec2 q = sfRot(p - sfCentre(i), -uSfB[i].w), hb = uSfC[i].xy; float r = min(0.014, 0.16 * min(hb.x, hb.y));   // rounded corners
  vec2 dd = abs(q) - hb + r, g = max(dd, 0.0), sg = vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0);
  suv = q / max(hb, vec2(1e-4)); z = uSfB[i].z;
  sfN = sfRot((g.x + g.y > 0.0 ? normalize(g) : (dd.x > dd.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0))) * sg, uSfB[i].w);
  return length(g) + min(max(dd.x, dd.y), 0.0) - r;
}`,
};
export const pframe = { ...frame, id: 'pframe', fn: 'sf_frame', pinchy: true, hint: false,      // (its text lives in the playtest script; the legend has six rows)
  spawn: { gesture: 'both hands: pinch apart, hold still',
    detect(st, mgr, scr) {
      const F = mgr.free, t = st.t, A = st.aspect, f = st.focal;
      if (F.length !== 2 || mgr.scr.box?.born) { scr.t0 = undefined; scr.key = null; return null; }
      const [a, b] = F[0].pinchPoint3[0] <= F[1].pinchPoint3[0] ? F : [F[1], F[0]], pa = a.pinchPoint3, pb = b.pinchPoint3, qa = toHu(a.pinchPoint, A), qb = toHu(b.pinchPoint, A);
      const v = [pb[0] - pa[0], pb[1] - pa[1]], z = (pa[2] + pb[2]) / 2, hx = Math.max(Math.hypot(v[0], v[1]) / 2, 0.012);
      const pose = { c: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, z], half: [hx, hx * PFK.aspect, 0.01], angle: Math.atan2(v[1], v[0]) };
      if (scr.born) return { progress: 1, pose };
      const span = Math.hypot(qb[0] - qa[0], qb[1] - qa[1]), key = a.id + ',' + b.id;
      if (scr.key !== key) { scr.key = key; scr.t0 = undefined; scr.s0 = span; scr.off = false; }
      scr.s0 = Math.min(scr.s0, span); if (span - scr.s0 > PFK.pulled) scr.off = true;      // they are pulling apart: that is a Box, for as long as this pair of pinches lasts
      if (scr.off) return null;
      const moved = scr.t0 === undefined || Math.hypot(qa[0] - scr.a[0], qa[1] - scr.a[1]) > SK.still || Math.hypot(qb[0] - scr.b[0], qb[1] - scr.b[1]) > SK.still;
      if (moved || span < PFK.minSpan || a.gap > SK.looseGap || b.gap > SK.looseGap) { scr.t0 = t; scr.a = qa; scr.b = qb; }       // not still: the hold starts over
      if (t - scr.t0 < PFK.show) return null;
      return { progress: (t - scr.t0) / PFK.hold, pose };
    } } };
export const DFK = { minW: 0.16, minH: 0.1, hold: 0.4, show: 0.08, wander: 1.6, slack: 0.06, maxT: 3, arrive: 0.8, otherSpeed: 0.6 };   // hu, hu, s, hu, x, hu, s, s, hu / s
export const dframe = { ...frame, id: 'dframe', fn: 'sf_frame', pinchy: true, hands: 1, hintOrder: -1,
  spawn: { gesture: 'one hand: pinch, drag a corner, hold',
    detect(st, mgr, scr) {
      const F = mgr.free, t = st.t, A = st.aspect, f = st.focal, h = F.length === 1 ? F[0] : null;
      if (!h || (scr.id && scr.id !== h.id) || mgr.scr.box?.born || mgr.scr.pframe?.born || mgr.scr.brush?.born) { scr.id = null; return null; }
      const p = toHu(h.pinchPoint, A);
      if (!scr.id) { scr.id = h.id; scr.p0 = p; scr.t0 = t; scr.z = h.depthM; scr.len = 0; scr.last = p; scr.q = p; scr.stillT = t; scr.dead = false; }
      if (scr.dead) return null;
      const dx = p[0] - scr.p0[0], dy = p[1] - scr.p0[1], k = scr.z / f, hx = Math.max(Math.abs(dx) / 2, 0.02), hy = Math.max(Math.abs(dy) / 2, 0.02);
      const pose = { c: unproject([(scr.p0[0] + dx / 2) / A, scr.p0[1] + dy / 2], scr.z, f, A), half: [hx * k, hy * k, 0.01], angle: 0 };
      if (scr.born) { if (h.gap <= SK.looseGap) scr.pose = pose; return { progress: 1, pose: scr.pose || pose }; }
      if (mgr.scr.brush?.armed) { scr.dead = true; return null; }                                        // it sat still first: that pinch is a brush
      scr.len += Math.hypot(p[0] - scr.last[0], p[1] - scr.last[1]); scr.last = p;
      const diag = Math.hypot(dx, dy);
      if (scr.len > DFK.wander * diag + DFK.slack || t - scr.t0 > DFK.maxT) { scr.dead = true; return null; }      // wandering, or taking for ever: not a drag
      if (Math.hypot(p[0] - scr.q[0], p[1] - scr.q[1]) > SK.still || h.gap > SK.looseGap) { scr.q = p; scr.stillT = t; }
      if (st.hands.some(o => o !== h && o.live && (o.age < DFK.arrive || o.speed > DFK.otherSpeed || o.pinched))) scr.stillT = t;   // the other hand is on its way: no birth
      if (diag < DFK.show) return null;
      const sized = Math.abs(dx) >= DFK.minW && Math.abs(dy) >= DFK.minH;
      return { progress: sized ? Math.min(1, 0.25 + 0.75 * (t - scr.stillT) / DFK.hold) : 0.25 * Math.min(1, Math.abs(dx) / DFK.minW, Math.abs(dy) / DFK.minH), pose };
    } } };
export default frame;
