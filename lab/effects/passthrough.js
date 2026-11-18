// Minimal effect: one screen pass. Copy this file to start a new effect.
export default {
  id: 'passthrough',
  name: 'Passthrough',
  needs: [],
  params: [
    { id: 'gain', label: 'Gain', type: 'float', min: 0, max: 2, default: 1 },
  ],
  passes: [
    { name: 'out', screen: true, frag: /* glsl */`
void main() {
  fragColor = vec4(texture(uCam, vUv).rgb * u_gain, 1.0);
}` },
  ],
};
