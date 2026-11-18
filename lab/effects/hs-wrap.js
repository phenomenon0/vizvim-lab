// Hosts any sibling effect under the hand-signal layer, without touching it:  ?fx=hs-wrap&hs=<config>;wrap=<effect id>
// The wrapped module's passes, params, init and frame run unchanged. Only its screen pass gets a tail:
//   look  -> shown everywhere, or only inside the director's frame / the 3D box (uHSMask), camera outside
//   HUD   -> pinch rings, clutch arc, dwell ring, cursor, frame brackets (lab/handsignal/glsl.js)
// Natively this tail is one extra compositing pass after the layer chain; see breakdowns/hand-signal.md.
import { HS_DECL, HS_BOX, HS_HUD, HS_BOX_SHELL } from '../handsignal/glsl.js';

const hs = new URLSearchParams(location.search).get('hs') || '';
const wrap = (hs.split(';').map(s => s.split('=')).find(([k]) => k === 'wrap') || [])[1] || 'passthrough';
let target;
try { target = (await import(`./${wrap}.js?v=${Date.now()}`)).default; }
catch (e) { console.warn(`[hs-wrap] cannot load ${wrap}: ${e.message}`); target = (await import('./passthrough.js')).default; }

const TAIL = /* glsl */`
void main() {
  hs_main();
  vec3 fx = fragColor.rgb, cam = texture(uCam, vUv).rgb, col = fx;
  if (uHSMask > 1.5) {
    float edge, shade; float m = hsBoxMask(vUv, edge, shade);
    col = mix(cam, fx * shade, m);
    col = mix(col, mix(vec3(1.0), HS_ACC, 0.6 * uBoxGrab), edge * (0.75 + 0.25 * uBoxFlash));
  } else if (uHSMask > 0.5) {
    col = mix(fx, mix(cam * 0.82, fx, hsFrameMask(vUv)), uHSFrameRot.y);
  }
  fragColor = vec4(hsHud(col, vUv), 1.0);
}`;
const passes = target.passes.map(p => (p.screen ? { ...p, frag: HS_DECL + p.frag.replace(/void\s+main\s*\(\s*(void)?\s*\)/, 'void hs_main()') + HS_BOX + HS_HUD + HS_BOX_SHELL + TAIL } : p));

export default { ...target, id: 'hs-wrap', wraps: target.id, name: `${target.name} + hand signals`, passes };
