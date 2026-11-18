// hand-signal core — landmarks in, signals / poses / events out. Pure JS (browser + node), no DOM.
// Spec: breakdowns/hand-signal.md. Test rig: lab/handsignal/test.mjs.
//
// Input per frame: raw MediaPipe hands  [{ lm: [[x,y,z] x21]  image space, x right, y DOWN, 0..1
//                                          world: [[x,y,z] x21] metres, x right, y DOWN, z away from camera, origin ~hand centre
//                                          handedness: 'Left'|'Right', score }]
// Output space: vUv (x right, y UP, 0..1) for 2D; camera space for 3D (x right, y up, z forward, metres).
// "Height units" (hu) = fraction of the image height, x multiplied by the aspect, so a distance means the same in x and y.

import { clamp, lerp, smoothstep, sub, add, mul, dot, cross, len, norm, angleBetween, wrapPi, OneEuro, OneEuro1, QuatEuro, RunRange, qFromBasis, qRotate, qAngle, qSlerp } from './filters.js';

export const POSES = ['none', 'open', 'fist', 'point', 'peace', 'thumbsup', 'pinch', 'L', 'horns', 'ok'];
export const EVENTS = ['swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown', 'pinchStart', 'pinchEnd', 'pinchTap', 'pinchTapSingle', 'doublePinch', 'grab', 'release', 'dwell', 'clap', 'poseEnter', 'poseLeave', 'handEnter', 'handLeave'];
const PALM = [0, 5, 9, 13, 17];
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const TIPS = [4, 8, 12, 16, 20];
const PALM_BONES = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17], [5, 17]];

// ---------------------------------------------------------------- constants (every number in the spec lives here)
export const K = {
  focal: 1.2,                 // pinhole focal length in image heights (vertical FOV 45 deg; 16:9 -> horizontal 73 deg)
  // one-euro constants per signal class: [minCutoff Hz, beta, dCutoff Hz]
  fLm: [1.6, 12, 1],          // image landmarks, hu          (jitter ~0.002 hu at rest, speeds up to 3 hu/s)
  fWorld: [2.5, 40, 1],       // world landmarks, metres      (jitter ~1.5 mm, speeds up to 1 m/s)
  fCenter: [1.2, 8, 1],       // palm centre, hu
  fShape: [2.0, 3.0, 1],      // pinch distance + curls, dimensionless 0..~4
  fRoll: [1.0, 1.5, 1],       // in-plane roll, rad
  fQuat: [0.8, 1.2, 1],       // palm orientation quaternion, rad/s
  fDepth: [0.5, 2.0, 1],      // log(depth metres), after a median-of-5 and a slew limit
  depthSlew: 1.5,             // ln(m)/s: 0.75 m/s at half a metre. The landmarker's 3-5 frame pose flips on side-on hands read as 2.5 m/s lunges
  quatSlew: 10,               // rad/s on the palm orientation
  curlSlew: 10,               // normalised curl / s: a finger cannot go straight -> fist in under ~80 ms; landmark snaps can
  fCursor: [0.9, 6, 1],       // pointing cursor, hu
  velTau: 0.05,               // s, EMA on the derivative of the filtered centre
  // tracking
  matchGate: 0.45,            // hu; a detection further than this from a track's prediction starts a new track
  xfade: 0.3,                 // s: cross-fade whenever the hand behind a signal name changes (full range in 0.3 s peaks at 0.17 / frame)
  speedSlew: 9,               // /s: the speed signal reaches full scale in ~110 ms at the fastest
  rollSlew: 14,               // rad/s
  teleport: 0.22,             // hu per 1/30 s (6.6 hu/s) with no run-up = not a hand movement
  reacquire: 3.0,             // hu/s the gate widens while a track is lost (cap +0.55)
  sidePenalty: 0.12,          // hu-equivalent cost of a handedness mismatch in assignment
  dedupe: 0.6,                // x hand size: two detections closer than this are one hand
  confirm: 0.06,              // s a new track must persist before it exists (kills one-frame ghosts on the face)
  attack: 0.12,               // s presence ramp-in
  hold: 0.25,                 // s lost hand is held frozen
  ease: 0.40,                 // s then eased to rest
  sideTau: 0.5,               // s handedness vote integrator
  sideFlip: 0.4,              // vote must cross this far past zero to flip a track's side
  minScore: 0.5,              // below this, poses/events are gated (continuous signals still update)
  edge: 0.04,                 // hu from the frame border where confidence is ramped down
  // pinch
  pinchLo: 0.22, pinchHi: 1.0,  // priors on thumb-index distance / hand size (touching .. open), auto-calibrated
  pinchOn: 0.10, pinchOff: 0.26, // latch thresholds in calibrated gap units (0 touching .. 1 open)
  pinchDebounce: 0.035,       // s the off-condition must hold before the latch opens
  // curl (sum of joint flexion angles, rad): index..pinky straight <= 1.45, fist >= 2.70; thumb 0.55 .. 1.15
  curlLo: 1.45, curlHi: 2.70, thumbLo: 0.55, thumbHi: 1.15,
  // poses
  poseOn: 0.62, poseOff: 0.38, poseSwitch: 0.22, poseHold: 0.09, poseLeaveHold: 0.12,
  // events
  swipeStart: 0.9, swipeStop: 0.45, swipePeak: 1.4, swipeTravel: 0.16, swipeMaxDur: 0.5, swipeAxis: 1.5,
  swipeRefractory: 0.5, swipeReturnLock: 0.7, swipeMinAge: 0.3, swipeSizeRef: 0.16,
  tapMaxDur: 0.35, tapMaxMove: 0.06, doubleWindow: 0.5, doubleMaxDist: 0.14,
  dwellRadius: 0.035, dwellTime: 0.8,
  clapDist: 1.7, clapSpeed: 0.9, clapRefractory: 0.6,
  // rest values the bus eases to when a hand is lost
  rest: { pinch: 0, gap: 0, open: 0, x: 0.5, y: 0.5, depth: 0.5, roll: 0.5, yaw: 0.5, pitch: 0.5, speed: 0, curl: 0, reachX: 0.5, reachY: 0.5, cursorX: 0.5, cursorY: 0.5 },
};

const NEAR = [Math.log(0.25), Math.log(0.8)];
const swap = (s) => (s === 'L' ? 'R' : 'L');
let NEXT_ID = 1;

class Track {
  constructor(t, k) {
    this.id = NEXT_ID++; this.born = t; this.lastSeen = t; this.seen = 0; this.vote = 0; this.side = 'R'; this.forced = null;
    this.state = 'new'; this.presence = 0; this.live = true; this.conf = 0; this.score = 0;
    this.fLm = new OneEuro(63, ...k.fLm); this.fWorld = new OneEuro(63, ...k.fWorld); this.fCenter = new OneEuro(2, ...k.fCenter);
    this.fShape = new OneEuro(8, ...k.fShape); this.fRoll = new OneEuro1(...k.fRoll); this.fQuat = new QuatEuro(...k.fQuat);
    this.fDepth = new OneEuro1(...k.fDepth); this.fCursor = new OneEuro(2, ...k.fCursor);
    this.c = [0, 0]; this.vel = [0, 0]; this.size = 0.15; this.rollRaw = 0; this.rollUnwrapped = 0;
    // signals
    this.lm = new Float32Array(63); this.world = new Float32Array(63);
    this.center = [0.5, 0.5]; this.pinchRaw = 1; this.gap = 1; this.pinch = 0; this.pinched = false; this.pinchOffT = 0;
    this.curl = [0, 0, 0, 0, 0]; this.open = 0; this.roll = 0; this.pitch = 0; this.yaw = 0; this.facing = 1;
    this.normal = [0, 0, -1]; this.quat = [0, 0, 0, 1]; this.depthM = 0.6; this.depth = 0.5; this.pos3 = [0, 0, 0.6];
    this.tips = TIPS.map(() => [0.5, 0.5]); this.pinchPoint = [0.5, 0.5]; this.pinchPoint3 = [0, 0, 0.6];
    this.speed = 0; this.velUv = [0, 0]; this.ray = { o: [0, 0, 0.6], d: [0, 0, -1] }; this.cursor = [0.5, 0.5];
    this.depthConf = 0; this.reach = [0.5, 0.5]; this.thumbOut = 0; this.thumbAng = 0; this.shH = []; this.zH = []; this.zSlew = null; this.idxFast = 0; this.curlInit = false; this.quatInit = false;
    // pose
    this.pose = 'none'; this.poseConf = 0; this.poseT = t; this.poseScores = {}; this.cand = 'none'; this.candT = t; this.lowT = 0;
    // events
    this.sw = null; this.swLast = { t: -9, dir: '' }; this.pinchT = 0; this.pinchC = [0, 0]; this.lastTap = { t: -9, c: [0, 0] }; this.pendingTap = null;
    this.dwellAnchor = null; this.dwellT = 0; this.dwell = 0; this.dwellFired = false; this.grabT = -1;
  }
}

export class HandSignals {
  constructor(opts = {}) {
    this.k = { ...K, ...opts }; this.tracks = []; this.t = 0; this.aspect = 16 / 9; this.mirrored = false;
    this.cal = {
      pinch: new RunRange({ lo: this.k.pinchLo, hi: this.k.pinchHi, qLo: 0.1, qHi: 0.9, rateLo: 0.25, loBounds: [0.16, 0.26], hiBounds: [0.72, 1.3] }),
      spread: new RunRange({ lo: 0.18, hi: 0.95, loBounds: [0.1, 0.35], hiBounds: [0.5, 1.7] }),
      depth: new RunRange({ lo: Math.log(0.32), hi: Math.log(0.85), loBounds: [Math.log(0.15), Math.log(0.6)], hiBounds: [Math.log(0.5), Math.log(2.5)], minSpan: 0.45 }),
      reachX: new RunRange({ lo: 0.2, hi: 0.8, loBounds: [0.02, 0.4], hiBounds: [0.6, 0.98], minSpan: 0.25 }),
      reachY: new RunRange({ lo: 0.25, hi: 0.8, loBounds: [0.02, 0.45], hiBounds: [0.55, 0.98], minSpan: 0.22 }),
    };
    this.two = this._emptyTwo(); this.clapT = -9; this.prevDist = null; this.closing = 0; this.state = null;
    this.fTwist = new OneEuro1(...this.k.fRoll); this.twistUnwrapped = 0; this.twistRaw = null;
  }
  reset() { this.px = null; this.lastOut = null; this.primaryId = 0; this.tracks = []; this.two = this._emptyTwo(); this.prevDist = null; this.twistRaw = null; this.fTwist.reset(); for (const c in this.cal) this.cal[c].reset(); }
  _emptyTwo() { return { on: false, presence: 0, spread: 0, spread01: 0, spreadM: 0, mid: [0.5, 0.5], twist: 0, twist01: 0.5, depthDiff: 0, depthDiff01: 0.5, push01: 0.5,
    frame: { on: false, conf: 0, strict: 0, cx: 0.5, cy: 0.5, w: 0, h: 0, angle: 0, corners: [[0, 0], [0, 0]] } }; }

  // raw: array of MediaPipe hands for this frame. t seconds (monotonic). Returns the state object (also kept in this.state).
  update(raw, t, aspect = this.aspect, mirrored = this.mirrored) {
    const k = this.k; const dt = clamp(t - this.t, 1e-3, 0.1); const first = this.state === null; this.t = t; this.aspect = aspect; this.mirrored = mirrored;
    const events = []; const emit = (type, tr, extra = {}) => events.push({ type, hand: tr ? tr.side : null, id: tr ? tr.id : 0, t, ...extra });

    // ---- detections: centre, size, side label, dedupe
    let det = (raw || []).filter(h => h && h.lm && h.lm.length >= 21).map(h => {
      let cx = 0, cy = 0; for (const i of PALM) { cx += h.lm[i][0] * aspect / 5; cy += h.lm[i][1] / 5; }
      const size = Math.max(Math.hypot((h.lm[9][0] - h.lm[0][0]) * aspect, h.lm[9][1] - h.lm[0][1]), 1e-3);
      // MediaPipe names the anatomical hand as seen in an UNMIRRORED image; in a mirrored (selfie) view the label is swapped.
      const lab = (h.handedness || 'Right')[0] === 'L' ? 'L' : 'R';
      return { h, c: [cx, cy], size, side: mirrored ? swap(lab) : lab, score: h.score ?? 1 };
    });
    det.sort((a, b) => b.score - a.score);
    det = det.filter((d, i) => !det.slice(0, i).some(e => Math.hypot(d.c[0] - e.c[0], d.c[1] - e.c[1]) < k.dedupe * Math.max(d.size, e.size))).slice(0, 2);

    // ---- assignment (continuity first, handedness as a tie-breaker)
    const tr = this.tracks; const pred = (T) => { const a = Math.min(t - T.lastSeen, 0.12); return [T.c[0] + T.vel[0] * a, T.c[1] + T.vel[1] * a]; };
    const cost = (T, d) => { const p = pred(T); const dist = Math.hypot(p[0] - d.c[0], p[1] - d.c[1]); const gate = k.matchGate + Math.min(Math.max(t - T.lastSeen - 0.05, 0) * k.reacquire, 0.55);   // a lost hand may reappear further away
      return dist > gate ? 1e3 : dist + (T.seen > 3 && T.side !== d.side ? k.sidePenalty * d.score : 0); };
    const match = new Map();
    if (tr.length && det.length) {
      let best = null;
      const opts = [];
      for (let a = -1; a < det.length; a++) for (let b = -1; b < det.length; b++) { if (a === b && a !== -1) continue; if (tr.length < 2 && b !== -1) continue; opts.push([a, b]); }
      for (const [a, b] of opts) {
        let c = 0; const pairs = [[tr[0], a], [tr[1], b]];
        for (const [T, i] of pairs) { if (!T) continue; c += i === -1 ? 0.6 : cost(T, det[i]); }
        if (!best || c < best.c) best = { c, a, b };
      }
      if (best.a !== -1 && cost(tr[0], det[best.a]) < 1e3) match.set(tr[0], det[best.a]);
      if (tr[1] && best.b !== -1 && cost(tr[1], det[best.b]) < 1e3) match.set(tr[1], det[best.b]);
    }
    const used = new Set(match.values());
    for (const d of det) {
      if (used.has(d)) continue;
      // a person has one hand per side: an unmatched (held / easing) track of the same side is stale the moment that side reappears elsewhere
      let i = tr.findIndex(T => !match.has(T) && T.state !== 'live' && T.side === d.side);
      if (i < 0 && tr.length >= 2) { i = tr.findIndex(T => !match.has(T) && T.state !== 'live'); if (i < 0) continue; }
      if (i >= 0) { if (tr[i].state !== 'new') { if (tr[i].pinched) { tr[i].pinched = false; emit('pinchEnd', tr[i], { lost: true, dur: t - tr[i].pinchT }); } emit('handLeave', tr[i]); } tr.splice(i, 1); }
      const T = new Track(t, k); T.c = d.c.slice(); T.side = d.side; T.vote = (d.side === 'R' ? 1 : -1) * 0.6 * d.score; tr.push(T); match.set(T, d);
    }

    // ---- per-track update
    for (const T of tr) {
      const d = match.get(T);
      if (d) {
        const gapT = t - T.lastSeen; T.lastSeen = t; T.seen++; T.gapT = gapT;
        if (T.state === 'ease' || (T.state === 'hold' && gapT > k.hold)) { /* re-acquired: keep filters, presence ramps back */ }
        if (T.state === 'new') { if (t - T.born >= k.confirm) { T.state = 'live'; emit('handEnter', T); } }
        else { if (T.state !== 'live') T.reacqT = t; T.state = 'live'; }
        T.live = true; T.score = d.score;
        // teleport: the detection sits further from the track than any hand travels in a frame (a cut, or the detector hopping to
        // another hand). Position filters restart there, velocity is zeroed (no phantom swipe) and the bus cross-fades.
        const jump = Math.hypot(d.c[0] - T.c[0], d.c[1] - T.c[1]);
        if (T.seen > 2 && jump > k.teleport * Math.max(gapT, dt) / (1 / 30) && jump > 4 * (T.speed * gapT + 0.04)) { T.fCenter.reset(); T.fLm.reset(); T.fCursor.reset(); T.vel = [0, 0]; T.sw = null; T.reacqT = t; T.dwellAnchor = null; }
        this._measure(T, d, dt, aspect);
      } else {
        T.live = false; T.seen = Math.max(0, T.seen - 1);
        const lost = t - T.lastSeen;
        if (T.state === 'new') T.state = 'dead';
        else if (lost <= k.hold) T.state = 'hold';
        else if (lost <= k.hold + k.ease) {
          if (T.state !== 'ease') {            // hold expired: latches open, pose drops; continuous values ease
            T.state = 'ease';
            if (T.pinched) { T.pinched = false; emit('pinchEnd', T, { lost: true, dur: t - T.pinchT }); }
            if (T.pose !== 'none') { emit('poseLeave', T, { pose: T.pose, lost: true }); T.pose = 'none'; T.poseConf = 0; }
            T.sw = null; T.dwellAnchor = null; T.dwell = 0;
          }
        } else { T.state = 'dead'; emit('handLeave', T); }
        T.vel = [T.vel[0] * 0.6, T.vel[1] * 0.6]; T.velUv = [T.velUv[0] * 0.6, T.velUv[1] * 0.6]; T.speed *= 0.6;
      }
      // presence envelope
      const lost = t - T.lastSeen;
      const target = T.state === 'live' ? 1 : T.state === 'hold' ? T.presence : T.state === 'ease' ? 1 - smoothstep(0, 1, (lost - k.hold) / k.ease) : 0;
      if (T.state === 'live') T.presence = Math.min(1, T.presence + dt / k.attack); else if (T.state === 'ease') T.presence = Math.min(T.presence, target); else if (T.state !== 'hold') T.presence = 0;
      T.age = t - T.born;
    }
    this.tracks = tr.filter(T => T.state !== 'dead');

    // ---- stable handedness: integrate votes, flip only with conviction, never two of the same side
    const live = this.tracks.filter(T => T.state !== 'new');
    for (const T of this.tracks) {
      const d = match.get(T); if (d) T.vote += ((d.side === 'R' ? 1 : -1) * d.score - T.vote) * (1 - Math.exp(-dt / k.sideTau));
      if (this.tracks.length === 1) { if (T.side === 'R' && T.vote < -k.sideFlip) T.side = 'L'; else if (T.side === 'L' && T.vote > k.sideFlip) T.side = 'R'; }
    }
    if (this.tracks.length === 2) {
      // two hands are always one L and one R. Which is which is decided jointly from the DIFFERENCE of their votes, with
      // hysteresis, so two tracks that both get labelled the same side keep the assignment they have instead of trading it.
      const [a, b] = this.tracks, dv = a.vote - b.vote;
      if (a.side === b.side) { const young = a.born > b.born ? a : b; young.side = swap(young.side); }
      if (dv > k.sideFlip && a.side === 'L') { a.side = 'R'; b.side = 'L'; } else if (dv < -k.sideFlip && a.side === 'R') { a.side = 'L'; b.side = 'R'; }
    }

    // ---- poses + events on confirmed tracks
    for (const T of live) {
      const gate = T.live && T.conf > 0.5;
      this._pinchLatch(T, t, dt, emit, gate);
      this._pose(T, t, dt, emit, gate);
      this._events(T, t, dt, emit, gate);
    }
    this._two(live, t, dt, emit);

    const L = live.find(T => T.side === 'L') || null, R = live.find(T => T.side === 'R') || null;
    // primary = the hand that is doing something: pinched first, then the longest-lived
    // sticky: the current primary keeps the role while it is live, unless the other hand pinches and it does not
    let primary = live.slice().sort((a, b) => (b.pinched - a.pinched) || (a.born - b.born))[0] || null;
    const curP = live.find(T => T.id === this.primaryId); if (curP && curP.live && primary && (curP.pinched || !primary.pinched)) primary = curP;
    this.primaryId = primary ? primary.id : 0;
    this.state = { t, dt, aspect, mirrored, focal: k.focal, count: live.filter(T => T.live).length, hands: live, L, R, primary, two: this.two, events, signals: null, first };
    this.state.signals = this._signals(this.state);
    return this.state;
  }

  // ---------------------------------------------------------------- per-hand measurement
  _measure(T, d, dt, aspect) {
    const k = this.k, h = d.h; const f = k.focal;
    const rawI = new Float64Array(63), rawW = new Float64Array(63);
    for (let i = 0; i < 21; i++) { rawI[i * 3] = h.lm[i][0] * aspect; rawI[i * 3 + 1] = h.lm[i][1]; rawI[i * 3 + 2] = h.lm[i][2] * aspect;
      const w = h.world && h.world[i] ? h.world[i] : [0, 0, 0]; rawW[i * 3] = w[0]; rawW[i * 3 + 1] = -w[1]; rawW[i * 3 + 2] = w[2]; }   // world -> y up
    const I = T.fLm.filter(rawI, dt), W = T.fWorld.filter(rawW, dt);
    const pI = (i) => [I[i * 3], I[i * 3 + 1], I[i * 3 + 2]], pW = (i) => [W[i * 3], W[i * 3 + 1], W[i * 3 + 2]];
    const rW = (i) => [rawW[i * 3], rawW[i * 3 + 1], rawW[i * 3 + 2]];
    for (let i = 0; i < 21; i++) { T.lm[i * 3] = I[i * 3] / aspect; T.lm[i * 3 + 1] = 1 - I[i * 3 + 1]; T.lm[i * 3 + 2] = I[i * 3 + 2]; }
    T.world.set(W);

    // centre + velocity (hu, y down internally; velUv is y up, in hu/s)
    const pc = T.fCenter.x ? [T.fCenter.x[0], T.fCenter.x[1]] : null;
    const c = T.fCenter.filter(d.c, dt); T.c = [c[0], c[1]];
    if (pc) { const a = 1 - Math.exp(-dt / k.velTau); const dv = Math.max(dt, T.gapT || dt);   // after a dropout the move happened over the whole gap, not one frame
      T.vel = [T.vel[0] + a * ((c[0] - pc[0]) / dv - T.vel[0]), T.vel[1] + a * ((c[1] - pc[1]) / dv - T.vel[1])]; }
    T.velUv = [T.vel[0], -T.vel[1]]; T.speed = Math.hypot(T.vel[0], T.vel[1]);
    { const m = k.speedSlew * dt; T.speed01 = (T.speed01 || 0) + clamp(clamp(T.speed / 2.5) - (T.speed01 || 0), -m, m); }   // the SIGNAL (events use T.speed raw)
    T.center = [c[0] / aspect, 1 - c[1]]; T.size = lerp(T.size, d.size, T.seen <= 1 ? 1 : 0.3);

    // confidence: detector score x distance from the frame edge x track age
    const ex = Math.min(T.center[0], 1 - T.center[0]) * aspect, ey = Math.min(T.center[1], 1 - T.center[1]);
    T.conf = clamp((d.score - 0.3) / 0.4) * smoothstep(0, k.edge, Math.min(ex, ey)) * (T.state === 'new' ? 0 : 1);

    // depth: similarity-fit scale between world xy (metres) and image xy (hu) over all 21 landmarks -> Z = f / scale
    let mi = [0, 0], mw = [0, 0]; for (let i = 0; i < 21; i++) { mi[0] += rawI[i * 3] / 21; mi[1] += rawI[i * 3 + 1] / 21; mw[0] += rawW[i * 3] / 21; mw[1] += rawW[i * 3 + 1] / 21; }
    let vi = 0, vw = 0; for (let i = 0; i < 21; i++) { vi += (rawI[i * 3] - mi[0]) ** 2 + (rawI[i * 3 + 1] - mi[1]) ** 2; vw += (rawW[i * 3] - mw[0]) ** 2 + (rawW[i * 3 + 1] - mw[1]) ** 2; }
    const hasWorld = vw > 1e-8; const scale = hasWorld ? Math.sqrt(vi / vw) : d.size / 0.092;
    const z1 = Math.log(clamp(f / Math.max(scale, 1e-3), 0.08, 5));
    // v2 fusion (calibration-free, no per-user step). Three estimates of ln Z from the same frame:
    //   z1  similarity fit over all 21 landmarks (above): best when the world pose is right, wild when a finger chain flips
    //   z2  the same fit over the RIGID palm only (wrist + four knuckles): blind to finger flips, noisier when the palm is edge-on
    //   z3  hand size alone: the most in-plane palm bone, image length against its 3D world length. Uses no world ORIENTATION,
    //       so it survives the landmarker's side-on pose flips; biased far when the palm is tilted on both axes.
    // The median of the three is the estimate; their disagreement is the confidence (T.depthConf, 0..1).
    let zRaw = z1, zc = 0;
    if (hasWorld) {
      let pi = [0, 0], pw = [0, 0]; for (const i of PALM) { pi[0] += rawI[i * 3] / 5; pi[1] += rawI[i * 3 + 1] / 5; pw[0] += rawW[i * 3] / 5; pw[1] += rawW[i * 3 + 1] / 5; }
      let qi = 0, qw = 0; for (const i of PALM) { qi += (rawI[i * 3] - pi[0]) ** 2 + (rawI[i * 3 + 1] - pi[1]) ** 2; qw += (rawW[i * 3] - pw[0]) ** 2 + (rawW[i * 3 + 1] - pw[1]) ** 2; }
      const z2 = qw > 1e-9 ? Math.log(clamp(f / Math.max(Math.sqrt(qi / qw), 1e-3), 0.08, 5)) : z1;
      let best = 0; for (const [a, b] of PALM_BONES) { const li = Math.hypot(rawI[a * 3] - rawI[b * 3], rawI[a * 3 + 1] - rawI[b * 3 + 1]);
        const lw = Math.hypot(rawW[a * 3] - rawW[b * 3], rawW[a * 3 + 1] - rawW[b * 3 + 1], rawW[a * 3 + 2] - rawW[b * 3 + 2]); if (lw > 1e-4) best = Math.max(best, li / lw); }
      const z3 = best > 0 ? Math.log(clamp(f / best, 0.08, 5)) : z1;
      const m3 = [z1, z2, z3].sort((p, q) => p - q); zRaw = m3[1];
      // palm facing from the raw world landmarks (0 = edge-on): an edge-on palm has almost no image area to measure
      const pa = sub(rW(5), rW(17)), pb = sub(rW(9), rW(0)), pn = norm(cross(pa, pb));
      // agreement: the three differ by a steady ~0.1 on real hands (perspective on the fingers), so only spread beyond that counts
      zc = Math.exp(-Math.max(0, m3[2] - m3[0] - 0.14) / 0.22) * (0.6 + 0.4 * smoothstep(0.1, 0.5, Math.abs(pn[2])));
    } else zc = 0.3;                                                   // no world landmarks: hand size only
    T.depthConf = T.depthConf + (zc * T.conf - T.depthConf) * (1 - Math.exp(-dt / 0.15));
    T.zH.push(zRaw); if (T.zH.length > 5) T.zH.shift(); const zs = T.zH.slice().sort((p, q) => p - q), zMed = zs[zs.length >> 1];
    T.zSlew = T.zSlew === null ? zMed : T.zSlew + clamp(zMed - T.zSlew, -k.depthSlew * dt, k.depthSlew * dt);
    const logZ = T.fDepth.filter(T.zSlew, dt);
    T.depthM = Math.exp(logZ); if (T.conf > 0.5) this.cal.depth.update(logZ, dt);
    T.depth = 1 - this.cal.depth.norm(logZ);                         // 1 = near
    const to3 = (u, v, Z) => [(u - 0.5) * aspect / f * Z, (v - 0.5) / f * Z, Z];
    T.pos3 = to3(T.center[0], T.center[1], T.depthM);

    // shape: pinch distance and curls from RAW world landmarks, then one filter stage
    const S = Math.max(len(sub(rW(9), rW(0))), 1e-4);
    const sh = new Float64Array(8);
    sh[0] = hasWorld ? len(sub(rW(4), rW(8))) / S : Math.hypot(rawI[12] - rawI[24], rawI[13] - rawI[25]) / d.size;
    sh[1] = angleBetween(sub(rW(2), rW(1)), sub(rW(3), rW(2))) + angleBetween(sub(rW(3), rW(2)), sub(rW(4), rW(3)));
    for (let fi = 1; fi < 5; fi++) { const F = FINGERS[fi];
      sh[1 + fi] = angleBetween(sub(rW(F[0]), rW(0)), sub(rW(F[1]), rW(F[0]))) + angleBetween(sub(rW(F[1]), rW(F[0])), sub(rW(F[2]), rW(F[1]))) + angleBetween(sub(rW(F[2]), rW(F[1])), sub(rW(F[3]), rW(F[2]))); }
    sh[6] = len(sub(rW(4), rW(9))) / S;                               // thumb tip -> middle MCP (thumb out-ness)
    sh[7] = angleBetween(sub(rW(4), rW(2)), sub(rW(8), rW(5)));       // thumb vs index direction
    // curls and thumb measures go through a median-of-3 first: the landmarker throws one-frame finger glitches (a thumb curl
    // reading 0 -> 1 -> 0) that a one-euro passes straight through. The pinch distance is NOT delayed (it carries the tap timing).
    T.idxFast = clamp((sh[2] - k.curlLo) / (k.curlHi - k.curlLo));     // undelayed index curl, only for the pinch-latch guard
    const h1 = T.shH[0] || sh, h2 = T.shH[1] || h1; T.shH = [sh.slice(), h1];
    for (let i = 1; i < 8; i++) { const a = sh[i], b = h1[i], c = h2[i]; sh[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
    const s = T.fShape.filter(sh, dt);
    // auto-calibration: the floor learns only from near-touch samples, the ceiling only from clearly open ones, so hovering
    // at a half-closed grip never drags either end toward itself
    T.pinchRaw = s[0]; if (T.conf > 0.5) { const C = this.cal.pinch, sp = C.hi - C.lo; C.update(s[0], dt, s[0] < C.lo + 0.12 * sp, s[0] > C.lo + 0.55 * sp); }
    T.gap = this.cal.pinch.norm(s[0]); T.pinch = 1 - T.gap;
    const cs = k.curlSlew * dt, slew = (i, v) => { T.curl[i] = T.curlInit ? T.curl[i] + clamp(v - T.curl[i], -cs, cs) : v; };
    slew(0, clamp((s[1] - k.thumbLo) / (k.thumbHi - k.thumbLo)));
    for (let fi = 1; fi < 5; fi++) slew(fi, clamp((s[1 + fi] - k.curlLo) / (k.curlHi - k.curlLo)));
    T.curlInit = true;
    T.open = 1 - (T.curl[1] + T.curl[2] + T.curl[3] + T.curl[4]) / 4;
    T.thumbOut = smoothstep(0.64, 0.84, s[6]); T.thumbAng = s[7];

    // orientation. roll from the IMAGE (wrist -> middle MCP), robust; yaw/pitch from the world palm plane, filtered hard.
    const up2 = [I[27] - I[0], I[28] - I[1]];
    const roll = Math.atan2(up2[0], -up2[1]);                         // 0 = fingers up, + = tilted to the right of the image
    // The step is weighted by how much of the wrist->knuckle bone lies in the image (a hand pointing at the lens has no roll to
    // read) and slew-limited to K.rollSlew: a real wrist turn peaks near 12 rad/s, a foreshortened bone can spin 40.
    if (T.fRoll.x === null) { T.rollUnwrapped = roll; } else { const w = smoothstep(0.25, 0.6, Math.hypot(up2[0], up2[1]) / Math.max(T.size, 1e-4)), m = k.rollSlew * dt; T.rollUnwrapped += clamp(wrapPi(roll - T.rollRaw) * w, -m, m); }
    T.rollRaw = roll; T.roll = T.fRoll.filter(T.rollUnwrapped, dt);
    const side = T.side;                                              // user's side; anatomical side is the same in an unmirrored view
    const anat = this.mirrored ? swap(side) : side;                   // chirality as it appears in the image
    const a = norm(sub(pW(5), pW(17))), b = norm(sub(pW(9), pW(0)));
    let n = norm(cross(a, b)); if (anat === 'R') n = mul(n, -1);      // out of the palm (y-up camera space)
    // orthonormal palm frame: Y up the hand, Z out of the back of the hand (so a palm facing the camera is identity-ish), X = Y x Z
    const z = mul(n, -1); let y = norm(sub(b, mul(z, dot(b, z)))); const x = cross(y, z);
    // slew-limited: an edge-on palm has an ambiguous normal and the landmarker flips it 180 deg in one frame; a wrist cannot
    const qf = T.fQuat.filter(qFromBasis(x, y, z), dt), qa = T.quatInit ? qAngle(T.quat, qf) : 0, qmax = k.quatSlew * dt;
    T.quat = qa > qmax ? qSlerp(T.quat, qf, qmax / qa) : qf.slice(); T.quatInit = true;
    const nf = mul(qRotate(T.quat, [0, 0, 1]), -1); T.normal = nf; T.facing = -nf[2];
    T.yaw = Math.asin(clamp(nf[0], -1, 1));   // asin of the normal's x (not atan2(x, z)): stays continuous when the palm tips up / down or turns its back
    T.pitch = Math.asin(clamp(nf[1], -1, 1));

    // fingertips, pinch point, pointing ray, cursor
    for (let i = 0; i < 5; i++) { const q = TIPS[i]; T.tips[i] = [T.lm[q * 3], T.lm[q * 3 + 1]]; }
    T.pinchPoint = [(T.tips[0][0] + T.tips[1][0]) / 2, (T.tips[0][1] + T.tips[1][1]) / 2];
    const cw = [0, 0, 0]; for (const i of PALM) { cw[0] += W[i * 3] / 5; cw[1] += W[i * 3 + 1] / 5; cw[2] += W[i * 3 + 2] / 5; }
    const ppW = mul(add(pW(4), pW(8)), 0.5);
    T.pinchPoint3 = to3(T.pinchPoint[0], T.pinchPoint[1], T.depthM + (ppW[2] - cw[2]));
    const dir = norm(sub(pW(8), pW(5)));
    T.ray = { o: to3(T.tips[1][0], T.tips[1][1], T.depthM + (W[26] - cw[2])), d: dir };
    // cursor: the fingertip pushed on along the index finger AS SEEN IN THE IMAGE (knuckle -> tip, x1.8, about 1.4 hand sizes
    // for a finger lying in the image plane). Scale-free, shortens to the fingertip itself when the finger points at the lens
    // or curls, and has no 3D direction to flip.
    // The reach (tip-relative offset) is slew-limited to 4 hu/s: a finger that curls or glitches in one frame walks the cursor in, never throws it.
    let ox = (I[24] - I[15]) * 1.8, oy = (I[25] - I[16]) * 1.8;
    if (T.cuOff) { const ex = ox - T.cuOff[0], ey = oy - T.cuOff[1], e = Math.hypot(ex, ey), m = 4 * Math.max(dt, T.gapT || dt); if (e > m) { ox = T.cuOff[0] + ex / e * m; oy = T.cuOff[1] + ey / e * m; } }
    T.cuOff = [ox, oy];
    const cu = T.fCursor.filter([I[24] + ox, I[25] + oy], dt);
    T.cursor = [clamp(cu[0] / aspect), clamp(1 - cu[1])];
    if (T.conf > 0.5) { this.cal.reachX.update(T.center[0], dt); this.cal.reachY.update(T.center[1], dt); }
    T.reach = [this.cal.reachX.norm(T.center[0]), this.cal.reachY.norm(T.center[1])];
  }

  _pinchLatch(T, t, dt, emit, gate) {
    const k = this.k; if (!T.live) return;
    if (!T.pinched) {
      if (gate && T.gap < k.pinchOn && Math.max(T.curl[1], T.idxFast) < 0.88) { T.pinched = true; T.pinchT = t; T.pinchC = T.c.slice(); T.pinchOffT = 0; emit('pinchStart', T); }
    } else {
      if (T.gap > k.pinchOff) { T.pinchOffT += dt; } else T.pinchOffT = 0;
      if (T.pinchOffT >= k.pinchDebounce) {
        T.pinched = false; const dur = t - T.pinchT, move = Math.hypot(T.c[0] - T.pinchC[0], T.c[1] - T.pinchC[1]);
        emit('pinchEnd', T, { dur, move });
        if (dur <= k.tapMaxDur + k.pinchDebounce && move <= k.tapMaxMove) {
          const dbl = t - T.lastTap.t <= k.doubleWindow && Math.hypot(T.c[0] - T.lastTap.c[0], T.c[1] - T.lastTap.c[1]) <= k.doubleMaxDist;
          emit('pinchTap', T);
          if (dbl) { emit('doublePinch', T); T.lastTap = { t: -9, c: [0, 0] }; T.pendingTap = null; }
          else { T.lastTap = { t, c: T.c.slice() }; T.pendingTap = t; }
        }
      }
    }
    // a tap that was not followed by a second one becomes pinchTapSingle (for configs that bind both tap and double)
    if (T.pendingTap !== null && t - T.pendingTap > k.doubleWindow && !T.pinched) { T.pendingTap = null; emit('pinchTapSingle', T); }
  }

  _pose(T, t, dt, emit, gate) {
    const k = this.k; if (!T.live) return;
    const e = T.curl.map(c => 1 - c), up = (x) => smoothstep(0.35, 0.7, x), dn = (x) => 1 - smoothstep(0.25, 0.6, x);
    const I = up(e[1]), M = up(e[2]), R = up(e[3]), P = up(e[4]), i = dn(e[1]), m = dn(e[2]), r = dn(e[3]), p = dn(e[4]);
    const touch = 1 - smoothstep(k.pinchOn, k.pinchOff + 0.1, T.gap);
    const tOut = Math.max(T.thumbOut, smoothstep(0.75, 1.15, T.thumbAng) * smoothstep(0.5, 0.7, T.thumbOut + 0.3));
    // thumb pointing up in the image (thumb MCP -> tip), for thumbs-up
    const tx = T.lm[12] - T.lm[6], ty = T.lm[13] - T.lm[7]; const tUp = smoothstep(0.45, 0.8, ty / (Math.hypot(tx * this.aspect, ty) || 1));
    const iHard = smoothstep(0.6, 0.9, T.curl[1]);                    // a fist needs the index properly curled; a pinch never has that
    const four = Math.min(iHard, m, r, p);
    const sc = {
      open: Math.min(I, M, R, P) * (1 - touch),
      fist: four * (1 - tOut * tUp),
      point: I * Math.min(m, r, p) * (1 - tOut),
      L: I * Math.min(m, r, p) * tOut,
      peace: Math.min(I, M) * Math.min(r, p),
      horns: Math.min(I, P) * Math.min(m, r),
      thumbsup: four * tOut * tUp,
      ok: touch * Math.min(M, R, P),
    };
    sc.pinch = (T.pinched ? 1 : touch * 0.5) * (1 - sc.ok) * (1 - iHard);
    T.poseScores = sc;
    let best = 'none', bs = 0; for (const n in sc) if (sc[n] > bs) { bs = sc[n]; best = n; }
    if (!gate) { T.cand = T.pose; return; }
    const cur = T.pose, curS = cur === 'none' ? 0 : sc[cur];
    T.poseConf += ((cur === 'none' ? 0 : curS) - T.poseConf) * (1 - Math.exp(-dt / 0.1));
    // candidate must beat the threshold (and the current pose by a margin) continuously for poseHold
    const want = bs >= k.poseOn && best !== cur && (cur === 'none' || bs > curS + k.poseSwitch || curS < k.poseOff) ? best : null;
    if (want) { if (T.cand !== want) { T.cand = want; T.candT = t; } } else T.cand = cur;
    if (cur !== 'none' && curS < k.poseOff) T.lowT += dt; else T.lowT = 0;
    if (want && T.cand === want && t - T.candT >= k.poseHold) {
      if (cur !== 'none') emit('poseLeave', T, { pose: cur, dur: t - T.poseT });
      T.pose = want; T.poseT = t; T.poseConf = bs; T.lowT = 0; emit('poseEnter', T, { pose: want, from: cur });
      if (want === 'fist') { T.grabT = t; emit('grab', T); }
      if (cur === 'fist' && T.grabT >= 0) { emit('release', T, { dur: t - T.grabT, to: want }); T.grabT = -1; }
    } else if (cur !== 'none' && T.lowT >= k.poseLeaveHold) {
      emit('poseLeave', T, { pose: cur, dur: t - T.poseT }); T.pose = 'none'; T.lowT = 0;
      if (cur === 'fist' && T.grabT >= 0) { emit('release', T, { dur: t - T.grabT, to: 'none' }); T.grabT = -1; }
    }
  }

  _events(T, t, dt, emit, gate) {
    const k = this.k; if (!T.live) { T.sw = null; return; }
    // ---- swipe: a fast, axis-dominant stroke of the palm with enough travel. Thresholds scale with apparent hand size.
    const rel = clamp(T.size / k.swipeSizeRef, 0.6, 1.3);
    const vx = T.vel[0], vy = -T.vel[1], ax = Math.abs(vx), ay = Math.abs(vy), sp = T.speed;
    const dir = ax > ay * k.swipeAxis ? (vx > 0 ? 'Right' : 'Left') : ay > ax * k.swipeAxis ? (vy > 0 ? 'Up' : 'Down') : '';
    if (T.sw) {
      const s = T.sw;
      if (sp < k.swipeStop * rel || (dir && dir !== s.dir) || t - s.t0 > k.swipeMaxDur) T.sw = null;
      else { s.travel += Math.max(ax, ay) * dt; s.peak = Math.max(s.peak, sp);
        if (!s.fired && s.travel >= k.swipeTravel * rel && s.peak >= k.swipePeak * rel) {
          s.fired = true; const opp = { Left: 'Right', Right: 'Left', Up: 'Down', Down: 'Up' }[s.dir];
          const blocked = t - T.swLast.t < k.swipeRefractory || (T.swLast.dir === opp && t - T.swLast.t < k.swipeReturnLock);
          if (!blocked && gate && !T.pinched && T.age >= k.swipeMinAge) { T.swLast = { t, dir: s.dir }; emit('swipe' + s.dir, T, { speed: s.peak, travel: s.travel }); }
        } }
    }
    if (!T.sw && dir && sp >= k.swipeStart * rel) T.sw = { dir, t0: t, travel: 0, peak: sp, fired: false };

    // ---- dwell: the palm stays inside a small circle
    if (!T.dwellAnchor || Math.hypot(T.c[0] - T.dwellAnchor[0], T.c[1] - T.dwellAnchor[1]) > k.dwellRadius * Math.max(rel, 0.8)) { T.dwellAnchor = T.c.slice(); T.dwellT = t; T.dwellFired = false; }
    T.dwell = gate ? clamp((t - T.dwellT) / k.dwellTime) : 0; if (!gate) T.dwellT = t;
    if (T.dwell >= 1 && !T.dwellFired) { T.dwellFired = true; emit('dwell', T, { pose: T.pose }); }
  }

  _two(live, t, dt, emit) {
    const k = this.k, W = this.two, A = this.aspect;
    const L = live.find(T => T.side === 'L'), R = live.find(T => T.side === 'R');
    if (!L || !R) {
      // clap fallback: palms that were closing fast usually merge into one detection (or none)
      if (this.prevDist !== null && this.closing > k.clapSpeed && this.prevDist < 2.6 * this.prevSize && t - this.clapT > k.clapRefractory && t - this.prevT < 0.2) { this.clapT = t; emit('clap', null, { merged: true }); }
      W.on = false; W.presence = Math.max(0, W.presence - dt / k.ease); this.prevDist = null; this.twistRaw = null; W.frame.on = false; W.frame.conf *= 0.8;
      return;
    }
    const pair = L.id * 4096 + R.id; if (pair !== this.pair) { this.pair = pair; this.twistRaw = null; this.prevDist = null; this.twistSign = 0; }   // a different pair of hands: nothing carries over
    W.on = true; W.presence = Math.min(L.presence, R.presence);
    const dx = R.c[0] - L.c[0], dy = L.c[1] - R.c[1];               // y up
    const dist = Math.hypot(dx, dy); W.spread = dist;
    if (L.live && R.live && Math.min(L.conf, R.conf) > 0.5) this.cal.spread.update(dist, dt);
    W.spread01 = this.cal.spread.norm(dist); W.spreadM = len(sub(R.pos3, L.pos3));
    W.mid = [(L.center[0] + R.center[0]) / 2, (L.center[1] + R.center[1]) / 2];
    // twist: angle of the L->R line, unwrapped so a steering motion past +-180 keeps going
    // (measured from the way the pair first appeared: in an unmirrored view the user's left hand is on the image right)
    if (!this.twistSign) this.twistSign = dx >= 0 ? 1 : -1;
    const tw = Math.atan2(dy * this.twistSign, dx * this.twistSign);
    if (this.twistRaw === null) { this.twistUnwrapped = tw; this.fTwist.reset(); } else this.twistUnwrapped += wrapPi(tw - this.twistRaw);
    this.twistRaw = tw; W.twist = this.fTwist.filter(this.twistUnwrapped, dt); W.twist01 = clamp(0.5 + W.twist / (Math.PI * 2 / 3));
    W.depthDiff = R.depthM - L.depthM; W.depthDiff01 = clamp(0.5 + W.depthDiff / 0.5); W.push01 = (L.depth + R.depth) / 2;
    // director's frame: the web of each hand's thumb+index "L" marks opposite corners
    const corner = (T) => { const u = (T.lm[6] + T.lm[15]) / 2, v = (T.lm[7] + T.lm[16]) / 2; return [u, v]; };
    const ca = corner(L), cb = corner(R);
    // confidence: both index fingers extended and not pinching (strict = both hands score as an "L")
    const iness = (T) => smoothstep(0.35, 0.7, 1 - T.curl[1]) * smoothstep(0.2, 0.45, T.gap);
    const conf = Math.min(iness(L), iness(R)) * W.presence;
    W.frame.strict = Math.min(L.poseScores.L || 0, R.poseScores.L || 0) * W.presence;
    const F = W.frame; F.conf += (conf - F.conf) * (1 - Math.exp(-dt / 0.12));
    F.on = F.on ? F.conf > 0.3 : F.conf > 0.55;
    F.corners = [ca, cb]; F.cx = (ca[0] + cb[0]) / 2; F.cy = (ca[1] + cb[1]) / 2;
    // rotated rect: edge direction = mean index-finger direction of both hands, folded to 90 deg symmetry
    let sx = 0, sy = 0; for (const T of [L, R]) { const a = Math.atan2(T.lm[25] - T.lm[16], (T.lm[24] - T.lm[15]) * A); sx += Math.cos(4 * a); sy += Math.sin(4 * a); }
    let ang = Math.atan2(sy, sx) / 4; F.angle = Math.abs(ang) < 0.09 ? 0 : ang;      // 5 deg dead zone: snaps to axis-aligned
    const ex = (cb[0] - ca[0]) * A, ey = cb[1] - ca[1], cs = Math.cos(F.angle), sn = Math.sin(F.angle);
    F.w = Math.abs(ex * cs + ey * sn) / A; F.h = Math.abs(-ex * sn + ey * cs);
    // clap
    const size = (L.size + R.size) / 2;
    if (this.prevDist !== null) { const v = (this.prevDist - dist) / dt; this.closing += (v - this.closing) * 0.5; } else this.closing = 0;
    if (L.live && R.live && dist < k.clapDist * size && this.closing > k.clapSpeed && t - this.clapT > k.clapRefractory) { this.clapT = t; emit('clap', null, {}); }
    this.prevDist = dist; this.prevSize = size; this.prevT = t;
  }

  // flat 0..1 map. Per-hand names carry the side suffix (pinchL, pinchR); unsuffixed = primary hand. Lost hands ease to rest.
  _signals(st) {
    const k = this.k, r = k.rest, out = {}; const ease = (v, rest, p) => rest + (v - rest) * p;
    const put = (T, sfx) => {
      const p = T ? T.presence : 0, g = (f, rest) => ease(T ? f(T) : rest, rest, p);
      out['pinch' + sfx] = g(t => t.pinch, r.pinch); out['gap' + sfx] = g(t => t.gap, r.gap); out['open' + sfx] = g(t => t.open, r.open);
      out['x' + sfx] = g(t => t.center[0], r.x); out['y' + sfx] = g(t => t.center[1], r.y);
      out['reachX' + sfx] = g(t => t.reach[0], r.reachX); out['reachY' + sfx] = g(t => t.reach[1], r.reachY);
      out['depth' + sfx] = g(t => t.depth, r.depth);
      // v2: 'near' is depth without the running calibration (fixed 0.25 m .. 0.80 m, log scale); 'depthConf' says how far to trust either
      out['near' + sfx] = g(t => 1 - clamp((Math.log(t.depthM) - NEAR[0]) / (NEAR[1] - NEAR[0])), 0.5); out['depthConf' + sfx] = g(t => t.depthConf, 0);
      out['roll' + sfx] = g(t => clamp(0.5 + wrapPi(t.roll) / Math.PI), r.roll);
      out['yaw' + sfx] = g(t => clamp(0.5 + t.yaw / (Math.PI * 2 / 3)), r.yaw); out['pitch' + sfx] = g(t => clamp(0.5 + t.pitch / (Math.PI * 2 / 3)), r.pitch);
      out['speed' + sfx] = g(t => t.speed01, r.speed);
      out['cursorX' + sfx] = g(t => t.cursor[0], r.cursorX); out['cursorY' + sfx] = g(t => t.cursor[1], r.cursorY);
      for (let i = 0; i < 5; i++) out['curl' + i + sfx] = g(t => t.curl[i], r.curl);
      out['pinched' + sfx] = T && T.pinched ? 1 : 0; out['present' + sfx] = p; out['dwell' + sfx] = T ? T.dwell : 0;
      for (const n of POSES) if (n !== 'none') out['pose_' + n + sfx] = T && T.pose === n ? 1 : 0;
    };
    put(st.L, 'L'); put(st.R, 'R'); put(st.primary, '');
    const W = st.two, p = W.presence;
    out.spread = ease(W.spread01, 0, p); out.twist = ease(W.twist01, 0.5, p); out.midX = ease(W.mid[0], 0.5, p); out.midY = ease(W.mid[1], 0.5, p);
    out.push = ease(W.push01, 0.5, p); out.depthDiff = ease(W.depthDiff01, 0.5, p); out.both = p;
    out.frameX = W.frame.cx; out.frameY = W.frame.cy; out.frameW = clamp(W.frame.w); out.frameH = clamp(W.frame.h); out.frameOn = W.frame.on ? 1 : 0;
    // whenever the hand behind a name changes identity (primary role moves, a stale track is replaced, sides are re-decided)
    // that group of signals cross-fades from its last output over K.xfade instead of jumping
    const XF = (this.px ||= {}), last = this.lastOut || {};
    const TWO = /^(spread|twist|midX|midY|push|depthDiff)$/;
    for (const [sfx, T] of [['L', st.L], ['R', st.R], ['', st.primary], ['2', st.L && st.R ? { id: st.L.id * 4096 + st.R.id } : null]]) {
      const id = T ? T.id : 0, X = (XF[sfx] ||= { id, from: null, t: 0 });
      const mine = (n) => (sfx === '2' ? TWO.test(n) : (sfx ? n.endsWith(sfx) : !/[LR]$/.test(n) && !TWO.test(n)) && !/^(pinched|present|pose_|dwell|both|frame)/.test(n));
      // ...and the same when a held hand is found again somewhere else (it kept moving while it was lost)
      const re = sfx === '2' ? !!T && (st.L.reacqT === st.t || st.R.reacqT === st.t) : !!T && T.reacqT === st.t;
      if (!id && !(last[sfx === '2' ? 'both' : 'present' + sfx] > 0.05)) X.id = 0;   // nobody behind the name and the presence envelope has already eased it to rest
      else if (id !== X.id || re) { X.id = id; X.from = {}; X.t = st.t; for (const n in last) if (mine(n)) X.from[n] = last[n]; }
      if (X.from) { const u = smoothstep(0, 1, (st.t - X.t) / k.xfade); if (u >= 1) X.from = null; else for (const n in X.from) if (n in out) out[n] = lerp(X.from[n], out[n], u); }
    }
    this.lastOut = { ...out };
    return out;
  }
}
