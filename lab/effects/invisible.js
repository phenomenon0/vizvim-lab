// invisible — the invisibility face of DX68QiKuX5Z (wxll.hx) as a standalone effect.
// Reference (breakdowns/invisible.md): where the person is, the empty room is shown (a clean plate), and what is
// left of the person is a line-art ghost: thin strokes of the live camera along its strongest edges (jaw, collar,
// glasses, hair fragments). No refraction in the reference.
//
// The clean plate is acquired live, no setup step:
//   inv_m      quarter res  person matte, dilated ~16 px (so matte misses never get learned) + plain
//   inv_plate  half res, feedback  rgb = room, a = "seen" flag. A pixel is learned whenever the dilated matte is
//              clear there: first sight is taken at once, later it follows the camera with a 0.4 s time constant
//              (lighting drift). Stepping out of frame for a moment therefore IS the "capture room" moment.
//              Plate = Hold freezes it, Plate = Capture copies the whole camera frame (step out, tap, step in).
//   inv_p1..3  pull pyramid (1/8, 1/32, 1/128) of the seen pixels: the fill for places never seen yet
//   inv_wh/w   wide blur of the matte, for the refraction field of the Shimmer extra
// Honest limit: behind a person who has not moved there is nothing to show; the fill is a smooth guess from the
// surroundings, right on a plain wall and visibly wrong on a busy room until the person has moved away once.
//
// Exports: INV_PASSES and invGlsl(opts) -> `vec3 invLook(vec2 uv)` for other modules (prism).

const M = /* glsl */`
void main() {
  // R = matte dilated ~16 px (learning guard: matte misses never get learned), G = plain matte,
  // B = matte dilated ~5 px (display: covers the skin/hair fringe the segmenter leaves outside its edge)
  // person matte united with the landmark hand silhouette: the segmenter drops fingers and thumbs
  #define PM(uv) max(texture(uPerson, uv).r, texture(uHandMask, uv).r)
  float m0 = uPersonReady > 0.5 ? PM(vUv) : 1.0, mx = m0, ms = m0;
  if (uPersonReady > 0.5) {
    vec2 r = vec2(uRes.y / uRes.x, 1.0) * (8.0 / 604.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854; vec2 d = vec2(cos(a), sin(a)) * r;
      mx = max(mx, max(PM(vUv + d), PM(vUv + d * 2.0)));
      ms = max(ms, PM(vUv + d * 0.6));
    }
  }
  fragColor = vec4(mx, m0, ms, 1.0);
}`;

// The fill for places never seen: push-pull. Each level is premultiplied (rgb * coverage, coverage), so a bilinear
// read near a hole's rim returns the colour of the seen pixels next to it; coarser levels only take over deeper in.
// Returns rgb + "deep": 0 near seen pixels, 1 far inside a hole.
const FILL = /* glsl */`
float invLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 invFill(vec2 uv, vec3 cam) {
  vec4 c1 = texture(uBuf_inv_p1, uv), c2 = texture(uBuf_inv_p2, uv), c3 = texture(uBuf_inv_p3, uv), c4 = texture(uBuf_inv_p4, uv);
  vec3 f4 = c4.a > 0.004 ? c4.rgb / c4.a : cam;
  vec3 f3 = mix(f4, c3.rgb / max(c3.a, 1e-3), smoothstep(0.02, 0.5, c3.a));
  vec3 f2 = mix(f3, c2.rgb / max(c2.a, 1e-3), smoothstep(0.02, 0.5, c2.a));
  vec3 f1 = mix(f2, c1.rgb / max(c1.a, 1e-3), smoothstep(0.05, 0.6, c1.a));
  float deep = 1.0 - smoothstep(0.02, 0.5, c2.a);            // far from anything seen: the guess is weakest here
  return vec4(f1, deep);
}`;

// inv_plate: rgb = the room. a > 0: seen, ramping 0 -> 1 over 0.35 s from first sight (the learning dissolve).
// a <= 0: never seen; rgb is then the push-pull guess (temporally smoothed) and -a is how deep in the hole it is.
const plate = (mode) => FILL + /* glsl */`
void main() {
  vec4 prev = texture(uSelf, vUv); vec3 cam = texture(uCam, vUv).rgb;
  float mode = ${mode};
  if (mode > 1.5) { fragColor = vec4(cam, 1.0); return; }               // Capture: the whole frame is the room
  if (uFrame < 2) { fragColor = vec4(cam, 0.0); return; }
  if (mode > 0.5 || uPersonReady < 0.5) { fragColor = prev; return; }   // Hold, or no matte yet: learn nothing
  float dt = clamp(uDt, 1.0 / 120.0, 0.1);
  // soften the dilated matte a little so the learning boundary does not leave a hard seam
  vec2 px = 1.0 / uPassRes; float m = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) m = max(m, texture(uBuf_inv_m, vUv + vec2(float(i), float(j)) * px * 3.0).r);
  float clear = 1.0 - smoothstep(0.03, 0.2, m);
  if (prev.a <= 0.0) {
    if (clear > 0.5) { fragColor = vec4(cam, dt / 0.35); return; }      // first sight
    vec4 f = invFill(vUv, cam);
    fragColor = vec4(mix(prev.rgb, f.rgb, uFrame < 4 ? 1.0 : 0.25), -mix(-prev.a, f.a, uFrame < 4 ? 1.0 : 0.15));
    return;
  }
  // A pixel must stay clear for the whole 0.35 s ramp to be kept: a matte miss that flickers (a sleeve the
  // segmenter drops for a few frames) is forgotten again instead of becoming "room".
  if (prev.a < 1.0 && clear < 0.5) {
    vec4 f = invFill(vUv, cam); fragColor = vec4(f.rgb, -f.a); return;
  }
  // Near the person, anything that disagrees with the plate is learned ten times slower: a cast shadow arriving
  // (darker, same chroma) and matte misses stay out of the plate; away from the person the plate follows the
  // light at the normal rate.
  float lp = invLum(prev.rgb), lc = invLum(cam), drop = 1.0 - lc / max(lp, 0.02);
  float same = 1.0 - smoothstep(0.10, 0.25, length(prev.rgb / max(lp, 0.02) - cam / max(lc, 0.02)));
  float halo = smoothstep(0.004, 0.04, texture(uBuf_inv_w, vUv).r);
  float shadow = same * smoothstep(0.03, 0.10, drop) * (1.0 - smoothstep(0.55, 0.7, drop));
  float odd = halo * max(shadow, smoothstep(0.08, 0.20, length(cam - prev.rgb))) * step(1.0, prev.a);
  float rate = 1.0 - exp(-dt / mix(0.4, 4.0, odd));
  fragColor = vec4(mix(prev.rgb, cam, clear * rate), min(1.0, prev.a + dt / 0.35));
}`;

// pull: average of the seen pixels of the finer level, premultiplied (rgb * coverage, coverage)
const pull = (src, first) => /* glsl */`
void main() {
  vec2 px = 1.0 / vec2(textureSize(${src}, 0)); vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec4 s = texture(${src}, vUv + (vec2(float(i), float(j)) - 1.5) * px);
    ${first ? 'float a = step(0.25, s.a); acc += vec4(s.rgb * a, a);' : 'acc += s;'}
  }
  acc /= 16.0;
  ${first ? '' : 'float c = clamp(acc.a * 4.0, 0.0, 1.0); acc = acc.a > 0.002 ? vec4(acc.rgb / acc.a * c, c) : vec4(0.0);'}
  fragColor = acc;
}`;

// inv_b (1x1): R = how cluttered the seen room is = mean distance of its 1/32 blocks from the frame average.
// ~0 on a plain wall, ~1 in a furnished room. Decides whether a deep guess may be shown as fact.
const BUSY = /* glsl */`
void main() {
  vec4 c4 = texture(uBuf_inv_p4, vec2(0.5)); vec3 mean = c4.rgb / max(c4.a, 1e-3);
  float acc = 0.0, ws = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    vec4 c = texture(uBuf_inv_p2, (vec2(float(i), float(j)) + 0.5) / 8.0);
    float w = step(0.5, c.a); acc += length(c.rgb / max(c.a, 1e-3) - mean) * w; ws += w;
  }
  float b = ws > 4.0 ? smoothstep(0.16, 0.30, acc / ws) : 0.0;
  vec4 prev = texture(uSelf, vec2(0.5));
  // G: 0 -> 1 over 0.15 s from the moment the person matte exists, so the cloak fades in instead of popping on
  float on = uFrame < 2 ? 0.0 : clamp(prev.g + (uPersonReady > 0.5 ? clamp(uDt, 1.0 / 120.0, 0.1) / 0.15 : 0.0), 0.0, 1.0);
  fragColor = vec4(uFrame < 4 ? b : mix(prev.r, b, 0.1), on, 0.0, 1.0);
}`;

const wide = (src, dir, ch) => /* glsl */`
void main() {
  vec2 st = ${dir} / uPassRes * 1.5; float acc = 0.0, ws = 0.0;
  for (int i = -6; i <= 6; i++) { float w = exp(-float(i * i) / 18.0); acc += texture(${src}, vUv + st * float(i)).${ch} * w; ws += w; }
  fragColor = vec4(acc / ws, 0.0, 0.0, 1.0);
}`;

export const invPasses = (mode = '0.0') => [
  { name: 'inv_m', scale: 0.25, frag: M, filter: 'linear' },
  { name: 'inv_plate', scale: 0.5, feedback: true, frag: plate(mode) },
  { name: 'inv_p1', scale: 0.125, frag: pull('uBuf_inv_plate', true) },
  { name: 'inv_p2', scale: 0.03125, frag: pull('uBuf_inv_p1', false) },
  { name: 'inv_p3', scale: 0.0078125, frag: pull('uBuf_inv_p2', false) },
  { name: 'inv_p4', size: [2, 2], frag: pull('uBuf_inv_p3', false) },
  { name: 'inv_b', size: [1, 1], feedback: true, frag: BUSY },
  { name: 'inv_wh', scale: 0.125, frag: wide('uBuf_inv_m', 'vec2(1.0, 0.0)', 'g') },
  { name: 'inv_w', scale: 0.125, frag: wide('uBuf_inv_wh', 'vec2(0.0, 1.0)', 'r') },
];
export const INV_PASSES = invPasses();

export const invGlsl = (o = {}) => {
  const k = { cloak: '1.0', ghost: '0.5', rim: '0.2', shimmer: '0.0', by: '0.0', ...o };
  return /* glsl */`
float invLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// the room at uv: rgb = learned plate where seen, push-pull guess elsewhere. a = how much of it is real (0..1)
vec4 invRoom(vec2 uv) {
  vec4 pl = texture(uBuf_inv_plate, uv);
  return vec4(pl.rgb, smoothstep(0.05, 0.95, pl.a));
}
vec3 invLook(vec2 uv) {
  vec3 cam = texture(uCam, uv).rgb;
  if (uPersonReady < 0.5) return cam;
  vec4 mm = texture(uBuf_inv_m, uv);
  float amt = ${k.cloak};
  if (${k.by} > 0.5 && uDepthReady > 0.5) {                       // near things go first
    float th = 1.0 - 1.25 * ${k.cloak}; amt = smoothstep(th - 0.06, th + 0.06, texture(uDepth, uv).r) * step(0.001, ${k.cloak});
  }
  amt *= smoothstep(0.0, 1.0, texture(uBuf_inv_b, vec2(0.5)).g);  // the cloak fades in, it does not pop on
  // Shimmer (beyond): the Predator recipe. Concentric rings of the matte, each showing the room pulled a step
  // further toward the body's inside, plus a slow ripple; R and B split slightly.
  vec2 off = vec2(0.0); float sh = ${k.shimmer};
  float d0 = texture(uBuf_inv_w, uv).r;
  if (sh > 0.0) {
    vec2 e = vec2(6.0) / uRes;
    vec2 g = vec2(texture(uBuf_inv_w, uv + vec2(e.x, 0.0)).r - texture(uBuf_inv_w, uv - vec2(e.x, 0.0)).r,
                  texture(uBuf_inv_w, uv + vec2(0.0, e.y)).r - texture(uBuf_inv_w, uv - vec2(0.0, e.y)).r);
    float gl = length(g); vec2 n = gl > 1e-4 ? g / gl : vec2(0.0);
    float ring = floor(d0 * 6.0 + 0.5 * sin(uTime * 1.7)) / 6.0;
    float rip = sin(d0 * 46.0 - uTime * 5.0) * 0.5 + 0.5;
    off = n * vec2(uRes.y / uRes.x, 1.0) * sh * (0.035 * ring + 0.008 * rip) * smoothstep(0.0, 0.02, gl);
  }
  vec4 pl = texture(uBuf_inv_plate, uv + off);
  if (sh > 0.0) { pl.r = texture(uBuf_inv_plate, uv + off * 1.25).r; pl.b = texture(uBuf_inv_plate, uv + off * 0.75).b; }
  // learning dissolve: a freshly seen pixel comes in over 0.35 s through a blue-noise threshold (fine sparkle)
  float bn = texture(uNoise, gl_FragCoord.xy / 256.0).r;
  float seen = smoothstep(0.0, 0.3, pl.a - 0.7 * bn * (1.0 - smoothstep(0.9, 1.0, pl.a)));
  float busy = clamp(-pl.a, 0.0, 1.0) * texture(uBuf_inv_b, vec2(0.5)).r;
  vec3 bg = pl.rgb;
  // matte: the 5 px dilation, grown to the 16 px one wherever the camera disagrees with a KNOWN plate (skin fringe,
  // fingers the segmenter misses, the contact shadow), and to the wide halo where the camera is a shadowed copy of
  // the plate (darker, same chroma): the cast shadow goes with the body
  float m = smoothstep(0.25, 0.6, mm.b);
  float known = smoothstep(0.5, 1.0, pl.a);
  float dif = length(cam - pl.rgb);
  m = max(m, smoothstep(0.05, 0.3, mm.r) * smoothstep(0.05, 0.12, dif) * known);
  float lp = invLum(pl.rgb), lc = invLum(cam), drop = 1.0 - lc / max(lp, 0.02);
  float same = 1.0 - smoothstep(0.10, 0.25, length(pl.rgb / max(lp, 0.02) - cam / max(lc, 0.02)));
  float halo = smoothstep(0.004, 0.04, d0);
  m = max(m, known * halo * max(same * smoothstep(0.03, 0.09, drop) * (1.0 - smoothstep(0.55, 0.7, drop)), smoothstep(0.10, 0.22, dif)));
  // where the room behind the body is a guess AND the room is busy, the guess is not shown as fact: the body
  // stays as a pale desaturated ghost over it until those pixels have been seen
  float lcam = invLum(cam);
  vec3 pale = mix(bg, mix(vec3(lcam), cam, 0.25), 0.32);
  bg = mix(bg, pale, busy * (1.0 - seen));
  // ghost: the camera's own strongest edges stay, as thin strokes (the reference's line-art remnant)
  vec2 p = 1.25 / uRes;
  float l00 = invLum(texture(uCam, uv + vec2(-p.x, -p.y)).rgb), l10 = invLum(texture(uCam, uv + vec2(p.x, -p.y)).rgb);
  float l01 = invLum(texture(uCam, uv + vec2(-p.x, p.y)).rgb), l11 = invLum(texture(uCam, uv + vec2(p.x, p.y)).rgb);
  float ed = length(vec2(l10 + l11 - l00 - l01, l01 + l11 - l00 - l10));
  float gk = smoothstep(0.16, 0.42, ed) * min(${k.ghost} * 2.0, 1.0) + smoothstep(0.05, 0.2, ed) * max(${k.ghost} * 2.0 - 1.0, 0.0) * 0.6;
  // strokes carry the camera's tone but only a third of its colour: skin edges no longer draw as pink lines
  vec3 body = mix(bg, mix(vec3(lcam), cam, 0.35), clamp(gk, 0.0, 1.0) * smoothstep(0.3, 0.7, mm.g));
  // rim: a hairline of light on the silhouette
  float mr = texture(uPerson, uv).r, band = clamp(mr * (1.0 - mr) * 4.0, 0.0, 1.0);
  body += vec3(0.85, 0.93, 1.0) * ${k.rim} * 0.5 * band * band;
  return mix(cam, body, m * amt);
}`;
};

export default {
  id: 'invisible',
  name: 'Invisible',
  ref: { clip: 'DX68QiKuX5Z', t: [3.2, 3.5], crop: [6, 20, 1074, 604] },
  needs: ['person', 'depth', 'hands'],
  params: [
    { id: 'cloak', label: 'Cloak', type: 'float', min: 0, max: 1, default: 1 },
    { id: 'ghost', label: 'Ghost', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'rim', label: 'Rim', type: 'float', min: 0, max: 1, default: 0.2 },
    { id: 'shimmer', label: 'Shimmer', type: 'float', min: 0, max: 1, default: 0 },
    { id: 'by', label: 'Cloak By', type: 'enum', options: ['Whole body', 'Near first'], default: 0 },
    { id: 'plate', label: 'Plate', type: 'enum', options: ['Auto', 'Hold', 'Capture'], default: 0 },
  ],
  passes: [
    ...invPasses('u_plate'),
    { name: 'out', screen: true, frag: invGlsl({ cloak: 'u_cloak', ghost: 'u_ghost', rim: 'u_rim', shimmer: 'u_shimmer', by: 'u_by' }) + /* glsl */`
void main() { fragColor = vec4(invLook(vUv), 1.0); }` },
  ],
};
