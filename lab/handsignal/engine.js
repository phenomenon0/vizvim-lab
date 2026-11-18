// hand-signal — configs and modalities. Turns HandSignals state into actions on a host. Pure JS (browser + node).
// A config is declarative JSON (lab/handsignal/configs/*.json): a list of bindings, each one modality instance.
//
// host = { id, params: [{ id, type: float|int|enum|bool, min, max, options, default, more }], get(id), set(id, value),
//          nextEffect(step), freeze(true|false|'toggle'), reset() }
// Targets:  "param:<id>" or an alias resolved against the host's params:
//   @main = first visible float/int   @second = the second   @float:N = Nth (0-based)   @enum = first enum   @bool = first bool
// A config may carry per-effect alias overrides:  "effects": { "halftone": { "@main": "param:cell" } }
//
// Modalities (binding.mode):
//   direct   continuous signal -> param over a range with a curve (absolute; soft takeover, holds on loss)
//   clutch   pinch and drag: relative, release keeps the value
//   frame    two-hand director's frame -> rect uniforms (+ optional params from w / h / area / angle)
//   pose     hold a pose (dwell ring) -> action
//   trigger  event -> action
//   xy       spatial: palm (calibrated reach) or pointing-ray cursor -> two params
//   box      the 3D box (box.js)
//
// v2 (breakdowns/hand-signal-v2.md; every v1 config still means what it meant):
//   binding.id      stable id (the legend and the panel refer to it)
//   binding.alias   fallback target when "param:<id>" does not exist on this look (how a mapping travels between looks)
//   clutch          out:[a,b] keeps the value inside a sub-range (a > b = inverted); axis 'spread' | 'twist' = both hands pinched
//   trigger         on:'hold:<pose>' (pose held for dwell s, default 0.5); do:'toggle' on a float flips between the two ends of out;
//                   do:'step' on a float moves by size (default 1/8 of out); pair:'<event>' steps the other way
//   groups          the axis lock is per AXIS, so two params learned on the same gesture move together and a second axis waits
//   opts.swapHands  left-handed user: every L / R in the config is read the other way round
//   update() also returns bind: [{ id, i, mode, pid, state: idle|armed|engaged|released, value 0..1, hand }]

import { clamp, lerp, smoothstep, wrapPi, CURVES } from './filters.js';
import { Box } from './box.js';

export const MODES = ['direct', 'clutch', 'frame', 'pose', 'trigger', 'xy', 'box'];
export const EK = {
  takeover: 0.25,        // s: an absolute binding approaches its target with this time constant when it (re)gains control...
  settle: 0.06,          // s after pinchStart before a clutch engages (the closing fingers move the palm)
  dead: 0.012,           // hu clutch dead zone after engage
  travel: 0.45,          // hu of drag for the full 0..1 range at gain 1
  rollTravel: 1.8,       // rad of twist for the full range (knob axis)
  depthTravel: 0.9,      // ln(Z) for the full range (push / pull axis)
  fineLo: 0.35, fineV0: 0.05, fineV1: 0.5,   // speed-dependent gain: below fineV0 hu/s the gain is fineLo, above fineV1 it is 1
  rollback: 0.06,        // s: on release the value returns to what it was this long ago (the opening fingers drag the palm)
  rollbackSlew: 0.08,    // s over which that correction is applied
  lockTravel: 0.03,      // hu before an axis-locked group decides its axis
};

export function resolveTarget(spec, host, cfg = {}) {
  if (!spec) return null; const over = cfg.effects?.[host.id]; if (over && over[spec]) spec = over[spec];
  const ps = host.params || [], vis = ps.filter(p => !p.more), fl = (vis.length ? vis : ps).filter(p => p.type === 'float' || p.type === 'int' || !p.type);
  let p = null;
  if (spec.startsWith('param:')) p = ps.find(q => q.id === spec.slice(6));
  else if (spec === '@main') p = fl[0]; else if (spec === '@second') p = fl[1]; else if (spec.startsWith('@float:')) p = fl[+spec.slice(7)];
  else if (spec === '@enum') p = ps.find(q => q.type === 'enum'); else if (spec === '@bool') p = ps.find(q => q.type === 'bool');
  return p || null;
}
export const lo = (p) => (p.type === 'enum' || p.type === 'bool' ? 0 : p.min ?? 0);
export const hi = (p) => (p.type === 'enum' ? p.options.length - 1 : p.type === 'bool' ? 1 : p.max ?? 1);
export const getN = (host, p) => { const v = +host.get(p.id); return clamp((v - lo(p)) / Math.max(hi(p) - lo(p), 1e-9)); };
export const setN = (host, p, n) => { const v = lo(p) + clamp(n) * (hi(p) - lo(p)); host.set(p.id, p.type === 'enum' || p.type === 'int' ? Math.round(v) : p.type === 'bool' ? v > 0.5 : v); };

// the alias a param answers to on its own look (so a binding made on it can follow to another look)
export function aliasOf(p, host) {
  if (!p) return null; const ps = host.params || [], vis = ps.filter(q => !q.more), fl = (vis.length ? vis : ps).filter(q => q.type === 'float' || q.type === 'int' || !q.type);
  const i = fl.indexOf(p); if (i === 0) return '@main'; if (i === 1) return '@second'; if (i > 1) return '@float:' + i;
  if (p.type === 'enum' && ps.find(q => q.type === 'enum') === p) return '@enum'; if (p.type === 'bool' && ps.find(q => q.type === 'bool') === p) return '@bool';
  return null;
}
const SWAP = { L: 'R', R: 'L' }, TWO_AXES = ['spread', 'twist'];
const isNum = (p) => p.type === 'float' || p.type === 'int' || !p.type;
const span = (d) => { const o = d.out || [0, 1]; return [Math.min(o[0], o[1]), Math.max(o[0], o[1]), o[1] < o[0] ? -1 : 1]; };

export class Engine {
  constructor(config, host, opts = {}) {
    this.k = { ...EK, ...opts }; this.cfg = config; this.host = host; this.box = null; this.frozen = false; this.log = [];
    this.b = (config.bindings || []).map((b, i) => ({ def: opts.swapHands && SWAP[b.hand] ? { ...b, hand: SWAP[b.hand] } : b, i, st: {}, target: null, ok: true }));
    this.has2 = this.b.some(B => B.def.mode === 'clutch' && TWO_AXES.includes(B.def.axis));
    this.bind(host);
  }
  bind(host) {
    this.host = host; this.missing = [];
    for (const B of this.b) {
      const d = B.def; B.t = {};
      for (const key of ['target', 'x', 'y', 'w', 'h', 'area', 'angle']) if (typeof d[key] === 'string') { B.t[key] = resolveTarget(d[key], host, this.cfg) || (key === 'target' && d.alias ? resolveTarget(d.alias, host, this.cfg) : null); if (!B.t[key]) this.missing.push(d[key]); }
      B.st = {};
    }
    if (this.b.some(B => B.def.mode === 'box') && !this.box) this.box = new Box(this.cfg.box || {});
  }
  describe() { return this.b.map(B => ({ mode: B.def.mode, targets: Object.fromEntries(Object.entries(B.t).map(([k, p]) => [k, p ? p.id : null])) })); }

  act(a, ev, st) {
    const h = this.host, p = a.target ? resolveTarget(a.target, h, this.cfg) || (a.alias ? resolveTarget(a.alias, h, this.cfg) : null) : null; const note = (s) => this.log.push({ t: st.t, text: s });
    switch (a.do) {
      case 'set': if (p) { setN(h, p, a.raw !== undefined ? (a.raw - lo(p)) / Math.max(hi(p) - lo(p), 1e-9) : a.value ?? 1); note(`${p.id} = ${a.raw ?? a.value}`); } break;
      case 'step': if (p && isNum(p) && p.type !== 'int') { const [a0, a1, sg] = span(a), c = getN(h, p); setN(h, p, clamp(c + sg * (a.by ?? 1) * (a.size ?? 0.125) * (a1 - a0), Math.min(a0, c), Math.max(a1, c))); note(`${p.id} ${a.by < 0 ? 'down' : 'up'}`); }
        else if (p) { const n = Math.round(hi(p) - lo(p)) + 1, cur = Math.round(+h.get(p.id) - lo(p)); const nx = a.wrap === false ? clamp(cur + (a.by ?? 1), 0, n - 1) : (((cur + (a.by ?? 1)) % n) + n) % n; h.set(p.id, lo(p) + nx); note(`${p.id} ${a.by < 0 ? 'prev' : 'next'}`); } break;
      case 'toggle': if (p && isNum(p)) { const o = a.out || [0, 1], c = getN(h, p); setN(h, p, Math.abs(c - o[1]) < Math.abs(c - o[0]) ? o[0] : o[1]); note(`${p.id} toggle`); }
        else if (p) { h.set(p.id, !(+h.get(p.id) > 0.5)); note(`${p.id} toggle`); } break;
      case 'nextEffect': h.nextEffect?.(1); note('next look'); break;
      case 'prevEffect': h.nextEffect?.(-1); note('previous look'); break;
      case 'freeze': { const on = a.arg === 'toggle' || a.arg === undefined ? !this.frozen : !!a.arg; this.frozen = on; h.freeze?.(on); note(on ? 'freeze' : 'unfreeze'); break; }
      case 'reset': h.reset?.(); note('reset'); break;
      case 'dismissBox': if (this.box && this.box.exists) { this.box.dismiss(); note('box dismissed'); } break;
      default: break;
    }
    this.flash = { t: st.t, hand: ev?.hand || null, kind: a.do, dir: ev?.type?.startsWith('swipe') ? ev.type.slice(5) : '' };
  }

  // st = HandSignals.update() result. Returns { hud, box, frame, cursor, log }
  update(st) {
    const k = this.k, host = this.host, dt = st.dt, sig = st.signals; this.log = [];
    const hud = { hands: [], dwell: null, cursor: null, frame: null };
    const pick = (sel) => (sel === 'L' ? st.L : sel === 'R' ? st.R : sel === 'primary' || !sel || sel === 'any' ? st.primary : null);
    const evHand = (e, sel) => !sel || sel === 'any' || sel === 'primary' || e.hand === sel;

    for (const B of this.b) {
      const d = B.def, S = B.st;
      if (d.mode === 'trigger') {
        const [type, pose] = d.on.split(':'); const p = B.t.target;
        if (type === 'hold') {                       // v2: a pose held for dwell seconds (ring at the palm), fires once per hold
          const h = st.hands.find(x => x.live && x.pose === pose && x.age >= 0.3 && evHand({ hand: x.side }, d.hand)); const hold = d.dwell ?? 0.5;
          if (!S.seen) { S.seen = true; if (h) { S.fired = true; S.last = -1e9; } }     // a pose already up when the mapping starts (just taught, or just switched) must be let go first
          if (!h) { S.t0 = null; S.fired = false; } else {
            if (S.t0 == null) S.t0 = st.t; const prog = clamp((st.t - S.t0) / hold);
            if (!S.fired) { hud.dwell = { x: h.center[0], y: h.center[1], p: prog }; if (prog >= 1) { S.fired = true; S.last = st.t; this.act(d, { hand: h.side, type: 'pose' }, st); } }
            else if (st.t - S.last < 0.3) hud.dwell = { x: h.center[0], y: h.center[1], p: 1, done: 1 - (st.t - S.last) / 0.3 };
          }
          this._rep(B, st, S.last != null && st.t - S.last < 0.45 ? 'engaged' : h ? (S.fired ? 'armed' : 'engaged') : st.count ? 'armed' : 'idle', h ? h.side : '', h && !S.fired ? clamp((st.t - S.t0) / hold) : null);
          continue;
        }
        for (const e of st.events) if (d.pair && e.type === d.pair && evHand(e, d.hand) && !(d.cooldown && st.t - (S.last ?? -9) < d.cooldown)) { S.last = st.t; S.side = e.hand; this.act({ ...d, by: -(d.by ?? 1) }, e, st); }
        this._rep(B, st, S.last != null && st.t - S.last < 0.45 ? 'engaged' : st.hands.some(x => x.live && evHand({ hand: x.side }, d.hand)) ? 'armed' : 'idle', S.side || '');
        for (const e of st.events) if (e.type === type && (!pose || e.pose === pose) && evHand(e, d.hand)) {
          if (d.unless === 'box' && this.box?.exists) continue;
          if (d.cooldown && st.t - (S.last ?? -9) < d.cooldown) continue; S.last = st.t; S.side = e.hand; this.act(d, e, st);
        }
      } else if (d.mode === 'direct') {
        const p = B.t.target; if (!p) continue;
        const sfx = d.hand === 'L' || d.hand === 'R' ? d.hand : ''; const name = d.signal + (sig[d.signal + sfx] !== undefined ? sfx : '');
        const two = ['spread', 'twist', 'midX', 'midY', 'push', 'depthDiff'].includes(d.signal);
        const h = two ? null : pick(d.hand); const live = two ? st.two.on && st.L?.live && st.R?.live : !!(h && h.live);
        const gateOk = !d.when || (d.when === 'pinched' ? h?.pinched : d.when.startsWith('pose:') ? h?.pose === d.when.slice(5) : true);
        // v2: depth is only as good as its confidence: below 0.35 the value holds instead of following a guess
        const shaky = /^(depth|near)$/.test(d.signal) && (sig['depthConf' + (name.endsWith(sfx) ? sfx : '')] ?? 1) < 0.35;
        if (!live || !gateOk || shaky) { S.w = 0; this._rep(B, st, live ? 'armed' : 'idle', h ? h.side : ''); continue; }            // hold: nothing is written while the hand is away
        let x = sig[name]; const r = d.range || [0, 1]; x = clamp((x - r[0]) / (r[1] - r[0]));
        if (d.deadzone) x = x < d.deadzone ? 0 : x > 1 - d.deadzone ? 1 : (x - d.deadzone) / (1 - 2 * d.deadzone);
        if (d.invert) x = 1 - x; x = (CURVES[d.curve] || CURVES.linear)(x);
        const out = d.out || [0, 1]; x = lerp(out[0], out[1], x);
        S.w = Math.min(1, (S.w || 0) + dt / k.takeover);
        const tau = lerp(k.takeover, d.smooth ?? 0.04, S.w), cur = getN(host, p);
        setN(host, p, cur + (x - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-3))));
        this._rep(B, st, 'engaged', two ? 'LR' : h.side);
      } else if (d.mode === 'clutch' && TWO_AXES.includes(d.axis)) {
        // v2: both hands pinched. spread = pull apart / push together, twist = steer. Relative, release keeps the value.
        const p = B.t.target; if (!p) continue; const L = st.L, R = st.R, both = !!(L && R && L.live && R.live && L.pinched && R.pinched);
        if (!both) S.phase = 'idle'; else if (S.phase !== 'on' && st.t - Math.max(L.pinchT, R.pinchT) >= k.settle) { S.phase = 'on'; S.a = d.axis === 'twist' ? st.two.twist : st.two.spread; S.v = getN(host, p); }
        if (both && S.phase === 'on') {
          const a = d.axis === 'twist' ? st.two.twist : st.two.spread, raw = a - S.a; S.a = a; const [o0, o1, sg] = span(d);
          const travel = (d.axis === 'twist' ? k.rollTravel : k.travel * 1.6) / (d.gain ?? 1);
          S.v = clamp(S.v + sg * raw / travel * (o1 - o0), Math.min(o0, S.v), Math.max(o1, S.v)); setN(host, p, S.v);
          for (const h of [L, R]) hud.hands.push({ id: h.id, side: h.side, engaged: 1, value: S.v, kind: d.axis === 'twist' ? 1 : 0 });
        }
        this._rep(B, st, both && S.phase === 'on' ? 'engaged' : L && R && L.live && R.live ? 'armed' : 'idle', 'LR');
      } else if (d.mode === 'clutch') {
        const p = B.t.target; if (!p) continue;
        const two = this.has2 && st.L && st.R && st.L.live && st.R.live && st.L.pinched && st.R.pinched;   // a two-hand clutch owns both pinches
        // which hand owns this clutch: the one that pinched (respecting the hand filter)
        let h = S.id ? st.hands.find(x => x.id === S.id) : null;
        if (!h || !h.pinched || two) {
          if (S.phase === 'on') this._release(B, st, h);
          S.phase = 'idle'; S.id = 0;
          h = two ? null : st.hands.find(x => x.pinched && x.live && (!d.hand || d.hand === 'any' || d.hand === 'primary' || x.side === d.hand) && !(d.unless === 'box' && this.box?.exists));
          if (h) { S.phase = 'armed'; S.id = h.id; S.t0 = h.pinchT; }
        }
        if (h && S.phase === 'armed' && st.t - S.t0 >= k.settle) { S.phase = 'on'; S.a = this._axis(h, d.axis); S.acc = 0; S.past = false; S.slew = null; S.trav = 0; S.v = getN(host, p); S.hist = []; S.lock = null; S.mine = !d.group; }
        if (h && S.phase === 'on' && h.live) {
          const a = this._axis(h, d.axis), raw = d.axis === 'roll' ? wrapPi(a - S.a) : a - S.a; S.a = a;
          const travel = (d.axis === 'roll' ? k.rollTravel : d.axis === 'depth' ? k.depthTravel : k.travel) / (d.gain ?? 1);
          const dead = d.axis === 'roll' ? 0.05 : d.axis === 'depth' ? 0.03 : k.dead;
          // dead zone is consumed once after engage; after that motion integrates with a speed-dependent gain
          let step = raw; if (!S.past) { S.acc += raw; if (Math.abs(S.acc) < dead) step = 0; else { step = S.acc - Math.sign(S.acc) * dead; S.past = true; } }
          const g = d.fine === false ? 1 : lerp(k.fineLo, 1, smoothstep(k.fineV0, k.fineV1, d.axis === 'x' || d.axis === 'y' || !d.axis ? h.speed : Math.abs(raw) / dt * (d.axis === 'roll' ? 0.33 : 0.6)));
          // axis lock inside a group: the first binding to travel lockTravel wins until release
          if (d.group) { const G = (this._groups ||= {}); const key = d.group + ':' + h.id; S.trav = (S.trav || 0) + Math.abs(raw) / travel * k.travel; const ax = d.axis || 'x'; if (!G[key] && S.trav > k.lockTravel) G[key] = ax; if (G[key] !== ax) step = 0; S.mine = G[key] === ax; }
          if (d.axis === 'depth') step *= smoothstep(0.25, 0.6, h.depthConf ?? 1);          // v2: a shaky depth estimate moves nothing
          const [o0, o1, sg] = span(d);
          S.v = clamp(S.v + (d.invert ? -1 : 1) * sg * step * g / travel * (o1 - o0), Math.min(o0, S.v), Math.max(o1, S.v));
          S.hist.push([st.t, S.v]); while (S.hist.length > 2 && S.hist[1][0] < st.t - 0.3) S.hist.shift();
          setN(host, p, S.v);
        }
        if (S.slew) { S.slew.t += dt; const u = clamp(S.slew.t / k.rollbackSlew); setN(host, p, lerp(S.slew.from, S.slew.to, u)); if (u >= 1) S.slew = null; }
        { const cand = h || st.hands.find(x => x.live && (!d.hand || d.hand === 'any' || d.hand === 'primary' || x.side === d.hand));
          this._rep(B, st, h && S.phase === 'on' && S.mine ? 'engaged' : cand ? 'armed' : 'idle', cand ? cand.side : ''); }
        if (h && (S.phase === 'on' || S.phase === 'armed')) hud.hands.push({ id: h.id, side: h.side, engaged: S.phase === 'on' ? 1 : 0.5, value: S.phase === 'on' ? S.v : getN(host, p), kind: d.axis === 'roll' ? 1 : 0 });
      } else if (d.mode === 'pose') {
        const h = pick(d.hand); const a = h && h.live ? d.map[h.pose] : null; const hold = d.dwell ?? 0.6;
        if (!a) { S.pose = null; S.fired = false; continue; }
        if (S.pose !== h.pose) { S.pose = h.pose; S.t0 = st.t; S.fired = false; }
        const prog = clamp((st.t - S.t0) / hold);
        if (!S.fired) { hud.dwell = { x: h.center[0], y: h.center[1], p: prog }; if (prog >= 1) { S.fired = true; S.done = st.t; this.act(a, { hand: h.side, type: 'pose' }, st); } }
        else if (st.t - S.done < 0.3) hud.dwell = { x: h.center[0], y: h.center[1], p: 1, done: 1 - (st.t - S.done) / 0.3 };
      } else if (d.mode === 'xy') {
        const h = pick(d.hand); const gateOk = h && h.live && (!d.when || d.when === 'always' || (d.when === 'pinched' ? h.pinched : h.pose === d.when.slice(5)));
        if (!gateOk) { S.w = 0; if (h && h.live && d.when?.startsWith('pose:') && d.source === 'cursor') hud.cursor = null; continue; }
        const src = d.source === 'cursor' ? h.cursor : d.source === 'pinch' ? h.pinchPoint : d.source === 'palm' ? h.center : h.reach;
        S.w = Math.min(1, (S.w || 0) + dt / k.takeover); const tau = lerp(k.takeover, d.smooth ?? 0.03, S.w), a = 1 - Math.exp(-dt / tau);
        const m = d.margin ?? 0.12, f = (v) => clamp((v - m) / (1 - 2 * m));
        const nx = d.source === 'reach' || !d.source ? src[0] : f(src[0]), ny = d.source === 'reach' || !d.source ? src[1] : f(src[1]);
        if (B.t.x) { const c = getN(host, B.t.x); setN(host, B.t.x, c + ((d.invertX ? 1 - nx : nx) - c) * a); }
        if (B.t.y) { const c = getN(host, B.t.y); setN(host, B.t.y, c + ((d.invertY ? 1 - ny : ny) - c) * a); }
        hud.cursor = { x: d.source === 'cursor' ? h.cursor[0] : d.source === 'pinch' ? h.pinchPoint[0] : h.center[0], y: d.source === 'cursor' ? h.cursor[1] : d.source === 'pinch' ? h.pinchPoint[1] : h.center[1], on: S.w, from: d.source === 'cursor' ? h.tips[1] : null };
      } else if (d.mode === 'frame') {
        const F = st.two.frame; const on = d.require === 'L' ? F.on && F.strict > 0.4 : F.on;
        S.a = clamp((S.a || 0) + (on ? dt : -dt) / 0.18);
        if (on || !S.rect) { if (on) { const r = [F.cx, F.cy, F.w, F.h, d.rotate === false ? 0 : F.angle]; if (!S.rect) S.rect = r; else { const a = 1 - Math.exp(-dt / 0.05); S.rect = S.rect.map((v, i) => v + (r[i] - v) * a); } } }
        if (S.rect && (S.a > 0 || d.sticky)) hud.frame = { rect: S.rect, on: d.sticky ? Math.max(S.a, S.rect ? 0.6 : 0) : S.a, mask: d.mask !== false, live: S.a };
        if (on && S.rect) {
          const a = 1 - Math.exp(-dt / 0.08), put = (p, x, r = [0, 1]) => { if (!p) return; const c = getN(host, p); setN(host, p, c + (clamp((x - r[0]) / (r[1] - r[0])) - c) * a); };
          put(B.t.w, S.rect[2], d.wRange || [0.08, 0.7]); put(B.t.h, S.rect[3], d.hRange || [0.08, 0.7]); put(B.t.area, Math.sqrt(S.rect[2] * S.rect[3]), d.areaRange || [0.1, 0.6]);
          put(B.t.angle, 0.5 + S.rect[4] / (Math.PI / 2)); put(B.t.x, S.rect[0]); put(B.t.y, S.rect[1]);
        }
      } else if (d.mode === 'box') {
        this.box.update(st, { mode: d.spawn === 'hold' ? 'hold' : 'pinch' });
        if (d.dismiss !== false) for (const e of st.events) if (e.type === (d.dismiss || 'doublePinch') && this.box.exists && this.box.grab === 'none') { this.box.dismiss(); this.log.push({ t: st.t, text: 'box dismissed' }); }
        for (const h of st.hands) if (h.pinched && h.live) hud.hands.push({ id: h.id, side: h.side, engaged: this.box.grab !== 'none' ? 1 : 0.5, value: -1, kind: 2 });
      }
    }
    if (this._groups) for (const key in this._groups) { const id = +key.split(':')[1]; const h = st.hands.find(x => x.id === id); if (!h || !h.pinched) delete this._groups[key]; }
    const bind = []; for (const B of this.b) { const p = B.t.target; if (!p || !B.rep) continue; const R = B.rep;
      bind.push({ id: B.def.id ?? 'b' + B.i, i: B.i, mode: B.def.mode, pid: p.id, state: R.state, since: R.since, hand: R.hand, value: getN(host, p), prog: R.prog }); }
    return { bind, hud, box: this.box, flash: this.flash && st.t - this.flash.t < 0.45 ? { ...this.flash, a: 1 - (st.t - this.flash.t) / 0.45 } : null, log: this.log, frozen: this.frozen };
  }
  // legend state of one binding. 'released' is the 1.2 s after an engagement ends (the value just set stays readable)
  _rep(B, st, state, hand, prog = null) {
    const R = (B.rep ||= { state: 'idle', since: st.t, hand: '', relT: -9 });
    if (R.live === 'engaged' && state !== 'engaged') R.relT = st.t; R.live = state;
    const shown = state !== 'engaged' && st.t - R.relT < 1.2 ? 'released' : state;
    if (shown !== R.state) { R.state = shown; R.since = shown === 'released' ? R.relT : st.t; }
    if (hand) R.hand = hand; R.prog = prog;
  }
  _axis(h, axis) { return axis === 'y' ? -h.c[1] : axis === 'roll' ? h.roll : axis === 'depth' ? -Math.log(h.depthM) : h.c[0]; }
  _release(B, st, h) {
    const S = B.st, k = this.k, p = B.t.target; if (!S.hist || !S.hist.length || !p) return;
    // if the hand was lost there is no finger-opening artefact to undo: keep the value as it is
    if (!h || !h.live) return;
    const tr = st.t - k.rollback; let v = S.hist[0][1]; for (const [t, x] of S.hist) { if (t <= tr) v = x; else break; }
    // a fast flick-release is intent, not artefact: only undo small recent changes
    if (Math.abs(v - S.v) < 0.06 && Math.abs(v - S.v) > 1e-4) S.slew = { from: S.v, to: v, t: 0 };
    S.v = v;
  }
}
