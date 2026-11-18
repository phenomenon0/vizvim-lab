// ascii-type — the picture is simplified first, then set in type.
// Subject (person matte) is kept, the room drops to blank paper; tone is normalised against the
// local exposure and posterised to four bands, each printed with ONE light fill glyph from the
// palette's own set; contours come from a blurred, thinned, thresholded edge map and are drawn
// with stroke glyphs (/ \ | _ - ( ) ...) picked by 2x3 shape match against a real monospace atlas.
// The face is the point: levels are Otsu clusters of the subject, inside the face contours come from the
// fine-scale gradient and features darker than the skin around them are inked, the cell width follows the
// subject's size (latched) so a small face still gets its cells, and each fill band alternates two glyphs.
// Passes: tone (1/2) -> sm (1/4 blur: luma + matte) -> lo (1/16 local exposure) -> em (1/4 gradient)
// -> edge (1/2 thinned contour) -> fa/fb (per-cell features, temporally smoothed) -> glyph (per-cell
// choice + hysteresis) -> disp (hand scatter) -> text -> glow -> out.

const NG = 95, ACOLS = 16, AROWS = 6, GW = 32, GH = 64;   // atlas: 16 x 6 glyph cells of 32 x 64 px

function buildAtlas() {
  const cv = document.createElement('canvas'); cv.width = ACOLS * GW; cv.height = AROWS * GH;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  const fam = "Menlo, Monaco, 'DejaVu Sans Mono', 'Liberation Mono', Consolas, monospace";
  g.font = `100px ${fam}`;
  const adv = g.measureText('M').width || 60;
  const px = Math.min(GW / adv * 100, 58);                   // advance == cell width
  g.font = `${px}px ${fam}`;
  const m = g.measureText('Mgjy|');
  const asc = m.fontBoundingBoxAscent || px * 0.93, desc = m.fontBoundingBoxDescent || px * 0.24;
  const base = (GH - (asc + desc)) / 2 + asc;
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 0.8; g.lineJoin = 'round'; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  for (let i = 0; i < NG; i++) {
    const cx = (i % ACOLS) * GW, cy = Math.floor(i / ACOLS) * GH;
    g.save(); g.beginPath(); g.rect(cx, cy, GW, GH); g.clip();
    g.fillText(String.fromCharCode(32 + i), cx + GW / 2, cy + base);
    g.strokeText(String.fromCharCode(32 + i), cx + GW / 2, cy + base); g.restore();   // a touch heavier than Regular: holds up at 7 px
  }
  // 2x3 descriptors (k = sx + 2 * syTop), normalised by the densest sub-cell of any glyph
  const img = g.getImageData(0, 0, cv.width, cv.height).data;
  const d = new Float32Array(NG * 6); let mx = 1e-6;
  const ys = [0, Math.round(GH / 3), Math.round(2 * GH / 3), GH];
  for (let i = 0; i < NG; i++) {
    const cx = (i % ACOLS) * GW, cy = Math.floor(i / ACOLS) * GH;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 2; sx++) {
      let s = 0, n = 0;
      for (let y = ys[sy]; y < ys[sy + 1]; y++) for (let x = sx * GW / 2; x < (sx + 1) * GW / 2; x++) { s += img[((cy + y) * cv.width + cx + x) * 4]; n++; }
      const v = s / n / 255; d[i * 6 + sy * 2 + sx] = v; mx = Math.max(mx, v);
    }
  }
  const tex = new Float32Array(96 * 2 * 4);
  for (let i = 0; i < NG; i++) {
    let cov = 0; for (let k = 0; k < 6; k++) cov += d[i * 6 + k] / 6;
    tex.set([d[i * 6] / mx, d[i * 6 + 1] / mx, d[i * 6 + 2] / mx, cov / mx], i * 4);
    tex.set([d[i * 6 + 3] / mx, d[i * 6 + 4] / mx, d[i * 6 + 5] / mx, 0], (96 + i) * 4);
  }
  return { canvas: cv, desc: tex };
}

const CONT = [15,60,92,63,13,8,9,7,12,62,94,2,29,64];   // contour glyphs: /\|_-()',^~"=`
const FILL  = [14,26,17,19, 14,26,11,3, 14,26,29,24, 14,13,29,3, 14,26,79,24, 14,26,11,3];   // per palette: light, mid, heavy, mass
const FILL2 = [12,27,16,24, 12,27,88,24, 12,27,94,19, 12,94,11,24, 12,27,69,34, 12,27,88,24];  // its partner: runs alternate (1010), light and mass are salted

const COMMON = /* glsl */ `
uniform sampler2D uAtlas; uniform sampler2D uDesc;
// cell width: Size, made finer when the figure is small (latched in the lv pass so the grid never chatters)
vec2 cellSize() {
  float w = texelFetch(uBuf_lv, ivec2(0), 0).b;
  if (w < 2.5) w = max(4.0, floor(u_size * uRes.y / 720.0 + 0.5));
  return vec2(w, 2.0 * w);
}
vec2 gridOff() { vec2 cs = cellSize(); return floor((uRes - ceil(uRes / cs) * cs) * 0.5); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
bool darkOnLight() { int p = int(u_palette + 0.5); return p == 0 || p == 2; }
// how much of the picture survives here: 1 on the subject, Background elsewhere
float keep(float matte) { return uPersonReady > 0.5 ? mix(u_background, 1.0, smoothstep(0.25, 0.6, matte)) : 1.0; }
`;

// Levels (1 x 1, feedback): Otsu split of the blurred luma (last frame's sm) over 16 x 9 samples, the person
// weighted 1, the room 0.06 -> x dark-cluster mean, y bright-cluster mean. Eased 0.6 s behind a hard dead band.
const LV = /* glsl */ `
void main(){
  float L[144]; float W[144]; float sw = 0.0, area = 0.0;
  for (int i = 0; i < 144; i++) {
    vec2 q = (vec2(float(i % 16), float(i / 16)) + 0.5) / vec2(16.0, 9.0);
    vec2 s = texture(uBuf_sm, q).rg;
    L[i] = s.r; area += smoothstep(0.3, 0.6, s.g) / 144.0;
    W[i] = uPersonReady > 0.5 ? 0.06 + 0.94 * smoothstep(0.3, 0.6, s.g) : 1.0; sw += W[i];
  }
  float best = -1.0, lo = 0.12, hi = 0.5;
  for (int k = 1; k < 32; k++) {
    float th = float(k) / 32.0, w0 = 0.0, m0 = 0.0, m1 = 0.0;
    for (int i = 0; i < 144; i++) { if (L[i] < th) { w0 += W[i]; m0 += W[i] * L[i]; } else m1 += W[i] * L[i]; }
    float w1 = sw - w0; if (w0 < 0.04 * sw || w1 < 0.04 * sw) continue;
    m0 /= w0; m1 /= w1; float sc = w0 * w1 * (m1 - m0) * (m1 - m0);
    if (sc > best) { best = sc; lo = m0; hi = m1; }
  }
  vec4 prev = texture(uSelf, vec2(0.5));
  vec2 dl = vec2(lo, hi) - prev.xy;
  float dt = uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0;
  dl *= step(0.015, abs(dl)) * (1.0 - exp(-dt / 0.6));
  // subject-aware cell: a head is about 0.24 sqrt(person area) of the frame width; give it ~28 columns
  float base = max(4.0, floor(u_size * uRes.y / 720.0 + 0.5));
  float want = uPersonReady > 0.5 && area > 0.01 ? clamp(0.24 * sqrt(area) * uRes.x / 28.0, MINW, base) : base;
  float w = prev.b;
  if (prev.a < 0.5 || w < 2.5 || w > base || abs(want - w) > 0.8) w = floor(want + 0.5);
  fragColor = prev.a > 0.5 ? vec4(prev.xy + dl, w, 1.0) : vec4(lo, hi, w, 1.0);
}`.replace('MINW', '3.0');

// half res: rgb = 4-tap box of the camera, a = luma
const TONE = COMMON + /* glsl */ `
void main() {
  vec2 px = 1.0 / uRes;
  vec3 c = 0.25 * (texture(uCam, vUv + vec2(-.5, -.5) * px).rgb + texture(uCam, vUv + vec2(.5, -.5) * px).rgb
                 + texture(uCam, vUv + vec2(-.5, .5) * px).rgb + texture(uCam, vUv + vec2(.5, .5) * px).rgb);
  fragColor = vec4(c, lum(c));
}`;

// quarter res: r = luma blurred over about a character, g = person matte blurred the same, b = luma, 4 px box (fine)
const SM = COMMON + /* glsl */ `
void main() {
  float s = 0.0, m = 0.0, ws = 0.0; vec2 st = 1.0 / uPassRes;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = exp(-float(i * i + j * j) / 3.0); vec2 p = vUv + vec2(float(i), float(j)) * st;
    s += w * texture(uBuf_tone, p).a; m += w * texture(uPerson, p).r; ws += w;
  }
  fragColor = vec4(s / ws, m / ws, texture(uBuf_tone, vUv).a, 1.0);
}`;

// 1/16 res: wide blur of luma, the local exposure the tone is read against
const LO = COMMON + /* glsl */ `
void main() {
  float s = 0.0, ws = 0.0; vec2 st = 1.0 / uPassRes;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float w = exp(-float(i * i + j * j) / 6.0);
    s += w * texture(uBuf_sm, vUv + vec2(float(i), float(j)) * st * 1.5).r; ws += w;
  }
  fragColor = vec4(s / ws);
}`;

// quarter res: Sobel of the blurred luma (relative to local exposure) and of the matte.
// rg = gradient direction, b = magnitude (subject-weighted), a = 1
const EM = COMMON + /* glsl */ `
vec3 S(vec2 o) { return texture(uBuf_sm, vUv + o / uPassRes).rgb; }
void main() {
  vec3 a = S(vec2(-1, 1)), b = S(vec2(0, 1)), c = S(vec2(1, 1)), d = S(vec2(-1, 0)), f = S(vec2(1, 0)),
       g = S(vec2(-1, -1)), h = S(vec2(0, -1)), i = S(vec2(1, -1));
  vec3 gx = (c + 2. * f + i) - (a + 2. * d + g), gy = (a + 2. * b + c) - (g + 2. * h + i);
  vec3 me = S(vec2(0.0));
  float lb = texture(uBuf_lo, vUv).r;
  vec2 gl = vec2(gx.x, gy.x) / (0.18 + lb);               // picture contour, relative
  // inside the face (the subject's bright cluster) the contour is read at the fine scale, so brows, eyes,
  // nose and mouth are drawn instead of being blurred away
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float face = smoothstep(0.3, 0.65, (me.x - lv.x) / max(lv.y - lv.x, 0.12)) * (uPersonReady > 0.5 ? smoothstep(0.5, 0.8, me.y) : 1.0);
  gl = mix(gl, vec2(gx.z, gy.z) / (0.18 + lb) * 0.8, face);
  vec2 gm = vec2(gx.y, gy.y);                             // silhouette of the subject
  // one field, one stroke: the matte's edge is added to the picture's, pointing the same way, so the
  // silhouette is a single line where the two nearly coincide
  gl *= uPersonReady > 0.5 ? mix(u_background, 1.0, smoothstep(0.08, 0.4, me.y)) : 1.0;
  if (uPersonReady < 0.5) gm = vec2(0.0);
  if (dot(gl, gm) < 0.0) gm = -gm;
  vec2 dir = gl + gm * 0.6;
  fragColor = vec4(normalize(dir + 1e-5), length(dir), 1.0);
}`;

// half res: non-maximum suppression along the gradient + threshold = one confident stroke per contour
const EDGE = COMMON + /* glsl */ `
void main() {
  vec4 e = texture(uBuf_em, vUv);
  vec2 st = e.xy / (uRes * 0.25);
  float m1 = texture(uBuf_em, vUv + st).b, m2 = texture(uBuf_em, vUv - st).b;
  float thr = mix(1.0, 0.24, u_edges);
  float ridge = smoothstep(-0.02, 0.02, e.b - max(m1, m2) * 0.985);
  fragColor = vec4(ridge * smoothstep(thr, thr * 1.5, e.b));
}`;

// one texel per cell, feedback. rgb = contour ink in three sub-cells of one column (top, middle,
// bottom); HALF 0 = left column (a = init flag), HALF 1 = right column (a = the cell's tone ink 0..1)
const FEAT = (half) => COMMON + /* glsl */ `
void main() {
  vec2 cs = cellSize(), off = gridOff();
  ivec2 ci = ivec2(gl_FragCoord.xy);
  vec2 org = off + vec2(ci) * cs;
  if (org.x > uRes.x || org.y > uRes.y) { fragColor = vec4(0.0); return; }
  vec3 t = vec3(0.0);
  for (int sy = 0; sy < 3; sy++) {
    float s = 0.0;
    for (int j = 0; j < 3; j++) for (int i = 0; i < 2; i++) {
      vec2 p = org + (vec2(${half}.0, float(sy)) + (vec2(float(i), float(j)) + 0.5) / vec2(2.0, 3.0)) * cs / vec2(2.0, 3.0);
      s += texture(uBuf_edge, p / uRes).r;
    }
    t[2 - sy] = s / 6.0;
  }
  // tone: blurred luma against the local exposure, subject only
  vec2 uv = (org + 0.5 * cs) / uRes;
  vec3 sm = texture(uBuf_sm, uv).rgb; float lb = texture(uBuf_lo, uv).r;
  float fine = 0.5 * (texture(uBuf_sm, (org + vec2(0.5, 0.3) * cs) / uRes).b + texture(uBuf_sm, (org + vec2(0.5, 0.7) * cs) / uRes).b);
  // auto levels: the subject's dark cluster (hair, clothes) -> 0.16, its bright cluster (skin) -> 0.84,
  // plus local contrast against the wide exposure so features cut inside either cluster
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float rng = max(lv.y - lv.x, 0.12);
  float l = 0.16 + 0.68 * (sm.r - lv.x) / rng + (sm.r - lb) / rng * 0.55;
  // features: what is darker than the face around it (brow, eye, nostril, lips) is inked from the fine luma
  l = clamp(l + min(fine - sm.r, 0.0) / rng * 3.6 * smoothstep(0.3, 0.65, (sm.r - lv.x) / rng), 0.0, 1.0);
  float v = (darkOnLight() ? 1.0 - l : l) * keep(sm.g);
  // light-on-dark: the subject's own shadows still carry the lightest fill, so the figure is a body, not a wire
  if (!darkOnLight() && uPersonReady > 0.5) v = max(v, 0.36 * smoothstep(0.45, 0.7, sm.g));
  vec4 nw = vec4(t, ${half} == 0 ? 1.0 : v);
  vec4 prev = texelFetch(uSelf, ci, 0);
  bool init = ${half == 0 ? 'prev.a' : 'texelFetch(uBuf_glyph, ci, 0).a'} > 0.5;   // glyph is a later pass: last frame's
  vec4 d = abs(nw - prev);
  float k = !init ? 1.0 : clamp(max(max(d.x, d.y), max(d.z, ${half} == 0 ? 0.0 : d.w)) * 7.0, 0.12, 1.0);
  fragColor = mix(prev, nw, k); if (${half} == 0) fragColor.a = 1.0;
}`;

// one texel per character cell. r = glyph index + 1, g = class (0 blank, 1..4 tone band, 5 contour),
// b = brightness level, a = 1
const GLYPH = COMMON + /* glsl */ `
const int CONT[${CONT.length}] = int[${CONT.length}](${CONT.join(', ')});
const int FILL[24] = int[24](${FILL.join(', ')});
const int FILL2[24] = int[24](${FILL2.join(', ')});
void main() {
  ivec2 ci = ivec2(gl_FragCoord.xy);
  vec4 fa = texelFetch(uBuf_fa, ci, 0), fb = texelFetch(uBuf_fb, ci, 0);
  if (fa.a < 0.5) { fragColor = vec4(0.0); return; }
  vec4 prev = texelFetch(uSelf, ci, 0);
  int pcls = int(prev.g + 0.5), pi = int(prev.r + 0.5) - 1; bool had = prev.a > 0.5;
  vec3 ta = vec3(fa.r, fb.r, fa.g), tb = vec3(fb.g, fa.b, fb.b);   // k = sx + 2 * row from the top
  float mx = max(max(max(ta.x, ta.y), max(ta.z, tb.x)), max(tb.y, tb.z));
  // contour cell? (Schmitt: a stroke that is there stays until it has clearly gone)
  if (mx > ((had && pcls == 5) ? 0.2 : 0.3)) {
    ta /= mx; tb /= mx;
    float best = 1e9, pe = 1e9; int bi = 0;
    for (int n = 0; n < ${CONT.length}; n++) {
      int g = CONT[n];
      vec3 da = texelFetch(uDesc, ivec2(g, 0), 0).rgb, db = texelFetch(uDesc, ivec2(g, 1), 0).rgb;
      float dm = max(max(max(da.x, da.y), max(da.z, db.x)), max(db.y, db.z));
      da = da / dm - ta; db = db / dm - tb;
      float e = dot(da, da) + dot(db, db);
      if (e < best) { best = e; bi = g; }
      if (g == pi) pe = e;
    }
    if (had && pcls == 5 && pe < best * 1.8 + 0.08) bi = pi;
    fragColor = vec4(float(bi) + 1.0, 5.0, 1.0, 1.0); return;
  }
  // tone band with hysteresis; one fill glyph per band from the palette's set
  float v = fb.a; int band = 0;
  float hy = 0.03;
  float t1 = 0.30, t2 = 0.52, t3 = 0.76, t4 = 0.95;
  if (had && pcls >= 1 && pcls <= 4) { float pb = float(pcls);
    t1 += pb >= 1.0 ? -hy : hy; t2 += pb >= 2.0 ? -hy : hy; t3 += pb >= 3.0 ? -hy : hy; t4 += pb >= 4.0 ? -hy : hy; }
  band = v > t4 ? 4 : v > t3 ? 3 : v > t2 ? 2 : v > t1 ? 1 : 0;
  int k = int(u_palette + 0.5) * 4 + band - 1;
  float hh = h21(vec2(ci) + 7.3);                            // fixed per cell: the mix never reshuffles
  bool alt = band == 3 ? ((ci.x + ci.y / 2) & 1) == 1 : band == 2 ? hh < 0.3 : hh < 0.14;
  int gi = band == 0 ? 0 : alt ? FILL2[k] : FILL[k];
  fragColor = vec4(float(gi) + 1.0, float(band), 0.74 + 0.26 * float(band - 1) / 3.0, 1.0);
}`;

// hand scatter: per-cell displacement (xy, in cell widths) + velocity (zw); spring back to the grid
const DISP = COMMON + /* glsl */ `
void main() {
  vec2 cs = cellSize(), off = gridOff(); ivec2 ci = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSelf, ci, 0);
  vec2 x = s.xy, v = s.zw;
  vec2 c = (off + (vec2(ci) + 0.5) * cs) / uRes;
  float dt = clamp(uDt, 0.004, 0.05), asp = uRes.x / uRes.y;
  vec2 acc = vec2(0.0);
  float mass = mix(0.6, 1.6, h21(vec2(ci) + 3.7));
  for (int h = 0; h < 2; h++) {
    if (h >= uHandCount) break;
    vec2 d = (c - uHandCenter[h]) * vec2(asp, 1.0);
    vec2 hv = uHandVel[h] * vec2(asp, 1.0);
    float sp = length(hv), r = 0.17;
    float w = exp(-dot(d, d) / (r * r));
    vec2 dir = normalize(d + 1e-4) + (vec2(h21(vec2(ci) + 11.0), h21(vec2(ci) + 23.0)) - 0.5) * 1.2;
    acc += w * (hv * 0.9 + dir * sp * 0.9) * smoothstep(0.15, 0.8, sp) * 260.0 / mass;
  }
  acc *= u_scatter;
  acc += -90.0 * x - 9.0 * v;                               // under-damped: letters overshoot and settle
  v += acc * dt; x += v * dt;
  x = clamp(x, vec2(-2.0), vec2(2.0));
  if (dot(x, x) < 1e-5 && dot(v, v) < 1e-4) { x = vec2(0.0); v = vec2(0.0); }
  fragColor = vec4(x, v);
}`;

// full res: rgb = ink colour of the covering glyph (used by Colour palette), a = coverage
const TEXT = COMMON + /* glsl */ `
void main() {
  vec2 cs = cellSize(), off = gridOff();
  vec2 p = gl_FragCoord.xy - off;
  ivec2 c0 = ivec2(floor(p / cs));
  float lod = max(0.0, log2(${GW}.0 / cs.x));
  float cov = 0.0; vec3 col = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -2; i <= 2; i++) {
    ivec2 ci = c0 + ivec2(i, j);
    if (ci.x < 0 || ci.y < 0) continue;
    vec4 g = texelFetch(uBuf_glyph, ci, 0);
    if (g.a < 0.5 || g.r < 1.5) continue;                   // unset or space
    vec2 d = texelFetch(uBuf_disp, ci, 0).xy * cs.x;
    vec2 q = (p - (vec2(ci) * cs + d)) / cs;                // 0..1 inside the glyph box, y up
    if (int(u_palette + 0.5) == 3) q.y = (q.y - 0.11) / 0.78;  // Terminal: line spacing, a dark gap between rows
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) continue;
    int gi = int(g.r + 0.5) - 1;
    vec2 auv = (vec2(float(gi % ${ACOLS}), float(${AROWS - 1} - gi / ${ACOLS})) + clamp(q, 0.02, 0.98)) / vec2(${ACOLS}.0, ${AROWS}.0);
    float a = textureLod(uAtlas, auv, lod).r;
    // light-on-dark: a glyph in a mid tone is also dimmer, as on a terminal with grey levels
    if (!darkOnLight()) a *= g.b;
    if (a > cov) { cov = a; col = texture(uBuf_tone, (off + (vec2(ci) + 0.5) * cs) / uRes).rgb; }
  }
  cov = smoothstep(0.06, 0.8, cov);                        // re-sharpen the minified atlas
  fragColor = vec4(col, cov);
}`;

const GLOW = /* glsl */ `
void main() {
  vec2 px = 1.0 / uRes; vec4 s = vec4(0.0); float wsum = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float w = exp(-float(i * i + j * j) / 7.0);
    vec4 t = texture(uBuf_text, vUv + vec2(float(i), float(j)) * px * 3.0);
    s += vec4(t.rgb * t.a, t.a) * w; wsum += w;
  }
  fragColor = s / wsum;
}`;

const OUT = COMMON + /* glsl */ `
void main() {
  vec4 t = texture(uBuf_text, vUv); vec4 g = texture(uBuf_glow, vUv);
  int pal = int(u_palette + 0.5);
  vec3 src = texture(uCam, vUv).rgb;
  vec3 bg, fg; float a = t.a;
  vec3 hue = t.rgb / max(max(t.r, max(t.g, t.b)), 0.08);
  if (pal == 0)      { bg = vec3(0.984, 0.976, 0.988); fg = vec3(0.085, 0.08, 0.095); }
  else if (pal == 1) { bg = vec3(0.078, 0.106, 0.149); fg = vec3(0.90, 0.93, 0.97); }
  else if (pal == 2) { bg = vec3(0.965, 0.955, 0.98);  fg = vec3(0.33, 0.31, 0.47); }
  else if (pal == 3) { bg = vec3(0.137, 0.125, 0.145); fg = vec3(0.74, 0.73, 0.76); }
  else if (pal == 4) { bg = vec3(0.02, 0.02, 0.025);   fg = mix(hue, t.rgb, 0.35) * 1.05; }
  else               { bg = src * 0.82;                fg = vec3(0.97); }
  vec3 col = mix(bg, fg, a);
  if (darkOnLight()) {
    col *= 1.0 - 0.55 * u_glow * g.a * (1.0 - a) * (1.0 - fg);           // ink gain: wet ink spreads into the paper
  } else {
    vec3 gc = pal == 4 ? g.rgb / max(g.a, 0.05) * 1.2 : fg;
    col += gc * g.a * u_glow * (pal == 5 ? 0.3 : pal == 3 ? 0.4 : 0.75);                    // phosphor halo
  }
  col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) * 0.012;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export default {
  id: 'ascii-type',
  name: 'ASCII Type',
  ref: { clip: 'DcTpHw4Owmc', t: [6.8, 7.25] },
  needs: ['hands', 'person'],
  params: [
    { id: 'size', label: 'Size', type: 'float', min: 4, max: 20, default: 6 },
    { id: 'palette', label: 'Palette', type: 'enum', options: ['Paper', 'Navy', 'Lavender', 'Terminal', 'Colour', 'Overlay'], default: 0 },
    { id: 'edges', label: 'Edges', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'background', label: 'Background', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'glow', label: 'Glow', type: 'float', min: 0, max: 1, default: 0.35 },
    { id: 'scatter', label: 'Scatter', type: 'float', min: 0, max: 1, default: 0.6 },
  ],
  passes: [
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'tone', frag: TONE, scale: 0.5 },
    { name: 'sm', frag: SM, scale: 0.25 },
    { name: 'lo', frag: LO, scale: 0.0625 },
    { name: 'em', frag: EM, scale: 0.25 },
    { name: 'edge', frag: EDGE, scale: 0.5 },
    { name: 'fa', frag: FEAT(0), scale: 0.25, feedback: true, filter: 'nearest' },
    { name: 'fb', frag: FEAT(1), scale: 0.25, feedback: true, filter: 'nearest' },
    { name: 'glyph', frag: GLYPH, scale: 0.25, feedback: true, filter: 'nearest' },
    { name: 'disp', frag: DISP, scale: 0.25, feedback: true, filter: 'nearest' },
    { name: 'text', frag: TEXT },
    { name: 'glow', frag: GLOW, scale: 0.25 },
    { name: 'out', frag: OUT, screen: true },
  ],
  init(ctx) {
    const a = buildAtlas();
    ctx.state.atlas = ctx.makeTexture(a.canvas, { filter: 'linear', wrap: 'clamp', mipmap: true });
    ctx.state.desc = ctx.makeTexture({ width: 96, height: 2, data: a.desc }, { filter: 'nearest', wrap: 'clamp' });
  },
  frame(ctx) { return { uAtlas: ctx.state.atlas, uDesc: ctx.state.desc }; },
};
