// martens — three print screens after Karel Martens, from one glyph atlas:
//   Icons  : CMY overprint of rosette icons, one per cell per ink, sized by that ink's density
//   Lines  : vertical line screen, four nested inks per column (hairline, orange, charcoal, blue)
//   Glyphs : black icon ramp, one glyph per cell chosen by tone
// plus the reel's reveal: clap, the look opens in a band between the hands, grows to full frame.
// Breakdown: breakdowns/martens.md

const COMMON = /* glsl */ `
const float PI = 3.14159265;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
`;

// Steadied, low-passed tone record (quarter res). rgb: 3x3 mean of the camera; small differences are
// averaged down over about a second, a real change passes at once. a: 0.5 + 0.5 x steadied person matte (0 = unset).
const TONE = COMMON + /* glsl */ `
void main(){
  vec2 t = 2.0 / vec2(textureSize(uCam, 0));
  vec3 c = texture(uCam, vUv).rgb * 0.25;
  c += (texture(uCam, vUv + vec2(t.x, 0.0)).rgb + texture(uCam, vUv - vec2(t.x, 0.0)).rgb
      + texture(uCam, vUv + vec2(0.0, t.y)).rgb + texture(uCam, vUv - vec2(0.0, t.y)).rgb) * 0.125;
  c += (texture(uCam, vUv + t).rgb + texture(uCam, vUv - t).rgb
      + texture(uCam, vUv + vec2(t.x, -t.y)).rgb + texture(uCam, vUv + vec2(-t.x, t.y)).rgb) * 0.0625;
  vec2 pt = 6.0 / uRes;
  float m = uPersonReady > 0.5 ? 0.25 * (texture(uPerson, vUv + pt).r + texture(uPerson, vUv - pt).r
      + texture(uPerson, vUv + vec2(pt.x, -pt.y)).r + texture(uPerson, vUv + vec2(-pt.x, pt.y)).r) : 0.0;
  vec4 prev = texture(uSelf, vUv);
  if (prev.a < 0.25) { fragColor = vec4(c, 0.5 + 0.5 * m); return; }
  vec3 dv = abs(c - prev.rgb);
  float d = max(dv.r, max(dv.g, dv.b));
  // small differences (sensor noise) are averaged down slowly; a real change passes at once
  float a = max(0.04 * smoothstep(0.003, 0.012, d), smoothstep(0.035, 0.09, d));
  float pm = prev.a * 2.0 - 1.0;
  float am = smoothstep(0.10, 0.35, abs(m - pm));
  fragColor = vec4(mix(prev.rgb, c, a), 0.5 + 0.5 * mix(pm, m, am));
}`;

// Scene meter (tiny, slow EMA, dead band): rgb = local mean colour.
const STAT = COMMON + /* glsl */ `
void main(){
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    c += texture(uCam, vUv + (vec2(float(i), float(j)) - 1.5) * 0.008).rgb;
  c /= 16.0;
  vec4 prev = texture(uSelf, vUv);
  vec3 dv = abs(c - prev.rgb);
  float a = prev.a < 0.5 ? 1.0 : 0.12 * smoothstep(0.004, 0.02, max(dv.r, max(dv.g, dv.b)));
  fragColor = vec4(mix(prev.rgb, c, a), 1.0);
}`;

// Local paper white: per-channel max of the meter over a 5x5 neighbourhood (about +-7% of the width).
const PEAK = COMMON + /* glsl */ `
void main(){
  vec2 t = 1.0 / vec2(textureSize(uBuf_stat, 0));
  vec3 m = vec3(0.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++)
    m = max(m, texture(uBuf_stat, vUv + vec2(float(i), float(j)) * t).rgb);
  fragColor = vec4(m, 1.0);
}`;

// Frame facts (2x2): r person coverage, g fine-cells latch (hysteresis), b global peak luma, a set.
const META = COMMON + /* glsl */ `
void main(){
  float cov = 0.0, pk = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    vec2 u = (vec2(float(i), float(j)) + 0.5) / 8.0;
    cov += texture(uPerson, u).r;
    pk = max(pk, luma(texture(uBuf_stat, u).rgb));
  }
  cov /= 64.0;
  vec4 prev = texture(uSelf, vec2(0.5));
  float fine = prev.a < 0.5 ? step(cov, FINE_MID) : prev.g;
  if (cov < FINE_ON) fine = 1.0;
  if (cov > FINE_OFF) fine = 0.0;
  if (uPersonReady < 0.5) fine = 0.0;
  fragColor = vec4(cov, fine, pk, 1.0);
}`.replace('FINE_MID', '0.31').replace('FINE_ON', '0.29').replace('FINE_OFF', '0.33');

const TILE = 128, ACOLS = 8, AROWS = 4;

// Latch (quarter res): the hysteresis on every step choice downstream (icon step and tool, glyph step,
// line weight). The steadied tone is held exactly until it has moved by more than HOLD, then it snaps.
// Noise left in the tone record (about 0.001) can never walk a cell across a threshold.
const HOLD = COMMON + /* glsl */ `
void main(){
  vec4 c = texture(uBuf_tone, vUv), prev = texture(uSelf, vUv);
  vec3 dv = abs(c.rgb - prev.rgb);
  bool move = prev.a < 0.25 || max(dv.r, max(dv.g, dv.b)) > 0.02;
  fragColor = vec4(move ? c.rgb : prev.rgb, c.a);
}`;

const OUT = COMMON + /* glsl */ `
uniform sampler2D uAtlas;      // ${ACOLS}x${AROWS} tiles, r = ink coverage. 0..15 icons, 16..31 tone ramp
uniform sampler2D uCard;       // found archive card (beyond), multiplies the paper
uniform vec4 uRect[3];         // reveal layers, px: centre xy, half size zw (z <= 0: layer off). 2 is on top
uniform float uRectLook[3];    // look shown by each layer
uniform float uKin;            // kinetic phase, seconds x amount

float gGamma, gGammaF, gPk, gFine;
// Lines grade (unchanged since it was accepted): a very wide local mean lifts a dark subject into the
// scale; it never burns a bright wall down.
// Icons / Glyphs grade (flat): first divide by the local paper white (peak pass), so a mid-bright or
// tinted wall goes to clean paper as the reel's white wall does, then the same dodge and gamma.
vec3 gradeAt(vec3 c, vec2 uv, bool flatten){
  float lm = luma(texture(uBuf_stat, uv).rgb);
  float g = gGamma;
  if (flatten) {
    vec3 pk = texture(uBuf_peak, uv).rgb;
    pk = mix(vec3(luma(pk)), pk, 0.9);                                 // most of the wall's cast goes too
    vec3 dv = max(pk, vec3(0.62 * gPk));                                // a big dark area is not paper
    // the wall clips to paper a little early; the person never does (a face is often the brightest thing in a dim room)
    dv *= uPersonReady > 0.5 ? mix(0.84, 1.16, smoothstep(0.25, 0.75, texture(uBuf_hold, uv).a * 2.0 - 1.0)) : 0.95;
    c /= dv; lm /= luma(dv); g = gGammaF;
  }
  c *= clamp(pow(0.40 / clamp(lm, 0.06, 0.9), 0.4), 0.95, flatten ? mix(1.3, 1.75, clamp(texture(uBuf_hold, uv).a * 2.0 - 1.0, 0.0, 1.0)) : 1.8);
  c = pow(clamp(c, 0.0, 1.0), vec3(g));
  return clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);
}
// mean of the steadied tone over one cell (4 taps on the quarter-res record)
vec3 cellRGB(vec2 cpx, float pitch){
  vec2 o = vec2(0.25 * pitch) / uRes; vec2 uv = cpx / uRes;
  return 0.25 * (texture(uBuf_hold, uv + o).rgb + texture(uBuf_hold, uv - o).rgb
               + texture(uBuf_hold, uv + vec2(o.x, -o.y)).rgb + texture(uBuf_hold, uv + vec2(-o.x, o.y)).rgb);
}
float matteAt(vec2 cpx){ return clamp(texture(uBuf_hold, cpx / uRes).a * 2.0 - 1.0, 0.0, 1.0); }
vec2 atlasUV(int gi, vec2 q){
  return (vec2(float(gi % ${ACOLS}), float(${AROWS - 1} - gi / ${ACOLS})) + clamp(q + 0.5, 0.02, 0.98)) / vec2(${ACOLS}.0, ${AROWS}.0);
}
// q: tile coords, centre 0, +-0.5 = tile edge. px: on-screen size of the tile.
float glyph(int gi, vec2 q, float px){
  if (abs(q.x) > 0.5 || abs(q.y) > 0.5) return 0.0;
  float lod = max(0.0, log2(${TILE}.0 / max(px, 1.0)) - 0.7);
  float a = textureLod(uAtlas, atlasUV(gi, q), lod).r;
  return mix(clamp(a * 1.7, 0.0, 1.0), smoothstep(0.25, 0.75, a), smoothstep(5.0, 9.0, px));   // tiny tiles: keep the speck, do not threshold it away
}
// Printed mark: x = body (edge about one screen pixel softer than the plate, gained outward),
// y = bleed (ink that crept past the edge). Softness is per mark, in the mark's own mips; the frame is not blurred.
vec2 inkMark(int gi, vec2 q, float px){
  if (abs(q.x) > 0.5 || abs(q.y) > 0.5) return vec2(0.0);
  vec2 uv = atlasUV(gi, q);
  float lod = max(0.0, log2(${TILE}.0 / max(px, 1.0)));
  float a = textureLod(uAtlas, uv, lod + 0.3).r;
  float w = textureLod(uAtlas, uv, lod + 1.4).r;
  float body = mix(clamp(a * 1.7, 0.0, 1.0), smoothstep(0.08, 0.82, a), smoothstep(5.0, 9.0, px));
  return vec2(body, smoothstep(0.04, 0.55, w));
}
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// Third pass: the tone ramp again, drawn analytically for SMALL cells (under about 10 px the atlas mips close the
// counters). Same sixteen steps in the same order, each simplified to what survives at 7 px: every counter is at
// least 0.28 of the cell and every stroke at least 0.13, edges one screen pixel wide. q: cell coords +-0.5.
float sdRing(vec2 q, float r, float w){ return abs(length(q) - r) - 0.5 * w; }
float sdBox(vec2 q, vec2 h){ vec2 d = abs(q) - h; return max(d.x, d.y); }
float rampSDF(int k, vec2 q){
  float r = length(q); vec2 a = abs(q);
  float dg = min(abs(q.x - q.y), abs(q.x + q.y)) * 0.7071;             // distance to the diagonals
  float cr = min(a.x, a.y);                                             // distance to the axes
  if (k == 0) return r - 0.10;
  if (k == 1) return r - 0.16;
  if (k == 2) return min(length(q - vec2(0.19, 0.0)), length(q + vec2(0.19, 0.0))) - 0.115;
  if (k == 3) return sdRing(q, 0.22, 0.13);
  if (k == 4) return sdBox(q, vec2(0.19));
  if (k == 5) return max(a.x - 0.62 * a.y - 0.02, a.y - 0.36);          // hourglass
  if (k == 6) return sdRing(q, 0.29, 0.16);
  if (k == 7) return min(sdRing(q, 0.35, 0.13), r - 0.11);              // target
  if (k == 8) return max(a.y - 0.68 * a.x - 0.02, a.x - 0.42);          // bowtie
  if (k == 9) return min(sdRing(q, 0.38, 0.12), max(cr - 0.055, r - 0.38));   // crossed circle
  if (k == 10) return max(r - 0.45, 0.07 - cr);                         // quartered disc
  if (k == 11) return min(sdRing(q, 0.36, 0.17), r - 0.13);             // dotted flower -> heavy ring + eye
  if (k == 12) return max(r - 0.47, 0.07 - dg);                         // disc, white X
  if (k == 13) return r - 0.46;                                         // solid
  if (k == 14) return max(sdBox(q, vec2(0.48)), 0.21 - r);              // square, round hole
  return max(sdBox(q, vec2(0.48)), 0.075 - dg);                         // square, white X
}
float rampSmall(int k, vec2 q, float px){
  if (abs(q.x) > 0.5 || abs(q.y) > 0.5) return 0.0;
  return clamp(0.5 - rampSDF(k, q) * px, 0.0, 1.0);
}

vec3 paperTone(vec3 base, vec2 p, float S){
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  float fib = vnoise(p / S * vec2(0.9, 0.22)) * 0.6 + vnoise(p / S * 0.07) * 0.4;
  base *= 1.0 + (fib - 0.5) * 0.022 + (bn.b - 0.5) * 0.014;
  if (u_card > 0.001) base *= mix(vec3(1.0), texture(uCard, p / uRes).rgb, u_card);
  return base;
}

// ---- Look 0: Icons. Three plates (C M Y). Most cells print the same tool on all three plates at
// three sizes (each ink's own density), so the overlap is a dark plum core with single-ink fringes. ----
vec3 lookIcons(vec2 p, float S){
  float pitch = uRes.x / 65.0 * u_scale;
  vec3 col = paperTone(vec3(0.969, 0.961, 0.929), p, S);              // #F7F5ED
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  float mott = vnoise(p / S * 0.3) * 0.55 + bn.g * 0.45;
  float pin = smoothstep(0.90, 0.97, bn.r * 0.8 + vnoise(p / S * 0.9) * 0.2);   // pinholes in the film
  float m = u_misreg * S * 1.15;
  float sway = sin(uTime * 0.9) * 0.25;
  // subject-aware pitch: a coarse cell whose centre is on the person splits in four
  vec2 g0 = (p - 0.5 * uRes) / pitch;
  vec2 cc = (floor(g0) + 0.5) * pitch + 0.5 * uRes;
  bool fine = false;
  if (gFine > 0.5 && matteAt(cc) > 0.5) {                              // ... if there is detail inside it (eyes, mouth, jaw; not a flat jumper)
    vec2 o = vec2(0.25 * pitch) / uRes; vec2 uv = cc / uRes;
    float a = luma(texture(uBuf_hold, uv + o).rgb), b = luma(texture(uBuf_hold, uv - o).rgb);
    float c2 = luma(texture(uBuf_hold, uv + vec2(o.x, -o.y)).rgb), d2 = luma(texture(uBuf_hold, uv + vec2(-o.x, o.y)).rgb);
    fine = max(max(a, b), max(c2, d2)) - min(min(a, b), min(c2, d2)) > 0.07;
  }
  float pc = fine ? pitch * 0.5 : pitch;
  // Fourth pass: tone picks the icon and its INKS; size only falls away in the lightest quarter.
  // Every icon has three parts (rings, or alternating petals + eye, or a different tool per plate). Each ink
  // prints in a part when that ink's density passes the part's threshold, so one cell carries two or three
  // colours (yellow eye, red petals, cyan frame...), skin is red/orange/yellow, darks are navy with red and
  // cyan parts still showing. Thresholds are per cell; the tone they read is the latched record (hysteresis).
  for (int k = 0; k < 3; k++) {
    vec2 off = (k == 0 ? vec2(1.0, -0.6) : k == 1 ? vec2(-0.8, 0.9) : vec2(0.1, 0.2)) * m * (1.0 + sway) * (fine ? 0.6 : 1.0);
    vec3 ink = k == 0 ? vec3(0.08, 0.62, 0.84) : k == 1 ? vec3(0.93, 0.13, 0.36) : vec3(1.0, 0.86, 0.22);
    vec2 g = (p - 0.5 * uRes + off) / pc;
    vec2 cell = floor(g); vec2 q = g - cell - 0.5;
    vec2 cp = (cell + 0.5) * pc + 0.5 * uRes - off;
    vec2 hcell = cell + (fine ? 57.0 : 0.0);
    vec3 c = gradeAt(cellRGB(cp, pc), cp / uRes, true);
    float L = luma(c);
    c = clamp(mix(vec3(L), c, mix(1.0, 1.6, smoothstep(0.10, 0.40, 1.0 - L))), 0.0, 1.0);   // light tones stay near neutral (the reel's pale cells are khaki, not yellow)
    float mt = matteAt(cp);
    vec3 dd = 1.0 - c;
    // the person never goes to bare paper: a lit face keeps warm ink (yellow, then red), as the reel's does
    dd.b += 0.30 * mt * (1.0 - smoothstep(0.10, 0.55, dd.b));
    dd.g += 0.17 * mt * (1.0 - smoothstep(0.08, 0.50, dd.g));
    float Dm = max(max(dd.r, dd.g), dd.b);
    if (Dm < 0.035) continue;
    float d = k == 0 ? dd.r : k == 1 ? dd.g : dd.b;
    float s = mix(0.36, 0.93, smoothstep(0.05, 0.36, Dm)) * (0.90 + 0.13 * h21(hcell + 3.1));
    s = max(s, 0.72 * mt * step(0.06, Dm));
    s *= 1.0 + 0.10 * smoothstep(0.62, 0.9, Dm);                        // darks fill the cell and touch, as the reel's hair and jacket do
    float hc = h21(hcell * 1.37 + 5.1);
    float step_ = floor(L * 5.0 + hc);
    int gi = int(h21(hcell + step_ * 7.31) * 15.999);
    float hk = h21(hcell + step_ * 1.7 + 11.0);
    float ang = floor(hk * 8.0) * (PI / 8.0) + uKin * (k == 0 ? 0.35 : k == 1 ? -0.6 : 1.0);
    float kind = h21(hcell * 2.3 + step_ * 0.77);
    float sk = s * (k == 2 ? 1.07 : k == 0 ? 1.0 + 0.07 * smoothstep(0.5, 0.85, Dm) : 1.0);   // yellow halo; cyan fringe in the darks
    if (kind > 0.74) {                                                  // a different tool per plate: cyan frame, red flower, yellow core
      gi = k == 0 ? (hk > 0.5 ? 9 : 8) + int(step(0.8, hk)) * 3 : int(h21(hcell + float(k) * 5.7 + step_ * 3.1) * 15.999);
      sk = s * (k == 0 ? 1.04 : k == 1 ? 0.86 : 0.62);
      ang += k == 0 ? floor(hk * 2.0) * (PI / 4.0) : 0.0;
    }
    vec2 qt = rot(ang) * q / sk;
    float px = pc * sk, e = 0.8 / px, r = length(qt);
    // three parts
    float w0, w1;
    if (kind < 0.42) {                                                  // rings
      float r1 = 0.15 + 0.06 * hk, r2 = 0.31 + 0.06 * hc;
      w0 = 1.0 - smoothstep(r1 - e, r1 + e, r); w1 = (1.0 - w0) * (1.0 - smoothstep(r2 - e, r2 + e, r));
    } else {                                                            // petals + eye
      float n = 2.0 + floor(hc * 3.0);
      float sw = sin(n * atan(qt.y, qt.x) + hk * 6.283);
      w0 = 1.0 - smoothstep(0.11 - e, 0.11 + e, r); w1 = (1.0 - w0) * smoothstep(-n * e / max(r, 0.05), n * e / max(r, 0.05), sw);
    }
    float w2 = 1.0 - w0 - w1;
    // per ink, the three thresholds in a per-cell order; the top one sometimes sits above full density (a part stays open in the darks)
    float ho = h21(hcell * 4.1 + float(k) * 7.7 + step_ * 0.31);
    if (Dm < 0.24) ho = h21(hcell * 4.1 + step_ * 0.31);                 // pale cells: the plates share parts and overprint to khaki
    int perm = int(ho * 5.999);
    // magenta and yellow come in early, cyan late: skin has no cyan part, mid greys are red-led, only darks go navy
    vec3 th = k == 0 ? vec3(0.24, 0.47, 0.70) : k == 1 ? vec3(0.08, 0.30, 0.60) : vec3(0.06, 0.32, 0.64);
    if (Dm < 0.24) th.x = 0.05;
    th.z += 0.27 * h21(hcell * 5.3 + float(k) * 2.9);
    vec3 tz = perm == 0 ? th.xyz : perm == 1 ? th.xzy : perm == 2 ? th.yxz : perm == 3 ? th.yzx : perm == 4 ? th.zxy : th.zyx;
    if (kind > 0.74) tz = vec3(th.x + 0.06 * float(k == 0));            // tool-per-plate cells: the whole tool prints once the ink is there (cyan a little later)
    vec3 on = smoothstep(tz - 0.012, tz + 0.012, vec3(d));
    float part = w0 * on.x + w1 * on.y + w2 * on.z;
    vec2 mk = inkMark(gi, qt, px * 0.72);                              // drawn a little under its size: the reel's marks are soft at the edge
    float dens = mix(0.50, 0.985, smoothstep(0.05, 0.40, d)) * (0.88 + 0.12 * h21(hcell * 3.7 + float(k) * 9.1))
               * (1.0 - u_misreg * (0.16 * mott + 0.5 * pin));
    float cov = (mk.x + (1.0 - mk.x) * mk.y * 0.20) * dens * part;
    col *= mix(vec3(1.0), ink, cov);
  }
  return col;
}

// ---- Look 1: Lines. Widths are per cell (column x row); rows join through tapers. ----
float cap(float w, float x, float P){ return w <= 0.0 ? 0.0 : clamp((0.5 * w - abs(x)) * P + 0.5, 0.0, 1.0); }
vec3 lookLines(vec2 p, float S){
  float P = uRes.x / 124.0 * u_scale;
  vec3 col = paperTone(vec3(0.969, 0.961, 0.933), p, S);
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  float scroll = uKin * 0.8;                                           // kinetic: the row grid travels down the lines
  vec2 g = (p - 0.5 * uRes) / P; g.y += scroll;
  float ci = floor(g.x); float x = g.x - ci - 0.5; float r0 = floor(g.y);
  float wO = 0.0, wC = 0.0, wB = 0.0;
  for (int j = -1; j <= 1; j++) {
    float rj = r0 + float(j);
    vec2 cpx = vec2(ci + 0.5, rj + 0.5 - scroll) * P + 0.5 * uRes;
    float D = 1.0 - luma(gradeAt(cellRGB(cpx, P), cpx / uRes, false));
    float u = abs(g.y - (rj + 0.5));
    float hj = h21(vec2(ci, rj) + 3.3);
    // orange: one thin weight, long pointed leads into the neighbouring rows
    wO = max(wO, step(0.36, D) * (0.26 + 0.05 * hj) * clamp((1.02 - u) / 0.72, 0.0, 1.0));
    // charcoal: three weights, short necks between rows (beads), a short point where it ends
    float wc = D < 0.55 ? 0.0 : D < 0.63 ? 0.33 : D < 0.71 ? 0.46 : D < 0.76 ? 0.58 : 0.26 + 0.2 * hj;
    float sc = u < 0.38 ? 1.0 : u < 0.5 ? mix(1.0, 0.62, (u - 0.38) / 0.12) : clamp(0.62 * (1.0 - (u - 0.5) / 0.28), 0.0, 1.0);
    wC = max(wC, wc * sc);
    // blue: the darkest step, a blunt block per cell with a paper gap between columns
    wB = max(wB, step(0.76, D) * 0.8 * step(u, 0.5));
  }
  float m = u_misreg * 0.09;
  float rag = (bn.r - 0.5) * 0.7 / P;                                  // ragged edge, < 1 px
  float grain = 0.70 + 0.3 * smoothstep(0.2, 0.75, bn.g * 0.65 + vnoise(p / S * 0.5) * 0.35);
  col *= mix(vec3(1.0), vec3(0.70, 0.67, 0.64), cap(1.15 * uRes.x / 1704.0 / P * max(1.0, sqrt(u_scale)), x, P) * 0.9);   // hairline
  col *= mix(vec3(1.0), vec3(0.73, 0.40, 0.27), cap(wO + rag, x - m * 0.6, P) * 0.92);                                    // #B96645
  col *= mix(vec3(1.0), vec3(0.29, 0.53, 0.72), cap(wB + rag, x + m, P) * grain);                                         // #4A87B8
  col *= mix(vec3(1.0), vec3(0.27, 0.29, 0.26), cap(wC + rag, x - m * 0.3, P) * (0.80 + 0.2 * grain));                   // #42473F
  return col;
}

// ---- Look 2: Glyphs. One black glyph per cell from a density-ordered ramp. ----
vec3 lookGlyphs(vec2 p, float S){
  float P = max(uRes.x / 156.0, 6.5) * u_scale;                        // reel pitch (156 cells); under 10 px the analytic small-cell ramp takes over
  vec3 col = paperTone(vec3(0.988, 0.988, 0.988), p, S);
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  vec2 g = (p - 0.5 * uRes) / P; vec2 cell = floor(g); vec2 q = g - cell - 0.5;
  vec2 cp = (cell + 0.5) * P + 0.5 * uRes;
  float D = 1.0 - luma(gradeAt(cellRGB(cp, P), cp / uRes, true));
  D += 0.15 * (1.0 - smoothstep(0.08, 0.42, D)) * matteAt(cp);                              // the person keeps mid glyphs where a bright face would go to specks (the reel's face is mid-density)
  float h = h21(cell + 9.7);
  float f = smoothstep(0.10, 0.88, D) * 13.4 + (h - 0.5) * mix(0.9, 3.6, smoothstep(0.5, 0.85, D));
  int gi = 16 + int(clamp(floor(f + 0.5), 0.0, 15.0));
  float turn = floor(uKin * 1.5 + h * 4.0) * (PI * 0.5);              // kinetic: quarter-turn ticks, hourglass <-> bowtie
  vec2 qg = uKin > 0.0 ? rot(turn) * q : q;
  float sm = 1.0 - smoothstep(9.5, 11.5, P);
  float cov = sm >= 1.0 ? rampSmall(gi - 16, qg, P) : mix(glyph(gi, qg, P), rampSmall(gi - 16, qg, P), sm);
  float m = u_misreg;
  cov *= 1.0 - m * 0.22 * smoothstep(0.45, 0.9, bn.g * 0.5 + vnoise(p / S * 0.4) * 0.5);   // dry patches in the film
  return mix(col, vec3(0.063, 0.055, 0.067), cov);                     // #100E11
}

void main(){
  vec2 p = vUv * uRes;
  int look = -1;
  for (int i = 2; i >= 0; i--) {
    vec4 r = uRect[i];
    if (r.z > 0.25 && abs(p.x - r.x) < r.z && abs(p.y - r.y) < r.w) { look = int(uRectLook[i] + 0.5); break; }
  }
  if (look < 0) { fragColor = vec4(texture(uCam, vUv).rgb, 1.0); return; }
  float S = uRes.x / 1080.0;
  float mean = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    mean += luma(texture(uBuf_stat, (vec2(float(i), float(j)) + 0.5) / 4.0).rgb);
  mean /= 16.0;
  vec4 meta = texture(uBuf_meta, vec2(0.5));
  gPk = max(meta.b, 0.08); gFine = meta.g * u_fine;
  // lift a dim room into the scale; never push a bright room down much (the reel is high-key)
  gGamma = clamp(log(0.52) / log(clamp(mean, 0.05, 0.9)), 0.5, 1.12);
  gGammaF = clamp(log(0.52) / log(clamp(mean / (gPk * 0.985), 0.05, 0.9)), 0.6, 1.12);
  vec3 col = look == 0 ? lookIcons(p, S) : look == 1 ? lookLines(p, S) : lookGlyphs(p, S);
  fragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ atlas (drawn once)
function buildAtlas() {
  const T = TILE, cv = document.createElement('canvas'); cv.width = T * ACOLS; cv.height = T * AROWS;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  const TAU = Math.PI * 2;
  let ink = true;
  const col = () => { g.fillStyle = ink ? '#fff' : '#000'; g.strokeStyle = g.fillStyle; };
  const disc = (x, y, r) => { col(); g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); };
  const ring = (r, w) => { col(); g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); };
  const box = (x, y, hw, hh, rad = 0) => { col(); g.beginPath(); if (rad) g.roundRect(x - hw, y - hh, hw * 2, hh * 2, rad); else g.rect(x - hw, y - hh, hw * 2, hh * 2); g.fill(); };
  const poly = (pts) => { col(); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); };
  const line = (x0, y0, x1, y1, w) => { col(); g.lineWidth = w; g.lineCap = 'butt'; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  const around = (n, fn, a0 = 0) => { for (let i = 0; i < n; i++) { g.save(); g.rotate(a0 + i * TAU / n); fn(i); g.restore(); } };
  const hole = (r) => { ink = false; disc(0, 0, r); ink = true; };
  const cut = (fn) => { ink = false; fn(); ink = true; };

  const icons = [
    () => { disc(0, 0, .44); hole(.12); },                                                             // 0 washer
    () => { around(4, () => { col(); g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, .46, 0, TAU / 8); g.closePath(); g.fill(); }); hole(.07); },   // 1 pinwheel
    () => { disc(0, 0, .46); cut(() => disc(0, 0, .37)); disc(0, 0, .29); cut(() => disc(0, 0, .2)); disc(0, 0, .12); hole(.045); },           // 2 target
    () => { around(4, () => disc(.215, 0, .215)); hole(.08); },                                         // 3 quatrefoil
    () => { around(3, () => disc(.21, 0, .235), -TAU / 4); hole(.075); },                               // 4 trefoil
    () => { around(8, () => { col(); g.beginPath(); g.ellipse(.27, 0, .19, .085, 0, 0, TAU); g.fill(); }); disc(0, 0, .14); hole(.07); },      // 5 eight petals
    () => { around(12, () => poly([[.1, -.05], [.46, 0], [.1, .05]])); disc(0, 0, .17); hole(.07); },   // 6 starburst
    () => { const pts = []; for (let i = 0; i < 16; i++) { const r = i % 2 ? .27 : .46, a = i * TAU / 16; pts.push([Math.cos(a) * r, Math.sin(a) * r]); } poly(pts); hole(.1); },   // 7 eight-point star
    () => { box(0, 0, .33, .33); cut(() => box(0, 0, .215, .215)); box(0, 0, .1, .1); },                // 8 frame + core
    () => { box(0, 0, .33, .33, .1); hole(.13); },                                                      // 9 plate with hole
    () => { box(0, 0, .44, .14); box(0, 0, .14, .44); hole(.07); },                                     // 10 cross
    () => { around(4, () => box(.185, .185, .14, .14)); },                                              // 11 four squares
    () => { g.save(); g.beginPath(); g.arc(0, 0, .45, 0, TAU); g.clip(); g.rotate(TAU / 8); for (let i = -3; i <= 3; i++) box(0, i * .2, .5, .055); g.restore(); },   // 12 striped disc
    () => { disc(0, 0, .44); cut(() => box(0, 0, .06, .5)); cut(() => { disc(-.24, 0, .06); disc(.24, 0, .06); }); },      // 13 two half moons
    () => { disc(0, 0, .33); around(8, () => disc(.33, 0, .125)); hole(.11); },                         // 14 scalloped disc
    () => { around(8, () => disc(.35, 0, .095)); disc(0, 0, .12); },                                    // 15 ring of dots
  ];
  const ramp = [
    () => disc(0, 0, .078),                                                                             // 0 speck
    () => disc(0, 0, .14),                                                                              // 1 dot
    () => { disc(-.17, 0, .095); disc(.17, 0, .095); },                                                 // 2 two dots
    () => ring(.19, .085),                                                                              // 3 small ring
    () => box(0, 0, .17, .17),                                                                          // 4 small square
    () => { poly([[-.2, -.34], [.2, -.34], [0, 0]]); poly([[-.2, .34], [.2, .34], [0, 0]]); box(0, 0, .035, .1); },   // 5 hourglass
    () => ring(.28, .12),                                                                               // 6 thick ring
    () => { ring(.32, .1); disc(0, 0, .11); },                                                          // 7 target
    () => { poly([[-.4, -.27], [-.4, .27], [0, 0]]); poly([[.4, -.27], [.4, .27], [0, 0]]); box(0, 0, .1, .04); },    // 8 bowtie
    () => { ring(.38, .085); line(-.38, 0, .38, 0, .075); line(0, -.38, 0, .38, .075); },               // 9 crossed circle
    () => { disc(0, 0, .44); cut(() => { line(-.5, 0, .5, 0, .1); line(0, -.5, 0, .5, .1); }); },   // 10 quartered disc
    () => { around(8, () => disc(.33, 0, .105)); disc(0, 0, .135); },                                   // 11 dotted flower
    () => { disc(0, 0, .46); cut(() => { line(-.33, -.33, .33, .33, .105); line(-.33, .33, .33, -.33, .105); }); },   // 12 disc, white X
    () => { disc(0, 0, .35); around(8, () => disc(.35, 0, .135)); },                                    // 13 scalloped solid
    () => { box(0, 0, .47, .47); hole(.215); },                                                           // 14 square, round hole
    () => { box(0, 0, .47, .47); cut(() => { line(-.36, -.36, .36, .36, .105); line(-.36, .36, .36, -.36, .105); }); hole(.13); },                                         // 15 square, white X + eye
  ];
  [...icons, ...ramp].forEach((fn, i) => {
    g.save();
    g.beginPath(); g.rect((i % ACOLS) * T, Math.floor(i / ACOLS) * T, T, T); g.clip();
    g.translate((i % ACOLS + 0.5) * T, (Math.floor(i / ACOLS) + 0.5) * T); g.scale(T, -T);       // unit tile, y up
    ink = true; fn(); g.restore();
  });
  return cv;
}

// Found archive card (beyond): ruled index card with typed entries and a stamp, printed under the inks.
function buildCard() {
  const W = 1536, H = 864, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.strokeStyle = 'rgba(70,110,160,0.55)'; g.lineWidth = 1.5;
  for (let y = 150; y < H - 30; y += 46) { g.beginPath(); g.moveTo(40, y + rnd()); g.lineTo(W - 40, y + rnd()); g.stroke(); }
  g.strokeStyle = 'rgba(190,60,50,0.6)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(40, 104); g.lineTo(W - 40, 104); g.moveTo(40, 110); g.lineTo(W - 40, 110); g.stroke();
  g.beginPath(); g.moveTo(250, 104); g.lineTo(250, H - 30); g.moveTo(1180, 104); g.lineTo(1180, H - 30); g.stroke();
  g.fillStyle = 'rgba(40,40,48,0.78)';
  g.font = '600 30px Helvetica, Arial, sans-serif';
  g.fillText('INVENTARIS', 46, 78); g.fillText('KAART No.', 1010, 78);
  g.font = '22px Helvetica, Arial, sans-serif';
  ['nr.', 'datum', 'titel', 'techniek', 'afm.', 'herkomst', 'plaats', 'opm.'].forEach((s, i) => g.fillText(s, 52, 186 + i * 92));
  g.font = '27px "Courier New", Courier, monospace'; g.fillStyle = 'rgba(30,30,40,0.7)';
  const rows = ['0417 / B', '12 . 3 . 58', 'zonder titel', 'boekdruk, monoprint', '20,5 x 12,8', 'drukkerij, restpartij', 'kast 14, lade 3', 'zie ook 0418'];
  rows.forEach((s, i) => { let x = 276; for (const ch of s) { g.fillText(ch, x + (rnd() - 0.5) * 1.6, 188 + i * 92 + (rnd() - 0.5) * 2.4); x += 17.5; } });
  g.fillText('1', 1210, 188); g.fillText('2', 1210, 280); g.fillText('x', 1300, 372);
  g.save(); g.translate(1320, 640); g.rotate(-0.12); g.strokeStyle = 'rgba(150,40,90,0.55)'; g.fillStyle = 'rgba(150,40,90,0.55)'; g.lineWidth = 4;
  g.strokeRect(-150, -46, 300, 92); g.font = '600 34px Helvetica, Arial, sans-serif'; g.fillText('VERVALLEN', -108, 12); g.restore();
  g.save(); g.fillStyle = 'rgba(40,40,48,0.5)'; g.beginPath(); g.arc(W / 2, H - 14, 9, 0, 6.2832); g.fill(); g.restore();
  return cv;
}

// ------------------------------------------------------------------ reveal (clap, windows, full)
// Measured on the reel (second pass, frame by frame):
//   0.65 s clap. 0.73 s a 16:9 window opens between the hands, width 0.47 x palm distance, centred on
//   the midpoint of the wrists. It keeps the widest size it reached when the hands drop out (ratchet).
//   Two smaller 16:9 windows (0.58x and 0.36x) hang off its left and right edges and trail it.
//   0.73-1.95 s the three windows trade looks (hard cuts every 1-2 frames) and jump sideways; then they settle.
//   2.6-3.0 s the hands meet again behind the window; 3.1 s they part and it goes full in ~0.27 s.
//   5.6 s, 8.9 s the look changes, new look wiping in from the left in ~0.35 s. 12.4-13.0 s hands close, it goes away.
// Ours: clap opens, clap again goes full on the release, each further clap changes the look (wipe),
// hands held together puts it away. Lost hands hold the last pose; nothing goes full on tracking loss.
// The opening shuffle is slowed to five decelerating look changes in one second (the reel's 15-30 Hz
// cuts read as flicker out of context), and the windows glide instead of jumping.
const WIN_W = 0.47, WIN_ASPECT = 16 / 9, FULL_AT = 0.84, HOLD_CLOSE = 0.7, WIPE_S = 0.35;
const SHUFFLE = [0.10, 0.24, 0.43, 0.68, 1.0];
const SIDE = [{ dx: 0.47, k: 0.36, tau: 0.18 }, { dx: -0.43, k: 0.58, tau: 0.11 }, { dx: 0, k: 1, tau: 0.05 }];   // layer 2 (main) on top
function palm(h, W, H) {
  const ids = [0, 5, 9, 13, 17]; let x = 0, y = 0;
  for (const i of ids) { x += h.lm[i].x * W; y += h.lm[i].y * H; }
  const size = Math.hypot((h.lm[9].x - h.lm[0].x) * W, (h.lm[9].y - h.lm[0].y) * H);
  return { x: x / 5, y: y / 5, wx: h.lm[0].x * W, wy: h.lm[0].y * H, size };
}
export function reveal(ctx) {
  const st = ctx.state, P = ctx.params, [W, H] = ctx.res, t = ctx.time, dt = Math.min(0.1, Math.max(1 / 240, ctx.dt || 1 / 30));
  const mode = Math.round(P.reveal || 0), look = Math.round(P.look || 0);
  const FULL = [W / 2, H / 2, W / 2 + 1, H / 2 + 1], OFF = [0, 0, 0, 0];
  if (!st.rv || t < st.rv.t - 0.2 || st.rv.mode !== mode) {
    st.rv = { mode, t, state: mode === 0 ? 'full' : mode === 1 ? 'open' : 'closed', apart: true, nearT: -9, lastD: 9, lastTwo: -9, lastPalm: null,
      pose: null, wmax: 0, openT: mode === 1 ? -9 : t, pendingFull: false, lay: [null, null, null], look, cur: look, shown: look, from: look, wipe: 1, full: mode === 0 ? 1 : 0 };
  }
  const R = st.rv; R.t = t;
  const hands = ctx.hands || [];
  let two = null;
  if (hands.length >= 2) {
    const a = palm(hands[0], W, H), b = palm(hands[1], W, H);
    two = { cx: (a.wx + b.wx) / 2, cy: (a.wy + b.wy) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), size: (a.size + b.size) / 2 };
  }

  // contact: palms meet (or one hand vanishes into the other while they were closing); release: seen apart again
  let clap = false, parted = false;
  if (two) {
    if (two.d > 3.2 * two.size) R.wideT = t;                                     // hands well apart: a clap starts from here
    if (two.d < 1.0 * two.size && R.apart) { clap = true; R.apart = false; R.nearT = t; R.swing = t - (R.wideT ?? -9) < 0.6; }
    else if (two.d > 1.8 * two.size && !R.apart) { R.apart = true; parted = true; }
    R.lastD = two.d; R.lastTwo = t; R.lastPalm = two;
  } else if (R.apart && R.lastPalm && t - R.lastTwo < 0.3 && t - R.lastTwo > 0 && R.lastD < 2.2 * R.lastPalm.size) {
    clap = true; R.apart = false; R.nearT = t; R.swing = t - (R.wideT ?? -9) < 0.6;
  }
  const quick = t - R.nearT < HOLD_CLOSE;                                        // a clap, not a hold
  const held = !R.apart && hands.length >= 1 && !quick;                         // together and kept together

  if (look !== R.look) { R.look = look; R.cur = look; }                          // the Look control always wins
  // Third pass: a look change is a CLAP, not a touch. The hands must have been well apart (over 3.2 palm lengths)
  // within 0.6 s before contact, be together for under 0.45 s, and it cannot repeat within 0.9 s. Fingertips
  // meeting, hands resting together, one hand crossing the other: none of these change the look.
  const snap = t - R.nearT < 0.45;
  const cycle = () => { if (R.swing && snap && t - (R.cycT ?? -9) > 0.9) { R.cur = (R.cur + 1) % 3; R.cycT = t; } R.swing = false; };
  if (mode === 0) { if (parted) cycle(); }
  else if (mode === 2) {
    if (R.state === 'closed') { if (clap) { R.state = 'open'; R.openT = t; R.wmax = 0; R.pose = null; R.lay = [null, null, null]; R.pendingFull = false; R.full = 0; } }
    else if (R.state === 'open') {
      if (clap && t - R.openT > 0.25) R.pendingFull = true;
      if (held) { R.state = 'closed'; R.pendingFull = false; }
      else if (parted && R.pendingFull) { R.state = 'full'; R.pendingFull = false; }
    } else if (R.state === 'full') {
      if (held) R.state = 'closed';
      else if (parted && quick && R.full > 0.9) cycle();
    }
  } else if (two) R.state = two.d > FULL_AT * W ? 'full' : 'open';

  if (R.cur !== R.shown) { R.from = R.shown; R.shown = R.cur; R.wipe = 0; }
  R.wipe = Math.min(1, R.wipe + dt / WIPE_S);
  R.full += ((R.state === 'full' ? 1 : 0) - R.full) * (1 - Math.exp(-dt / 0.07));

  // pose: wrist midpoint and window width; held through tracking loss, ratcheted in Clap mode
  if (two && R.state !== 'closed') {
    const w = WIN_W * two.d;
    R.wmax = mode === 2 ? Math.max(R.wmax, w) : w;
    R.pose = { cx: two.cx, cy: two.cy, w: R.wmax };
  }
  const closing = R.state === 'closed';
  if (closing && R.lastPalm && R.pose) R.pose = { cx: R.lastPalm.cx, cy: R.lastPalm.cy, w: 0 };

  if (R.state === 'full' && R.full > 0.97) {                                     // settled full frame; look changes wipe in from the left
    R.lay = [FULL.slice(), FULL.slice(), FULL.slice()];
    if (R.wipe < 1) { const w = (1 - Math.pow(1 - R.wipe, 3)) * W; return { rects: [FULL, OFF, [w / 2, H / 2, w / 2, H / 2 + 1]], looks: [R.from, R.from, R.cur] }; }
    return { rects: [FULL, OFF, OFF], looks: [R.cur, R.cur, R.cur] };
  }
  if (!R.pose) return { rects: [OFF, OFF, OFF], looks: [R.cur, R.cur, R.cur] };

  // opening shuffle: five look changes, slowing down, ending on the current look in the main window
  let n = 0; for (const s of SHUFFLE) if (t - R.openT >= s) n++;
  const mainLook = (R.cur + (SHUFFLE.length - n)) % 3;
  const rects = [], looks = [];
  let alive = false;
  for (let i = 0; i < 3; i++) {
    const sd = SIDE[i], w = R.pose.w * sd.k;
    const target = R.state === 'full' ? FULL : [R.pose.cx + sd.dx * R.pose.w, R.pose.cy, w / 2, w / 2 / WIN_ASPECT];
    if (!R.lay[i]) R.lay[i] = [R.pose.cx, R.pose.cy, 0, 0];
    const tau = R.state === 'full' ? [0.085, 0.07, 0.055][i] : closing ? 0.07 : sd.tau;
    const a = 1 - Math.exp(-dt / tau);
    for (let c = 0; c < 4; c++) R.lay[i][c] += (target[c] - R.lay[i][c]) * a;
    if (R.lay[i][2] > 0.6) alive = true;
    rects.push(R.lay[i].slice());
    looks.push((mainLook + (2 - i)) % 3);
  }
  if (closing && !alive) { R.pose = null; R.lay = [null, null, null]; }
  return { rects, looks };
}

export default {
  id: 'martens',
  name: 'Martens',
  ref: { clip: 'DfhuYHNOybv', t: [4.5, 5.2], crop: [0, 36, 1704, 958] },
  needs: ['hands', 'person'],
  params: [
    { id: 'look', label: 'Look', type: 'enum', options: ['Icons', 'Lines', 'Glyphs'], default: 0 },
    { id: 'scale', label: 'Scale', type: 'float', min: 0.5, max: 3, default: 1 },
    { id: 'misreg', label: 'Misregister', type: 'float', min: 0, max: 1, default: 0.35 },
    { id: 'kinetic', label: 'Kinetic', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'fine', label: 'Subject detail', type: 'bool', default: false },
    { id: 'reveal', label: 'Reveal', type: 'enum', options: ['Full', 'Hands frame', 'Clap'], default: 0 },
    { id: 'card', label: 'Found card', type: 'float', min: 0, max: 1, default: 0, more: true },
    { id: 'contrast', label: 'Contrast', type: 'float', min: 0.6, max: 2, default: 1.15, more: true },
  ],
  passes: [
    { name: 'stat', frag: STAT, scale: 0.03, feedback: true },
    { name: 'peak', frag: PEAK, scale: 0.03 },
    { name: 'meta', frag: META, size: [2, 2], feedback: true, filter: 'nearest' },
    { name: 'tone', frag: TONE, scale: 0.25, feedback: true },
    { name: 'hold', frag: HOLD, scale: 0.25, feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
  init(ctx) {
    ctx.state.atlas = ctx.makeTexture(buildAtlas(), { filter: 'linear', wrap: 'clamp', mipmap: true });
    ctx.state.cardTex = ctx.makeTexture(buildCard(), { filter: 'linear', wrap: 'clamp', mipmap: true });
  },
  frame(ctx) {
    const st = ctx.state, dt = Math.min(0.1, ctx.dt || 1 / 30), kin = ctx.params.kinetic || 0;
    if (st.kinT === undefined || ctx.time < st.kinT - 0.2) st.kin = ctx.time * kin;
    else st.kin += dt * kin;
    st.kinT = ctx.time;
    const r = reveal(ctx);
    return { uAtlas: st.atlas, uCard: st.cardTex, uKin: st.kin, uRect: new Float32Array(r.rects.flat()), uRectLook: new Float32Array(r.looks) };
  },
};
