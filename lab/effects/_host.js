// QA host (lab/qa/chain.mjs, HARNESS-NOTES "Hosting a look"): shows the looks named in ?host=a,b,c side by side,
// each hosted through the harness's `hosts` field. Not a look; reindex.mjs skips it (helper: true).
const ids = (new URLSearchParams(location.search).get('host') || 'halftone').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
const u = (id) => 'uBuf_host_' + id.replace(/\W+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
export default {
  id: '_host', name: 'Host test', helper: true,
  hosts: ids,
  params: [{ id: 'mix', label: 'Mix', type: 'float', min: 0, max: 1, default: 1 }],
  passes: [{ name: 'main', screen: true, frag: `
void main(){
  vec3 cam = texture(uCam, vUv).rgb; vec3 c = cam; float n = ${ids.length}.0; int k = int(min(n - 1.0, floor(vUv.x * n)));
  ${ids.map((id, i) => `if (k == ${i}) c = texture(${u(id)}, vUv).rgb;`).join('\n  ')}
  fragColor = vec4(mix(cam, c, u_mix), 1.0);
}` }],
};
