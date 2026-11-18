// risograph — 2-3 spot inks from the Riso ink set, one drum each. Default: the reel's three-plate tone
// separation (sunflower + blue overprinting to green, pale pink furthest out) on a stochastic grain-touch
// screen; also designed 2-ink role separations and 3-ink density-space NNLS, AM dots at per-drum angles.
// Every tone comes from a steady record (no sensor noise in the grain) under person-weighted Otsu levels
// (no fixed thresholds). Multiply overprint with wet trapping on warm uncoated paper, static
// misregistration per drum, uneven coverage / roller banding / dropouts. Knock-out drops the room.
// Breakdown: breakdowns/risograph.md

const COMMON = /* glsl */ `
const float PI = 3.14159265;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2 rot(float deg){ float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fdt(){ return uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0; }
float fbm(vec2 p){ return 0.5*vnoise(p) + 0.25*vnoise(p*2.03 + 7.1) + 0.125*vnoise(p*4.01 + 3.3) + 0.125*vnoise(p*8.07 + 1.7); }
`;

// The steady record (half res, feedback). rgb: EMA (tau 0.2 s) in still areas; a wide low-passed
// difference, which sensor noise cannot trip, releases it to the live frame at once (no trails).
// a: 0.25 + 0.75 * person matte, smoothed 0.1 s (released by the same motion test).
const TONE = COMMON + /* glsl */ `
void main(){
  vec2 t = 1.0 / vec2(textureSize(uCam, 0));
  vec2 h = 1.0 / uPassRes;
  vec3 c = texture(uCam, vUv).rgb;
  vec4 prev = texture(uSelf, vUv);
  float cw = 0.0, pw = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)) * 1.5;
    cw += luma(texture(uCam, vUv + o * 2.0 * t).rgb);
    pw += luma(texture(uSelf, vUv + o * h).rgb);
  }
  float d = abs(cw - pw) / 9.0;
  vec3 dc = abs(c - prev.rgb);
  float rel = max(smoothstep(0.022, 0.06, d), smoothstep(0.12, 0.22, max(dc.r, max(dc.g, dc.b))));
  float a = mix(1.0 - exp(-fdt() / 0.20), 1.0, rel);
  float m = uPersonReady > 0.5 ? texture(uPerson, vUv).r : 1.0;
  bool valid = prev.a > 0.2;
  float mS = valid ? mix((prev.a - 0.25) / 0.75, m, max(1.0 - exp(-fdt() / 0.10), rel)) : m;
  fragColor = vec4(valid ? mix(prev.rgb, c, a) : c, 0.25 + 0.75 * clamp(mS, 0.0, 1.0));
}`;

// Scene statistics (tiny, slow) from the steady record -> white balance + wide dodge/burn.
const STAT = COMMON + /* glsl */ `
void main(){
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    c += texture(uBuf_tone, vUv + (vec2(float(i), float(j)) - 1.5) * 0.008).rgb;
  c /= 16.0;
  vec4 prev = texture(uSelf, vUv);
  float a = prev.a < 0.5 ? 1.0 : 1.0 - exp(-fdt() / 0.5);
  fragColor = vec4(mix(prev.rgb, c, a), 1.0);
}`;

// Levels (1 x 1, feedback): Otsu split of the record's luma over 16 x 9 samples, the person weighted 1,
// the room 0.06 -> x dark-cluster mean (hair, clothes), y bright-cluster mean (skin). Eased (0.6 s) with
// a dead band so sensor noise cannot walk them.
const LV = COMMON + /* glsl */ `
void main(){
  float L[144]; float W[144]; float sw = 0.0;
  for (int i = 0; i < 144; i++) {
    vec2 q = (vec2(float(i % 16), float(i / 16)) + 0.5) / vec2(16.0, 9.0);
    vec4 s = texture(uBuf_tone, q);
    L[i] = luma(s.rgb);
    W[i] = mix(1.0, 0.06 + 0.94 * smoothstep(0.3, 0.6, (s.a - 0.25) / 0.75), step(0.5, uPersonReady)); sw += W[i];
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
  dl *= smoothstep(0.008, 0.03, abs(dl)) * (1.0 - exp(-fdt() / 0.6));
  fragColor = prev.a > 0.5 ? vec4(prev.xy + dl, 0.0, 1.0) : vec4(lo, hi, 0.0, 1.0);
}`;

const OUT = COMMON + /* glsl */ `
vec3 gWB; float gAdapt; vec4 gLv;
vec3 meanCol(){
  vec3 m = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    m += texture(uBuf_stat, (vec2(float(i), float(j)) + 0.5) / 4.0).rgb;
  return m / 16.0;
}
float matteAt(vec2 uv){ return uPersonReady > 0.5 ? smoothstep(0.3, 0.7, (texture(uBuf_tone, uv).a - 0.25) / 0.75) : 1.0; }
// auto levels: 0 = the subject's dark cluster, 1 = its bright cluster (unclamped above)
float lvX(float L){ return (L - gLv.x) / max(gLv.y - gLv.x, 0.12); }
// art-director's grade before separation: neutralise the room cast, set the scale from the levels
// (dark cluster -> 0.12, bright cluster -> 0.78, soft shoulder above), lift chroma
vec3 pregrade(vec3 c){
  c = clamp(c * gWB * gAdapt, 0.0, 1.0);
  float L = max(luma(c), 1e-3), x = lvX(L);
  float t = x > 1.0 ? 0.78 + 0.16 * (1.0 - exp(-(x - 1.0) * 2.2)) : 0.12 + 0.66 * x;
  return clamp(c * (clamp(t, 0.02, 1.0) / L), 0.0, 1.0);
}
vec3 grade(vec3 c){
  c = pregrade(c);
  float L = luma(c);
  c = mix(vec3(L), c, 1.45);
  c = (c - 0.5) * u_density + 0.60;
  c = c * 1.04;                                           // highlights clear to bare paper
  return clamp(c, 0.012, 1.0);
}

// non-negative least squares in optical density, 2 inks
vec2 nnls2(vec3 k1, vec3 k2, vec3 d){
  float a = dot(k1, k1), b = dot(k1, k2), c = dot(k2, k2), e = dot(k1, d), f = dot(k2, d);
  float det = max(a*c - b*b, 1e-5);
  vec2 x = vec2(c*e - b*f, a*f - b*e) / det;
  if (x.x < 0.0) x = vec2(0.0, f / c);
  else if (x.y < 0.0) x = vec2(e / a, 0.0);
  return max(x, 0.0);
}
vec3 nnls3(vec3 k1, vec3 k2, vec3 k3, vec3 d){
  vec3 x = inverse(mat3(k1, k2, k3)) * d;
  if (x.x < 0.0) { vec2 y = nnls2(k2, k3, d); x = vec3(0.0, y); }
  else if (x.y < 0.0) { vec2 y = nnls2(k1, k3, d); x = vec3(y.x, 0.0, y.y); }
  else if (x.z < 0.0) { vec2 y = nnls2(k1, k2, d); x = vec3(y, 0.0); }
  return x;
}

float spotTh(float a){ float b = min(a, 1.0 - a); float t = b*(1.5564 - b*(1.0928 + 0.0233*b)); return a <= 0.5 ? 1.0 - t : t; }
float dotCov(vec2 p, float pitch, float ang, float a, float rag){
  vec2 q = rot(ang) * p / pitch;
  vec2 s = sin(2.0*PI*q), c = cos(2.0*PI*q);
  float f = 0.5 + 0.25*(c.x + c.y);
  float g = 0.5*PI*length(s) / pitch;
  float e = f - spotTh(a);
  float d = e / sqrt(g*g + 0.5*PI*PI/(pitch*pitch)*abs(e) + 1e-9);
  float on = smoothstep(0.004, 0.03, a);
  return mix(clamp(d + 0.5 + (0.25 + rag) * on, 0.0, 1.0) * on, 1.0, smoothstep(0.97, 0.996, a));
}
// grain touch: the master is burnt as a random scatter of holes. Blue noise fixed to the sheet (never
// animated), magnified to ~1.35 px grains; a plate prints where its density beats the grain, with a short
// soft edge. One noise channel per drum, so overprints do not line up.
float grainCov(vec2 p, float a, float S, int ch){
  float gs = 1.35 * mix(0.75, 1.6, clamp(u_grain * 0.5, 0.0, 1.0));
  float n = texture(uNoise, (p + float(ch) * vec2(37.0, 91.0)) / (256.0 * gs * S))[ch];
  return smoothstep(n * 0.92, n * 0.92 + 0.08, a);
}

// ---- 2-ink separation by tone role (what a designer does by hand for a duotone portrait) -------
// key ink  : structure. High-key curve on luminance, so room walls go to a pale tint and only real
//            shadows get heavy ink; held back on skin so faces are not muddied.
// warm ink : skin and warm things. Modelled by luminance (light on the forehead, heavier in the
//            skin's own shadows), plus an overprint under the deepest key to give rich darks.
// Highlights get neither: bare paper.
vec2 roleSep(vec3 c){
  float L = luma(c);
  float t = 1.0 - L;
  float warm = c.r - 0.5 * (c.g + c.b);
  float ws = smoothstep(0.075, 0.21, warm);
  float dn = u_density / 1.4;
  float key = pow(t, 2.1) * 1.45 * dn;
  key = max(key, 0.07 * dn * smoothstep(0.02, 0.12, t));  // pale veil of key on everything but speculars
  key *= 1.0 - 0.38 * ws * smoothstep(0.85, 0.35, t);
  float wI = ws * (0.17 + 0.63 * smoothstep(0.14, 0.60, t)) * dn;
  wI += 0.62 * smoothstep(0.5, 0.92, t) * dn;              // overprint under the deep key: rich darks
  return clamp(vec2(key, wI), 0.0, 0.97);
}

void main(){
  float S = uRes.x / 1080.0;
  vec2 p = vUv * uRes;
  vec2 pp = p / S;
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);

  // ---- ink set (Riso catalogue colours) ----------------------------------------------------------
  int set = int(u_inks + 0.5);
  vec3 ink[3]; int N = 2; int flood = 1; float floodTint = 0.55;
  if (set == 0)      { ink[0] = vec3(0.090, 0.580, 0.725); ink[1] = vec3(0.960, 0.770, 0.020); ink[2] = vec3(0.953, 0.749, 0.855); N = 3; flood = 3; }               // reel: Blue 1794B9, Sunflower F5C405, Pink F3BFDA
  else if (set == 1) { ink[0] = vec3(0.463, 0.357, 0.655); ink[1] = vec3(1.0, 0.282, 0.690); flood = 1; floodTint = 0.34; }                                         // Purple 765BA7 + Fl. Pink
  else if (set == 2) { ink[0] = vec3(0.0, 0.471, 0.749);   ink[1] = vec3(1.0, 0.282, 0.690); flood = 0; floodTint = 0.42; }                                         // Blue + Fl. Pink
  else if (set == 3) { ink[0] = vec3(0.0, 0.471, 0.749);   ink[1] = vec3(1.0, 0.282, 0.690); ink[2] = vec3(1.0, 0.910, 0.0); N = 3; flood = 2; floodTint = 0.8; }  // Blue 0078BF, Fl. Pink FF48B0, Yellow FFE800
  else if (set == 4) { ink[0] = vec3(0.0, 0.514, 0.541);   ink[1] = vec3(1.0, 0.455, 0.467); ink[2] = vec3(1.0, 0.710, 0.067); N = 3; flood = 2; floodTint = 0.7; }  // Teal 00838A, Fl. Orange FF7477, Sunflower FFB511
  else               { ink[0] = vec3(0.239, 0.333, 0.533); ink[1] = vec3(0.945, 0.314, 0.376); flood = 1; floodTint = 0.3; }                                         // Federal Blue 3D5588 + Bright Red F15060
  bool reel = set == 0;
  if (N == 2) ink[2] = vec3(1.0);
  vec3 kI[3];
  for (int i = 0; i < 3; i++) kI[i] = -log(max(ink[i], vec3(0.045)));

  // ---- grade constants -----------------------------------------------------------------------------
  vec3 mc = max(meanCol(), vec3(0.03));
  gWB = clamp(mix(vec3(1.0), vec3(luma(mc)) / mc, 0.9), 0.6, 1.7);
  gLv = texture(uBuf_lv, vec2(0.5));

  gAdapt = pow(0.42 / clamp(luma(texture(uBuf_stat, vUv).rgb * gWB), 0.08, 0.9), 0.2);   // dodge & burn
  // ---- paper ---------------------------------------------------------------------------------------
  float fib = vnoise(pp * vec2(0.8, 0.18)) * 0.55 + vnoise(pp * vec2(0.2, 0.9) + 40.0) * 0.45;
  float tooth = vnoise(pp * 0.8) * 0.6 + bn.a * 0.4;
  vec3 col = vec3(0.957, 0.937, 0.890) * (1.0 + (fib - 0.5) * 0.04 + (bn.b - 0.5) * 0.02);    // #F4EFE3
  col *= 1.0 - 0.35 * smoothstep(0.93, 0.99, vnoise(pp * 0.33 + 17.0) * 0.5 + bn.g * 0.5) * vec3(0.5, 0.6, 0.8);  // flecks

  // ---- drums ---------------------------------------------------------------------------------------
  float prevCov = 0.0;
  int scr = int(u_screen + 0.5);
  for (int i = 0; i < 3; i++) {
    if (i >= N) break;
    float fi = float(i);
    // misregistration: drum 0 is the key; the others slip a few px, with a hair of skew, and
    // drift very slowly sheet to sheet
    vec2 dir = i == 1 ? vec2(0.82, -0.57) : vec2(-0.45, 0.89);
    vec2 off = i == 0 ? vec2(0.0) : dir * 3.9 * u_misreg * S;            // fixed per sheet: registration does not swim
    if (reel && i > 0) off = (i == 1 ? vec2(-8.0, 1.0) : vec2(5.5, -0.8)) * u_misreg * 2.5 * S;    // the reel prints its plates well apart: colour fringes on every edge
    float skew = i == 0 ? 0.0 : (i == 1 ? 0.0016 : -0.0012) * u_misreg;
    vec2 c0 = p - 0.5 * uRes;
    // the sheet also stretches a little as it goes through: low-frequency local warp per drum
    vec2 warp = i == 0 ? vec2(0.0) : (vec2(vnoise(pp * 0.0035 + fi * 11.0), vnoise(pp * 0.0035 + fi * 11.0 + 50.0)) - 0.5) * 6.0 * u_misreg * S;
    vec2 ps = p + off + warp + skew * vec2(-c0.y, c0.x);
    vec2 uv = ps / uRes;

    vec3 src = texture(uBuf_tone, uv).rgb;
    float a;
    if (reel) {
      // tone separation: each plate is its own ramp of the levelled tone (0 dark cluster .. 1 bright cluster)
      float t = lvX(luma(clamp(src * gAdapt, 0.0, 1.0))) - (u_density - 1.4) * 0.3;
      // each ink owns a band, so each is seen as itself: blue alone carries the darks and the key,
      // yellow the mid tones (walls, backdrop), pink the skin and the upper lights; neighbours overlap
      // only across a short shoulder (green and orange as accents), the top clears to bare paper
      vec3 wc = clamp(src * gWB, 0.0, 1.0);
      float ws = smoothstep(0.035, 0.13, wc.r - 0.5 * (wc.g + wc.b)) * smoothstep(0.22, 0.45, t);   // warm and lit: skin
      float bl = 1.0 - 0.9 * smoothstep(-0.02, 0.24, t) * 0.22 - 0.802 * smoothstep(0.20, 0.52, t);   // darks keep a grain of paper so cloth still models
      float ye = smoothstep(0.24, 0.44, t) * (1.0 - smoothstep(0.66, 0.98, t)) * (1.0 - 0.75 * ws);
      float pk = max(smoothstep(0.52, 0.72, t) * (1.0 - smoothstep(1.02, 1.30, t)) * 0.8, ws * (0.95 - 0.45 * smoothstep(0.6, 1.1, t)));
      a = i == 0 ? bl : i == 1 ? 0.92 * ye : pk;
    } else if (N == 2) {
      vec2 r2 = roleSep(pregrade(src));
      a = i == 0 ? r2.x : r2.y;
    } else {
      vec3 d = -log(grade(src));
      vec3 x = nnls3(kI[0], kI[1], kI[2], d);
      float aD = clamp(i == 0 ? x.x : i == 1 ? x.y : x.z, 0.0, 1.0);
      // density -> dot area (Murray-Davies on the ink's strongest absorption band)
      float km = max(kI[i].r, max(kI[i].g, kI[i].b));
      a = (1.0 - exp(-aD * km)) / (1.0 - exp(-km));
    }

    // beyond: knock-out. Behind the person the drum prints a flat flood (or nothing).
    if (u_backdrop > 0.001 && uPersonReady > 0.5) {
      float m = matteAt(uv);
      float bg = i == flood ? floodTint : 0.0;
      a = mix(a, mix(bg, a, m), u_backdrop);
    }

    float rag = (bn.r - 0.5) * 0.5;
    float cov;
    if (scr == 0) cov = grainCov(ps, a, S, i);
    else cov = dotCov(ps, (scr == 1 ? 4.2 : 8.5) * S, N == 2 ? (i == 0 ? 15.0 : 60.0) : (i == 0 ? 45.0 : i == 1 ? 75.0 : 15.0), a, rag);

    // ink film: soy ink is translucent and never lies flat. Blotchy coverage, roller banding
    // across the feed, pinhole dropouts on the paper's high points, less take-up on wet ink.
    float w = u_wear;
    float blot = fbm(pp * 0.0045 + fi * 13.0);
    float band = vnoise(vec2(fi * 5.0, pp.y * 0.021)) * 0.6 + vnoise(vec2(fi * 5.0 + 2.0, pp.y * 0.13)) * 0.4;
    float film = 0.94 - w * (0.30 * (blot - 0.35) + 0.12 * (band - 0.5));
    float pin = smoothstep(0.80 - 0.10 * w, 0.97, tooth * 0.75 + vnoise(pp * 1.9 + fi * 31.0) * 0.25 + (blot - 0.5) * 0.25 * w);
    film *= 1.0 - pin * (0.35 + 0.5 * w);
    film *= 1.0 - 0.14 * prevCov;
    col *= mix(vec3(1.0), ink[i], clamp(cov * film, 0.0, 1.0));
    prevCov = max(prevCov, cov);
  }
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'risograph',
  name: 'Risograph',
  ref: { clip: 'DcTpHw4Owmc', t: [3.3, 4.1] },
  needs: ['person'],
  params: [
    { id: 'inks', label: 'Inks', type: 'enum', default: 0, options: [
      'Blue #1794B9 · Sunflower #F5C405 · Pink #F3BFDA',
      'Purple #765BA7 · Fl. Pink #FF48B0',
      'Blue #0078BF · Fl. Pink #FF48B0',
      'Blue #0078BF · Fl. Pink #FF48B0 · Yellow #FFE800',
      'Teal #00838A · Fl. Orange #FF7477 · Sunflower #FFB511',
      'Federal Blue #3D5588 · Bright Red #F15060',
    ] },
    { id: 'screen', label: 'Screen', type: 'enum', options: ['Grain touch', 'Dots fine', 'Dots coarse'], default: 0 },
    { id: 'misreg', label: 'Misregistration', type: 'float', min: 0, max: 1, default: 0.4 },
    { id: 'wear', label: 'Ink wear', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'density', label: 'Density', type: 'float', min: 0.6, max: 2, default: 1.4 },
    { id: 'backdrop', label: 'Knock-out', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'grain', label: 'Grain size', type: 'float', min: 0, max: 2, default: 1, more: true },
  ],
  passes: [
    { name: 'tone', frag: TONE, scale: 0.5, feedback: true },
    { name: 'stat', frag: STAT, scale: 0.03, feedback: true },
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'out', frag: OUT, screen: true },
  ],
};
