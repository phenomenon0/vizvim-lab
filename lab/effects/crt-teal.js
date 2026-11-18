// crt-teal — the teal raster look from DecGDxGue_s (3.7–5.0 s). Breakdown: breakdowns/crt-teal.md
//
// Measured (frames 230–295, 1080 wide video of a 1280x720 TOP):
//  - 93.7 raster lines per frame height (pitch 6.486 px in the video = 7.69 px at 720p), static phase.
//  - line profile is a sine, trough/peak = 0.25 in the video at every brightness (multiplicative, no
//    luma-dependent thickness, no bloom filling the troughs); the picture is one sample row per line.
//  - mono; tint is an OFFSET applied AFTER the lines and clipped: G = x + .05, B = G + .03, R = G - .16
//    (line peak on the wall #7aa1aa, the trough under it #042933); black #010d13, peak #c3eff5.
//  - tone at the line peaks vs. the clean camera: x = 1.3 L - .075 with a toe (.2 L), knee from .8 to .92.
//  - per-line dash noise: re-seeded every 1/30 s (frame-to-frame r = 0.1), uncorrelated between lines
//    (r = 0.2), correlated ~7 px along the line; brightens the blacks as well (additive part).
//  - no curvature, no vignette, no horizontal jitter, no flicker (frame means drift < 1 %/frame).
// Beyond: `Field` — the hands act on the raster like a magnet on a tube: lines bow around the palm and
// the rows the hand is crossing tear sideways with its speed. 0 = the reference.

const COMMON = /* glsl */ `
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// dash noise along one raster line: value noise in x with hard-ish shoulders, its own phase per line
float dash(float xpx, float line, float seed, float cell){
  float p = xpx / cell + h21(vec2(line, seed + 3.7)) * 61.0;
  float i = floor(p), f = fract(p);
  float a = h21(vec2(i, line * 1.37 + seed * 7.13)), b = h21(vec2(i + 1.0, line * 1.37 + seed * 7.13));
  return mix(a, b, smoothstep(0.25, 0.75, f));
}
`;

const OUT = COMMON + /* glsl */ `
void main(){
  float N = u_lines;
  float asp = uRes.x / uRes.y;
  vec2 uv = vUv;

  // ── beyond: hand field ──
  float bend = 0.0, tear = 0.0, lift = 0.0;
  if (u_field > 0.0) {
    for (int h = 0; h < 2; h++) {
      if (h >= uHandCount) break;
      vec2 d = (uv - uHandCenter[h]) * vec2(asp, 1.0);
      float R = 0.13 + 0.04 * uOpen[h];
      float w = exp(-dot(d, d) / (R * R));
      // lines are pushed away from the palm: the raster opens up over the hand
      bend += -u_field * 0.55 * w * d.y;
      // rows the hand is on tear along its horizontal speed
      float wy = exp(-d.y * d.y / (R * R * 0.6));
      tear += u_field * 0.035 * clamp(uHandVel[h].x, -3.0, 3.0) * wy;
      lift += u_field * 0.10 * w;
    }
  }
  float ly = (uv.y + bend) * N;
  float li = floor(ly), ph = fract(ly);
  float yc = (li + 0.5) / N - bend;                      // the row this raster line carries

  float seed = floor(uTime * 30.0);
  float k = uRes.x / 1080.0;
  // per-line tear: every line gets its own share of the hand's shove
  // (each line's share now glides between values at 10 Hz instead of being re-rolled every frame: a moving hand
  // drags the rows, it does not make them buzz)
  float ts = uTime * 10.0;
  float xo = tear * (0.35 + 0.65 * mix(h21(vec2(li, floor(ts))), h21(vec2(li, floor(ts) + 1.0)), smoothstep(0.0, 1.0, fract(ts))));

  // one sample row per line: box over the line height, slight horizontal softness (the TD picture
  // is a webcam upscaled to 720p, measured edge width ~3 px)
  float L = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i) * 1.3 * k / uRes.x, float(j) * 0.3 / N);
    L += lum(texture(uCam, vec2(uv.x + xo, yc) + o).rgb);
  }
  L /= 9.0;

  // tone at the line peak (measured against the clean camera)
  float x = max(0.2 * L, 1.3 * L - 0.075);
  x = (x < 0.8) ? x : 0.8 + 0.12 * (1.0 - exp(-(x - 0.8) / 0.12));      // knee -> 0.92

  // dash noise: two lengths, re-seeded at 30 Hz, gain rises with the signal
  float xp = gl_FragCoord.x / k;
  float n = 0.62 * dash(xp, li, seed, 9.0) + 0.38 * dash(xp, li + 301.0, seed, 27.0) - 0.5;
  float nz = u_static * n * (0.30 - 0.5 * max(x - 0.6, 0.0));           // additive: ~.04 rms, less in the highlights
  x = max(x + 0.5 * nz + lift * x, 0.0);

  // raster
  float m = mix(1.0 - u_depth, 1.0, 0.5 + 0.5 * cos(6.2831853 * (ph - 0.5)));
  float G = x * m + 0.05;

  // tint AFTER the lines, as an offset (not a multiply): R = G - .16, B = G + .03, red clips to 0 in
  // the troughs, which is why the gaps read saturated teal instead of dark grey
  vec3 T = u_tint / max(max(u_tint.r, u_tint.g), max(u_tint.b, 1e-3));
  // second look: the offset follows the PICTURE under the lines, not the lit line itself. Measured again on a
  // dark jacket: R = G - .043 at both the line peak and the trough (the first version clipped red to 0 there,
  // which is why our blacks read teal and the reel's read neutral), against R = G - .17 on the wall.
  float x0 = max(0.2 * L, 1.3 * L - 0.075);
  vec3 col = vec3(G) + (T - T.g) * mix(0.27, 1.06, smoothstep(0.03, 0.45, x0));
  col = max(col, 0.0) + 0.5 * max(nz, 0.0) * m;                                   // a neutral share of the noise survives the clip
  col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) / 255.0;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export default {
  id: 'crt-teal',
  name: 'CRT Teal',
  ref: { clip: 'DecGDxGue_s', t: [3.85, 4.95] },
  needs: ['hands'],
  params: [
    { id: 'lines', label: 'Lines', type: 'float', min: 40, max: 240, default: 93.7 },
    { id: 'depth', label: 'Line Depth', type: 'float', min: 0, max: 1, default: 0.8 },
    { id: 'static', label: 'Static', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'tint', label: 'Tint', type: 'color', default: '#cff8ff' },
    { id: 'field', label: 'Hand Field', type: 'float', min: 0, max: 1, default: 0.4 },
  ],
  passes: [
    { name: 'out', frag: OUT, screen: true },
  ],
};
