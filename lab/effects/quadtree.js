// quadtree — adaptive subdivision mosaic (see breakdowns/quadtree.md)
//
// Pass graph (all plain fragment passes over textures):
//   q0            cell statistics at the finest level: mean RGB + mean |rgb|^2 per cell
//   q1..q5        the pyramid: each texel = average of its four children (exact, texelFetch)
//   qs (feedback) one texel per cell per level, packed as an atlas: the split decision with
//                 hysteresis (Schmitt trigger on a temporally smoothed deviation) and a 0..1
//                 animation ramp, so cells neither flicker with sensor noise nor pop
//   out           per pixel, descend from the root level and stop at the first unsplit cell
//
// The grid is defined in OUTPUT pixels (cell k is minCell*2^k px, origin centred on the frame),
// not by buffer sizes, so the levels nest exactly whatever the resolution; the pass buffers
// are only required to be big enough (they are: see breakdown).

const COMMON = /* glsl */ `
// shape styles need room to draw: their finest cell is twice the Blocks one
float minCell() { return max(2.5, u_cell * uRes.y / 720.0) * (u_style > 0.5 ? 1.5 : 1.0); }
float cellPx(int k) { return minCell() * exp2(float(k)); }
vec2 gridOrigin() { float root = minCell() * 32.0; return mod(uRes * 0.5, root) - root; }
ivec2 lvlDim(int k) { return ivec2(ceil((uRes - gridOrigin()) / cellPx(k))); }
// atlas placement of level k (1..5) in the state buffer: level 1 at the origin, 2..5 stacked
// in a column to its right
ivec2 lvlOff(int k) {
  if (k <= 1) return ivec2(0);
  ivec2 o = ivec2(lvlDim(1).x, 0);
  for (int j = 2; j < k; j++) o.y += lvlDim(j).y;
  return o;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const Q0 = COMMON + /* glsl */ `
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  float s = cellPx(0);
  vec2 o = gridOrigin();
  vec3 m = vec3(0.0); float m2 = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 p = o + (vec2(ij) + (vec2(x, y) + 0.5) * 0.25) * s;
    vec3 c = texture(uCam, clamp(p / uRes, 0.0, 1.0)).rgb;
    m += c; m2 += dot(c, c);
  }
  fragColor = vec4(m / 16.0, m2 / 16.0);
}`;

const QUP = (prev) => /* glsl */ `
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy) * 2;
  ivec2 mx = textureSize(uBuf_${prev}, 0) - 1;
  vec4 a = texelFetch(uBuf_${prev}, min(ij, mx), 0)
         + texelFetch(uBuf_${prev}, min(ij + ivec2(1, 0), mx), 0)
         + texelFetch(uBuf_${prev}, min(ij + ivec2(0, 1), mx), 0)
         + texelFetch(uBuf_${prev}, min(ij + ivec2(1, 1), mx), 0);
  fragColor = a * 0.25;
}`;

const QFETCH = /* glsl */ `
vec4 qfetch(int k, ivec2 c) {
  if (k == 0) return texelFetch(uBuf_q0, clamp(c, ivec2(0), textureSize(uBuf_q0, 0) - 1), 0);
  if (k == 1) return texelFetch(uBuf_q1, clamp(c, ivec2(0), textureSize(uBuf_q1, 0) - 1), 0);
  if (k == 2) return texelFetch(uBuf_q2, clamp(c, ivec2(0), textureSize(uBuf_q2, 0) - 1), 0);
  if (k == 3) return texelFetch(uBuf_q3, clamp(c, ivec2(0), textureSize(uBuf_q3, 0) - 1), 0);
  if (k == 4) return texelFetch(uBuf_q4, clamp(c, ivec2(0), textureSize(uBuf_q4, 0) - 1), 0);
  return texelFetch(uBuf_q5, clamp(c, ivec2(0), textureSize(uBuf_q5, 0) - 1), 0);
}`;

// Split state. R = decision (0/1), G = animation ramp 0..1, B = smoothed deviation, A = 1 (initialised)
const QS = COMMON + QFETCH + /* glsl */ `
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int k = 0; ivec2 c = ivec2(0);
  ivec2 d1 = lvlDim(1);
  if (t.x < d1.x) { if (t.y < d1.y) { k = 1; c = t; } }
  else {
    for (int j = 2; j <= 5; j++) {
      ivec2 o = lvlOff(j), d = lvlDim(j);
      if (t.x >= o.x && t.x < o.x + d.x && t.y >= o.y && t.y < o.y + d.y) { k = j; c = t - o; }
    }
  }
  if (t == textureSize(uSelf, 0) - 1) {
    // spare texel: exposure gain. Person-weighted mean of the level-4 cells over a fixed lattice -> gain
    // (at most 1.9x), eased 0.8 s behind a hard dead band so it sits exactly still in a still room.
    float sw = 0.0, sl = 0.0; vec2 o = gridOrigin();
    if (uPersonReady > 0.5) for (int i = 0; i < 32; i++) {
      vec2 u = (vec2(float(i % 8), float(i / 8)) + 0.5) / vec2(8.0, 4.0);
      float w = smoothstep(0.3, 0.7, texture(uPerson, u).r);
      sl += w * luma(qfetch(4, ivec2(floor((u * uRes - o) / cellPx(4)))).rgb); sw += w;
    }
    float tgt = sw > 1.0 ? clamp(0.30 / max(sl / sw, 0.02), 1.0, 1.9) : 1.0;
    vec4 pv = texelFetch(uSelf, t, 0);
    float dg = tgt - pv.r;
    float dtt = uDt > 1e-4 ? clamp(uDt, 1.0/120.0, 1.0/15.0) : 1.0/30.0;
    fragColor = vec4(pv.a > 0.5 ? pv.r + dg * step(0.06, abs(dg)) * (1.0 - exp(-dtt / 0.8)) : tgt, 0.0, 0.0, 1.0);
    return;
  }
  if (k == 0) { fragColor = vec4(0.0); return; }

  vec4 q = qfetch(k, c);
  // RMS per-channel deviation inside the cell (includes all finer detail)
  float dev = sqrt(max(q.a - dot(q.rgb, q.rgb), 0.0) / 3.0);
  // perceptual: the same absolute deviation reads stronger in the dark
  dev /= (0.35 + luma(q.rgb));

  float s = cellPx(k);
  vec2 uv = clamp((gridOrigin() + (vec2(c) + 0.5) * s) / uRes, 0.0, 1.0);
  float thr = mix(0.26, 0.03, pow(u_detail, 0.6)) * (u_style > 0.5 ? 0.7 : 1.0);
  // Focus: the subject resolves finely, the room stays calm. Matte sampled over the cell.
  if (uPersonReady > 0.5) {
    vec2 h = 0.25 * s / uRes;
    float pm = 0.25 * (texture(uPerson, uv + h * vec2(1, 1)).r + texture(uPerson, uv + h * vec2(-1, 1)).r
                     + texture(uPerson, uv + h * vec2(1, -1)).r + texture(uPerson, uv + h * vec2(-1, -1)).r);
    // subject-aware scale: a small figure (little matte coverage) gets its splits cheaper, so a face that is
    // 60 px tall still resolves to the finest cell. Coverage from a fixed 8 x 4 lattice (same for every cell).
    float cov = 0.0;
    for (int i = 0; i < 32; i++) cov += texture(uPerson, (vec2(float(i % 8), float(i / 8)) + 0.5) / vec2(8.0, 4.0)).r;
    float small = 1.0 - smoothstep(0.14, 0.34, cov / 32.0);
    thr *= mix(1.0, mix(1.9, mix(0.6, 0.32, small), smoothstep(0.1, 0.6, pm)), u_focus);
    // inside the subject the last two splits must be earned: flats (cheek, forehead, cloth) keep 2-4x cells,
    // only real features (eyes, mouth, fingers, edges) reach the finest cell
    thr *= 1.0 + smoothstep(0.3, 0.7, pm) * (k == 1 ? 1.1 : (k == 2 ? 0.45 : 0.0)) * (1.0 - 0.85 * small);
  }
  // Beyond: depth-aware. Near things subdivide finer, far things coarser (one octave per unit).
  if (uDepthReady > 0.5) {
    float z = texture(uDepth, uv).r;
    thr *= exp2((0.5 - z) * 2.0 * u_depth);
  }

  vec4 prev = texelFetch(uSelf, t, 0);
  bool init = prev.a > 0.5;
  float sm = init ? mix(prev.b, dev, 0.35) : dev;
  float split = init ? (prev.r > 0.5 ? step(thr * 0.78, sm) : step(thr * 1.18, sm)) : step(thr, sm);
  float g = init ? clamp(prev.g + (split * 2.0 - 1.0) * uDt / 0.16, 0.0, 1.0) : split;
  fragColor = vec4(split, g, sm, 1.0);
}`;

const OUT = COMMON + QFETCH + /* glsl */ `
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdTri(vec2 p, float w, float h) {   // isoceles, apex up, base centred at y = -h/2
  p.y += h * 0.5; p.x = abs(p.x);
  vec2 n = normalize(vec2(h, w));         // slanted edge normal
  float d = dot(vec2(p.x - w, p.y), n);
  return max(d, -p.y);
}
void main() {
  vec2 p = vUv * uRes;
  vec2 o = gridOrigin();
  float px = max(1.0, uRes.y / 720.0);

  int L = 5; ivec2 c = ivec2(0);
  vec3 col = vec3(0.0); float gPar = 1.0; float line = 0.0;
  float lw = px * mix(0.6, 1.6, u_lines);
  for (int k = 5; k >= 0; k--) {
    float s = cellPx(k);
    vec2 f = (p - o) / s;
    c = ivec2(floor(f));
    vec3 m = qfetch(k, c).rgb;
    col = (k == 5) ? m : mix(col, m, gPar);
    vec2 e = min(fract(f), 1.0 - fract(f)) * s;                // px to the cell border
    float d = min(e.x, e.y);
    float la = (1.0 - smoothstep(lw * 0.5 - 0.5, lw * 0.5 + 0.5, d)) * gPar;
    if (k == 0) la *= 0.7;
    line = max(line, la);
    L = k;
    if (k == 0) break;
    vec4 st = texelFetch(uBuf_qs, lvlOff(k) + c, 0);
    if (st.g <= 0.002) break;
    gPar = st.g * st.g * (3.0 - 2.0 * st.g);
  }
  // exposure: a backlit / dim subject is lifted to a readable key (gain held in the state atlas' spare texel)
  {
    vec4 gs = texelFetch(uBuf_qs, textureSize(uBuf_qs, 0) - 1, 0);
    float gain = gs.a > 0.5 ? gs.r : 1.0;
    vec3 lifted = col * gain;
    col = lifted / (1.0 + max(lifted - 0.8, 0.0) * (gain - 1.0));
  }
  float s = cellPx(L);
  vec2 q = (fract((p - o) / s) - 0.5) * s;                     // px from the cell centre
  int style = int(u_style + 0.5);
  vec3 outc;
  if (style == 0) {
    // Blocks: mean colour, hairline outline in a darker shade of the fill
    outc = mix(col, col * 0.3, line * u_lines);
  } else if (style == 1) {
    // Squircle: 1-bit tiles on a black ground. One white squircle per cell whose area is the
    // cell tone; mid/high tones carry a black centre dot (on a stable half of the cells), very
    // dark fields keep a white hairline frame. Every term is continuous in tone, so a cell
    // never flips polarity under sensor noise.
    float Lm = pow(smoothstep(0.03, 0.92, luma(col)), 0.62);
    float hsh = h21(vec2(c) + float(L) * 17.0);
    float gap = max(0.55 * px, s * 0.04) * mix(0.5, 1.5, u_lines);
    float hb = s * 0.5 - gap;
    float hw = hb * sqrt(clamp(Lm * 1.25, 0.0, 1.0));
    float rw = hw * mix(1.0, 0.36, smoothstep(0.18, 0.6, Lm));          // dot when small, squircle when large
    float white = (1.0 - smoothstep(-0.5, 0.5, sdRound(q, vec2(hw), rw))) * step(0.7 * px, hw);
    float dotA = smoothstep(0.38, 0.6, Lm) * (1.0 - smoothstep(0.72, 0.97, Lm)) * step(0.42, hsh);
    float rd = hb * mix(0.12, 0.34, hsh) * dotA;
    float dotm = (1.0 - smoothstep(-0.5, 0.5, length(q) - rd)) * step(0.7 * px, rd);
    float tone = white * (1.0 - dotm);
    // dark fields: the cell is a black squircle in a white hairline bed, so junctions show
    // the little white stars the reference has
    float hair = max(0.45 * px, s * 0.012) * mix(0.6, 1.4, u_lines);
    float fr = smoothstep(-0.5, 0.5, sdRound(q, vec2(s * 0.5 - hair), s * 0.16)) * smoothstep(0.11, 0.07, Lm) * step(0.5, float(L));
    tone = max(tone, fr * step(0.02, u_lines));
    outc = mix(vec3(0.0, 0.0, 0.004), vec3(0.976, 0.965, 0.98), tone);
  } else {
    // Triangle: white paper, one upward triangle per cell in the cell colour. Near-white cells
    // print nothing; Focus fades the room towards paper so the subject sits alone on white.
    float Lm = luma(col);
    float keep = 1.0;
    if (uPersonReady > 0.5) keep = mix(1.0, smoothstep(0.05, 0.5, texture(uPerson, (o + (vec2(c) + 0.5) * s) / uRes).r), u_focus);
    vec3 ink = pow(max(col, 0.0), vec3(1.5));
    float mx = max(ink.r, max(ink.g, ink.b)), mn = min(ink.r, min(ink.g, ink.b));
    ink = mix(vec3(luma(ink)), ink, 1.35);                              // print inks run more saturated than video
    float dark = clamp((1.0 - Lm) + (mx - mn), 0.0, 1.0);
    float k2 = mix(0.62, 1.0, smoothstep(0.1, 0.7, dark)) * smoothstep(0.05, 0.14, dark);
    k2 *= mix(0.0, 1.0, keep);
    float w = s * 0.45 * k2, h = s * 0.82 * k2;
    float tri = (1.0 - smoothstep(-0.5, 0.5, sdTri(q, w, h))) * step(0.8 * px, w);
    vec3 paper = vec3(0.985, 0.98, 0.985);
    outc = mix(paper, clamp(ink, 0.0, 1.0), tri);
    outc = mix(outc, outc * 0.9, line * u_lines * 0.35 * step(2.5, float(L)));
  }
  fragColor = vec4(outc, 1.0);
}`;

export default {
  id: 'quadtree',
  name: 'Quadtree',
  ref: { clip: 'DcTpHw4Owmc', t: [5.25, 5.65] },
  needs: ['person', 'depth'],
  params: [
    { id: 'detail', label: 'Detail', type: 'float', min: 0, max: 1, default: 0.55 },
    { id: 'cell', label: 'Cell', type: 'float', min: 2.5, max: 12, default: 4 },
    { id: 'style', label: 'Style', type: 'enum', options: ['Blocks', 'Squircle', 'Triangle'], default: 0 },
    { id: 'lines', label: 'Lines', type: 'float', min: 0, max: 1, default: 0.55 },
    { id: 'focus', label: 'Focus', type: 'float', min: 0, max: 1, default: 0.7 },
    { id: 'depth', label: 'Depth', type: 'float', min: 0, max: 1, default: 0.5 },
  ],
  passes: [
    { name: 'q0', frag: Q0, scale: 0.5 },
    { name: 'q1', frag: COMMON + QUP('q0'), scale: 0.25 },
    { name: 'q2', frag: COMMON + QUP('q1'), scale: 0.125 },
    { name: 'q3', frag: COMMON + QUP('q2'), scale: 0.0625 },
    { name: 'q4', frag: COMMON + QUP('q3'), scale: 0.03125 },
    { name: 'q5', frag: COMMON + QUP('q4'), scale: 0.015625 },
    { name: 'qs', frag: QS, scale: 0.5, feedback: true },
    { name: 'out', frag: OUT, screen: true },
  ],
};
