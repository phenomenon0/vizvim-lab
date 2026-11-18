// vhs-tape — a VHS playback chain, signal first (see breakdowns/vhs-tape.md)
//
//   sig  (feedback) camera -> Y'IQ on the tape raster, luma band-limited (~240 TVL), written
//                   one FIELD per frame (the other field's lines are held: real interlace
//                   weave, so motion combs); held entirely while paused
//   c1,c2           chroma band-limit (~35 TVL) in two half-res horizontal passes + vertical
//                   line bleed (the colour-under comb averages adjacent lines)
//   tape            playback: time-base error per line, head-switch tear, tracking band,
//                   peaking + trailing ring, chroma delay, luma snow / chroma crawl, dropouts
//                   with comet tails, OSD, pedestal + knee  -> R'G'B'
//   glow            wide blur of the tube face
//   out  (screen)   the tube it is watched on: scanlines, mask, halation, cool phosphor cast

// ── OSD font: 5x7 dot-matrix, the kind a VCR's character generator ROM holds ───────────────
const FONT = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  'D': ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '>': ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],   // play triangle
  '<': ['....#', '...##', '..###', '.####', '..###', '...##', '....#'],   // rewind triangle
  '|': ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'],   // pause bars
};
const CHARS = Object.keys(FONT);
const GI = (ch) => Math.max(0, CHARS.indexOf(ch));
const NG = CHARS.length;
const AW = NG * 6, AH = 8;                     // 6x8 cell: 5x7 glyph + 1 texel of padding

function fontPixels() {
  const px = new Uint8Array(AW * AH * 4);
  CHARS.forEach((ch, g) => {
    FONT[ch].forEach((row, r) => {
      for (let x = 0; x < 5; x++) if (row[x] === '#') {
        const y = 6 - r;                       // texture row 0 = glyph bottom (vUv is y-up)
        const o = ((y * AW) + g * 6 + x) * 4;
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 255;
      }
    });
  });
  return px;
}
const glslStr = (name, s) => `const int ${name}_N = ${s.length};\nconst int ${name}[${s.length}] = int[${s.length}](${[...s].map(GI).join(',')});\n`;

const d = new Date();
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DATE1 = `${d.getHours() >= 12 ? 'PM' : 'AM'} ${String(((d.getHours() + 11) % 12) + 1).padStart(2, ' ')}:${String(d.getMinutes()).padStart(2, '0')}`;
const DATE2 = `${MONTHS[d.getMonth()]}.${String(d.getDate()).padStart(2, ' ')} ${d.getFullYear()}`;

const COMMON = /* glsl */ `
uniform sampler2D uOsd; uniform float uPause; uniform float uShuttle;
float lineH() { return max(1.0, floor(uRes.y / 480.0 + 0.5)); }      // output px per tape line
float pitchPx() { return min(uRes.x, uRes.y) / 240.0; }              // output px per TV line of luma
vec3 rgb2yiq(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 yiq2rgb(vec3 y) { return vec3(y.x + 0.956 * y.y + 0.621 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z); }
uint hu(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float h1(int a, int b, int c) { return float(hu(uint(a) * 0x9e3779b9u ^ hu(uint(b) * 0x85ebca6bu ^ hu(uint(c) + 0x27d4eb2fu)))) / 4294967295.0; }
float nrm(int a, int b, int c) { return (h1(a, b, c) + h1(a, b, c + 7919) + h1(a, b, c + 15101) - 1.5) * 2.0; }   // ~unit variance
// band-limited noise along a line: values on cells 'cell' px wide, eased between
float streak(float x, float cell, int line, int fld, int seed) {
  float xc = x / max(cell, 0.5), i0 = floor(xc), t = smoothstep(0.0, 1.0, xc - i0);
  return mix(nrm(int(i0), line, fld * 131 + seed), nrm(int(i0) + 1, line, fld * 131 + seed), t);
}
`;

// ── sig: the recorded signal, one field per frame ─────────────────────────────────────────
const SIG = COMMON + /* glsl */ `
void main() {
  float lh = lineH();
  int ln = int(floor(gl_FragCoord.y / lh));
  vec4 prev = texelFetch(uSelf, ivec2(gl_FragCoord.xy), 0);
  bool held = prev.a > 0.5 && (uPause > 0.5 || ((ln & 1) != (uFrame & 1) && u_interlace > 0.5));
  if (held) { fragColor = prev; return; }
  float yc = (float(ln) + 0.5) * lh / uRes.y;
  float sig = 0.68 * pitchPx();                // ~10 % MTF left at 240 TVL: the limiting resolution
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    float w = exp(-0.5 * float(k * k) * 0.5625);                     // taps every 0.75 sigma
    vec3 c = texture(uCam, vec2(vUv.x + float(k) * 0.75 * sig / uRes.x, yc)).rgb;
    acc += w * rgb2yiq(c); wsum += w;
  }
  vec3 cur = acc / wsum;
  // third pass: the camera's own sensor noise is not tape noise. A motion-adaptive hold against the last time this
  // line was written keeps still picture still (small differences are averaged away, real change passes at once),
  // so every flicker left in the output is one this module drew on purpose.
  if (prev.a > 0.5) {
    float dY = abs(cur.x - prev.x), dC = length(cur.yz - prev.yz);
    float k = mix(0.22, 1.0, smoothstep(0.02, 0.07, max(dY, dC * 0.8)));
    cur = mix(prev.rgb, cur, k);
  }
  fragColor = vec4(cur, 1.0);
}`;

// ── chroma band-limit, two half-res horizontal passes ─────────────────────────────────────
const C1 = COMMON + /* glsl */ `
void main() {
  vec2 acc = vec2(0.0); float wsum = 0.0;
  float st = 0.5 * pitchPx();                  // tap spacing, output px
  for (int k = -4; k <= 4; k++) {
    float w = exp(-0.5 * float(k * k) * 0.25);
    acc += w * texture(uBuf_sig, vUv + vec2(float(k) * st / uRes.x, 0.0)).gb; wsum += w;
  }
  fragColor = vec4(acc / wsum, 0.0, 1.0);
}`;
const C2 = COMMON + /* glsl */ `
void main() {
  // total chroma sigma = 0.5 * S / 35 TVL at Bleed 1; this pass supplies what c1 has not
  float S = min(uRes.x, uRes.y);
  float sigC = 0.5 * S / 35.0 * (mix(0.35, 1.6, u_bleed) + 1.8 * smoothstep(0.6, 1.0, u_bleed));   // top of the range = nth-generation dub
  float s1 = pitchPx();                        // c1's sigma (2 taps of 0.5 pitch)
  float s2 = sqrt(max(sigC * sigC - s1 * s1, 0.25));
  float lh = lineH() / uRes.y;
  vec2 acc = vec2(0.0); float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    float w = exp(-0.5 * float(k * k) * 0.25);
    vec2 u = vUv + vec2(float(k) * 0.5 * s2 / uRes.x, 0.0);
    // vertical bleed: the line above and the one above that leak down (comb + 1H delay)
    vec2 c = 0.5 * texture(uBuf_c1, u).rg + 0.32 * texture(uBuf_c1, u + vec2(0.0, lh * 2.0)).rg
           + 0.18 * texture(uBuf_c1, u + vec2(0.0, lh * 4.0)).rg;
    acc += w * c; wsum += w;
  }
  fragColor = vec4(acc / wsum, 0.0, 1.0);
}`;

// ── tape: playback ────────────────────────────────────────────────────────────────────────
const TAPE = COMMON + glslStr('S_PLAY', 'PLAY >') + glslStr('S_SP', 'SP') + glslStr('S_PAUSE', 'PAUSE |')
  + glslStr('S_REW', '<< REW') + glslStr('S_FF', 'FF >>') + glslStr('S_D1', DATE1) + glslStr('S_D2', DATE2) + /* glsl */ `
const float NG = ${NG}.0;
float glyph(int g, vec2 f) {                    // f in font px, 0..6 x 0..8 (cell incl. padding)
  if (f.x < 0.0 || f.y < 0.0 || f.x >= 6.0 || f.y >= 8.0) return 0.0;
  return texture(uOsd, vec2((float(g) * 6.0 + f.x) / (NG * 6.0), f.y / 8.0)).r;
}
// one text line; q = font px relative to the line's bottom-left
#define TEXT(NAME, N) { int i = int(floor(q.x / 6.0)); if (q.y >= -1.0 && q.y < 8.0 && i >= 0 && i < N) m = max(m, glyph(NAME[i], vec2(q.x - float(i) * 6.0, q.y))); }
float counterGlyph(vec2 q) {                    // H:MM:SS tape counter from uTime
  int i = int(floor(q.x / 6.0));
  if (q.y < -1.0 || q.y >= 8.0 || i < 0 || i >= 7) return 0.0;
  int tsec = int(uTime) + 754;
  int dg[7] = int[7](tsec / 3600 % 10, -1, tsec / 600 % 6, tsec / 60 % 10, -1, tsec / 10 % 6, tsec % 10);
  int g = dg[i] < 0 ? ${GI(':')} : ${GI('0')} + dg[i];
  return glyph(g, vec2(q.x - float(i) * 6.0, q.y));
}
float osdMask(vec2 p) {                         // p in output px
  float fp = lineH() * 2.0;                     // one font dot = one field line pair... x2
  fp = max(2.0, floor(uRes.y / 480.0 * 4.0 + 0.5));
  vec2 mrg = vec2(0.075 * uRes.y * 1.2, 0.085 * uRes.y);
  float m = 0.0; vec2 q;
  int mode = int(u_osd + 0.5);
  float top = uRes.y - mrg.y - 7.0 * fp;
  if (uPause > 0.5 || abs(uShuttle) > 0.3) {
    q = (p - vec2(mrg.x, top)) / fp;
    if (uShuttle < -0.3) { TEXT(S_REW, S_REW_N) } else if (uShuttle > 0.3) { TEXT(S_FF, S_FF_N) } else { TEXT(S_PAUSE, S_PAUSE_N) }
  } else if (mode == 1) {
    q = (p - vec2(mrg.x, top)) / fp; TEXT(S_PLAY, S_PLAY_N)
    q = (p - vec2(uRes.x - mrg.x - 12.0 * fp, top)) / fp; TEXT(S_SP, S_SP_N)
    q = (p - vec2(uRes.x - mrg.x - 42.0 * fp, mrg.y)) / fp; m = max(m, counterGlyph(q));
  } else if (mode == 2) {
    q = (p - vec2(uRes.x - mrg.x - float(S_D2_N) * 6.0 * fp, mrg.y + 10.0 * fp)) / fp; TEXT(S_D1, S_D1_N)
    q = (p - vec2(uRes.x - mrg.x - float(S_D2_N) * 6.0 * fp, mrg.y)) / fp; TEXT(S_D2, S_D2_N)
  }
  return m;
}
vec3 knee(vec3 c, float k) { return mix(c, k + (1.0 - k) * (1.0 - exp(-(c - k) / (1.0 - k))), step(k, c)); }

void main() {
  vec2 px = vUv * uRes;
  float S = min(uRes.x, uRes.y), pitch = pitchPx(), lh = lineH();
  int ln = int(floor(px.y / lh));
  int fld = uFrame;
  float t = uTime;
  float wob = u_wobble * 2.0, wear = u_wear;

  // pause: the still field bounces a line; shuttle: the picture skews
  float pauseAmt = uPause;
  float shut = abs(uShuttle);

  // 1. time base (px). No TBC in a consumer deck: lines jitter, the frame breathes sideways,
  //    the top flags (skew from tape tension).
  float dx = 0.0;
  dx += nrm(ln, 17, fld) * 0.22 * wob * pitch;
  dx += sin(float(ln) * 0.021 + t * 1.3) * 0.5 * wob * pitch;
  dx += sin(float(ln) * 0.0037 - t * 0.41) * 0.9 * wob * pitch;
  float top = clamp(1.0 - (1.0 - vUv.y) / 0.045, 0.0, 1.0);
  dx += top * top * 3.5 * wob * pitch * (0.55 + 0.45 * sin(t * 2.1));
  // head switching: the bottom ~7 lines of 480 tear sideways, with a noisy switch line
  float hsBand = 0.017;
  float hs = clamp((hsBand - vUv.y) / hsBand, 0.0, 1.0);
  dx += hs > 0.0 ? (8.0 + hs * hs * 22.0 + nrm(ln, 3, fld) * 2.5) * pitch : 0.0;

  // 2. tracking: a band of lost RF rising from the bottom edge (Tracking), plus transient
  //    bands that roam the frame on a worn tape, plus pause / search noise bars
  float edgeN = 0.5 + 0.5 * sin(t * 0.7) * sin(t * 1.9 + 1.3);
  float tb = u_tracking * u_tracking * 0.48 * (0.85 + 0.15 * edgeN);
  float track = u_tracking > 0.0 ? 1.0 - smoothstep(tb * 0.08, tb * 1.2 + 0.002, vUv.y) : 0.0;
  {
    int ep = int(floor(t / 2.7));
    float he = h1(ep, 5, 77);
    if (he < wear * 0.75) {
      float y0 = fract(h1(ep, 6, 77) + t * 0.06), w = 0.012 + 0.03 * h1(ep, 7, 77);
      float dy = abs(vUv.y - y0); dy = min(dy, 1.0 - dy);
      track = max(track, (1.0 - smoothstep(0.0, w, dy)) * 0.8);
    }
  }
  float bars = 0.0;
  if (pauseAmt > 0.5 || shut > 0.3) {
    float nb = shut > 0.3 ? 4.0 : 1.0;
    float yy = fract(vUv.y * nb + (shut > 0.3 ? sign(uShuttle) * t * 0.35 : 0.18) + 0.02 * sin(t * 3.0));
    bars = 1.0 - smoothstep(0.0, shut > 0.3 ? 0.14 : 0.06, abs(yy - 0.5));
    track = max(track, bars);
    dx += shut * sin(vUv.y * 9.0 + t * 5.0) * 6.0 * pitch;
  }
  int lg = ln / int(max(2.0, floor(uRes.y / 200.0 + 0.5)));           // snow dashes span a few picture lines
  dx += track * nrm(lg, 29, fld) * 7.0 * pitch;
  dx += track * track * 10.0 * pitch * sin(float(ln) * 0.7 + t * 9.0);

  vec2 p = px - vec2(dx, 0.0);
  if (pauseAmt > 0.5) p.y += ((fld & 1) == 0 ? lh : 0.0);            // pause jitter
  vec2 uv = p / uRes;

  // 3. luma: five taps on a 1.5-TV-line grid give the peaking (sharpness circuit) and a
  //    trailing ring (overshoot, then a weaker undershoot one and two steps after an edge)
  float a = 1.5 * pitch / uRes.x;
  float Y0 = texture(uBuf_sig, uv).r;
  float Yp = texture(uBuf_sig, uv + vec2(a, 0.0)).r;
  float Ym1 = texture(uBuf_sig, uv - vec2(a, 0.0)).r;
  float Ym2 = texture(uBuf_sig, uv - vec2(2.0 * a, 0.0)).r;
  float Ym3 = texture(uBuf_sig, uv - vec2(3.0 * a, 0.0)).r;
  float hp0 = Y0 - 0.5 * (Ym1 + Yp), hp1 = Ym1 - 0.5 * (Ym2 + Y0), hp2 = Ym2 - 0.5 * (Ym3 + Ym1);
  float pk = 0.85;
  float Y = Y0 + pk * (hp0 - 0.42 * hp1 + 0.2 * hp2);
  // highlight streak: bright picture to the left drags a faint tail right
  Y += 0.06 * max(Ym2 - 0.75, 0.0) + 0.04 * max(Ym3 - 0.75, 0.0);

  // 4. chroma: band-limited, delayed (smears right), and a line late
  float delay = 0.0045 * S * (mix(0.3, 1.6, u_bleed) + 1.2 * smoothstep(0.6, 1.0, u_bleed));
  vec2 IQ = texture(uBuf_c2, (p - vec2(delay, 0.0)) / uRes).rg;
  IQ *= mix(0.95, 1.25, u_bleed) + 0.6 * smoothstep(0.6, 1.0, u_bleed);                                     // dubbed tapes run hot
  IQ *= 1.0 - 0.85 * track;                                           // colour killer in lost RF

  // 6. noise. Luma snow is band-limited like the signal (streaky along the line, sharp
  //    between lines); chroma noise is far lower in frequency and two lines tall: it crawls.
  float nl = (0.010 + 0.04 * wear);
  float dark = 1.35 - 0.7 * clamp(Y, 0.0, 1.0);
  Y += streak(p.x, pitch * 1.7, ln, fld, 31) * nl * dark;
  Y += streak(p.x, pitch * 0.8, ln, fld, 37) * nl * 0.45 * dark;
  float nc = (0.004 + 0.03 * wear) * mix(0.6, 1.4, u_bleed);
  IQ += vec2(streak(p.x, pitch * 9.0, ln / 2, fld, 33), streak(p.x, pitch * 9.0, ln / 2, fld, 35)) * nc * 0.8;
  IQ += vec2(streak(p.x, pitch * 22.0, ln / 4, fld, 41), streak(p.x, pitch * 22.0, ln / 4, fld, 43)) * nc * 0.6;

  // tracking snow: the FM demodulator on noise -> hard black/white dashes, with flecks of
  // decoded colour, denser toward the centre of the band
  if (track > 0.0) {
    int l2 = lg;
    float n1 = streak(p.x, pitch * 3.5, l2, fld, 51);
    float n2 = streak(p.x, pitch * 8.0, l2, fld, 53);
    float bandN = streak(float(lg), 3.0, 0, fld, 55);                  // rows clump into lighter and darker belts
    float snow = smoothstep(0.3, 0.5, 0.5 + 0.8 * n1 + 0.16 * n2 + 0.22 * bandN);
    float lineLoss = step(h1(l2, 57, fld), track * 0.75);              // whole lines drop to noise
    float k = clamp(track * (0.6 + 0.4 * lineLoss) * (0.75 + 0.5 * streak(p.x, pitch * 4.0, l2, fld, 65)), 0.0, 1.0);
    Y = mix(Y, snow * 0.97 + 0.02, min(1.0, k * 1.15));
    IQ += track * 0.045 * vec2(streak(p.x, pitch * 5.0, l2, fld, 59), streak(p.x, pitch * 5.0, l2, fld, 61));
  }
  // the head-switch line itself
  if (hs > 0.0) Y = mix(Y, 0.55 + 0.45 * streak(p.x, pitch * 2.0, ln, fld, 63), 0.35 * hs);

  // 5. OSD: the deck's character generator, keyed in after the tape (it does not wobble),
  //    white with a black edge, through the same output bandwidth
  float osd = 0.0, osdEdge = 0.0;
  if (u_osd > 0.5 || uPause > 0.5 || abs(uShuttle) > 0.3) {
    float fp = max(2.0, floor(uRes.y / 480.0 * 4.0 + 0.5));
    for (int k = -1; k <= 1; k++) osd += osdMask(px + vec2(float(k) * pitch * 0.6, 0.0)) * (k == 0 ? 0.5 : 0.25);
    osd = smoothstep(0.3, 0.62, osd);
    float e = 0.0;
    e = max(e, osdMask(px + vec2(fp, 0.0)));  e = max(e, osdMask(px - vec2(fp, 0.0)));
    e = max(e, osdMask(px + vec2(0.0, fp)));  e = max(e, osdMask(px - vec2(0.0, fp)));
    e = max(e, osdMask(px + vec2(fp, -fp)));  e = max(e, osdMask(px + vec2(-fp, -fp)));
    osdEdge = smoothstep(0.25, 0.6, e);
    Y = mix(Y, 0.05, osdEdge * 0.85); IQ *= 1.0 - osdEdge;
    Y = mix(Y, 0.9, osd); IQ *= 1.0 - osd;
  }

  vec3 c = yiq2rgb(vec3(Y, IQ));

  // 7. dropouts: oxide shed -> a line-tall white streak with a decaying tail; the line
  //    below carries a weaker echo (the dropout compensator repeating the previous line)
  // (expected dropouts per FRAME, whatever the line count: 0.05 on a good tape, ~0.2 at the default, 1.3 worn out)
  float rate = (0.05 + 1.25 * wear * wear) * lh / uRes.y;
  for (int j = 0; j < 2; j++) {
    int l2 = ln + j;                                                  // j = 1: the line above
    if (h1(l2, 9, fld) < rate) {
      float x0 = h1(l2, 10, fld) * uRes.x, len = (6.0 + 50.0 * h1(l2, 11, fld)) * pitch;
      float xr = px.x - x0;
      float v = xr >= 0.0 ? exp(-xr / (len * 0.35)) * step(xr, len * 1.6) : 0.0;
      v *= (j == 0 ? 1.0 : 0.35) * (0.75 + 0.25 * streak(px.x, pitch, l2, fld, 71));
      c = mix(c, vec3(h1(l2, 12, fld) < 0.85 ? 0.97 : 0.03), clamp(v, 0.0, 1.0));
    }
  }

  // 8. tone: the camera/dub chain crushes the toe, playback adds setup (lifted pedestal)
  //    and a soft knee into the clip
  c = max(c - 0.035, 0.0) * 1.03;
  c = knee(c, 0.78) * 0.92 + 0.045;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const GLOW = /* glsl */ `
void main() {
  vec3 acc = vec3(0.0); float ws = 0.0;
  float r = uRes.y * 0.012;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float w = exp(-0.5 * float(i * i + j * j) / 2.6);
    vec3 s = texture(uBuf_tape, vUv + vec2(float(i), float(j)) * r / uRes).rgb;
    acc += w * s * s; ws += w;
  }
  fragColor = vec4(acc / ws, 1.0);
}`;

const OUT = COMMON + /* glsl */ `
void main() {
  vec3 c = texture(uBuf_tape, vUv).rgb;
  float s = u_screen;
  if (s > 0.0) {
    vec2 px = vUv * uRes;
    vec3 lin = c * c;
    vec3 g = texture(uBuf_glow, vUv).rgb;
    // halation: the tube face scatters light; highlights bloom, blacks lift
    lin = mix(lin, lin + g * 0.55, s * 0.6);
    // scanlines at the field-line pitch; bright lines are fatter (beam spot grows with drive)
    float lh = max(3.0, floor(uRes.y / 240.0 + 0.5));
    float ph = fract(px.y / lh);
    float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
    float prof = 0.5 - 0.5 * cos(6.2831853 * ph);
    float depth = s * mix(0.55, 0.22, smoothstep(0.0, 0.6, lum));
    lin *= 1.0 - depth * (1.0 - prof);
    lin *= 1.0 + depth * 0.45;
    // shadow mask: staggered triads, 3 px wide
    float mp = max(1.0, floor(uRes.y / 720.0 + 0.5));
    vec2 mc = floor(px / mp);
    float tri = mod(mc.x + 1.5 * floor(mod(mc.y, 4.0) / 2.0), 3.0);
    vec3 mask = vec3(tri < 1.0 ? 1.0 : 0.72, (tri >= 1.0 && tri < 2.0) ? 1.0 : 0.72, tri >= 2.0 ? 1.0 : 0.72);
    lin *= mix(vec3(1.0), mask * 1.18, s * 0.55);
    // 9300 K phosphor white + the glass: a cool cast, blue in the blacks
    lin *= mix(vec3(1.0), vec3(0.78, 1.0, 1.22), s);
    lin += s * vec3(0.0015, 0.004, 0.008);
    // tube corner falloff
    vec2 d = (vUv - 0.5) * vec2(1.0, uRes.y / uRes.x) * 2.0;
    lin *= 1.0 - s * 0.35 * smoothstep(0.55, 1.25, length(d));
    // shoulder: glow + line gain + mask gain used to clip a lit face to flat lavender
    lin = mix(lin, 0.55 + 0.45 * (1.0 - exp(-(lin - 0.55) / 0.45)), step(0.55, lin));
    c = sqrt(clamp(lin, 0.0, 1.0));
  }
  fragColor = vec4(c, 1.0);
}`;

// transport state (CPU side: a debounced bool and a smoothed scalar, no pixel work)
const transport = { pause: 0, shuttle: 0, held: 0 };

export default {
  id: 'vhs-tape',
  name: 'VHS Tape',
  ref: { clip: 'DcTpHw4Owmc', t: [6.0, 6.5] },
  needs: ['hands'],
  params: [
    { id: 'wear', label: 'Wear', type: 'float', min: 0, max: 1, default: 0.25 },
    { id: 'bleed', label: 'Bleed', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'tracking', label: 'Tracking', type: 'float', min: 0, max: 1, default: 0.25 },
    { id: 'wobble', label: 'Wobble', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'screen', label: 'Screen', type: 'float', min: 0, max: 1, default: 0.55 },
    { id: 'osd', label: 'OSD', type: 'enum', options: ['Off', 'Play', 'Date'], default: 1 },
    { id: 'interlace', label: 'Interlace', type: 'bool', default: true, more: true },
    // Gesture: a fist held 0.25 s pauses the tape, a fist swept sideways is picture search
    { id: 'transport', label: 'Transport', type: 'enum', options: ['Gesture', 'Play', 'Pause', 'Rewind', 'FF'], default: 0, more: true },
  ],
  passes: [
    { name: 'sig', frag: SIG, feedback: true },
    { name: 'c1', frag: C1, scale: 0.5 },
    { name: 'c2', frag: C2, scale: 0.5 },
    { name: 'tape', frag: TAPE },
    { name: 'glow', frag: GLOW, scale: 0.25 },
    { name: 'out', frag: OUT, screen: true },
  ],
  init(ctx) {
    ctx.state.osd = ctx.makeTexture({ width: AW, height: AH, data: fontPixels() }, { filter: 'linear', wrap: 'clamp' });
    transport.pause = transport.shuttle = transport.held = 0;
  },
  frame(ctx) {
    const mode = Math.round(ctx.params.transport ?? 0);
    const dt = Math.min(0.1, ctx.dt || 1 / 60);
    let target = 0;
    if (mode === 0) {
      const H = ctx.hands, s = H && H.count > 0 ? H.slots[0] : null;
      const fist = !!s && s.open < 0.22, open = !s || s.open > 0.45;
      transport.held = fist ? transport.held + dt : open ? 0 : transport.held;
      transport.pause = transport.held > 0.25 ? 1 : 0;
      target = transport.pause && s && Math.abs(s.vel[0]) > 0.6 ? Math.sign(s.vel[0]) : 0;
      transport.shuttle += (target - transport.shuttle) * Math.min(1, dt * (target ? 12 : 3));
    } else {
      transport.held = 0;
      transport.pause = mode === 2 ? 1 : 0;
      transport.shuttle = mode === 3 ? -1 : mode === 4 ? 1 : 0;
    }
    return { uOsd: ctx.state.osd, uPause: transport.pause, uShuttle: transport.shuttle };
  },
};
