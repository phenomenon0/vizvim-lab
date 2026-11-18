// grain-dither — the hard 1-bit grain look from DecGDxGue_s (7.0–8.75 s). Breakdown: breakdowns/grain-dither.md
//
// Measured (frames 440–520): pure black/white, one decision per 3x3 px cell of the 1280x720 TOP
// (2.54 px in the 1080 video -> a 427x240 grid). The texture is ERROR DIFFUSION of a noisy live picture
// (worms, short horizontal dashes, checker patches, diagonal dot rows in the highlights), not a Bayer
// matrix and not thresholded noise. It is recomputed every source frame (20 % of cells flip per frame).
// Neighbour statistics sit on a wide kernel (Jarvis–Judice–Ninke) with input noise sigma ~0.1; plain
// Floyd–Steinberg is too fine and too regular.
// Tone before the dither: the reel's fixed ramp (white fraction = (L - .18) / (.69 - .18)) is replaced by
// person-weighted Otsu levels: the subject's dark cluster falls to solid ink, its bright cluster nearly
// clears to paper, in any room. The reel re-seeds its grain every frame (20 % of cells flip); on a live
// webcam that boils, so here the cell lumas are held behind a dead band and the grain is fixed to the
// sheet: a still scene dithers to the identical pattern. Boil brings the reel's flicker back, scaled.
//
// Error diffusion is serial; here it is made parallel exactly the way a compute kernel would do it:
// the cell grid is cut into brick-staggered 16x16 tiles, every fragment re-runs the diffusion from the
// (padded) origin of its own tile down to itself. Input noise hides the tile joins (checked: no seam
// in the autocorrelation at lag 16).
// Beyond: `Hold` — inside the person matte the picture is locally contrast-expanded before the dither
// and gets less noise, so the face keeps eyes/mouth in clean dots while the room stays grain.

const COMMON = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
ivec2 gridSize(){ float k = uRes.x / 1080.0; return ivec2(max(floor(uRes / (u_cell * k)), vec2(8.0))); }
`;

// Levels (1 x 1, feedback): Otsu split of the held cell luma over 16 x 9 samples, the person weighted 1,
// the room 0.06 -> x dark-cluster mean, y bright-cluster mean. Eased (0.6 s) with a dead band.
const LV = COMMON + /* glsl */ `
void main(){
  ivec2 G = gridSize();
  float L[144]; float W[144]; float sw = 0.0;
  for (int i = 0; i < 144; i++) {
    vec2 q = (vec2(float(i % 16), float(i / 16)) + 0.5) / vec2(16.0, 9.0);
    L[i] = texelFetch(uSelfTone, ivec2(q * vec2(G)), 0).g;
    W[i] = uPersonReady > 0.5 ? 0.06 + 0.94 * smoothstep(0.3, 0.6, texture(uPerson, q).r) : 1.0; sw += W[i];
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
  dl *= step(0.02, abs(dl)) * (1.0 - exp(-dt / 0.6));               // hard dead band: levels sit exactly still in a still room
  fragColor = prev.a > 0.5 ? vec4(prev.xy + dl, 0.0, 1.0) : vec4(lo, hi, 0.0, 1.0);
}`.replace('uSelfTone', 'uBuf_tone');

// pass 1 (feedback): one value per cell. g: the cell's luma, area-averaged and HELD: it only moves when the
// change clears a dead band, so sensor noise never reaches the diffusion and a still scene dithers to the
// identical pattern every frame. r: levelled tone + grain (+ hold). Cells live in the lower-left of a
// half-res buffer.
const TONE = COMMON + /* glsl */ `
void main(){
  ivec2 G = gridSize(); ivec2 c = ivec2(gl_FragCoord.xy);
  if (c.x >= G.x || c.y >= G.y) { fragColor = vec4(0.0); return; }
  vec2 g = vec2(G);
  vec2 uv = (vec2(c) + 0.5) / g;
  // area prefilter: 3 x 3 box over the cell
  float Lc = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) Lc += lum(texture(uCam, uv + (vec2(float(i), float(j)) - 1.5) * 0.25 / g).rgb);
  Lc /= 16.0;
  // wide test (3 x 3 cells, live vs record): sensor noise cannot trip it, a moving edge does
  float wl = 0.0, wp = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    wl += lum(texture(uCam, uv + vec2(float(i), float(j)) / g).rgb);
    wp += texelFetch(uSelf, clamp(c + ivec2(i, j), ivec2(0), G - 1), 0).b;
  }
  float wd = abs(wl - wp) / 9.0;
  vec4 prev = texelFetch(uSelf, c, 0);
  // b: a short EMA of the cell (0.15 s; a real change releases it at once), g: the held value, which
  // follows the EMA only once it has moved clear of the dead band
  float dt = uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0;
  float e = prev.a > 0.5 ? mix(prev.b, Lc, max(1.0 - exp(-dt / 0.15), max(smoothstep(0.025, 0.06, wd), smoothstep(0.12, 0.2, abs(Lc - prev.b))))) : Lc;
  float d = e - prev.g;
  float Lh = prev.a > 0.5 ? (abs(d) > 0.022 ? e : prev.g) : Lc;      // hard hold: an exact repeat in, an exact repeat out

  // auto levels: 0 = the subject's dark cluster, 1 = its bright cluster
  vec4 lv = texture(uBuf_lv, vec2(0.5));
  float rng = max(lv.y - lv.x, 0.12);
  float x = (Lh - lv.x) / rng;

  float hold = 0.0, pm = 1.0;
  if (uPersonReady > 0.5) pm = smoothstep(0.35, 0.65, texture(uPerson, uv).r);
  if (u_hold > 0.0 && uPersonReady > 0.5) {
    hold = pm * u_hold;
    if (hold > 0.0) {
      // local mean over ~14 cells (held lumas): the person is re-exposed around their own local level
      float m = 0.0;
      for (int i = 0; i < 12; i++) {
        float a = float(i) * 2.399963; float r = 14.0 * sqrt((float(i) + 0.5) / 12.0);
        m += texelFetch(uSelf, clamp(c + ivec2(vec2(cos(a), sin(a)) * r), ivec2(0), G - 1), 0).g;
      }
      m = (m / 12.0 - lv.x) / rng;
      // pull the local mean toward the dither's mid-grey, keep the detail around it at 1.6x
      x = mix(x, mix(m, 0.72, 0.45) + (x - m) * 1.6, hold);
    }
  }

  // transfer: dark cluster -> solid ink, bright cluster -> near paper, a linear ramp raised to 1.64 (measured)
  x -= 0.10 * (1.0 - pm) * u_hold * 2.0;                  // the room prints a step denser: skin stands off a pale wall
  float lin = (x > 1.0 ? 0.74 + 0.20 * (1.0 - exp(-(x - 1.0) * 2.0)) : 0.06 + 0.68 * x) + u_level;
  float v = pow(clamp((lin - 0.5) * u_contrast / 1.6 + 0.5, 0.0, 1.0), 1.64);
  // input grain: fixed to the sheet by default; Boil re-seeds a share of it at the source rate (30 Hz)
  float seed = floor(uTime * 30.0);
  float ns = h21(vec2(c) * 1.0 + 3.7) + h21(vec2(c) + 71.3) - 1.0;
  float nd = h21(vec2(c) + seed * vec2(17.13, 31.71)) + h21(vec2(c) + seed * vec2(5.37, 11.9) + 71.3) - 1.0;
  float n = u_boil > 0.0 ? (ns * (1.0 - u_boil) + nd * u_boil) / sqrt((1.0 - u_boil) * (1.0 - u_boil) + u_boil * u_boil) : ns;
  v += n * 2.45 * u_grain * (1.0 - 0.6 * hold);
  fragColor = vec4(clamp(v, -0.5, 1.5), Lh, e, 1.0);
}`;

// pass 2: tiled exact error diffusion
const ED = COMMON + /* glsl */ `
const int T = 16;      // tile
const int M = 4;       // warm-up margin
const int W = T + 2 * M;
void main(){
  ivec2 G = gridSize(); ivec2 c = ivec2(gl_FragCoord.xy);
  if (c.x >= G.x || c.y >= G.y) { fragColor = vec4(0.0); return; }
  int cx = c.x, cy = G.y - 1 - c.y;                       // row counted from the top: scan order of the reference
  int tr = cy / T;
  int off = (tr % 2 == 1) ? T / 2 : 0;
  int x0 = ((cx + off) / T) * T - off - M;
  int y0 = tr * T - M;

  // kernel rows (dx = -2..+2), row 0 only uses dx = +1, +2
  float a1, a2; float w1[5]; float w2[5];
  int kern = int(u_kernel + 0.5);
  if (kern == 0) {        // Jarvis–Judice–Ninke /48
    a1 = 7.0/48.0; a2 = 5.0/48.0;
    w1[0] = 3.0/48.0; w1[1] = 5.0/48.0; w1[2] = 7.0/48.0; w1[3] = 5.0/48.0; w1[4] = 3.0/48.0;
    w2[0] = 1.0/48.0; w2[1] = 3.0/48.0; w2[2] = 5.0/48.0; w2[3] = 3.0/48.0; w2[4] = 1.0/48.0;
  } else if (kern == 1) { // Atkinson /8 (loses 1/4 of the error: harder, more open)
    a1 = 0.125; a2 = 0.125;
    w1[0] = 0.0; w1[1] = 0.125; w1[2] = 0.125; w1[3] = 0.125; w1[4] = 0.0;
    w2[0] = 0.0; w2[1] = 0.0; w2[2] = 0.125; w2[3] = 0.0; w2[4] = 0.0;
  } else {                // Floyd–Steinberg /16
    a1 = 7.0/16.0; a2 = 0.0;
    w1[0] = 0.0; w1[1] = 3.0/16.0; w1[2] = 5.0/16.0; w1[3] = 1.0/16.0; w1[4] = 0.0;
    w2[0] = 0.0; w2[1] = 0.0; w2[2] = 0.0; w2[3] = 0.0; w2[4] = 0.0;
  }

  float e0[W + 4]; float e1[W + 4]; float e2[W + 4];
  for (int i = 0; i < W + 4; i++) { e0[i] = 0.0; e1[i] = 0.0; e2[i] = 0.0; }
  float res = 0.0;
  float stick = texelFetch(uSelf, ivec2(0), 0).a > 0.5 ? 0.45 * (1.0 - u_boil) : 0.0;
  int tx = cx - x0;
  for (int r = y0; r <= cy; r++) {
    int ry = G.y - 1 - clamp(r, 0, G.y - 1);
    int last = (r == cy) ? tx : W - 1;
    for (int x = 0; x <= last; x++) {
      ivec2 q = ivec2(clamp(x0 + x, 0, G.x - 1), ry);
      float v = texelFetch(uBuf_tone, q, 0).r + e0[x + 2];
      // hysteresis: the threshold leans toward what this cell printed last frame, so a small change in the
      // input moves a few dots instead of re-flowing the whole tile. Mean tone is kept (the error still diffuses).
      float o = step(0.5 - stick * (texelFetch(uSelf, q, 0).r - 0.5), v);
      float er = clamp(v - o, -1.0, 1.0);
      e0[x + 3] += er * a1; e0[x + 4] += er * a2;
      e1[x] += er * w1[0]; e1[x + 1] += er * w1[1]; e1[x + 2] += er * w1[2]; e1[x + 3] += er * w1[3]; e1[x + 4] += er * w1[4];
      e2[x] += er * w2[0]; e2[x + 1] += er * w2[1]; e2[x + 2] += er * w2[2]; e2[x + 3] += er * w2[3]; e2[x + 4] += er * w2[4];
      res = o;
    }
    for (int i = 0; i < W + 4; i++) { e0[i] = e1[i]; e1[i] = e2[i]; e2[i] = 0.0; }
  }
  fragColor = vec4(res, res, res, 1.0);
}`;

const OUT = COMMON + /* glsl */ `
float cellAt(ivec2 c, ivec2 G){ return texelFetch(uBuf_ed, clamp(c, ivec2(0), G - 1), 0).r; }
void main(){
  ivec2 G = gridSize(); vec2 g = vec2(G);
  // hard cells with a one-pixel anti-aliased edge (cells are 2.54 px: plain nearest would beat)
  vec2 p = vUv * g - 0.5;
  vec2 i = floor(p), f = p - i;
  vec2 pxc = g / uRes;                                    // cells per output pixel
  f = clamp((f - 0.5) / max(pxc, vec2(1e-4)) + 0.5, 0.0, 1.0);
  ivec2 b = ivec2(i);
  float v = mix(mix(cellAt(b, G), cellAt(b + ivec2(1, 0), G), f.x), mix(cellAt(b + ivec2(0, 1), G), cellAt(b + ivec2(1, 1), G), f.x), f.y);
  fragColor = vec4(mix(u_ink, u_paper, v), 1.0);
}`;

export default {
  id: 'grain-dither',
  name: 'Grain Dither',
  ref: { clip: 'DecGDxGue_s', t: [7.3, 8.6] },
  needs: ['person'],
  params: [
    { id: 'cell', label: 'Cell', type: 'float', min: 2, max: 10, default: 2.54 },
    { id: 'level', label: 'Exposure', type: 'float', min: -0.4, max: 0.4, default: 0 },
    { id: 'contrast', label: 'Contrast', type: 'float', min: 0.5, max: 4, default: 1.6 },
    { id: 'grain', label: 'Grain', type: 'float', min: 0, max: 0.4, default: 0.11 },
    { id: 'hold', label: 'Hold face', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'boil', label: 'Boil', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'kernel', label: 'Kernel', type: 'enum', options: ['Jarvis', 'Atkinson', 'Floyd'], default: 1, more: true },
    { id: 'ink', label: 'Ink', type: 'color', default: '#000000', more: true },
    { id: 'paper', label: 'Paper', type: 'color', default: '#ffffff', more: true },
  ],
  passes: [
    { name: 'lv', frag: LV, size: [1, 1], feedback: true, filter: 'nearest' },
    { name: 'tone', frag: TONE, scale: 0.5, filter: 'nearest', feedback: true },
    { name: 'ed', frag: ED, scale: 0.5, filter: 'nearest', feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
};
