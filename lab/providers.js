// vizvim fx-lab — ML providers (hands / person / depth). Booted only when asked for.
// Everything here works in IMAGE space of the harness source canvas (already mirrored for cameras):
// x right, y DOWN, 0..1. Conversion to vUv (y up) happens once, at the edges: landmark y -> 1 - y,
// rasters are row-flipped before upload. That single convention is what keeps things aligned.

const V = new URL('./vendor/', import.meta.url).href;

// ---------- one-euro filter ----------
class OneEuro {
  constructor(n, minCutoff = 1.5, beta = 10, dCutoff = 1) { this.n = n; this.mc = minCutoff; this.beta = beta; this.dc = dCutoff; this.x = null; this.dx = new Float32Array(n); }
  reset() { this.x = null; this.dx.fill(0); }
  filter(v, dt) {
    if (!this.x) { this.x = Float32Array.from(v); return this.x; }
    dt = Math.max(dt, 1e-3);
    const a = (c) => { const tau = 1 / (2 * Math.PI * c); return 1 / (1 + tau / dt); };
    const ad = a(this.dc);
    for (let i = 0; i < this.n; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      const al = a(this.mc + this.beta * Math.abs(this.dx[i]));
      this.x[i] += al * (v[i] - this.x[i]);
    }
    return this.x;
  }
}

let mpPromise = null;
async function mediapipe() {
  if (!mpPromise) mpPromise = (async () => {
    const MP = await import(V + 'mediapipe/vision_bundle.mjs');
    const fileset = await MP.FilesetResolver.forVisionTasks(V + 'mediapipe/wasm');
    return { MP, fileset };
  })();
  return mpPromise;
}
async function createTask(Cls, fileset, opts) {
  try { return [await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }), 'gpu']; }
  catch (e) { console.warn('mediapipe GPU delegate failed, using CPU', e); return [await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }), 'cpu']; }
}

// ---------- hands ----------
let HAND_UID = 0;
const PALM = [0, 5, 9, 13, 17];
const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
export class Hands {
  constructor(still) {
    this.still = still; this.ms = 0; this.ready = false; this.count = 0;
    this.slots = [0, 1].map(() => ({ on: false, f: new OneEuro(63), lm: new Float32Array(63), c: [0, 0], cf: new OneEuro(2, 1.2, 6), vel: [0, 0], pinch: 0, open: 0, size: 0, side: '', score: 0, raw: new Float32Array(63), world: null }));
    this.spread = 0;
    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: false });
    this.ts = 0;
  }
  async boot() {
    const { MP, fileset } = await mediapipe();
    [this.task, this.delegate] = await createTask(MP.HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: V + 'models/hand_landmarker.task' }, numHands: 2,
      runningMode: this.still ? 'IMAGE' : 'VIDEO', minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    });
    this.ready = true;
  }
  reset() { for (const s of this.slots) { s.on = false; s.f.reset(); s.cf.reset(); s.vel = [0, 0]; } this.count = 0; this.spread = 0; }
  // src: canvas (mirrored already). dt seconds since the previous update.
  update(src, dt) {
    if (!this.ready) return;
    const t0 = performance.now();
    let res;
    if (this.still) res = this.task.detect(src);
    else { this.ts = Math.max(this.ts + 1, Math.round(performance.now())); res = this.task.detectForVideo(src, this.ts); }
    this.ingest(res, src.width / src.height, dt);
    this.rasterMask(src.width, src.height);
    this.ms = performance.now() - t0;
  }
  // one detection result -> slots (assignment, one-euro, derived signals). Shared by the sync path above and LiveHands.
  ingest(res, aspect, dt) {
    this.raw = { landmarks: res.landmarks || [], worldLandmarks: res.worldLandmarks || [], handedness: res.handedness || [] };   // un-smoothed MediaPipe result, image space (y down)
    let det = (res.landmarks || []).map((lm, i) => {
      const c = [0, 0]; for (const k of PALM) { c[0] += lm[k].x / 5; c[1] += lm[k].y / 5; }
      return { lm, c, side: res.handedness?.[i]?.[0]?.categoryName || '', score: res.handedness?.[i]?.[0]?.score ?? 0, world: res.worldLandmarks?.[i] || null };
    }).slice(0, 2);
    // slot assignment: keep continuity with the previous frame, otherwise left-to-right on screen.
    const prevOn = this.slots.filter(s => s.on).length;
    let order;
    if (det.length === 0) order = [];
    else if (prevOn === 0) { det.sort((a, b) => a.c[0] - b.c[0]); order = det.map((d, i) => [i, d]); }
    else {
      const d2 = (s, d) => s.on ? (s.c[0] - d.c[0]) ** 2 * aspect * aspect + (s.c[1] - d.c[1]) ** 2 : 1e3;
      if (det.length === 1) {
        const k = (this.slots[0].on && this.slots[1].on) ? (d2(this.slots[0], det[0]) <= d2(this.slots[1], det[0]) ? 0 : 1) : (this.slots[0].on ? 0 : 1);
        order = [[k, det[0]]];
      } else {
        const a = d2(this.slots[0], det[0]) + d2(this.slots[1], det[1]), b = d2(this.slots[0], det[1]) + d2(this.slots[1], det[0]);
        order = a <= b ? [[0, det[0]], [1, det[1]]] : [[0, det[1]], [1, det[0]]];
      }
    }
    // a single hand always lives in slot 0 (contract: uHandCount==1 -> index 0 valid)
    if (order.length === 1 && order[0][0] === 1) { const s = this.slots; [s[0], s[1]] = [s[1], s[0]]; order[0][0] = 0; }
    const seen = [false, false];
    for (const [k, d] of order) {
      const s = this.slots[k]; seen[k] = true;
      const raw = new Float32Array(63);
      for (let i = 0; i < 21; i++) { raw[i * 3] = d.lm[i].x; raw[i * 3 + 1] = d.lm[i].y; raw[i * 3 + 2] = d.lm[i].z; }
      if (!s.on) { s.f.reset(); s.cf.reset(); s.vel = [0, 0]; s.uid = ++HAND_UID; }
      const f = s.f.filter(raw, dt); s.lm.set(f); s.raw = raw; s.world = d.world; s.score = d.score;
      const P = (i) => [f[i * 3] * aspect, f[i * 3 + 1], f[i * 3 + 2] * aspect];
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      let cx = 0, cy = 0; for (const i of PALM) { cx += f[i * 3] / 5; cy += f[i * 3 + 1] / 5; }
      const pc = s.on ? s.cf.x && [s.cf.x[0], s.cf.x[1]] : null;
      const c = s.cf.filter([cx, cy], dt);
      if (pc && dt > 0) { const vx = (c[0] - pc[0]) / dt, vy = (c[1] - pc[1]) / dt; s.vel = [s.vel[0] + 0.5 * (vx - s.vel[0]), s.vel[1] + 0.5 * (vy - s.vel[1])]; }
      s.c = [c[0], c[1]];
      s.size = Math.max(dist3(P(0), P(9)), 1e-4);
      s.pinch = dist3(P(4), P(8)) / s.size;
      let open = 0;
      for (const fi of FINGERS.slice(1)) { const r = dist3(P(fi[3]), P(0)) / Math.max(dist3(P(fi[0]), P(0)), 1e-4); open += Math.min(1, Math.max(0, (r - 1.15) / 0.75)) / 4; }
      s.open = open; s.side = d.side; s.on = true;
      s.size2d = Math.max(dist(P(0), P(9)), 1e-4);
    }
    for (let k = 0; k < 2; k++) if (!seen[k]) this.slots[k].on = false;
    this.count = order.length;
    this.spread = this.count === 2 ? Math.hypot(this.slots[0].c[0] - this.slots[1].c[0], this.slots[0].c[1] - this.slots[1].c[1]) : 0;
  }
  rasterMask(sw, sh) {
    const W = 384, H = Math.max(2, Math.round(W * sh / sw)), cv = this.maskCanvas, g = this.maskCtx;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    g.filter = 'none'; g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = g.strokeStyle = '#fff'; g.lineCap = g.lineJoin = 'round';
    for (let k = 0; k < this.count; k++) {
      const s = this.slots[k], p = (i) => [s.lm[i * 3] * W, s.lm[i * 3 + 1] * H];
      const size = s.size2d * H, lw = Math.max(2, size * 0.26);
      g.filter = `blur(${Math.max(1, size * 0.05).toFixed(1)}px)`;
      g.beginPath(); for (const i of [0, 1, 2, 5, 9, 13, 17]) { const q = p(i); g.lineTo(q[0], q[1]); } g.closePath();
      g.lineWidth = lw * 0.7; g.fill(); g.stroke();
      g.lineWidth = lw;
      for (const fi of FINGERS) { g.beginPath(); for (const i of fi) { const q = p(i); g.lineTo(q[0], q[1]); } g.stroke(); }
    }
    g.filter = 'none';
  }
  // uniforms in vUv space (y up)
  uniforms() {
    const hand = new Float32Array(126), center = new Float32Array(4), pinch = new Float32Array(2), open = new Float32Array(2), vel = new Float32Array(4);
    for (let k = 0; k < this.count; k++) {
      const s = this.slots[k];
      for (let i = 0; i < 21; i++) { hand[(k * 21 + i) * 3] = s.lm[i * 3]; hand[(k * 21 + i) * 3 + 1] = 1 - s.lm[i * 3 + 1]; hand[(k * 21 + i) * 3 + 2] = s.lm[i * 3 + 2]; }
      center[k * 2] = s.c[0]; center[k * 2 + 1] = 1 - s.c[1]; pinch[k] = s.pinch; open[k] = s.open; vel[k * 2] = s.vel[0]; vel[k * 2 + 1] = -s.vel[1];
    }
    return { uHandCount: this.count, uHand: hand, uHandCenter: center, uPinch: pinch, uOpen: open, uHandVel: vel, uSpread: this.spread };
  }
}

// ---------- person ----------
export class Person {
  constructor(still) { this.still = still; this.ms = 0; this.ready = false; this.has = false; this.w = 0; this.h = 0; this.data = null; this.ts = 0; this.version = 0; }
  async boot() {
    const { MP, fileset } = await mediapipe();
    [this.task, this.delegate] = await createTask(MP.ImageSegmenter, fileset, {
      baseOptions: { modelAssetPath: V + 'models/selfie_segmenter.tflite' },
      runningMode: this.still ? 'IMAGE' : 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    this.ready = true;
  }
  reset() { this.has = false; }
  update(src) {
    if (!this.ready) return;
    const t0 = performance.now();
    let res;
    if (this.still) res = this.task.segment(src);
    else { this.ts = Math.max(this.ts + 1, Math.round(performance.now())); res = this.task.segmentForVideo(src, this.ts); }
    const masks = res.confidenceMasks;
    if (masks && masks.length) {
      const m = masks[masks.length - 1], a = m.getAsFloat32Array(), w = m.width, h = m.height;
      if (!this.data || this.w !== w || this.h !== h) { this.data = new Float32Array(w * h); this.w = w; this.h = h; }
      for (let y = 0; y < h; y++) this.data.set(a.subarray(y * w, y * w + w), (h - 1 - y) * w);   // row-flip -> y up
      this.has = true; this.version++;
    }
    res.close?.();
    this.ms = performance.now() - t0;
  }
}

// ---------- depth ----------
export class Depth {
  constructor(still, longSide = 392) {
    this.still = still; this.long = longSide; this.blend = 0.6; this.ms = 0; this.ready = false; this.has = false; this.busy = false;
    this.w = 0; this.h = 0; this.data = null; this.lo = null; this.hi = null; this.version = 0; this.device = '';
    this.cv = document.createElement('canvas'); this.g = this.cv.getContext('2d', { willReadFrequently: true });
  }
  async boot() {
    const T = this.T = await import(V + 'transformers/transformers.min.js');
    T.env.allowRemoteModels = false; T.env.allowLocalModels = true; T.env.localModelPath = V + 'models/';
    T.env.useBrowserCache = false;
    T.env.backends.onnx.wasm.wasmPaths = V + 'transformers/';
    const id = 'onnx-community/depth-anything-v2-small';
    const tryDev = async (device) => { this.model = await T.AutoModel.from_pretrained(id, { device, dtype: 'fp32' }); this.device = device; };
    const forced = new URLSearchParams(location.search).get('depthDevice');
    if (forced) await tryDev(forced);
    else {
      let ok = false;
      if (navigator.gpu) { try { if (await navigator.gpu.requestAdapter()) { await tryDev('webgpu'); ok = true; } } catch (e) { console.warn('depth: webgpu failed, falling back to wasm', e); } }
      if (!ok) await tryDev('wasm');
    }
    this.ready = true;
  }
  reset() { this.has = false; this.lo = this.hi = null; }
  // async; resolves when this frame's depth is in this.data (row-flipped, 0 far .. 1 near)
  async update(src) {
    if (!this.ready || this.busy) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      const asp = src.width / src.height;
      let W, H;
      if (asp >= 1) { W = Math.round(this.long / 14) * 14; H = Math.max(14, Math.round(W / asp / 14) * 14); }
      else { H = Math.round(this.long / 14) * 14; W = Math.max(14, Math.round(H * asp / 14) * 14); }
      if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
      this.g.drawImage(src, 0, 0, W, H);
      const px = this.g.getImageData(0, 0, W, H).data, n = W * H, inp = new Float32Array(3 * n);
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) inp[c * n + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
      const out = await this.model({ pixel_values: new this.T.Tensor('float32', inp, [1, 3, H, W]) });
      const pd = out.predicted_depth, d = pd.data, h = pd.dims[pd.dims.length - 2], w = pd.dims[pd.dims.length - 1];
      let lo = Infinity, hi = -Infinity; for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const fresh = !this.has || this.still || this.w !== w || this.h !== h;
      if (fresh) { this.lo = lo; this.hi = hi; } else { this.lo += 0.15 * (lo - this.lo); this.hi += 0.15 * (hi - this.hi); }
      if (!this.data || this.w !== w || this.h !== h) { this.data = new Float32Array(w * h); this.w = w; this.h = h; }
      const k = 1 / Math.max(this.hi - this.lo, 1e-6), a = fresh ? 1 : this.blend, D = this.data;
      for (let y = 0; y < h; y++) { const o = (h - 1 - y) * w, s = y * w; for (let x = 0; x < w; x++) { const v = Math.min(1, Math.max(0, (d[s + x] - this.lo) * k)); D[o + x] += a * (v - D[o + x]); } }
      this.has = true; this.version++;
    } finally { this.busy = false; this.ms = performance.now() - t0; }
  }
}

// =====================================================================================================
// Live path (the rAF loop). Shoot mode never comes here: it keeps the synchronous classes above, frame-exact.
//
// Why: on the main thread a HandLandmarker call blocks ~13-18 ms (GPU inference + synchronous tensor read-back,
// independent of input size) and the segmenter's matte read-back another 6-12 ms. Run every rAF, that is 20-25 ms
// of blocked main thread per frame: 35-45 fps at best, and it was the whole of the "16-24 fps with hands".
// Here both run in one worker on an ImageBitmap of the source frame, at most once per NEW source frame; the page
// keeps the latest result. Landmarks are interpolated from the previous to the latest detection over one
// detection interval, so overlays move at the display rate instead of stepping at the inference rate.
// =====================================================================================================
class Pump {
  constructor() { this.w = null; this.seq = 0; this.wait = new Map(); this.busy = false; this.lastFrame = -1; this.users = {}; this.dead = null; this.tSent = 0; this.bitmapMs = 0; }
  start() {
    if (this.w) return;
    this.w = new Worker(new URL('./providers-worker.js', import.meta.url));
    this.w.onmessage = (ev) => { const m = ev.data, p = this.wait.get(m.id); if (!p) return; this.wait.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m); };
    this.w.onerror = (e) => { this.dead = e.message || 'worker error'; for (const p of this.wait.values()) p.rej(new Error(this.dead)); this.wait.clear(); };
  }
  call(msg, transfer = []) { this.start(); return new Promise((res, rej) => { const id = ++this.seq; this.wait.set(id, { res, rej }); this.w.postMessage({ ...msg, id }, transfer); }); }
  async boot(task, user) { const r = await this.call({ type: 'boot', task, V }); this.users[task] = user; return r.delegate; }
  // Called by every live provider on every render frame; sends at most one request per new source frame.
  kick(src, frameId) {
    if (this.busy || this.dead || frameId === this.lastFrame) return;
    const hands = this.users.hands?.ready, person = this.users.person?.ready; if (!hands && !person) return;
    this.busy = true; this.lastFrame = frameId; const t0 = performance.now(), aspect = src.width / src.height;
    createImageBitmap(src).then((bmp) => { this.bitmapMs = performance.now() - t0; return this.call({ type: 'frame', bmp, hands: !!hands, person: !!person, personW: this.users.person?.long || 512 }, [bmp]); })
      .then((r) => { const now = performance.now(); if (r.hands) this.users.hands?.onResult(r.hands, aspect, now, now - t0); if (r.person) this.users.person?.onResult(r.person, now, now - t0); })
      .catch((e) => { if (!this.warned) console.warn('[fx-lab] live provider worker: ' + (e.message || e)); this.warned = true; })
      .finally(() => { this.busy = false; });
  }
}
let pump = null; const getPump = () => pump || (pump = new Pump());
const snap = (s) => ({ lm: Float32Array.from(s.lm), c: [s.c[0], s.c[1]], pinch: s.pinch, open: s.open, size: s.size, size2d: s.size2d });

export class LiveHands extends Hands {
  constructor(o = {}) { super(false); this.live = true; this.core = new Hands(false); this.lerp = o.lerp !== false; this.period = 1 / 30; this.tArr = 0; this.tPrev = 0; this.hz = 0; this.latency = 0;
    for (const s of this.slots) { s.from = null; s.to = null; } }
  async boot() { this.delegate = (await getPump().boot('hands', this)) + ' worker'; this.ready = true; }
  reset() { super.reset(); this.core.reset(); for (const s of this.slots) { s.from = s.to = null; s.uid = 0; } this.tPrev = 0; }
  onResult(r, aspect, now, latency) {
    const dt = this.tPrev ? Math.min(0.1, Math.max(1e-3, (now - this.tPrev) / 1000)) : 1 / 30; this.tPrev = now;
    this.period += 0.25 * (dt - this.period); this.hz = 1 / this.period; this.ms = r.ms; this.latency = latency;
    this.core.ingest(r, aspect, dt);
    const shown = this.slots.filter(s => s.on && s.to).map(s => ({ uid: s.uid, at: snap(s) }));   // what is on screen right now, by hand identity
    for (let k = 0; k < 2; k++) {
      const c = this.core.slots[k], s = this.slots[k];
      s.on = c.on; if (!c.on) { s.from = s.to = null; s.uid = 0; continue; }
      const was = this.lerp ? shown.find(x => x.uid === c.uid) : null;
      s.from = was ? was.at : null; s.to = snap(c); s.uid = c.uid;
      s.raw = c.raw; s.world = c.world; s.side = c.side; s.score = c.score; s.vel = [c.vel[0], c.vel[1]];
    }
    this.raw = this.core.raw; this.count = this.core.count; this.tArr = now; this.tick(now);
  }
  // every render frame: slots = previous detection -> latest detection, eased over one detection interval
  tick(now) {
    const a = Math.min(1, Math.max(0, (now - this.tArr) / (this.period * 1000)));
    for (let k = 0; k < this.count; k++) {
      const s = this.slots[k], t = s.to, f = s.from; if (!t) continue;
      if (!f || a >= 1) { s.lm.set(t.lm); s.c = [t.c[0], t.c[1]]; s.pinch = t.pinch; s.open = t.open; s.size = t.size; s.size2d = t.size2d; continue; }
      for (let i = 0; i < 63; i++) s.lm[i] = f.lm[i] + a * (t.lm[i] - f.lm[i]);
      s.c = [f.c[0] + a * (t.c[0] - f.c[0]), f.c[1] + a * (t.c[1] - f.c[1])];
      s.pinch = f.pinch + a * (t.pinch - f.pinch); s.open = f.open + a * (t.open - f.open); s.size = f.size + a * (t.size - f.size); s.size2d = f.size2d + a * (t.size2d - f.size2d);
    }
    this.spread = this.count === 2 ? Math.hypot(this.slots[0].c[0] - this.slots[1].c[0], this.slots[0].c[1] - this.slots[1].c[1]) : 0;
  }
  update(src, dt, frameId) {
    if (!this.ready) return;
    getPump().kick(src, frameId);
    this.tick(performance.now());
    this.rasterMask(src.width, src.height);
  }
}

export class LivePerson extends Person {
  constructor(o = {}) { super(false); this.live = true; this.long = o.long || 512; this.hz = 0; this.latency = 0; this.tPrev = 0; }
  async boot() { this.delegate = (await getPump().boot('person', this)) + ' worker'; this.ready = true; }
  onResult(r, now, latency) {
    this.data = r.data; this.w = r.w; this.h = r.h; this.has = true; this.version++; this.ms = r.ms; this.latency = latency;
    if (this.tPrev) { const hz = 1000 / Math.max(1, now - this.tPrev); this.hz += 0.25 * (hz - this.hz); } this.tPrev = now;
  }
  update(src, frameId) { if (this.ready) getPump().kick(src, frameId); }
}
