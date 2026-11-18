// hand-signal / Imagine — surfaces the hands MAKE. Registry + manager. Pure JS, no DOM (node: surfaces/test.mjs).
//
// A surface is a mask + local uv / depth provider that hosts one look. Up to SK.cap things coexist; a fifth retires the oldest.
// (A web is one thing made of three surfaces, one per quad, sharing a group; only one web lives at a time.)
// All types share ONE pose model and ONE manipulator:
//   pose   c     [x, y, z]   centre, camera space, metres (x right, y up, z forward, pinhole focal st.focal image heights)
//          half  [hx, hy, hz] half extents, metres (planar types ignore hz)
//          angle rad, ccw in the image (rotation about the view axis)
//          pts   optional [[x, y, w?], ...] metres, in the surface's own unrotated plane (web, brush; w = brush pressure 0..1)
//   2D work happens in "hu": p = [u * aspect, v] with (u, v) = vUv (y up), so a distance means the same in x and y.
//
// Registry interface (one object per type, see frame.js / box.js / portal.js / web.js / brush.js):
//   { id, name, code, fn?, group?,         code = the float the shader switches on; fn = its GLSL function when not sf_<id> (types
//                                          may share one); group = the name seed() expands to all types carrying it ('web')
//     hands,                               1 | 2: how many hands the spawn gesture needs (the legend says so; one-hand paths first)
//     behind,                              true: once pinned it sits BEHIND the person in the picture when mgr.behind is on (Frame,
//                                          Portal, Brush: flat things read as on the wall; Box and Web are objects in the hands)
//     pinchy,                              true: the spawn gesture is made of pinches (pose freezes while a pinch is letting go)
//     spawn: { gesture,                    human text for the legend
//              detect(st, mgr, scratch) -> null | { progress 0..1, pose: { c, half, angle, pts? }, once?, group? } },
//                                          progress < 1: a ghost (dashed / progress outline) follows the gesture
//                                          progress = 1: the surface is born and keeps following the gesture while detect keeps
//                                          returning; the first null pins it. once: pin at birth (portal). group: an id shared by
//                                          the surfaces of one gesture (web quads): they count as one against the cap.
//                                          scratch persists per type; scratch.born is set by the manager while its surface is live.
//     hit(s, p, f, A) -> signed distance in hu at p (hu), negative inside
//     uniforms(s, f, A) -> { d: [4 floats], pts?: [[x, y] hu, ...] }      type-specific packing (see glsl.js for the layout)
//     glsl }                               "float sf_<id>(int i, vec2 p, out vec2 suv, out float z)" source: signed distance in hu,
//                                          suv = local -1..1, z = metres at this pixel. May set sfShade / sfAux (glsl.js).
//
// Manager, per frame (update(st), st = HandSignals state):
//   spawn      each type's detect() runs; resting hands satisfy none of them (see each type's thresholds)
//   pinch ON a surface (top-most within SK.margin)      = grab: move x, y, z; wrist roll turns it in-plane
//   second pinch ON the same surface                    = scale + rotate about the hands' midpoint
//   second pinch OFF the surface while the first holds  = ride that look's main param (vertical drag, SK.rideGain per image height)
//   release                                             = stays pinned; released moving faster than SK.flick hu/s = dismissed, flies off
//   swipe left / right by an open hand that was already over a pinned surface (SK.swipeDwell), or by the free hand while the
//   other holds one                                     = next / previous look
//   one surface per look: cycling and spawning skip looks already on a surface
//   a hand younger than SK.entry seconds does nothing (entry frames are noise)
import { clamp, wrapPi, OneEuro } from '../filters.js';

import { SK, toHu, project, unproject, rot2, scaleHu, popScale, settleScale, present } from './geom.js';
import frame, { pframe, dframe } from './frame.js'; import box from './box.js'; import portal from './portal.js'; import webs from './web.js'; import brush from './brush.js';
export * from './geom.js';
export const TYPES = [frame, pframe, dframe, box, portal, ...webs, brush];     // detection order: two free pinches (pinch frame, box) before one (drag frame, brush)
const dz = (x, w) => (Math.abs(x) <= w ? 0 : x - Math.sign(x) * w);
const usable = present;

let NEXT = 1;
export class Surfaces {
  // types: registry objects. looks: [{ id, name, param: label of the ridden param, def: 0..1 default of it }]
  constructor(looks, opts = {}, types = TYPES) {
    this.k = { ...SK, ...opts }; this.types = types; this.T = Object.fromEntries(types.map(t => [t.id, t]));
    this.looks = looks; this.order = looks.map((_, i) => i); this.behind = false; this.reset();
  }
  reset() {
    this.list = []; this.scr = {}; for (const t of this.types) this.scr[t.id] = {};
    this.shared = {}; this.over = {}; this.banned = this.banned || new Set(); this.roles = {}; this.prevPinched = {}; this.val = this.looks.map(l => l.def ?? 0.5); this.t = 0; this.ride = null; this.log = [];
  }
  setOrder(ids) { const o = ids.map(id => this.looks.findIndex(l => l.id === id)).filter(i => i >= 0); this.order = [...o, ...this.looks.map((_, i) => i).filter(i => !o.includes(i))]; }
  alive() { return this.list.filter(s => s.state !== 'dismissing'); }
  byId(id) { return this.list.find(s => s.id === id) || null; }
  freeLook(from = -1, dir = 1) {
    const used = new Set([...this.alive().map(s => s.look), ...this.banned]), n = this.order.length; const at = this.order.indexOf(from);
    for (let j = 1; j <= n; j++) { const k = this.order[(((at < 0 ? -1 : at) + dir * j) % n + n) % n]; if (!used.has(k)) return k; }
    return from < 0 ? this.order[0] : from;
  }
  // put a surface in the world. state: 'spawning' (ghost) | 'live' (born, following its gesture) | 'pinned'
  add(type, pose, state = 'pinned', look = undefined, group = null) {
    const k = this.k; if (state !== 'spawning') this._cap(group);
    const s = { id: NEXT++, type, group, look: look ?? this.freeLook(), state, born: this.t, alpha: 0, target: 1, flash: state === 'spawning' ? 0 : 1, cyc: 0, prog: 1, hover: 0,
      bornT: state === 'spawning' ? null : this.t, pinT: state === 'pinned' ? this.t : -9, prevLook: -1, xf: 0, lift: 0, bh: 0,      // clocks + eased values the picture animates from
      c: pose.c.slice(), half: [pose.half[0], pose.half[1], pose.half[2] ?? pose.half[1]], angle: pose.angle || 0, pts: pose.pts ? pose.pts.map(p => p.slice()) : null,
      h0: pose.half[0], grab: null, hist: [], vel: [0, 0, 0], fc: new OneEuro(3, ...k.fPos), fh: new OneEuro(3, ...k.fExt), out: null };
    this.list.push(s); this.log.push({ t: this.t, type: 'spawn', id: s.id, kind: type, state });
    const fading = this.list.filter(x => x.state === 'dismissing'); while (this.list.length > k.slots && fading.length) this.list.splice(this.list.indexOf(fading.shift()), 1);
    return s;
  }
  // the cap counts born THINGS (a surface, or all the surfaces of one group); making one more retires the oldest one nobody holds.
  // Joining a group that is already counted costs nothing; a new group first retires what is left of any older group.
  _cap(group = null) {
    let born = this.alive().filter(s => s.state !== 'spawning'); const unit = (s) => (s.group != null ? 'g' + s.group : 's' + s.id);
    if (group != null) { if (born.some(s => s.group === group)) return; for (const s of born) if (s.group != null) this.dismiss(s, null, 'cap'); born = born.filter(s => s.state !== 'dismissing'); }
    const units = [...new Set(born.map(unit))];
    if (units.length >= this.k.cap) { const mem = (u) => born.filter(s => unit(s) === u), age = (u) => Math.min(...mem(u).map(s => s.born));
      const idle = units.filter(u => mem(u).every(s => !s.grab && s.state !== 'live')).sort((a, b) => age(a) - age(b));
      for (const s of mem(idle[0] || units[0])) this.dismiss(s, null, 'cap'); }
  }
  things() { return new Set(this.alive().filter(s => s.state !== 'spawning').map(s => (s.group != null ? 'g' + s.group : 's' + s.id))).size; }
  ready(h) { return h && h.age >= this.k.entry; }
  setPose(s, pose) { s.c = pose.c.slice(); s.half = [pose.half[0], pose.half[1], pose.half[2] ?? pose.half[1]]; s.angle = pose.angle || 0; if (pose.pts) { s.pts = pose.pts.map(p => p.slice()); s.h0 = pose.half[0]; } }
  dismiss(s, vel = null, why = 'dismiss') {
    if (!s || s.state === 'dismissing') return; s.state = 'dismissing'; s.target = 0; s.grab = null; s.vel = vel || [0, 0, 0]; s.fly = !!vel;
    for (const id in this.roles) if (this.roles[id].sid === s.id) this.roles[id] = { role: 'none' };
    for (const t in this.scr) if (this.scr[t].born === s.id) this.scr[t] = {};
    this.log.push({ t: this.t, type: why, id: s.id });
  }
  clear() { for (const s of this.list.slice()) this.dismiss(s, null, 'clear'); }
  // pre-pin surfaces of the named types across the picture, each with its own look
  seed(ids, A = 16 / 9, f = 1.2) {
    const n = ids.length; const made = [];
    ids.forEach((id, i) => { const Ts = this.T[id] ? [this.T[id]] : this.types.filter(T => T.group === id), g = Ts.length > 1 ? 'seed' + NEXT : null;
      const u = n === 1 ? 0.5 : 0.2 + 0.6 * i / (n - 1), v = 0.5 + (i % 2 ? -0.06 : 0.06) * (n > 1);
      for (const T of Ts) { if (!T.seed) continue; const s = this.add(T.id, T.seed(unproject([u, v], 0.55 + 0.06 * (i % 3), f, A), Math.min(1.5, 4.2 / n)), 'pinned', undefined, g); s.alpha = 1; s.flash = 0; s.bornT = -9; s.pinT = -9; s.bh = this.behind && T.behind ? 1 : 0; made.push(s); } });
    return made;
  }
  // top-most surface at p (hu): nearest to the camera first
  hitTest(p, f, A, margin, ok = () => true) {
    const near = this.alive().filter(s => s.state !== 'spawning' && ok(s)).sort((a, b) => a.c[2] - b.c[2]);
    for (const s of near) if (this.T[s.type].hit(s, p, f, A) < margin) return s;
    return null;
  }

  update(st) {
    const k = this.k, t = st.t, dt = st.dt, f = st.focal, A = st.aspect; this.t = t; this.f = f; this.A = A;
    const hands = st.hands.filter(usable), byId = Object.fromEntries(hands.map(h => [h.id, h]));
    const pp = (h) => toHu(h.pinchPoint, A); this._side = Object.fromEntries(hands.map(h => [h.id, h.side]));

    // ---- pinch roles: decided once, when the pinch starts, and kept until it ends
    for (const h of hands) {
      const was = this.prevPinched[h.id];
      if (h.pinched && !was) {
        let r = { role: 'none' };
        if (was === false && h.age >= k.entry) {      // (was === undefined: the hand arrived already pinching)
          const s = this.hitTest(pp(h), f, A, k.margin, s => s.state !== 'live');
          const other = hands.find(o => o.id !== h.id && this.roles[o.id] && (this.roles[o.id].role === 'grab' || (this.roles[o.id].role === 'free' && this.roles[o.id].sid)));   // holding one, or painting a stroke
          if (s) r = { role: 'grab', sid: s.id };
          else if (other) r = { role: 'ride', sid: this.roles[other.id].sid, y0: h.pinchPoint[1], v0: null };
          else r = { role: 'free', t0: t, sid: null };
        }
        this.roles[h.id] = r;
      } else if (!h.pinched && was) this.roles[h.id] = { role: 'none', endT: t };
      this.prevPinched[h.id] = h.pinched;
    }
    for (const id in this.roles) if (!byId[id]) { delete this.roles[id]; delete this.prevPinched[id]; }   // hand lost: its grab simply ends (pinned)
    this.free = hands.filter(h => this.roles[h.id]?.role === 'free');

    // ---- spawn gestures
    const loose = hands.some(h => h.pinched && h.gap > k.looseGap);
    for (const T of this.types) {
      const scr = this.scr[T.id]; let s = scr.sid ? this.byId(scr.sid) : null; if (s && s.state === 'dismissing') { s = null; scr.sid = null; scr.born = null; }
      const d = T.spawn.detect(st, this, scr);
      if (!d) {
        if (s) { if (s.state === 'live') { s.state = 'pinned'; s.touchT = t; s.pinT = t; this.log.push({ t, type: 'pin', id: s.id });
            if (T.pinchy) { for (const h of this.free) this.roles[h.id] = { role: 'none' }; this.free = []; } }   // a pinch still closed after its surface pinned does nothing more
          else this.list.splice(this.list.indexOf(s), 1); }
        for (const h of this.free) if (this.roles[h.id].sid === scr.sid) this.roles[h.id].sid = null;
        scr.sid = null; scr.born = null; continue;
      }
      const born = d.progress >= 1;
      if (!s) { s = this.add(T.id, d.pose, born ? 'live' : 'spawning', undefined, d.group ?? null); scr.sid = s.id; }
      else if (born && s.state === 'spawning') { this._cap(s.group); s.state = 'live'; s.flash = 1; s.born = t; s.bornT = t; this.log.push({ t, type: 'born', id: s.id }); }
      if (!(T.pinchy && loose && s.state === 'live')) this.setPose(s, d.pose);
      s.prog = clamp(d.progress, 0, 1); scr.born = s.state === 'live' ? s.id : null;
      if (T.pinchy) for (const h of this.free) this.roles[h.id].sid = s.state === 'live' ? s.id : null;
      if (d.once && born) { s.state = 'pinned'; s.touchT = t; s.pinT = t; scr.sid = null; scr.born = null; this.log.push({ t, type: 'pin', id: s.id }); }
    }

    // ---- grabs: one hand moves, two hands scale and turn. Every change of the holding set re-anchors from the surface as it is.
    this.ride = null;
    for (const s of this.list) {
      if (s.state === 'dismissing' || s.state === 'spawning' || s.state === 'live') continue;
      const hold = hands.filter(h => this.roles[h.id]?.role === 'grab' && this.roles[h.id].sid === s.id).sort((a, b) => a.id - b.id);
      const key = hold.map(h => h.id).join(',');
      if (!hold.length) {
        if (s.grab) {                                 // released: flick = dismiss, else it stays where it is
          const one = s.grab.n === 1, v = this._vel(s), sp = Math.hypot(v[0], v[1]) * scaleHu(s, f);
          s.grab = null; s.state = 'pinned'; s.touchT = t; s.pinT = t; this.log.push({ t, type: 'release', id: s.id, speed: sp });
          if (one && sp > k.flick) this.dismiss(s, v, 'flick');
        }
        continue;
      }
      if (!s.grab || s.grab.key !== key) {
        const a = hold[0], b = hold[1];
        s.grab = b ? { key, n: 2, pa: a.pinchPoint3.slice(), pb: b.pinchPoint3.slice(), c0: s.c.slice(), h0: s.half.slice(), a0: s.angle }
          : { key, n: 1, p0: a.pinchPoint3.slice(), c0: s.c.slice(), a0: s.angle, r0: a.roll };
        s.state = 'held'; s.hist = []; this.log.push({ t, type: b ? 'grab2' : 'grab', id: s.id });
      }
      const g = s.grab;
      if (hold.some(h => h.gap > k.looseGap)) { /* letting go: the pinch point kicks as the fingers open, ignore it */ }
      else if (g.n === 2) {
        const a = hold[0].pinchPoint3, b = hold[1].pinchPoint3;
        const v0 = [g.pb[0] - g.pa[0], g.pb[1] - g.pa[1]], v = [b[0] - a[0], b[1] - a[1]], m0 = [(g.pa[0] + g.pb[0]) / 2, (g.pa[1] + g.pb[1]) / 2, (g.pa[2] + g.pb[2]) / 2], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const hmax = Math.max(g.h0[0], g.h0[1]), hmin = Math.min(g.h0[0], g.h0[1]);
        const sc = clamp(Math.hypot(v[0], v[1]) / Math.max(Math.hypot(v0[0], v0[1]), 1e-3), k.minHalf / hmin, k.maxHalf / hmax);
        const da = wrapPi(Math.atan2(v[1], v[0]) - Math.atan2(v0[1], v0[0])), off = rot2([g.c0[0] - m0[0], g.c0[1] - m0[1]], da);
        s.c = [m[0] + off[0] * sc, m[1] + off[1] * sc, g.c0[2] + (m[2] - m0[2]) * k.depthMove]; s.half = g.h0.map(h => h * sc); s.angle = g.a0 + da;
      } else {
        const h = hold[0], p = h.pinchPoint3;
        s.c = [g.c0[0] + p[0] - g.p0[0], g.c0[1] + p[1] - g.p0[1], g.c0[2] + (p[2] - g.p0[2]) * k.depthMove];
        s.angle = g.a0 - dz(wrapPi(h.roll - g.r0), k.rollDead);
        s.hist.push({ t, c: s.c.slice() }); while (s.hist.length && t - s.hist[0].t > 0.25) s.hist.shift();
      }
      s.c[2] = clamp(s.c[2], k.minZ, k.maxZ);
    }

    // ---- param ride: the off-surface pinch of the second hand, vertical
    for (const h of hands) { const r = this.roles[h.id]; if (!r || r.role !== 'ride') continue;
      const s = this.byId(r.sid); if (!s || (s.state !== 'held' && s.state !== 'live')) { this.roles[h.id] = { role: 'none' }; continue; }
      if (r.v0 === null) { r.v0 = this.val[s.look]; r.y0 = h.pinchPoint[1]; r.look = s.look; }
      if (r.look !== s.look) { r.v0 = this.val[s.look]; r.y0 = h.pinchPoint[1]; r.look = s.look; }
      if (h.gap <= k.looseGap) this.val[s.look] = clamp(r.v0 + (h.pinchPoint[1] - r.y0) * k.rideGain);
      this.ride = { hand: h.side, id: h.id, sid: s.id, look: s.look, value: this.val[s.look], at: h.pinchPoint.slice() };
    }

    // ---- which pinned surface each open hand is resting over, and since when (a swipe only counts from a hand that was already there)
    for (const h of hands) { const o = this.over[h.id] || (this.over[h.id] = { sid: null, t0: t, was: null, wasT: -9, wasFor: 0 });
      const s = h.pinched ? null : this.hitTest(toHu(h.center, A), f, A, k.swipeMargin, x => x.state === 'pinned');
      if ((s ? s.id : null) !== o.sid) { if (o.sid) { o.was = o.sid; o.wasT = t; o.wasFor = t - o.t0; } o.sid = s ? s.id : null; o.t0 = t; } }
    for (const id in this.over) if (!byId[id]) delete this.over[id];
    // ---- look cycling: swipe left / right
    for (const e of st.events) { if (e.type !== 'swipeLeft' && e.type !== 'swipeRight') continue;
      const h = byId[e.id]; if (!h || h.age < k.entry || t - (this.roles[h.id]?.endT ?? -9) < k.swipeAfterPinch) continue;   // a throw is not a swipe
      const other = hands.find(o => o.id !== h.id && this.roles[o.id]?.sid && (this.roles[o.id].role === 'grab' || this.roles[o.id].role === 'free'));
      let s = other ? this.byId(this.roles[other.id].sid) : null;
      if (!s) { const o = this.over[h.id];      // the surface the hand is over and has been for swipeDwell, or the one it was resting on until the stroke carried it off
        if (o && o.sid && t - o.t0 >= k.swipeDwell) s = this.byId(o.sid); else if (o && o.was && t - o.wasT < 0.35 && o.wasFor >= k.swipeDwell) s = this.byId(o.was);
        if (s && s.state !== 'pinned') s = null; }
      if (!s || (!other && t - Math.max(s.born, s.touchT || 0) < k.swipeSettle)) continue;   // the hand leaving a surface it just made / let go is not a swipe
      const nx = this.freeLook(s.look, e.type === 'swipeRight' ? 1 : -1); if (nx !== s.look) { s.prevLook = s.look; s.look = nx; s.cyc = 1; s.xf = 1; this.log.push({ t, type: 'look', id: s.id, look: nx }); }
    }

    // ---- hover (an open pinch point resting on a pinned surface lights its border), envelopes, output filters, removal
    for (const s of this.list) {
      let hov = 0; if (s.state === 'pinned') for (const h of hands) if (!h.pinched && h.age >= k.entry && h.gap < 0.75 && this.hitTest(pp(h), f, A, k.margin) === s) hov = 1;
      s.hover += clamp(hov - s.hover, -dt / 0.15, dt / 0.15);
      const fade = s.fly ? k.flyFade : k.fade; s.alpha += clamp(s.target - s.alpha, -dt / fade, dt / fade);
      s.flash = Math.max(0, s.flash - dt / 0.4); s.cyc = Math.max(0, s.cyc - dt / 0.35); s.xf = Math.max(0, s.xf - dt / k.xfade);
      const up = s.state === 'held' || s.state === 'live' ? 1 : 0; s.lift += clamp(up - s.lift, -dt / k.liftDown, dt / k.liftUp);      // held = lifted off the wall
      // in front of the person or behind them: decided once per pin, from how much of the surface the person covers at that moment
      // (this.cover(s) -> 0..1 | null, set by the host). On the person = a filter on them, stays in front; on the wall = goes behind.
      if (s.state === 'pinned' && s.frontT !== s.pinT && this.cover) { const cv = this.cover(s); if (cv != null) { const first = s.frontT === undefined && s.bornT === -9; s.front = cv > k.coverFront; s.frontT = s.pinT;
        if (first) s.bh = this.behind && this.T[s.type].behind && !s.front ? 1 : 0; } }
      const bh = this.behind && this.T[s.type].behind && s.state === 'pinned' && !s.front ? 1 : 0; s.bh += clamp(bh - s.bh, -dt / (k.behind * 0.5), dt / k.behind);   // comes forward faster than it goes back
      if (s.state === 'dismissing') { s.c = [s.c[0] + s.vel[0] * dt, s.c[1] + s.vel[1] * dt, s.c[2]]; s.angle += (s.fly ? 2.5 : 0) * dt * Math.sign(s.vel[0] || 1) * -1; }
      const c = s.fc.filter(s.c, dt), h = s.fh.filter(s.half.map(Math.log), dt);
      s.out = { c: [c[0], c[1], c[2]], half: [Math.exp(h[0]), Math.exp(h[1]), Math.exp(h[2])], angle: s.angle };
    }
    this.list = this.list.filter(s => !(s.state === 'dismissing' && s.alpha <= 0));
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    return this;
  }
  // surface velocity (m / s) at release: the fastest 2-frame stretch of the last 0.25 s of a one-hand grab (the pose is frozen
  // while the fingers open, so the newest samples are from just before the let-go)
  _vel(s) {
    const H = s.hist; let best = [0, 0, 0], bs = 0;
    for (let i = 2; i < H.length; i++) { const d = Math.max(H[i].t - H[i - 2].t, 1e-3), v = [(H[i].c[0] - H[i - 2].c[0]) / d, (H[i].c[1] - H[i - 2].c[1]) / d, 0], sp = Math.hypot(v[0], v[1]); if (sp > bs) { bs = sp; best = v; } }
    return best;
  }
  // paint order: what sits behind the person first, then far -> near. Each entry is the FILTERED pose (what is drawn and what hit() should see).
  drawList() { return this.list.filter(s => s.out).map(s => ({ ...s, ...s.out })).sort((a, b) => (b.bh > 0.5) - (a.bh > 0.5) || b.c[2] - a.c[2]); }
  stateCode(s) { return s.state === 'spawning' ? 2 : s.state === 'dismissing' ? 3 : s.state === 'held' || s.state === 'live' ? 1 : 0; }
  // the eased scale the picture draws a surface at: spawn pop (overshoot), pin settle (one small dip), shrink on the way out.
  // A function of the clocks only, so a replayed track draws the same frames.
  visScale(s, t = this.t) {
    const k = this.k; let v = 1;
    if (s.bornT != null && s.bornT > -1) v *= popScale((t - s.bornT) / k.pop);
    if (s.pinT > -1 && s.state === 'pinned') v *= settleScale((t - s.pinT) / k.settle);
    if (s.state === 'dismissing') v *= s.fly ? 0.8 + 0.2 * s.alpha : 0.9 + 0.1 * s.alpha;
    return v;
  }
  // radius (hu) of the circle about the projected centre that holds the whole surface (s = a drawList entry)
  bound(s, f, A, u = null) {
    const T = this.T[s.type]; u = u || T.uniforms(s, f, A);
    if (u.pts && u.pts.length) { const c = toHu(project(s.c, f, A), A); let r = 0; for (const p of u.pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1]) + (p[2] || 0)); return r; }
    return T.bound ? T.bound(s, f) : Math.hypot(s.half[0], s.half[1]) * scaleHu(s, f);
  }
  // Which looks have to render this frame, and over which part of the picture. Per look: crop = [u0, v0, size] (a window of the
  // camera with the picture's own aspect, `size` of its height), the union of the footprints of the surfaces showing it. A
  // footprint is the surface's bounding circle * k.cropPad, never smaller than k.cropMin: the look is rendered over THAT, so its
  // dots / lines / levels are scaled to the surface, not to the whole frame. warm = looks nobody shows yet but a swipe could
  // bring next (the neighbours of a surface a hand rests over or holds): they render one frame early so a change never pops.
  lookUse(f = this.f || 1.2, A = this.A || 16 / 9) {
    const k = this.k, use = new Map(), L = this.drawList();
    const foot = (s) => { const uv = project(s.c, f, A), R = this.bound(s, f, A), sz = clamp(2 * R * k.cropPad, k.cropMin, 1); return [uv[0] - sz / (2 * A) * 1, uv[1] - sz / 2, uv[0] + sz / (2 * A), uv[1] + sz / 2]; };
    const put = (look, b, warm) => { if (look == null || look < 0 || this.banned.has(look)) return; const e = use.get(look);
      if (!e) use.set(look, { box: b.slice(), warm }); else { e.box = [Math.min(e.box[0], b[0]), Math.min(e.box[1], b[1]), Math.max(e.box[2], b[2]), Math.max(e.box[3], b[3])]; e.warm = e.warm && warm; } };
    const hot = new Set(Object.values(this.over).map(o => o.sid).filter(Boolean));
    for (const s of L) { if (s.state === 'dismissing' && s.alpha <= 0.003) continue; const b = foot(s);
      put(s.look, b, false); if (s.xf > 0.003) put(s.prevLook, b, false);
      if (s.state === 'held' || s.state === 'live' || hot.has(s.id)) for (const d of [1, -1]) { const nx = this.freeLook(s.look, d); if (nx !== s.look) put(nx, b, true); } }
    for (const e of use.values()) { const b = e.box, sz = clamp(Math.max(b[3] - b[1], (b[2] - b[0])), k.cropMin, 1), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;      // (u and v sizes are equal: the crop keeps the picture's aspect)
      e.crop = [clamp(cx - sz / 2, 0, 1 - sz), clamp(cy - sz / 2, 0, 1 - sz), sz]; delete e.box; }
    return use;
  }
  // packed uniforms for glsl.js SF_DECL
  uniforms(f = this.f || 1.2, A = this.A || 16 / 9) {
    const k = this.k, n = k.slots, mk = () => new Float32Array(n * 4), a = mk(), b = mk(), c = mk(), d = mk(), e = mk(), F = mk(), G = mk(), pts = new Float32Array(n * k.npts * 3);
    const L = this.drawList().slice(-n); let any = 0;
    L.forEach((s, i) => { const T = this.T[s.type], uv = project(s.c, f, A), sh = scaleHu(s, f), u = T.uniforms(s, f, A), v = this.visScale(s), ch = toHu(uv, A), dd = (u.d || [0, 0, 0, 0]).slice();
      if (T.code === 5) dd[1] *= v;
      a.set([T.code, s.look, s.alpha * s.alpha * (3 - 2 * s.alpha), this.stateCode(s)], i * 4); b.set([uv[0], uv[1], s.c[2], s.angle], i * 4);
      c.set([s.half[0] * sh * v, s.half[1] * sh * v, s.prog, Math.max(s.flash, s.cyc)], i * 4); d.set(dd, i * 4);
      e.set([s.half[0] * v, s.half[1] * v, s.half[2] * v, s.hover], i * 4);
      F.set([s.bh, s.lift, s.state === 'dismissing' && s.fly ? s.vel[0] * sh : 0, s.state === 'dismissing' && s.fly ? s.vel[1] * sh : 0], i * 4);
      G.set([Math.max(0, s.prevLook), s.xf, s.state === 'pinned' && s.pinT > -1 ? clamp(1 - (this.t - s.pinT) / k.glint) : 0, this.bound(s, f, A, u) * Math.max(v, 1) * 1.04 + 0.006], i * 4);
      (u.pts || []).slice(0, k.npts).forEach((p, j) => { const o = (i * k.npts + j) * 3; pts[o] = ch[0] + (p[0] - ch[0]) * v; pts[o + 1] = ch[1] + (p[1] - ch[1]) * v; pts[o + 2] = (p[2] || 0) * v; });
      if (s.state !== 'spawning') any = Math.max(any, s.alpha); });
    const r = this.ride;
    return { uSfA: a, uSfB: b, uSfC: c, uSfD: d, uSfE: e, uSfF: F, uSfG: G, uSfP: pts, uSfAny: any, uSfRide: r ? [r.at[0], r.at[1], r.value, 1] : [0, 0, 0, 0] };
  }
  // what the legend shows
  publish() {
    const side = (ids) => { const s = (ids || '').split(',').map(id => this._side?.[id]).filter(Boolean); return s.length === 1 ? s[0] : ''; };
    const nm = (s) => `${this.T[s.type].name} · ${this.looks[s.look]?.name || '?'}`;
    const surfaces = this.list.map(s => ({ id: s.id, type: s.type, shape: this.T[s.type].name, group: s.group, behind: s.bh > 0.5, look: this.looks[s.look]?.id, lookName: this.looks[s.look]?.name, state: s.state, value: this.val[s.look] }));
    const rows = [];
    for (const s of this.list) {
      if (s.state === 'spawning') { if (!rows.some(r => r.state === 'armed' && r.label === `${this.T[s.type].name} · forming`)) rows.push({ hand: '', gesture: this.T[s.type].spawn.gesture, label: `${this.T[s.type].name} · forming`, value: s.prog, state: 'armed' }); }
      else if (s.state === 'live') rows.push({ hand: '', gesture: this.T[s.type].spawn.gesture, label: nm(s), value: null, state: 'engaged' });
      else if (s.state === 'held') rows.push({ hand: s.grab?.n === 2 ? '' : side(s.grab?.key), gesture: s.grab?.n === 2 ? 'two-hand pinch' : 'pinch-hold', label: nm(s), value: null, state: 'engaged' });
      else if (s.state === 'pinned') rows.push({ hand: '', gesture: s.hover > 0.5 ? 'pinch to grab' : '', label: nm(s), value: null, state: s.hover > 0.5 ? 'armed' : 'released' });
    }
    if (this.ride) rows.push({ hand: this.ride.hand, gesture: 'pinch-drag', label: `${this.looks[this.ride.look].name} · ${this.looks[this.ride.look].param || 'amount'}`, value: this.ride.value, state: 'engaged' });
    // one legend row per way of making something, one-hand ways first (a phone is held in the other hand)
    const hints = []; for (const T of this.types.slice().sort((x, y) => (x.hintOrder || 0) - (y.hintOrder || 0))) if (T.hint !== false && !hints.some(x => x.name === T.name && x.gesture === T.spawn.gesture)) hints.push({ type: T.id, name: T.name, gesture: T.spawn.gesture, hands: T.hands || 2 });
    // regions: the same list under the app's name for it (a Region row = a Group that hosts a look, placed by hand, at most `cap`)
    return { surfaces, regions: surfaces, rows, hints, cap: this.k.cap, things: this.things() };
  }
}
