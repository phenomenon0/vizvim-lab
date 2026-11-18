// Living documentation for the harness: 2 passes, depth + hands, a param with `drive`,
// a feedback buffer, blue noise, and both CPU hooks. Not a shippable look.
export default {
  id: '_demo',
  name: 'Harness demo (depth fog + hand trails)',
  // ref: { clip: 'DecGDxGue_s', t: [5.5, 7.4] },   // add a ref to get the side-by-side + shoot.mjs --pair
  needs: ['depth', 'hands'],
  params: [
    // drive: while a hand is visible, pinch of hand 0 is mapped onto [min, max]. Touching the slider
    // (or shoot.mjs --set fog=...) pins the value; click the hand badge to give control back.
    { id: 'fog', label: 'Fog', type: 'float', min: 0, max: 1, default: 0.7, drive: 'pinch0' },
    { id: 'trail', label: 'Trail', type: 'float', min: 0.5, max: 0.99, default: 0.92 },
    { id: 'tint', label: 'Tint', type: 'color', default: '#19e0c8' },
    { id: 'mode', label: 'Mode', type: 'enum', options: ['Fog', 'Depth only'], default: 0 },
    { id: 'grain', label: 'Grain', type: 'bool', default: true },
    { id: 'near', label: 'Near plane', type: 'float', min: 0, max: 1, default: 0.55, more: true },
  ],
  passes: [
    // half-res feedback buffer: hand silhouette leaves a decaying trail. uSelf = this buffer last frame.
    { name: 'trail', scale: 0.5, feedback: true, frag: /* glsl */`
void main() {
  float prev = texture(uSelf, vUv).r * u_trail;
  float hand = texture(uHandMask, vUv).r;
  fragColor = vec4(max(prev, hand), hand, 0.0, 1.0);
}` },
    { name: 'out', screen: true, frag: /* glsl */`
uniform vec2 uPulse;     // from frame()
void main() {
  vec3 cam = texture(uCam, vUv).rgb;
  float d = texture(uDepth, vUv).r;                      // 0 far .. 1 near
  if (uDepthReady < 0.5) d = 1.0;
  float far = 1.0 - smoothstep(u_near - 0.35, u_near, d);
  vec3 col = mix(cam, u_tint * (0.25 + 0.5 * dot(cam, vec3(0.333))), far * u_fog);
  if (u_mode > 0.5) col = vec3(d);
  float t = texture(uBuf_trail, vUv).r;
  col += u_tint * t * 0.8;
  for (int h = 0; h < 2; h++) {                           // ring at each palm centre, radius follows pinch
    if (h >= uHandCount) break;
    vec2 q = (vUv - uHandCenter[h]) * vec2(uRes.x / uRes.y, 1.0);
    float r = 0.03 + 0.08 * uPinch[h] + 0.004 * uPulse.x;
    col = mix(col, vec3(1.0), smoothstep(0.004, 0.0015, abs(length(q) - r)));
  }
  if (u_grain > 0.5) col += (texture(uNoise, gl_FragCoord.xy / 256.0).r - 0.5) * 0.06;
  fragColor = vec4(col, 1.0);
}` },
  ],
  init(ctx) { ctx.state.born = ctx.time; },
  frame(ctx) { return { uPulse: [Math.sin(ctx.time * 6.0), ctx.frame] }; },
};
