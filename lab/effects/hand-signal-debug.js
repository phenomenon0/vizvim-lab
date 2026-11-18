// Hand-signal debug: every signal, pose and event of the hand-signal layer, live, over the dimmed camera.
// Not a look. It is the instrument panel for lab/handsignal.js (spec: breakdowns/hand-signal.md):
//   skeleton of each tracked hand as the core sees it (user's left white, right teal), fingertip dots swell with curl,
//   pinch ring (radius = finger gap, solid when latched), pose name + confidence over the hand, velocity and palm-normal
//   vectors, pointing cursor, director's frame, meter columns per hand, two-hand meters, event ticker.
// One fragment pass over uniforms + a label atlas made once in init. No per-pixel CPU work.
import { HS_DECL, HS_BOX, HS_HUD, HS_BOX_SHELL } from '../handsignal/glsl.js';

const METERS = ['pinch', 'open', 'x', 'y', 'depth', 'roll', 'yaw', 'pitch', 'speed', 'curl0', 'curl1', 'curl2', 'curl3', 'curl4'];
const METER_LABELS = ['pinch', 'open', 'x', 'y', 'depth', 'roll', 'yaw', 'pitch', 'speed', 'thumb', 'index', 'middle', 'ring', 'pinky'];
const TWO = ['spread', 'twist', 'midX', 'midY', 'push', 'depthDiff'];
const TWO_LABELS = ['spread', 'twist', 'mid x', 'mid y', 'push', 'depth diff'];
const POSES = ['none', 'open', 'fist', 'point', 'peace', 'thumbsup', 'pinch', 'L', 'horns', 'ok'];
const POSE_LABELS = ['no pose', 'open palm', 'fist', 'point', 'peace', 'thumbs up', 'pinch', 'L', 'horns', 'OK'];
const EVENTS = ['swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown', 'pinchStart', 'pinchEnd', 'pinchTap', 'pinchTapSingle', 'doublePinch', 'grab', 'release', 'dwell', 'clap', 'poseEnter', 'poseLeave', 'handEnter', 'handLeave'];
const EVENT_LABELS = ['swipe left', 'swipe right', 'swipe up', 'swipe down', 'pinch start', 'pinch end', 'pinch tap', 'single tap', 'double pinch', 'grab', 'release', 'dwell', 'clap', 'pose in', 'pose out', 'hand in', 'hand out'];
const HEAD = ['LEFT HAND', 'RIGHT HAND', 'BOTH HANDS', 'EVENTS'];
const LABELS = [...METER_LABELS, ...TWO_LABELS, ...POSE_LABELS, ...EVENT_LABELS, ...HEAD];   // 14 + 6 + 10 + 17 + 4 = 51
const I_TWO = 14, I_POSE = 20, I_EVENT = 30, I_HEAD = 47, COLS = 4, ROWS = 13, NEV = 8;

export default {
  id: 'hand-signal-debug',
  name: 'Hand signal debug',
  needs: ['hands'],
  params: [
    { id: 'dim', label: 'Dim camera', type: 'float', min: 0, max: 1, default: 0.55 },
    { id: 'meters', label: 'Meters', type: 'bool', default: true },
    { id: 'vectors', label: 'Vectors', type: 'bool', default: true },
  ],
  passes: [
    { name: 'out', screen: true, frag: HS_DECL + /* glsl */`
uniform sampler2D uDAtlas;
uniform vec3 uDLm[42];        // filtered landmarks: x, y (vUv), presence. 0..20 = user's left hand, 21..41 = right
uniform vec4 uDHand[2];       // presence, pinched, pose label index, pose confidence
uniform vec4 uDPinch[2];      // pinch point x, y, gap, hand size (hu)
uniform vec4 uDVel[2];        // palm centre x, y, velocity x, y (hu/s, y up)
uniform vec4 uDNorm[2];       // palm normal x, y, z (camera space), facing
uniform vec4 uDCursor[2];     // cursor x, y, alpha, -
uniform float uDMeter[34];    // 14 per hand (left, right) then 6 two-hand
uniform vec4 uDEvents[${NEV}];     // event label index, alpha, pose label index (-1 none), hand (1 left, 2 right, 0 none)
uniform vec4 uDFrame; uniform vec2 uDFrameRot;   // raw director's frame: cx, cy, w, h; angle, on
` + HS_BOX + HS_HUD + HS_BOX_SHELL + /* glsl */`
const vec3 WHITE = vec3(0.93, 0.95, 0.97);
float label(int idx, vec2 q, float h) {
  vec2 l = q / vec2(h * 8.0, h); if (l.x < 0.0 || l.x > 1.0 || l.y < 0.0 || l.y > 1.0) return 0.0;
  return texture(uDAtlas, vec2((float(idx % ${COLS}) + l.x) / ${COLS}.0, 1.0 - (float(idx / ${COLS}) + 1.0 - l.y) / ${ROWS}.0)).r;
}
float rbox(vec2 p, vec2 c, vec2 hb, float r) { vec2 d = abs(p - c) - hb + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
bool bipolar(int row) { return row == 2 || row == 3 || row == 4 || row == 5 || row == 6 || row == 7; }

// one meter column: header + n rows. o = top-left corner (hu), base = index of the first value / label
void column(inout vec3 col, vec2 p, vec2 o, int n, int base, int lbase, int head, float latched, float alive) {
  float rowH = 0.031, W = 0.36, px = 1.0 / uRes.y;
  float back = rbox(p, o + vec2(W * 0.5, -(float(n) + 1.6) * rowH * 0.5), vec2(W * 0.5 + 0.014, (float(n) + 1.6) * rowH * 0.5 + 0.012), 0.012);
  col = mix(col, vec3(0.035, 0.04, 0.046), 0.72 * (1.0 - smoothstep(-px, px, back)));
  hsOver(col, mix(vec3(0.49, 0.52, 0.56), HS_ACC, alive), label(head, p - (o + vec2(0.0, -rowH)), 0.019));
  float fy = (o.y - 1.6 * rowH - p.y) / rowH; int row = int(floor(fy)); if (fy < 0.0 || row >= n) return;
  vec2 ro = vec2(o.x, o.y - 1.6 * rowH - float(row + 1) * rowH);          // bottom-left of the row
  bool two = lbase == ${I_TWO};
  float hot = (!two && row == 0) ? latched : 0.0;
  hsOver(col, mix(WHITE, HS_ACC, hot), mix(0.62, 1.0, hot) * label(lbase + row, p - (ro + vec2(0.0, 0.006)), 0.019));
  float v = clamp(uDMeter[base + row], 0.0, 1.0), x0 = ro.x + 0.125, len = W - 0.125, yc = ro.y + rowH * 0.5;
  float rest = two ? ((row == 0) ? 0.0 : 0.5) : (bipolar(row) ? 0.5 : 0.0);
  float u = (p.x - x0) / len, dy = abs(p.y - yc);
  if (u >= -0.01 && u <= 1.01) {
    hsOver(col, WHITE, 0.16 * hsAA(dy, 0.6 * px) * step(0.0, u) * step(u, 1.0));
    hsOver(col, HS_ACC, alive * hsAA(dy, 1.1 * px) * step(min(rest, v), u) * step(u, max(rest, v)));
    hsOver(col, mix(WHITE, HS_ACC, hot), mix(0.35, 1.0, alive) * hsAA(abs(p.x - (x0 + v * len)), 1.1 * px) * hsAA(dy, 0.0085));
    if (rest > 0.25) hsOver(col, WHITE, 0.3 * hsAA(abs(p.x - (x0 + 0.5 * len)), 0.6 * px) * hsAA(dy, 0.004));
  }
}

void main() {
  vec3 cam = texture(uCam, vUv).rgb; float A = uRes.x / uRes.y, px = 1.0 / uRes.y;
  float lum = dot(cam, vec3(0.299, 0.587, 0.114));
  vec3 col = mix(cam, vec3(lum) * 0.42, u_dim);
  vec2 p = vUv * vec2(A, 1.0);

  // box (if a box config is live): shell only
  if (uBoxActive > 0.003) { float e, sh; hsBoxMask(vUv, e, sh); col = mix(col, mix(WHITE, HS_ACC, 0.6 * uBoxGrab), e); }

  // raw director's frame
  if (uDFrameRot.y > 0.01) {
    vec2 q = hsHu(vUv, uDFrame.xy); float cs = cos(uDFrameRot.x), sn = sin(uDFrameRot.x); q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
    vec2 dd = abs(q) - 0.5 * vec2(uDFrame.z * A, uDFrame.w); float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
    col = mix(col, cam, 0.85 * uDFrameRot.y * (1.0 - smoothstep(-px, px, sd)));           // the frame opens a window of undimmed camera
    hsStroke(col, abs(sd), 0.9 * px, HS_ACC, uDFrameRot.y);
  }

  for (int h = 0; h < 2; h++) {
    float pr = uDHand[h].x; if (pr < 0.01) continue;
    vec3 hc = h == 0 ? WHITE : HS_ACC; int b = h * 21;
    // bones
    float d = 1e3;
    for (int f = 0; f < 5; f++) {
      int k = b + 1 + f * 4;
      d = min(d, hsSeg(p, uDLm[b].xy * vec2(A, 1.0), uDLm[k].xy * vec2(A, 1.0)) + (f == 0 || f == 1 || f == 4 ? 0.0 : 1e3));
      for (int j = 0; j < 3; j++) d = min(d, hsSeg(p, uDLm[k + j].xy * vec2(A, 1.0), uDLm[k + j + 1].xy * vec2(A, 1.0)));
      if (f > 0 && f < 4) d = min(d, hsSeg(p, uDLm[k].xy * vec2(A, 1.0), uDLm[k + 4].xy * vec2(A, 1.0)));
    }
    hsStroke(col, d, 0.9 * px, hc, 0.9 * pr);
    // joints; fingertips swell with that finger's curl
    for (int i = 0; i < 21; i++) {
      float r = 2.0 * px; bool tip = i > 0 && i % 4 == 0;
      if (tip) r = (2.6 + 4.0 * uDMeter[h * 14 + 9 + (i / 4 - 1)]) * px;
      float dj = length(p - uDLm[b + i].xy * vec2(A, 1.0));
      hsOver(col, tip ? HS_ACC : hc, pr * hsAA(dj, r)); if (tip) hsOver(col, vec3(0.04), pr * hsAA(dj, r - 1.6 * px));
    }
    // pinch ring
    vec2 pp = p - uDPinch[h].xy * vec2(A, 1.0); float R = mix(0.014, 0.05, clamp(uDPinch[h].z, 0.0, 1.0)), on = uDHand[h].y;
    hsStroke(col, abs(length(pp) - R), mix(0.9, 1.6, on) * px, mix(WHITE, HS_ACC, on), pr * mix(0.55, 1.0, on));
    hsOver(col, HS_ACC, pr * on * hsAA(length(pp), 2.6 * px));
    if (u_vectors > 0.5) {
      vec2 c = uDVel[h].xy * vec2(A, 1.0), v = uDVel[h].zw * 0.12;
      if (length(v) > 0.006) { hsStroke(col, hsSeg(p, c, c + v), 1.3 * px, vec3(1.0, 0.72, 0.2), pr); hsOver(col, vec3(1.0, 0.72, 0.2), pr * hsAA(length(p - c - v), 3.0 * px)); }
      // palm normal: a stalk from the palm centre; the bead is solid when the palm faces the lens, hollow when it shows its back
      vec2 n = uDNorm[h].xy * 0.075; float face = uDNorm[h].w;
      hsStroke(col, hsSeg(p, c, c + n), 0.9 * px, vec3(0.62, 0.72, 1.0), pr);
      float bead = length(p - c - n); hsOver(col, vec3(0.62, 0.72, 1.0), pr * hsAA(bead, 4.0 * px)); if (face < 0.0) hsOver(col, vec3(0.04), pr * hsAA(bead, 2.4 * px));
      // pointing cursor
      if (uDCursor[h].z > 0.01) { vec2 cu = uDCursor[h].xy * vec2(A, 1.0), tip = uDLm[b + 8].xy * vec2(A, 1.0); float a = uDCursor[h].z * pr;
        hsOver(col, WHITE, 0.35 * a * hsAA(hsSeg(p, tip, cu), 0.7 * px));
        hsStroke(col, abs(length(p - cu) - 0.016), 1.2 * px, HS_ACC, a); hsOver(col, WHITE, a * hsAA(length(p - cu), 1.6 * px)); }
    }
    // pose name over the hand + confidence underline
    vec2 c = uDVel[h].xy * vec2(A, 1.0); float hs = uDPinch[h].w; vec2 lo = c + vec2(-0.05, max(hs * 1.25, 0.11));
    lo = clamp(lo, vec2(0.01, 0.02), vec2(A - 0.2, 0.95));
    float bk = rbox(p, lo + vec2(0.085, 0.011), vec2(0.095, 0.02), 0.01); col = mix(col, vec3(0.035, 0.04, 0.046), 0.7 * pr * (1.0 - smoothstep(-px, px, bk)));
    hsOver(col, hc, pr * label(${I_POSE} + int(uDHand[h].z + 0.5), p - lo, 0.024));
    hsOver(col, HS_ACC, pr * hsAA(abs(p.y - (lo.y - 0.004)), 0.9 * px) * step(lo.x, p.x) * step(p.x, lo.x + 0.17 * clamp(uDHand[h].w, 0.0, 1.0)));
  }

  if (u_meters > 0.5) {
    column(col, p, vec2(0.03, 0.975), 14, 0, 0, ${I_HEAD}, uDHand[0].y, uDHand[0].x);
    column(col, p, vec2(A - 0.39, 0.975), 14, 14, 0, ${I_HEAD + 1}, uDHand[1].y, uDHand[1].x);
    column(col, p, vec2(0.03, 0.455), 6, 28, ${I_TWO}, ${I_HEAD + 2}, 0.0, min(uDHand[0].x, uDHand[1].x));
    // events: newest on top, fading
    vec2 o = vec2(A - 0.39, 0.455); float rowH = 0.031, W = 0.36;
    float back = rbox(p, o + vec2(W * 0.5, -(${NEV}.0 + 1.6) * rowH * 0.5), vec2(W * 0.5 + 0.014, (${NEV}.0 + 1.6) * rowH * 0.5 + 0.012), 0.012);
    col = mix(col, vec3(0.035, 0.04, 0.046), 0.72 * (1.0 - smoothstep(-px, px, back)));
    hsOver(col, vec3(0.49, 0.52, 0.56), label(${I_HEAD + 3}, p - (o + vec2(0.0, -rowH)), 0.019));
    float fy = (o.y - 1.6 * rowH - p.y) / rowH; int row = int(floor(fy));
    if (fy >= 0.0 && row < ${NEV}) {
      vec4 e = uDEvents[row]; vec2 ro = vec2(o.x, o.y - 1.6 * rowH - float(row + 1) * rowH);
      if (e.y > 0.01) {
        vec3 ec = mix(WHITE, HS_ACC, smoothstep(0.6, 1.0, e.y));
        hsOver(col, e.w > 1.5 ? HS_ACC : WHITE, e.y * step(0.5, e.w) * hsAA(length(p - (ro + vec2(0.006, rowH * 0.5))), 2.2 * px));
        hsOver(col, ec, e.y * label(${I_EVENT} + int(e.x + 0.5), p - (ro + vec2(0.02, 0.006)), 0.019));
        if (e.z >= 0.0) hsOver(col, ec, 0.8 * e.y * label(${I_POSE} + int(e.z + 0.5), p - (ro + vec2(0.2, 0.006)), 0.019));
      }
    }
  }
  fragColor = vec4(hsHud(col, vUv), 1.0);
}` },
  ],
  init(ctx) {
    const CW = 256, CH = 32, cv = document.createElement('canvas'); cv.width = CW * COLS; cv.height = CH * ROWS;
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.font = '500 23px ui-monospace, SFMono-Regular, Menlo, monospace';
    LABELS.forEach((s, i) => g.fillText(s, (i % COLS) * CW + 2, Math.floor(i / COLS) * CH + CH / 2 + 1, CW - 4));
    ctx.state.atlas = ctx.makeTexture(cv);
  },
  frame(ctx) {
    const H = window.__hs, L = H && H.last, z = (n) => new Array(n).fill(0);
    const lm = z(126), hand = z(8), pinch = z(8), vel = z(8), norm = z(8), cur = z(8), meter = z(34), ev = z(NEV * 4);
    const U = { uDAtlas: ctx.state.atlas, uDLm: lm, uDHand: hand, uDPinch: pinch, uDVel: vel, uDNorm: norm, uDCursor: cur, uDMeter: meter, uDEvents: ev, uDFrame: [0.5, 0.5, 0, 0], uDFrameRot: [0, 0] };
    if (!L) return U;
    const st = L.st, s = st.signals;
    [st.L, st.R].forEach((T, h) => {
      const sfx = h ? 'R' : 'L'; METERS.forEach((n, i) => { meter[h * 14 + i] = s[n + sfx] ?? 0; });
      if (!T) return;
      for (let i = 0; i < 21; i++) { lm[(h * 21 + i) * 3] = T.lm[i * 3]; lm[(h * 21 + i) * 3 + 1] = T.lm[i * 3 + 1]; lm[(h * 21 + i) * 3 + 2] = T.presence; }
      hand.splice(h * 4, 4, T.presence, T.pinched ? 1 : 0, Math.max(0, POSES.indexOf(T.pose)), T.poseConf || 0);
      pinch.splice(h * 4, 4, T.pinchPoint[0], T.pinchPoint[1], T.gap, T.size);
      vel.splice(h * 4, 4, T.center[0], T.center[1], T.velUv[0], T.velUv[1]);
      norm.splice(h * 4, 4, T.normal[0], T.normal[1], T.normal[2], T.facing);
      cur.splice(h * 4, 4, T.cursor[0], T.cursor[1], T.pose === 'point' ? 1 : 0, 0);
    });
    TWO.forEach((n, i) => { meter[28 + i] = s[n] ?? 0; });
    const F = st.two.frame; if (F.on) { U.uDFrame = [F.cx, F.cy, F.w, F.h]; U.uDFrameRot = [F.angle, Math.min(1, F.conf * 1.5)]; }
    // every core event, newest first (the layer's own log filters some out; the debug view shows all of them)
    const log = (ctx.state.log ||= []); if (st.first || (log.length && log[log.length - 1].t > st.t)) log.length = 0;
    for (const e of st.events) log.push({ t: st.t, i: EVENTS.indexOf(e.type), pose: e.pose ? POSES.indexOf(e.pose) : -1, hand: e.hand === 'L' ? 1 : e.hand === 'R' ? 2 : 0 });
    if (log.length > 40) log.splice(0, log.length - 40);
    const recent = log.filter(e => e.i >= 0).slice(-NEV).reverse();
    recent.forEach((e, k) => { const age = st.t - e.t; ev.splice(k * 4, 4, e.i, Math.max(0.28, 1 - age / 2.5), e.pose, e.hand); });
    return U;
  },
};
