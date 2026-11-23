// vizvim fx-lab — live ML worker (hands + person). Classic worker on purpose: MediaPipe loads its wasm glue with
// importScripts(), which module workers do not have; the ES bundle itself comes in through dynamic import().
// Protocol (all replies carry the request's `id`):
//   { id, type: 'boot', task: 'hands' | 'person', V }            -> { id, ok, delegate } | { id, error }
//   { id, type: 'frame', bmp: ImageBitmap, hands, person, personW } -> { id, hands?: {landmarks, worldLandmarks, handedness, ms},
//                                                                        person?: {data: Float32Array (y up), w, h, ms} }
// The frame's inference blocks only this thread; the page's render loop never waits for it.
// MediaPipe's mask read-back probes `'ontouchend' in self.document` (an iOS check) and throws in a worker; an empty stub is enough.
if (typeof self.document === 'undefined') self.document = {};
let MPp = null; const tasks = {}; let ts = 0; let small = null, smallG = null, handCv = null, handG = null;
const mediapipe = (V) => MPp || (MPp = (async () => { const MP = await import(V + 'mediapipe/vision_bundle.mjs'); const fileset = await MP.FilesetResolver.forVisionTasks(V + 'mediapipe/wasm'); return { MP, fileset }; })());
async function createTask(Cls, fileset, opts, wantGpu = false) {
  // Default to CPU WASM SIMD inside the worker: avoids MediaPipe multi-task WebGL context deadlocks
  // (e.g. booting hands after person) and keeps 100% of GPU bandwidth free for the main WebGL2 canvas.
  if (wantGpu) {
    try { return [await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }), 'gpu']; }
    catch (e) { /* fall through to CPU */ }
  }
  return [await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }), 'cpu'];
}
async function boot(task, V, wantGpu) {
  if (tasks[task]) return tasks[task].delegate;
  const { MP, fileset } = await mediapipe(V);
  const [t, delegate] = task === 'hands'
    ? await createTask(MP.HandLandmarker, fileset, { baseOptions: { modelAssetPath: V + 'models/hand_landmarker.task' }, numHands: 2, runningMode: 'VIDEO', minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4 }, wantGpu)
    : await createTask(MP.ImageSegmenter, fileset, { baseOptions: { modelAssetPath: V + 'models/selfie_segmenter.tflite' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false }, wantGpu);
  tasks[task] = { t, delegate }; return delegate;
}
const plain = (a) => (a || []).map(h => h.map(p => ({ x: p.x, y: p.y, z: p.z })));
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'boot') { self.postMessage({ id: m.id, ok: true, delegate: await boot(m.task, m.V, !!m.gpu) }); return; }
    if (m.type === 'frame') {
      const out = { id: m.id }, transfer = [], bmp = m.bmp;
      if (m.hands && tasks.hands) {
        const t0 = performance.now(); ts = Math.max(ts + 1, Math.round(performance.now()));
        let src = bmp;
        if (bmp.width > 512 && typeof OffscreenCanvas !== 'undefined') {
          const W = 512, H = Math.max(2, Math.round(W * bmp.height / bmp.width));
          if (!handCv || handCv.width !== W || handCv.height !== H) { handCv = new OffscreenCanvas(W, H); handG = handCv.getContext('2d', { willReadFrequently: true }); }
          handG.drawImage(bmp, 0, 0, W, H);
          src = handG.getImageData(0, 0, W, H);
        }
        const r = tasks.hands.t.detectForVideo(src, ts);
        out.hands = { landmarks: plain(r.landmarks), worldLandmarks: plain(r.worldLandmarks), handedness: (r.handedness || []).map(h => h.map(c => ({ categoryName: c.categoryName, score: c.score }))), ms: performance.now() - t0 };
      }
      if (m.person && tasks.person) {
        const t0 = performance.now(); ts = Math.max(ts + 1, Math.round(performance.now()));
        // selfie_segmenter works natively at 256^2; pass CPU ImageData so WASM never stalls on GPU OffscreenCanvas readback
        const W = Math.min(bmp.width, m.personW || 256), H = Math.max(2, Math.round(W * bmp.height / bmp.width));
        if (!small || small.width !== W || small.height !== H) { small = new OffscreenCanvas(W, H); smallG = small.getContext('2d', { willReadFrequently: true }); }
        smallG.drawImage(bmp, 0, 0, W, H);
        const r = tasks.person.t.segmentForVideo(smallG.getImageData(0, 0, W, H), ts), masks = r.confidenceMasks;
        if (masks && masks.length) {
          const k = masks[masks.length - 1], a = k.getAsFloat32Array(), w = k.width, h = k.height, data = new Float32Array(w * h);
          for (let y = 0; y < h; y++) data.set(a.subarray(y * w, y * w + w), (h - 1 - y) * w);   // row-flip -> y up
          out.person = { data, w, h, ms: performance.now() - t0 }; transfer.push(data.buffer);
        }
        r.close?.();
      }
      bmp.close?.();
      self.postMessage(out, transfer); return;
    }
  } catch (e) { try { m.bmp?.close?.(); } catch {} self.postMessage({ id: m.id, error: String(e && e.stack || e) }); }
};
