// tv-scan — the blue "TV scan" face of DX68QiKuX5Z (wxll.hx: "tv scan, invisibility, and thermal camera").
// Measured (breakdowns/tv-scan.md): only the PERSON is drawn, as a cyan point raster on near-black navy (#020c1b):
// rows ~3.6 px apart at 1080 wide, beaded into dots along each row, rows pushed about by a wave field so they
// read as chevrons / moire; brightness = person matte x camera luma, summed additively so skin saturates to a flat
// #00eefb core while hair and clothes stay as visible rows (#0059b2 troughs, #1b9df5 crests). The silhouette breaks
// up into loose particles, and the empty room is a field of ~1.5 px grey-blue specks (about 1 per 12x12 px) that
// re-randomise every frame. No scan bar and no horizontal scanline grid in the reference.
// Second pass: the look is a POINT CLOUD, not a shaded surface. It is still fragment-only: every pixel gathers
// the 15 points (5 rows x 3 cells) whose home cell can reach it, since points never travel more than ~2 pitches.
// Tone decides how many points survive and how big they are; each row has its own random wave phase (the first
// version shared one phase field across rows, and row pitch x wave period beat into a regular diagonal hatch).
//
// Exports so other modules (prism) can put the look on a surface:
//   TV_PASSES            prepasses (tv_drv -> tv_bh -> tv_tb, half res)
//   tvGlsl(opts)         GLSL chunk defining `vec3 tvScan(vec2 uv)`; opts = GLSL expressions for the knobs

const LUM = /* glsl */`
float tvLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const DRV = LUM + /* glsl */`
void main() {
  vec2 px = 0.5 / uCamRes;
  vec3 c = 0.25 * (texture(uCam, vUv + px * vec2(-1.0, -1.0)).rgb + texture(uCam, vUv + px * vec2(1.0, -1.0)).rgb
                 + texture(uCam, vUv + px * vec2(-1.0, 1.0)).rgb + texture(uCam, vUv + px * vec2(1.0, 1.0)).rgb);
  float m = uPersonReady > 0.5 ? texture(uPerson, vUv).r : 1.0;
  float d = uDepthReady > 0.5 ? texture(uDepth, vUv).r : 0.5;
  fragColor = vec4(tvLum(c), m, d, tvLum(c) * m);   // a = matte-weighted luma, so the wall cannot leak into the rim
}`;

// separable gaussian, sigma in px at 1080 wide
export const tvBlur = (src, dir, sigma) => /* glsl */`
void main() {
  float sig = ${sigma} * uRes.x / 1080.0; vec2 st = ${dir} / uRes * sig * 0.6;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -4; i <= 4; i++) { float x = float(i) * 0.6; float w = exp(-0.5 * x * x); acc += texture(${src}, vUv + st * float(i)) * w; ws += w; }
  fragColor = acc / ws;
}`;

export const TV_PASSES = [
  { name: 'tv_drv', scale: 0.5, frag: DRV },
  { name: 'tv_bh', scale: 0.5, frag: tvBlur('uBuf_tv_drv', 'vec2(1.0, 0.0)', '2.6') },
  { name: 'tv_tb', scale: 0.5, frag: tvBlur('uBuf_tv_bh', 'vec2(0.0, 1.0)', '2.6') },
  // wide matte (sigma ~14 px) for the particle halo the silhouette dissolves into
  { name: 'tv_wh', scale: 0.125, frag: tvBlur('uBuf_tv_tb', 'vec2(1.0, 0.0)', '14.0') },
  { name: 'tv_w', scale: 0.125, frag: tvBlur('uBuf_tv_wh', 'vec2(0.0, 1.0)', '14.0') },
];

export const tvGlsl = (o = {}) => {
  const k = { pitch: '3.6', relief: '0.5', wave: '0.6', sparkle: '0.5', room: '0.1', sweep: '0.0', src: '0.0', glow: '0.6', ...o };
  return /* glsl */`
float tvH(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float tvN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tvH(i), tvH(i + vec2(1.0, 0.0)), f.x), mix(tvH(i + vec2(0.0, 1.0)), tvH(i + vec2(1.0, 1.0)), f.x), f.y); }
// measured ramp: navy ground -> row troughs -> row crests -> flat cyan core
vec3 tvRamp(float i) {
  vec3 c = mix(vec3(0.004, 0.039, 0.094), vec3(0.0, 0.2, 0.52), smoothstep(0.0, 0.22, i));
  c = mix(c, vec3(0.0, 0.35, 0.70), smoothstep(0.18, 0.42, i));
  c = mix(c, vec3(0.08, 0.60, 0.95), smoothstep(0.4, 0.7, i));
  return mix(c, vec3(0.013, 0.90, 0.984), smoothstep(0.66, 1.0, i));
}
// what the cloud is made of at uv: x = tone (0 empty room .. 1 lit skin), y = soft person matte
// Third pass: tone is half absolute level, half LOCAL contrast against the wide blur, so a face in a bright room
// keeps its eyes / brows / jaw as holes in the core instead of flooding to one flat cyan shape.
vec2 tvVal(vec2 uv) {
  vec4 d = texture(uBuf_tv_tb, uv), w = texture(uBuf_tv_w, uv);
  float m = smoothstep(0.3, 0.7, d.g);
  float lf = d.a / max(d.g, 0.05), lw = w.a / max(w.g, 0.05);
  float l = clamp(0.78 * smoothstep(0.05, 0.85, mix(lf, lw, 0.3)) + 1.7 * (lf - lw) + 0.08, 0.0, 1.0);
  return vec2(mix(${k.room} * 0.5 * smoothstep(0.02, 0.5, d.r), 0.5 + 0.5 * l, m), m);
}
vec3 tvScan(vec2 uv) {
  float S = 1080.0 / uRes.x; vec2 R = uRes * S, P = uv * R;      // reference pixels, 1080 wide
  float pitch = ${k.pitch}, tt = uTime, cw = pitch * 0.85;
  vec2 v0 = tvVal(uv);
  vec4 d0 = texture(uBuf_tv_tb, uv), w0 = texture(uBuf_tv_w, uv);
  float mw = w0.g;                                                 // wide matte: where the silhouette sheds points
  float j0 = floor(P.y / pitch), k0 = floor(P.x / cw), I = 0.0, rip = 0.0;
  // gather: the cloud is a grid of points (rows pitch apart, one point per cw along the row). Rows only move
  // about a pitch, so a pixel can only be lit by points whose home is within 2 rows and 1 cell of it.
  // Points keep their identity from frame to frame (no per-frame reseed): what moves is the wave field, which
  // travels along the rows, plus a slow per-point shimmer. Sensor noise can only nudge a point across its
  // survival threshold through a soft edge, so a still subject gives a still cloud.
  for (int q = -2; q <= 2; q++) {
    float j = j0 + float(q), yb = (j + 0.5) * pitch;
    // wave phase drifts SMOOTHLY from row to row (chevrons a few rows tall, as in the reel) with a small
    // per-row kick; a fully shared phase beats into a regular hatch, a fully random one loses the chevrons
    float ph = tvN(vec2(j * 0.21, tt * 0.25)) * 2.4 + tvH(vec2(j, 3.0)) * 0.16 - tt * 0.55;
    for (int r = -1; r <= 1; r++) {
      float kx = k0 + float(r);
      vec2 hc = vec2(kx, j), home = vec2((kx + 0.5) * cw, yb), huv = home / R;
      vec4 d = texture(uBuf_tv_tb, huv); float wg = texture(uBuf_tv_w, huv).g;
      vec2 vm = tvVal(huv);
      float h1 = tvH(hc), h2 = tvH(hc.yx + 19.1), h3 = tvH(hc + 41.3);
      float zf = fract(home.x / 14.0 + ph + 0.5 * tvN(vec2(home.x / 60.0, j * 0.07 + tt * 0.2)));
      float zig = abs(zf - 0.5) * 4.0 - 1.0;
      float swell = tvN(vec2(home.x / 46.0 + tt * 0.5, yb / 46.0 - tt * 0.3)) - 0.5;
      float lift = 1.6 * ${k.relief} * mix(d.r, d.b, ${k.src}) * vm.y;
      float me = mix(d.g, wg, 0.55), ms = smoothstep(0.03, 0.3, me);
      // points near the silhouette come loose: their jitter grows as the matte thins
      float loose = (1.0 - vm.y) * smoothstep(0.03, 0.4, wg);
      vec2 pos = home + vec2((h2 - 0.5) * cw * (0.4 + 2.0 * loose), pitch * (lift + ${k.wave} * (1.0 * zig + 1.3 * swell) * (0.3 + 0.7 * max(vm.y, ms))) + (h3 - 0.5) * pitch * (0.35 + 2.5 * loose));
      // tone drives how many points survive, not how bright a surface is
      // the silhouette is dithered away through the wide matte instead of ending on an outline
      float tone = max(vm.x, 0.9 * ms * (1.0 - vm.y));
      float dens = min(1.3 * tone, 1.0) * ms + ${k.room} * vm.x * (1.0 - ms);
      float on = smoothstep(h1 - 0.07, h1 + 0.07, dens) * smoothstep(-0.05, 0.05, ms + d.g - 0.7 * tvH(hc + 3.3));
      float shim = 0.82 + 0.18 * sin(tt * (2.0 + 3.0 * h3) + h2 * 6.283);
      vec2 dq = (P - pos) * vec2(0.5, 1.0); float rr = dot(dq, dq), sz = mix(0.95, 1.25, h2) * mix(1.0, 1.7, smoothstep(0.45, 0.95, vm.x));
      // crests of the wave are brighter than its troughs: that is what makes the fronts read as chevrons
      I += on * exp(-rr / (sz * sz)) * mix(0.55, 1.0, tvH(hc + 7.7)) * shim * (0.72 + 0.4 * ${k.wave} * zig) * (1.0 - 0.4 * loose);
    }
    float zp = abs(fract(P.x / 14.0 + ph) - 0.5) * 4.0 - 1.0, dyr = (P.y - yb) / pitch - ${k.wave} * 0.9 * zp; rip += exp(-dyr * dyr * 3.2);
  }
  // lit skin floods towards the cyan core, softly: the core fades into the beads over the blurred tone instead of
  // ending on an edge, and the wave fronts stay visible inside it. A blue haze (the glow of the beads) sits under
  // the sparser parts.
  float mE = mix(d0.g, mw, 0.55), g = ${k.glow};
  float tw = 0.5 + 0.5 * smoothstep(0.05, 0.85, w0.a / max(w0.g, 0.05));
  float core = smoothstep(0.5, 1.0, mix(v0.x, tw, 0.42)) * smoothstep(0.25, 0.9, mE);
  float haze = (0.10 + 0.14 * g + (0.10 + 0.14 * g) * smoothstep(0.3, 0.85, v0.x)) * smoothstep(0.1, 0.75, mE);
  float inten = haze + 0.74 * I * (1.0 - 0.45 * core) + core * (0.26 + 0.16 * min(I, 1.3) + 0.14 * (rip - 0.9));

  // optional vertical sweep (beyond): a bright refresh bar with a phosphor tail behind it. The tail has decayed
  // by the time the bar comes round again, and the bar has a soft leading edge, so there is no step at the wrap.
  float sw = ${k.sweep};
  if (sw > 0.0) {
    float bar = fract(uTime / 2.4), dist = fract(bar - (1.0 - uv.y)), ahead = 1.0 - dist;   // dist: 0 at the bar, grows behind it
    float lead = exp(-ahead * 55.0);
    inten *= 1.0 + sw * (1.1 * (exp(-dist * 26.0) + lead) - 0.45 * smoothstep(0.0, 0.9, dist) * (1.0 - lead));
    inten += sw * 0.1 * (exp(-dist * 120.0) + exp(-ahead * 160.0));
  }
  vec3 col = tvRamp(clamp(inten, 0.0, 1.0));
  // glow: the wide halo the figure throws on the dark, from the eighth-res blur of matte x luma
  float hal = smoothstep(0.0, 0.38, mw) * (0.35 + 0.65 * smoothstep(0.1, 0.6, w0.a / max(w0.g, 0.05)));
  col += g * vec3(0.0, 0.2, 0.56) * hal * (1.0 - 0.75 * smoothstep(0.25, 0.8, inten));

  // loose particles: the cloud shed round the silhouette + the star field in the empty room. Each has its own
  // short life (fades in and out on its own clock) instead of the whole field being re-rolled every frame.
  float sp = ${k.sparkle};
  if (sp > 0.0) {
    float fr = smoothstep(0.03, 0.45, mw) * (1.0 - smoothstep(0.35, 0.8, v0.y));
    for (int s = 0; s < 3; s++) {
      float cs = s == 0 ? 2.6 : (s == 1 ? 3.7 : 5.2); vec2 pc = P / cs + float(s) * 17.3, ci = floor(pc);
      float clk = tt * (s == 0 ? 7.0 : 4.5) + tvH(ci + 2.2) * 9.0, life = floor(clk), ph = fract(clk);
      float h1 = tvH(ci + life * 1.37 + float(s) * 5.1), h2 = tvH(ci.yx + life * 0.73 + 2.9);
      vec2 off = (vec2(h2, tvH(ci + 11.7 + life)) - 0.5) * 0.6;
      float prob = sp * (0.095 + 0.9 * fr * fr + 0.25 * fr);
      float env = smoothstep(0.0, 0.3, ph) * smoothstep(1.0, 0.6, ph);
      float rad = s == 2 ? 0.3 : 0.4;
      float dotm = smoothstep(rad, 0.08, length(fract(pc) - 0.5 - off)) * step(h1, prob) * env;
      vec3 pcol = mix(vec3(0.40, 0.52, 0.62) * (0.4 + 0.8 * h2), vec3(0.2, 0.72, 1.0) * (0.6 + 0.4 * h2), clamp(fr * 2.0, 0.0, 1.0));
      col = max(col, pcol * dotm);
    }
  }
  return col;
}`;
};


export default {
  id: 'tv-scan',
  name: 'TV Scan',
  ref: { clip: 'DX68QiKuX5Z', t: [1.6, 2.6], crop: [6, 20, 1074, 604] },
  needs: ['person', 'depth'],
  params: [
    { id: 'pitch', label: 'Row Pitch', type: 'float', min: 2.4, max: 9, default: 3.6 },
    { id: 'relief', label: 'Relief', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'wave', label: 'Wave', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'sparkle', label: 'Particles', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'src', label: 'Relief From', type: 'enum', options: ['Luma', 'Depth'], default: 0 },
    { id: 'sweep', label: 'Sweep', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'room', label: 'Room', type: 'float', min: 0, max: 1, default: 0.1, more: true },
    { id: 'glow', label: 'Glow', type: 'float', min: 0, max: 1, default: 0.6, more: true },
  ],
  passes: [
    ...TV_PASSES,
    { name: 'out', screen: true, frag: tvGlsl({ pitch: 'u_pitch', relief: 'u_relief', wave: 'u_wave', sparkle: 'u_sparkle', room: 'u_room', sweep: 'u_sweep', src: 'u_src', glow: 'u_glow' }) + /* glsl */`
void main() {
  vec3 col = tvScan(vUv);
  col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}` },
  ],
};
