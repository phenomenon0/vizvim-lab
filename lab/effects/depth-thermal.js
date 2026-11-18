// depth-thermal — the thermal look from DecGDxGue_s (5.2–7.0 s).
// Measured: the reference is NOT depth-driven. Palette index vs. the same pose's luminance:
// r = -0.97 (teal frame 297 vs thermal 313), r = -0.96 vs the clean camera on static background;
// vs. the depth frame r = 0.26. It is: camera luma -> gaussian blur (~5-8 px at 1080) -> inverted
// lookup through a black-navy-blue-cyan-green-yellow-red ramp. The blur before the lookup is what
// draws the rainbow contour "halo" round every edge. `Depth` mixes our depth in as the driver.

// Ramp sampled from frames 313/330/360/400 (median colour per index bin), cold/bright -> hot/dark.
export const RAMP_HEX = ['000008', '000027', '010042', '03016b', '05079c', '050bbe', '060de0', '071bf3',
  '0938f5', '0b63f6', '0e89f7', '11b4f8', '14dbf9', '14e6e7', '14efbb', '14ff69', '1bff27', '66ff15',
  'bbff13', 'effb0f', 'f7d70c', 'f5af0a', 'f38a0a', 'ef5c08', 'ed3907', 'eb1c06', 'e90007'];
const v3 = (h) => `vec3(${[0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)).join(',')})`;

// index u in 0..1 (0 = black/navy end, 1 = red end)
export const RAMP_GLSL = /* glsl */ `
const vec3 TH_RAMP[27] = vec3[27](${RAMP_HEX.map(v3).join(',')});
vec3 thRamp(float u){
  float x = clamp(u, 0.0, 1.0) * 26.0; int i = int(min(floor(x), 25.0));
  return mix(TH_RAMP[i], TH_RAMP[i + 1], x - float(i));
}
// measured tone curve: blurred camera luma -> ramp index. Note the fold below luma 0.1: the
// very darkest pixels come back from red toward orange in the reference.
const vec2 TH_TONE[14] = vec2[14](vec2(0.0,0.865), vec2(0.05,0.904), vec2(0.10,1.0), vec2(0.20,0.895),
  vec2(0.33,0.735), vec2(0.40,0.640), vec2(0.50,0.529), vec2(0.55,0.442), vec2(0.60,0.337),
  vec2(0.65,0.231), vec2(0.70,0.180), vec2(0.80,0.110), vec2(0.90,0.050), vec2(1.0,0.0));
float thTone(float l){
  l = clamp(l, 0.0, 1.0); float r = TH_TONE[0].y;
  for (int i = 0; i < 13; i++) {
    if (l >= TH_TONE[i].x) r = mix(TH_TONE[i].y, TH_TONE[i+1].y, clamp((l - TH_TONE[i].x) / (TH_TONE[i+1].x - TH_TONE[i].x), 0.0, 1.0));
  }
  return r;
}`;

// ---- Palette "Prism": the thermal face of DX68QiKuX5Z (wxll.hx). Same recipe (blurred luma -> inverted lookup),
// different instrument: a short navy-blue-green-yellow-orange ramp with no black and no cyan band, a much
// steeper tone curve (measured on the reel's static background against its own clean frame: everything
// brighter than luma ~0.40 is blue, the whole green-yellow-orange run happens between 0.38 and 0.27, small
// red-orange cores at 0.20-0.25, folding back to orange and then yellow-green below), and the result is multiplied by a shade term
// from the sharp luma so true blacks (the shirt) read dark olive / brown instead of glowing.
export const PRISM_HEX = ['001167', '0017be', '0b3c3c', '10cf0a', 'b3cd04', 'ffc50c', 'fe8f02', 'e64a00'];
export const PRISM_GLSL = /* glsl */ `
const vec3 THP_RAMP[8] = vec3[8](${PRISM_HEX.map(v3).join(',')});
const float THP_X[8] = float[8](0.0, 0.16, 0.27, 0.40, 0.55, 0.68, 0.85, 1.0);
vec3 thpRamp(float u){
  u = clamp(u, 0.0, 1.0); vec3 c = THP_RAMP[0];
  for (int i = 0; i < 7; i++) c = mix(c, THP_RAMP[i + 1], clamp((u - THP_X[i]) / (THP_X[i + 1] - THP_X[i]), 0.0, 1.0));
  return c;
}
const vec2 THP_TONE[14] = vec2[14](vec2(0.0,0.62), vec2(0.06,0.66), vec2(0.11,0.85), vec2(0.22,1.0), vec2(0.27,0.85),
  vec2(0.30,0.68), vec2(0.33,0.55), vec2(0.35,0.44), vec2(0.385,0.37), vec2(0.415,0.22), vec2(0.50,0.16),
  vec2(0.70,0.11), vec2(0.78,0.04), vec2(1.0,0.0));
float thpTone(float l){
  l = clamp(l, 0.0, 1.0); float r = THP_TONE[0].y;
  for (int i = 0; i < 13; i++) {
    if (l >= THP_TONE[i].x) r = mix(THP_TONE[i].y, THP_TONE[i+1].y, clamp((l - THP_TONE[i].x) / (THP_TONE[i+1].x - THP_TONE[i].x), 0.0, 1.0));
  }
  return r;
}
// l = sharp camera luma, b = blurred luma
float thpShade(float l, float b){ return mix(0.42, 1.0, smoothstep(0.05, 0.16, mix(l, b, 0.4))); }
// the whole look from a blurred luma and the sharp luma (for hosts like prism)
vec3 thPrism(float b, float l){ return thpRamp(thpTone(b)) * thpShade(l, b); }`;

const COMMON = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// R = luma (box), G = depth joint-bilateral upsampled against the camera (edges on silhouettes)
const DRV = COMMON + /* glsl */ `
void main(){
  vec2 px = 1.0 / uCamRes;
  vec3 c0 = 0.25 * (texture(uCam, vUv + px*vec2(-0.5,-0.5)).rgb + texture(uCam, vUv + px*vec2(0.5,-0.5)).rgb
                  + texture(uCam, vUv + px*vec2(-0.5, 0.5)).rgb + texture(uCam, vUv + px*vec2(0.5, 0.5)).rgb);
  float d = 0.0;
  if (uDepthReady > 0.5 && u_depth > 0.0) {
    vec2 dt = 1.0 / vec2(textureSize(uDepth, 0));
    float acc = 0.0, ws = 0.0;
    for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
      vec2 o = vec2(float(i), float(j)) * dt;
      vec3 dc = texture(uCam, vUv + o).rgb - c0;
      float w = exp(-dot(dc, dc) / 0.012) * exp(-float(i*i + j*j) / 4.5) + 1e-4;
      acc += texture(uDepth, vUv + o).r * w; ws += w;
    }
    d = acc / ws;
  }
  fragColor = vec4(lum(c0), d, 0.0, 1.0);
}`;

export const thBlur = (src, dir, soften = 'u_soften') => COMMON + /* glsl */ `
void main(){
  // u_soften = gaussian sigma in px at 1080 wide
  float sig = max(${soften}, 0.01) * uRes.x / 1080.0;
  vec2 stepv = ${dir} / uRes * max(sig / 3.0, 0.5);
  vec2 acc = vec2(0.0); float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i) * max(sig / 3.0, 0.5);
    float w = exp(-x * x / (2.0 * sig * sig));
    acc += texture(${src}, vUv + stepv * float(i)).rg * w; ws += w;
  }
  fragColor = vec4(acc / ws, 0.0, 1.0);
}`;

// Camera exposure hold. exg (12 x 8): R = blurred luma at the tap now, G = the same followed over ~0.4 s.
// ex (1x1): G = the gain that most taps agree on (G / R, two rounds of a mean weighted toward the consensus), so a
// hand crossing the frame moves a few taps and is outvoted, while auto-exposure hunting and mains flicker move all
// of them together and are cancelled (within +-12 %). A real lighting change comes through over the follow time.
const EXPO_G = /* glsl */ `
void main(){
  float m = texture(uBuf_bv, vUv).r;
  vec4 pv = texture(uSelf, vUv);
  float slow = (uFrame > 1 && pv.a > 0.5 && pv.g > 0.0) ? mix(pv.g, m, 1.0 - exp(-max(uDt, 0.001) / 0.4)) : m;
  fragColor = vec4(m, slow, 0.0, 1.0);
}`;
const EXPO = /* glsl */ `
float exMean(float c, float w){
  float a = 0.0, ws = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 12; i++) {
    vec2 t = texture(uBuf_exg, (vec2(float(i), float(j)) + 0.5) / vec2(12.0, 8.0)).rg;
    float r = t.g / max(t.r, 0.02), k = (r - c) / w, q = exp(-k * k) * step(0.04, t.r);
    a += r * q; ws += q;
  }
  return ws > 0.0 ? a / ws : 1.0;
}
void main(){
  float g = exMean(1.0, 0.12); g = exMean(g, 0.03); g = exMean(g, 0.015);
  fragColor = vec4(1.0, g, 0.0, 1.0);
}`;

// index + heat lag (beyond). Stored: R = displayed index, G = instantaneous index.
const HEAT = COMMON + RAMP_GLSL + PRISM_GLSL + /* glsl */ `
void main(){
  vec2 b = texture(uBuf_bv, vUv).rg;
  vec2 ex = texture(uBuf_ex, vec2(0.5)).rg;
  b.r *= clamp(ex.g / max(ex.r, 0.01), 0.88, 1.12);
  float pl = u_palette > 0.5 ? thpTone(b.r) : thTone(b.r);
  float pd = mix(1.0, 0.06, pow(clamp(b.g, 0.0, 1.0), 0.85));   // far = red, near = navy
  float k = (uDepthReady > 0.5) ? u_depth : 0.0;
  // depth as driver, luma kept as fine detail riding on it
  float p = mix(pl, clamp(pd + (pl - 0.55) * 0.35 * (1.0 - k), 0.0, 1.0), k);
  p = clamp((p - 0.5) * exp2(2.0 * u_span) + 0.5 + 0.5 * u_level, 0.0, 1.0);
  float prev = texture(uSelf, vUv).r;
  float shown = p;
  if (u_lag > 0.0 && uFrame > 1) {
    // a body that leaves the pixel does not vanish: its (cold-end) print relaxes back up the ramp
    float tau = u_lag * 1.6;
    float relax = 1.0 - exp(-max(uDt, 0.001) / tau);
    shown = (p < prev) ? mix(prev, p, 0.6) : mix(prev, p, relax);
  }
  fragColor = vec4(shown, p, 0.0, 1.0);
}`;

const OUT = COMMON + RAMP_GLSL + PRISM_GLSL + /* glsl */ `
void main(){
  float p = texture(uBuf_heat, vUv).r;
  vec3 col = thRamp(p);
  if (u_palette > 0.5) col = thpRamp(p) * thpShade(texture(uBuf_drv, vUv).r, texture(uBuf_bv, vUv).r);   // half-res box luma: the sharp camera's noise made the shade shimmer
  col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'depth-thermal',
  name: 'Depth Thermal',
  ref: { clip: 'DecGDxGue_s', t: [5.3, 6.95] },
  needs: ['depth'],
  params: [
    { id: 'depth', label: 'Depth', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'soften', label: 'Soften', type: 'float', min: 0, max: 14, default: 5.5 },
    { id: 'level', label: 'Level', type: 'float', min: -1, max: 1, default: 0 },
    { id: 'span', label: 'Span', type: 'float', min: -1, max: 1, default: 0 },
    { id: 'lag', label: 'Heat Lag', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'palette', label: 'Palette', type: 'enum', options: ['Spectrum', 'Prism'], default: 0 },
  ],
  passes: [
    { name: 'drv', frag: DRV, scale: 0.5 },
    { name: 'bh', frag: thBlur('uBuf_drv', 'vec2(1.0, 0.0)'), scale: 0.5 },
    { name: 'bv', frag: thBlur('uBuf_bh', 'vec2(0.0, 1.0)'), scale: 0.5 },
    { name: 'exg', frag: EXPO_G, size: [12, 8], feedback: true, filter: 'nearest' },
    { name: 'ex', frag: EXPO, size: [1, 1] },
    { name: 'heat', frag: HEAT, scale: 0.5, feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
};
