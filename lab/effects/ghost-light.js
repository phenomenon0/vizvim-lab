// ghost-light — okamirufu's "digital light glow" (qoNQsdgiGsk) and "liquid blur" (C_5hOu1yGGs) are ONE
// graph: mono -> streaky Gaussian -> BAND-PASS (small blur minus large blur, the "diffblur") -> hard level
// at a percentile -> light lingers -> small streaky Gaussian rim + wide halo, added back -> grain.
// Every radius is a fraction of the SUBJECT's head width (from the person matte), not of the frame.
// Melt is the only thing that separates the looks: 0 = sparkle, 0.3 = Glow, 0.6 = Liquid.
// Breakdown: breakdowns/ghost-light.md

const COMMON = /* glsl */ `
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// stat texel: R = level point, G = head width (fraction of frame width), B = person present, A = valid
vec4 stats(){ return texelFetch(uBuf_stat, ivec2(0), 0); }
// The unit every radius is measured in: head width in full-res px. The reference head is ~0.5 of the frame.
float unitPx(){ vec4 s = stats(); return uRes.x * (s.a > 0.5 ? s.g : 0.5); }
// small blur sigma (x along the streak, y across it), full-res px
vec2 fineSigma(){
  float m = u_melt, H = unitPx();
  float sy = H * mix(0.007, 0.050, m * m);
  float sx = sy * 1.3 + H * 0.16 * pow(1.0 - m, 1.5) * smoothstep(0.0, 0.2, m);   // the streak
  return vec2(sx, sy);
}
// pool scale of the band-pass, in head widths: small at Melt 0 (sparkle = many fine glints), ~1/7 head at Glow
float poolSigma(){ return mix(0.045, 0.135, smoothstep(0.0, 0.3, u_melt)); }
vec4 gauss(sampler2D t, vec2 dir, float sigmaFull){
  float s = max(sigmaFull * uPassRes.x / uRes.x, 0.5);        // sigma in this buffer's texels
  float stp = max(1.0, s / 3.4);
  vec2 d = dir * stp / uPassRes;
  // when the stride is wider than a texel, slide the whole kernel by a blue-noise fraction of a stride:
  // the terraces a sparse kernel leaves on hard edges become noise the next blur removes
  float jit = stp > 1.0 ? texelFetch(uNoise, ivec2(gl_FragCoord.xy) & 255, 0).r - 0.5 : 0.0;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -10; i <= 10; i++) {
    float o = float(i) + jit, x = o * stp / s, w = exp(-0.5 * x * x);
    acc += texture(t, vUv + d * o) * w; ws += w;
  }
  return acc / ws;
}
`;

// R = keyed luma, G = raw luma, B = key weight. The key is the person matte (the reference shoots a lit
// subject in a black studio; an ordinary room needs the room crushed first).
const MONO = COMMON + /* glsl */ `
void main(){
  float L = luma(texture(uCam, vUv).rgb);
  float k = 1.0;
  if (uPersonReady > 0.5 && u_key > 0.5) {
    vec4 st = stats();
    float has = st.a < 0.5 ? 1.0 : st.b;                      // nobody in frame -> fall back to the whole picture
    k = mix(1.0, smoothstep(0.35, 0.85, texture(uPerson, vUv).r), has);
  }
  fragColor = vec4(L * k, L, k, 1.0);
}`;

const PH = COMMON + `void main(){ fragColor = gauss(uBuf_mono, vec2(1.0, 0.0), fineSigma().x); }`;
const PV = COMMON + `void main(){ fragColor = gauss(uBuf_ph, vec2(0.0, 1.0), fineSigma().y); }`;
// the large blur of the band-pass: ~1/9 of a head, a little wider along the streak
const QH = COMMON + `void main(){ fragColor = gauss(uBuf_pv, vec2(1.0, 0.0), unitPx() * poolSigma()); }`;
const QV = COMMON + `void main(){ fragColor = gauss(uBuf_qh, vec2(0.0, 1.0), unitPx() * poolSigma() * 0.7); }`;

// 64x36 copy of the keyed picture for the statistics (B = matte coverage)
const LO = COMMON + /* glsl */ `
void main(){
  vec4 a = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    a += texture(uBuf_mono, vUv + (vec2(float(i), float(j)) - 1.5) / (uPassRes * 4.0));
  fragColor = a / 16.0;
}`;

// BAND-PASS. R = level input: what is brighter than its surroundings at pool scale, plus a little of the
// picture so a lit side still beats a dark side. On a keyed subject the silhouette is an edge against
// black, so the band-pass puts crescents along the head outline. G = fine picture, B = key.
const PRE = COMMON + /* glsl */ `
void main(){
  vec4 a = texture(uBuf_pv, vUv);
  vec4 q = texture(uBuf_qv, vUv);
  // third pass: the surround is mostly the SUBJECT's own local mean (blur of keyed luma / blur of key), so the
  // cut-out silhouette is no longer the strongest edge in the picture and the light lands inside the head
  float band = a.r - mix(q.r, q.r / max(q.b, 0.12) * a.b, 0.7);
  // beyond: the matte's own inside edge counts as light, so the outline carries crescents even where the
  // room light is flat (the reference gets them from a rim light). Grows with Melt.
  float edge = a.b * clamp(1.0 - q.b, 0.0, 1.0);
  float x = band + 0.12 * a.r + u_melt * 0.5 * pow(clamp(edge * 2.0, 0.0, 1.0), 2.0);
  fragColor = vec4(max(x, 0.0), a.r, a.b, band * 0.5 + 0.5);
}`;

// Statistics on a 64x36 grid, one frame late. Head width: the widest run of matte within one head-height
// of the top of the matte. Level point: a PERCENTILE of the band-passed picture, weighted to the head,
// so the same share of the face lights up in any room and a white shirt cannot take the light.
const STAT = COMMON + /* glsl */ `
float cellK(int i, int j){ return texelFetch(uBuf_lo, ivec2(i, j), 0).b; }
void main(){
  bool keyed = uPersonReady > 0.5 && u_key > 0.5;
  // Third pass. The head is the top of the blob that sits over the BODY: the matte's centre of mass in x
  // (lower rows count more: torso, not raised arms) picks the column, and the head is followed down from the
  // first matte row that touches that column. A raised hand off to the side is higher than the head but is
  // not over the body, so it can no longer be taken for it.
  float ksum = 0.0, cx = 0.0, cw = 0.0;
  for (int j = 0; j < 36; j++) for (int i = 0; i < 64; i++) {
    float k = step(0.5, cellK(i, j)); ksum += k;
    float w = k * (1.0 + 2.0 * float(35 - j) / 35.0); cx += w * float(i); cw += w;
  }
  cx = cw > 0.0 ? cx / cw : 32.0;
  float top = -1.0, headW = 0.0, lo_ = cx - 5.0, hi_ = cx + 5.0, rows = 0.0, done = 0.0;
  for (int j = 35; j >= 0; j--) {
    // the run of matte in this row that overlaps the tracked span [lo_, hi_]
    float bestW = 0.0, bestL = 0.0, bestR = 0.0, run = 0.0, st = 0.0;
    for (int i = 0; i <= 64; i++) {
      float k = i < 64 ? cellK(i, j) : 0.0;
      if (k > 0.5) { if (run < 0.5) st = float(i); run += 1.0; }
      else {
        if (run > 0.5) { float en = float(i) - 1.0; if (en >= lo_ && st <= hi_ && run > bestW) { bestW = run; bestL = st; bestR = en; } }
        run = 0.0;
      }
    }
    if (done > 0.5) continue;
    if (top < 0.0) { if (bestW >= 2.0) { top = float(j); headW = bestW; lo_ = bestL; hi_ = bestR; rows = 1.0; } continue; }
    if (bestW < 1.0) { done = 1.0; continue; }
    // the head's widest row is in its upper part: only rows within ~0.8 of a head width of the top may widen
    // it, and a row that jumps well past the head so far (shoulders, a hood's drape) ends the head
    if (rows > max(0.8 * headW, 2.0) || (rows >= 3.0 && bestW > 1.3 * headW)) { done = 1.0; continue; }
    headW = max(headW, bestW); lo_ = bestL; hi_ = bestR; rows += 1.0;
  }
  float has = keyed ? smoothstep(0.02, 0.07, ksum / 2304.0) : 0.0;
  float hw = has > 0.5 && top >= 0.0 ? clamp(headW / 64.0, 0.10, 0.60) : 0.5;
  float headBottom = top - 1.5 * headW;                       // rows below this are neck, shirt, arms
  float headX = 0.5 * (lo_ + hi_);
  float target = mix(0.02, 0.55, u_light) * (has > 0.5 ? 1.0 : 0.45);
  float lo = 0.0, hi = 1.0, wsum = 0.0;
  vec2 cell = 1.0 / vec2(64.0, 36.0);
  for (int it = 0; it < 8; it++) {
    float T = 0.5 * (lo + hi), above = 0.0; wsum = 0.0;
    for (int j = 0; j < 36; j++) for (int i = 0; i < 64; i++) {
      vec2 c = (vec2(float(i), float(j)) + 0.5) * cell;
      // two taps per cell and a soft count: the level point no longer flips with single noisy texels
      vec4 s = 0.5 * (texture(uBuf_pre, c + cell * vec2(-0.25, -0.2)) + texture(uBuf_pre, c + cell * vec2(0.25, 0.2)));
      // the head column counts fully; things beside it at head height (a raised hand) and below it count less
      float head = mix(0.15, 1.0, smoothstep(headBottom - 2.0, headBottom + 2.0, float(j)))
                 * mix(0.3, 1.0, smoothstep(1.6 * headW, 0.8 * headW, abs(float(i) - headX)));
      float w = mix(1.0, s.b * head, has);
      above += w * smoothstep(T * 0.9, T * 1.1 + 1e-4, s.r); wsum += w;
    }
    if (above / max(wsum, 1e-3) > target) lo = T; else hi = T;
  }
  float T = max(0.5 * (lo + hi), 0.035);                      // never light up sensor noise in a black frame
  vec4 prev = texture(uSelf, vec2(0.5));
  if (prev.a > 0.5) {
    // follow real changes quickly, sit still otherwise: exposure wobble and noise in the percentile must not
    // make every pool grow and shrink together
    float dT = abs(T - prev.r) / max(prev.r, 0.02), dW = abs(hw - prev.g) / max(prev.g, 0.05);
    T = mix(prev.r, T, mix(0.04, 0.45, smoothstep(0.06, 0.35, dT)));
    has = mix(prev.b, has, 0.3);
    hw = mix(prev.g, hw, mix(0.03, 0.35, smoothstep(0.12, 0.5, dW)));
  }
  fragColor = vec4(T, hw, has, 1.0);
}`;

// R = the light: hard level ("INF:1"), held with a decaying max so motion smears. G = the crushed dim
// picture (the grey middle: fine band-passed texture). B = light that has just arrived.
const LIT = COMMON + /* glsl */ `
void main(){
  float T = stats().r;
  vec4 pre = texture(uBuf_pre, vUv);
  float hard = smoothstep(T * 0.9, T * 1.1 + 0.003, pre.r);
  float band = (pre.a - 0.5) * 2.0;
  // SHADOW CRUSH: luma under 0.05 goes to black; what is left stays as a dim, textured picture
  float dim = clamp((pre.g - 0.05) * 0.42 + band * 3.2, 0.0, 1.0) * smoothstep(0.05, 0.12, pre.g);
  // the held light diffuses a little every frame, so a fast hand leaves a melting wake, not stacked copies
  // (third pass: a wider 9-tap kernel with a blue-noise turn, so the copies of a waving hand fuse into one wake)
  vec2 o = vec2(unitPx() * 0.034) / uRes;
  float an = texelFetch(uNoise, ivec2(gl_FragCoord.xy) & 255, 0).r * 1.5708; vec2 e1 = vec2(cos(an), sin(an)) * o, e2 = vec2(-sin(an), cos(an)) * o;
  vec4 prev = (texture(uSelf, vUv) * 2.0 + texture(uSelf, vUv + e1) + texture(uSelf, vUv - e1) + texture(uSelf, vUv + e2) + texture(uSelf, vUv - e2)
             + 0.5 * (texture(uSelf, vUv + 0.5 * (e1 + e2)) + texture(uSelf, vUv - 0.5 * (e1 + e2)) + texture(uSelf, vUv + 0.5 * (e1 - e2)) + texture(uSelf, vUv - 0.5 * (e1 - e2)))) / 8.0;
  float p = pow(clamp(u_trail, 0.0, 0.97), clamp(uDt, 1.0 / 120.0, 1.0 / 15.0) * 30.0);   // per-frame at 30 fps
  float held = prev.a > 0.5 ? prev.r * p : 0.0;
  float fresh = max(hard - (prev.a > 0.5 ? prev.r : hard), 0.0);
  fragColor = vec4(max(hard, held), dim, fresh, 1.0);
}`;

const rimSigma = `(unitPx() * mix(0.004, 0.030, u_glow) * mix(0.5, 1.4, u_melt))`;
const BH = COMMON + `void main(){ fragColor = gauss(uBuf_lit, vec2(1.0, 0.0), ${rimSigma} * mix(2.4, 1.5, u_melt)); }`;
const BV = COMMON + `void main(){ fragColor = gauss(uBuf_bh, vec2(0.0, 1.0), ${rimSigma}); }`;
const WH = COMMON + `void main(){ fragColor = gauss(uBuf_bv, vec2(1.0, 0.0), unitPx() * 0.11); }`;
const WV = COMMON + `void main(){ fragColor = gauss(uBuf_wh, vec2(0.0, 1.0), unitPx() * 0.075); }`;

const OUT = COMMON + /* glsl */ `
void main(){
  vec4 rim = texture(uBuf_bv, vUv);
  vec4 halo = texture(uBuf_wv, vUv);
  float v = rim.r * 1.7                                 // the blurred hard mask, overdriven so cores clip flat
          + rim.g * 0.8                                // the crushed picture underneath
          + halo.r * (0.2 + 0.8 * u_glow) * 0.5         // wide spill
          + (rim.b * 0.5 + halo.b * 1.2) * u_trail;     // beyond: fresh light flares
  v = tanh(v * 1.15);                                   // whites land at ~0.96 like the reference, never 1.0
  vec3 white = vec3(0.945, 0.965, 0.992);               // #F1F6FD
  vec3 col = mix(u_ground, white, v);
  // grain: fine, everywhere, a little weaker in the whites; re-seeded at 15 Hz
  float gs = max(1.0, uRes.x / 700.0);
  float k = floor(uTime * 15.0);
  vec2 gp = floor(gl_FragCoord.xy / gs) + mod(vec2(k * 37.0, k * 91.0), 256.0);
  float n = fract(sin(dot(gp, vec2(12.9898, 78.233))) * 43758.5453)
          + fract(sin(dot(gp, vec2(39.3468, 11.135))) * 24634.6345) - 1.0;   // triangular white noise
  col += n * u_grain * 0.13 * (1.0 - 0.45 * v);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export default {
  id: 'ghost-light',
  name: 'Ghost Light',
  ref: null,   // okamirufu shorts qoNQsdgiGsk / C_5hOu1yGGs: no mp4 (stills in refs/okami, pairs built by shots/ghost-light/pair.sh)
  needs: ['person'],
  params: [
    { id: 'melt', label: 'Melt', type: 'float', min: 0, max: 1, default: 0.3 },      // 0 = sparkle, 0.3 = Glow, 0.6 = Liquid
    { id: 'light', label: 'Light', type: 'float', min: 0, max: 1, default: 0.27 },    // how much of the head is lit
    { id: 'glow', label: 'Glow', type: 'float', min: 0, max: 1, default: 0.35 },
    { id: 'trail', label: 'Trail', type: 'float', min: 0, max: 0.97, default: 0.6 },
    { id: 'grain', label: 'Grain', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'ground', label: 'Ground', type: 'color', default: '#101216' },
    { id: 'key', label: 'Subject key', type: 'bool', default: true, more: true },
  ],
  passes: [
    { name: 'mono', frag: MONO, scale: 1 },
    { name: 'ph', frag: PH, scale: 1 },
    { name: 'pv', frag: PV, scale: 1 },
    { name: 'qh', frag: QH, scale: 0.25 },
    { name: 'qv', frag: QV, scale: 0.25 },
    { name: 'lo', frag: LO, size: [64, 36] },
    { name: 'pre', frag: PRE, scale: 1 },
    { name: 'stat', frag: STAT, size: [2, 2], feedback: true, filter: 'nearest' },
    { name: 'lit', frag: LIT, scale: 1, feedback: true },
    { name: 'bh', frag: BH, scale: 1 },
    { name: 'bv', frag: BV, scale: 1 },
    { name: 'wh', frag: WH, scale: 0.125 },
    { name: 'wv', frag: WV, scale: 0.125 },
    { name: 'out', frag: OUT, screen: true },
  ],
};
