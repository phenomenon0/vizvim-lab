// halftone — classic ink-on-paper AM screens as designed looks (News, Rosette CMYK, Poster duotone,
// Comic Ben-Day, Blue Dot), built on a temporally steady tone record so dots do not boil on a live camera.
// Area-correct spot functions (elliptical chain / Euclidean / round), analytic AA, dot gain in px,
// plate misregistration, subject-aware ruling (backdrop cells merge kxk on a sub-lattice, with hysteresis;
// a small figure latches the whole screen to 2/3 pitch). Tone is set by person-weighted Otsu levels (1x1
// feedback pass), held per cell behind a dead band; solid blacks by region-growing hysteresis.
// Motion "pulse" (ink swells where the picture moves) is off by default, under More.
// Breakdown: breakdowns/halftone.md

// ---- area-correct thresholds: th(a) such that the fraction of the cell with f > th equals a.
// f = .5 + wx cos(2pi u) + wy cos(2pi v) + B cos(2pi u) cos(2pi v)
const SPOTS = [
  [0.25, 0.25, 0.10],   // 0 round: stays round, necks late (~58%), round holes        (Blue Dot, Comic, Rosette)
  [0.25, 0.25, 0.00],   // 1 Euclidean: round -> square at 50% -> round holes          (Poster)
  [0.29, 0.21, 0.03],   // 2 elliptical chain: joins along one axis ~41%, the other ~59% (News)
];
const TH_N = 65;
function thTable([wx, wy, B]) {
  const N = 384, v = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cx = Math.cos(2 * Math.PI * (i + 0.5) / N), cy = Math.cos(2 * Math.PI * (j + 0.5) / N);
    v[j * N + i] = 0.5 + wx * cx + wy * cy + B * cx * cy;
  }
  v.sort();
  const out = [];
  for (let k = 0; k < TH_N; k++) {
    const a = k / (TH_N - 1);
    out.push(k === 0 ? v[N * N - 1] + 1e-3 : k === TH_N - 1 ? v[0] - 1e-3 : v[Math.round((1 - a) * (N * N - 1))]);
  }
  return out;
}
const TH_GLSL = `const float TH[${SPOTS.length * TH_N}] = float[${SPOTS.length * TH_N}](${SPOTS.flatMap(thTable).map(x => x.toFixed(5)).join(',')});`;

const COMMON = /* glsl */ `
const float PI = 3.14159265;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2 rot(float deg){ float a = radians(deg); float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fdt(){ return uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0; }
`;
// Auto levels -> print tone. lv.x / lv.y = the subject's dark / bright cluster means (Otsu, see LV pass).
// The dark cluster lands at 0.10 (prints solid or near it), the bright one at 0.80 (a light tint); above
// that a shoulder keeps a trace of tone so a hand near the lens does not blow to bare paper.
const LVT = /* glsl */ `
vec4 gLv;
float lvTone(float L){
  float x = (L - gLv.x) / max(gLv.y - gLv.x, 0.12);
  float t = 0.10 + 0.70 * x;
  if (x > 1.0) t = 0.80 + 0.13 * (1.0 - exp(-(x - 1.0) * 2.4));
  return clamp(t, 0.0, 1.0);
}
`;
// Levels (1 x 1, feedback): Otsu split of the steady record's luma over 16 x 9 samples, the person weighted
// 1, the room 0.06 -> x dark-cluster mean, y bright-cluster mean (eased, tau 0.5 s). z = fine-screen latch:
// 1 while the person covers under ~1/5 of the frame (small face -> the screen prints at 2/3 pitch), slewed.
const LV = COMMON + /* glsl */ `
void main(){
  float L[144]; float W[144]; float sw = 0.0, cov = 0.0;
  for (int i = 0; i < 144; i++) {
    vec2 q = (vec2(float(i % 16), float(i / 16)) + 0.5) / vec2(16.0, 9.0);
    L[i] = luma(texture(uBuf_fine, q).rgb);
    float m = smoothstep(0.3, 0.6, texture(uBuf_aux, q).r) * step(0.5, uPersonReady);
    cov += m / 144.0;
    W[i] = mix(1.0, 0.06 + 0.94 * m, step(0.5, uPersonReady)); sw += W[i];
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
  bool valid = prev.a > 0.5;
  float was = step(0.5, prev.z);
  float target = uPersonReady < 0.5 ? 0.0 : cov < 0.20 ? 1.0 : (cov > 0.28 ? 0.0 : (valid ? was : step(cov, 0.24)));
  float dt = fdt();
  float z = valid ? prev.z + clamp(target - prev.z, -dt / 0.35, dt / 0.35) : target;
  vec2 dl = vec2(lo, hi) - prev.xy;                          // dead band: sensor noise cannot walk the levels
  dl *= smoothstep(0.008, 0.03, abs(dl)) * (1.0 - exp(-dt / 0.6));
  fragColor = valid ? vec4(prev.xy + dl, z, 1.0) : vec4(lo, hi, z, 1.0);
}`;

// 1. The steady record (half res, feedback). Every tone the screens use comes from here, never from the
// raw camera. Still areas: EMA (tau 0.2 s) averages sensor noise away. Motion: a wide (10 px) low-passed
// difference, which noise cannot trip, releases the filter to the live frame at once -> no trails.
const FINE = COMMON + /* glsl */ `
void main(){
  vec2 t = 1.0 / vec2(textureSize(uCam, 0));
  vec2 h = 1.0 / uPassRes;
  vec3 c = texture(uCam, vUv).rgb;                      // 2x2 box of the source
  vec4 prev = texture(uSelf, vUv);
  float cw = 0.0, pw = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)) * 1.5;
    cw += luma(texture(uCam, vUv + o * 2.0 * t).rgb);
    pw += luma(texture(uSelf, vUv + o * h).rgb);
  }
  float d = abs(cw - pw) / 9.0;
  vec3 dc = abs(c - prev.rgb);
  float dp = max(dc.r, max(dc.g, dc.b));
  float a = 1.0 - exp(-fdt() / 0.20);
  a = mix(a, 1.0, max(smoothstep(0.022, 0.06, d), smoothstep(0.12, 0.22, dp)));
  if (prev.a < 0.5 || u_steady < 0.5) a = 1.0;
  fragColor = vec4(mix(prev.rgb, c, a), 1.0);
}`;

// 2. Slow fields (1/8 res, feedback): r = person matte, blurred + smoothed (fill light and ruling use this,
// never the raw matte edge) · g = backdrop state 0 subject .. 1 backdrop: Schmitt trigger on r, slewed over
// 0.15 s, so a cell changes ruling once and dissolves instead of flipping · b = motion energy (fast attack,
// 0.3 s release, diffused) · a = last low-passed luma (+ valid flag).
const AUX = COMMON + /* glsl */ `
void main(){
  vec4 prev = texture(uSelf, vUv);
  bool valid = prev.a > 0.05;
  float dt = fdt();
  vec2 h = 1.0 / uPassRes;
  float m = 0.0;
  if (uPersonReady > 0.5) {
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
      m += texture(uPerson, vUv + vec2(float(i), float(j)) * h * 0.9).r;
    m /= 9.0;
  }
  float mv = clamp(prev.b * 1.5, 0.0, 1.0);                 // where the picture is moving the matte and the ruling follow at once: no wake behind a hand
  float mS = valid ? mix(prev.r, m, max(1.0 - exp(-dt / 0.10), mv)) : m;
  float was = step(0.5, prev.g);
  float target = mS < 0.22 ? 1.0 : (mS > 0.42 ? 0.0 : was);
  if (!valid) target = mS < 0.32 ? 1.0 : 0.0;
  if (uPersonReady < 0.5) target = 0.0;
  float gr = dt / 0.15 + mv;
  float g = valid ? prev.g + clamp(target - prev.g, -gr, gr) : target;

  float L = 0.25 * (luma(texture(uBuf_fine, vUv + h * vec2(0.25, 0.25)).rgb) + luma(texture(uBuf_fine, vUv + h * vec2(-0.25, 0.25)).rgb)
                  + luma(texture(uBuf_fine, vUv + h * vec2(0.25, -0.25)).rgb) + luma(texture(uBuf_fine, vUv + h * vec2(-0.25, -0.25)).rgb));
  float e = valid ? smoothstep(0.03, 0.11, abs(L - (prev.a - 0.1) / 0.9)) : 0.0;
  float bn = prev.b * 0.4 + 0.15 * (texture(uSelf, vUv + vec2(h.x, 0.0)).b + texture(uSelf, vUv - vec2(h.x, 0.0)).b
                                  + texture(uSelf, vUv + vec2(0.0, h.y)).b + texture(uSelf, vUv - vec2(0.0, h.y)).b);
  bn *= exp(-dt / 0.30);
  float b = bn + max(e - bn, 0.0) * (1.0 - exp(-dt / 0.05));
  fragColor = vec4(mS, g, b, L * 0.9 + 0.1);
}`;

// Scene statistics (tiny, slow) -> auto gamma + wide dodge/burn. Read from the steady record.
const STAT = COMMON + /* glsl */ `
void main(){
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    c += texture(uBuf_fine, vUv + (vec2(float(i), float(j)) - 1.5) * 0.008).rgb;
  c /= 16.0;
  vec4 prev = texture(uSelf, vUv);
  float a = prev.a < 0.5 ? 1.0 : 1.0 - exp(-fdt() / 0.5);
  fragColor = vec4(mix(prev.rgb, c, a), 1.0);
}`;

// 3. Cell-area prefilter: the steady record box-filtered to one screen cell (5x5 taps, pitch/4 apart).
const CELL = COMMON + /* glsl */ `
void main(){
  float fz = int(u_style + 0.5) == 3 ? 0.0 : texture(uBuf_lv, vec2(0.5)).z;
  float pitch = u_cell * mix(1.0, 0.6667, fz) * uRes.x / 1080.0;
  vec2 s = pitch * 0.25 / uRes;
  vec3 c = vec3(0.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = (abs(i) == 2 ? 0.5 : 1.0) * (abs(j) == 2 ? 0.5 : 1.0);
    c += w * texture(uBuf_fine, vUv + vec2(float(i), float(j)) * s).rgb;
  }
  c /= 16.0;
  // dead band: a cell's tone holds until it moves by more than the residual noise, then follows at once
  vec4 prev = texture(uSelf, vUv);
  vec3 d = c - prev.rgb;
  float m = max(abs(d.r), max(abs(d.g), abs(d.b)));
  if (prev.a > 0.5 && u_steady > 0.5) c = prev.rgb + d * smoothstep(0.006, 0.022, m);
  fragColor = vec4(c, 1.0);
}`;
// ... and to one merged backdrop cell (k * pitch).
const WIDE = COMMON + /* glsl */ `
void main(){
  float pk = u_cell * max(u_backdrop, 1.0) * uRes.x / 1080.0;
  vec2 s = pk * 0.2 / uRes;
  vec3 c = vec3(0.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++)
    c += texture(uBuf_cell, vUv + vec2(float(i), float(j)) * s).rgb;
  fragColor = vec4(c / 25.0, 1.0);
}`;

// 4. Comic black plate (1/4 res, feedback): where solid black prints. Schmitt trigger on the cell-area
// tone (in below 0.215, out above 0.285, else hold), slewed; motion releases the slew. A cloth sitting on
// the threshold inks once as a shape and stays, instead of boiling as grain.
const INK = COMMON + LVT + /* glsl */ `
void main(){
  gLv = texture(uBuf_lv, vec2(0.5));
  vec4 ax = texture(uBuf_aux, vUv);
  float adapt = pow(0.46 / clamp(luma(texture(uBuf_stat, vUv).rgb), 0.08, 0.9), 0.28);
  vec3 kc = mix(texture(uBuf_cell, vUv).rgb, texture(uBuf_fine, vUv).rgb, 0.3);
  float tk = lvTone(luma(kc) * adapt);
  // skin in shade is still warm: on the subject it holds a tint instead of blocking to solid black
  if (uPersonReady > 0.5) tk += 0.10 * smoothstep(0.4, 0.7, ax.r) * smoothstep(0.10, 0.24, (kc.r - kc.b) / max(luma(kc), 0.04)) * smoothstep(0.10, 0.20, tk);
  vec4 prev = texture(uSelf, vUv);
  float was = step(0.5, prev.r);
  // region-growing hysteresis: in below IN, out above OUT; in between a texel holds, or joins inked neighbours
  vec2 h = 1.5 / uPassRes;
  float nb = max(max(texture(uSelf, vUv + vec2(h.x, 0.0)).r, texture(uSelf, vUv - vec2(h.x, 0.0)).r),
                 max(texture(uSelf, vUv + vec2(0.0, h.y)).r, texture(uSelf, vUv - vec2(0.0, h.y)).r));
  float target = tk < 0.21 ? 1.0 : (tk > 0.31 ? 0.0 : max(was, step(0.6, nb)));
  float r = fdt() / 0.10 + ax.b;
  float st = prev.a < 0.5 ? step(tk, 0.26) : prev.r + clamp(target - prev.r, -r, r);
  fragColor = vec4(st, tk, 0.0, 1.0);
}`;

const OUT = COMMON + LVT + TH_GLSL + /* glsl */ `
float spotTh(int shape, float a){
  float x = clamp(a, 0.0, 1.0) * ${TH_N - 1}.0;
  int i = int(min(floor(x), ${TH_N - 2}.0));
  int o = shape * ${TH_N};
  return mix(TH[o + i], TH[o + i + 1], x - float(i));
}
vec3 spotW(int shape){ return shape == 0 ? vec3(0.25, 0.25, 0.10) : shape == 1 ? vec3(0.25, 0.25, 0.0) : vec3(0.29, 0.21, 0.03); }

// Signed distance (px, + inside ink) to the dot outline at coverage a, lattice coordinate q.
float dotDist(vec2 q, float pitch, float a, int shape){
  vec3 w = spotW(shape);
  vec2 s = sin(2.0*PI*q), c = cos(2.0*PI*q);
  float f = 0.5 + w.x*c.x + w.y*c.y + w.z*c.x*c.y;
  vec2 gr = 2.0*PI*vec2(s.x*(w.x + w.z*c.y), s.y*(w.y + w.z*c.x)) / pitch;
  float e = f - spotTh(shape, a);
  float curv = (0.5 + 2.0*w.z)*PI*PI / (pitch*pitch);
  return e / sqrt(dot(gr, gr) + curv*abs(e) + 1e-9);
}

float gAdapt, gGainPx, gRag, gDetail, gPulse, gBk, gFineF, gUsm, gSubC;

// scene tone -> print tone 0..1 (auto levels, wide dodge/burn, contrast)
float tone(float L){
  L = lvTone(L * gAdapt);
  float x = clamp((L - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  return x*x*(3.0 - 2.0*x) * 0.35 + x * 0.65;
}
float cover(float L){ return clamp(1.0 - tone(L), 0.0, 1.0); }
vec3 cover3(vec3 c){ return vec3(cover(c.r), cover(c.g), cover(c.b)); }
// Ben-Day tint steps: 0 / 25 / 50 / solid, soft risers so a region boundary cannot chatter
float benday(float x){ return 0.25*smoothstep(0.10, 0.17, x) + 0.25*smoothstep(0.34, 0.42, x) + 0.43*smoothstep(0.66, 0.76, x); }
vec3 comicCMY(vec3 rgb){
  vec3 c = pow(vec3(tone(rgb.r), tone(rgb.g), tone(rgb.b)), vec3(0.62));   // tints print light; the black plate carries the shadows
  float L = luma(c);
  vec3 cmy = 1.0 - clamp(L + (c - L) * 2.2, 0.0, 1.0);
  float n = min(cmy.x, min(cmy.y, cmy.z));
  vec3 ch = max(cmy - n - 0.07, 0.0) * 1.45;                    // faint casts drop out: flat fields stay one ink
  cmy = ch + max(n - 0.06, 0.0) * vec3(1.0, 0.22, 0.0);         // neutrals print cool: blue-grey, never mud
  vec3 bd = vec3(benday(cmy.x), benday(cmy.y), benday(cmy.z));
  // neutral mids on the subject (a sheen on dark hair or cloth) stay paper, a white highlight in the black,
  // not a blue patch; only real colour prints
  float neu = gSubC * (1.0 - smoothstep(0.30, 0.48, ch.x));
  bd.x = mix(bd.x, 0.0, neu);
  bd.y = mix(bd.y, benday(ch.y), neu);
  // flesh: lit skin on the subject always carries the light red tint (25 %), as comics print it; never bare paper
  float sk = gSubC * smoothstep(0.56, 0.70, L) * smoothstep(0.04, 0.12, (rgb.r - rgb.b) / max(rgb.r, 0.05));
  bd.y = max(bd.y, 0.25 * smoothstep(0.35, 0.65, sk));
  return bd;
}
// chan: 0 mono · 1-3 process CMY, 4 process K (GCR) · 5 duotone light ink, 6 duotone dark ink · 7-9 comic CMY
float chanCov(vec3 rgb, int chan){
  if (chan == 0) return cover(luma(rgb));
  if (chan <= 4) {
    vec3 d3 = cover3(rgb);
    d3 = clamp(mix(vec3(dot(d3, vec3(0.3333))), d3, 1.3), 0.0, 1.0);     // press-side saturation: webcam colour is timid
    float k = min(d3.r, min(d3.g, d3.b));
    float g = k * mix(0.80, 1.0, smoothstep(0.25, 0.75, k));             // heavy GCR: neutrals print as black only, so a plain wall is one calm plate
    if (chan == 4) return g;
    return clamp((d3[chan - 1] - g) / max(1.0 - g, 1e-3), 0.0, 1.0);
  }
  if (chan <= 6) {
    float a = cover(luma(rgb));
    return chan == 5 ? 0.92 * clamp(a * 1.25, 0.0, 1.0) : pow(clamp((a - 0.30) / 0.66, 0.0, 1.0), 1.25);
  }
  return comicCMY(rgb)[chan - 7];
}

// one lattice at ruling k (k x k fine cells merged; k = 1 is the fine screen)
float lat(vec2 p, vec2 q, mat2 Ri, float pitch, float k, int chan, int shape, out float edge){
  vec2 qk = (q + 0.5) / k - 0.5;
  float pk = pitch * k;
  vec2 cDot = (Ri * (((round(qk) + 0.5) * k - 0.5) * pitch)) / uRes;
  vec2 cHole = (Ri * (((floor(qk) + 1.0) * k - 0.5) * pitch)) / uRes;
  vec2 uv = p / uRes;
  vec3 tD, tH;
  if (k > 1.5) { tD = texture(uBuf_wide, cDot).rgb; tH = texture(uBuf_wide, cHole).rgb; }
  else { tD = texture(uBuf_cell, cDot).rgb; tH = texture(uBuf_cell, cHole).rgb; }
  if (gUsm > 0.001 && k < 1.5) {                                  // prepress unsharp mask on the subject screen
    tD += gUsm * (tD - texture(uBuf_wide, cDot).rgb); tH += gUsm * (tH - texture(uBuf_wide, cHole).rgb);
  }
  gSubC = chan >= 7 && uPersonReady > 0.5 ? smoothstep(0.35, 0.6, texture(uBuf_aux, cDot).r) : 0.0;
  float aD = chanCov(tD, chan), aH = chanCov(tH, chan);
  float a = mix(aD, aH, smoothstep(0.38, 0.62, 0.5*(aD + aH)));   // dots and holes are both whole shapes
  float dw = gDetail * clamp(12.0 / pk, 0.0, 1.0);
  if (dw > 0.001) {
    vec3 f = texture(uBuf_fine, uv).rgb;
    if (k < 1.5) f += gUsm * (f - texture(uBuf_wide, uv).rgb);
    a = clamp(mix(a, chanCov(f, chan), dw), 0.0, 1.0);
  }
  float d = dotDist(qk, pk, a, shape);
  float on = smoothstep(0.004, 0.03, a), full = smoothstep(0.93, 0.975, a);
  d += (gGainPx * min(1.0, pk / 8.0) + gRag + gPulse * 0.16 * pk) * on;
  edge = d;
  float cov = clamp(d + 0.5, 0.0, 1.0) * on;
  cov = mix(cov, 1.0, full);
  return mix(a, cov, smoothstep(2.2, 3.6, pk));     // too fine to resolve -> continuous tone, no shimmer
}

// one plate: ink coverage of this pixel. Backdrop cells (state from the aux pass, read at the merged
// cell's centre so a cell is never cut) print at k x the pitch; the two rulings cross-dissolve.
float screenAtK(vec2 p, float pitch, float bk, float ang, int chan, int shape, out float edge){
  mat2 R = rot(ang), Ri = rot(-ang);
  vec2 q = R * p / pitch;
  float s = 0.0;
  if (bk > 1.5) {
    vec2 cq = (floor((q + 0.5) / bk) + 0.5) * bk - 0.5;
    s = texelFetch(uBuf_aux, ivec2(clamp((Ri * (cq * pitch)) / uRes, 0.0, 0.9999) * vec2(textureSize(uBuf_aux, 0))), 0).g;   // nearest: fractional only while a cell is dissolving
  }
  float e0 = 0.0, e1 = 0.0, c0 = 0.0, c1 = 0.0;
  if (s < 0.999) c0 = lat(p, q, Ri, pitch, 1.0, chan, shape, e0);
  if (s > 0.001) c1 = lat(p, q, Ri, pitch, bk, chan, shape, e1);
  edge = mix(e0, e1, s);
  return mix(c0, c1, s);
}
// Small subject -> the whole lattice prints at 2/3 pitch and the backdrop merges 1.5x as many cells, so the
// backdrop ruling stays where it was. The latch is global and slewed; the two lattices cross-dissolve.
float screenInk(vec2 p, float pitch, float ang, int chan, int shape, out float edge){
  float e0 = 0.0, e1 = 0.0, c0 = 0.0, c1 = 0.0;
  if (gFineF < 0.999) c0 = screenAtK(p, pitch, gBk, ang, chan, shape, e0);
  if (gFineF > 0.001) c1 = screenAtK(p, pitch * 0.6667, gBk < 1.5 ? 1.0 : ceil(gBk * 1.5 - 0.01), ang, chan, shape, e1);
  edge = mix(e0, e1, gFineF);
  return mix(c0, c1, gFineF);
}

vec3 inkLayer(vec3 col, vec3 ink, float cov, float edge, float mott){
  // ink film: slightly uneven density, a touch heavier at the squashed rim
  float rim = 1.0 - smoothstep(0.0, 2.2, edge);
  float dens = clamp(0.93 + 0.07*mott + 0.05*rim, 0.0, 1.0);
  return col * mix(vec3(1.0), ink, cov * dens);
}

void main(){
  float S = uRes.x / 1080.0;
  vec2 p = vUv * uRes;
  float pitch = u_cell * S;
  int st = int(u_style + 0.5);
  gLv = texture(uBuf_lv, vec2(0.5));
  gFineF = st == 3 ? 0.0 : gLv.z;
  gUsm = st == 3 ? 0.0 : st == 1 ? 0.3 : 0.6;
  gAdapt = pow(0.46 / clamp(luma(texture(uBuf_stat, vUv).rgb), 0.08, 0.9), 0.28);
  gBk = floor(u_backdrop + 0.5);
  gDetail = st == 3 ? 0.0 : st == 1 ? 0.4 * u_detail : u_detail;   // four stacked plates: per-pixel tone is noise x4
  gPulse = u_pulse * texture(uBuf_aux, vUv).b;

  // static paper + per-pixel tooth (locked to the frame, never animated)
  vec4 bn = texelFetch(uNoise, ivec2(mod(p, 256.0)), 0);
  float fib = vnoise(p / S * vec2(0.9, 0.22)) * 0.6 + vnoise(p / S * 0.07) * 0.4;
  float mott = vnoise(p / S * 0.35) * 0.6 + bn.g * 0.4;
  gRag = (bn.r - 0.5) * 0.7 + (vnoise(p * 0.45) - 0.5) * 0.5;
  gGainPx = u_gain * 1.6 * S;
  float reg = S * clamp(pitch / (7.0 * S), 0.7, 2.5);  // plate misregistration unit (px)
  float A = u_angle;
  vec3 col; float e, cv;

  if (st == 0) {
    // NEWS — one warm black on newsprint, elliptical chain dot at 45, heavy gain, starved film
    vec3 paper = vec3(0.886, 0.863, 0.800);            // #E2DCCC
    paper *= 1.0 + (fib - 0.5) * 0.07 + (bn.b - 0.5) * 0.03;
    gGainPx *= 1.25; gRag *= 1.3;
    cv = screenInk(p, pitch, 45.0 + A, 0, 2, e);
    col = inkLayer(paper, vec3(0.165, 0.150, 0.140), cv * (0.90 + 0.10 * mott), e, mott);   // #2A2624
  } else if (st == 1) {
    // ROSETTE — four process plates at 15 / 75 / 0 / 45, GCR, each plate slightly out of register
    vec3 paper = vec3(0.945, 0.935, 0.905);            // #F1EEE7
    paper *= 1.0 + (fib - 0.5) * 0.03 + (bn.b - 0.5) * 0.015;
    gGainPx *= 0.4;                                    // four films stack: per-film gain has to be small
    col = paper;
    cv = screenInk(p + vec2(0.9, -0.5) * reg, pitch, 15.0 + A, 1, 0, e); col = inkLayer(col, vec3(0.05, 0.60, 0.86), cv, e, mott);
    cv = screenInk(p + vec2(-0.7, 0.8) * reg, pitch, 75.0 + A, 2, 0, e); col = inkLayer(col, vec3(0.86, 0.13, 0.47), cv, e, mott);
    cv = screenInk(p + vec2(0.3, 0.6) * reg, pitch, 0.0 + A, 3, 0, e);   col = inkLayer(col, vec3(0.99, 0.89, 0.10), cv, e, mott);
    cv = screenInk(p, pitch, 45.0 + A, 4, 0, e);                         col = inkLayer(col, vec3(0.125, 0.115, 0.125), cv, e, mott);
  } else if (st == 2) {
    // POSTER — duotone on coloured stock: coral carries the lights and mids, indigo the shadows
    vec3 paper = vec3(0.953, 0.890, 0.722);            // #F3E3B8
    paper *= 1.0 + (fib - 0.5) * 0.04 + (bn.b - 0.5) * 0.02;
    col = paper;
    cv = screenInk(p + vec2(0.8, 0.5) * reg, pitch, 15.0 + A, 5, 0, e); col = inkLayer(col, vec3(0.945, 0.310, 0.220), cv, e, mott);   // #F14F38
    cv = screenInk(p, pitch, 45.0 + A, 6, 1, e);                        col = inkLayer(col, vec3(0.110, 0.140, 0.430), cv, e, mott);   // #1C246E
  } else if (st == 3) {
    // COMIC — Ben-Day tints (uniform dots at 25 / 50 / solid) + solid blacks and a keyline
    vec3 paper = vec3(0.953, 0.925, 0.847);            // #F3ECD8 pulp
    paper *= 1.0 + (fib - 0.5) * 0.05 + (bn.b - 0.5) * 0.02;
    gGainPx *= 0.6;
    col = paper;
    cv = screenInk(p + vec2(0.4, 0.7) * reg, pitch, 0.0 + A, 9, 0, e);   col = inkLayer(col, vec3(0.99, 0.85, 0.08), cv, e, mott);
    cv = screenInk(p + vec2(-0.8, 0.5) * reg, pitch, 45.0 + A, 8, 0, e); col = inkLayer(col, vec3(0.90, 0.16, 0.24), cv, e, mott);
    cv = screenInk(p + vec2(0.9, -0.4) * reg, pitch, 75.0 + A, 7, 0, e); col = inkLayer(col, vec3(0.07, 0.56, 0.86), cv, e, mott);
    // black plate from the steady record: solid shadows + keyline on luminance edges
    vec2 uv = vUv, o = 1.6 * S / uRes;
    float sub = smoothstep(0.25, 0.6, texture(uBuf_aux, uv).r);     // keyline is drawn for the subject; the room gets only its strong edges
    if (uPersonReady < 0.5) sub = 1.0;
    o *= mix(1.6, 1.0, sub);
    float t00 = tone(luma(texture(uBuf_fine, uv + vec2(-o.x, -o.y)).rgb)), t11 = tone(luma(texture(uBuf_fine, uv + vec2(o.x, o.y)).rgb));
    float t10 = tone(luma(texture(uBuf_fine, uv + vec2(o.x, -o.y)).rgb)), t01 = tone(luma(texture(uBuf_fine, uv + vec2(-o.x, o.y)).rgb));
    float gmag = length(vec2(t11 - t00, t10 - t01));
    float kt = mix(0.26, 0.11, sub);
    float key = smoothstep(kt, kt + 0.10, gmag + gRag * 0.02);
    // solid blacks: the hysteresis state from the ink pass (keyed off a less lifted tone than the tints)
    float solid = smoothstep(0.40, 0.60, texture(uBuf_ink, uv).r + gRag * 0.03);
    // features: on the subject, what is clearly darker than its own surround (pupil and iris, brow, nostril,
    // lip line) is inked from local contrast, so an eye is drawn and not left as a paper hole
    float tf = tone(luma(texture(uBuf_fine, uv).rgb));
    float o2 = 4.0 * S;
    float tw = 0.25 * (tone(luma(texture(uBuf_cell, uv + vec2(o2, o2) / uRes).rgb)) + tone(luma(texture(uBuf_cell, uv + vec2(-o2, o2) / uRes).rgb))
                     + tone(luma(texture(uBuf_cell, uv + vec2(o2, -o2) / uRes).rgb)) + tone(luma(texture(uBuf_cell, uv + vec2(-o2, -o2) / uRes).rgb)));
    float feat = sub * smoothstep(0.095, 0.15, tw - tf + gRag * 0.01) * smoothstep(0.30, 0.45, tw);
    solid = max(solid, feat);
    col = inkLayer(col, vec3(0.085, 0.075, 0.085), max(key, solid), 3.0, mott);
  } else {
    // BLUE DOT — the reel's dot-matrix print: ultramarine round dots on off-white
    vec3 paper = vec3(0.918, 0.902, 0.859);            // #EAE6DB
    paper *= 1.0 + (fib - 0.5) * 0.035 + (bn.b - 0.5) * 0.018;
    cv = screenInk(p, pitch, 45.0 + A, 0, 0, e);
    col = inkLayer(paper, vec3(0.059, 0.251, 0.651), cv, e, mott);   // #0F40A6
  }
  fragColor = vec4(col, 1.0);
}`;

export default {
  id: 'halftone',
  name: 'Halftone',
  ref: { clip: 'DcTpHw4Owmc', t: [7.3, 8.1] },
  needs: ['person'],
  params: [
    { id: 'style', label: 'Style', type: 'enum', options: ['News', 'Rosette CMYK', 'Poster duotone', 'Comic', 'Blue Dot'], default: 3 },
    { id: 'cell', label: 'Cell px', type: 'float', min: 4, max: 40, default: 7 },
    { id: 'backdrop', label: 'Backdrop ×', type: 'int', min: 1, max: 4, default: 2 },
    { id: 'gain', label: 'Dot gain', type: 'float', min: 0, max: 1, default: 0.3 },
    { id: 'contrast', label: 'Contrast', type: 'float', min: 0.6, max: 2.5, default: 1.1 },
    { id: 'pulse', label: 'Pulse', type: 'float', min: 0, max: 1, default: 0, more: true },
    { id: 'angle', label: 'Angle ±', type: 'float', min: -45, max: 45, default: 0, more: true },
    { id: 'detail', label: 'Detail', type: 'float', min: 0, max: 1, default: 0.6, more: true },
    { id: 'steady', label: 'Steady', type: 'bool', default: true, more: true },
  ],
  passes: [
    { name: 'fine', frag: FINE, scale: 0.5, feedback: true },
    { name: 'aux', frag: AUX, scale: 0.125, feedback: true },
    { name: 'stat', frag: STAT, scale: 0.03, feedback: true },
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'cell', frag: CELL, scale: 0.25, feedback: true },
    { name: 'wide', frag: WIDE, scale: 0.125 },
    { name: 'ink', frag: INK, scale: 0.25, feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
};
