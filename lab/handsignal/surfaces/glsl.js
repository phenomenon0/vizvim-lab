// Imagine — GLSL for the surfaces. Plain fragment code over uniforms (packed by Surfaces.uniforms() in index.js).
// Slot i of SF_SLOTS, painted in array order (the manager sorts: behind-the-person first, then far -> near):
//   uSfA[i]  type code (0 = empty), look index, alpha, state (0 pinned, 1 held / live, 2 spawning, 3 dismissing)
//   uSfB[i]  centre u, v (vUv), depth z (metres), in-plane angle (rad, ccw)
//   uSfC[i]  half extents x, y in hu (projected, spawn pop / pin settle already applied), spawn progress 0..1, -
//   uSfD[i]  type-specific: box = orientation quaternion; brush = point count, half width (hu), seed
//   uSfE[i]  half extents x, y, z in metres, hover 0..1
//   uSfF[i]  behind 0..1 (1 = the person in the picture covers it), lift 0..1 (held = off the wall: longer, softer shadow),
//            velocity x, y in hu / s (a thrown surface streaks along it)
//   uSfG[i]  previous look index, cross-fade 1 -> 0 (1 = all previous look), pin pulse 1 -> 0 (the glint as it settles),
//            bound radius in hu (nothing of the surface or its shadow is drawn outside it: the early-out)
//   uSfP[i * SF_NPTS + k]  points x, y in hu + half width in hu (web quad: its four corners in order; brush: the stroke)
// A type's function returns the signed distance in hu (negative inside) and may set:
//   sfShade  multiplies the look inside (box: face lighting)       sfAux   extra line alpha (box: back edges, web: strings)
//   sfN      outward unit normal of the nearest edge (the bevel)   sfOff   look uv offset (box: per-face parallax)
//   sfMask   coverage inside 0..1 (brush: bristles)                sfLens  rim refraction strength (portal: a thicker lens)
// Material, all types: contact shadow + soft drop shadow (longer when lifted), a glass bevel that shows the CAMERA bent at the
// rim and lit from the upper left, a specular hairline, an inner vignette, a soft sheen. Web = one membrane (no pane edges),
// Brush = paint (no glass). Everything is a function of this pixel and the uniforms: no extra passes, no history.
import { SK } from './geom.js';
export const SF_DECL = /* glsl */`
#define SF_SLOTS ${SK.slots}
#define SF_NPTS ${SK.npts}
uniform vec4 uSfA[SF_SLOTS]; uniform vec4 uSfB[SF_SLOTS]; uniform vec4 uSfC[SF_SLOTS]; uniform vec4 uSfD[SF_SLOTS]; uniform vec4 uSfE[SF_SLOTS];
uniform vec4 uSfF[SF_SLOTS]; uniform vec4 uSfG[SF_SLOTS];
uniform vec3 uSfP[SF_SLOTS * SF_NPTS];
uniform float uSfAny;          // 0..1: something is on screen (drives the outside dim)
uniform float uSfFocal;        // image heights
uniform vec4 uSfRide;          // param ride: pinch point u, v, value 0..1, alpha
float sfA, sfShade, sfAux, sfMask, sfLens; vec2 sfN, sfOff;
vec2 sfRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(p.x * c - p.y * s, p.x * s + p.y * c); }
vec2 sfCentre(int i) { return uSfB[i].xy * vec2(sfA, 1.0); }
float sfSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0)); }
`;
// types: registry objects (their glsl + code). Emits sfDist(), the dispatcher.
export const sfDispatch = (types) => [...new Set(types.map(T => T.glsl))].join('\n') + /* glsl */`
float sfDist(int i, vec2 p, out vec2 suv, out float z) {
  int ty = int(uSfA[i].x + 0.5); sfShade = 1.0; sfAux = 0.0; sfMask = 1.0; sfLens = 1.0; sfN = vec2(0.0, 1.0); sfOff = vec2(0.0);
${[...new Set(types.map(T => `  if (ty == ${T.code}) return ${T.fn || 'sf_' + T.id}(i, p, suv, z);`))].join('\n')}
  suv = vec2(0.0); z = 1e4; return 1.0;
}
`;
// The compositor. Needs: vec3 sfLook(int k, vec2 uv) (the hosted look k at this pixel), ACC (accent colour).
//   dim = how far the camera drops outside the surfaces, border = rim strength (bevel width + lines),
//   occ = 1: surfaces flagged "behind" (uSfF.x) are covered by the person matte
export const SF_COMPOSITE = /* glsl */`
const vec2 SF_LD = vec2(-0.5547, 0.8321);      // key light: upper left
vec3 sfComposite(vec3 cam, vec2 uv, float dim, float border, float occ) {
  sfA = uRes.x / uRes.y; float px = 1.0 / uRes.y; vec2 p = uv * vec2(sfA, 1.0), toUv = vec2(1.0 / sfA, 1.0);
  vec3 col = cam * (1.0 - dim * uSfAny);
  float person = (occ > 0.5 && uPersonReady > 0.5) ? smoothstep(0.3, 0.7, texture(uPerson, uv).r) : 0.0;
  for (int i = 0; i < SF_SLOTS; i++) {
    vec4 A = uSfA[i]; if (A.x < 0.5 || A.z < 0.003) continue;
    vec4 F = uSfF[i], G = uSfG[i]; int ty = int(A.x + 0.5), lk0 = int(A.y + 0.5);
    float st = A.w, a = A.z, held = 1.0 - step(0.5, abs(st - 1.0)), ghost = 1.0 - step(0.5, abs(st - 2.0)), hov = uSfE[i].w, lift = F.y;
    float glass = (ty == 4 || ty == 5) ? 0.0 : 1.0, paint = ty == 5 ? 1.0 : 0.0;
    vec2 so = vec2(0.009, -0.016) * (0.45 + 1.4 * lift); float soft = 0.014 + 0.03 * lift, sp = length(F.zw);
    if (length(p - sfCentre(i)) > G.w + length(so) + soft + sp * 0.07) continue;       // nothing of it here
    float vis = 1.0 - F.x * person; if (vis < 0.003) continue;
    vec2 suv; float z;
    // a thrown surface streaks: four fainter copies of its shape back along the throw
    if (st > 2.5 && sp > 0.25) for (int j = 1; j <= 4; j++) {
      float sdj = sfDist(i, p + F.zw * 0.014 * float(j), suv, z);
      col = mix(col, sfLook(lk0, uv + F.zw * toUv * 0.014 * float(j)), 0.2 * (1.0 - smoothstep(-1.5 * px, 0.0, sdj)) * sfMask * a * vis * (1.0 - 0.2 * float(j)));
    }
    // drop shadow: the shape again, offset away from the light; then a tight contact line right at the edge
    if (ghost < 0.5 && ty != 4) {
      float sds = sfDist(i, p - so, suv, z), k = 1.0 - smoothstep(-0.4 * soft, soft, sds);
      col *= 1.0 - mix(0.3, 0.2, lift) * mix(1.0, 0.45, paint) * k * k * a * vis * (paint > 0.5 ? sfMask : 1.0);
    }
    float sd = sfDist(i, p, suv, z); float shade = sfShade, aux = sfAux, mask = sfMask, lens = sfLens; vec2 n = sfN, off = sfOff;
    if (sd > 0.012) continue;
    if (ghost < 0.5 && ty != 4) col *= 1.0 - 0.22 * a * vis * (1.0 - smoothstep(0.0, 3.5 * px, sd)) * step(0.0, sd) * (1.0 - paint);
    float m = (1.0 - smoothstep(-1.5 * px, 0.0, sd)) * mask;
    // the bevel: e = 0 at its inner edge, 1 at the outline
    float bw = (0.0035 + 0.0075 * border) * glass, e = bw > 0.0 ? clamp(1.0 + sd / bw, 0.0, 1.0) : 0.0, lit = dot(n, SF_LD);
    // the look, seen through the pane: its picture bulges a little toward the rim (a lens), each box face its own way
    vec2 luv = uv + off - n * toUv * 0.012 * lens * glass * smoothstep(-3.0 * bw, 0.0, sd);
    vec3 lk = sfLook(lk0, luv);
    if (G.y > 0.003) lk = mix(lk, sfLook(int(G.x + 0.5), luv), smoothstep(0.0, 1.0, clamp(G.y * 1.6 - 0.3 * (suv.x * 0.5 + 0.5), 0.0, 1.0)));   // look change: a soft wipe, never a pop
    lk *= shade;
    float vw = max(0.4 * min(uSfC[i].x, uSfC[i].y), 0.01), vg = clamp(1.0 + sd / vw, 0.0, 1.0);
    lk *= 1.0 - mix(0.2, 0.3, paint) * vg * vg * (ty == 4 ? 0.4 : 1.0);                    // inner vignette (paint pools at its edge)
    if (glass > 0.5) {
      lk += 0.05 * smoothstep(0.1, 1.0, dot(suv, vec2(-0.45, 0.6)) * 0.5 + 0.5);            // sheen from the key light
      float gt = 1.0 - G.z, band = (suv.x + suv.y) * 0.5 - mix(-1.5, 1.5, gt);
      lk += 0.3 * exp(-band * band * 14.0) * sin(3.14159 * gt) * step(0.003, G.z);          // the glint that crosses it as it settles
      // rim: the camera itself, bent toward the centre and lit by the key light; a dark seam where the bevel meets the pane
      vec3 rim = texture(uCam, uv - n * toUv * (0.02 + 0.03 * e) * lens).rgb * (0.86 + 0.34 * lit) + 0.1 + 0.16 * max(lit, 0.0);
      lk = mix(lk, rim, smoothstep(0.0, 0.25, e) * mix(1.0, 0.0, ghost));
      lk *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 1.5 * px, abs(sd + bw))) * (1.0 - ghost);
      lk += 0.75 * pow(max(lit, 0.0), 2.0) * (1.0 - smoothstep(0.4 * px, 1.6 * px, abs(sd + 1.2 * px))) * (1.0 - ghost);   // specular hairline on the lit edges
      lk += 0.12 * (1.0 - smoothstep(0.4 * px, 1.4 * px, abs(sd + 1.0 * px))) * (1.0 - ghost);                            // and a faint one all the way round
    }
    col = mix(col, lk, m * a * vis * mix(1.0, 0.3, ghost));
    // lines: hover = white hairline, held = accent, spawning = dashed hairline + accent progress arc (clockwise from the top)
    float w = mix(0.8, 1.3, held) * px, line = (1.0 - smoothstep(w - 0.75 * px, w + 0.75 * px, abs(sd + w))) * step(sd, 1.5 * px);
    vec3 bc = mix(vec3(1.0), ACC, held); float ba = max(held, 0.75 * hov) * mix(1.0, 0.0, ghost);
    if (ghost > 0.5) {
      float ang = mod(atan(suv.x, suv.y) + 6.2831853, 6.2831853) / 6.2831853;
      float on = step(ang, uSfC[i].z), dash = step(0.5, fract(ang * 36.0));
      bc = mix(vec3(1.0), ACC, on); ba = mix(0.5 * dash, 1.0, on); w = 1.3 * px;
      line = (1.0 - smoothstep(w - 0.75 * px, w + 0.75 * px, abs(sd + w))) * step(sd, 1.5 * px);
      col *= 1.0 - 0.25 * a * (1.0 - smoothstep(w, w + 3.0 * px, abs(sd + w))) * step(sd, 4.0 * px);
    }
    col = mix(col, bc, clamp(line * ba * a * vis, 0.0, 1.0));
    col = mix(col, vec3(1.0, 0.985, 0.96), clamp(aux * a * vis * (0.35 + 0.65 * border) * (ty == 4 ? 1.0 : m), 0.0, 1.0));
  }
  // param ride: a 270 degree value arc around the riding pinch
  if (uSfRide.w > 0.003) {
    vec2 q = p - uSfRide.xy * vec2(sfA, 1.0); float R = 0.062, a0 = -2.3561945, full = 4.712389, v = clamp(uSfRide.z, 0.0, 1.0);
    float ang = mod(atan(q.x, q.y) - a0 + 6.2831853, 6.2831853), ring = 1.0 - smoothstep(0.75 * px, 2.25 * px, abs(length(q) - R));
    col *= 1.0 - 0.35 * (1.0 - smoothstep(1.5 * px, 5.0 * px, abs(length(q) - R))) * step(ang, full);
    col = mix(col, vec3(1.0), 0.3 * ring * step(ang, full));
    col = mix(col, ACC, ring * step(ang, full * v));
    float ka = a0 + full * v; vec2 kd = vec2(sin(ka), cos(ka));
    col = mix(col, vec3(1.0), 1.0 - smoothstep(1.2 * px, 2.4 * px, sfSeg(q, kd * (R - 0.009), kd * (R + 0.009))));
  }
  return col;
}
`;
