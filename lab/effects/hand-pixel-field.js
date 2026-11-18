// hand-pixel-field — pixelation as a spatial field shaped by the hands
// (the "beyond" of hand-pixelate; see breakdowns/hand-pixelate.md)
//
// The frame is a mosaic. Each hand opens a window of sharpness; two hands stretch one window
// between them (a capsule from palm to palm). Outside the window the cell size doubles ring by
// ring on a power-of-two grid anchored to the frame centre, so cells never swim: a cell is only
// ever replaced by its four children or its parent, and that hand-over is cross-faded.
//
// Pass graph:
//   hs (feedback, tiny)  hand state: 2 slots x (centre, radius, presence + velocities),
//                        critically damped springs, slot continuity, ease-out on tracking loss
//   p1..p5               box pyramid of uCam (1/2 .. 1/32) — in Metal this is just the mip chain
//   out (screen)         per pixel: descend the quadtree from the coarsest level, stop at the
//                        first cell whose centre asks for that level; cell colour = 4x4 taps of
//                        the matching pyramid level; optional seam + bevel

const HS = /* glsl */ `
vec4 rd(int b) {
  ivec2 sz = textureSize(uSelf, 0);
  return texelFetch(uSelf, ivec2(int((float(b) + 0.5) * 0.25 * float(sz.x)), sz.y / 2), 0);
}
// exact critically damped spring step (stable for any dt)
void spring(inout vec3 x, inout vec3 v, vec3 target, float w, float dt) {
  vec3 j0 = x - target, j1 = v + j0 * w;
  float e = exp(-w * dt);
  x = target + (j0 + j1 * dt) * e;
  v = (v - j1 * w * dt) * e;
}
// one detection -> (centroid of the 21 landmarks, radius of their bounding circle in frame heights)
vec3 det(int i, vec2 k) {
  vec2 c = vec2(0.0);
  for (int j = 0; j < 21; j++) c += uHand[i * 21 + j].xy;
  c /= 21.0;
  float r = 0.0;
  for (int j = 0; j < 21; j++) r = max(r, length((uHand[i * 21 + j].xy - c) * k));
  return vec3(c, r);
}
void main() {
  int band = int(vUv.x * 4.0);
  int slot = band / 2;
  vec4 P0 = rd(0), V0 = rd(1), P1 = rd(2), V1 = rd(3);
  bool init = V0.a > 0.5;
  bool alive0 = init && P0.a > 0.02, alive1 = init && P1.a > 0.02;
  float asp = uRes.x / uRes.y;
  vec2 k = vec2(asp, 1.0);
  vec3 D0 = det(0, k), D1 = det(1, k);
  vec2 d0 = D0.xy, d1 = D1.xy;

  // which detection belongs to which slot: nearest to where the slot already is
  int pick0 = -1, pick1 = -1;
  if (uHandCount == 1) {
    float c0 = alive0 ? distance(d0 * k, P0.xy * k) : 1e3;
    float c1 = alive1 ? distance(d0 * k, P1.xy * k) : 1e3;
    if (!alive0 && !alive1) pick0 = 0;
    else if (c0 <= c1) { if (c0 > 0.45 && !alive1) pick1 = 0; else pick0 = 0; }
    else { if (c1 > 0.45 && !alive0) pick0 = 0; else pick1 = 0; }
  } else if (uHandCount >= 2) {
    float a = (alive0 ? distance(d0 * k, P0.xy * k) : 0.0) + (alive1 ? distance(d1 * k, P1.xy * k) : 0.0);
    float b = (alive0 ? distance(d1 * k, P0.xy * k) : 0.0) + (alive1 ? distance(d0 * k, P1.xy * k) : 0.0);
    if (a <= b) { pick0 = 0; pick1 = 1; } else { pick0 = 1; pick1 = 0; }
  }

  vec4 P = slot == 0 ? P0 : P1, V = slot == 0 ? V0 : V1;
  bool alive = slot == 0 ? alive0 : alive1;
  int pick = slot == 0 ? pick0 : pick1;
  float dt = clamp(uDt, 0.0, 0.1);
  bool snap = !init || uDt <= 0.0;

  vec3 x = P.xyz, v = V.xyz; float pres = P.a; float lost = init ? max(V.a - 1.0, 0.0) : 0.0;
  if (pick >= 0) {
    vec3 target = pick == 0 ? D0 : D1;
    if (snap) { x = target; v = vec3(0.0); pres = 1.0; }
    else if (!alive) { x = vec3(target.xy, 0.0); v = vec3(0.0); pres = max(pres, 0.03); }   // appear in place, grow open
    else {
      vec3 xp = x, vp = v;
      spring(xp, vp, target, 30.0, dt);          // position: ~0.12 s to settle, no overshoot
      vec3 xo = x, vo = v;
      spring(xo, vo, target, 12.0, dt);          // radius: slower, a closing fist shrinks the window smoothly
      x = vec3(xp.xy, xo.z); v = vec3(vp.xy, vo.z);
    }
    if (!snap) pres += (1.0 - pres) * (1.0 - exp(-dt / 0.14));
    lost = 0.0;
  } else {
    if (snap) { pres = 0.0; v = vec3(0.0); }
    else {
      // coast; hold the window open for 0.25 s (a short tracking miss must not make it breathe), then ease out
      v *= exp(-dt * 12.0); x += v * dt; lost = min(lost + dt, 9.0);
      if (lost > 0.25) pres *= exp(-dt / 0.4);
    }
  }
  bool isVel = (band - slot * 2) == 1;
  fragColor = isVel ? vec4(v, 1.0 + lost) : vec4(x, pres);                    // V.a = 1 + seconds since last seen
}`;

const DOWN = (src) => /* glsl */ `
void main() { fragColor = vec4(texture(${src}, vUv).rgb, 1.0); }`;

const OUT = /* glsl */ `
const int K = 4;                      // cell sizes S0, S0/2 .. S0/16, then the raw image
vec4 hs(int b) {
  ivec2 sz = textureSize(uBuf_hs, 0);
  return texelFetch(uBuf_hs, ivec2(int((float(b) + 0.5) * 0.25 * float(sz.x)), sz.y / 2), 0);
}
vec3 pyr(int m, vec2 uv) {
  if (m <= 0) return texture(uCam, uv).rgb;
  if (m == 1) return texture(uBuf_p1, uv).rgb;
  if (m == 2) return texture(uBuf_p2, uv).rgb;
  if (m == 3) return texture(uBuf_p3, uv).rgb;
  if (m == 4) return texture(uBuf_p4, uv).rgb;
  return texture(uBuf_p5, uv).rgb;
}
// average colour of the square cell centred at c (px), side s (px)
vec3 cellAvg(vec2 c, float s) {
  int m = int(clamp(floor(log2(max(s, 1.0) / 4.0) + 0.5), 0.0, 5.0));
  vec3 a = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 p = c + (vec2(float(i), float(j)) - 1.5) * 0.25 * s;
    a += pyr(m, clamp(p / uRes + 0.5, 0.0, 1.0));
  }
  return a / 16.0;
}
float sdCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h) - mix(ra, rb, h);
  return min(d, min(length(pa) - ra, length(p - b) - rb));     // never thinner than either end disc
}
vec2 A, B; float RA, RB, PRES, FINE, RING;
// wanted level at a point (px from centre): <= 0 sharp, K = coarsest
float want(vec2 p) {
  float top = float(K) + 0.5;
  float d = sdCapsule(p / uRes.y, A, B, RA, RB) * uRes.y;          // px, < 0 inside the window
  // rings: every level gets a band RING cells wide at its own cell size, so the band of
  // 2^L-sized cells starts at RING * fine * (2^L - 1) px from the window edge
  float unit = RING * FINE;
  if (u_invert > 0.5) return mix(-0.5, min(log2(1.0 + max(-d, 0.0) / unit), top), PRES);
  float w = d < 0.0 ? max(d / unit, -1.0) : min(log2(1.0 + d / unit), top);
  return mix(top, w, PRES);
}
// bevel: 1 px seam + a soft top-left light, in the cell's own frame
vec3 bevel(vec3 col, vec2 p, float s) {
  vec2 q = fract(p / s) * s;                         // px inside the cell, origin bottom-left
  vec2 e = min(q, s - q);
  float vis = u_edge * smoothstep(8.0, 20.0, s);
  float seam = 1.0 - smoothstep(0.35, 1.35, min(e.x, e.y));
  float bw = clamp(s * 0.09, 1.5, 5.0);
  float hi = max(1.0 - smoothstep(0.0, bw, s - q.y), 1.0 - smoothstep(0.0, bw, q.x));   // top + left
  float lo = max(1.0 - smoothstep(0.0, bw, q.y), 1.0 - smoothstep(0.0, bw, s - q.x));   // bottom + right
  col *= 1.0 + vis * (0.16 * hi - 0.20 * lo);
  return col * (1.0 - 0.55 * vis * seam);
}
void main() {
  vec4 h0 = hs(0), h1 = hs(2);
  float asp = uRes.x / uRes.y;
  vec2 a = (h0.xy - 0.5) * vec2(asp, 1.0), b = (h1.xy - 0.5) * vec2(asp, 1.0);
  float p0 = smoothstep(0.0, 1.0, h0.a), p1 = smoothstep(0.0, 1.0, h1.a);
  // a hand that is fading slides its end of the capsule onto the other hand
  A = mix(b, a, clamp(p0 / max(p1, 1e-3), 0.0, 1.0));
  B = mix(a, b, clamp(p1 / max(p0, 1e-3), 0.0, 1.0));
  RA = u_reach * h0.z * p0;
  RB = u_reach * h1.z * p1;
  if (p0 < 1e-3) RA = RB; if (p1 < 1e-3) RB = RA;
  PRES = max(p0, p1);

  vec2 p = (vUv - 0.5) * uRes;                       // px from the frame centre: the grid anchor
  float S0 = u_block * uRes.x / 1280.0;
  FINE = S0 * exp2(-float(K)); RING = mix(0.75, 5.0, u_falloff);
  vec3 raw = texture(uCam, vUv).rgb;
  vec3 col = raw;
  for (int L = K; L >= 0; L--) {
    float s = S0 * exp2(float(L - K));
    vec2 c = (floor(p / s) + 0.5) * s;
    float w = want(c) - float(L);
    if (w >= 0.0) {
      float t = smoothstep(0.0, 0.4, w);
      vec3 own = bevel(cellAvg(c, s), p, s);
      vec3 finer = raw;
      if (L > 0 && t < 1.0) {
        float s2 = s * 0.5; vec2 c2 = (floor(p / s2) + 0.5) * s2;
        finer = bevel(cellAvg(c2, s2), p, s2);
      }
      col = mix(finer, own, t);
      break;
    }
  }
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'hand-pixel-field',
  name: 'Hand Pixel Field',
  ref: { clip: 'DcyiqeyOI4g', t: [53.4, 54.0] },
  needs: ['hands'],
  params: [
    { id: 'block', label: 'Block', type: 'float', min: 32, max: 192, default: 96 },
    { id: 'reach', label: 'Reach', type: 'float', min: 0.5, max: 3, default: 1.3 },
    { id: 'falloff', label: 'Falloff', type: 'float', min: 0, max: 1, default: 0.3 },
    { id: 'edge', label: 'Edges', type: 'float', min: 0, max: 1, default: 0.22 },
    { id: 'invert', label: 'Blocks At Hands', type: 'bool', default: false },
  ],
  passes: [
    { name: 'hs', frag: HS, scale: 0.05, feedback: true },
    { name: 'p1', frag: DOWN('uCam'), scale: 0.5 },
    { name: 'p2', frag: DOWN('uBuf_p1'), scale: 0.25 },
    { name: 'p3', frag: DOWN('uBuf_p2'), scale: 0.125 },
    { name: 'p4', frag: DOWN('uBuf_p3'), scale: 0.0625 },
    { name: 'p5', frag: DOWN('uBuf_p4'), scale: 0.03125 },
    { name: 'out', frag: OUT, screen: true },
  ],
};
