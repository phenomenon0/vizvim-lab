// Imagine surface: Box. Both hands pinch in empty space and pull apart -> a 3D glass box between the pinches. Born once the
// pinches are BK.minSpan hu apart AND have moved BK.grow hu further apart than they started (two pinched hands that are merely
// far apart make no box; held still they make a Frame, frame.js). Follows the hands until either lets go, then pinned.
// The second pinch may come any time before the first hand has painted a stroke (brush.js).
// The box turns in-plane with the hands (and later with a grabbing wrist); its out-of-plane tilt is fixed (BK.tilt) so three
// faces always read. Orientation = rotZ(angle) * tilt.
import { centreHu, scaleHu, project, toHu, SK } from './geom.js';
import { qAxisAngle, qMul, qRotate, qConj } from '../filters.js';
export const BK = { minSpan: 0.34, grow: 0.07, show: 0.02, aspectY: 0.62, aspectZ: 0.62, pitch: -0.42, yaw: 0.5 };
const TILT = qMul(qAxisAngle([1, 0, 0], BK.pitch), qAxisAngle([0, 1, 0], BK.yaw));
export const boxQuat = (angle) => qMul(qAxisAngle([0, 0, 1], angle), TILT);
export default {
  id: 'box', name: 'Box', code: 2, pinchy: true, hands: 2, behind: false,
  bound: (s, f) => Math.hypot(s.half[0], s.half[1], s.half[2]) * scaleHu(s, f) * 1.15,      // hu: nothing of the box projects outside this circle
  spawn: { gesture: 'both hands: pinch close, pull apart',
    detect(st, mgr, scr) {
      const F = mgr.free, f = st.focal, A = st.aspect;
      if (F.length !== 2 || mgr.scr.pframe?.born || mgr.scr.brush?.born) { scr.s0 = undefined; return null; }
      const [a, b] = F[0].pinchPoint3[0] <= F[1].pinchPoint3[0] ? F : [F[1], F[0]], pa = a.pinchPoint3, pb = b.pinchPoint3;
      const v = [pb[0] - pa[0], pb[1] - pa[1]], z = (pa[2] + pb[2]) / 2, hx = Math.max(Math.hypot(v[0], v[1]) / 2, 0.012);
      const pose = { c: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, z], half: [hx, hx * BK.aspectY, hx * BK.aspectZ], angle: Math.atan2(v[1], v[0]) };
      if (scr.born) return { progress: 1, pose };
      const span = 2 * hx * f / z, key = a.id + ',' + b.id; if (scr.s0 === undefined || scr.key !== key) { scr.s0 = span; scr.key = key; }
      scr.s0 = Math.min(scr.s0, span); const grown = span - scr.s0;                    // hu further apart than the closest they have been
      if (grown < BK.show) return null;
      return { progress: Math.min(1, span / BK.minSpan, grown / BK.grow), pose };
    } },
  seed: (c, k) => ({ c, half: [0.075 * k, 0.047 * k, 0.047 * k], angle: 0.08 }),
  // ray through p against the oriented box (same slab test as the shader); outside: distance to the projected bounding circle
  hit(s, p, f, A) {
    const q = qConj(boxQuat(s.angle)), rd = [(p[0] / A - 0.5) * A / f, (p[1] - 0.5) / f, 1];
    const ro = qRotate(q, [-s.c[0], -s.c[1], -s.c[2]]), d = qRotate(q, rd); let tN = -1e9, tF = 1e9;
    for (let i = 0; i < 3; i++) { const di = Math.abs(d[i]) < 1e-6 ? 1e-6 : d[i], t0 = (-s.half[i] - ro[i]) / di, t1 = (s.half[i] - ro[i]) / di; tN = Math.max(tN, Math.min(t0, t1)); tF = Math.min(tF, Math.max(t0, t1)); }
    if (tF > Math.max(tN, 0)) return -0.01;
    const c = centreHu(s, f, A); return Math.max(0.001, Math.hypot(p[0] - c[0], p[1] - c[1]) - Math.hypot(s.half[0], s.half[1], s.half[2]) * scaleHu(s, f));
  },
  uniforms(s) { return { d: boxQuat(s.angle) }; },
  glsl: /* glsl */`
vec3 sfQRot(vec4 q, vec3 v) { vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
float sf_box(int i, vec2 p, out vec2 suv, out float z) {
  vec4 q = uSfD[i], qc = vec4(-q.xyz, q.w); vec3 hf = uSfE[i].xyz; float zc = uSfB[i].z;
  vec3 C = vec3((uSfB[i].x - 0.5) * sfA / uSfFocal * zc, (uSfB[i].y - 0.5) / uSfFocal * zc, zc);
  vec3 rd = vec3((p.x / sfA - 0.5) * sfA / uSfFocal, (p.y - 0.5) / uSfFocal, 1.0);
  vec3 ro = sfQRot(qc, -C), d = sfQRot(qc, rd); d += (1.0 - abs(sign(d))) * 1e-6;
  vec3 t0 = (-hf - ro) / d, t1 = (hf - ro) / d, a = min(t0, t1), b = max(t0, t1);
  float tN = max(max(a.x, a.y), a.z), tF = min(min(b.x, b.y), b.z);
  suv = vec2(0.0); z = zc;
  if (tF <= max(tN, 0.0)) return 1.0;
  vec3 nN = -sign(d) * step(vec3(tN), a), nF = sign(d) * step(b, vec3(tF)), pN = ro + d * tN, pF = ro + d * tF;
  vec3 eN = hf - abs(pN) + abs(nN) * 1e3, eF = hf - abs(pF) + abs(nF) * 1e3;
  float kN = uSfFocal / max(tN, 0.05), kF = uSfFocal / max(tF, 0.05);          // metres -> hu at that depth (rd.z = 1)
  float e = min(eN.x, min(eN.y, eN.z)) * kN, eb = min(eF.x, min(eF.y, eF.z)) * kF;
  z = tN; suv = pN.xy / max(hf.xy, vec2(1e-4));
  vec3 nc = sfQRot(q, nN); float fres = pow(1.0 - abs(dot(nc, normalize(rd))), 3.0);
  sfShade = 0.76 + 0.34 * (dot(nc, normalize(vec3(-0.35, 0.8, -0.5))) * 0.5 + 0.5) + 0.3 * fres;      // key light from the upper left + a grazing-angle lift
  sfN = nc.xy;                                                   // the bevel bends the camera the way the face leans
  sfOff = nc.xy * vec2(1.0 / sfA, 1.0) * 0.03;                   // and each face looks a little its own way: three facets, three slightly different views
  sfAux = 0.5 * (1.0 - smoothstep(0.6 / uRes.y, 2.0 / uRes.y, eb));       // the far edges, seen through the glass
  return -e;
}`,
};
