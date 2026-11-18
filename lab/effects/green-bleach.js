// green-bleach — the white/green overprint look from DecGDxGue_s (9.0–10.6 s). Breakdown: breakdowns/green-bleach.md
//
// Measured (frames 560/572/590): it is NOT a green gradient map with an RGB split on top. It is ONE
// steep luma level curve (reel: ink falls from full at luma .10 to none at .37, fine grain on top; here the
// curve sits between the subject's dark and bright clusters, found by person-weighted Otsu levels on a
// steady record, so any room bleaches the same and the face keeps its features) printed three
// times as three inks that MULTIPLY over white paper, each copy displaced along one diagonal:
//   yellow  #fad600  at  -d      (kills blue)
//   cyan    #00bde6  at   0      (kills red)
//   pink    #fdddf9  at  +d      (takes 13 % of green)
//   d = (+11.4 px, 6.5 px up) per step at 1080 wide = 0.0106 of the frame in both u and v.
// All three overlap -> (0, .54, 0) = the green subject #008605. One only -> the yellow / cyan / pink
// fringes; pairs -> yellow-green (#03980a) and blue (#02a6e2). No tonal steps besides these.
// Beyond: `Smear` — the three plates slip along the hand's velocity near the hand (misregistration
// that follows the gesture). Still hands = the reference.

const BASE = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float luma(vec3 c){ return lum(c); }
float fdt(){ return uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0; }
`;

// The steady record (full res, feedback). rgb: EMA (tau 0.2 s) in still areas; a wide low-passed
// difference, which sensor noise cannot trip, releases it to the live frame at once (no trails).
// a: 0.25 + 0.75 * person matte, smoothed 0.1 s (released by the same motion test).
const TONE = BASE + /* glsl */ `
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
const LV = BASE + /* glsl */ `
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

const COMMON = BASE + /* glsl */ `
vec3 hueRot(vec3 c, float deg){
  float a = radians(deg), cs = cos(a), sn = sin(a);
  vec3 k = vec3(0.57735);
  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
}
vec4 gLv;
// the plate at a source position: 1 = ink. bias moves this plate's curve.
float plate(vec2 uv, float seed, float bias){
  const vec3 w = vec3(0.299, 0.587, 0.114);
  vec2 px = 1.0 / uRes; float k = uRes.x / 1080.0;
  // webcam softness: 4-tap box of the steady record (no sensor noise in the plate)
  float L = 0.25 * (dot(texture(uBuf_tone, uv + px * vec2(-1.1, -1.1) * k).rgb, w) + dot(texture(uBuf_tone, uv + px * vec2(1.1, -1.1) * k).rgb, w)
                  + dot(texture(uBuf_tone, uv + px * vec2(-1.1,  1.1) * k).rgb, w) + dot(texture(uBuf_tone, uv + px * vec2(1.1,  1.1) * k).rgb, w));
  // wide ring: local contrast, so brows / eyes / mouth cut into bleached skin
  float Lw = 0.25 * (dot(texture(uBuf_tone, uv + px * vec2(-9.0, -5.0) * k).rgb, w) + dot(texture(uBuf_tone, uv + px * vec2(9.0, -5.0) * k).rgb, w)
                   + dot(texture(uBuf_tone, uv + px * vec2(-5.0,  9.0) * k).rgb, w) + dot(texture(uBuf_tone, uv + px * vec2(5.0,  9.0) * k).rgb, w));
  float rng = max(gLv.y - gLv.x, 0.12);
  float x = (L - gLv.x) / rng + min(L - Lw, 0.0) / rng * 0.9;      // 0 dark cluster .. 1 bright cluster
  // cloth: inside the dark cluster a fold that is lighter than its surround (relative, darks are compressed)
  // opens the plate, so a black jumper prints as worked fabric, not one flat solid
  float Lm = 0.0, Lr = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i < 2 ? -1.0 : 1.0, (i & 1) == 0 ? -1.0 : 1.0);
    Lm += dot(texture(uBuf_tone, uv + px * o * 3.0 * k).rgb, w);
    Lr += dot(texture(uBuf_tone, uv + px * o * 16.0 * k).rgb, w) + dot(texture(uBuf_tone, uv + px * vec2(o.x - o.y, o.x + o.y) * 11.0 * k).rgb, w);
  }
  Lm *= 0.25; Lr *= 0.125;
  x += 0.6 * smoothstep(0.10, 0.45, (Lm - Lr) / max(Lr, 0.08)) * (1.0 - smoothstep(0.15, 0.55, x));
  // the room's mid tones (ceiling, walls) clear to paper: only the subject and real room darks take ink
  float pm = clamp((texture(uBuf_tone, uv).a - 0.25) / 0.75, 0.0, 1.0);
  x += (1.0 - smoothstep(0.25, 0.6, pm)) * 0.6 * smoothstep(0.18, 0.5, x);
  // speckle is fixed to the sheet (it never re-seeds): each plate carries its own grain, displaced.
  // triangular distribution (two taps), one value per 0.9 px at 1080
  vec2 np = floor(uv * uRes / (0.9 * k)) + vec2(seed * 37.0, seed * 91.0);
  float n = texture(uNoise, (np + 0.5) / 256.0).r + texture(uNoise, (np.yx + vec2(101.5, 47.5)) / 256.0).g - 1.0;
  // the plate is a steep but CONTINUOUS level curve with fine grain riding on it; not a binary threshold
  float c = mix(0.10, 0.90, u_threshold) + bias, sw = 0.30;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return (1.0 - smoothstep(c - sw, c + sw, x + 1.3 * n * u_grain)) * inside;
}
`;

const OUT = COMMON + /* glsl */ `
void main(){
  float k = uRes.x / 1080.0;
  float a = radians(u_angle);
  vec2 d = vec2(cos(a), sin(a)) * u_split * k / uRes;       // one plate step, uv

  // ── beyond: plates slip along the hand's velocity, near the hand only ──
  vec2 slip = vec2(0.0);
  if (u_smear > 0.0) {
    float asp = uRes.x / uRes.y;
    for (int h = 0; h < 2; h++) {
      if (h >= uHandCount) break;
      vec2 q = (vUv - uHandCenter[h]) * vec2(asp, 1.0);
      float w = exp(-dot(q, q) / (0.22 * 0.22));
      vec2 v = uHandVel[h]; float sp = length(v);
      slip += w * u_smear * 0.045 * v * min(1.0, 2.5 / max(sp, 1e-3));   // 45 ms of travel, capped
    }
  }
  vec2 s = d + slip;
  float seed = 0.0;
  gLv = texture(uBuf_lv, vec2(0.5));
  // the yellow plate is cut slightly heavier than the other two: the holes in the jacket read yellow-green,
  // not blue (tested and rejected: cutting the plates from separate R/G/B channels; the jacket goes blue)
  float mY = plate(vUv + s, 1.0, 0.05);    // yellow plate sits down-left of cyan
  float mC = plate(vUv, 2.0, 0.0);
  float mP = plate(vUv - s, 3.0, 0.0);    // pink up-right

  vec3 inkY = hueRot(vec3(0.980, 0.840, 0.000), u_hue);
  vec3 inkC = hueRot(vec3(0.000, 0.740, 0.900), u_hue);
  vec3 inkP = hueRot(vec3(0.990, 0.870, 0.980), u_hue);
  vec3 col = vec3(0.985, 0.976, 0.990);
  col *= mix(vec3(1.0), clamp(inkY, 0.0, 1.0), mY);
  col *= mix(vec3(1.0), clamp(inkC, 0.0, 1.0), mC);
  col *= mix(vec3(1.0), clamp(inkP, 0.0, 1.0), mP);
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'green-bleach',
  name: 'Green Bleach',
  ref: { clip: 'DecGDxGue_s', t: [9.2, 10.4] },
  needs: ['hands', 'person'],
  params: [
    { id: 'threshold', label: 'Bleach', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'grain', label: 'Grain', type: 'float', min: 0, max: 0.5, default: 0.2 },
    { id: 'split', label: 'Split', type: 'float', min: 0, max: 40, default: 13.1 },
    { id: 'angle', label: 'Angle', type: 'float', min: -180, max: 180, default: 30 },
    { id: 'hue', label: 'Ink Hue', type: 'float', min: -180, max: 180, default: 0 },
    { id: 'smear', label: 'Hand Smear', type: 'float', min: 0, max: 1, default: 0.6 },
  ],
  passes: [
    { name: 'tone', frag: TONE, feedback: true },
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'out', frag: OUT, screen: true },
  ],
};
