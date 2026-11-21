// Unified single-page studio controller for Vizvim.
// Works directly on top of ./lab/harness.js (window.__lab) with zero page reloads.

const CATALOG = [
  { id: 'passthrough', name: 'Original', cat: 'Camera', desc: 'Clean live camera with no effect applied.', tags: [] },
  // Print
  { id: 'halftone', name: 'Halftone', cat: 'Print', desc: 'Comic and newsprint dots that hold still.', tags: [] },
  { id: 'risograph', name: 'Risograph', cat: 'Print', desc: 'Three-ink riso print with grain and misregistration.', tags: [] },
  { id: 'cyanotype', name: 'Cyanotype', cat: 'Print', desc: 'Prussian-blue contact print on tea paper.', tags: ['Depth'] },
  { id: 'martens', name: 'Martens', cat: 'Print', desc: 'Rotated icon rosettes in three inks.', tags: ['Hands'] },
  { id: 'green-bleach', name: 'Green Bleach', cat: 'Print', desc: 'White and green overprint.', tags: ['Hands'] },
  { id: 'grain-dither', name: 'Grain Dither', cat: 'Print', desc: 'Fine ordered dither with film grain.', tags: [] },
  { id: 'ascii-type', name: 'ASCII Type', cat: 'Print', desc: 'You, set in type.', tags: ['Hands'] },
  { id: 'quadtree', name: 'Quadtree', cat: 'Print', desc: 'Blocks that split where there is detail.', tags: ['Depth'] },
  // Screen
  { id: 'crt-teal', name: 'CRT Teal', cat: 'Screen', desc: 'Mono raster tube, one line at a time.', tags: ['Hands'] },
  { id: 'vhs-tape', name: 'VHS Tape', cat: 'Screen', desc: 'Tracking, snow and the date in the corner.', tags: ['Hands'] },
  { id: 'tv-scan', name: 'TV Scan', cat: 'Screen', desc: 'Scanlines that bend around you.', tags: ['Depth'] },
  { id: 'depth-thermal', name: 'Depth Thermal', cat: 'Screen', desc: 'Heat camera from depth.', tags: ['Depth'] },
  { id: 'depth-map', name: 'Depth Map', cat: 'Screen', desc: 'The room as distance.', tags: ['Depth', 'Hands'] },
  // Light
  { id: 'ghost-light', name: 'Ghost Light', cat: 'Light', desc: 'A glowing trace of your outline.', tags: [] },
  { id: 'invisible', name: 'Invisible', cat: 'Light', desc: 'Step out of the frame and the room fills in.', tags: ['Depth'] },
  // Hands
  { id: 'hand-pixelate', name: 'Hand Pixelate', cat: 'Hands', desc: 'Pixelate whatever sits between your hands.', tags: ['Hands'] },
  { id: 'hand-pixel-field', name: 'Hand Pixel Field', cat: 'Hands', desc: 'Pixels that follow your fingers.', tags: ['Hands'] },
  { id: 'hand-wipe', name: 'Hand Wipe', cat: 'Hands', desc: 'Wipe one look away to reveal another.', tags: ['Hands'] },
  { id: 'hand-webs', name: 'Hand Webs', cat: 'Hands', desc: 'Webs between your fingertips, each its own look.', tags: ['Hands'] },
  { id: 'prism', name: 'Prism', cat: 'Hands', desc: 'A ribbon of colour strung between fingers.', tags: ['Hands'] },
  { id: 'imagine', name: 'Imagine', cat: 'Hands', desc: 'Draw frames, boxes and portals in the air.', tags: ['Hands', 'Depth'] },
];

const CATEGORIES = ['All', 'Print', 'Screen', 'Light', 'Hands'];
const CYCLE_IDS = CATALOG.filter(e => e.id !== 'passthrough').map(e => e.id);
const byId = Object.fromEntries(CATALOG.map(e => [e.id, e]));

const $ = (id) => document.getElementById(id);

const ui = {
  cat: 'All',
  query: '',
  currentId: new URLSearchParams(location.search).get('fx') || 'halftone',
  inspTab: 'adjust',
  mobileTab: 'effects',
  bypassHold: false,
  bypassLocked: false,
};

// ---------------- Effects Library Rendering ----------------
function renderCats() {
  const bar = $('catBar');
  bar.innerHTML = '';
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-pill' + (ui.cat === cat ? ' on' : '');
    btn.textContent = cat;
    btn.onclick = () => { ui.cat = cat; renderCats(); renderList(); };
    bar.append(btn);
  }
}

function renderList() {
  const list = $('fxList');
  list.innerHTML = '';
  const q = ui.query.trim().toLowerCase();
  const filtered = CATALOG.filter(item => {
    if (ui.cat !== 'All' && item.cat !== ui.cat && !(item.id === 'passthrough' && !q && ui.cat === 'All')) {
      return false;
    }
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.desc.toLowerCase().includes(q) ||
      item.cat.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      item.tags.some(t => t.toLowerCase().includes(q))
    );
  });

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'fx-empty';
    empty.textContent = 'No effects match that filter.';
    list.append(empty);
    return;
  }

  let lastCat = '';
  for (const item of filtered) {
    if (ui.cat === 'All' && !q && item.cat !== lastCat) {
      lastCat = item.cat;
      const label = document.createElement('div');
      label.className = 'fx-group-label';
      label.textContent = item.cat;
      list.append(label);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-item' + (item.id === ui.currentId ? ' on' : '');
    btn.dataset.fx = item.id;
    btn.setAttribute('aria-current', item.id === ui.currentId ? 'true' : 'false');

    const top = document.createElement('div');
    top.className = 'fx-item-top';
    const name = document.createElement('span');
    name.className = 'fx-item-name';
    name.textContent = item.name;
    top.append(name);

    if (item.tags.length) {
      const tags = document.createElement('span');
      tags.className = 'fx-tags';
      for (const t of item.tags) {
        const b = document.createElement('span');
        b.className = 'fx-badge';
        b.textContent = t;
        tags.append(b);
      }
      top.append(tags);
    }

    const desc = document.createElement('span');
    desc.className = 'fx-item-desc';
    desc.textContent = item.desc;

    btn.append(top, desc);
    btn.onclick = () => selectEffect(item.id);
    list.append(btn);
  }
}

function syncActiveEffect(id, mod) {
  ui.currentId = id;
  const meta = byId[id] || { name: mod?.name || id, desc: '', cat: '', tags: [] };
  $('fxTitle').textContent = meta.name;
  $('fxDesc').textContent = meta.desc || 'Live WebGL effect.';
  $('liveFxName').textContent = meta.name;
  document.title = `${meta.name} · Vizvim`;

  for (const el of $('fxList').querySelectorAll('.fx-item')) {
    const active = el.dataset.fx === id;
    el.classList.toggle('on', active);
    el.setAttribute('aria-current', active ? 'true' : 'false');
    if (active) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Empty params hint for effects with zero controls (e.g. Original / passthrough)
  const paramsBox = $('params');
  const emptyHint = $('paramsEmpty');
  if (paramsBox && emptyHint) {
    const hasParams = (mod?.params?.length ?? paramsBox.children.length) > 0;
    emptyHint.classList.toggle('hide', hasParams);
    $('resetBtn').disabled = !hasParams;
    $('resetBtn').style.opacity = hasParams ? '' : '0.4';
  }

  syncHandsDot();
}

async function selectEffect(id) {
  if (!window.__lab) return;
  setBypass(false);
  ui.bypassLocked = false;
  syncActiveEffect(id);
  await window.__lab.selectEffect(id);
}

function stepEffect(delta) {
  const idx = CYCLE_IDS.indexOf(ui.currentId);
  const next = idx < 0
    ? CYCLE_IDS[0]
    : CYCLE_IDS[(idx + delta + CYCLE_IDS.length) % CYCLE_IDS.length];
  selectEffect(next);
}

// ---------------- Inspector & Mobile Tabs ----------------
function setInspectorTab(tab) {
  ui.inspTab = tab;
  for (const btn of document.querySelectorAll('.insp-tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('paneAdjust').classList.toggle('hidden', tab !== 'adjust');
  $('paneHands').classList.toggle('hidden', tab !== 'hands');
  $('paneDebug').classList.toggle('hidden', tab !== 'debug');
}

function setMobileTab(tab) {
  ui.mobileTab = tab;
  document.body.dataset.mobileTab = tab;
  for (const btn of document.querySelectorAll('.mob-tab')) {
    btn.classList.toggle('on', btn.dataset.mtab === tab);
  }
  if (tab === 'adjust') setInspectorTab('adjust');
  if (tab === 'hands') setInspectorTab('hands');
}

function syncHandsDot() {
  const hs = window.__hs;
  const active = !!(hs?.cfg || byId[ui.currentId]?.tags?.includes('Hands'));
  $('handsDot').classList.toggle('show', active);
}

// ---------------- Camera, Bypass, Freeze, Snapshot ----------------
function setBypass(on) {
  if (!window.__lab) return;
  window.__lab.setBypass(on);
  $('compareBtn').classList.toggle('on', on);
  $('bypassBadge').classList.toggle('show', on);
}

function syncFreeze(frozen) {
  $('freezeBtn').classList.toggle('on', frozen);
  $('liveDot').classList.toggle('frozen', frozen);
  $('freezeBtn').title = frozen ? 'Resume live feed (Space)' : 'Freeze frame (Space)';
}

function syncMirror() {
  const on = !!window.__lab?.getMirror();
  $('mirrorBtn').classList.toggle('on', on);
}

function takeSnapshot() {
  const canvas = $('out');
  if (!canvas || !canvas.width) return;
  const flash = $('flash');
  flash.classList.add('pop');
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('pop')));
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `vizvim-${ui.currentId}-${stamp}.png`;
  a.href = window.__lab?.captureDataURL ? window.__lab.captureDataURL() : canvas.toDataURL('image/png');
  a.click();
}

function showCamOverlay(message) {
  $('camErrorDetail').textContent = message || 'Camera permission was not granted or no camera was detected.';
  $('camOverlay').classList.add('show');
  $('liveDot').classList.add('off');
}

function hideCamOverlay() {
  $('camOverlay').classList.remove('show');
  $('liveDot').classList.remove('off');
}

// ---------------- Wire Up Controls ----------------
function init() {
  renderCats();
  renderList();
  document.body.dataset.mobileTab = ui.mobileTab;
  $('fxCount').textContent = `${CATALOG.length - 1}`;

  // Search
  const search = $('fxSearch');
  const clearBtn = $('fxSearchClear');
  search.addEventListener('input', () => {
    ui.query = search.value;
    clearBtn.classList.toggle('hide', !ui.query);
    renderList();
  });
  clearBtn.addEventListener('click', () => {
    search.value = '';
    ui.query = '';
    clearBtn.classList.add('hide');
    renderList();
    search.focus();
  });

  // Inspector & mobile tabs
  for (const btn of document.querySelectorAll('.insp-tab')) {
    btn.addEventListener('click', () => setInspectorTab(btn.dataset.tab));
  }
  for (const btn of document.querySelectorAll('.mob-tab')) {
    btn.addEventListener('click', () => setMobileTab(btn.dataset.mtab));
  }

  // Prev / Next / Reset
  $('prevBtn').addEventListener('click', () => stepEffect(-1));
  $('nextBtn').addEventListener('click', () => stepEffect(1));
  $('resetBtn').addEventListener('click', () => window.__lab?.resetParams());

  // Upload media
  const fileInput = $('fileInput');
  const openPicker = () => fileInput.click();
  $('uploadBtn').addEventListener('click', openPicker);
  $('camUploadBtn').addEventListener('click', openPicker);
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) {
      hideCamOverlay();
      window.__lab?.setSource(f);
    }
    fileInput.value = '';
  });

  // Camera overlay buttons
  $('camRetryBtn').addEventListener('click', () => {
    hideCamOverlay();
    window.__lab?.setSource('cam');
  });
  $('camDemoBtn').addEventListener('click', () => {
    hideCamOverlay();
    window.__lab?.setSource('demo');
  });

  // Dock actions
  $('mirrorBtn').addEventListener('click', () => {
    window.__lab?.setMirror();
    syncMirror();
  });

  // Compare original: hold > 240ms for momentary peek, quick click to toggle
  const cmp = $('compareBtn');
  let cmpDownAt = 0;
  cmp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cmpDownAt = performance.now();
    if (ui.bypassLocked) {
      ui.bypassLocked = false;
      ui.bypassHold = false;
      setBypass(false);
    } else {
      ui.bypassHold = true;
      setBypass(true);
    }
  });
  cmp.addEventListener('pointerup', () => {
    if (!ui.bypassHold) return;
    ui.bypassHold = false;
    if (performance.now() - cmpDownAt > 240) {
      setBypass(false);
    } else {
      ui.bypassLocked = true;
      setBypass(true);
    }
  });
  const cancelHold = () => {
    if (ui.bypassHold) { ui.bypassHold = false; setBypass(false); }
  };
  cmp.addEventListener('pointerleave', cancelHold);
  cmp.addEventListener('pointercancel', cancelHold);

  $('freezeBtn').addEventListener('click', () => {
    window.__lab?.freeze();
  });

  $('snapBtn').addEventListener('click', takeSnapshot);

  $('focusBtn').addEventListener('click', () => {
    const on = document.body.classList.toggle('focus-mode');
    $('focusBtn').classList.toggle('on', on);
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); stepEffect(-1); }
    else if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); stepEffect(1); }
    else if ((e.key === 'o' || e.key === 'O') && !e.repeat) { setBypass(true); }
    else if (e.key === 'f' || e.key === 'F') {
      const on = document.body.classList.toggle('focus-mode');
      $('focusBtn').classList.toggle('on', on);
    }
    else if (e.key === 'm' || e.key === 'M') { window.__lab?.setMirror(); syncMirror(); }
    else if (e.key === 's' || e.key === 'S') { takeSnapshot(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'o' || e.key === 'O') { setBypass(ui.bypassLocked); }
  });

  // Harness reactive events
  window.addEventListener('vz:effect', (e) => {
    syncActiveEffect(e.detail.id, e.detail.mod);
  });
  window.addEventListener('vz:source', () => {
    hideCamOverlay();
    syncMirror();
  });
  window.addEventListener('vz:cam-error', (e) => {
    showCamOverlay(e.detail?.message);
  });
  window.addEventListener('vz:status', (e) => {
    const text = (e.detail?.text || '').trim();
    $('statusText').textContent = text;
    $('statusPill').classList.toggle('show', !!text);
  });
  window.addEventListener('vz:freeze', (e) => {
    syncFreeze(!!e.detail?.frozen);
  });
  window.addEventListener('vz:handsignal', () => {
    syncHandsDot();
  });

  // Initial sync once harness boots
  syncActiveEffect(ui.currentId);
  if (window.__lab?.whenReady) {
    window.__lab.whenReady.then(() => {
      if (window.__lab?.state?.mod?.id) {
        syncActiveEffect(window.__lab.state.mod.id, window.__lab.state.mod);
      }
      syncMirror();
    });
  }
}

init();
