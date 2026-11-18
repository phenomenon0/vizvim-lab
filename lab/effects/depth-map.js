// depth-map — the grey monocular-depth look from DecGDxGue_s (1.45–3.3 s).
// Reference, measured: pure grey ramp (far ~#0b0b0b, near ~#f0eef1), no grain, no vignette,
// silhouette edges 5–6 px wide (10–90 %) at 1080, piecewise-smooth interiors.
// Our depth is Depth Anything v2 small at low res, so the work here is the upsample:
//   g    half-res camera guide (box)                      -> kills sensor noise in the guide
//   up   joint-bilateral upsample of uDepth against g     -> depth edges snap to camera edges
//   fm   finger-gap evidence from the camera, finger zone only (landmarks); fing = low-pass + soft threshold + carve
//   snap toggle/shock filter (push toward local min|max)  -> crisp edge where the camera has no contrast
//   acc  camera-motion-gated temporal EMA (feedback)      -> no breathing on a still room, no ghost on moves
//   out  levels + tint (+ Relief, the beyond item)

const COMMON = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

export const DM_G = COMMON + /* glsl */ `
void main(){
  vec2 px = 1.0 / uCamRes;
  vec3 c = texture(uCam, vUv + px*vec2(-0.5,-0.5)).rgb + texture(uCam, vUv + px*vec2(0.5,-0.5)).rgb
         + texture(uCam, vUv + px*vec2(-0.5, 0.5)).rgb + texture(uCam, vUv + px*vec2(0.5, 0.5)).rgb;
  fragColor = vec4(c * 0.25, 1.0);
}`;

// Joint bilateral upsample. 5x5 taps spaced one depth texel apart, range weight from the guide.
export const DM_UP = COMMON + /* glsl */ `
void main(){
  vec2 dt = 1.0 / vec2(textureSize(uDepth, 0));
  vec3 c0 = texture(uBuf_g, vUv).rgb;
  float acc = 0.0, ws = 0.0;
  // range sigma: tight when Edge is high
  float sc = mix(0.16, 0.065, DM_EDGE);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 o = vec2(float(i), float(j)) * dt;
    vec3 dc = texture(uBuf_g, vUv + o).rgb - c0;
    float w = exp(-dot(dc, dc) / (2.0 * sc * sc)) * exp(-float(i*i + j*j) / 4.5) + 1e-4;
    acc += texture(uDepth, vUv + o).r * w; ws += w;
  }
  fragColor = vec4(vec3(acc / ws), 1.0);
}`;

// Shock/toggle filter: where the neighbourhood spans a real depth step, steepen it.
export const DM_SNAP = COMMON + /* glsl */ `
#ifndef DM_SRC
#define DM_SRC uBuf_up
#endif
void main(){
  vec2 dt = 1.0 / vec2(textureSize(uDepth, 0));
  float d = texture(DM_SRC, vUv).r, mn = d, mx = d;
  float rad = mix(0.6, 1.5, DM_EDGE);
  for (int k = 0; k < 12; k++) {
    float a = 6.2831853 * float(k) / 12.0;
    float r = (k % 2 == 0) ? rad : rad * 0.5;
    float s = texture(DM_SRC, vUv + vec2(cos(a), sin(a)) * dt * r).r;
    mn = min(mn, s); mx = max(mx, s);
  }
  float range = mx - mn;
  float t = (d - mn) / max(range, 1e-5);
  float k = mix(0.5, 0.10, DM_EDGE);                    // half-width of the steepened ramp
  float ts = smoothstep(0.5 - k, 0.5 + k, t);
  float gate = smoothstep(0.06, 0.16, range) * DM_EDGE; // leave gentle gradients alone (no terracing)
  fragColor = vec4(vec3(mn + mix(t, ts, gate) * range), 1.0);
}`;

// Finger carve. The depth net fuses neighbouring fingers into a mitten: the gap between them is
// narrower than its receptive field. Around the four fingers only (from the hand landmarks), build a
// local two-class colour model from a wide ring of taps - "near" = what the camera looks like where
// depth says hand, "far" = where depth says background - and send a pixel that depth calls hand but
// whose FULL-RES camera colour is clearly background down to the background depth. Carve only, never
// fill; everywhere else (palm, thumb, wrist, body, furniture) this pass is a copy, so those silhouettes are untouched.
const FZONE = /* glsl */ `
float segDist(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; return length(p - a - ab * clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0)); }
// x: 1 around and between the four fingers (from a fifth of the way up each finger to just past its tip),
// 0 on the palm, thumb and wrist: those outlines stay exactly what the upsample made them.
// y: 1 on the core of a finger (within ~a quarter finger width of its bones): never carved, whatever the colour
// says (rings, nails, speculars and sensor noise used to punch dots there).
vec2 fingerZone(vec2 uv){
  vec2 k = vec2(1.0, uRes.y / uRes.x); float z = 0.0, core = 0.0;
  for (int h = 0; h < 2; h++) {
    if (h >= uHandCount) break;
    int o = h * 21;
    float s = (distance(uHand[o+5].xy * k, uHand[o+9].xy * k) + distance(uHand[o+9].xy * k, uHand[o+13].xy * k) + distance(uHand[o+13].xy * k, uHand[o+17].xy * k)) / 3.0;
    float dm = 1e3, db = 1e3;
    for (int f = 0; f < 4; f++) {
      vec2 a = uHand[o + 5 + 4*f].xy * k, b = uHand[o + 8 + 4*f].xy * k;
      // only an extended finger has a gap beside it; a curled one (fist, knuckles toward the lens) has creases, not gaps
      float bones = distance(a, uHand[o + 6 + 4*f].xy * k) + distance(uHand[o + 6 + 4*f].xy * k, uHand[o + 7 + 4*f].xy * k) + distance(uHand[o + 7 + 4*f].xy * k, b);
      float ext = smoothstep(0.80, 0.92, distance(a, b) / max(bones, 1e-5)) * smoothstep(0.9, 1.4, bones / max(s, 1e-5));
      dm = min(dm, segDist(uv * k, mix(a, b, 0.25), mix(a, b, 1.1)) + (1.0 - ext) * 2.0 * s);
      for (int j = 0; j < 3; j++) db = min(db, segDist(uv * k, uHand[o + 5 + 4*f + j].xy * k, uHand[o + 6 + 4*f + j].xy * k));
    }
    z = max(z, 1.0 - smoothstep(0.75 * s, 1.1 * s, dm));
    core = max(core, 1.0 - smoothstep(0.16 * s, 0.34 * s, db));
  }
  return vec2(z, core);
}`;

// Finger carve, stage 1 (evidence). The depth net fuses neighbouring fingers into a mitten: the gap between
// them is narrower than its receptive field. Around the four fingers only (from the hand landmarks), build a
// local two-class colour model from a wide ring of taps - "near" = what the camera looks like where depth
// says hand, "far" = where depth says background - and mark a pixel that depth calls hand but whose camera
// colour is clearly background. R = that evidence (0..1), G = the background depth to fall to.
const FM = COMMON + FZONE + /* glsl */ `
void main(){
  float d = texture(uBuf_up, vUv).r;
  vec2 fz = fingerZone(vUv); float hm = fz.x;
  fragColor = vec4(0.0, d, 0.0, 1.0);
  if (hm < 0.02 || DM_EDGE <= 0.0) return;
  float asp = uRes.x / uRes.y;
  float mn = d, mx = d;
  float ds[24]; vec3 cs[24];
  for (int k = 0; k < 24; k++) {
    float a = 6.2831853 * (float(k % 8) + 0.5 * float(k / 8)) / 8.0;
    float r = (k < 8) ? 0.014 : (k < 16 ? 0.032 : 0.056);
    vec2 uv = vUv + vec2(cos(a), sin(a) * asp) * r;
    ds[k] = texture(uBuf_up, uv).r; cs[k] = texture(uBuf_g, uv).rgb;
    mn = min(mn, ds[k]); mx = max(mx, ds[k]);
  }
  float range = mx - mn;
  if (range < 0.12) return;
  vec3 cn = vec3(0.0), cf = vec3(0.0); float wn = 1e-4, wf = 1e-4, df = 0.0, wd = 1e-4;
  for (int k = 0; k < 24; k++) {
    float t = (ds[k] - mn) / range;
    float a = smoothstep(0.75, 0.95, t), b = 1.0 - smoothstep(0.05, 0.25, t);
    cn += cs[k] * a; wn += a; cf += cs[k] * b; wf += b;
    float nb = b * (k < 8 ? 6.0 : (k < 16 ? 2.0 : 1.0)) * (0.02 + t) * (0.02 + t);   // the background depth to fall to is the NEAREST background
    df += ds[k] * nb; wd += nb;
  }
  if (wn < 1.5 || wf < 1.5) return;
  cn /= wn; cf /= wf; df /= wd;
  float sep = distance(cn, cf);
  float sepOk = smoothstep(0.08, 0.20, sep);
  // position of this pixel's colour along the far->near axis: 0 = background, 1 = hand. The half-res guide
  // (a 2x2 box) is the sample: the full-res pixel only adds sensor noise to the decision.
  vec3 c = texture(uBuf_g, vUv).rgb;
  float al = dot(c - cf, cn - cf) / max(sep * sep, 1e-4);
  float bg = (1.0 - smoothstep(0.12, 0.42, al)) * (1.0 - smoothstep(0.35, 0.7, distance(c, cf) / max(sep, 1e-3))) * (1.0 - smoothstep(0.10, 0.20, distance(c, cf)));
  float isNear = smoothstep(0.10, 0.28, (d - mn) / range);
  float ev = bg * sepOk * isNear * smoothstep(0.02, 0.25, hm) * (1.0 - fz.y);
  fragColor = vec4(ev, df, 0.0, 1.0);
}`;

// Stage 2 (decision). The evidence is low-passed (sigma ~2.5 px) and thresholded with a soft step: a gap is a
// smooth-edged slot or it is nothing. Isolated specks and single-pixel teeth cannot survive the vote; the
// 10-90 % width of the cut edge is ~4 px, the same as the upsampled silhouettes around it.
const FING = COMMON + FZONE + /* glsl */ `
uniform float uCarveK;   // 1 for a steady hand, 0 for a fast (motion-blurred) one
void main(){
  float d = texture(uBuf_up, vUv).r;
  fragColor = vec4(vec3(d), 1.0);
  float hm = fingerZone(vUv).x;
  if (hm < 0.02 || DM_EDGE <= 0.0 || DM_CARVE * uCarveK <= 0.0) return;
  vec2 px = 1.25 / uRes; float ev = 0.0, df = 0.0, ws = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float w = exp(-float(i*i + j*j) / 8.0);
    vec2 s = texture(uBuf_fm, vUv + vec2(float(i), float(j)) * px).rg;
    ev += s.r * w; df += s.g * s.r * w; ws += w;
  }
  df = df / max(ev, 1e-4); ev /= ws;
  float carve = smoothstep(0.30, 0.58, ev) * min(1.0, DM_EDGE * 1.4) * DM_CARVE * uCarveK;
  fragColor = vec4(vec3(mix(d, min(d, df), carve)), 1.0);
}`;

// Global scale hold. The provider normalises every frame to its own min..max, and those two extreme pixels
// are noisy: the whole frame's scale jitters by a few % per frame, and jumps when something near enters.
// Match this frame's mean and spread to last frame's output (16x16 samples, 1x1 target; std matching, so
// noise cannot bias the gain) and the temporal pass sees a steady scale. It is applied at 85 %, so the scale
// relaxes to the provider's own within ~6 frames and cannot drift.
const GS = /* glsl */ `
void main(){
  float sd = 0.0, sp = 0.0, sdd = 0.0, spp = 0.0;
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) {
    vec2 uv = (vec2(float(i), float(j)) + 0.5) / 16.0;
    float d = texture(uBuf_snap, uv).r, p = texture(uBuf_acc, uv).r;
    sd += d; sp += p; sdd += d * d; spp += p * p;
  }
  float n = 256.0, md = sd / n, mp = sp / n;
  float vard = sdd / n - md * md, varp = spp / n - mp * mp;
  float g = clamp(sqrt(varp / max(vard, 1e-5)), 0.75, 1.33);
  float o = mp - g * md;
  if (varp < 1e-3 || vard < 1e-3 || uFrame < 2) { g = 1.0; o = 0.0; }
  fragColor = vec4(g, o, 0.0, 1.0);
}`;

// Temporal. The net's answer for a region can flip from frame to frame on sensor noise alone (whole blobs
// move by 0.05-0.2 with nothing happening in the room), so the depth difference is a bad motion detector.
// The camera is a good one: G/B keep a low-passed luma and chroma of the guide, A a short motion memory; where it has not moved, depth follows
// slowly (Smooth sets how slowly); where it has, depth follows at once. No ghost on a moving hand, no
// breathing on a still room.
const ACC = COMMON + /* glsl */ `
vec3 lowCol(vec2 uv){
  vec2 o = 5.0 / uRes;
  return 0.2 * (texture(uBuf_g, uv).rgb + texture(uBuf_g, uv + vec2(o.x, o.y)).rgb + texture(uBuf_g, uv + vec2(-o.x, o.y)).rgb
              + texture(uBuf_g, uv + vec2(o.x, -o.y)).rgb + texture(uBuf_g, uv + vec2(-o.x, -o.y)).rgb);
}
vec2 lc(vec3 c){ return vec2(lum(c), 0.5 + 0.5 * (c.r - c.b)); }          // luma + one chroma axis
float moved(vec2 uv){ vec2 q = lc(lowCol(uv)) - texture(uSelf, uv).gb; return abs(q.x) + abs(q.y); }
void main(){
  vec2 px = 1.0 / uRes;
  // 3x3 gaussian, taps 1.5 px apart (sigma ~1.6 px) = the antialias the reference edges carry
  float d = 0.0; vec2 o = px * 1.5;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float w = (i == 0 ? 0.5 : 0.25) * (j == 0 ? 0.5 : 0.25);
    d += texture(uBuf_snap, vUv + vec2(float(i), float(j)) * o).r * w;
  }
  // Hairline guard. The snap pass can leave 1-3 px streaks along a motion-blurred silhouette and half-cut
  // slots between fingers. A streak is darker (or lighter) than BOTH neighbours across it in some direction:
  // clamp to max-over-directions of min(pair) .. min-over-directions of max(pair), neighbours 2.5 px out.
  // Edges, corners and anything wider than ~4 px pass untouched.
  {
    float lo = 0.0, hi = 1.0;
    for (int k = 0; k < 4; k++) {
      vec2 dir = (k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(0.0, 1.0) : k == 2 ? vec2(0.7071) : vec2(0.7071, -0.7071)) * px * 2.5;
      float p0 = texture(uBuf_snap, vUv + dir).r, p1 = texture(uBuf_snap, vUv - dir).r;
      lo = max(lo, min(p0, p1)); hi = min(hi, max(p0, p1));
    }
    if (lo <= hi) d = clamp(d, lo, hi); else d = clamp(d, hi, lo);
  }
  vec4 pv = texture(uSelf, vUv);
  vec2 gs = texture(uBuf_gs, vec2(0.5)).rg;
  d = mix(d, clamp(d * gs.x + gs.y, 0.0, 1.0), 0.85 * step(0.001, u_smooth));
  vec2 c = lc(lowCol(vUv));
  // camera motion here or next to here (a moving edge uncovers pixels beside it)...
  vec2 e = 10.0 / uRes;
  float m = max(abs(c.x - pv.g) + abs(c.y - pv.b), 0.8 * max(max(moved(vUv + vec2(e.x, 0.0)), moved(vUv - vec2(e.x, 0.0))), max(moved(vUv + vec2(0.0, e.y)), moved(vUv - vec2(0.0, e.y)))));
  // ...or a moment ago (A = motion heat, ~6 frames): what moved gets time to settle on its new depth
  float heat = max(m, pv.a * 0.72);
  float still = pow(0.05, u_smooth);                       // per-frame follow rate with the camera at rest
  float a = mix(still, 1.0, smoothstep(0.022, 0.06, heat));
  // a hand leaving a wall of its own colour moves little in the camera: a depth step this large is followed
  // regardless (the net's noise flips are 0.05-0.2, a real foreground/background swap is more)
  a = max(a, smoothstep(0.20, 0.42, abs(d - pv.r)));
  if (uFrame < 2 || u_smooth <= 0.0) { a = 1.0; heat = 0.0; }
  fragColor = vec4(mix(pv.r, d, a), mix(pv.gb, c, max(a, 0.5)), heat);
}`;

const OUT = COMMON + /* glsl */ `
float D(vec2 uv){ return texture(uBuf_acc, uv).r; }
void main(){
  float d = D(vUv);
  float v = clamp((d - u_far) / max(1.0 - u_far, 1e-3), 0.0, 1.0);
  v = pow(v, u_falloff);
  // Beyond: Relief. Light the depth as a surface so interiors (face, folds, fingers) get form
  // instead of flat grey. Normal from a wide central difference so depth-texel noise stays out.
  if (u_relief > 0.0) {
    vec2 e = 3.0 / uRes;
    float gx = D(vUv + vec2(e.x, 0)) - D(vUv - vec2(e.x, 0));
    float gy = D(vUv + vec2(0, e.y)) - D(vUv - vec2(0, e.y));
    // detail the depth net cannot resolve comes from the camera, only where depth says "surface"
    float lg = lum(texture(uBuf_g, vUv).rgb);
    float lb = 0.25 * (lum(texture(uBuf_g, vUv + vec2(6.0/uRes.x, 0)).rgb) + lum(texture(uBuf_g, vUv - vec2(6.0/uRes.x, 0)).rgb)
                     + lum(texture(uBuf_g, vUv + vec2(0, 6.0/uRes.y)).rgb) + lum(texture(uBuf_g, vUv - vec2(0, 6.0/uRes.y)).rgb));
    vec3 n = normalize(vec3(-gx * 26.0, -gy * 26.0, 1.0));
    float lit = dot(n, normalize(vec3(-0.45, 0.6, 0.66)));
    float shade = (lit - 0.66) * 0.55 + (lg - lb) * 1.6;
    v = clamp(v + u_relief * shade * smoothstep(0.02, 0.25, v), 0.0, 1.0);
  }
  vec3 col = v * u_tint;
  if (uDepthReady < 0.5) col = vec3(lum(texture(uCam, vUv).rgb) * 0.25);
  // 1/255 blue-noise dither so the long ceiling gradient does not band in 8 bit
  col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

const E = '#define DM_EDGE u_edge\n#define DM_CARVE u_carve\n';
const ES = E + '#define DM_SRC uBuf_fing\n';

export default {
  id: 'depth-map',
  name: 'Depth Map',
  ref: { clip: 'DecGDxGue_s', t: [1.5, 3.25] },
  needs: ['depth', 'hands'],
  depthBlend: 1,   // raw per-frame depth: the acc pass owns temporal smoothing
  depthSize: 518,  // the reference's level of detail (desk plane, separate fingers) needs the 518 input; 392 loses both
  params: [
    { id: 'far', label: 'Far', type: 'float', min: -0.3, max: 0.7, default: 0 },
    { id: 'falloff', label: 'Falloff', type: 'float', min: 0.4, max: 2.5, default: 1.0 },
    { id: 'edge', label: 'Edge', type: 'float', min: 0, max: 1, default: 0.75 },
    { id: 'smooth', label: 'Smooth', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'relief', label: 'Relief', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'tint', label: 'Tint', type: 'color', default: '#fbf8fc' },
    { id: 'carve', label: 'Finger carve', type: 'float', min: 0, max: 1, default: 1, more: true },
  ],
  frame(ctx) {
    // a fast hand is motion blur: there are no finger gaps to find and the colour model is unreliable
    const res = ctx.res || [16, 9], asp = res[0] / res[1];
    let sp = 0;
    for (const h of ctx.hands || []) sp = Math.max(sp, Math.hypot(h.vel[0], h.vel[1] / asp));
    const t = Math.min(1, Math.max(0, (sp - 0.5) / 0.7));
    return { uCarveK: 1 - t * t * (3 - 2 * t) };
  },
  passes: [
    { name: 'g', frag: DM_G, scale: 0.5 },
    { name: 'up', frag: E + DM_UP },
    { name: 'fm', frag: E + FM },
    { name: 'fing', frag: E + FING },
    { name: 'snap', frag: ES + DM_SNAP },
    { name: 'gs', frag: GS, size: [1, 1] },
    { name: 'acc', frag: ACC, feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
};
