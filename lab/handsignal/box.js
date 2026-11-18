// hand-signal — the 3D box. A persistent oriented cuboid in camera space, held and moved with pinches. Pure JS.
// Camera space: x right, y up, z forward (metres), pinhole at the origin, focal length K.focal image-heights.
//   pixel ray (vUv):  d = normalize(((u - 0.5) * aspect / f, (v - 0.5) / f, 1))
// The box is { c: centre, half: half extents along its own axes, q: orientation }, uBoxRot = mat3 whose COLUMNS are the box axes.
//
// Manipulation is RELATIVE to the moment of the grab, so a noisy absolute hand pose never lands in the box directly:
//   two pinches : v = pR - pL (depth difference damped), m = midpoint
//                 scale s = |v| / |v0| (uniform), swing = shortest rotation v0 -> v (gives yaw and roll),
//                 pitch about the hand line from the mean palm pitch change (x0.5, 5 deg dead zone)
//                 c = m + swing * s * (c0 - m0),  half = half0 * s,  q = pitchRot * swing * q0
//   one pinch   : c = c0 + (p - p0) (depth x0.7), roll about the view axis from the hand's in-plane roll (4 deg dead zone)
//   release     : the box stays where it is. doublePinch (no grab active): dismiss.
//   letting go  : opening the fingers moves the pinch point before the latch opens (a ~1 cm kick). While a holding hand's gap is
//                 loose (> looseGap, or > tightGap and opening faster than looseRate) the box ignores the hands; if the pinch
//                 tightens again without releasing, the grab re-anchors from the box as it is.
// Everything is then filtered once more (one-euro on centre / log extents, quaternion one-euro on orientation).

import { clamp, lerp, smoothstep, sub, add, mul, dot, cross, len, norm, wrapPi, OneEuro, QuatEuro, qIdent, qMul, qAxisAngle, qRotate, qFromTo, qFromBasis, qToMat3, qNorm } from './filters.js';

export const BOXK = {
  fPos: [1.0, 6, 1], fRot: [0.8, 1.2, 1], fExt: [1.0, 4, 1],
  fDz: [0.35, 0.8, 1],    // the depth DIFFERENCE between the hands gets its own slow filter before anything uses it (it is what turns into yaw)
  depthDamp: 0.6,         // how much of the measured depth DIFFERENCE between the hands reaches the box (monocular depth is the noisiest axis)
  depthMove: 0.7,         // one-hand push/pull gain
  pitchGain: 0.5, pitchDead: 0.087, rollDead: 0.07,
  aspectY: 0.62, aspectZ: 0.62,   // spawn proportions relative to the half-width between the pinches
  minHalf: 0.03, maxHalf: 0.6, minZ: 0.18, maxZ: 3,
  fade: 0.25,             // s alpha ramp on spawn / dismiss
  grabRadius: 1.35,       // one-hand grab reaches this far outside the box's projected radius
  tightGap: 0.12, looseGap: 0.2, looseRate: 1.0,   // calibrated gap units, units / s (the pinch latch itself is 0.10 on / 0.26 off)
  maxYaw: 1.2,            // rad: the box x axis never turns further than this out of the image plane (an edge-on box is unusable)
};
const dz = (x, w) => (Math.abs(x) <= w ? 0 : x - Math.sign(x) * w);

export class Box {
  constructor(opts = {}) {
    this.k = { ...BOXK, ...opts }; this.exists = false; this.alpha = 0; this.target = 0; this.grab = 'none'; this.g = null;
    this.c = [0, 0, 0.6]; this.half = [0.12, 0.08, 0.08]; this.q = qIdent();
    this.fc = new OneEuro(3, ...this.k.fPos); this.fh = new OneEuro(3, ...this.k.fExt); this.fq = new QuatEuro(...this.k.fRot);
    this.out = { c: this.c.slice(), half: this.half.slice(), q: qIdent() }; this.flash = 0; this.fdz = new OneEuro(1, ...this.k.fDz); this.dz = 0; this.pg = {}; this.frozen = false;
  }
  dismiss() { this.target = 0; this.grab = 'none'; this.g = null; }
  place(c, half, q) { this.c = c.slice(); this.half = half.slice(); this.q = q.slice(); this.exists = true; this.target = 1; this.fc.reset(); this.fh.reset(); this.fq.reset(); }

  // st: HandSignals state. mode: 'pinch' (grab with pinches) | 'hold' (the box simply lives between two visible hands)
  update(st, { mode = 'pinch' } = {}) {
    const k = this.k, dt = st.dt, f = st.focal, A = st.aspect;
    const hands = st.hands.filter(h => h.state === 'live' || h.state === 'hold');
    const point = (h) => (mode === 'hold' ? h.pos3 : h.pinchPoint3);
    const holds = (h) => (mode === 'hold' ? true : h.pinched);
    const L = hands.find(h => h.side === 'L' && holds(h)), R = hands.find(h => h.side === 'R' && holds(h));
    if (L && R) this.dz = this.fdz.filter([point(R)[2] - point(L)[2]], dt)[0]; else this.fdz.reset();
    let want = L && R ? 'two' : (L || R) && mode === 'pinch' && this.exists && this.target > 0 ? 'one' : 'none';
    const one = L || R;
    // letting go (see header): is any holding hand opening its fingers?
    let loose = false; const pg = {};
    for (const h of hands) { const p = this.pg[h.id], rate = p === undefined ? 0 : (h.gap - p) / Math.max(dt, 1e-3); pg[h.id] = h.gap;
      if (mode === 'pinch' && (h === L || h === R) && (h.gap > k.looseGap || (h.gap > k.tightGap && rate > k.looseRate))) loose = true; }
    this.pg = pg;
    let re = false; if (this.frozen && !loose && want === this.grab && want !== 'none') { this.grab = 'none'; re = true; }   // tightened again: re-anchor
    this.frozen = loose && want !== 'none' && (want === this.grab || re);
    if (want === 'one' && this.grab !== 'one' && this.grab !== 'two' && !re) {
      // a single pinch only grabs if it starts on (or near) the box
      const pc = this.project(this.c, f, A), pp = one.pinchPoint; const r = Math.max(...this.half) * f / Math.max(this.c[2], 0.05) * 1.3;
      if (Math.hypot((pp[0] - pc[0]) * A, pp[1] - pc[1]) > r * k.grabRadius) want = 'none';
    }
    if (want === 'one' && this.grab === 'one' && this.g && this.g.id !== one.id) this.grab = 'none';   // other hand took over: re-anchor

    if (want !== this.grab) {                                   // (re)anchor: every transition starts from the box as it is now
      this.grab = want; this.g = null;
      if (want === 'two') {
        const pl = point(L), pr = point(R); const v = this._v(pl, pr), m = mul(add(pl, pr), 0.5);
        if (!this.exists || this.target === 0) {                // spawn: the hand line is the box x axis, the pinches sit on its end faces
          const x = norm(v); let y = sub([0, 1, 0], mul(x, x[1])); y = len(y) < 1e-3 ? [0, 0, 1] : norm(y); const z = cross(x, y);
          const hx = clamp(len(v) / 2, k.minHalf, k.maxHalf);
          this.place(m, [hx, hx * k.aspectY, hx * k.aspectZ], qFromBasis(x, y, z)); this.flash = 1;
        }
        this.g = { v0: v, m0: m, c0: this.c.slice(), h0: this.half.slice(), q0: this.q.slice(), p0: (L.pitch + R.pitch) / 2 };
      } else if (want === 'one') {
        this.g = { id: one.id, p0: one.pinchPoint3.slice(), c0: this.c.slice(), q0: this.q.slice(), r0: one.roll };
      }
    }
    if (this.frozen) { /* hands ignored */ } else if (this.grab === 'two' && this.g && L && R) {
      const g = this.g, pl = point(L), pr = point(R), v = this._v(pl, pr), m = mul(add(pl, pr), 0.5);
      const hmax = Math.max(...g.h0), hmin = Math.min(...g.h0);
      const s = clamp(len(v) / Math.max(len(g.v0), 1e-3), k.minHalf / hmin, k.maxHalf / hmax);
      const swing = qFromTo(norm(g.v0), norm(v));
      const dp = dz((L.pitch + R.pitch) / 2 - g.p0, k.pitchDead) * k.pitchGain;
      const rot = qMul(qAxisAngle(norm(v), dp), swing);
      this.q = qNorm(qMul(rot, g.q0)); this.half = g.h0.map(h => h * s);
      this.c = add(m, mul(qRotate(rot, sub(g.c0, g.m0)), s));
    } else if (this.grab === 'one' && this.g && one) {
      const g = this.g, p = one.pinchPoint3; const d = sub(p, g.p0); d[2] *= k.depthMove;
      this.c = add(g.c0, d);
      this.q = qNorm(qMul(qAxisAngle([0, 0, 1], -dz(wrapPi(one.roll - g.r0), k.rollDead)), g.q0));
    }
    this.c[2] = clamp(this.c[2], k.minZ, k.maxZ);
    // output filters + alpha
    this.alpha += clamp(this.target - this.alpha, -dt / k.fade, dt / k.fade); if (this.alpha <= 0 && this.target === 0) this.exists = false;
    this.flash = Math.max(0, this.flash - dt / 0.35);
    if (this.exists) {
      const c = this.fc.filter(this.c, dt), h = this.fh.filter(this.half.map(Math.log), dt), q = this.fq.filter(this.q, dt);
      this.out = { c: [c[0], c[1], c[2]], half: [Math.exp(h[0]), Math.exp(h[1]), Math.exp(h[2])], q: q.slice() };
    }
    return this;
  }
  // hand vector with the depth difference damped and the out-of-plane angle limited
  _v(pl, pr) {
    const k = this.k; const v = sub(pr, pl); v[2] = this.dz * k.depthDamp;
    const xy = Math.hypot(v[0], v[1]), lim = Math.tan(k.maxYaw) * Math.max(xy, 1e-4); v[2] = clamp(v[2], -lim, lim);
    if (len(v) < 1e-4) return [1e-4, 0, 0]; return v;
  }
  project(p, f, A) { return [0.5 + p[0] / p[2] * f / A, 0.5 + p[1] / p[2] * f]; }
  uniforms(f = 1.2) {
    const o = this.out;
    return { uBoxCenter: o.c, uBoxHalf: o.half, uBoxRot: qToMat3(o.q), uBoxActive: this.exists ? smoothstep(0, 1, this.alpha) : 0, uBoxFocal: f, uBoxGrab: this.grab === 'two' ? 1 : this.grab === 'one' ? 0.5 : 0, uBoxFlash: this.flash };
  }
}
