// Hand Webs — quads strung between the two hands' corresponding fingertips, each a screen-space window onto a
// different look, over the clean camera. Reference: wxll.hx "hand web portal" (DcoOO6JOtKo). Breakdown: breakdowns/hand-webs.md
//
// Geometry lives in the fragment shader: 4 corners per web as uniforms, inverse bilinear per pixel (portable to Metal).
// CPU side (frame()) only moves 10 points: damped follow, hand-loss retract, one-hand mode, raised-finger latch.
//
// Looks per web: built-ins `cyan riso dots ink` (the reel's three + one), or ANY lab effect id.
//   ?fx=hand-webs&webs=cyan,risograph,halftone      (live)
//   shoot.mjs --fx hand-webs --hs "off;webs=cyan,risograph,halftone"   (shoot.mjs only forwards --hs; see HARNESS-ASKS)
// Tracker, quad shader and look hosting are shared with prism.js: see hand-region.js.

import { hostSlots, trackRegion, REGION_GLSL, FINGER_SET_NAMES } from './hand-region.js';

const Q = new URLSearchParams(location.search);
const hsOpt = ((Q.get('hs') || '').split(';').map(s => s.split('=')).find(([k]) => k === 'webs') || [])[1];
const BUILTIN = { cyan: 'look0(uv)', riso: 'look1(uv)', dots: 'look2(uv)', ink: 'look3(uv)' };
const LOOKS = (Q.get('webs') || hsOpt || Object.keys(BUILTIN).join(',')).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
// look slots: built-ins by name, anything else is a lab effect hosted through the harness (hand-region.js hostSlots)
const SLOTS = await hostSlots(LOOKS, BUILTIN, { tag: 'hand-webs' });
const lookExpr = SLOTS.exprs, NL = lookExpr.length;

// ---------------------------------------------------------------- shader
const FRAG = REGION_GLSL + /* glsl */`

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 camBlur(vec2 uv, float r) {          // 9 taps, r in px at 1080 wide
  vec2 d = r * (uRes.x / 1080.0) / uRes, e = d * 0.7;
  return (texture(uCam, uv).rgb * 2.0
        + texture(uCam, uv + vec2(d.x, 0.0)).rgb + texture(uCam, uv - vec2(d.x, 0.0)).rgb
        + texture(uCam, uv + vec2(0.0, d.y)).rgb + texture(uCam, uv - vec2(0.0, d.y)).rgb
        + texture(uCam, uv + e).rgb + texture(uCam, uv - e).rgb
        + texture(uCam, uv + vec2(e.x, -e.y)).rgb + texture(uCam, uv - vec2(e.x, -e.y)).rgb) / 10.0;
}
float matte(vec2 uv) { return mix(1.0, smoothstep(0.2, 0.7, texture(uPerson, uv).r), uPersonReady); }
// Tone 0..1 after auto levels: 0 = the subject's dark cluster (hair, clothes), 1 = its bright cluster (skin),
// 0.5 = the split. Everything outside the person matte reads as paper-bright, as in the reel.
float tone(vec2 uv, float r) {
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float t = (luma(camBlur(uv, r)) - lv.x) / max(lv.y - lv.x, 0.10);
  return clamp(mix(1.0, t, matte(uv)), 0.0, 1.0);
}
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {                        // smooth value noise
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + 1.0), f.x), f.y);
}
// blue noise fixed to the frame (never animated): s = grain size in px at 1080 wide
vec4 grain(vec2 uv, float s) { return texture(uNoise, uv * uRes / (256.0 * s * uRes.x / 1080.0)); }
// stochastic screen: density d prints where it beats the grain; d = 0 never, d = 1 always
float screenAt(float d, float n) { return smoothstep(n * 0.92, n * 0.92 + 0.08, d); }

// 0 cyanotype: bright -> prussian blue, dark -> bare paper. Sandy edge, uneven coating, drag marks, scratches, dust.
vec3 look0(vec2 uv) {
  float t = tone(uv, 3.5);
  vec4 n = grain(uv, 1.25);
  float asp = uRes.x / uRes.y; vec2 p = vec2(uv.x * asp, uv.y);
  float cloud = 0.6 * vn(uv * vec2(7.0, 4.0)) + 0.4 * vn(uv * vec2(31.0, 19.0) + 7.3);          // uneven coating
  float drag = vn(vec2(uv.x * 5.0, uv.y * 170.0)) * vn(uv * vec2(2.0, 9.0) + 3.1);              // horizontal brush drag
  float d = smoothstep(0.28, 0.72, t + (cloud - 0.5) * 0.12 + (drag - 0.25) * 0.20);
  float ink = screenAt(d, n.r);
  ink = max(ink * (1.0 - step(0.9965, h21(floor(uv * uRes / (1.6 * uRes.x / 1080.0)))) * smoothstep(0.45, 0.7, vn(uv * vec2(9.0, 6.0) + 11.0))), step(0.975 - 0.09 * smoothstep(0.35, 0.75, vn(uv * vec2(40.0, 26.0) + 5.0)), n.g) * 0.7 * (1.0 - d));              // pinholes in the blue, specks on the paper
  vec3 blue = mix(vec3(0.060, 0.270, 0.490), vec3(0.120, 0.345, 0.560), smoothstep(0.25, 0.75, cloud));   // #0f457d .. #1f588f around #144d84
  blue += 0.05 * smoothstep(0.30, 0.55, drag) * vec3(0.7, 0.9, 1.0) + (n.a - 0.5) * 0.035;
  float sc = 0.0;                                                                              // four fixed scratches
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 o = vec2(h21(vec2(fi, 1.7)) * asp, h21(vec2(fi, 9.2)));
    float a = (h21(vec2(fi, 4.4)) - 0.5) * 1.2 + (i < 1 ? 1.57 : 0.0);
    vec2 dir = vec2(cos(a), sin(a)); vec2 q = p - o;
    float al = dot(q, dir), ds = abs(dot(q, vec2(-dir.y, dir.x)) + 0.004 * sin(al * 9.0)) * uRes.y;
    sc = max(sc, (1.0 - smoothstep(0.35, 1.0, ds)) * step(abs(al), 0.10 + 0.22 * h21(vec2(fi, 7.7))) * smoothstep(0.35, 0.6, vn(vec2(al * 60.0, fi))));
  }
  vec3 paper = vec3(0.914, 0.937, 0.957) * (0.935 + 0.085 * vn(uv * vec2(150.0, 90.0)) + 0.04 * vn(uv * vec2(18.0, 11.0)));   // #e9eff4, mottled
  return mix(paper, mix(blue, paper, sc * 0.38), ink);
}
// 1 risograph: three plates, each its own tone ramp, register offset and grain. Yellow + blue overprint to green.
float plate(vec2 uv, float off, float lo, float hi, float n) {
  return screenAt(1.0 - smoothstep(lo, hi, tone(uv + vec2(off, 0.0), 4.5)), n);
}
vec3 look1(vec2 uv) {
  float d = 0.0095;                                  // 10 px at 1080 wide
  vec4 n = grain(uv, 1.35);
  float Y = plate(uv, d, 0.30, 0.74, n.r), C = plate(uv, -d, 0.26, 0.70, n.g), P = plate(uv, -2.1 * d, 0.40, 0.90, n.b) * 0.8;
  vec3 col = vec3(0.980, 0.961, 0.922);              // #faf5eb
  col = mix(col, vec3(0.953, 0.749, 0.855), P);      // pink #f3bfda, the lightest plate, furthest out
  col = mix(col, vec3(0.960, 0.770, 0.020), Y);      // yellow
  col = mix(col, mix(vec3(0.090, 0.580, 0.725), vec3(0.004, 0.408, 0.020), Y), C);   // blue #1794b9; over yellow -> green #016805
  return col;
}
// 2 dotted: square grid, 130 across. Dot size follows skin redness (large, touching) with a small floor on the
// subject's darks (pin dots on hair and clothes); soft rims; small dots print duller.
vec3 look2(vec2 uv) {
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float pitch = uRes.x / 130.0;
  vec2 px = uv * uRes, cell = floor(px / pitch), cc = (cell + 0.5) * pitch, cu = cc / uRes;
  vec3 s = camBlur(cu, 3.0);
  float skin = smoothstep(0.04, 0.30, (s.r - s.g) * 0.5 / max(lv.y, 0.2)) * smoothstep(lv.x, mix(lv.x, lv.y, 0.6), luma(s));
  float tn = tone(cu, 3.0);
  float k = max(max(skin, 0.7 * smoothstep(0.5, 0.95, tn)), mix(0.07, 0.20, smoothstep(0.05, 0.5, tn))) * matte(cu);
  float r = pitch * 0.57 * sqrt(k);
  float m = (1.0 - smoothstep(r - 0.9, r + 0.9, length(px - cc))) * smoothstep(0.02, 0.05, k);
  return mix(vec3(0.984, 0.980, 0.976), mix(vec3(0.690, 0.330, 0.370), vec3(0.906, 0.290, 0.250), smoothstep(0.15, 0.6, k)), m);   // #fbfaf9; #b0545e .. #e74a40
}
// 3 ink (ours): one red plate on cream, same stochastic screen
vec3 look3(vec2 uv) {
  vec4 n = grain(uv, 1.35);
  float t = plate(uv, 0.0, 0.28, 0.72, n.r);
  return mix(vec3(0.980, 0.961, 0.922), vec3(0.847, 0.192, 0.243) * (0.95 + 0.10 * n.a), t);
}
vec3 lookCol(int id, vec2 uv) {
${lookExpr.map((e, i) => `  if (id == ${i}) return ${e};`).join('\n')}
  return texture(uCam, uv).rgb;
}

void main() {
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(vUv.x * asp, vUv.y);
  vec3 col = texture(uCam, vUv).rgb;
  for (int k = 0; k < 4; k++) {
    if (float(k) >= uRgN) break;
    vec4 P = uRgP[k];
    if (P.y <= 0.002) continue;
    vec2 st; float cov, line;
    if (!rgQuad(k, p, u_strings, 0.7, st, cov, line)) continue;
    if (cov > 0.0) col = mix(col, lookCol(int(mod(P.x + u_rotate + 0.5, ${NL}.0)), vUv), cov * P.y);
    col = mix(col, RG_LINE, line * u_strings * P.y);       // strings: finger-to-finger edges, fainter hand-side edges
  }
  if (u_solo > 0.5) col = lookCol(int(u_solo - 0.5), vUv);      // lab only: one look full frame, for recipe checks
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- auto levels (1 x 1 buffer)
// Otsu split of the luma of 16 x 9 samples weighted by the person matte -> (dark-cluster mean, bright-cluster mean),
// eased over time. Natively: the same on a 16 x 9 downsample on the CPU, two floats as uniforms.
const LEVELS = /* glsl */`
void main() {
  float L[144]; float W[144]; float sw = 0.0;
  for (int i = 0; i < 144; i++) {
    vec2 q = (vec2(float(i % 16), float(i / 16)) + 0.5) / vec2(16.0, 9.0);
    L[i] = dot(texture(uCam, q).rgb, vec3(0.299, 0.587, 0.114));
    W[i] = mix(1.0, 0.02 + smoothstep(0.3, 0.6, texture(uPerson, q).r), uPersonReady); sw += W[i];
  }
  float best = -1.0, lo = 0.12, hi = 0.5;
  for (int k = 1; k < 32; k++) {
    float th = float(k) / 32.0, w0 = 0.0, m0 = 0.0, m1 = 0.0;
    for (int i = 0; i < 144; i++) { if (L[i] < th) { w0 += W[i]; m0 += W[i] * L[i]; } else m1 += W[i] * L[i]; }
    float w1 = sw - w0; if (w0 < 0.03 * sw || w1 < 0.03 * sw) continue;
    m0 /= w0; m1 /= w1; float sc = w0 * w1 * (m1 - m0) * (m1 - m0);
    if (sc > best) { best = sc; lo = m0; hi = m1; }
  }
  vec4 prev = texture(uSelf, vec2(0.5));
  fragColor = prev.a < 0.5 ? vec4(lo, hi, 0.0, 1.0) : vec4(mix(prev.xy, vec2(lo, hi), 0.06), 0.0, 1.0);
}`;

// ---------------------------------------------------------------- CPU: the shared region tracker
function frame(ctx) {
  const P = ctx.params;
  const u = trackRegion(ctx, ctx.state, { n: P.webs, set: P.fingers, trail: P.trail, oneHand: P.oneHand > 0.5, curl: P.curl > 0.5, order: 'fixed' });
  return { ...u, ...SLOTS.frame() };
}

export default {
  id: 'hand-webs',
  name: 'Hand Webs',
  ref: { clip: 'DcoOO6JOtKo', t: [24.6, 27.0] },
  needs: [...new Set(['hands', 'person', ...SLOTS.needs])],
  looks: LOOKS,
  params: [
    { id: 'webs', label: 'Webs', type: 'int', min: 1, max: 4, default: 3 },
    { id: 'rotate', label: 'Look order', type: 'int', min: 0, max: 3, default: 0 },
    { id: 'trail', label: 'Trail', type: 'float', min: 0, max: 1, default: 0.3 },
    { id: 'strings', label: 'Strings', type: 'float', min: 0, max: 1, default: 0.25 },
    { id: 'oneHand', label: 'One-hand fan', type: 'bool', default: true },
    { id: 'fingers', label: 'Fingers', type: 'enum', options: FINGER_SET_NAMES, default: 0 },
    { id: 'curl', label: 'Raised fingers only', type: 'bool', default: true, more: true },
    { id: 'solo', label: 'Solo look (lab)', type: 'int', min: 0, max: 4, default: 0, more: true },
  ],
  passes: [...SLOTS.passes, { name: 'lv', frag: LEVELS, size: [1, 1], feedback: true, filter: 'nearest' }, { name: 'out', frag: FRAG, screen: true }],
  async init() { await SLOTS.init(); },
  frame,
};
