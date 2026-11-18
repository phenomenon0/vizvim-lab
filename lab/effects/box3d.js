// 3D Box: a glass cuboid held in the air between two hands. A true perspective volume, not a 2D rectangle:
// lab/handsignal/box.js keeps an oriented box in camera space (metres) and this module ray-traces it per pixel.
//   uBoxCenter, uBoxHalf, uBoxRot (columns = box axes), uBoxActive, uBoxFocal  ->  ray-OBB in the fragment shader
//   ray(uv) = normalize(((u - 0.5) * aspect / f, (v - 0.5) / f, 1)),  camera space x right, y up, z forward
// Inside the volume the picture gets a treatment (pixelate / thermal / x-ray / frosted blur); the shell is glass:
// refraction, thickness tint, fresnel sheen, fine lit edges (front crisp, back faint through the glass).
// With depth on, the scene itself decides: things in front of the box cover it (Occlude), or only what actually
// lies between the near and far faces is treated (Volume).
// Hands: config "box3d" (pinch with both hands to pull it out, hold to move / size / turn, let go and it floats,
// one pinch drags it, double pinch puts it away) or "box3d-hold" (lives between two visible hands; for plates).
// Spec: breakdowns/hand-signal.md, section "3D box".
import { HS_DECL, HS_BOX, HS_HUD } from '../handsignal/glsl.js';

export default {
  id: 'box3d',
  name: '3D Box',
  needs: ['hands', 'depth'],
  depthSize: 518,
  params: [
    { id: 'inside', label: 'Inside', type: 'enum', options: ['Pixelate', 'Thermal', 'X-ray', 'Frost'], default: 0 },
    { id: 'amount', label: 'Amount', type: 'float', min: 0, max: 1, default: 0.5 },
    { id: 'glass', label: 'Glass', type: 'float', min: 0, max: 1, default: 0.6 },
    { id: 'refract', label: 'Refraction', type: 'float', min: 0, max: 1, default: 0.4 },
    { id: 'depth', label: 'Depth', type: 'enum', options: ['Off', 'Occlude', 'Volume'], default: 1 },
    { id: 'edge', label: 'Edge light', type: 'float', min: 0, max: 1, default: 0.7, more: true },
  ],
  passes: [
    // quarter-res separable blur of the camera for the frosted treatment (radius follows Amount)
    { name: 'bh', scale: 0.25, frag: /* glsl */`
void main() {
  vec2 s = vec2(mix(0.8, 2.4, u_amount) / uPassRes.x, 0.0); vec3 c = texture(uCam, vUv).rgb * 0.227;
  c += (texture(uCam, vUv + s * 1.385).rgb + texture(uCam, vUv - s * 1.385).rgb) * 0.316;
  c += (texture(uCam, vUv + s * 3.231).rgb + texture(uCam, vUv - s * 3.231).rgb) * 0.0703;
  fragColor = vec4(c, 1.0);
}` },
    { name: 'blur', scale: 0.25, frag: /* glsl */`
void main() {
  vec2 s = vec2(0.0, mix(0.8, 2.4, u_amount) / uPassRes.y); vec3 c = texture(uBuf_bh, vUv).rgb * 0.227;
  c += (texture(uBuf_bh, vUv + s * 1.385).rgb + texture(uBuf_bh, vUv - s * 1.385).rgb) * 0.316;
  c += (texture(uBuf_bh, vUv + s * 3.231).rgb + texture(uBuf_bh, vUv - s * 3.231).rgb) * 0.0703;
  fragColor = vec4(c, 1.0);
}` },
    { name: 'out', screen: true, frag: HS_DECL + HS_BOX + HS_HUD + /* glsl */`
vec3 thermal(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.02, 0.0, 0.12), vec3(0.42, 0.0, 0.62), smoothstep(0.0, 0.28, t));
  c = mix(c, vec3(0.93, 0.13, 0.25), smoothstep(0.22, 0.52, t));
  c = mix(c, vec3(1.0, 0.62, 0.08), smoothstep(0.48, 0.76, t));
  return mix(c, vec3(1.0, 0.98, 0.82), smoothstep(0.74, 1.0, t));
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// the picture as seen through the volume at the box-space point q on the face with normal n
vec3 treat(vec3 q, vec3 n, vec2 off, out float grid) {
  grid = 0.0;
  vec2 uv = hsProject(uBoxRot * q + uBoxCenter) + off;
  if (u_inside < 0.5) {
    // pixel tiles locked to the FACE, in metres: they foreshorten and turn with the box
    float cell = mix(0.003, 0.024, u_amount * u_amount) * sqrt(max(uBoxHalf.x, max(uBoxHalf.y, uBoxHalf.z)) / 0.12);
    vec3 t = 1.0 - abs(n), g = q / cell, qc = (floor(g) + 0.5) * cell;
    vec3 qq = mix(q, qc, t);
    vec3 fr = abs(fract(g) - 0.5) * t; float m = max(fr.x, max(fr.y, fr.z));
    grid = smoothstep(0.44, 0.5, m);
    return texture(uCam, hsProject(uBoxRot * qq + uBoxCenter) + off).rgb;
  }
  vec3 c = texture(uCam, uv).rgb;
  if (u_inside < 1.5) { float l = luma(c); return mix(c, thermal(pow(l, mix(1.3, 0.75, u_amount)) * 1.08), mix(0.6, 1.0, u_amount)); }
  if (u_inside < 2.5) {
    vec2 e = 1.5 / uRes; float l = luma(c);
    float gx = luma(texture(uCam, uv + vec2(e.x, 0.0)).rgb) - luma(texture(uCam, uv - vec2(e.x, 0.0)).rgb);
    float gy = luma(texture(uCam, uv + vec2(0.0, e.y)).rgb) - luma(texture(uCam, uv - vec2(0.0, e.y)).rgb);
    float x = clamp((1.0 - l) * mix(0.85, 1.1, u_amount) + length(vec2(gx, gy)) * mix(1.5, 5.0, u_amount), 0.0, 1.0);
    return mix(c, vec3(0.62, 0.86, 1.0) * x * x * 1.25 + vec3(0.0, 0.02, 0.05), mix(0.75, 1.0, u_amount));
  }
  vec3 b = texture(uBuf_blur, uv).rgb;                       // frosted: blurred, lifted and a little milky
  return mix(b, vec3(luma(b)), 0.15) * 1.06 + vec3(0.07, 0.085, 0.09);
}

void main() {
  vec3 cam = texture(uCam, vUv).rgb, col = cam;
  float tN, tF; vec3 pN, pF, nN, nF; vec3 rd = hsRay(vUv);
  if (uBoxActive > 0.003 && hsBox(rd, tN, tF, pN, pF, nN, nF)) {
    bool within = tN <= 0.0;                              // the lens is inside the box
    vec3 q = within ? pF : pN, n = within ? -nF : nN;
    float zN = max(tN, 0.0) * rd.z, zF = tF * rd.z;
    vec3 nc = uBoxRot * n;                                // face normal in camera space
    float big = max(uBoxHalf.x, max(uBoxHalf.y, uBoxHalf.z));
    float thick = clamp((tF - max(tN, 0.0)) / (2.0 * big), 0.0, 1.5);
    float cosi = clamp(dot(nc, -rd), 0.0, 1.0);

    // refraction: the ray bends toward the face normal, more where the glass is thick; plus a slight magnification
    vec2 c2 = hsProject(uBoxCenter);
    vec2 off = (-nc.xy * vec2(uRes.y / uRes.x, 1.0) * 0.035 * (1.0 - cosi) - (vUv - c2) * 0.06) * u_refract * (0.35 + thick);

    float grid; vec3 inner = treat(q, n, off, grid);
    vec3 through = texture(uCam, vUv + off).rgb;          // what plain glass would show

    // depth: scene in front of the near face covers the box; in Volume mode only what lies inside it is treated
    float vis = 1.0, involve = 1.0;
    if (u_depth > 0.5 && uDepthReady > 0.5 && uBoxDepthFit.x > 0.0) {
      float zs = hsSceneZ(vUv), w = 0.1 * zN + 0.01;
      vis = smoothstep(zN - 1.6 * w, zN - 0.6 * w, zs);
      if (u_depth > 1.5) involve = 1.0 - smoothstep(zF + 0.5 * w, zF + 2.0 * w, zs);
    }
    vec3 g = mix(through, inner, involve);
    g *= 1.0 - 0.1 * grid * involve;

    // glass
    vec3 L = normalize(vec3(-0.35, 0.8, -0.5)); float lam = dot(nc, L) * 0.5 + 0.5;
    g = mix(g, g * vec3(0.84, 0.96, 1.0), u_glass * clamp(0.25 + 0.5 * thick, 0.0, 1.0));     // thickness tint
    g *= mix(1.0, 0.8 + 0.32 * lam, u_glass);                                                  // each face catches the light differently
    float fres = pow(1.0 - cosi, 3.0);
    g += vec3(0.72, 0.9, 1.0) * u_glass * (0.55 * fres + 0.05 * lam);
    // a soft sheen band sliding across each face
    vec3 t = 1.0 - abs(n); float band = dot(q * t, vec3(0.7, 0.5, 0.6)) / big;
    g += vec3(0.9, 0.97, 1.0) * u_glass * 0.07 * smoothstep(0.25, 0.0, abs(band - 0.25)) * lam;

    // edges: back ones faint through the glass, front ones crisp with a breath of glow
    vec3 ec = mix(vec3(0.92, 0.98, 1.0), HS_ACC, 0.65 * uBoxGrab);
    float eb = hsLine(hsEdge(pF, nF), zF, 0.8);
    g = mix(g, ec, (within ? 0.9 : 0.3) * u_edge * eb);
    if (!within) {
      float e = hsEdge(pN, nN), pxm = zN / (uBoxFocal * uRes.y);
      g += ec * u_edge * (0.16 + 0.3 * uBoxFlash) * exp(-e / (7.0 * pxm));
      g = mix(g, ec * (0.82 + 0.25 * lam), clamp(u_edge * 1.35, 0.0, 1.0) * hsLine(e, zN, 1.15));
    }
    g += ec * 0.25 * uBoxFlash * uBoxFlash;
    col = mix(cam, g, uBoxActive * vis);
  }
  fragColor = vec4(hsHud(col, vUv), 1.0);
}` },
  ],
  init() {
    // the look needs a box config; if none is live, take the pinch one
    const H = window.__hs; if (H && H.setConfig && !(H.cfg && H.cfg.bindings.some(b => b.mode === 'box'))) H.setConfig('box3d', { save: false });
  },
};
