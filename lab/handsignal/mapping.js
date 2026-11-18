// hand-signal v2 — owner-authorable mappings. Pure JS (browser + node). Spec: breakdowns/hand-signal-v2.md sections 2-4.
//
// A mapping is a v1 config plus identity. It is the thing vizvim persists inside a Look.
//
//   mapping  { schema: 'vizvim.handmap/2', id, name, about?, base: <preset id> | null, hud?: bool, box?: {...}, effects?: {...},
//              bindings: [binding] }
//   binding  { id: 'b3',                         stable inside the mapping
//              mode: 'clutch' | 'direct' | 'trigger' | (v1 only: 'pose' | 'xy' | 'frame' | 'box'),
//              target: 'param:<id>',             the parameter on the look it was made on
//              alias:  '@main' | '@second' | '@float:N' | '@enum' | '@bool' | null,   what it falls back to on another look
//              hand:   'any' | 'L' | 'R',        right-handed convention; a left-handed user swaps at run time
//              src:    'learn' | 'manual' | 'preset',
//              -- clutch:  axis: 'x'|'y'|'roll'|'depth'|'spread'|'twist', gain, out: [from, to], group
//              -- direct:  signal, when: 'always'|'pinched', range: [lo, hi] (of the signal), out: [from, to], curve, smooth
//              -- trigger: on: '<event>' | 'hold:<pose>', do: 'toggle'|'step'|'set', by, pair, out, dwell }
//   out is in normalised parameter units (0 = param min, 1 = param max); from > to means inverted. There is no invert switch.
//
// The four modalities the picker offers compile to those modes:
//   Direct  -> direct           the signal IS the value (absolute, soft takeover)
//   Clutch  -> clutch           pinch and move: relative, release keeps the value
//   Toggle  -> trigger/toggle   an event or a held pose flips a switch (on a float: between the two ends of out)
//   Step    -> trigger/step     an event moves to the next option (pair = the event that goes back)
import { clamp, wrapPi } from './filters.js';
import { resolveTarget, aliasOf, getN, setN, EK } from './engine.js';

export const SCHEMA = 'vizvim.handmap/2';
export const LEARN_POSES = ['peace', 'thumbsup', 'horns'];                // distinct on a webcam. Left out on purpose: open / point / L (look-alikes, resting shapes), ok / pinch (the clutch), fist (switches only)
export const HOLD_POSES = [...LEARN_POSES, 'fist'];
export const EVENTS = ['swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown', 'doublePinch', 'clap'];
export const AXES = ['x', 'y', 'roll', 'depth', 'spread', 'twist'];
export const DIRECT_SIGNALS = ['open', 'pinch', 'x', 'y', 'roll', 'near', 'depth', 'spread', 'twist', 'speed'];
export const TWO = ['spread', 'twist'];
const OPP = { swipeLeft: 'swipeRight', swipeRight: 'swipeLeft', swipeUp: 'swipeDown', swipeDown: 'swipeUp' };
const GLOBAL = ['nextEffect', 'prevEffect', 'freeze', 'reset', 'dismissBox'];
export const kindOf = (p) => (p.type === 'enum' ? 'enum' : p.type === 'bool' ? 'bool' : p.type === 'color' ? 'color' : 'float');
export const MODALITIES = { float: ['Clutch', 'Direct', 'Toggle', 'Step'], enum: ['Step', 'Clutch'], bool: ['Toggle', 'Direct'], color: [] };
const clone = (o) => JSON.parse(JSON.stringify(o));
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- schema
export function empty(base = null) { return { schema: SCHEMA, id: 'custom', name: 'Custom', about: 'Your own mapping. Tap the hand on a control, then do the gesture.', base, hud: true, bindings: [] }; }
// any v1 config or v2 mapping -> a valid v2 mapping (ids filled in, unknown keys kept: they are binding fields the engine reads)
export function normalize(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.bindings)) return empty();
  const out = { ...clone(m), schema: SCHEMA }; if (out.base === undefined) out.base = null; const seen = new Set();
  let n = 0; for (const b of out.bindings) { while (!b.id || seen.has(b.id)) b.id = 'b' + ++n; seen.add(b.id); if (!b.src) b.src = 'preset'; }
  return out;
}
// the first edit of a preset: same bindings, new identity
export function fork(cfg) { const m = normalize(cfg || empty()); return { ...m, id: 'custom', name: 'Custom', base: cfg && cfg.id !== 'custom' ? cfg.id : m.base ?? null, about: cfg && cfg.id !== 'custom' ? `Your own mapping, started from ${cfg.name}.` : empty().about }; }
const nextId = (m) => { let n = m.bindings.length; const ids = new Set(m.bindings.map(b => b.id)); while (ids.has('b' + ++n)); return 'b' + n; };

// which gestures a binding listens to (for conflict checks and fan-out)
export function gestures(b) {
  if (b.mode === 'clutch') return [TWO.includes(b.axis) ? 'pinch2' : 'pinch:' + (b.hand === 'L' || b.hand === 'R' ? b.hand : 'any')];
  if (b.mode === 'trigger') return [b.on, b.pair].filter(Boolean);
  if (b.mode === 'pose') return Object.keys(b.map || {}).map(p => 'hold:' + p);
  if (b.mode === 'box') return ['pinch:any', 'pinch2'];
  return [];
}
const targetsOf = (b) => ['target', 'x', 'y', 'w', 'h', 'area', 'angle'].map(k => b[k]).filter(v => typeof v === 'string');
const resolves = (b, host, cfg) => { const out = new Set(); for (const t of targetsOf(b)) { const p = resolveTarget(t, host, cfg) || (t === b.target && b.alias ? resolveTarget(b.alias, host, cfg) : null); if (p) out.add(p.id); } return out; };

// Conflict rules, in one place:
//   1. one owner per parameter: the new binding replaces whatever drove that parameter (a multi-target v1 binding goes whole)
//   2. the same gesture may fan out to several parameters (same pinch + same axis moves them together)
//   3. a parameter binding on an EVENT displaces a global action (next look, freeze...) and a v1 pose-map entry on that event
//   4. one-hand clutches that can share a hand share a group, so only one AXIS moves per pinch
// Returns { map, removed: [{ id, why, text }] }. Never mutates its input.
export function addBinding(map, b, host) {
  const m = clone(map), removed = []; b = { ...b, id: b.id || nextId(m) };
  const p = resolveTarget(b.target, host, m) || (b.alias ? resolveTarget(b.alias, host, m) : null);
  if (p && b.alias === undefined) b.alias = aliasOf(p, host);
  const mine = gestures(b);
  m.bindings = m.bindings.filter((o) => {
    if (o.id === b.id) return false;
    if (p && resolves(o, host, m).has(p.id)) { removed.push({ id: o.id, why: 'param', text: `${label(o)} no longer drives ${p.label || p.id}` }); return false; }
    if (b.mode === 'trigger' && o.mode === 'trigger' && GLOBAL.includes(o.do) && gestures(o).some(g => mine.includes(g))) { removed.push({ id: o.id, why: 'event', text: `${label(o)} no longer does ${actionName(o.do)}` }); return false; }
    if (b.mode === 'trigger' && o.mode === 'pose') for (const g of mine) if (g.startsWith('hold:') && o.map && o.map[g.slice(5)]) { delete o.map[g.slice(5)]; removed.push({ id: o.id, why: 'event', text: `holding ${g.slice(5)} is now yours` }); }
    return true;
  });
  if (b.mode === 'clutch' && !TWO.includes(b.axis)) {
    const share = m.bindings.filter(o => o.mode === 'clutch' && !TWO.includes(o.axis) && (o.hand === b.hand || !/^[LR]$/.test(o.hand || '') || !/^[LR]$/.test(b.hand || '')));
    // (a preset that deliberately runs two axes at once, like Knob's turn + push, keeps doing so)
    const loose = share.filter(o => !o.group && o.src === 'preset'), keep = loose.length >= 2 ? loose : [];
    const g = share.find(o => o.group)?.group || 'learn'; b.group = g; for (const o of share) if (!keep.includes(o)) o.group = g;
    if (m.bindings.some(o => o.mode === 'box')) b.unless = 'box';
  }
  m.bindings.push(b);
  return { map: m, removed, binding: b };
}
export function removeBinding(map, id) { const m = clone(map); m.bindings = m.bindings.filter(b => b.id !== id); return m; }
// free one parameter: a single-target binding goes, a multi-target v1 binding (xy, frame, pose map) only loses that leg
export function clearParam(map, pid, host) {
  const f = bindingFor(map, pid, host); if (!f) return map; const m = clone(map), b = m.bindings.find(x => x.id === f.b.id);
  if (f.key === 'target') m.bindings = m.bindings.filter(x => x !== b); else if (f.key === 'map') delete b.map[f.pose]; else delete b[f.key];
  return m;
}
// the binding that owns a parameter on this host (null if none), with the key it owns it through
export function bindingFor(map, pid, host) {
  if (!map) return null;
  for (const b of map.bindings) for (const k of ['target', 'x', 'y', 'w', 'h', 'area', 'angle']) if (typeof b[k] === 'string') {
    const p = resolveTarget(b[k], host, map) || (k === 'target' && b.alias ? resolveTarget(b.alias, host, map) : null); if (p && p.id === pid) return { b, key: k };
  }
  if (map.bindings) for (const b of map.bindings) if (b.mode === 'pose') for (const pose in b.map || {}) { const a = b.map[pose]; const p = a.target ? resolveTarget(a.target, host, map) : null; if (p && p.id === pid) return { b, key: 'map', pose }; }
  return null;
}

// ---------------------------------------------------------------- words (panel chip + legend)
const AX = { x: '↔', y: '↕', roll: 'turn', depth: 'push', spread: 'apart', twist: 'steer' };
const EV = { swipeLeft: 'swipe ←', swipeRight: 'swipe →', swipeUp: 'swipe ↑', swipeDown: 'swipe ↓', doublePinch: 'double pinch', clap: 'clap', pinchTap: 'pinch tap', dwell: 'dwell' };
const SG = { open: 'open hand', pinch: 'pinch amount', x: 'hand ↔', y: 'hand ↕', roll: 'wrist turn', near: 'reach in', depth: 'reach in', spread: 'hands apart', twist: 'hands steer', speed: 'hand speed' };
const actionName = (d) => ({ nextEffect: 'next look', prevEffect: 'previous look', freeze: 'freeze', reset: 'reset', dismissBox: 'put the box away' }[d] || d);
const evName = (on) => (on.startsWith('hold:') ? on.slice(5) + ' hold' : on.startsWith('poseEnter:') ? on.slice(10) : EV[on] || on);
export function label(b, key) {
  const hd = b.hand === 'L' || b.hand === 'R' ? b.hand + ' ' : '';
  if (b.mode === 'clutch') return TWO.includes(b.axis) ? `both ${AX[b.axis]}` : `${hd}pinch ${AX[b.axis || 'x']}`;
  if (b.mode === 'direct') return hd + (SG[b.signal] || b.signal) + (b.when === 'pinched' ? ' (pinched)' : '');
  if (b.mode === 'trigger') return hd + (b.pair && OPP[b.on] === b.pair ? `swipe ${/Left|Right/.test(b.on) ? '←→' : '↑↓'}` : evName(b.on));
  if (b.mode === 'pose') return hd + 'pose hold';
  if (b.mode === 'xy') return hd + (b.source === 'cursor' ? 'point' : 'palm') + (key ? ' ' + (key === 'x' ? '↔' : '↕') : '');
  if (b.mode === 'frame') return 'frame' + (key && key !== 'target' ? ' ' + key : '');
  return b.mode;
}
export function modality(b) { return b.mode === 'clutch' ? 'Clutch' : b.mode === 'direct' ? 'Direct' : b.mode === 'trigger' ? (b.do === 'step' ? 'Step' : b.do === 'toggle' ? 'Toggle' : 'Set') : 'Preset'; }

// ---------------------------------------------------------------- the manual picker: a flat spec <-> a binding
// spec { modality, signal, hand, from, to, curve, feel }   (signal: an axis for Clutch, a signal for Direct, an event for Toggle / Step)
export const FEEL = { Clutch: { Fine: 0.8, Normal: 1.6, Fast: 3 }, Direct: { Tight: 0.04, Soft: 0.12, Slow: 0.3 } };
export const CURVE_NAMES = { Linear: 'linear', Smooth: 'smooth', Exp: 'exp', Log: 'log' };
export function options(mod, p) {
  const k = kindOf(p);
  if (mod === 'Clutch') return AXES;
  if (mod === 'Direct') return k === 'bool' ? ['pinched', ...HOLD_POSES.map(n => 'pose_' + n)] : DIRECT_SIGNALS;
  return [...EVENTS, ...(k === 'float' ? LEARN_POSES : HOLD_POSES).map(n => 'hold:' + n)];
}
export function defaults(mod, p) {
  const k = kindOf(p);
  return { modality: mod, signal: mod === 'Clutch' ? 'x' : mod === 'Direct' ? (k === 'bool' ? 'pinched' : 'open') : mod === 'Step' ? 'swipeRight' : 'hold:peace', hand: 'any', from: 0, to: 1,
    curve: 'Linear', feel: mod === 'Clutch' ? 'Normal' : 'Tight', gate: 'Always' };
}
export function compile(spec, p, host) {
  const base = { target: 'param:' + p.id, alias: aliasOf(p, host), hand: spec.hand || 'any', src: 'manual' }, out = [r3(spec.from ?? 0), r3(spec.to ?? 1)];
  const two = TWO.includes(spec.signal); if (two) base.hand = 'any';
  if (spec.modality === 'Clutch') return { ...base, mode: 'clutch', axis: spec.signal, gain: FEEL.Clutch[spec.feel] ?? spec.gain ?? 1.6, out };
  if (spec.modality === 'Direct') return { ...base, mode: 'direct', signal: spec.signal, when: spec.gate === 'Pinched' && !two ? 'pinched' : 'always', range: spec.range || [0, 1], out, curve: CURVE_NAMES[spec.curve] || 'linear', smooth: FEEL.Direct[spec.feel] ?? 0.04 };
  const t = { ...base, mode: 'trigger', on: spec.signal, do: spec.modality === 'Step' ? 'step' : 'toggle', cooldown: 0.4 };
  if (spec.signal === 'clap') t.hand = 'any';
  if (spec.modality === 'Step') { if (OPP[spec.signal]) t.pair = OPP[spec.signal]; if (kindOf(p) === 'float') t.out = out; } else if (kindOf(p) === 'float') t.out = out;
  return t;
}
export function decompile(b) {
  const inv = (o, v, d) => Object.keys(o).find(k => Math.abs(o[k] - v) < 1e-6) || d, out = b.out || [0, 1];
  const s = { modality: modality(b), hand: b.hand === 'L' || b.hand === 'R' ? b.hand : 'any', from: out[0], to: out[1], curve: Object.keys(CURVE_NAMES).find(k => CURVE_NAMES[k] === (b.curve || 'linear')) || 'Linear', gate: b.when === 'pinched' ? 'Pinched' : 'Always' };
  if (b.mode === 'clutch') { s.signal = b.axis || 'x'; s.feel = inv(FEEL.Clutch, b.gain ?? 1, ''); s.gain = b.gain ?? 1; }
  else if (b.mode === 'direct') { s.signal = b.signal; s.feel = inv(FEEL.Direct, b.smooth ?? 0.04, 'Tight'); s.range = b.range; }
  else if (b.mode === 'trigger') s.signal = b.on;
  return s;
}
export const optionLabel = (o) => (AX[o] ? (TWO.includes(o) ? 'both ' : 'pinch ') + AX[o] : SG[o] || (o.startsWith('pose_') ? 'while ' + o.slice(5) : o === 'pinched' ? 'while pinched' : evName(o)));

// ---------------------------------------------------------------- storage
// one JSON document under 'hs.map.v2':  { v: 2, handed: 'R' | 'L', global: mapping | null, effects: { <effect id>: mapping } }
export const STORE_KEY = 'hs.map.v2';
export class Store {
  constructor(storage) { this.s = storage || null; this.d = { v: 2, handed: 'R', global: null, effects: {} }; this.load(); }
  load() { try { const raw = this.s && this.s.getItem(STORE_KEY); if (raw) { const d = JSON.parse(raw); if (d && d.v === 2) this.d = { v: 2, handed: d.handed === 'L' ? 'L' : 'R', global: d.global ? normalize(d.global) : null, effects: Object.fromEntries(Object.entries(d.effects || {}).map(([k, m]) => [k, normalize(m)])) }; } } catch { /* a corrupt store is an empty store */ } return this; }
  save() { try { this.s && this.s.setItem(STORE_KEY, JSON.stringify(this.d)); } catch { /* private window / quota */ } }
  get handed() { return this.d.handed; } set handed(v) { this.d.handed = v === 'L' ? 'L' : 'R'; this.save(); }
  // what 'Custom' means on this look: its own mapping, else the global one (its targets follow by alias), else nothing yet
  custom(fx) { return this.d.effects[fx] || this.d.global || null; }
  source(fx) { return this.d.effects[fx] ? 'effect' : this.d.global ? 'global' : null; }
  set(fx, map) { this.d.effects[fx] = normalize(map); this.save(); }
  setGlobal(map) { this.d.global = map ? normalize(map) : null; this.save(); }
  clear(fx) { delete this.d.effects[fx]; this.save(); }
}

// ---------------------------------------------------------------- learn: touch a control, do the gesture
// arm(param) then feed every frame through update(st, host). It returns null until a clear gesture is seen, then
// { binding, text }. What counts, in priority order:
//   pinch-drag (float, int, enum)   the axis that moved most between pinch and release: left-right, up-down, wrist turn, push,
//                                   or with both hands pinched: apart / steer. How far you dragged = the full range (gain).
//   swipe / double pinch / clap     enum: step (a swipe pairs with its opposite). bool: toggle. float: toggle between the ends.
//   a pose held 0.5 s               peace, thumbs up, horns (+ fist for switches). Same actions.
// Nothing counts for the first 0.3 s after arming or after a hand appears; a pinch shorter than 0.25 s or smaller than
// 0.05 hu is a tap, not a drag. The hand is recorded only when both hands were up (otherwise either hand works).
export const LK = { ignore: 0.3, minDrag: 0.11, minDur: 0.25, hold: 0.5, timeout: 12, previewGain: 1.6, gainLo: 0.8, gainHi: 3.5 };
export class Learn {
  constructor() { this.p = null; }
  get armed() { return !!this.p; }
  arm(p, t) { this.p = p; this.t0 = t; this.drag = null; this.pose = null; this.phase = 'waiting'; this.axis = null; this.amount = 0; }
  cancel() { this.p = null; this.drag = null; }
  update(st, host) {
    const p = this.p; if (!p) return null; const kind = kindOf(p), t = st.t; if (this.t0 == null || t < this.t0) this.t0 = t;
    if (t - this.t0 > LK.timeout) { this.cancel(); return { timeout: true, text: 'no gesture seen' }; }
    const ready = t - this.t0 >= LK.ignore, hands = st.hands.filter(h => h.live && h.age >= LK.ignore);
    const both = !!(st.L && st.R && st.L.live && st.R.live), sideOf = (h) => (both && h ? h.side : 'any');
    const done = (b, text) => { this.cancel(); return { binding: { ...b, target: 'param:' + p.id, alias: aliasOf(p, host), src: 'learn' }, text }; };
    // ---- pinch-drag
    if (kind !== 'bool' && kind !== 'color') {
      const D = this.drag, pin = hands.filter(h => h.pinched);
      if (!D && ready && pin.length) { const h = pin[0]; this.drag = { id: h.id, t0: t, v0: getN(host, p), a0: this._ax(h, st), peak: {}, cur: {}, two: false, conf: 1 }; this.phase = 'dragging'; }
      else if (D) {
        const h = st.hands.find(x => x.id === D.id), on = h && h.live && h.pinched;
        if (on) {
          const two2 = both && st.L.pinched && st.R.pinched; if (two2 && !D.two) { D.two = true; D.b0 = { spread: st.two.spread, twist: st.two.twist }; }
          const a = this._ax(h, st); D.conf = Math.min(D.conf, h.depthConf ?? 1);
          const n = { x: (a.x - D.a0.x) / EK.travel, y: (a.y - D.a0.y) / EK.travel, roll: wrapPi(a.roll - D.a0.roll) / EK.rollTravel, depth: (h.depthConf ?? 1) > 0.5 ? (a.depth - D.a0.depth) / EK.depthTravel : 0 };
          if (D.two && two2) { n.spread = (st.two.spread - D.b0.spread) / (EK.travel * 1.6); n.twist = (st.two.twist - D.b0.twist) / EK.rollTravel; }
          for (const k in n) { D.cur[k] = n[k]; D.peak[k] = Math.max(D.peak[k] || 0, Math.abs(n[k])); }
          const best = this._best(D); this.axis = best.axis; this.amount = best.peak;
          // live preview: the control already follows the hand while you teach it
          if (best.peak >= LK.minDrag) setN(host, p, clamp(D.v0 + D.cur[best.axis] * LK.previewGain));
        } else {
          const best = this._best(D), dur = t - D.t0; this.drag = null; this.phase = 'waiting';
          if (dur >= LK.minDur && best.peak >= LK.minDrag) {
            // range by demonstration: the distance you dragged becomes the travel for the full range
            const gain = Math.round(clamp(1 / Math.max(best.peak, 1e-3), LK.gainLo, LK.gainHi) * 10) / 10;
            return done({ mode: 'clutch', axis: best.axis, gain, out: [0, 1], hand: TWO.includes(best.axis) ? 'any' : sideOf(h || st.hands.find(x => x.id === D.id)) }, `pinch ${AX[best.axis]}`);
          }
          setN(host, p, D.v0);
        }
      }
    }
    if (this.drag && this.amount >= LK.minDrag) return null;        // a drag in progress outranks events
    // ---- events
    if (ready) for (const e of st.events) {
      if (!EVENTS.includes(e.type)) continue; const hand = e.type === 'clap' ? 'any' : both && e.hand ? e.hand : 'any';
      if (kind === 'enum') return done({ mode: 'trigger', on: e.type, do: 'step', by: 1, ...(OPP[e.type] ? { pair: OPP[e.type] } : {}), hand, cooldown: 0.4 }, EV[e.type]);
      if (kind === 'bool') return done({ mode: 'trigger', on: e.type, do: 'toggle', hand, cooldown: 0.4 }, EV[e.type]);
      if (kind === 'float' && !e.type.startsWith('swipe')) return done({ mode: 'trigger', on: e.type, do: 'toggle', out: [0, 1], hand, cooldown: 0.4 }, EV[e.type]);
    }
    // ---- a pose held
    const allowed = kind === 'float' ? LEARN_POSES : HOLD_POSES, h = hands.find(x => allowed.includes(x.pose) && !x.pinched);
    if (!h || !ready) { this.pose = null; if (!this.drag) this.phase = 'waiting'; }
    else {
      if (!this.pose || this.pose.name !== h.pose || this.pose.id !== h.id) this.pose = { name: h.pose, id: h.id, t0: t };
      this.phase = 'holding'; this.axis = h.pose; this.amount = clamp((t - this.pose.t0) / LK.hold);
      if (t - this.pose.t0 >= LK.hold) { const on = 'hold:' + h.pose, hand = sideOf(h);
        if (kind === 'enum') return done({ mode: 'trigger', on, do: 'step', by: 1, hand }, h.pose + ' hold');
        if (kind === 'bool') return done({ mode: 'trigger', on, do: 'toggle', hand }, h.pose + ' hold');
        if (kind === 'float') return done({ mode: 'trigger', on, do: 'toggle', out: [0, 1], hand }, h.pose + ' hold'); }
    }
    return null;
  }
  _ax(h) { return { x: h.c[0], y: -h.c[1], roll: h.roll, depth: -Math.log(h.depthM) }; }
  _best(D) { let axis = 'x', peak = 0; const order = D.two ? ['spread', 'twist'] : ['x', 'y', 'roll', 'depth']; for (const k of order) if ((D.peak[k] || 0) > peak) { peak = D.peak[k]; axis = k; } return { axis, peak }; }
}
