// cyanotype — Prussian blue contact print on watercolour paper: Beer-Lambert pigment colour,
// exposure set by person-weighted Otsu levels from a steady record (any room prints the same key, sensor
// noise never reaches the paper), long-toe / blocked-shadow curve, hand-brushed coating border, paper tooth, depth softness,
// photogram (sun-print silhouette) as the beyond. Breakdown: breakdowns/cyanotype.md

const COMMON = /* glsl */ `
const float PI = 3.14159265;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ return 0.5*vnoise(p) + 0.25*vnoise(p*2.03 + 7.1) + 0.125*vnoise(p*4.01 + 3.3) + 0.125*vnoise(p*8.07 + 1.7); }
float fdt(){ return uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0; }
`;

// The steady record (full res, feedback). rgb: EMA (tau 0.2 s) in still areas; a wide low-passed
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

const blur = (src, dir) => COMMON + /* glsl */ `
void main(){
  vec2 t = ${dir} * 2.6 / vec2(textureSize(uCam, 0));
  vec3 c = texture(${src}, vUv).rgb * 0.227;
  c += (texture(${src}, vUv + t*1.385).rgb + texture(${src}, vUv - t*1.385).rgb) * 0.316;
  c += (texture(${src}, vUv + t*3.231).rgb + texture(${src}, vUv - t*3.231).rgb) * 0.0703;
  fragColor = vec4(c, 1.0);
}`;

const OUT = COMMON + /* glsl */ `
float meanLuma(){
  float m = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    m += luma(texture(uBuf_stat, (vec2(float(i), float(j)) + 0.5) / 4.0).rgb);
  return m / 16.0;
}
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main(){
  float S = uRes.x / 1080.0;
  vec2 p = vUv * uRes;
  vec2 pp = p / S;                                   // px at 1080 wide: all texture scales live here
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  float tex = u_texture;

  // ---- sheet geometry: paper > brushed coat > negative window --------------------------------
  float f = u_border * 0.075;                        // window inset as a fraction of each side
  vec2 uvI = (vUv - f) / (1.0 - 2.0*f);
  vec2 half_ = 0.5 * uRes / S;
  vec2 c0 = pp - half_;
  float m = f * 1080.0;                              // inset in ref px (horizontal)
  // brush: horizontal sweeps. Left/right ends are bristle fingers (fast in y), top/bottom are the
  // long wavy flank of a stroke (slow in x).
  float fenv = 0.35 + 1.3 * vnoise(vec2(pp.y * 0.011, 21.0));
  float fingers = ((vnoise(vec2(pp.y * 0.04, 3.0)) - 0.5) * 1.2 + (vnoise(vec2(pp.y * 0.17, 9.0)) - 0.5) * 0.6 + (vnoise(vec2(pp.y * 0.6, 4.0)) - 0.5) * 0.2) * fenv;
  float flank = (vnoise(vec2(pp.x * 0.006, 5.0)) - 0.5) * 0.9 + (vnoise(vec2(pp.x * 0.05, 1.0)) - 0.5) * 0.25;
  vec2 dEdge = half_ - abs(c0);
  float nearSide = smoothstep(-0.25*m, 0.25*m, dEdge.y - dEdge.x * (uRes.y / uRes.x));
  float disp = mix(flank, fingers, nearSide) * m * 0.42;
  float dCoat = sdBox(c0, half_ - m * 0.30) + disp;  // < 0 inside the coat
  float dry = smoothstep(-m * 0.55, 0.0, dCoat);     // dry-brush zone at the stroke ends
  float bristle = vnoise(vec2(pp.x * 0.012, pp.y * 0.42)) * 0.65 + vnoise(vec2(pp.x * 0.03, pp.y * 0.95)) * 0.35;
  float coat = (1.0 - smoothstep(-2.5, 1.0, dCoat)) * (1.0 - dry * smoothstep(0.38, 0.72, bristle + (bn.r - 0.5) * 0.2));
  coat = mix(1.0, coat, step(0.002, f));
  // window (the negative's edge): crisp but not digital
  float dWin = sdBox(c0, half_ - vec2(m, m * uRes.y / uRes.x)) + (vnoise(pp * 0.08) - 0.5) * 1.2;
  float win = mix(1.0, 1.0 - smoothstep(-1.0, 0.8, dWin), step(0.002, f));

  // ---- the picture -----------------------------------------------------------------------------
  float depth = uDepthReady > 0.5 ? texture(uDepth, uvI).r : 1.0;
  vec3 sharp = texture(uBuf_tone, uvI).rgb;
  vec3 soft = texture(uBuf_blurV, uvI).rgb;
  // sensitiser sits in the fibres: never pin-sharp; things further from the "paper" print softer
  float softK = uDepthReady > 0.5 ? mix(0.10, 0.85, smoothstep(0.55, 0.05, depth)) : 0.25;
  float L = luma(mix(sharp, soft, softK));
  // auto exposure: the subject's dark cluster prints deep blue, its bright cluster nearly clears to paper
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float lx = (L - lv.x) / max(lv.y - lv.x, 0.12);
  L = lx > 1.0 ? 0.84 + 0.14 * (1.0 - exp(-(lx - 1.0) * 2.2)) : 0.19 + 0.65 * lx;
  L *= pow(0.42 / clamp(luma(texture(uBuf_stat, uvI).rgb), 0.08, 0.9), 0.14);   // dodge & burn (wide local mean)
  L = clamp(L, 0.0, 1.0);
  float x = 1.0 - L;                                 // exposure received through the negative
  x = (x - 0.5) * u_contrast + 0.5 + u_exposure * 0.28;

  // beyond: photogram. The body lies on the paper and blocks the sun: white silhouette, translucent
  // where it is bright, penumbra widening with distance from the sheet (depth).
  if (u_photogram > 0.001 && uPersonReady > 0.5) {
    float r = mix(2.0, 15.0, smoothstep(0.75, 0.15, depth)) * S;
    float mt = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = (float(i) + bn.g) * (2.0 * PI / 8.0);
      mt += texture(uPerson, uvI + vec2(cos(a), sin(a)) * r * (0.45 + 0.55 * fract(float(i) * 0.618)) / uRes).r;
    }
    mt = smoothstep(0.15, 0.85, mt / 8.0);
    float body = 0.04 + 0.34 * pow(clamp(1.0 - L, 0.0, 1.0), 1.4);
    x = mix(x, mix(1.02, body, mt), u_photogram);
  }
  x = clamp(x, 0.0, 1.0);
  x = mix(1.0, x, win);                              // outside the negative the coat gets full sun

  // characteristic curve: long delicate toe, shadows block up
  float D = 1.0 - pow(1.0 - pow(x, 1.5), 2.2);

  // ---- material ----------------------------------------------------------------------------------
  float tooth = vnoise(pp * 0.42) * 0.55 + vnoise(pp * 0.95 + 11.0) * 0.3 + bn.b * 0.15;   // cold-press bumps
  float toothL = vnoise((pp + vec2(1.3, -1.3)) * 0.42) * 0.55 + vnoise((pp + vec2(1.3, -1.3)) * 0.95 + 11.0) * 0.3 + bn.b * 0.15;
  float streak = vnoise(vec2(pp.x * 0.0035, pp.y * 0.075)) * 0.6 + vnoise(vec2(pp.x * 0.011, pp.y * 0.26)) * 0.4;  // brush lay
  float mottle = fbm(pp * 0.006 + 3.0);
  float thick = 1.0 + tex * ((streak - 0.5) * 0.16 + (mottle - 0.5) * 0.30);
  // pigment pools in the valleys of the tooth; strongest in the mid densities
  float pool = (0.5 - tooth) * tex * 0.7 * (0.35 + 1.3 * D * (1.0 - D) * 2.0);
  D = clamp(D * thick + pool * D, 0.0, 1.25) * coat;
  // unexposed fibre flecks and pinholes
  float fleck = smoothstep(0.9965, 0.9995, h21(floor(pp * 0.8) + 3.0)) * smoothstep(0.3, 0.7, vnoise(pp * 0.05 + 9.0)) * tex;
  D *= 1.0 - 0.75 * fleck;

  bool tea = u_toning > 0.5;
  vec3 k = tea ? vec3(2.45, 2.05, 1.55) : vec3(2.75, 1.62, 0.90);       // absorption per channel
  vec3 paper = tea ? vec3(0.905, 0.850, 0.735) : vec3(0.957, 0.947, 0.918);
  // faint sensitiser stain wherever the coat went, even in the whites
  paper *= mix(vec3(1.0), tea ? vec3(0.97, 0.955, 0.92) : vec3(0.975, 0.985, 0.975), coat * 0.8);
  float shade = 1.0 + tex * ((toothL - tooth) * 0.10 + (fbm(pp * vec2(0.02, 0.11)) - 0.5) * 0.03);
  vec3 col = paper * shade * exp(-k * D * 1.08);
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'cyanotype',
  name: 'Cyanotype',
  ref: { clip: 'DcTpHw4Owmc', t: [4.3, 5.0] },
  needs: ['depth', 'person'],
  params: [
    { id: 'exposure', label: 'Exposure', type: 'float', min: -1, max: 1, default: 0 },
    { id: 'contrast', label: 'Contrast', type: 'float', min: 0.6, max: 2.2, default: 1.25 },
    { id: 'toning', label: 'Toning', type: 'enum', options: ['Prussian #12325A', 'Tea-toned #2B2F38'], default: 0 },
    { id: 'border', label: 'Brushed border', type: 'float', min: 0, max: 1, default: 0.35 },
    { id: 'texture', label: 'Paper', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'photogram', label: 'Photogram', type: 'float', min: 0, max: 1, default: 0 },
  ],
  passes: [
    { name: 'tone', frag: TONE, feedback: true },
    { name: 'stat', frag: STAT, scale: 0.03, feedback: true },
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'blurH', frag: blur('uBuf_tone', 'vec2(1.0, 0.0)'), scale: 0.5 },
    { name: 'blurV', frag: blur('uBuf_blurH', 'vec2(0.0, 1.0)'), scale: 0.5 },
    { name: 'out', frag: OUT, screen: true },
  ],
};
