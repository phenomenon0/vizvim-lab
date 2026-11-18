// hand-signal — GLSL chunks shared by the modules that draw the layer (hand-signal-debug, box3d, hs-wrap).
// Plain fragment-shader code over uniforms, nothing here needs the CPU per pixel. Spec: breakdowns/hand-signal.md.
//
// All uniforms below are produced by lab/handsignal.js update() and merged into every pass by the harness.
//   2D things are in vUv (x right, y up, 0..1). Distances are in "hu" (fraction of image height).
//   The box is in camera space: x right, y up, z forward, metres, pinhole at the origin,
//   focal length uBoxFocal image heights:   ray(uv) = normalize(((u - 0.5) * aspect / f, (v - 0.5) / f, 1)).

export const HS_DECL = /* glsl */`
#ifndef HS_DECL_ONCE
#define HS_DECL_ONCE
uniform float uHSHud;          // 1 = draw the HUD
uniform vec4 uHSHand[2];       // per HUD slot (0 = user's left, 1 = right): pinch point x, y, gap 0 touching..1 open, presence
uniform vec4 uHSClutch[2];     // engaged (0 idle, 0.5 armed, 1 holding), value 0..1 (-1 = no value), kind (0 slide, 1 knob, 2 box), latch flash
uniform vec4 uHSDwell;         // x, y, progress 0..1, alpha
uniform vec4 uHSFrame;         // director's frame: centre x, y, width (fraction of image width), height (fraction of image height)
uniform vec3 uHSFrameRot;      // angle rad (ccw), alpha, 1 = the look is masked to the frame
uniform vec4 uHSCursor;        // pointing cursor x, y, alpha, engaged
uniform vec4 uHSCursorFrom;    // fingertip x, y, alpha, -
uniform vec4 uHSFlash;         // event flash: direction x, y (0,0 = none), alpha, kind (0 swipe, 1 freeze / reset border)
uniform float uHSSkel;         // ghost skeleton alpha (hs option skel=1; for replayed tracks whose hands are not in the picture)
uniform vec3 uHSLm[42];        // filtered landmarks x, y (vUv), presence; 0..20 user's left, 21..41 right
uniform float uHSMask;         // 0 none, 1 frame, 2 box: where a wrapped look is allowed to show
uniform vec3 uBoxCenter;       // metres, camera space
uniform vec3 uBoxHalf;         // half extents along the box's own axes, metres
uniform mat3 uBoxRot;          // columns = box axes in camera space
uniform float uBoxActive;      // 0..1 (spawn / dismiss fade)
uniform float uBoxFocal;       // image heights
uniform float uBoxGrab;        // 0 floating, 0.5 one hand, 1 two hands
uniform float uBoxFlash;       // 1 at spawn, decays
uniform vec2 uBoxDepthFit;     // 1 / z(metres) = x * uDepth + y   (x = 0: no fit)
#endif
`;

export const HS_BOX = /* glsl */`
#ifndef HS_BOX_ONCE
#define HS_BOX_ONCE
vec3 hsRay(vec2 uv) { return normalize(vec3((uv.x - 0.5) * uRes.x / uRes.y / uBoxFocal, (uv.y - 0.5) / uBoxFocal, 1.0)); }
vec2 hsProject(vec3 p) { return vec2(0.5 + p.x / p.z * uBoxFocal * uRes.y / uRes.x, 0.5 + p.y / p.z * uBoxFocal); }
// ray (from the origin) against the oriented box. tN / tF = entry / exit distance, pN / pF = those points in BOX space,
// nN / nF = outward face normals in BOX space. Returns false on a miss or when the box is behind the lens.
bool hsBox(vec3 rd, out float tN, out float tF, out vec3 pN, out vec3 pF, out vec3 nN, out vec3 nF) {
  mat3 Rt = transpose(uBoxRot);
  vec3 ro = Rt * (-uBoxCenter), d = Rt * rd;
  d += (1.0 - abs(sign(d))) * 1e-6;
  vec3 t0 = (-uBoxHalf - ro) / d, t1 = (uBoxHalf - ro) / d, a = min(t0, t1), b = max(t0, t1);
  tN = max(max(a.x, a.y), a.z); tF = min(min(b.x, b.y), b.z);
  nN = -sign(d) * step(vec3(tN), a); nF = sign(d) * step(b, vec3(tF));
  pN = ro + d * tN; pF = ro + d * tF;
  return tF > max(tN, 0.0);
}
// distance (metres) from a point on a face to the nearest edge of that face
float hsEdge(vec3 p, vec3 n) { vec3 q = uBoxHalf - abs(p) + abs(n) * 1e3; return min(q.x, min(q.y, q.z)); }
// constant-width line: w = half width in pixels, z = depth of the point (metres)
float hsLine(float e, float z, float w) { float px = z / (uBoxFocal * uRes.y); return 1.0 - smoothstep((w - 0.75) * px, (w + 0.75) * px, e); }
float hsSceneZ(vec2 uv) { return uBoxDepthFit.x > 0.0 ? 1.0 / max(uBoxDepthFit.x * texture(uDepth, uv).r + uBoxDepthFit.y, 0.05) : 1e4; }
#endif
`;

export const HS_HUD = /* glsl */`
#ifndef HS_HUD_ONCE
#define HS_HUD_ONCE
const vec3 HS_ACC = vec3(0.098, 0.878, 0.784);
float hsAA(float d, float w) { float px = 1.0 / uRes.y; return 1.0 - smoothstep(w - 0.75 * px, w + 0.75 * px, d); }
vec2 hsHu(vec2 uv, vec2 c) { return (uv - c) * vec2(uRes.x / uRes.y, 1.0); }
// arc of radius r, clockwise from the angle a0 over the sweep sw (radians, 0 = up), half width w
float hsArc(vec2 p, float r, float a0, float sw, float w) {
  float ang = mod(atan(p.x, p.y) - a0 + 6.2831853, 6.2831853), e = 1.5 / (uRes.y * max(r, 1e-3));
  return hsAA(abs(length(p) - r), w) * smoothstep(0.0, e, ang) * (1.0 - smoothstep(sw - e, sw + e, ang)) * step(1e-4, sw);
}
void hsOver(inout vec3 col, vec3 c, float a) { col = mix(col, c, clamp(a, 0.0, 1.0)); }
// a stroke with a soft dark seat under it so it reads on any picture
void hsStroke(inout vec3 col, float d, float w, vec3 c, float a) {
  float px = 1.0 / uRes.y;
  col *= 1.0 - 0.38 * a * (1.0 - smoothstep(w, w + 3.0 * px, d));
  hsOver(col, c, a * hsAA(d, w));
}
float hsSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0)); }

vec3 hsHud(vec3 col, vec2 uv) {
  if (uHSHud < 0.5) return col;
  float px = 1.0 / uRes.y, lw = 0.9 * px;
  // ---- ghost skeleton (off unless asked for)
  if (uHSSkel > 0.003) {
    vec2 A = vec2(uRes.x / uRes.y, 1.0), p = uv * A;
    for (int h = 0; h < 2; h++) {
      int b = h * 21; float pr = uHSLm[b].z * uHSSkel; if (pr < 0.01) continue;
      float d = 1e3;
      for (int f = 0; f < 5; f++) {
        int k = b + 1 + f * 4;
        if (f == 0 || f == 1 || f == 4) d = min(d, hsSeg(p, uHSLm[b].xy * A, uHSLm[k].xy * A));
        for (int j = 0; j < 3; j++) d = min(d, hsSeg(p, uHSLm[k + j].xy * A, uHSLm[k + j + 1].xy * A));
        if (f > 0 && f < 4) d = min(d, hsSeg(p, uHSLm[k].xy * A, uHSLm[k + 4].xy * A));
      }
      hsStroke(col, d, lw, vec3(1.0), 0.6 * pr);
      for (int i = 0; i < 21; i++) hsOver(col, vec3(1.0), 0.9 * pr * hsAA(length(p - uHSLm[b + i].xy * A), 1.9 * px));
    }
  }
  // ---- director's frame: hairline rectangle + heavier corner brackets
  if (uHSFrameRot.y > 0.003) {
    vec2 q = hsHu(uv, uHSFrame.xy); float cs = cos(uHSFrameRot.x), sn = sin(uHSFrameRot.x); q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
    vec2 hb = 0.5 * vec2(uHSFrame.z * uRes.x / uRes.y, uHSFrame.w), dd = abs(q) - hb;
    float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
    float a = uHSFrameRot.y;
    hsStroke(col, abs(sd), lw, vec3(1.0), 0.55 * a);
    float L = min(0.03, 0.45 * min(hb.x, hb.y)); vec2 cq = hb - abs(q);
    float corner = step(cq.x, L) * step(cq.y, L);
    hsStroke(col, abs(sd), 1.6 * px, HS_ACC, a * corner);
  }
  // ---- per-hand pinch ring: radius follows the finger gap; closes and turns accent when the pinch latches;
  //      while a clutch holds a value, a 270 deg arc around it reads the value like a knob
  for (int i = 0; i < 2; i++) {
    vec4 h = uHSHand[i], c = uHSClutch[i]; if (h.w < 0.01) continue;
    vec2 p = hsHu(uv, h.xy); float r = mix(0.014, 0.045, clamp(h.z, 0.0, 1.0)), on = clamp(c.x, 0.0, 1.0);
    vec3 rc = mix(vec3(1.0), HS_ACC, smoothstep(0.2, 0.6, on));
    hsStroke(col, abs(length(p) - r), mix(lw, 1.5 * px, on), rc, h.w * mix(0.5, 1.0, on));
    hsOver(col, HS_ACC, h.w * step(0.75, on) * hsAA(length(p), 2.2 * px));
    // latch flash: one expanding ring
    if (c.w > 0.01) hsOver(col, HS_ACC, 0.7 * c.w * h.w * hsAA(abs(length(p) - (r + 0.05 * (1.0 - c.w))), lw));
    if (c.y >= 0.0 && on > 0.25) {
      float R = 0.062, a0 = -2.3561945, full = 4.712389;
      hsOver(col, vec3(1.0), 0.22 * h.w * on * hsArc(p, R, a0, full, lw));
      hsStroke(col, 1e3 * (1.0 - hsArc(p, R, a0, full * clamp(c.y, 0.0, 1.0), 1.4 * px)), 0.5, HS_ACC, h.w * on);
      float ang = a0 + full * clamp(c.y, 0.0, 1.0); vec2 kd = vec2(sin(ang), cos(ang));
      hsStroke(col, hsSeg(p, kd * (R - 0.008), kd * (R + 0.008)), 1.2 * px, vec3(1.0), h.w * on);
      if (c.z > 0.5 && c.z < 1.5) hsStroke(col, hsSeg(p, vec2(0.0), kd * (r - 0.004)), lw, HS_ACC, 0.8 * h.w * on);   // knob: pointer from the centre
    }
    if (c.z > 1.5 && on > 0.25) {     // box grab: four small ticks
      vec2 ap = abs(p); float tk = min(hsSeg(ap, vec2(r + 0.008, 0.0), vec2(r + 0.02, 0.0)), hsSeg(ap, vec2(0.0, r + 0.008), vec2(0.0, r + 0.02)));
      hsStroke(col, tk, lw, HS_ACC, h.w * on);
    }
  }
  // ---- dwell ring: fills clockwise from the top; on completion it widens and fades
  if (uHSDwell.w > 0.003) {
    vec2 p = hsHu(uv, uHSDwell.xy); float pr = clamp(uHSDwell.z, 0.0, 1.0), done = step(0.999, pr);
    float R = 0.085 + 0.03 * done * (1.0 - uHSDwell.w);
    hsOver(col, vec3(1.0), 0.2 * uHSDwell.w * hsAA(abs(length(p) - R), lw));
    hsStroke(col, 1e3 * (1.0 - hsArc(p, R, 0.0, 6.2831853 * pr, 1.5 * px)), 0.5, HS_ACC, uHSDwell.w);
  }
  // ---- pointing cursor: hairline from the fingertip, open reticle at the cursor
  if (uHSCursor.z > 0.003) {
    vec2 p = hsHu(uv, uHSCursor.xy); float a = uHSCursor.z;
    if (uHSCursorFrom.z > 0.003) { vec2 f = hsHu(uHSCursorFrom.xy, uHSCursor.xy); float along = length(p - f) / max(length(f), 1e-4);
      hsOver(col, vec3(1.0), 0.3 * a * uHSCursorFrom.z * hsAA(hsSeg(p, f, normalize(f + 1e-6) * 0.022), lw) * smoothstep(0.0, 0.35, along)); }
    hsStroke(col, abs(length(p) - 0.016), 1.2 * px, HS_ACC, a);
    vec2 ap = abs(p); float tk = min(hsSeg(ap, vec2(0.022, 0.0), vec2(0.032, 0.0)), hsSeg(ap, vec2(0.0, 0.022), vec2(0.0, 0.032)));
    hsStroke(col, tk, lw, vec3(1.0), 0.8 * a);
    hsOver(col, vec3(1.0), a * hsAA(length(p), 1.6 * px));
  }
  // ---- event flash: a swipe lights the edge it went toward; freeze / reset draw a hairline border
  if (uHSFlash.z > 0.003) {
    float a = uHSFlash.z * uHSFlash.z;
    if (uHSFlash.w < 0.5) { float e = dot(uv - 0.5, uHSFlash.xy) + 0.5; col += HS_ACC * 0.5 * a * smoothstep(0.86, 1.0, e) * smoothstep(0.86, 1.0, e); }
    else { vec2 b = min(uv, 1.0 - uv) * vec2(uRes.x / uRes.y, 1.0); float d = min(b.x, b.y); hsOver(col, HS_ACC, a * hsAA(abs(d - 0.012), 1.2 * px)); }
  }
  return col;
}
// where a wrapped look shows: everywhere, inside the director's frame, or inside the box silhouette
float hsFrameMask(vec2 uv) {
  vec2 q = hsHu(uv, uHSFrame.xy); float cs = cos(uHSFrameRot.x), sn = sin(uHSFrameRot.x); q = vec2(q.x * cs + q.y * sn, -q.x * sn + q.y * cs);
  vec2 dd = abs(q) - 0.5 * vec2(uHSFrame.z * uRes.x / uRes.y, uHSFrame.w);
  float sd = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
  return 1.0 - smoothstep(-1.0 / uRes.y, 1.0 / uRes.y, sd);
}
#endif
`;

// minimal glass shell for the box when it masks another look (hs-wrap): silhouette + front and back edges
export const HS_BOX_SHELL = /* glsl */`
// returns the silhouette alpha; edge = line alpha; shade = how the face under this pixel catches the light (about 0.8 .. 1.12)
float hsBoxMask(vec2 uv, out float edge, out float shade) {
  edge = 0.0; shade = 1.0; if (uBoxActive < 0.003) return 0.0;
  float tN, tF; vec3 pN, pF, nN, nF; vec3 rd = hsRay(uv);
  if (!hsBox(rd, tN, tF, pN, pF, nN, nF)) return 0.0;
  float front = tN > 0.0 ? hsLine(hsEdge(pN, nN), tN * rd.z, 1.1) : 0.0, back = hsLine(hsEdge(pF, nF), tF * rd.z, 0.8);
  edge = max(front, 0.35 * back) * uBoxActive;
  vec3 nc = uBoxRot * (tN > 0.0 ? nN : -nF); shade = 0.8 + 0.32 * (dot(nc, normalize(vec3(-0.35, 0.8, -0.5))) * 0.5 + 0.5);
  return uBoxActive;
}
`;
