// hand-signal — filters and small math. Pure JS (browser + node), no DOM.

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const angleBetween = (a, b) => Math.acos(clamp(dot(a, b) / ((len(a) * len(b)) || 1), -1, 1));
export const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// ------------------------------------------------------------------ one-euro (Casiez et al. 2012)
// cutoff = minCutoff + beta * |dx/dt|   (dx/dt itself low-passed at dCutoff)
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
export class OneEuro {
  constructor(n, minCutoff, beta, dCutoff = 1) { this.n = n; this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = null; this.dx = new Float64Array(n); }
  reset() { this.x = null; this.dx.fill(0); }
  filter(v, dt) {
    if (!this.x) { this.x = Float64Array.from(v); return this.x; }
    dt = Math.max(dt, 1e-3); const ad = alpha(this.dc, dt);
    for (let i = 0; i < this.n; i++) {
      const d = (v[i] - this.x[i]) / dt; this.dx[i] += ad * (d - this.dx[i]);
      this.x[i] += alpha(this.mc + this.beta * Math.abs(this.dx[i]), dt) * (v[i] - this.x[i]);
    }
    return this.x;
  }
}
export class OneEuro1 {
  constructor(minCutoff, beta, dCutoff = 1) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = null; this.dx = 0; }
  reset(v = null) { this.x = v; this.dx = 0; }
  filter(v, dt) {
    if (this.x === null) { this.x = v; return v; }
    dt = Math.max(dt, 1e-3);
    const d = (v - this.x) / dt; this.dx += alpha(this.dc, dt) * (d - this.dx);
    this.x += alpha(this.mc + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
}

// ------------------------------------------------------------------ quaternions [x, y, z, w]
export const qIdent = () => [0, 0, 0, 1];
export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
export const qAxisAngle = (axis, ang) => { const a = norm(axis), s = Math.sin(ang / 2); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)]; };
export const qAngle = (a, b) => 2 * Math.acos(clamp(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]), 0, 1));
export function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; let s = 1; if (d < 0) { d = -d; s = -1; }
  if (d > 0.9995) return qNorm([lerp(a[0], s * b[0], t), lerp(a[1], s * b[1], t), lerp(a[2], s * b[2], t), lerp(a[3], s * b[3], t)]);
  const th = Math.acos(d), st = Math.sin(th), wa = Math.sin((1 - t) * th) / st, wb = s * Math.sin(t * th) / st;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2], wa * a[3] + wb * b[3]];
}
export function qRotate(q, v) { const u = [q[0], q[1], q[2]], t = mul(cross(u, v), 2); return add(add(v, mul(t, q[3])), cross(u, t)); }
// shortest rotation taking unit vector a onto unit vector b ("swing")
export function qFromTo(a, b) {
  const d = dot(a, b); if (d > 0.999999) return qIdent();
  if (d < -0.999999) { const ax = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]); return qAxisAngle(ax, Math.PI); }
  const c = cross(a, b); return qNorm([c[0], c[1], c[2], 1 + d]);
}
// columns x, y, z (orthonormal, right-handed) -> quaternion
export function qFromBasis(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22; let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return qNorm(q);
}
// quaternion -> column-major mat3 (Float32Array(9)), columns = rotated x, y, z axes
export function qToMat3(q) {
  const x = qRotate(q, [1, 0, 0]), y = qRotate(q, [0, 1, 0]), z = qRotate(q, [0, 0, 1]);
  return new Float32Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);
}
// One-euro on a rotation: cutoff rises with angular speed (rad/s). Output is slerped toward the input.
export class QuatEuro {
  constructor(minCutoff, beta, dCutoff = 1) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.q = null; this.w = 0; }
  reset(q = null) { this.q = q; this.w = 0; }
  filter(q, dt) {
    if (!this.q) { this.q = q.slice(); return this.q; }
    dt = Math.max(dt, 1e-3);
    const w = qAngle(this.q, q) / dt; this.w += alpha(this.dc, dt) * (w - this.w);
    this.q = qNorm(qSlerp(this.q, q, alpha(this.mc + this.beta * this.w, dt)));
    return this.q;
  }
}

// ------------------------------------------------------------------ running-percentile range (per-user calibration)
// Tracks a low and a high quantile of a stream by stochastic approximation (Robbins-Monro):
//   est += rate * span * dt * (x > est ? q : -(1 - q))
// so the estimate settles where a fraction q of samples lie below it. With q = 0.97 it climbs to a new
// maximum in about a second of holding there and forgets it over ~40 s. Bounded so it can never collapse.
export class RunRange {
  constructor({ lo, hi, qLo = 0.04, qHi = 0.96, rate = 0.9, rateLo, loBounds, hiBounds, minSpan }) {
    this.p = { lo, hi }; this.lo = lo; this.hi = hi; this.qLo = qLo; this.qHi = qHi; this.rate = rate; this.rateLo = rateLo ?? rate;
    this.loB = loBounds || [lo - (hi - lo) * 0.5, lo + (hi - lo) * 0.35]; this.hiB = hiBounds || [hi - (hi - lo) * 0.35, hi + (hi - lo) * 0.6];
    this.minSpan = minSpan ?? (hi - lo) * 0.45; this.n = 0;
  }
  reset() { this.lo = this.p.lo; this.hi = this.p.hi; this.n = 0; }
  // doLo / doHi: which end this sample is allowed to teach (e.g. only near-touch samples teach the pinch floor)
  update(x, dt, doLo = true, doHi = true) {
    if (!isFinite(x)) return; const span = Math.max(this.hi - this.lo, 1e-6), k = this.rate * span * Math.min(dt, 0.1);
    if (doHi) this.hi += k * (x > this.hi ? this.qHi : -(1 - this.qHi));
    if (doLo) this.lo += k * (this.rateLo / this.rate) * (x > this.lo ? this.qLo : -(1 - this.qLo));
    this.lo = clamp(this.lo, this.loB[0], this.loB[1]); this.hi = clamp(this.hi, this.hiB[0], this.hiB[1]);
    if (this.hi - this.lo < this.minSpan) { const m = (this.hi + this.lo) / 2; this.lo = m - this.minSpan / 2; this.hi = m + this.minSpan / 2; }
    this.n++;
  }
  norm(x) { return clamp((x - this.lo) / Math.max(this.hi - this.lo, 1e-6)); }
}

// dead zone around a centre with continuity at the edges: |x - c| < w -> c, then ramps back to identity at the ends of [0,1]
export function deadzone(x, c = 0.5, w = 0.04) {
  const d = x - c, a = Math.abs(d); if (a <= w) return c;
  const room = d > 0 ? 1 - c : c; return c + Math.sign(d) * (a - w) / Math.max(room - w, 1e-6) * room;
}
export const CURVES = {
  linear: (x) => x, smooth: (x) => x * x * (3 - 2 * x), ease: (x) => x * x * (3 - 2 * x),
  exp: (x) => x * x, cube: (x) => x * x * x, log: (x) => Math.sqrt(x), expo: (x) => (Math.pow(2, 6 * x) - 1) / 63,
  step: (x) => (x >= 0.5 ? 1 : 0),
};
