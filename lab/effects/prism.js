// prism — a multi-face shape held between two hands; every face shows a different look of the camera.
// Reference: DX68QiKuX5Z (wxll.hx, "tv scan, invisibility, and thermal camera"). Measured (breakdowns/prism.md):
// the reference shape is NOT a rigid cuboid. It is a ribbon of three quads strung between matching fingertips of
// the two hands:   thumb tip - index tip  = TV scan,   index tip - middle tip = invisible,
//                  middle tip - pinky tip = thermal.   Each face is a WINDOW onto the full-frame look (the look
// multiplied by the face's mask, as the maker's own tutorial reel DcoOO6JOtKo shows: "step 3: multiply"), so
// features sit at their true screen position. Opaque, unshaded, ~1.2 px white edge line.
// Spawn / collapse is pure geometry: the quads are as big as the gap between the hands, so they fold down to a
// sliver when the fingertips meet.
//
// Form = Ribbon reproduces that. Form = Box puts the same three looks on the faces of the hand-signal layer's
// oriented 3D box (uBox* uniforms from lab/handsignal/box.js, ray / box per pixel, true perspective):
// Y faces = Top, Z faces = Front, X faces = Body. Box needs a box config: ?hs=box3d (pinch to pull it out) or
// ?hs=box3d-hold (lives between two visible hands; for plates).
//
// Everything is per pixel in the fragment shader: face id -> look -> one function call. The CPU only moves the
// ribbon vertices (frame(), shared tracker in hand-region.js). Looks come from sibling modules as GLSL chunks + prepasses:
//   tv-scan.js   TV_PASSES + tvGlsl()   -> vec3 tvScan(vec2 uv)
//   invisible.js INV_PASSES + invGlsl() -> vec3 invLook(vec2 uv)
//   depth-thermal.js PRISM_GLSL + thBlur -> vec3 thPrism(blurredLuma, sharpLuma)  (its "Prism" palette)
// Any other lab effect on a face: ?webs=halftone,tv,risograph (same as hand-webs; hand-region.js hostSlots).
import { HS_DECL, HS_BOX, HS_HUD } from '../handsignal/glsl.js';
import { TV_PASSES, tvGlsl } from './tv-scan.js';
import { INV_PASSES, invGlsl } from './invisible.js';
import { PRISM_GLSL, thBlur } from './depth-thermal.js';
import { hostSlots, trackRegion, REGION_GLSL, FINGER_SET_NAMES } from './hand-region.js';

// Look slots, the same way as hand-webs: ?webs=a,b,c names the looks of the thumb-index, index-middle and
// middle-pinky quads (= Front, Body, Top). Built-ins: thermal, tv, invisible, cam; anything else is a lab effect id
// hosted through the harness (hand-region.js hostSlots) and added to the Top / Front / Body choices.
const BUILTIN = { thermal: 0, tv: 1, invisible: 2, cam: 3 };
const WEBS = (new URLSearchParams(location.search).get('webs') || 'tv,invisible,thermal').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
const EXTRA = [...new Set(WEBS.filter(id => !(id in BUILTIN)))];
const SLOTS = await hostSlots(EXTRA, {}, { tag: 'prism', fallback: () => 'texture(uCam, uv).rgb' });
const slotIx = (i, d) => { const id = WEBS[i]; return id == null ? d : id in BUILTIN ? BUILTIN[id] : 4 + EXTRA.indexOf(id); };

// this reel's thermal face = depth-thermal's "Prism" palette (measured ramp + tone + shade live there), fed by
// its own blurred luma (sigma 5 px at 1080) of tv-scan's half-res driver buffer.
const PZ_THERMAL = PRISM_GLSL + /* glsl */`
vec3 pzThermal(vec2 uv) {
  return thPrism(texture(uBuf_pz_th, uv).r, dot(texture(uCam, uv).rgb, vec3(0.299, 0.587, 0.114)));
}`;

const MAIN = REGION_GLSL + /* glsl */`
vec3 pzLook(float id, vec2 uv) {
  if (id < 0.5) return pzThermal(uv);
  if (id < 1.5) return tvScan(uv);
  if (id < 2.5) return mix(invLook(uv), vec3(0.80, 0.90, 1.0), 0.07);     // the reference's faint cool cast on the clear face
  if (id < 3.5) return texture(uCam, uv).rgb;
${SLOTS.exprs.map((e, i) => `  if (id < ${i + 4}.5) return ${e};`).join('\n')}
  return texture(uCam, uv).rgb;
}
// Mapping: Window = the reel (full-frame look multiplied by the face mask); Stretch = whole frame fitted to the face
vec2 pzMap(float id, vec2 st) { return u_map > 0.5 ? st : vUv; }
// oriented box with its half extents scaled (spawn / collapse), box space like hsBox
bool pzBox(vec3 rd, vec3 hf, out float tN, out vec3 pN, out vec3 nN) {
  mat3 Rt = transpose(uBoxRot); vec3 ro = Rt * (-uBoxCenter), d = Rt * rd; d += (1.0 - abs(sign(d))) * 1e-6;
  vec3 t1 = (-hf - ro) / d, t2 = (hf - ro) / d, ta = min(t1, t2), tb = max(t1, t2);
  tN = max(ta.x, max(ta.y, ta.z)); float tF = min(tb.x, min(tb.y, tb.z));
  if (tN > tF || tF < 0.0 || tN < 0.0) return false;
  pN = ro + d * tN;
  nN = vec3(0.0); if (tN == ta.x) nN.x = -sign(d.x); else if (tN == ta.y) nN.y = -sign(d.y); else nN.z = -sign(d.z);
  return true;
}

void main() {
  vec3 cam = texture(uCam, vUv).rgb, col = cam;
  if (u_solo > 0.5) { fragColor = vec4(pzLook(u_solo - 1.0, vUv), 1.0); return; }
  vec3 looks = vec3(u_top, u_front, u_body);
  vec3 lineCol = RG_LINE;

  if (u_form < 0.5) {
    // ---- Ribbon: three quads between matching fingertips (shared region shader, hand-region.js)
    vec2 p = vec2(vUv.x * uRes.x / uRes.y, vUv.y);
    for (int k = 0; k < 4; k++) {
      if (float(k) >= uRgN) break;
      vec4 R = uRgP[k];
      if (R.y <= 0.002) continue;
      vec2 st; float cov, line;
      if (!rgQuad(k, p, u_edge, 1.0, st, cov, line)) continue;
      // thumb-index quad = Front, index-middle = Body, last = Top
      float id = R.x < 0.5 ? looks.y : (R.x < 1.5 ? looks.z : looks.x);
      if (cov > 0.0) col = mix(col, pzLook(id, pzMap(id, st)), cov * R.y);
      col = mix(col, lineCol, line * u_edge * R.y);
    }
    fragColor = vec4(col, 1.0);
    return;
  }

  // ---- Box: the hand-signal layer's oriented box, ray-traced
  float act = uBoxActive;
  if (act > 0.003) {
    float grow = act * act * (3.0 - 2.0 * act); vec3 hf = uBoxHalf * mix(0.04, 1.0, grow);
    float tN; vec3 pN, nN; vec3 rd = hsRay(vUv);
    if (pzBox(rd, hf, tN, pN, nN)) {
      vec3 an = abs(nN);
      float id = an.y > 0.5 ? looks.x : (an.z > 0.5 ? looks.y : looks.z);
      vec2 fuv = an.y > 0.5 ? vec2(pN.x / hf.x, -pN.z / hf.z * nN.y) : (an.z > 0.5 ? vec2(pN.x / hf.x, pN.y / hf.y) : vec2(pN.z / hf.z * nN.x, pN.y / hf.y));
      vec2 uv = pzMap(id, fuv * 0.5 + 0.5);
      vec3 g = pzLook(id, uv);
      // each face catches the light a little differently, so the turn reads without glass tricks
      vec3 nc = uBoxRot * nN; g *= 0.94 + 0.1 * (dot(nc, normalize(vec3(-0.35, 0.8, -0.5))) * 0.5 + 0.5);
      // edge hairline, constant width in pixels
      vec3 r = hf - abs(pN); float e = an.x > 0.5 ? min(r.y, r.z) : (an.y > 0.5 ? min(r.x, r.z) : min(r.x, r.y));
      float pxm = tN * rd.z / (uBoxFocal * uRes.y), lw = 0.55 + 0.75 * uRes.x / 1080.0;
      g = mix(g, lineCol, u_edge * (1.0 - smoothstep(lw - 0.5, lw + 0.5, e / pxm)));
      g += lineCol * 0.2 * uBoxFlash * uBoxFlash;
      col = mix(cam, g, smoothstep(0.0, 0.35, act));
    }
  }
  fragColor = vec4(hsHud(col, vUv), 1.0);
}`;

// Ribbon corners = thumb, index, middle and PINKY tips of each hand (fitted against hand-marked corners of the
// reel on 10 frames, breakdowns/prism.md: pinky 4-35 px, ring 48-117 px on the outer corner) = finger set
// "Skip ring". Tracking (side assignment, occlusion-robust tips, dropout hold, damped follow) is hand-region.js.
let boxAsked = false;
function frame(ctx) {
  const P = ctx.params;
  // Box form needs a box config; if none is live, take the pinch one (same rule as box3d). Only when Box is chosen:
  // the Ribbon runs without the hand-signal layer's gestures and HUD.
  if (P.form > 0.5 && !boxAsked) {
    boxAsked = true;
    const H = window.__hs; if (H && H.setConfig && !(H.cfg && H.cfg.bindings.some(b => b.mode === 'box'))) H.setConfig('box3d', { save: false });
  }
  const u = trackRegion(ctx, ctx.state, { n: 3, set: P.fingers, trail: P.trail, oneHand: true, curl: false, order: 'depth' });
  return { ...u, ...SLOTS.frame() };
}

const LOOKS = ['Thermal', 'TV Scan', 'Invisible', 'Camera', ...EXTRA];
export default {
  id: 'prism',
  name: 'Prism',
  ref: { clip: 'DX68QiKuX5Z', t: [1.3, 2.7], crop: [6, 20, 1074, 604] },
  needs: [...new Set(['hands', 'person', ...SLOTS.needs])],
  looks: WEBS,
  params: [
    // Top first: a hand-signal config that steps "the first enum" (box3d: swipe up / down) changes a look, never the form
    { id: 'top', label: 'Top', type: 'enum', options: LOOKS, default: slotIx(2, 0) },
    { id: 'front', label: 'Front', type: 'enum', options: LOOKS, default: slotIx(0, 1) },
    { id: 'body', label: 'Body', type: 'enum', options: LOOKS, default: slotIx(1, 2) },
    { id: 'form', label: 'Form', type: 'enum', options: ['Ribbon', 'Box'], default: 0 },
    { id: 'map', label: 'Mapping', type: 'enum', options: ['Window', 'Stretch'], default: 0 },
    { id: 'edge', label: 'Edge', type: 'float', min: 0, max: 1, default: 0.85 },
    { id: 'fingers', label: 'Fingers', type: 'enum', options: FINGER_SET_NAMES, default: 1, more: true },
    { id: 'trail', label: 'Trail', type: 'float', min: 0, max: 1, default: 0.1, more: true },
    { id: 'solo', label: 'Preview Look', type: 'enum', options: ['Off', ...LOOKS], default: 0, more: true },
  ],
  passes: [
    ...SLOTS.passes,
    ...TV_PASSES,
    ...INV_PASSES,
    { name: 'pz_thh', scale: 0.5, frag: thBlur('uBuf_tv_drv', 'vec2(1.0, 0.0)', '5.0') },
    { name: 'pz_th', scale: 0.5, frag: thBlur('uBuf_pz_thh', 'vec2(0.0, 1.0)', '5.0') },
    { name: 'out', screen: true, frag: HS_DECL + HS_BOX + HS_HUD + PZ_THERMAL + tvGlsl() + invGlsl() + MAIN },
  ],
  async init() {
    await SLOTS.init();
    boxAsked = false;
  },
  frame,
};
