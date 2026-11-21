// vizvim fx-lab — hand-signal layer (browser glue). Spec: breakdowns/hand-signal.md.
// The harness imports this once (attach) and calls update(ctx) every frame before drives and the effect's frame().
//   landmarks -> lab/handsignal/core.js (signals, poses, events) -> lab/handsignal/engine.js (config: modalities -> params / actions)
//   returns { signals: { name: 0..1 }  -> drive sources 'sig:<name>',
//             uniforms: HUD + box (declared in lab/handsignal/glsl.js),  uCam: frozen frame while frozen }
// ?hs=<config>[;key=value]*   keys:  wrap=<effect id>   (for effects/hs-wrap.js)
//                                    track=<name>       (replay handsignal/tracks/<name>.json instead of the live landmarks)
//                                    hud=0|1            (override the config)
//                                    skel=1             (ghost skeleton in the HUD: for replayed tracks whose hands are not in the plate)
// v2 (breakdowns/hand-signal-v2.md):  ?hs=custom         the owner's own mapping for this look (lab/handsignal/mapping.js; localStorage 'hs.map.v2')
//                                    learn=<param id>   arm "learn" for that control (shots: re-armed on every seek, nothing is saved)
//                                    panel=1            build the panel section even in shoot mode (for page screenshots)
//                                    legend=0           hide the on-picture legend
//   window.__hs.map = { get, put(paramId, binding | spec), clear(paramId), learn(paramId), cancel(), everywhere(), reset(), handed('L'|'R') }
import { HandSignals, POSES, K } from './handsignal/core.js';
import { Engine } from './handsignal/engine.js';
import { Store, Learn, fork, normalize, empty, addBinding, bindingFor, clearParam, compile, label as bindLabel } from './handsignal/mapping.js';

const BASE = new URL('./handsignal/', import.meta.url).href.replace(/\?.*$/, '');
const H = { lab: null, S: null, sig: new HandSignals(), eng: null, cfg: null, cfgs: {}, order: [], opts: {}, lastT: -1, boundMod: null, track: null,
  frozen: null, last: null, ui: null, fitA: 0, events: [], hudOn: true, pendingNav: null, shoot: false,
  store: new Store(null), learn: new Learn(), note: null, mapUI: null, legend: null, learn0: null, learnPid: null };
if (typeof window !== 'undefined') window.__hs = H;      // effects (hand-signal-debug, box3d) read H.last from here

function parse(s) {
  const [id, ...rest] = String(s || '').split(';'); const o = {};
  for (const kv of rest) { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  return { id: id.trim(), o };
}
const hsString = () => [H.cfg ? H.cfg.id : 'off', ...Object.entries(H.opts).map(([k, v]) => `${k}=${v}`)].join(';');

function host() {
  const S = H.S, lab = H.lab;
  return {
    id: S.mod?.wraps || S.mod?.id || '', params: S.params || [],
    get: (id) => { const v = S.P[id]; return v === true ? 1 : v === false ? 0 : v; },
    set: (id, v) => lab.setParam(id, v),
    nextEffect(step) {
      const ids = [...document.querySelectorAll('#fxPick option')].map(o => o.value).filter(id => !/^_|^hs-wrap$|^passthrough$|^hand-signal-debug$/.test(id));
      const cur = S.mod?.wraps || S.mod?.id, i = ids.indexOf(cur), nx = ids[(((i < 0 ? 0 : i + step) % ids.length) + ids.length) % ids.length];
      if (!nx || H.shoot || H.track) { H.pendingNav = nx; return; }       // shots / replays never navigate
      if (lab.selectEffect && !S.mod?.wraps) {
        clearTimeout(H.navT); H.navT = setTimeout(() => { lab.selectEffect(nx); }, 260);
        return;
      }
      const u = new URL(location.href);
      if (S.mod?.wraps) { H.opts.wrap = nx; u.searchParams.set('hs', hsString()); } else { u.searchParams.set('fx', nx); u.searchParams.set('hs', hsString()); }
      clearTimeout(H.navT); H.navT = setTimeout(() => { location.href = u.href; }, 260);   // let the edge flash play
    },
    freeze(on) {
      const gl = lab.ctx.gl; if (H.frozen) { gl.deleteTexture(H.frozen); H.frozen = null; }
      if (on) H.frozen = lab.ctx.makeTexture(lab.ctx.source);
    },
    reset() { for (const p of S.params || []) if (p.default !== undefined) lab.setParam(p.id, p.default); },
  };
}
const playMode = () => !!(H.S && H.S.mod && (H.S.mod.ownsHands || H.S.mod.id === 'imagine'));   // the look itself is played with the hands
H.playMode = playMode;
function setConfig(id, { save = true } = {}) {
  if (id === 'custom') H.cfgs.custom = normalize(H.store.custom(host().id) || empty());      // 'Custom' is per look: its own mapping, else the global one
  H.cfg = H.cfgs[id] || null;
  H.eng = H.cfg ? new Engine(H.cfg, host(), { swapHands: H.store.handed === 'L' }) : null; H.boundMod = H.S.mod;
  if (H.frozen) { H.lab.ctx.gl.deleteTexture(H.frozen); H.frozen = null; }
  H.hudOn = H.opts.hud !== undefined ? H.opts.hud !== '0' : H.cfg ? H.cfg.hud !== false : false;
  if (save) { try { sessionStorage.setItem('hs.cfg', id || 'off'); } catch {} }
  if (H.ui) H.ui.sync(); if (H.mapUI) H.mapUI.sync();
}

H.setConfig = setConfig;

// ------------------------------------------------------------------ v2: the owner's mapping (every edit forks the preset to Custom, saved per look)
const paramOf = (pid) => (H.S.params || []).find(p => p.id === pid) || null;
const say = (text) => { H.note = { t: H.lastT, text }; };
function edit(fn) {
  const h = host(), base = H.cfg && H.cfg.id === 'custom' ? H.cfg : fork(H.cfg), r = fn(base, h); if (!r) return null;
  H.store.set(h.id, r.map || r); setConfig('custom');
  if (!H.shoot && typeof history !== 'undefined') { const u = new URL(location.href); u.searchParams.set('hs', hsString()); history.replaceState(null, '', u.href); }
  return r;
}
H.map = {
  get: () => H.cfg,
  bindingFor: (pid) => bindingFor(H.cfg, pid, host()),
  // put(paramId, binding) or put(paramId, picker spec { modality, signal, hand, from, to, curve, feel, gate })
  put(pid, b) {
    const p = paramOf(pid); if (!p) return null; const def = b.mode ? { target: 'param:' + pid, src: 'manual', ...b } : compile(b, p, host());
    const r = edit((m, h) => addBinding(m, def, h)); if (r) say([`${bindLabel(r.binding)} \u2192 ${p.label || p.id}`, ...r.removed.map(x => x.text)].join(' \u00b7 ')); return r;
  },
  clear(pid) { const p = paramOf(pid); if (!p || !bindingFor(H.cfg, pid, host())) return; edit((m, h) => clearParam(m, pid, h)); say(`${p.label || p.id} is free`); },
  learn(pid) {
    const p = paramOf(pid); if (!p) return false;
    const armNow = () => {
      H.learnPid = pid; H.learn0 = JSON.stringify(H.store.d); H.learn.arm(p, H.lastT < 0 ? null : H.lastT);
      say(`Teach ${p.label || p.id}: pinch and drag, swipe, or hold a pose`); if (H.mapUI) H.mapUI.sync();
    };
    if (!H.track && !H.lab.ctx.hands) {
      if (H.lab.ensureProvider) {
        say('Starting hand tracking…');
        H.lab.ensureProvider('hands').then(() => { if (!H.cfg) setConfig('custom', { save: false }); armNow(); });
        return true;
      }
      H.opts.learn = pid; const keep = H.cfg; if (!keep) H.cfg = { id: 'custom' }; const u = new URL(location.href); u.searchParams.set('hs', hsString()); location.href = u.href; return false;
    }
    armNow(); return true;
  },
  cancel() { H.learn.cancel(); H.learnPid = null; if (H.mapUI) H.mapUI.sync(); },
  everywhere() { if (H.cfg && H.cfg.id === 'custom') { H.store.setGlobal(H.cfg); say('saved as your mapping for every look'); if (H.mapUI) H.mapUI.sync(); } },
  reset() { const fx = host().id, base = H.cfg && H.cfg.base; H.store.clear(fx); setConfig(base && H.cfgs[base] ? base : H.store.custom(fx) ? 'custom' : ''); say('back to ' + (H.cfg ? H.cfg.name : 'off')); },
  handed(v) { H.store.handed = v; if (H.cfg) setConfig(H.cfg.id, { save: false }); },
};

// ------------------------------------------------------------------ panel section (lab UI, not part of any effect)
function buildPanel() {
  const lab = H.lab, root = document.createElement('div'); root.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const chips = document.createElement('div'); chips.className = 'chips';
  const mk = (text, title, fn) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = text; c.title = title || ''; c.onclick = fn; chips.append(c); return c; };
  const pick = async (id) => {
    if (id && !lab.ctx.hands) {
      if (lab.ensureProvider) { await lab.ensureProvider('hands'); }
      else { const u = new URL(location.href); H.cfg = H.cfgs[id]; u.searchParams.set('hs', hsString()); location.href = u.href; return; }
    }
    setConfig(id); const u = new URL(location.href); u.searchParams.set('hs', hsString()); history.replaceState(null, '', u.href);
    window.dispatchEvent(new CustomEvent('vz:handsignal', { detail: { id: H.cfg ? H.cfg.id : '' } }));
  };
  const cc = { off: mk('Off', 'no hand control', () => pick('')) };
  for (const id of H.order) cc[id] = mk(H.cfgs[id].name, H.cfgs[id].about, () => pick(id));
  cc.custom = mk('Custom', 'your own mapping for this look: tap the hand on a control, then do the gesture', () => pick('custom'));
  const imChip = mk('Imagine', 'free play: make frames, boxes, portals and strokes with your hands, each holding its own look', () => {
    if (lab.selectEffect) { lab.selectEffect('imagine'); return; }
    const u = new URL(location.href); u.searchParams.set('fx', 'imagine'); u.searchParams.set('hs', 'custom'); location.href = u.href;
  });
  const hudChip = document.createElement('span'); hudChip.className = 'chip'; hudChip.textContent = 'HUD'; hudChip.title = 'rings on the picture'; hudChip.style.alignSelf = 'flex-start';
  hudChip.onclick = () => { H.hudOn = !H.hudOn; H.opts.hud = H.hudOn ? '1' : '0'; hudChip.classList.toggle('on', H.hudOn); };
  const about = document.createElement('div'); about.style.cssText = 'color:var(--dim);font-size:11px;line-height:1.4';
  const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;gap:8px;white-space:nowrap;overflow:hidden';
  const pose = document.createElement('b'); pose.style.cssText = 'color:var(--fg);font-weight:500'; const ev = document.createElement('span'); ev.style.cssText = 'color:var(--acc);overflow:hidden;text-overflow:ellipsis';
  line.append(pose, ev);
  const cv = document.createElement('canvas'); const dpr = Math.min(window.devicePixelRatio || 1, 2); const CW = 228, CH = 150; cv.width = CW * dpr; cv.height = CH * dpr; cv.style.cssText = `width:${CW}px;height:${CH}px;display:block`;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  root.append(chips, about, line, cv, hudChip);
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  const METERS = [['pinch', 'pinch'], ['open', 'open'], ['x', 'x'], ['y', 'y'], ['depth', 'depth'], ['roll', 'roll'], ['speed', 'speed'], ['spread', 'spread'], ['twist', 'twist']];
  const css = getComputedStyle(document.documentElement), ACC = css.getPropertyValue('--acc').trim() || '#19e0c8', DIM = css.getPropertyValue('--dim').trim() || '#7d848e', LINE = css.getPropertyValue('--line').trim() || '#23262b';
  let lastDraw = 0;
  const draw = () => {
    if (cv.offsetParent === null) return;
    const now = performance.now(); if (now - lastDraw < 50) return; lastDraw = now;
    const L = H.last; g.clearRect(0, 0, CW, CH); if (!L) return;
    const st = L.st, s = st.signals;
    // skeleton preview (left): the tracked hands as the core sees them, user's left in a cool white, right in the accent
    const PW = 96, PH = 54; g.strokeStyle = LINE; g.lineWidth = 1; g.strokeRect(0.5, 0.5, PW - 1, PH - 1);
    for (const h of st.hands) {
      g.globalAlpha = Math.max(0.15, h.presence); g.strokeStyle = h.side === 'L' ? '#d9dce1' : ACC; g.lineWidth = 1; g.beginPath();
      for (const [a, b] of BONES) { g.moveTo(h.lm[a * 3] * PW, (1 - h.lm[a * 3 + 1]) * PH); g.lineTo(h.lm[b * 3] * PW, (1 - h.lm[b * 3 + 1]) * PH); }
      g.stroke();
      if (h.pinched) { g.fillStyle = ACC; g.beginPath(); g.arc(h.pinchPoint[0] * PW, (1 - h.pinchPoint[1]) * PH, 2.5, 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
    // finger curls of the primary hand (right of the preview): five short bars, thumb first
    const cx0 = PW + 10; g.font = '9px ui-monospace, Menlo, monospace'; g.fillStyle = DIM; g.fillText('curl', cx0, 9);
    for (let i = 0; i < 5; i++) { const v = s['curl' + i] || 0, x = cx0 + i * 12; g.fillStyle = LINE; g.fillRect(x, 14, 8, 40); g.fillStyle = ACC; g.fillRect(x, 14 + 40 * (1 - v), 8, 40 * v); }
    g.fillStyle = DIM; g.fillText(st.count + (st.count === 1 ? ' hand' : ' hands'), cx0 + 64, 9);
    if (L.box && L.box.exists) g.fillText('box ' + (L.box.grab === 'none' ? 'free' : L.box.grab === 'two' ? 'held' : 'drag'), cx0 + 64, 22);
    if (L.frozen) g.fillText('frozen', cx0 + 64, 35);
    // meter strip: one hairline row per signal, value as an accent run, rest position as a tick
    const y0 = PH + 10, rowH = 9.4;
    METERS.forEach(([n, label], i) => {
      const y = y0 + i * rowH, v = Math.min(1, Math.max(0, s[n] ?? 0)), x0 = 44, w = CW - x0 - 2;
      g.fillStyle = DIM; g.fillText(label, 0, y + 7); g.fillStyle = LINE; g.fillRect(x0, y + 3, w, 2);
      const rest = /^(x|y|depth|roll|twist)$/.test(n) ? 0.5 : 0; g.fillStyle = ACC; g.fillRect(x0 + w * Math.min(rest, v), y + 3, Math.max(1, w * Math.abs(v - rest)), 2);
      g.fillRect(x0 + w * v - 1, y + 1, 2, 6);
    });
    if (playMode()) { const n = (H.S.mod.leftOut || []).length; if (n !== H._imLeft) { H._imLeft = n; sync(); } }      // a look dropped at run time (shader did not compile) shows in the note
    const P = st.primary; pose.textContent = P && P.live ? `${P.side === 'L' ? 'left' : 'right'} · ${P.pose === 'none' ? '—' : P.pose}` : 'no hand';
    const e = H.events[H.events.length - 1]; ev.textContent = e && st.t - e.t < 1.5 ? e.text : '';
  };
  const sync = () => {
    const im = playMode(); imChip.classList.toggle('on', im);
    for (const id in cc) cc[id].classList.toggle('on', !im && id === (H.cfg ? H.cfg.id : 'off'));
    hudChip.classList.toggle('on', H.hudOn);
    const miss = H.eng && H.eng.missing.length ? `  (this look has no ${[...new Set(H.eng.missing)].join(', ')})` : '';
    const M = im && H.S.mod, pool = M && M.lookNames ? ` Looks in the pool: ${M.lookNames.filter((n, k) => !(M.leftOut || []).some(x => x.id === M.looks[k])).join(', ') || 'none'}.` + ((M.leftOut || []).length ? ` LEFT OUT: ${M.leftOut.map(x => `${x.name} (${x.why})`).join('; ')}.` : '') : '';
    about.textContent = im ? 'Free play. Your hands make windows onto other looks: frame with both hands (or pinch both hands apart and hold still), pinch and pull a box, draw a loop with one finger, touch fingertips, hold, then pull a web, or pinch, hold still, then paint. Pinch one to move it, throw it to drop it, rest an open hand on it and swipe for the next look. Mappings are paused here.' + pool : H.cfg ? (H.cfg.about || '') + miss : 'Pick a config to play the look with your hands, or tap the hand on any control to make your own.';
  };
  lab.addPanelSection('Hand signals', root);
  return { draw, sync, root, about, visible: () => cv.offsetParent !== null };
}

// ------------------------------------------------------------------ depth fit for the box (1/z = A * uDepth + B)
const FIT_B = 0.3;      // 1/m at uDepth = 0: the far end of the relative depth map sits ~3.3 m away
function depthFit(ctx, st) {
  const D = ctx.depth; if (!D || !D.has || !D.data) return;
  let s = 0, n = 0;
  for (const h of st.hands) if (h.live && h.conf > 0.5) {
    const cx = Math.min(D.w - 2, Math.max(1, Math.round(h.center[0] * D.w))), cy = Math.min(D.h - 2, Math.max(1, Math.round((1 - h.center[1]) * D.h)));
    const v = []; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) v.push(D.data[(cy + j) * D.w + cx + i]);
    v.sort((a, b) => a - b); const d = v[4];
    if (d > 0.15) { s += Math.max(1 / h.depthM - FIT_B, 0.2) / d; n++; }
  }
  if (n) { const a = s / n; H.fitA = H.fitA ? H.fitA + (a - H.fitA) * (1 - Math.exp(-st.dt / 0.5)) : a; }
}

// ------------------------------------------------------------------ harness entry points
const ZERO_SKEL = new Float32Array(126);
const IDLE_U = {
  uHSHud: 0, uHSHand: [0, 0, 1, 0, 0, 0, 1, 0], uHSClutch: [0, -1, 0, 0, 0, -1, 0, 0],
  uHSDwell: [0.5, 0.5, 0, 0], uHSFrame: [0.5, 0.5, 0, 0], uHSFrameRot: [0, 0, 0],
  uHSCursor: [0.5, 0.5, 0, 0], uHSCursorFrom: [0.5, 0.5, 0, 0], uHSFlash: [0, 0, 0, 0],
  uHSSkel: 0, uHSLm: ZERO_SKEL, uHSMask: 0, uBoxDepthFit: [0, FIT_B],
  uBoxCenter: [0, 0, 1], uBoxHalf: [0.1, 0.1, 0.1], uBoxRot: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  uBoxActive: 0, uBoxFocal: K.focal, uBoxGrab: 0, uBoxFlash: 0,
};

export default {
  state: H,
  async attach(lab) {
    H.lab = lab; H.S = lab.state; H.shoot = new URLSearchParams(location.search).get('shoot') === '1';
    try { H.order = await (await fetch(BASE + 'configs/index.json', { cache: 'no-store' })).json(); } catch { H.order = []; }
    await Promise.all(H.order.map(async (id) => { try { H.cfgs[id] = await (await fetch(`${BASE}configs/${id}.json`, { cache: 'no-store' })).json(); } catch (e) { console.warn('[handsignal] config ' + id + ': ' + e.message); } }));
    H.order = H.order.filter(id => H.cfgs[id]);
    const { id, o } = parse(lab.hs); H.opts = o;
    // shots never touch the saved mapping: they run on a store in memory (store=1 opts in)
    try { H.store = new Store(H.shoot && o.store !== '1' ? null : window.localStorage); } catch { H.store = new Store(null); }
    H.cfgs.custom = normalize(H.store.custom(lab.state.mod?.wraps || lab.state.mod?.id || '') || empty());
    if (o.track) { try { H.track = await (await fetch(`${BASE}tracks/${o.track}.json`, { cache: 'no-store' })).json(); } catch (e) { console.warn('[handsignal] track ' + o.track + ': ' + e.message); } }
    let want = id; if (!lab.hs) { try { want = sessionStorage.getItem('hs.cfg') || ''; } catch {} if (want && !lab.ctx.hands) want = ''; }
    if (want && want !== 'off' && !H.cfgs[want]) console.warn(`[handsignal] no config "${want}" (have: ${H.order.join(', ')})`);
    if (!H.shoot || o.panel === '1') H.ui = buildPanel();
    setConfig(H.cfgs[want] ? want : '', { save: false });
    // the mapping UI (hand glyph + binding chip on every control, inline editor) and the on-picture legend: DOM, never part of an effect.
    // Loaded apart so a fault there cannot take the signal layer down with it.
    try { const M = await import(BASE + 'panel.js'); if (H.ui) H.mapUI = M.buildMapUI(H, H.ui.root); if (o.legend !== '0') H.legend = M.buildLegend(H); } catch (e) { console.warn('[handsignal] mapping ui: ' + e.message); }
    if (o.learn) { H.learnPid = o.learn; H.learn0 = JSON.stringify(H.store.d); if (!H.cfg) setConfig('custom', { save: false }); if (!H.shoot) delete H.opts.learn; }
  },

  update(ctx) {
    const S = H.S, t = ctx.time, res = ctx.res, aspect = res[0] / Math.max(res[1], 1);
    if (t < H.lastT - 1e-6 || t - H.lastT > 1.0) {             // seek / loop: nothing carries across a cut
      H.sig.reset(); H.events = []; H.fitA = 0; H.note = null;
      // a shot that teaches (learn=) starts every seek from the mapping it had when it was armed, and arms again
      if (H.shoot && H.learnPid && H.learn0) { H.store.d = JSON.parse(H.learn0); if (H.cfg && H.cfg.id === 'custom') H.cfgs.custom = null; }
      if (H.cfg) setConfig(H.cfg.id, { save: false });
      if (H.learnPid && (H.shoot || H.learn.armed)) { const p = paramOf(H.learnPid); if (p) H.learn.arm(p, t); }
    }
    H.lastT = t;
    if (S.mod !== H.boundMod) {                                 // another look: presets re-resolve their aliases, Custom loads that look's own mapping
      if (H.cfg && H.cfg.id === 'custom') setConfig('custom', { save: false }); else if (H.eng) H.eng.bind(host());
      H.boundMod = S.mod; H.learn.cancel(); if (H.ui) H.ui.sync(); if (H.mapUI) H.mapUI.sync();
    }
    if (H.learnPid && !H.learn.armed && !H.learnDone) { const p = paramOf(H.learnPid); if (p && S.mod) H.learn.arm(p, t); }   // learn= from the URL: armed on the first frame

    // fast-path: handsignal is Off, not learning, not Imagine, no synthetic track, Hands meter hidden, and no hands present
    const handCount = ctx.hands?.count || 0;
    if (!H.cfg && !H.learn.armed && !playMode() && !H.track && !handCount && !H.frozen && !H.ui?.visible?.()) {
      if (H.mapUI) H.mapUI.draw();
      if (H.legend) H.legend.hide?.();
      return { signals: {}, uniforms: IDLE_U };
    }

    // ---- landmarks: the harness's raw (unsmoothed) points, or a recorded / synthetic track
    let raw = [], mirrored = !!S.src?.mirrored;
    if (H.track) {
      const fr = H.track.frames[Math.min(H.track.frames.length - 1, Math.max(0, Math.round(t * (H.track.fps || 30))))]; raw = fr ? fr.hands : []; mirrored = !!H.track.mirror;
    } else if (ctx.hands) {
      for (const h of ctx.hands) raw.push({ lm: h.raw.map(p => [p.x, 1 - p.y, p.z]), world: h.world ? h.world.map(p => [p.x, p.y, p.z]) : null, handedness: h.handedness, score: h.score });
    }
    const st = H.sig.update(raw, t, aspect, mirrored);
    const idle = () => ({ bind: [], hud: { hands: [], dwell: null, cursor: null, frame: null }, box: null, flash: null, log: [], frozen: false });
    // map mode: while a control is being taught the mapping is suspended (nothing else moves), the control previews the gesture
    let out, teach = null;
    if (H.learn.armed) {
      const p = H.learn.p, r = H.learn.update(st, host()); out = idle();
      teach = { pid: p.id, label: p.label || p.id, phase: H.learn.phase, axis: H.learn.axis, amount: H.learn.amount };
      for (const h of st.hands) if (h.pinched && h.live) out.hud.hands.push({ id: h.id, side: h.side, engaged: 1, value: -1, kind: 0 });
      if (r) { H.learnDone = true; if (!H.shoot) H.learnPid = null;
        if (r.binding) { const e = edit((m, hh) => addBinding(m, r.binding, hh)); say([`${bindLabel(e.binding)} \u2192 ${p.label || p.id}`, ...e.removed.map(x => x.text)].join(' \u00b7 ')); H.events.push({ t, text: 'learned ' + r.text, type: 'action' }); }
        else say('no clear gesture: tap the hand to try again');
        if (H.mapUI) H.mapUI.sync(); }
    } else out = H.eng && !playMode() ? H.eng.update(st) : idle();      // a look that owns the hands (Imagine): the mapping is muted, its own gestures are the only ones
    if (t < (H.learnT ?? 0)) H.learnDone = false; H.learnT = t;
    for (const e of st.events) if (!/^(handEnter|handLeave|pinchStart|pinchEnd|poseEnter|poseLeave|pinchTapSingle)$/.test(e.type)) H.events.push({ t, text: e.type + (e.pose ? ' ' + e.pose : ''), type: e.type, hand: e.hand });
    for (const l of out.log) H.events.push({ t, text: l.text, type: 'action' });
    if (H.events.length > 24) H.events.splice(0, H.events.length - 24);
    if (out.box && out.box.exists) depthFit(ctx, st);

    // ---- uniforms
    const hud = out.hud, hudOn = H.hudOn && !!H.cfg;
    const usesPinch = !!H.cfg && H.cfg.bindings.some(b => b.mode === 'clutch' || b.mode === 'box' || /pinch/i.test(b.on || '') || b.when === 'pinched') || !!teach;
    const hand = [0, 0, 1, 0, 0, 0, 1, 0], clutch = [0, -1, 0, 0, 0, -1, 0, 0];
    [st.L, st.R].forEach((T, i) => {
      if (!T || !usesPinch) return; const c = hud.hands.find(x => x.id === T.id);
      hand[i * 4] = T.pinchPoint[0]; hand[i * 4 + 1] = T.pinchPoint[1]; hand[i * 4 + 2] = T.gap; hand[i * 4 + 3] = T.presence;
      clutch[i * 4] = c ? c.engaged : T.pinched ? 0.5 : 0; clutch[i * 4 + 1] = c ? c.value : -1; clutch[i * 4 + 2] = c ? c.kind : 0;
      clutch[i * 4 + 3] = T.pinched ? Math.max(0, 1 - (t - T.pinchT) / 0.3) : 0;
    });
    const skel = new Array(126).fill(0);
    if (H.opts.skel === '1') [st.L, st.R].forEach((T, h) => { if (T) for (let i = 0; i < 21; i++) { skel[(h * 21 + i) * 3] = T.lm[i * 3]; skel[(h * 21 + i) * 3 + 1] = T.lm[i * 3 + 1]; skel[(h * 21 + i) * 3 + 2] = T.presence; } });
    const F = hud.frame, C = hud.cursor, D = hud.dwell, fl = out.flash;
    const DIRS = { Left: [-1, 0], Right: [1, 0], Up: [0, 1], Down: [0, -1] };
    const flashKind = fl ? (fl.dir || /Effect/.test(fl.kind) ? 0 : /freeze|reset/.test(fl.kind) ? 1 : -1) : -1;
    const flDir = fl ? DIRS[fl.dir] || (fl.kind === 'nextEffect' ? DIRS.Right : fl.kind === 'prevEffect' ? DIRS.Left : [0, 0]) : [0, 0];
    const maskFrame = F && F.mask && H.cfg.bindings.some(b => b.mode === 'frame' && b.mask !== false);
    const box = out.box;
    const uniforms = {
      uHSHud: hudOn ? 1 : 0, uHSHand: hand, uHSClutch: clutch,
      uHSDwell: D ? [D.x, D.y, D.p, D.done !== undefined ? D.done : 1] : [0.5, 0.5, 0, 0],
      uHSFrame: F ? [F.rect[0], F.rect[1], F.rect[2], F.rect[3]] : [0.5, 0.5, 0, 0],
      uHSFrameRot: F ? [F.rect[4], F.on, maskFrame ? 1 : 0] : [0, 0, 0],
      uHSCursor: C ? [C.x, C.y, C.on, 1] : [0.5, 0.5, 0, 0],
      uHSCursorFrom: C && C.from ? [C.from[0], C.from[1], C.on, 0] : [0.5, 0.5, 0, 0],
      // while the picture is frozen the hairline border stays up (0.75), so the state is never a mystery
      uHSFlash: fl && flashKind >= 0 ? [flDir[0], flDir[1], flashKind === 1 && H.frozen ? Math.max(fl.a, 0.75) : fl.a, flashKind] : H.frozen ? [0, 0, 0.75, 1] : [0, 0, 0, 0],
      uHSSkel: H.opts.skel === '1' ? 1 : 0, uHSLm: skel,
      uHSMask: box ? 2 : maskFrame ? 1 : 0,
      uBoxDepthFit: [H.fitA, FIT_B],
      ...(box ? box.uniforms(st.focal) : { uBoxCenter: [0, 0, 1], uBoxHalf: [0.1, 0.1, 0.1], uBoxRot: [1, 0, 0, 0, 1, 0, 0, 0, 1], uBoxActive: 0, uBoxFocal: K.focal, uBoxGrab: 0, uBoxFlash: 0 }),
    };
    H.last = { st, out, box, frozen: !!H.frozen, cfg: H.cfg, events: H.events, uniforms, poses: POSES, pendingNav: H.pendingNav, bind: out.bind || [], teach, note: H.note };
    if (H.ui) H.ui.draw(); if (H.mapUI) H.mapUI.draw(); if (H.legend) H.legend.draw();
    const r = { signals: st.signals, uniforms };
    if (H.frozen) r.uCam = H.frozen;
    return r;
  },
};
