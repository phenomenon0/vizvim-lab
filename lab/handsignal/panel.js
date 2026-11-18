// hand-signal v2 — the mapping UI (browser only). Spec: breakdowns/hand-signal-v2.md section 3.
//   buildMapUI(H, root)   inside the existing "Hand signals" section: Left-handed / Everywhere / Reset chips and a one-line note;
//                         on every control of the look's own panel: a small hand (tap = teach) and, when bound, a chip naming
//                         the gesture (tap = edit in place, long-press = clear). No panel of its own, no per-effect UI.
//   buildLegend(H)        on the picture: one line per binding that is live. Hand colour, gesture, control, value.
//                         armed = outline, engaged = filled, released = fading. Nothing when no hand is up.
import { MODALITIES, kindOf, options, optionLabel, defaults, decompile, modality, label, FEEL, CURVE_NAMES, TWO } from './mapping.js';

const HAND_L = '#d9dce1';                 // user's left hand: cool white. Right hand: the accent. Same in the skeleton, the rings, the chips.
const SVG = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.6V3.1M5 6V1.9M6.8 6V2.3M8.6 6.4V3.5M3.2 6.6 1.9 5.4M3.2 6.4v1.4c0 1.6 1.2 2.7 2.8 2.7s2.6-1 2.6-2.6V6.2"/></svg>';
const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
const fmtVal = (p, v) => (p.type === 'enum' ? (p.options || [])[Math.round(v)] ?? '' : p.type === 'bool' ? (v ? 'on' : 'off') : p.type === 'int' ? String(Math.round(v)) : Math.abs((p.max ?? 1) - (p.min ?? 0)) >= 50 ? (+v).toFixed(1) : (+v).toFixed(2));
const handColor = (hand, acc) => (hand === 'L' ? HAND_L : acc);

// two opposite swipes on one control read as one gesture
const pairLabel = (H, pid, text) => { const B = (H.last && H.last.bind || []).filter(b => b.pid === pid).map(b => H.cfg && H.cfg.bindings[b.i]).filter(Boolean), on = B.map(d => d.on);
  if (on.includes('swipeUp') && on.includes('swipeDown')) return 'swipe ↕'; if (on.includes('swipeLeft') && on.includes('swipeRight')) return 'swipe ↔'; return text; };

export function buildMapUI(H, root) {
  const css = getComputedStyle(document.documentElement), ACC = css.getPropertyValue('--acc').trim() || '#19e0c8';
  const st = document.createElement('style');
  st.textContent = `.hsg{cursor:pointer;color:var(--dim);display:inline-flex;align-items:center;margin-left:3px;padding:2px 4px;opacity:.8;vertical-align:-3px}.hsg svg{width:13px;height:13px}
.hsg:hover{color:var(--fg);opacity:1}.hsg.arm{color:var(--acc);opacity:1;animation:hsp 0.9s ease-in-out infinite}
@keyframes hsp{50%{opacity:.35}}
.hsc{flex:none;margin-left:auto;margin-right:6px;font-size:10px;line-height:15px;padding:0 6px;border-radius:999px;border:1px solid var(--acc);color:var(--acc);cursor:pointer;white-space:nowrap;user-select:none}
.hsc.l{border-color:${HAND_L};color:${HAND_L}}.hsc.open{background:var(--acc);color:#06110f}.hsc.l.open{background:${HAND_L}}
.hse{display:flex;flex-direction:column;gap:4px;padding:5px 0 3px}.hse .chips{gap:3px}.hse .chip{padding:1px 7px;font-size:10px}
.hse .cap{color:var(--dim);font-size:10px;width:38px;flex:none;padding-top:2px}.hse .ln{display:flex;gap:4px;align-items:flex-start}
.hse input{width:52px;background:#1b1e22;border:1px solid var(--line);color:var(--fg);border-radius:4px;font:inherit;font-size:10px;padding:1px 4px}`;
  document.head.append(st);

  // ---- section controls: who you are + what to do with this mapping
  const bar = el('div'); bar.className = 'chips';
  const chip = (text, title, fn) => { const c = el('span', '', text); c.className = 'chip'; c.title = title; c.onclick = fn; bar.append(c); return c; };
  const left = chip('Left-handed', 'swap which hand every binding listens to', () => H.map.handed(H.store.handed === 'L' ? 'R' : 'L'));
  const every = chip('Everywhere', 'use this mapping on every look that has no mapping of its own (targets follow by role: main, second, first choice, first switch)', () => H.map.everywhere());
  const reset = chip('Reset', 'drop your changes on this look', () => H.map.reset());
  const note = el('div', 'color:var(--acc);font-size:11px;line-height:1.4;min-height:15px');
  root.insertBefore(bar, root.children[2] || null); root.insertBefore(note, bar.nextSibling);

  // ---- per-control decoration
  let rows = [], open = null, stampMod = null, lastSig = '';
  const box = document.getElementById('params');
  const closeEditor = () => { if (open) { open.ed.remove(); open.chip?.classList.remove('open'); open = null; } };
  function editor(p, row, chipEl) {
    const ed = el('div'); ed.className = 'hse';
    const render = () => {
      ed.innerHTML = ''; const f = H.map.bindingFor(p.id), kind = kindOf(p);
      const spec = f && f.key === 'target' && modality(f.b) !== 'Preset' && modality(f.b) !== 'Set' ? decompile(f.b) : null;
      const line = (cap, items, cur, pick, lab = (x) => x) => { const ln = el('div'); ln.className = 'ln'; ln.append(Object.assign(el('span', '', cap), { className: 'cap' })); const cs = el('div'); cs.className = 'chips';
        for (const it of items) { const c = el('span', '', lab(it)); c.className = 'chip' + (it === cur ? ' on' : ''); c.onclick = () => pick(it); cs.append(c); } ln.append(cs); ed.append(ln); return cs; };
      const put = (s) => { H.map.put(p.id, s); render(); };
      line('how', MODALITIES[kind], spec ? spec.modality : null, (m) => put(spec && spec.modality === m ? spec : { ...defaults(m, p), hand: spec ? spec.hand : 'any', from: spec ? spec.from : 0, to: spec ? spec.to : 1 }));
      if (!spec) { if (f) ed.append(el('div', 'color:var(--dim);font-size:10px', `from the preset: ${label(f.b, f.key)}. Pick how to replace it.`)); }
      else {
        line('with', options(spec.modality, p), spec.signal, (s) => put({ ...spec, signal: s, feel: spec.feel || (spec.modality === 'Clutch' ? 'Normal' : 'Tight') }), optionLabel);
        if (!TWO.includes(spec.signal) && spec.signal !== 'clap') line('hand', ['any', 'L', 'R'], spec.hand, (h) => put({ ...spec, hand: h }), (h) => (h === 'any' ? 'Either' : h === 'L' ? 'Left' : 'Right'));
        if (kind === 'float' && (spec.modality !== 'Step')) {
          const ln = el('div'); ln.className = 'ln'; ln.append(Object.assign(el('span', '', 'range'), { className: 'cap' }));
          const lo = p.min ?? 0, hi = p.max ?? 1, toP = (n) => +(lo + n * (hi - lo)).toFixed(3), toN = (v) => Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-9)));
          const a = el('input'), b = el('input'); a.value = toP(spec.from); b.value = toP(spec.to); a.title = 'value at the start of the gesture'; b.title = 'value at the end (smaller than the first = inverted)';
          const commit = () => { const x = parseFloat(a.value), y = parseFloat(b.value); if (isFinite(x) && isFinite(y) && x !== y) put({ ...spec, from: toN(x), to: toN(y) }); };
          a.onchange = commit; b.onchange = commit; ln.append(a, el('span', 'color:var(--dim)', '→'), b); ed.append(ln);
        }
        if (spec.modality === 'Clutch') line('feel', spec.feel ? Object.keys(FEEL.Clutch) : [...Object.keys(FEEL.Clutch), 'Learned'], spec.feel || 'Learned', (x) => x !== 'Learned' && put({ ...spec, feel: x }));
        if (spec.modality === 'Direct' && kind === 'float') { line('curve', Object.keys(CURVE_NAMES), spec.curve, (c) => put({ ...spec, curve: c })); line('feel', Object.keys(FEEL.Direct), spec.feel, (x) => put({ ...spec, feel: x }));
          if (!TWO.includes(spec.signal)) line('live', ['Always', 'Pinched'], spec.gate, (g) => put({ ...spec, gate: g })); }
      }
      if (f) { const c = el('span', 'align-self:flex-start', 'Clear'); c.className = 'chip'; c.onclick = () => { H.map.clear(p.id); closeEditor(); }; ed.append(c); }
    };
    render(); row.append(ed); return { ed, render, pid: p.id, chip: chipEl };
  }
  function decorate() {
    rows = []; closeEditor(); const S = H.S, ps = S.params || [], order = [...ps.filter(p => !p.more), ...ps.filter(p => p.more)];
    const els = [...box.querySelectorAll('.row')]; stampMod = S.mod; if (H.playMode && H.playMode()) { sync(); return; }      // a look that owns the hands has nothing to teach
    order.forEach((p, i) => {
      const row = els[i]; if (!row || p.type === 'color') return; let top = row.querySelector('.top');
      const g = el('span'); g.className = 'hsg'; g.innerHTML = SVG; g.title = 'tap, then do the gesture you want for this control. Long-press (or right-click) to pick it by hand.';
      const c = el('span'); c.className = 'hsc'; c.style.display = 'none';
      if (top) { const lab = top.firstElementChild; const grp = el('span', 'margin-right:auto;display:inline-flex;align-items:center'); top.insertBefore(grp, lab); grp.append(lab, g); top.style.gap = '6px'; top.insertBefore(c, grp.nextSibling); }
      else { const line = el('div', 'display:flex;align-items:center;gap:6px'); row.insertBefore(line, row.firstChild); line.append(row.querySelector('.chip'), g, c); }   // bool rows: the chip is the control
      let gp = null; const pick = () => { H.map.cancel(); closeEditor(); open = editor(p, row, c); };
      g.onpointerdown = () => { gp = setTimeout(() => { gp = 'done'; pick(); }, 550); }; g.onpointerup = g.onpointerleave = () => { if (gp !== 'done') clearTimeout(gp); };      // long-press the hand: pick by hand instead of teaching
      g.onclick = () => { if (gp === 'done') { gp = null; return; } if (H.learn.armed && H.learn.p.id === p.id) H.map.cancel(); else H.map.learn(p.id); };
      let press = null; c.onpointerdown = () => { press = setTimeout(() => { press = 'done'; H.map.clear(p.id); }, 550); };
      c.onpointerup = c.onpointerleave = () => { if (press !== 'done') clearTimeout(press); };
      c.onclick = () => { if (press === 'done') { press = null; return; } if (open && open.pid === p.id) { closeEditor(); return; } closeEditor(); open = editor(p, row, c); c.classList.add('open'); };
      g.oncontextmenu = (e) => { e.preventDefault(); closeEditor(); open = editor(p, row, c); };      // right-click the hand: open the picker without teaching
      rows.push({ p, row, g, c });
    });
    stampMod = S.mod; sync();
  }
  function sync() {
    const host = H.cfg; left.classList.toggle('on', H.store.handed === 'L');
    const custom = !!host && host.id === 'custom' && !(H.playMode && H.playMode()); every.style.display = reset.style.display = custom ? '' : 'none';
    every.classList.toggle('on', custom && H.store.source(H.S.mod?.wraps || H.S.mod?.id || '') !== 'effect' && !!H.store.d.global);
    for (const r of rows) {
      const f = H.cfg ? H.map.bindingFor(r.p.id) : null; r.c.style.display = f ? '' : 'none';
      if (f) { let hand = f.b.hand; if (H.store.handed === 'L' && (hand === 'L' || hand === 'R')) hand = hand === 'L' ? 'R' : 'L'; r.c.textContent = pairLabel(H, r.p.id, label({ ...f.b, hand }, f.key === 'target' ? null : f.key)); r.c.classList.toggle('l', hand === 'L'); r.c.title = 'tap to edit, long-press to clear'; }
      r.g.classList.toggle('arm', H.learn.armed && H.learn.p.id === r.p.id);
    }
    if (open) { if (rows.some(r => r.p.id === open.pid)) open.render(); else closeEditor(); }
  }
  function draw() {
    if (H.S.mod !== stampMod || (H.S.params || []).length && !box.querySelector('.hsg') && !(H.playMode && H.playMode())) decorate();
    const n = H.note, t = H.lastT, lp = H.learn.armed ? H.learn.p : null, k = lp ? (lp.type === 'bool' ? 'bool' : lp.type === 'enum' ? 'enum' : 'num') : '';
    const txt = lp ? `${lp.label || lp.id}: ` + (k === 'num' ? 'pinch and drag any way, or hold a pose' : k === 'enum' ? 'swipe, pinch and drag, or hold a pose' : 'hold a pose, swipe, clap or double-pinch') + '. Tap the hand again to cancel.' : n && t - n.t < 6 && t >= n.t ? n.text : '';
    if (txt !== note.textContent) note.textContent = txt;
    const sig = (H.learn.armed ? H.learn.p.id : '') + '|' + (H.cfg ? H.cfg.id + H.cfg.bindings.length : '');
    if (sig !== lastSig) { lastSig = sig; sync(); }
  }
  decorate();
  return { sync, draw, decorate, open: (pid) => { const r = rows.find(x => x.p.id === pid); if (r) { closeEditor(); open = editor(r.p, r.row, r.c); r.c.classList.add('open'); } }, ACC };
}

// ---------------------------------------------------------------- legend
export function buildLegend(H) {
  const stage = document.getElementById('stage'), cv = document.getElementById('out'); if (!stage || !cv) return null;
  const css = getComputedStyle(document.documentElement), ACC = css.getPropertyValue('--acc').trim() || '#19e0c8';
  const root = el('div', 'position:absolute;pointer-events:none;display:none;flex-direction:column;align-items:flex-start;gap:4px;font:11px/1.3 ui-monospace,Menlo,monospace;color:#f4f6f8;z-index:3;background:rgba(8,10,12,.8);border-radius:9px;padding:7px 11px 7px 9px;box-shadow:0 0 0 1px rgba(255,255,255,.1),0 4px 18px rgba(0,0,0,.35);max-width:calc(100% - 24px);box-sizing:border-box;overflow:hidden');
  stage.append(root); const pool = [];
  const mkRow = () => { const r = el('div', 'display:flex;align-items:center;gap:7px;white-space:nowrap');
    r.dot = el('span', 'width:7px;height:7px;border-radius:50%;box-sizing:border-box;flex:none');
    // hint rows: how many hands the gesture takes, as one or two dots (a phone user holding the phone needs the one-dot rows)
    r.hands = el('span', 'display:none;width:15px;flex:none;letter-spacing:1px;font-size:.8em'); r.ges = el('span', 'min-width:76px'); r.lab = el('span', 'min-width:70px;opacity:.85');
    r.bar = el('span', 'width:64px;height:2px;background:rgba(255,255,255,.22);position:relative;flex:none'); r.fill = el('span', 'position:absolute;left:0;top:0;bottom:0'); r.bar.append(r.fill);
    r.val = el('span', 'min-width:38px'); r.append(r.dot, r.hands, r.ges, r.lab, r.bar, r.val); root.append(r); return r; };
  let upT = -9, hadHand = false;
  // skel=1: replayed tracks have no hand in the plate, so the tracked hands are ghosted over the picture (shots and demos only)
  const ghost = H.opts.skel === '1' ? el('canvas', 'position:absolute;pointer-events:none;z-index:2;background:transparent') : null; if (ghost) stage.append(ghost);
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  function drawGhost(st, cr, sr) {
    const w = Math.round(cr.width), h = Math.round(cr.height); if (ghost.width !== w || ghost.height !== h) { ghost.width = w; ghost.height = h; }
    ghost.style.left = cr.left - sr.left + 'px'; ghost.style.top = cr.top - sr.top + 'px'; ghost.style.width = w + 'px'; ghost.style.height = h + 'px';
    const g = ghost.getContext('2d'); g.clearRect(0, 0, w, h); g.lineCap = 'round';
    for (const T of st.hands) { if (!T.live || !T.lm) continue; const col = handColor(T.side, ACC), X = (i) => T.lm[i * 3] * w, Y = (i) => T.lm[i * 3 + 1] * h;
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 5; g.beginPath(); for (const [a, b] of BONES) { g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); } g.stroke();
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); for (const [a, b] of BONES) { g.moveTo(X(a), Y(a)); g.lineTo(X(b), Y(b)); } g.stroke();
      if (T.pinched) { g.fillStyle = col; g.beginPath(); g.arc((X(4) + X(8)) / 2, (Y(4) + Y(8)) / 2, 7, 0, 7); g.fill(); } }
  }
  function draw() {
    const L = H.last; if (!L) return; const st = L.st, t = st.t, S = H.S;
    const cr = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect(); root.style.left = cr.left - sr.left + 12 + 'px'; root.style.bottom = sr.bottom - cr.bottom + 12 + 'px';
    if (ghost) drawGhost(st, cr, sr);
    // type scales with the picture as it is shown: 10 px on a 390 pt phone, 11 at the lab's usual width, 15 on a 1080p-wide stage
    const fs = Math.max(10, Math.min(15, cr.width / 100)); root.style.fontSize = fs.toFixed(1) + 'px'; const narrow = cr.width < 520;
    const anyHand = st.hands.some(h => h.live); if (anyHand && !hadHand) upT = t; hadHand = anyHand; if (t < upT) upT = t;
    const items = [];
    if (L.teach) items.push({ hand: '', state: 'engaged', a: 1, ges: 'teach', lab: L.teach.label, v: L.teach.phase === 'waiting' ? null : Math.min(1, L.teach.amount / (L.teach.phase === 'holding' ? 1 : 0.6)),
      val: L.teach.phase === 'dragging' ? ({ x: '↔', y: '↕', roll: 'turn', depth: 'push', spread: 'apart', twist: 'steer' }[L.teach.axis] || '') : L.teach.phase === 'holding' ? L.teach.axis : 'do it' });
    else if (H.hudOn && H.cfg) {
      const anyOn = L.bind.some(b => b.state === 'engaged'), fresh = t - upT < 2.5;
      for (const b of L.bind) {
        const def = H.cfg.bindings[b.i], p = (S.params || []).find(q => q.id === b.pid); if (!def || !p || b.state === 'idle') continue;
        const a = b.state === 'engaged' ? 1 : b.state === 'released' ? Math.max(0, 1 - (t - b.since) / 1.2) * 0.9 + 0.1 * (anyHand ? 1 : 0) : anyOn ? 0.25 : fresh ? 0.6 : 0.3;
        if (a < 0.02) continue; let hand = b.hand === 'LR' ? '' : b.hand;
        const it = { pid: b.pid, hand, state: b.state, a, ges: pairLabel(H, b.pid, label({ ...def, hand: def.hand === 'L' || def.hand === 'R' ? hand : def.hand })), lab: p.label || p.id, v: b.prog != null ? b.prog : p.type === 'bool' || p.type === 'enum' ? null : b.value, val: fmtVal(p, S.P[p.id] === true ? 1 : S.P[p.id] === false ? 0 : S.P[p.id]) };
        const same = items.find(x => x.pid === b.pid); if (!same) items.push(it); else if (it.a > same.a) Object.assign(same, it);      // one row per control
      }
    }
    // Imagine publishes its own rows (lab/handsignal/surfaces): same grammar, same place
    const im = H.playMode && H.playMode() && window.__hs ? window.__hs.imagine : null;
    if (im && Array.isArray(im.rows) && !L.teach) {
      for (const r of im.rows) items.push({ hand: r.hand || '', state: r.state || 'armed', a: r.state === 'engaged' ? 1 : r.state === 'released' ? 0.5 : 0.6, ges: r.label || '', lab: ({ 'pinch-hold': 'held', 'pinch-drag': 'pinch \u2195', 'two-hand pinch': 'both hands' })[r.gesture] || r.gesture || '', v: typeof r.value === 'number' ? r.value : null, val: typeof r.value === 'number' ? r.value.toFixed(2) : r.value ?? '' });
      // nothing made yet and a hand is up: how to make one (the only time the legend teaches)
      // (also with no hand up: with the idle demonstration on the picture it is the first thing a new user reads)
      // at phone width only the one-hand ways are listed: the other hand is holding the phone, and six rows would cover half the picture
      if (!im.rows.length && Array.isArray(im.hints)) for (const h of im.hints) if (!narrow || h.hands === 1) items.push({ hint: true, hands: h.hands || 2, hand: '', state: 'armed', a: h.hands === 1 ? 1 : 0.8, ges: h.name, lab: h.gesture.replace(/^(one hand|both hands): /, ''), v: null, val: '' });
    }
    const shown = items.slice(0, 6); root.style.display = shown.length ? 'flex' : 'none';
    while (pool.length < shown.length) pool.push(mkRow());
    pool.forEach((r, i) => {
      const it = shown[i]; if (!it) { r.style.display = 'none'; return; } r.style.display = 'flex'; r.style.opacity = Math.max(0.55, it.a).toFixed(2);
      const hint = !!it.hint; r.dot.style.display = hint ? 'none' : ''; r.hands.style.display = hint ? '' : 'none'; if (hint) r.hands.textContent = it.hands === 1 ? '\u25CF' : '\u25CF\u25CF';
      r.ges.style.minWidth = hint ? '3.6em' : narrow ? '5.5em' : '76px'; r.lab.style.minWidth = hint || narrow ? '0' : '70px'; r.bar.style.display = hint || it.v == null ? 'none' : ''; r.val.style.display = hint || it.val === '' ? 'none' : ''; r.bar.style.width = narrow ? '40px' : '64px';
      r.ges.style.fontWeight = hint ? '600' : '';
      const col = it.ges === 'teach' ? '#fff' : handColor(it.hand, ACC);
      r.dot.style.background = it.state === 'engaged' ? col : 'transparent'; r.dot.style.border = '1.5px solid ' + col;
      r.ges.textContent = it.ges; r.lab.textContent = it.lab; r.val.textContent = it.val;
      r.bar.style.visibility = it.v == null ? 'hidden' : 'visible'; r.fill.style.width = (100 * Math.min(1, Math.max(0, it.v || 0))).toFixed(1) + '%'; r.fill.style.background = it.state === 'engaged' ? col : 'rgba(255,255,255,.7)';
    });
  }
  return { draw, root };
}
