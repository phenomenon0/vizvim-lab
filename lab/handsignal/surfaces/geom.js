// Imagine surfaces — shared constants and geometry helpers (see index.js for the model).
export const SK = {
  cap: 4, slots: 8, npts: 20,     // things alive at once (a web's three quads count as ONE); shader slots (alive + fading); points per slot (x, y, half width)
  entry: 0.3,                     // s: a hand this young neither spawns nor grabs
  margin: 0.03,                   // hu: a pinch this far outside a surface still grabs it
  swipeMargin: 0.1,               // hu: an open-hand swipe this far outside still counts as "over" it
  fade: 0.25, flyFade: 0.4,       // s alpha ramps: spawn / retire, flick dismiss
  swipeAfterPinch: 0.4,           // s after a pinch ends during which that hand's swipes are ignored
  swipeDwell: 0.25,               // s an open hand must already have been over a pinned surface for its swipe to count (a hand crossing it does not)
  swipeSettle: 1.0,               // s after a surface is pinned / let go during which a swipe over it is ignored
  flick: 1.6,                     // hu / s at release
  depthMove: 0.7,                 // one-hand push / pull gain (monocular depth is the noisiest axis)
  rollDead: 0.07,                 // rad
  looseGap: 0.2,                  // calibrated pinch gap above which a holding hand is "letting go": pose frozen
  rideGain: 2.2,                  // param range per image height of vertical drag
  minHalf: 0.02, maxHalf: 0.9, minZ: 0.18, maxZ: 3,
  still: 0.028,                   // hu: a pinch that stays inside this radius is "held still" (brush arm, pinch frame)
  fPos: [1.0, 6, 1], fExt: [1.0, 4, 1],
  // material + motion (premium pass). All deterministic functions of the surface's own clock.
  pop: 0.34,                      // s: birth scale-in (0.8 -> ~1.03 -> 1)
  settle: 0.4,                    // s: pin "settle" (a 2.8 % dip that rings out) and the glint that crosses the pane
  liftUp: 0.14, liftDown: 0.22,   // s: held / live surfaces lift off the wall (shadow grows and softens), pinned ones sit down
  behind: 0.3,                    // s: a pinned planar surface eases behind the person; any grab brings it back in front
  xfade: 0.45, glint: 0.7, coverFront: 0.3,                    // s: look change cross-fade
  cropPad: 1.12, cropMin: 0.3,    // the look's working rectangle around a surface: bounding circle * pad, never smaller than cropMin of the frame
};
// a hand the tracker has, or lost a moment ago and core is still holding frozen (CONFIG.hold, 0.25 s): a 3-frame dropout must
// not end a grab or abort a gesture half made
export const present = (h) => !!h && (h.state === undefined ? !!h.live : h.state === 'live' || h.state === 'hold');
export const toHu = (uv, A) => [uv[0] * A, uv[1]];
export const project = (c, f, A) => [0.5 + c[0] / c[2] * f / A, 0.5 + c[1] / c[2] * f];           // camera -> vUv
export const unproject = (uv, z, f, A) => [(uv[0] - 0.5) * A / f * z, (uv[1] - 0.5) / f * z, z];  // vUv + depth -> camera
export const rot2 = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
// surface centre in hu, metres -> hu scale at its depth
export const centreHu = (s, f, A) => toHu(project(s.c, f, A), A);
export const scaleHu = (s, f) => f / Math.max(s.c[2], 0.05);
// local plane points (metres) -> hu, with the surface's scale since spawn, angle and centre
export function ptsHu(s, f, A) {
  const c = centreHu(s, f, A), k = scaleHu(s, f) * (s.half[0] / (s.h0 || s.half[0]));
  return (s.pts || []).map(p => { const r = rot2(p, s.angle); return p.length > 2 ? [c[0] + r[0] * k, c[1] + r[1] * k, p[2]] : [c[0] + r[0] * k, c[1] + r[1] * k]; });   // a third component (brush: pressure 0..1) rides along
}
// signed distance (hu) to a closed polygon
export function sdPoly(p, P) { let d = 1e9, s = 1; const n = P.length;
  for (let i = 0, j = n - 1; i < n; j = i, i++) { const e = [P[j][0] - P[i][0], P[j][1] - P[i][1]], w = [p[0] - P[i][0], p[1] - P[i][1]];
    const h = Math.min(1, Math.max(0, (w[0] * e[0] + w[1] * e[1]) / Math.max(e[0] * e[0] + e[1] * e[1], 1e-12))), bx = w[0] - e[0] * h, by = w[1] - e[1] * h; d = Math.min(d, bx * bx + by * by);
    const c1 = p[1] >= P[i][1], c2 = p[1] < P[j][1], c3 = e[0] * w[1] > e[1] * w[0]; if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s; }
  return s * Math.sqrt(d); }
// birth pop: 0.8 at tau = 0, overshoots to about 1.03, 1 from tau = 1 on (ease-out-back)
export const popScale = (tau) => { if (!(tau < 1)) return 1; if (tau <= 0) return 0.8; const c1 = 2.2, c3 = c1 + 1, x = tau - 1; return 0.8 + 0.2 * (1 + c3 * x * x * x + c1 * x * x); };
// pin settle: 1 at tau = 0, dips ~2.8 %, rings once, 1 from tau = 1 on
export const settleScale = (tau) => (tau >= 1 || tau < 0 ? 1 : 1 - 0.034 * Math.exp(-4.5 * tau) * Math.sin(tau * 9.42478) * (1 - tau));
