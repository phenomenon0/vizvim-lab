// hand-pixelate — faithful replica of wxll.hx "TD30 day 17" (see breakdowns/hand-pixelate.md)
//
// The TouchDesigner network, transcribed from the reel:
//   MediaPipe -> hand_tracking -> null1 -> select1 (h1:index_finger_tip:x)
//     -> math1 (range 0.25..0.8 -> 0..1) -> limit1 (clamp 0..1) -> lag1 (0.2 / 0.2 s)
//     -> math2 (0..1 -> 0..100) + math3 (0..1 -> 0..20) -> merge1 (rename horizontal vertical)
//     -> limit2 (clamp 1..100) -> null4 -> pixelate.Horsize / pixelate.Vertsize (integer pars)
// One scalar (index fingertip X of the first hand) drives BOTH cell sizes; the cell is always 5:1.
//
// Measured from the reel (1280x720 source): the pixelate COMP shows round(1280/H) x round(720/V)
// cells that fill the frame exactly (13 x 36 at 100/20), each cell the box average of its source
// rectangle (RMS 2.1/255 against the raw camera in the split-view intro; point sampling: 8.6).
//
// Pass graph:
//   state (feedback, tiny)  the Lag CHOP: one scalar, exponential, tau = 0.48 * lag; + commit/hold (see STATE)
//   avgH                    box average of uCam along x inside the cell
//   out (screen)            box average of avgH along y inside the cell -> exact rectangular box

const COMMON = /* glsl */ `
const float REFW = 1280.0;
float refH() { return REFW * uCamRes.y / max(uCamRes.x, 1.0); }
float drive() { return texture(uBuf_state, vec2(0.5)).g; }
// TD integer parameters: round(), then limit2's clamp at 1
vec2 pixelSize(float y) {
  return max(vec2(1.0), floor(vec2(y * u_width, y * u_height) + 0.5));
}
// the pixelate COMP: an integer number of cells that fills the frame
vec2 cellCount(float y) {
  vec2 s = pixelSize(y);
  return max(vec2(1.0), floor(vec2(REFW, refH()) / s + 0.5));
}
`;

// state: R = lagged drive (the Lag CHOP), G = committed drive (what the grid uses), B = last target,
// A = 1 + seconds since a hand was last seen (0 = not initialised).
// Two departures from the TD chain, both invisible in the reel and both for a live noisy tracker:
//  - the grid uses a committed value that only moves when the lagged drive has left the current integer block
//    width by more than 0.35 px (a Schmitt trigger): tracking jitter at a rounding boundary no longer re-grids
//    the whole frame every other frame;
//  - a hand that drops out is held for 0.3 s before the chain sees "no hand", so a 2-8 frame tracking miss does
//    not pulse the picture sharp and back.
// With two hands the further-right index tip drives (order-independent; TD's "h1" is whichever came first).
const STATE = /* glsl */ `
void main() {
  vec4 prev = texture(uSelf, vec2(0.5));
  bool init = prev.a < 0.5;
  float dt = clamp(uDt, 0.0, 0.1);
  float x = 0.0;
  for (int i = 0; i < 2; i++) if (i < uHandCount) x = max(x, uHand[i * 21 + 8].x);
  float u = clamp((x - u_start) / max(u_end - u_start, 1e-3), 0.0, 1.0);   // math1 + limit1
  float lost = init ? 9.0 : prev.a - 1.0;
  if (uHandCount > 0) lost = 0.0; else { lost = min(lost + dt, 9.0); if (lost < 0.3) u = prev.b; }
  float tgt = u;
  u = max(u, u_hold);
  float tau = u_lag * 0.48;                                               // lag1 (fit, see breakdown)
  float a = (init || uDt <= 0.0 || tau < 1e-4) ? 1.0 : 1.0 - exp(-dt / tau);
  float y = mix(prev.r, u, a);
  float W = max(u_width, 1.0), c = init ? y : prev.g;
  if (init || abs(y * W - c * W) > 0.85 || uDt <= 0.0) c = floor(y * W + 0.5) / W;
  if (y * W < 0.5) c = 0.0;                                               // fully sharp is always reachable
  fragColor = vec4(y, c, tgt, 1.0 + lost);
}`;

const AVGH = COMMON + /* glsl */ `
void main() {
  vec2 n = cellCount(drive());
  if (n.x >= REFW - 0.5) { fragColor = vec4(texture(uCam, vUv).rgb, 1.0); return; }
  float x0 = floor(vUv.x * n.x) / n.x, w = 1.0 / n.x;
  int N = int(clamp(ceil(w * uCamRes.x), 1.0, 64.0));
  vec3 s = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= N) break;
    s += texture(uCam, vec2(x0 + (float(i) + 0.5) / float(N) * w, vUv.y)).rgb;
  }
  fragColor = vec4(s / float(N), 1.0);
}`;

const OUT = COMMON + /* glsl */ `
void main() {
  vec2 n = cellCount(drive());
  float cx = n.x >= REFW - 0.5 ? vUv.x : (floor(vUv.x * n.x) + 0.5) / n.x;
  if (n.y >= refH() - 0.5) { fragColor = vec4(texture(uBuf_avgH, vec2(cx, vUv.y)).rgb, 1.0); return; }
  float y0 = floor(vUv.y * n.y) / n.y, h = 1.0 / n.y;
  int N = int(clamp(ceil(h * uCamRes.y), 1.0, 32.0));
  vec3 s = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= N) break;
    s += texture(uBuf_avgH, vec2(cx, y0 + (float(i) + 0.5) / float(N) * h)).rgb;
  }
  fragColor = vec4(s / float(N), 1.0);
}`;

export default {
  id: 'hand-pixelate',
  name: 'Hand Pixelate',
  ref: { clip: 'DcyiqeyOI4g', t: [0.0, 2.85], crop: [280, 21, 520, 293] },   // pixelated half of the split-view intro
  needs: ['hands'],
  params: [
    { id: 'width', label: 'Block Width', type: 'float', min: 1, max: 240, default: 100 },
    { id: 'height', label: 'Block Height', type: 'float', min: 1, max: 240, default: 20 },
    { id: 'start', label: 'Start X', type: 'float', min: 0, max: 1, default: 0.25 },
    { id: 'end', label: 'End X', type: 'float', min: 0, max: 1, default: 0.8 },
    { id: 'lag', label: 'Lag', type: 'float', min: 0, max: 1, default: 0.2 },
    { id: 'hold', label: 'Hold', type: 'float', min: 0, max: 1, default: 0 },
  ],
  passes: [
    { name: 'state', frag: STATE, scale: 0.02, feedback: true },
    { name: 'avgH', frag: AVGH },
    { name: 'out', frag: OUT, screen: true },
  ],
};
