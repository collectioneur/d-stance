import type { ShapeType } from "../store/sceneStore";

/**
 * Source of every SDF primitive, once per target language. The editor's
 * compiled scene shader (src/gpu/sceneCompiler.ts) and the code export
 * (src/utils/generateSdfCode.ts) both emit these exact sources, so what the
 * viewport shows is what the exported code computes.
 *
 * Conventions: y-up local frame (rotated prims documented inline), angle
 * params in degrees. `image` only carries the shared field math; sampling the
 * baked texture differs per target and lives with each emitter.
 */

export const TG_HELPERS: Record<ShapeType, string> = {
  sphere: `const sdSphere = (p: d.v3f, R: number): number => {
  "use gpu";
  return std.length(p) - R;
};`,
  box: `const sdBox = (p: d.v3f, b: d.v3f): number => {
  "use gpu";
  const q = std.abs(p) - b;
  return (
    std.length(std.max(q, d.vec3f(0.0))) +
    std.min(std.max(q.x, std.max(q.y, q.z)), 0.0)
  );
};`,
  torus: `const sdTorus = (p: d.v3f, t: d.v2f): number => {
  "use gpu";
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)) - t.x, p.y);
  return std.length(q) - t.y;
};`,
  cylinder: `const sdCylinder = (p: d.v3f, r: number, h: number): number => {
  "use gpu";
  const d2 = d.vec2f(std.length(d.vec2f(p.x, p.z)) - r, std.abs(p.y) - h);
  return std.min(std.max(d2.x, d2.y), 0.0) + std.length(std.max(d2, d.vec2f(0.0)));
};`,
  capsule: `const sdCapsule = (p: d.v3f, r: number, h: number): number => {
  "use gpu";
  const py = std.clamp(p.y, -h, h);
  return std.length(p - d.vec3f(0.0, py, 0.0)) - r;
};`,
  cone: `const sdCone = (p: d.v3f, r: number, h: number): number => {
  "use gpu";
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), p.y);
  const k1 = d.vec2f(0.0, h);
  const k2 = d.vec2f(-r, 2.0 * h);
  let capR = d.f32(0.0);
  if (p.y < 0.0) { capR = d.f32(r); }
  const ca = d.vec2f(q.x - std.min(q.x, capR), std.abs(p.y) - h);
  const t = std.clamp(std.dot(k1 - q, k2) / std.dot(k2, k2), 0.0, 1.0);
  const cb = q - k1 + k2 * t;
  let s = d.f32(1.0);
  if (cb.x < 0.0) { if (ca.y < 0.0) { s = d.f32(-1.0); } }
  return s * std.sqrt(std.min(std.dot(ca, ca), std.dot(cb, cb)));
};`,
  roundedBox: `const sdRoundedBox = (p: d.v3f, b: d.v3f, r: number): number => {
  "use gpu";
  const q = std.abs(p) - b;
  return std.length(std.max(q, d.vec3f(0.0))) + std.min(std.max(q.x, std.max(q.y, q.z)), 0.0) - r;
};`,
  boxFrame: `const sdBoxFrame = (pIn: d.v3f, b: d.v3f, e: number): number => {
  "use gpu";
  const p = std.abs(pIn) - b;
  const q = std.abs(p + d.vec3f(e)) - d.vec3f(e);
  const dA = std.length(std.max(d.vec3f(p.x, q.y, q.z), d.vec3f(0.0))) + std.min(std.max(p.x, std.max(q.y, q.z)), 0.0);
  const dB = std.length(std.max(d.vec3f(q.x, p.y, q.z), d.vec3f(0.0))) + std.min(std.max(q.x, std.max(p.y, q.z)), 0.0);
  const dC = std.length(std.max(d.vec3f(q.x, q.y, p.z), d.vec3f(0.0))) + std.min(std.max(q.x, std.max(q.y, p.z)), 0.0);
  return std.min(dA, std.min(dB, dC));
};`,
  cappedTorus: `const sdCappedTorus = (pIn: d.v3f, ra: number, rb: number, angleDeg: number): number => {
  "use gpu";
  const an = angleDeg * 0.017453292519943295;
  const sc = d.vec2f(std.sin(an), std.cos(an));
  const p = d.vec3f(std.abs(pIn.x), pIn.z, pIn.y);
  let k = std.length(d.vec2f(p.x, p.y));
  if (sc.y * p.x > sc.x * p.y) { k = std.dot(d.vec2f(p.x, p.y), sc); }
  return std.sqrt(std.dot(p, p) + ra * ra - 2.0 * ra * k) - rb;
};`,
  link: `const sdLink = (p: d.v3f, le: number, r1: number, r2: number): number => {
  "use gpu";
  const q = d.vec3f(p.x, std.max(std.abs(p.y) - le, 0.0), p.z);
  return std.length(d.vec2f(std.length(d.vec2f(q.x, q.y)) - r1, q.z)) - r2;
};`,
  hexPrism: `const sdHexPrism = (pIn: d.v3f, r: number, h: number): number => {
  "use gpu";
  const k = d.vec3f(-0.8660254, 0.5, 0.57735);
  const q0 = std.abs(d.vec3f(pIn.x, pIn.z, pIn.y));
  const kd = 2.0 * std.min(std.dot(d.vec2f(k.x, k.y), d.vec2f(q0.x, q0.y)), 0.0);
  const qx = q0.x - kd * k.x;
  const qy = q0.y - kd * k.y;
  const d1 = std.length(d.vec2f(qx - std.clamp(qx, -k.z * r, k.z * r), qy - r)) * std.sign(qy - r);
  const d2 = q0.z - h;
  return std.min(std.max(d1, d2), 0.0) + std.length(std.max(d.vec2f(d1, d2), d.vec2f(0.0)));
};`,
  triPrism: `const sdTriPrism = (pIn: d.v3f, r: number, h: number): number => {
  "use gpu";
  const p = d.vec3f(pIn.x, pIn.z, pIn.y);
  const q = std.abs(p);
  return std.max(q.z - h, std.max(q.x * 0.866025 + p.y * 0.5, -p.y) - r * 0.5);
};`,
  roundedCylinder: `const sdRoundedCylinder = (p: d.v3f, ra: number, rb: number, h: number): number => {
  "use gpu";
  const d2 = d.vec2f(std.length(d.vec2f(p.x, p.z)) - ra + rb, std.abs(p.y) - h);
  return std.min(std.max(d2.x, d2.y), 0.0) + std.length(std.max(d2, d.vec2f(0.0))) - rb;
};`,
  roundCone: `const sdRoundCone = (p: d.v3f, r1: number, r2: number, h: number): number => {
  "use gpu";
  const b = std.clamp((r1 - r2) / std.max(h, 0.0001), -0.999, 0.999);
  const a = std.sqrt(1.0 - b * b);
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), p.y);
  const k = std.dot(q, d.vec2f(-b, a));
  let result = std.dot(q, d.vec2f(a, b)) - r1;
  if (k < 0.0) { result = std.length(q) - r1; }
  else if (k > a * h) { result = std.length(q - d.vec2f(0.0, h)) - r2; }
  return result;
};`,
  solidAngle: `const sdSolidAngle = (p: d.v3f, angleDeg: number, ra: number): number => {
  "use gpu";
  const an = angleDeg * 0.017453292519943295;
  const sc = d.vec2f(std.sin(an), std.cos(an));
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), p.y);
  const l = std.length(q) - ra;
  const m = std.length(q - sc * std.clamp(std.dot(q, sc), 0.0, ra));
  return std.max(l, m * std.sign(sc.y * q.x - sc.x * q.y));
};`,
  cutSphere: `const sdCutSphere = (p: d.v3f, r: number, hIn: number): number => {
  "use gpu";
  const h = std.clamp(hIn, -r * 0.999, r * 0.999);
  const w = std.sqrt(r * r - h * h);
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), p.y);
  const s = std.max((h - r) * q.x * q.x + w * w * (h + r - 2.0 * q.y), h * q.x - w * q.y);
  let result = std.length(q - d.vec2f(w, h));
  if (s < 0.0) { result = std.length(q) - r; }
  else if (q.x < w) { result = h - q.y; }
  return result;
};`,
  cutHollowSphere: `const sdCutHollowSphere = (p: d.v3f, r: number, hIn: number, t: number): number => {
  "use gpu";
  const h = std.clamp(hIn, -r * 0.999, r * 0.999);
  const w = std.sqrt(r * r - h * h);
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), p.y);
  let result = std.abs(std.length(q) - r);
  if (h * q.x < w * q.y) { result = std.length(q - d.vec2f(w, h)); }
  return result - t;
};`,
  deathStar: `const sdDeathStar = (p: d.v3f, ra: number, rb: number, dOff: number): number => {
  "use gpu";
  const dd = std.max(dOff, 0.0001);
  const a = (ra * ra - rb * rb + dd * dd) / (2.0 * dd);
  const b = std.sqrt(std.max(ra * ra - a * a, 0.0));
  const q = d.vec2f(p.y, std.length(d.vec2f(p.x, p.z)));
  let result = std.max(std.length(q) - ra, -(std.length(q - d.vec2f(dd, 0.0)) - rb));
  if (q.x * b - q.y * a > dd * std.max(b - q.y, 0.0)) { result = std.length(q - d.vec2f(a, b)); }
  return result;
};`,
  rhombus: `const ndot2 = (a: d.v2f, b: d.v2f): number => {
  "use gpu";
  return a.x * b.x - a.y * b.y;
};

const sdRhombus = (p: d.v3f, la: number, lb: number, h: number, ra: number): number => {
  "use gpu";
  const q = std.abs(p);
  const b = d.vec2f(la, lb);
  const f = std.clamp(ndot2(b, b - d.vec2f(2.0 * q.x, 2.0 * q.z)) / std.dot(b, b), -1.0, 1.0);
  const qx = std.length(d.vec2f(q.x, q.z) - b * d.vec2f(1.0 - f, 1.0 + f) * 0.5) * std.sign(q.x * b.y + q.z * b.x - b.x * b.y) - ra;
  const qy = q.y - h;
  return std.min(std.max(qx, qy), 0.0) + std.length(std.max(d.vec2f(qx, qy), d.vec2f(0.0)));
};`,
  octahedron: `const sdOctahedron = (pIn: d.v3f, s: number): number => {
  "use gpu";
  const p = std.abs(pIn);
  const m = p.x + p.y + p.z - s;
  let result = m * 0.57735027;
  let q = d.vec3f(0.0);
  let onEdge = d.f32(0.0);
  if (3.0 * p.x < m) { q = d.vec3f(p.x, p.y, p.z); onEdge = d.f32(1.0); }
  else if (3.0 * p.y < m) { q = d.vec3f(p.y, p.z, p.x); onEdge = d.f32(1.0); }
  else if (3.0 * p.z < m) { q = d.vec3f(p.z, p.x, p.y); onEdge = d.f32(1.0); }
  if (onEdge > 0.5) {
    const k = std.clamp(0.5 * (q.z - q.y + s), 0.0, s);
    result = std.length(d.vec3f(q.x, q.y - s + k, q.z - k));
  }
  return result;
};`,
  pyramid: `const sdPyramid = (pIn: d.v3f, base: number, height: number): number => {
  "use gpu";
  const invB = 1.0 / std.max(base, 0.0001);
  const p0 = d.vec3f(pIn.x * invB, pIn.y * invB, pIn.z * invB);
  const h = height * invB;
  const m2 = h * h + 0.25;
  let px = std.abs(p0.x);
  let pz = std.abs(p0.z);
  if (pz > px) { const tmp = px; px = pz; pz = tmp; }
  px = px - 0.5;
  pz = pz - 0.5;
  const q = d.vec3f(pz, h * p0.y - 0.5 * px, h * px + 0.5 * p0.y);
  if (q.z < 0.0 && p0.y > 0.0) {
    return -std.min(-q.z / std.sqrt(m2), p0.y) * base;
  }
  let dSlant = d.f32(1e10);
  if (q.z > 0.0) {
    const s = std.max(-q.x, 0.0);
    const t = std.clamp((q.y - 0.5 * pz) / (m2 + 0.25), 0.0, 1.0);
    const a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
    const b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
    let d2 = std.min(a, b);
    if (std.min(q.y, -q.x * m2 - q.y * 0.5) > 0.0) { d2 = d.f32(0.0); }
    dSlant = std.sqrt((d2 + q.z * q.z) / m2);
  }
  let dBase = d.f32(1e10);
  if (p0.y < 0.0) {
    dBase = std.length(d.vec3f(std.max(px, 0.0), p0.y, std.max(pz, 0.0)));
  }
  return std.min(dSlant, dBase) * base;
};`,
  vesica: `const sdVesica = (p: d.v3f, r: number, dIn: number): number => {
  "use gpu";
  const dd = std.clamp(dIn, 0.0001, r * 0.999);
  const b = std.sqrt(r * r - dd * dd);
  const q = d.vec2f(std.length(d.vec2f(p.x, p.z)), std.abs(p.y));
  let result = std.length(q - d.vec2f(-dd, 0.0)) - r;
  if ((q.y - b) * dd > q.x * b) { result = std.length(q - d.vec2f(0.0, b)); }
  return result;
};`,
  image: `// t = normalized distance from the texture (d_px / RES); outside the square
// √(dBox² + dEdge²) is a tight lower bound (content lies inside the square).
// rnd rounds every edge: erode the 2D field and half-thickness by rnd, inflate back after extrusion.
const sdImageField = (p: d.v3f, t: number, s: number, h: number, bold: number, rnd: number, invert: number): number => {
  "use gpu";
  const dTex = t * (2.0 * s);
  const b = std.abs(d.vec2f(p.x, p.y)) - d.vec2f(s);
  const dBox = std.length(std.max(b, d.vec2f(0.0))) + std.min(std.max(b.x, b.y), 0.0);
  let d2 = dTex - bold;
  if (invert > 0.5) {
    d2 = std.max(-d2, dBox);
  } else if (dBox > 0.0) {
    const dEdge = std.max(dTex, 0.0);
    d2 = std.sqrt(dBox * dBox + dEdge * dEdge) - bold;
  }
  const r = std.min(rnd, h);
  const w = d.vec2f(d2 + r, std.abs(p.z) - (h - r));
  return std.min(std.max(w.x, w.y), 0.0) + std.length(std.max(w, d.vec2f(0.0))) - r;
};`,
};

export const WGSL_HELPERS: Record<ShapeType, string> = {
  sphere: `fn sdSphere(p: vec3f, R: f32) -> f32 {
  return length(p) - R;
}`,
  box: `fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}`,
  torus: `fn sdTorus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}`,
  cylinder: `fn sdCylinder(p: vec3f, r: f32, h: f32) -> f32 {
  let d2 = vec2f(length(p.xz) - r, abs(p.y) - h);
  return min(max(d2.x, d2.y), 0.0) + length(max(d2, vec2f(0.0)));
}`,
  capsule: `fn sdCapsule(p: vec3f, r: f32, h: f32) -> f32 {
  let py = clamp(p.y, -h, h);
  return length(p - vec3f(0.0, py, 0.0)) - r;
}`,
  cone: `fn sdCone(p: vec3f, r: f32, h: f32) -> f32 {
  let q = vec2f(length(p.xz), p.y);
  let k1 = vec2f(0.0, h);
  let k2 = vec2f(-r, 2.0 * h);
  var capR = 0.0;
  if (p.y < 0.0) { capR = r; }
  let ca = vec2f(q.x - min(q.x, capR), abs(p.y) - h);
  let t = clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  let cb = q - k1 + k2 * t;
  var s = 1.0;
  if (cb.x < 0.0 && ca.y < 0.0) { s = -1.0; }
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}`,
  roundedBox: `fn sdRoundedBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}`,
  boxFrame: `fn sdBoxFrame(pIn: vec3f, b: vec3f, e: f32) -> f32 {
  let p = abs(pIn) - b;
  let q = abs(p + vec3f(e)) - vec3f(e);
  let dA = length(max(vec3f(p.x, q.y, q.z), vec3f(0.0))) + min(max(p.x, max(q.y, q.z)), 0.0);
  let dB = length(max(vec3f(q.x, p.y, q.z), vec3f(0.0))) + min(max(q.x, max(p.y, q.z)), 0.0);
  let dC = length(max(vec3f(q.x, q.y, p.z), vec3f(0.0))) + min(max(q.x, max(q.y, p.z)), 0.0);
  return min(dA, min(dB, dC));
}`,
  cappedTorus: `fn sdCappedTorus(pIn: vec3f, ra: f32, rb: f32, angleDeg: f32) -> f32 {
  let an = angleDeg * 0.017453292519943295;
  let sc = vec2f(sin(an), cos(an));
  let p = vec3f(abs(pIn.x), pIn.z, pIn.y);
  var k = length(p.xy);
  if (sc.y * p.x > sc.x * p.y) { k = dot(p.xy, sc); }
  return sqrt(dot(p, p) + ra * ra - 2.0 * ra * k) - rb;
}`,
  link: `fn sdLink(p: vec3f, le: f32, r1: f32, r2: f32) -> f32 {
  let q = vec3f(p.x, max(abs(p.y) - le, 0.0), p.z);
  return length(vec2f(length(q.xy) - r1, q.z)) - r2;
}`,
  hexPrism: `fn sdHexPrism(pIn: vec3f, r: f32, h: f32) -> f32 {
  let k = vec3f(-0.8660254, 0.5, 0.57735);
  let q0 = abs(vec3f(pIn.x, pIn.z, pIn.y));
  let kd = 2.0 * min(dot(k.xy, q0.xy), 0.0);
  let qx = q0.x - kd * k.x;
  let qy = q0.y - kd * k.y;
  let d1 = length(vec2f(qx - clamp(qx, -k.z * r, k.z * r), qy - r)) * sign(qy - r);
  let d2 = q0.z - h;
  return min(max(d1, d2), 0.0) + length(max(vec2f(d1, d2), vec2f(0.0)));
}`,
  triPrism: `fn sdTriPrism(pIn: vec3f, r: f32, h: f32) -> f32 {
  let p = vec3f(pIn.x, pIn.z, pIn.y);
  let q = abs(p);
  return max(q.z - h, max(q.x * 0.866025 + p.y * 0.5, -p.y) - r * 0.5);
}`,
  roundedCylinder: `fn sdRoundedCylinder(p: vec3f, ra: f32, rb: f32, h: f32) -> f32 {
  let d2 = vec2f(length(p.xz) - ra + rb, abs(p.y) - h);
  return min(max(d2.x, d2.y), 0.0) + length(max(d2, vec2f(0.0))) - rb;
}`,
  roundCone: `fn sdRoundCone(p: vec3f, r1: f32, r2: f32, h: f32) -> f32 {
  let b = clamp((r1 - r2) / max(h, 0.0001), -0.999, 0.999);
  let a = sqrt(1.0 - b * b);
  let q = vec2f(length(p.xz), p.y);
  let k = dot(q, vec2f(-b, a));
  if (k < 0.0) { return length(q) - r1; }
  if (k > a * h) { return length(q - vec2f(0.0, h)) - r2; }
  return dot(q, vec2f(a, b)) - r1;
}`,
  solidAngle: `fn sdSolidAngle(p: vec3f, angleDeg: f32, ra: f32) -> f32 {
  let an = angleDeg * 0.017453292519943295;
  let sc = vec2f(sin(an), cos(an));
  let q = vec2f(length(p.xz), p.y);
  let l = length(q) - ra;
  let m = length(q - sc * clamp(dot(q, sc), 0.0, ra));
  return max(l, m * sign(sc.y * q.x - sc.x * q.y));
}`,
  cutSphere: `fn sdCutSphere(p: vec3f, r: f32, hIn: f32) -> f32 {
  let h = clamp(hIn, -r * 0.999, r * 0.999);
  let w = sqrt(r * r - h * h);
  let q = vec2f(length(p.xz), p.y);
  let s = max((h - r) * q.x * q.x + w * w * (h + r - 2.0 * q.y), h * q.x - w * q.y);
  if (s < 0.0) { return length(q) - r; }
  if (q.x < w) { return h - q.y; }
  return length(q - vec2f(w, h));
}`,
  cutHollowSphere: `fn sdCutHollowSphere(p: vec3f, r: f32, hIn: f32, t: f32) -> f32 {
  let h = clamp(hIn, -r * 0.999, r * 0.999);
  let w = sqrt(r * r - h * h);
  let q = vec2f(length(p.xz), p.y);
  if (h * q.x < w * q.y) { return length(q - vec2f(w, h)) - t; }
  return abs(length(q) - r) - t;
}`,
  deathStar: `fn sdDeathStar(p: vec3f, ra: f32, rb: f32, dOff: f32) -> f32 {
  let dd = max(dOff, 0.0001);
  let a = (ra * ra - rb * rb + dd * dd) / (2.0 * dd);
  let b = sqrt(max(ra * ra - a * a, 0.0));
  let q = vec2f(p.y, length(p.xz));
  if (q.x * b - q.y * a > dd * max(b - q.y, 0.0)) { return length(q - vec2f(a, b)); }
  return max(length(q) - ra, -(length(q - vec2f(dd, 0.0)) - rb));
}`,
  rhombus: `fn ndot2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.x - a.y * b.y;
}

fn sdRhombus(p: vec3f, la: f32, lb: f32, h: f32, ra: f32) -> f32 {
  let q = abs(p);
  let b = vec2f(la, lb);
  let f = clamp(ndot2(b, b - 2.0 * q.xz) / dot(b, b), -1.0, 1.0);
  let qx = length(q.xz - 0.5 * b * vec2f(1.0 - f, 1.0 + f)) * sign(q.x * b.y + q.z * b.x - b.x * b.y) - ra;
  let qy = q.y - h;
  return min(max(qx, qy), 0.0) + length(max(vec2f(qx, qy), vec2f(0.0)));
}`,
  octahedron: `fn sdOctahedron(pIn: vec3f, s: f32) -> f32 {
  let p = abs(pIn);
  let m = p.x + p.y + p.z - s;
  var q = vec3f(0.0);
  if (3.0 * p.x < m) { q = p.xyz; }
  else if (3.0 * p.y < m) { q = p.yzx; }
  else if (3.0 * p.z < m) { q = p.zxy; }
  else { return m * 0.57735027; }
  let k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
  return length(vec3f(q.x, q.y - s + k, q.z - k));
}`,
  pyramid: `fn sdPyramid(pIn: vec3f, base: f32, height: f32) -> f32 {
  let invB = 1.0 / max(base, 0.0001);
  let p0 = pIn * invB;
  let h = height * invB;
  let m2 = h * h + 0.25;
  var px = abs(p0.x);
  var pz = abs(p0.z);
  if (pz > px) { let tmp = px; px = pz; pz = tmp; }
  px -= 0.5;
  pz -= 0.5;
  let q = vec3f(pz, h * p0.y - 0.5 * px, h * px + 0.5 * p0.y);
  if (q.z < 0.0 && p0.y > 0.0) {
    return -min(-q.z / sqrt(m2), p0.y) * base;
  }
  var dSlant = 1e10;
  if (q.z > 0.0) {
    let s = max(-q.x, 0.0);
    let t = clamp((q.y - 0.5 * pz) / (m2 + 0.25), 0.0, 1.0);
    let a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
    let b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
    var d2 = min(a, b);
    if (min(q.y, -q.x * m2 - q.y * 0.5) > 0.0) { d2 = 0.0; }
    dSlant = sqrt((d2 + q.z * q.z) / m2);
  }
  var dBase = 1e10;
  if (p0.y < 0.0) {
    dBase = length(vec3f(max(px, 0.0), p0.y, max(pz, 0.0)));
  }
  return min(dSlant, dBase) * base;
}`,
  vesica: `fn sdVesica(p: vec3f, r: f32, dIn: f32) -> f32 {
  let dd = clamp(dIn, 0.0001, r * 0.999);
  let b = sqrt(r * r - dd * dd);
  let q = vec2f(length(p.xz), abs(p.y));
  if ((q.y - b) * dd > q.x * b) { return length(q - vec2f(0.0, b)); }
  return length(q - vec2f(-dd, 0.0)) - r;
}`,
  image: `// t = normalized distance from the texture (d_px / RES); outside the square
// sqrt(dBox² + dEdge²) is a tight lower bound (content lies inside the square).
// rnd rounds every edge: erode the 2D field and half-thickness by rnd, inflate back after extrusion.
fn sdImageField(p: vec3f, t: f32, s: f32, h: f32, bold: f32, rnd: f32, invert: f32) -> f32 {
  let dTex = t * (2.0 * s);
  let b = abs(p.xy) - vec2f(s);
  let dBox = length(max(b, vec2f(0.0))) + min(max(b.x, b.y), 0.0);
  var d2 = dTex - bold;
  if (invert > 0.5) {
    d2 = max(-d2, dBox);
  } else if (dBox > 0.0) {
    let dEdge = max(dTex, 0.0);
    d2 = sqrt(dBox * dBox + dEdge * dEdge) - bold;
  }
  let r = min(rnd, h);
  let w = vec2f(d2 + r, abs(p.z) - (h - r));
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - r;
}`,
};

export const GLSL_HELPERS: Record<ShapeType, string> = {
  sphere: `float sdSphere(vec3 p, float R) {
  return length(p) - R;
}`,
  box: `float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}`,
  torus: `float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}`,
  cylinder: `float sdCylinder(vec3 p, float r, float h) {
  vec2 d2 = vec2(length(p.xz) - r, abs(p.y) - h);
  return min(max(d2.x, d2.y), 0.0) + length(max(d2, vec2(0.0)));
}`,
  capsule: `float sdCapsule(vec3 p, float r, float h) {
  float py = clamp(p.y, -h, h);
  return length(p - vec3(0.0, py, 0.0)) - r;
}`,
  cone: `float sdCone(vec3 p, float r, float h) {
  vec2 q = vec2(length(p.xz), p.y);
  vec2 k1 = vec2(0.0, h);
  vec2 k2 = vec2(-r, 2.0 * h);
  float capR = 0.0;
  if (p.y < 0.0) { capR = r; }
  vec2 ca = vec2(q.x - min(q.x, capR), abs(p.y) - h);
  float t = clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  vec2 cb = q - k1 + k2 * t;
  float s = 1.0;
  if (cb.x < 0.0 && ca.y < 0.0) { s = -1.0; }
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}`,
  roundedBox: `float sdRoundedBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}`,
  boxFrame: `float sdBoxFrame(vec3 pIn, vec3 b, float e) {
  vec3 p = abs(pIn) - b;
  vec3 q = abs(p + vec3(e)) - vec3(e);
  float dA = length(max(vec3(p.x, q.y, q.z), vec3(0.0))) + min(max(p.x, max(q.y, q.z)), 0.0);
  float dB = length(max(vec3(q.x, p.y, q.z), vec3(0.0))) + min(max(q.x, max(p.y, q.z)), 0.0);
  float dC = length(max(vec3(q.x, q.y, p.z), vec3(0.0))) + min(max(q.x, max(q.y, p.z)), 0.0);
  return min(dA, min(dB, dC));
}`,
  cappedTorus: `float sdCappedTorus(vec3 pIn, float ra, float rb, float angleDeg) {
  float an = angleDeg * 0.017453292519943295;
  vec2 sc = vec2(sin(an), cos(an));
  vec3 p = vec3(abs(pIn.x), pIn.z, pIn.y);
  float k = (sc.y * p.x > sc.x * p.y) ? dot(p.xy, sc) : length(p.xy);
  return sqrt(dot(p, p) + ra * ra - 2.0 * ra * k) - rb;
}`,
  link: `float sdLink(vec3 p, float le, float r1, float r2) {
  vec3 q = vec3(p.x, max(abs(p.y) - le, 0.0), p.z);
  return length(vec2(length(q.xy) - r1, q.z)) - r2;
}`,
  hexPrism: `float sdHexPrism(vec3 pIn, float r, float h) {
  const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
  vec3 q0 = abs(vec3(pIn.x, pIn.z, pIn.y));
  float kd = 2.0 * min(dot(k.xy, q0.xy), 0.0);
  float qx = q0.x - kd * k.x;
  float qy = q0.y - kd * k.y;
  float d1 = length(vec2(qx - clamp(qx, -k.z * r, k.z * r), qy - r)) * sign(qy - r);
  float d2 = q0.z - h;
  return min(max(d1, d2), 0.0) + length(max(vec2(d1, d2), vec2(0.0)));
}`,
  triPrism: `float sdTriPrism(vec3 pIn, float r, float h) {
  vec3 p = vec3(pIn.x, pIn.z, pIn.y);
  vec3 q = abs(p);
  return max(q.z - h, max(q.x * 0.866025 + p.y * 0.5, -p.y) - r * 0.5);
}`,
  roundedCylinder: `float sdRoundedCylinder(vec3 p, float ra, float rb, float h) {
  vec2 d2 = vec2(length(p.xz) - ra + rb, abs(p.y) - h);
  return min(max(d2.x, d2.y), 0.0) + length(max(d2, vec2(0.0))) - rb;
}`,
  roundCone: `float sdRoundCone(vec3 p, float r1, float r2, float h) {
  float b = clamp((r1 - r2) / max(h, 0.0001), -0.999, 0.999);
  float a = sqrt(1.0 - b * b);
  vec2 q = vec2(length(p.xz), p.y);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) { return length(q) - r1; }
  if (k > a * h) { return length(q - vec2(0.0, h)) - r2; }
  return dot(q, vec2(a, b)) - r1;
}`,
  solidAngle: `float sdSolidAngle(vec3 p, float angleDeg, float ra) {
  float an = angleDeg * 0.017453292519943295;
  vec2 sc = vec2(sin(an), cos(an));
  vec2 q = vec2(length(p.xz), p.y);
  float l = length(q) - ra;
  float m = length(q - sc * clamp(dot(q, sc), 0.0, ra));
  return max(l, m * sign(sc.y * q.x - sc.x * q.y));
}`,
  cutSphere: `float sdCutSphere(vec3 p, float r, float hIn) {
  float h = clamp(hIn, -r * 0.999, r * 0.999);
  float w = sqrt(r * r - h * h);
  vec2 q = vec2(length(p.xz), p.y);
  float s = max((h - r) * q.x * q.x + w * w * (h + r - 2.0 * q.y), h * q.x - w * q.y);
  if (s < 0.0) { return length(q) - r; }
  if (q.x < w) { return h - q.y; }
  return length(q - vec2(w, h));
}`,
  cutHollowSphere: `float sdCutHollowSphere(vec3 p, float r, float hIn, float t) {
  float h = clamp(hIn, -r * 0.999, r * 0.999);
  float w = sqrt(r * r - h * h);
  vec2 q = vec2(length(p.xz), p.y);
  if (h * q.x < w * q.y) { return length(q - vec2(w, h)) - t; }
  return abs(length(q) - r) - t;
}`,
  deathStar: `float sdDeathStar(vec3 p, float ra, float rb, float dOff) {
  float dd = max(dOff, 0.0001);
  float a = (ra * ra - rb * rb + dd * dd) / (2.0 * dd);
  float b = sqrt(max(ra * ra - a * a, 0.0));
  vec2 q = vec2(p.y, length(p.xz));
  if (q.x * b - q.y * a > dd * max(b - q.y, 0.0)) { return length(q - vec2(a, b)); }
  return max(length(q) - ra, -(length(q - vec2(dd, 0.0)) - rb));
}`,
  rhombus: `float ndot2(vec2 a, vec2 b) {
  return a.x * b.x - a.y * b.y;
}

float sdRhombus(vec3 p, float la, float lb, float h, float ra) {
  vec3 q = abs(p);
  vec2 b = vec2(la, lb);
  float f = clamp(ndot2(b, b - 2.0 * q.xz) / dot(b, b), -1.0, 1.0);
  float qx = length(q.xz - 0.5 * b * vec2(1.0 - f, 1.0 + f)) * sign(q.x * b.y + q.z * b.x - b.x * b.y) - ra;
  float qy = q.y - h;
  return min(max(qx, qy), 0.0) + length(max(vec2(qx, qy), vec2(0.0)));
}`,
  octahedron: `float sdOctahedron(vec3 pIn, float s) {
  vec3 p = abs(pIn);
  float m = p.x + p.y + p.z - s;
  vec3 q;
  if (3.0 * p.x < m) { q = p.xyz; }
  else if (3.0 * p.y < m) { q = p.yzx; }
  else if (3.0 * p.z < m) { q = p.zxy; }
  else { return m * 0.57735027; }
  float k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
  return length(vec3(q.x, q.y - s + k, q.z - k));
}`,
  pyramid: `float sdPyramid(vec3 pIn, float base, float height) {
  float invB = 1.0 / max(base, 0.0001);
  vec3 p0 = pIn * invB;
  float h = height * invB;
  float m2 = h * h + 0.25;
  float px = abs(p0.x);
  float pz = abs(p0.z);
  if (pz > px) { float tmp = px; px = pz; pz = tmp; }
  px -= 0.5;
  pz -= 0.5;
  vec3 q = vec3(pz, h * p0.y - 0.5 * px, h * px + 0.5 * p0.y);
  if (q.z < 0.0 && p0.y > 0.0) {
    return -min(-q.z / sqrt(m2), p0.y) * base;
  }
  float dSlant = 1e10;
  if (q.z > 0.0) {
    float s = max(-q.x, 0.0);
    float t = clamp((q.y - 0.5 * pz) / (m2 + 0.25), 0.0, 1.0);
    float a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
    float b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
    float d2 = min(a, b);
    if (min(q.y, -q.x * m2 - q.y * 0.5) > 0.0) { d2 = 0.0; }
    dSlant = sqrt((d2 + q.z * q.z) / m2);
  }
  float dBase = 1e10;
  if (p0.y < 0.0) {
    dBase = length(vec3(max(px, 0.0), p0.y, max(pz, 0.0)));
  }
  return min(dSlant, dBase) * base;
}`,
  vesica: `float sdVesica(vec3 p, float r, float dIn) {
  float dd = clamp(dIn, 0.0001, r * 0.999);
  float b = sqrt(r * r - dd * dd);
  vec2 q = vec2(length(p.xz), abs(p.y));
  if ((q.y - b) * dd > q.x * b) { return length(q - vec2(0.0, b)); }
  return length(q - vec2(-dd, 0.0)) - r;
}`,
  image: `// t = normalized distance from the texture (d_px / RES); outside the square
// sqrt(dBox² + dEdge²) is a tight lower bound (content lies inside the square).
// rnd rounds every edge: erode the 2D field and half-thickness by rnd, inflate back after extrusion.
float sdImageField(vec3 p, float t, float s, float h, float bold, float rnd, float invert) {
  float dTex = t * (2.0 * s);
  vec2 b = abs(p.xy) - vec2(s);
  float dBox = length(max(b, vec2(0.0))) + min(max(b.x, b.y), 0.0);
  float d2 = dTex - bold;
  if (invert > 0.5) {
    d2 = max(-d2, dBox);
  } else if (dBox > 0.0) {
    float dEdge = max(dTex, 0.0);
    d2 = sqrt(dBox * dBox + dEdge * dEdge) - bold;
  }
  float r = min(rnd, h);
  vec2 w = vec2(d2 + r, abs(p.z) - (h - r));
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2(0.0))) - r;
}`,
};

/** Target-language constructors for the vector args of a primitive call. */
export interface CallSyntax {
  vec2(x: string, y: string): string;
  vec3(x: string, y: string, z: string): string;
}

/** Function name of a primitive in every language (`sphere` → `sdSphere`). */
export function primitiveFnName(shape: Exclude<ShapeType, "image">): string {
  return `sd${shape[0].toUpperCase()}${shape.slice(1)}`;
}

/**
 * Call expression of primitive `shape` at local point `lp`, with params given
 * as target-language expressions (literals for export, buffer reads in the
 * editor). Param meaning per shape: see DEFAULT_PARAMS in sceneStore.ts.
 */
export function primitiveCall(
  shape: Exclude<ShapeType, "image">,
  lp: string,
  P: readonly [string, string, string, string],
  syn: CallSyntax,
): string {
  const [p0, p1, p2, p3] = P;
  const fn = primitiveFnName(shape);
  switch (shape) {
    case "sphere":
    case "octahedron":
      return `${fn}(${lp}, ${p0})`;
    case "box":
      return `${fn}(${lp}, ${syn.vec3(p0, p1, p2)})`;
    case "torus":
      return `${fn}(${lp}, ${syn.vec2(p0, p1)})`;
    case "roundedBox":
    case "boxFrame":
      return `${fn}(${lp}, ${syn.vec3(p0, p1, p2)}, ${p3})`;
    case "rhombus":
      return `${fn}(${lp}, ${p0}, ${p1}, ${p2}, ${p3})`;
    case "cappedTorus":
    case "link":
    case "roundedCylinder":
    case "roundCone":
    case "cutHollowSphere":
    case "deathStar":
      return `${fn}(${lp}, ${p0}, ${p1}, ${p2})`;
    case "cylinder":
    case "capsule":
    case "cone":
    case "hexPrism":
    case "triPrism":
    case "solidAngle":
    case "cutSphere":
    case "pyramid":
    case "vesica":
      return `${fn}(${lp}, ${p0}, ${p1})`;
  }
}

// ── Modifier helpers (src/store/modifiers.ts) ────────────────────────────────
// One source per language for the viewport compiler (WGSL, prefixed ds_) and
// the export. Axis arguments: 0 = x, 1 = y, 2 = z.

export const MODIFIER_WGSL = `// Repetition: c = copies per axis (1 = off, 0 = infinite), centered on the
// origin; even counts straddle it. Polar repetition: count copies around an
// axis, sector = 2π / count. A point is checked against the nearest copy,
// then (unless …Others says no other copy can be nearer) against the
// neighbors whose bounding sphere (…NearBound) beats the result so far;
// …Far caps it for the copies no candidate covers. See modifierMath.ts.

// The cell (copy index per axis) nearest to q.
fn repeatCell(q: vec3f, s: vec3f, c: vec3f) -> vec3f {
  let h = max(c - 1.0, vec3f(0.0)) * 0.5;
  let shift = h - floor(h);
  return select(clamp(round(q / s - shift) + shift, -h, h), round(q / s), c < vec3f(0.5));
}

// Toward q from the center of cell id: +1 or −1 per axis.
fn repeatDir(q: vec3f, s: vec3f, id: vec3f) -> vec3f {
  return select(vec3f(1.0), vec3f(-1.0), q - s * id < vec3f(0.0));
}

// 1 where cell id holds a copy on that axis, else 0.
fn repeatHas(id: vec3f, c: vec3f) -> vec3f {
  let h = max(c - 1.0, vec3f(0.0)) * 0.5;
  return select(vec3f(0.0), vec3f(1.0), (c < vec3f(0.5)) | (abs(id) <= h + 0.25));
}

// Candidate n's step from cell id, in units of "toward q" per axis: bit k
// of n crosses the face toward q on axis k (copies inside their cells).
fn repeatStep(n: u32) -> vec3f {
  return vec3f(f32(n & 1u), f32((n >> 1u) & 1u), f32((n >> 2u) & 1u));
}

// Candidate n's step over the ring of cells around q's cell (copies that
// leave their cells): radix.k choices per axis (1: stay; 2: stay, toward q;
// 3: stay, toward, away), n counting through them axis by axis.
fn repeatRing(n: u32, radix: vec3u) -> vec3f {
  let d = vec3u(n % radix.x, (n / radix.x) % radix.y, n / (radix.x * radix.y));
  return select(select(vec3f(0.0), vec3f(1.0), d == vec3u(1u)), vec3f(-1.0), d == vec3u(2u));
}

// A candidate copy's point: cell id stepped by step (repeatStep / repeatRing).
fn opRepeatNear(q: vec3f, s: vec3f, id: vec3f, step: vec3f) -> vec3f {
  return q - s * (id + repeatDir(q, s, id) * step);
}

// Lower bound of the distance to a candidate copy: to its bounding sphere
// (sphere.xyz, sphere.w in the copy's frame); 1e10 when its cell is empty.
fn opRepeatNearBound(q: vec3f, s: vec3f, c: vec3f, id: vec3f, sphere: vec4f, step: vec3f) -> f32 {
  if (dot(abs(step) * (1.0 - repeatHas(id + repeatDir(q, s, id) * step, c)), vec3f(1.0)) > 0.0) { return 1e10; }
  return length(opRepeatNear(q, s, id, step) - sphere.xyz) - sphere.w;
}

// Lower bound of the distance to every copy but cell id's: to the nearest
// other copy's bounding sphere (sphere.xyz, .w in a copy's frame), one cell
// over along one repeated axis. (Never below "across a face, a copy keeps its
// gap", so that one is not needed here.)
fn opRepeatOthers(q: vec3f, s: vec3f, c: vec3f, id: vec3f, sphere: vec4f) -> f32 {
  let e = q - s * id - sphere.xyz;
  let rep = (c < vec3f(0.5)) | (c > vec3f(1.5));
  // Per axis: the nearest center offset over any copy, and over the copies
  // one or more cells over.
  let k = select(vec3f(0.0), round(e / s), rep);
  let g = e - s * k;
  let h = select(vec3f(1e10), select(g, s - abs(e), k == vec3f(0.0)), rep);
  let m = dot(g, g) - g * g + h * h;
  return sqrt(min(m.x, min(m.y, m.z))) - sphere.w;
}

// Lower bound of the distance to the copies no candidate covers (past the
// far face, two cells toward q); 1e10 when there are none, or when copies
// reach so far past their cell that it says nothing.
fn opRepeatFar(q: vec3f, s: vec3f, c: vec3f, id: vec3f, gap: vec3f) -> f32 {
  let dir = repeatDir(q, s, id);
  let a = abs(q - s * id);
  let away = mix(vec3f(1e10), s * 0.5 + a + gap, repeatHas(id - dir, c));
  let two = mix(vec3f(1e10), s * 1.5 - a + gap, repeatHas(id + 2.0 * dir, c));
  let t = min(away, two);
  let m = min(t.x, min(t.y, t.z));
  return select(m, 1e10, m <= 0.0);
}

// opRepeatFar for the whole-ring candidates: the copies two or more cells
// away on some axis.
fn opRepeatFarRing(q: vec3f, s: vec3f, c: vec3f, id: vec3f, gap: vec3f) -> f32 {
  let dir = repeatDir(q, s, id);
  let a = abs(q - s * id);
  let toward = mix(vec3f(1e10), s * 1.5 - a + gap, repeatHas(id + 2.0 * dir, c));
  let away = mix(vec3f(1e10), s * 1.5 + a + gap, repeatHas(id - 2.0 * dir, c));
  let t = min(toward, away);
  let m = min(t.x, min(t.y, t.z));
  return select(m, 1e10, m <= 0.0);
}

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Scattered repeats: integer hashing only (PCG), so every GPU picks the
// same layout; modifierMath.ts scatterCopy mirrors it on the CPU.
fn scatterHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// A copy's hash: the start of its sequence of random values.
fn scatterBase(id: vec3f, seed: f32) -> u32 {
  let i = bitcast<vec3u>(vec3i(round(id * 2.0)));
  return scatterHash(i.x ^ scatterHash(i.y ^ scatterHash(i.z ^ scatterHash(u32(seed)))));
}

// Value k of a copy's sequence, in [−1, 1]: 0–2 move, 3–5 turn, 6 size.
fn scatterValue(base: u32, k: u32) -> f32 {
  return f32(scatterHash(base + k) >> 8u) / 16777215.0 * 2.0 - 1.0;
}

fn scatterMove(base: u32, jitter: vec4f) -> vec3f {
  return vec3f(scatterValue(base, 0u), scatterValue(base, 1u), scatterValue(base, 2u)) * jitter.xyz;
}

fn scatterSize(base: u32, jitter: vec4f) -> f32 {
  return 1.0 + scatterValue(base, 6u) * jitter.w;
}

// A candidate copy's cell (opRepeatNear's).
fn opRepeatNearId(q: vec3f, s: vec3f, id: vec3f, step: vec3f) -> vec3f {
  return id + repeatDir(q, s, id) * step;
}

// A scattered copy's own frame: p (about its cell's center) moved by up to
// jitter.xyz, turned by up to spin.xyz (radians, Euler XYZ like an item's
// rotation) and scaled by its size. jitter.w: size, spin.w: seed.
fn opScatterPoint(p: vec3f, id: vec3f, jitter: vec4f, spin: vec4f) -> vec3f {
  let b = scatterBase(id, spin.w);
  let q0 = p - scatterMove(b, jitter);
  let a = vec3f(scatterValue(b, 3u), scatterValue(b, 4u), scatterValue(b, 5u)) * spin.xyz;
  let xy = rot2(q0.xy, -a.z);
  let zx = rot2(vec2f(q0.z, xy.x), -a.y);
  let yz = rot2(vec2f(xy.y, zx.x), -a.x);
  return vec3f(zx.y, yz.x, yz.y) / scatterSize(b, jitter);
}

// How much a scattered copy grows: its distance is multiplied by this.
fn opScatterSize(id: vec3f, jitter: vec4f, spin: vec4f) -> f32 {
  return scatterSize(scatterBase(id, spin.w), jitter);
}

// Lower bound of the distance to a scattered copy: to its own sphere (its
// move, and reach · its size; reach: the unscattered copy's |center| + radius).
fn opScatterBound(p: vec3f, id: vec3f, jitter: vec4f, spin: vec4f, reach: f32) -> f32 {
  let b = scatterBase(id, spin.w);
  return length(p - scatterMove(b, jitter)) - reach * scatterSize(b, jitter);
}

// The plane a polar repeat turns in, and back.
fn polarUv(q: vec3f, axis: u32) -> vec2f {
  if (axis == 0u) { return q.yz; }
  if (axis == 1u) { return q.xz; }
  return q.xy;
}

fn polarSet(q: vec3f, axis: u32, uv: vec2f) -> vec3f {
  if (axis == 0u) { return vec3f(q.x, uv.x, uv.y); }
  if (axis == 1u) { return vec3f(uv.x, q.y, uv.y); }
  return vec3f(uv.x, uv.y, q.z);
}

// Candidate n: 0 the nearest sector's copy, 1 the next one toward q, 2 the
// one on the other side.
fn opPolarNear(q: vec3f, sector: f32, axis: u32, n: u32) -> vec3f {
  let uv = polarUv(q, axis);
  let a = atan2(uv.y, uv.x);
  let id = round(a / sector);
  let dir = select(1.0, -1.0, a < sector * id);
  let k = select(select(0.0, dir, n == 1u), -dir, n == 2u);
  return polarSet(q, axis, rot2(uv, -sector * (id + k)));
}

// Lower bound of the distance to candidate n's copy: to its bounding sphere.
fn opPolarNearBound(q: vec3f, sector: f32, axis: u32, sphere: vec4f, n: u32) -> f32 {
  return length(opPolarNear(q, sector, axis, n) - sphere.xyz) - sphere.w;
}

// Lower bound of the distance to every copy but the nearest sector's, from
// p (q in that copy's frame, opPolarNear's copy 0): to the nearest other
// copy's bounding sphere. near1 / near2: the sphere's center in the plane,
// turned by ±1 / ±2 sectors (the nearest other is one of those).
fn opPolarOthers(p: vec3f, axis: u32, sphere: vec4f, near1: vec4f, near2: vec4f) -> f32 {
  let pu = polarUv(p, axis);
  let cu = polarUv(sphere.xyz, axis);
  let e = p - sphere.xyz;
  let along = max(dot(e, e) - dot(pu - cu, pu - cu), 0.0);
  let a = pu - near1.xy;
  let b = pu - near1.zw;
  let c = pu - near2.xy;
  let d = pu - near2.zw;
  return sqrt(min(min(dot(a, a), dot(b, b)), min(dot(c, c), dot(d, d))) + along) - sphere.w;
}

// Lower bound of the distance to the copies two or more sectors away (1e10:
// none, or it says nothing).
fn opPolarFar(q: vec3f, sector: f32, axis: u32, gap: vec2f, count: f32) -> f32 {
  if (count < 3.5) { return 1e10; }
  let uv = polarUv(q, axis);
  let a = atan2(uv.y, uv.x);
  let off = abs(a - sector * round(a / sector));
  let rho = length(uv);
  let lb = max(rho * sin(clamp(sector * 1.5 - off + gap.x, 0.0, 1.5707964)), gap.y - rho);
  return select(lb, 1e10, lb <= 0.0);
}

// Copy n counted from q's nearest sector (every copy, for geometry that
// reaches around the axis).
fn opPolarCopy(q: vec3f, sector: f32, axis: u32, n: u32) -> vec3f {
  let uv = polarUv(q, axis);
  return polarSet(q, axis, rot2(uv, -sector * (round(atan2(uv.y, uv.x) / sector) + f32(n))));
}

fn opTwist(q: vec3f, k: f32, axis: u32) -> vec3f {
  if (axis == 0u) { let r = rot2(q.yz, k * q.x); return vec3f(q.x, r.x, r.y); }
  if (axis == 1u) { let r = rot2(q.xz, k * q.y); return vec3f(r.x, q.y, r.y); }
  let r = rot2(q.xy, k * q.z);
  return vec3f(r.x, r.y, q.z);
}

// Bend around an axis: the angle grows along the next axis (z: IQ's cheap bend).
fn opBend(q: vec3f, k: f32, axis: u32) -> vec3f {
  if (axis == 0u) { let r = rot2(q.yz, k * q.y); return vec3f(q.x, r.x, r.y); }
  if (axis == 1u) { let r = rot2(q.zx, k * q.z); return vec3f(r.y, q.y, r.x); }
  let r = rot2(q.xy, k * q.x);
  return vec3f(r.x, r.y, q.z);
}`;

export const MODIFIER_GLSL = `// Repetition: c = copies per axis (1 = off, 0 = infinite), centered on the
// origin; even counts straddle it. Polar repetition: count copies around an
// axis, sector = 2π / count. A point is checked against the nearest copy,
// then (unless …Others says no other copy can be nearer) against the
// neighbors whose bounding sphere (…NearBound) beats the result so far;
// …Far caps it for the copies no candidate covers. See modifierMath.ts.

// The cell (copy index per axis) nearest to q.
vec3 repeatCell(vec3 q, vec3 s, vec3 c) {
  vec3 h = max(c - 1.0, 0.0) * 0.5;
  vec3 shift = h - floor(h);
  return mix(clamp(round(q / s - shift) + shift, -h, h), round(q / s), lessThan(c, vec3(0.5)));
}

// Toward q from the center of cell id: +1 or −1 per axis.
vec3 repeatDir(vec3 q, vec3 s, vec3 id) {
  return mix(vec3(1.0), vec3(-1.0), lessThan(q - s * id, vec3(0.0)));
}

// 1 where cell id holds a copy on that axis, else 0.
vec3 repeatHas(vec3 id, vec3 c) {
  vec3 h = max(c - 1.0, 0.0) * 0.5;
  return max(vec3(lessThan(c, vec3(0.5))), vec3(lessThanEqual(abs(id), h + 0.25)));
}

// Candidate n's step from cell id, in units of "toward q" per axis: bit k
// of n crosses the face toward q on axis k (copies inside their cells).
vec3 repeatStep(int n) {
  return vec3(float(n & 1), float((n >> 1) & 1), float((n >> 2) & 1));
}

// Candidate n's step over the ring of cells around q's cell (copies that
// leave their cells): radix.k choices per axis (1: stay; 2: stay, toward q;
// 3: stay, toward, away), n counting through them axis by axis.
vec3 repeatRing(int n, ivec3 radix) {
  ivec3 d = ivec3(n % radix.x, (n / radix.x) % radix.y, n / (radix.x * radix.y));
  return mix(mix(vec3(0.0), vec3(1.0), equal(d, ivec3(1))), vec3(-1.0), equal(d, ivec3(2)));
}

// A candidate copy's point: cell id stepped by step (repeatStep / repeatRing).
vec3 opRepeatNear(vec3 q, vec3 s, vec3 id, vec3 step) {
  return q - s * (id + repeatDir(q, s, id) * step);
}

// Lower bound of the distance to a candidate copy: to its bounding sphere
// (sphere.xyz, sphere.w in the copy's frame); 1e10 when its cell is empty.
float opRepeatNearBound(vec3 q, vec3 s, vec3 c, vec3 id, vec4 sphere, vec3 step) {
  if (dot(abs(step) * (1.0 - repeatHas(id + repeatDir(q, s, id) * step, c)), vec3(1.0)) > 0.0) return 1e10;
  return length(opRepeatNear(q, s, id, step) - sphere.xyz) - sphere.w;
}

// Lower bound of the distance to every copy but cell id's: to the nearest
// other copy's bounding sphere (sphere.xyz, .w in a copy's frame), one cell
// over along one repeated axis. (Never below "across a face, a copy keeps its
// gap", so that one is not needed here.)
float opRepeatOthers(vec3 q, vec3 s, vec3 c, vec3 id, vec4 sphere) {
  vec3 e = q - s * id - sphere.xyz;
  bvec3 rep = bvec3(max(vec3(lessThan(c, vec3(0.5))), vec3(greaterThan(c, vec3(1.5)))));
  // Per axis: the nearest center offset over any copy, and over the copies
  // one or more cells over.
  vec3 k = mix(vec3(0.0), round(e / s), rep);
  vec3 g = e - s * k;
  vec3 h = mix(vec3(1e10), mix(g, s - abs(e), equal(k, vec3(0.0))), rep);
  vec3 m = dot(g, g) - g * g + h * h;
  return sqrt(min(m.x, min(m.y, m.z))) - sphere.w;
}

// Lower bound of the distance to the copies no candidate covers (past the
// far face, two cells toward q); 1e10 when there are none, or when copies
// reach so far past their cell that it says nothing.
float opRepeatFar(vec3 q, vec3 s, vec3 c, vec3 id, vec3 gap) {
  vec3 dir = repeatDir(q, s, id);
  vec3 a = abs(q - s * id);
  vec3 away = mix(vec3(1e10), s * 0.5 + a + gap, repeatHas(id - dir, c));
  vec3 two = mix(vec3(1e10), s * 1.5 - a + gap, repeatHas(id + 2.0 * dir, c));
  vec3 t = min(away, two);
  float m = min(t.x, min(t.y, t.z));
  return m <= 0.0 ? 1e10 : m;
}

// opRepeatFar for the whole-ring candidates: the copies two or more cells
// away on some axis.
float opRepeatFarRing(vec3 q, vec3 s, vec3 c, vec3 id, vec3 gap) {
  vec3 dir = repeatDir(q, s, id);
  vec3 a = abs(q - s * id);
  vec3 toward = mix(vec3(1e10), s * 1.5 - a + gap, repeatHas(id + 2.0 * dir, c));
  vec3 away = mix(vec3(1e10), s * 1.5 + a + gap, repeatHas(id - 2.0 * dir, c));
  vec3 t = min(toward, away);
  float m = min(t.x, min(t.y, t.z));
  return m <= 0.0 ? 1e10 : m;
}

vec2 rot2(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Scattered repeats: integer hashing only (PCG), so every GPU picks the
// same layout; modifierMath.ts scatterCopy mirrors it on the CPU.
uint scatterHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// A copy's hash: the start of its sequence of random values.
uint scatterBase(vec3 id, float seed) {
  uvec3 i = uvec3(ivec3(round(id * 2.0)));
  return scatterHash(i.x ^ scatterHash(i.y ^ scatterHash(i.z ^ scatterHash(uint(seed)))));
}

// Value k of a copy's sequence, in [−1, 1]: 0–2 move, 3–5 turn, 6 size.
float scatterValue(uint base, uint k) {
  return float(scatterHash(base + k) >> 8u) / 16777215.0 * 2.0 - 1.0;
}

vec3 scatterMove(uint base, vec4 jitter) {
  return vec3(scatterValue(base, 0u), scatterValue(base, 1u), scatterValue(base, 2u)) * jitter.xyz;
}

float scatterSize(uint base, vec4 jitter) {
  return 1.0 + scatterValue(base, 6u) * jitter.w;
}

// A candidate copy's cell (opRepeatNear's).
vec3 opRepeatNearId(vec3 q, vec3 s, vec3 id, vec3 step) {
  return id + repeatDir(q, s, id) * step;
}

// How much a scattered copy grows: its distance is multiplied by this.
float opScatterSize(vec3 id, vec4 jitter, vec4 spin) {
  return scatterSize(scatterBase(id, spin.w), jitter);
}

// Lower bound of the distance to a scattered copy: to its own sphere (its
// move, and reach · its size; reach: the unscattered copy's |center| + radius).
float opScatterBound(vec3 p, vec3 id, vec4 jitter, vec4 spin, float reach) {
  uint b = scatterBase(id, spin.w);
  return length(p - scatterMove(b, jitter)) - reach * scatterSize(b, jitter);
}

// A scattered copy's own frame: p (about its cell's center) moved by up to
// jitter.xyz, turned by up to spin.xyz (radians, Euler XYZ like an item's
// rotation) and scaled by its size. jitter.w: size, spin.w: seed.
vec3 opScatterPoint(vec3 p, vec3 id, vec4 jitter, vec4 spin) {
  uint b = scatterBase(id, spin.w);
  vec3 q0 = p - scatterMove(b, jitter);
  vec3 a = vec3(scatterValue(b, 3u), scatterValue(b, 4u), scatterValue(b, 5u)) * spin.xyz;
  vec2 xy = rot2(q0.xy, -a.z);
  vec2 zx = rot2(vec2(q0.z, xy.x), -a.y);
  vec2 yz = rot2(vec2(xy.y, zx.x), -a.x);
  return vec3(zx.y, yz.x, yz.y) / scatterSize(b, jitter);
}

// The plane a polar repeat turns in, and back.
vec2 polarUv(vec3 q, int axis) {
  return axis == 0 ? q.yz : axis == 1 ? q.xz : q.xy;
}

vec3 polarSet(vec3 q, int axis, vec2 uv) {
  if (axis == 0) return vec3(q.x, uv.x, uv.y);
  if (axis == 1) return vec3(uv.x, q.y, uv.y);
  return vec3(uv.x, uv.y, q.z);
}

// Candidate n: 0 the nearest sector's copy, 1 the next one toward q, 2 the
// one on the other side.
vec3 opPolarNear(vec3 q, float sector, int axis, int n) {
  vec2 uv = polarUv(q, axis);
  float a = atan(uv.y, uv.x);
  float id = round(a / sector);
  float dir = a < sector * id ? -1.0 : 1.0;
  float k = n == 1 ? dir : n == 2 ? -dir : 0.0;
  return polarSet(q, axis, rot2(uv, -sector * (id + k)));
}

// Lower bound of the distance to candidate n's copy: to its bounding sphere.
float opPolarNearBound(vec3 q, float sector, int axis, vec4 sphere, int n) {
  return length(opPolarNear(q, sector, axis, n) - sphere.xyz) - sphere.w;
}

// Lower bound of the distance to every copy but the nearest sector's, from
// p (q in that copy's frame, opPolarNear's copy 0): to the nearest other
// copy's bounding sphere. near1 / near2: the sphere's center in the plane,
// turned by ±1 / ±2 sectors (the nearest other is one of those).
float opPolarOthers(vec3 p, int axis, vec4 sphere, vec4 near1, vec4 near2) {
  vec2 pu = polarUv(p, axis);
  vec2 cu = polarUv(sphere.xyz, axis);
  vec3 e = p - sphere.xyz;
  float along = max(dot(e, e) - dot(pu - cu, pu - cu), 0.0);
  vec2 a = pu - near1.xy;
  vec2 b = pu - near1.zw;
  vec2 c = pu - near2.xy;
  vec2 d = pu - near2.zw;
  return sqrt(min(min(dot(a, a), dot(b, b)), min(dot(c, c), dot(d, d))) + along) - sphere.w;
}

// Lower bound of the distance to the copies two or more sectors away (1e10:
// none, or it says nothing).
float opPolarFar(vec3 q, float sector, int axis, vec2 gap, float count) {
  if (count < 3.5) return 1e10;
  vec2 uv = polarUv(q, axis);
  float a = atan(uv.y, uv.x);
  float off = abs(a - sector * round(a / sector));
  float rho = length(uv);
  float lb = max(rho * sin(clamp(sector * 1.5 - off + gap.x, 0.0, 1.5707964)), gap.y - rho);
  return lb <= 0.0 ? 1e10 : lb;
}

// Copy n counted from q's nearest sector (every copy, for geometry that
// reaches around the axis).
vec3 opPolarCopy(vec3 q, float sector, int axis, int n) {
  vec2 uv = polarUv(q, axis);
  return polarSet(q, axis, rot2(uv, -sector * (round(atan(uv.y, uv.x) / sector) + float(n))));
}

vec3 opTwist(vec3 q, float k, int axis) {
  if (axis == 0) { vec2 r = rot2(q.yz, k * q.x); return vec3(q.x, r.x, r.y); }
  if (axis == 1) { vec2 r = rot2(q.xz, k * q.y); return vec3(r.x, q.y, r.y); }
  vec2 r = rot2(q.xy, k * q.z);
  return vec3(r.x, r.y, q.z);
}

// Bend around an axis: the angle grows along the next axis (z: IQ's cheap bend).
vec3 opBend(vec3 q, float k, int axis) {
  if (axis == 0) { vec2 r = rot2(q.yz, k * q.y); return vec3(q.x, r.x, r.y); }
  if (axis == 1) { vec2 r = rot2(q.zx, k * q.z); return vec3(r.y, q.y, r.x); }
  vec2 r = rot2(q.xy, k * q.x);
  return vec3(r.x, r.y, q.z);
}`;

/** TypeGPU export: the WGSL helpers as typed raw-WGSL functions. */
export const MODIFIER_TG = (() => {
  // [name, signature, params, helpers it calls] — callees first.
  const fns: [string, string, string, string[]][] = [
    ["repeatCell", "[d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, c)", []],
    ["repeatDir", "[d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, id)", []],
    ["repeatHas", "[d.vec3f, d.vec3f], d.vec3f", "(id, c)", []],
    ["repeatStep", "[d.u32], d.vec3f", "(n)", []],
    ["repeatRing", "[d.u32, d.vec3u], d.vec3f", "(n, radix)", []],
    ["opRepeatNear", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, id, step)", ["repeatDir"]],
    ["opRepeatNearBound", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec4f, d.vec3f], d.f32", "(q, s, c, id, sphere, step)", ["repeatDir", "repeatHas", "opRepeatNear"]],
    ["opRepeatOthers", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec4f], d.f32", "(q, s, c, id, sphere)", []],
    ["opRepeatFar", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec3f], d.f32", "(q, s, c, id, gap)", ["repeatDir", "repeatHas"]],
    ["opRepeatFarRing", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec3f], d.f32", "(q, s, c, id, gap)", ["repeatDir", "repeatHas"]],
    ["rot2", "[d.vec2f, d.f32], d.vec2f", "(v, a)", []],
    ["scatterHash", "[d.u32], d.u32", "(v)", []],
    ["scatterBase", "[d.vec3f, d.f32], d.u32", "(id, seed)", ["scatterHash"]],
    ["scatterValue", "[d.u32, d.u32], d.f32", "(base, k)", ["scatterHash"]],
    ["scatterMove", "[d.u32, d.vec4f], d.vec3f", "(base, jitter)", ["scatterValue"]],
    ["scatterSize", "[d.u32, d.vec4f], d.f32", "(base, jitter)", ["scatterValue"]],
    ["opRepeatNearId", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, id, step)", ["repeatDir"]],
    ["opScatterSize", "[d.vec3f, d.vec4f, d.vec4f], d.f32", "(id, jitter, spin)", ["scatterBase", "scatterSize"]],
    ["opScatterBound", "[d.vec3f, d.vec3f, d.vec4f, d.vec4f, d.f32], d.f32", "(p, id, jitter, spin, reach)", ["scatterBase", "scatterMove", "scatterSize"]],
    ["opScatterPoint", "[d.vec3f, d.vec3f, d.vec4f, d.vec4f], d.vec3f", "(p, id, jitter, spin)", ["scatterBase", "scatterMove", "scatterValue", "scatterSize", "rot2"]],
    ["polarUv", "[d.vec3f, d.u32], d.vec2f", "(q, axis)", []],
    ["polarSet", "[d.vec3f, d.u32, d.vec2f], d.vec3f", "(q, axis, uv)", []],
    ["opPolarNear", "[d.vec3f, d.f32, d.u32, d.u32], d.vec3f", "(q, sector, axis, n)", ["polarUv", "polarSet", "rot2"]],
    ["opPolarNearBound", "[d.vec3f, d.f32, d.u32, d.vec4f, d.u32], d.f32", "(q, sector, axis, sphere, n)", ["opPolarNear"]],
    ["opPolarOthers", "[d.vec3f, d.u32, d.vec4f, d.vec4f, d.vec4f], d.f32", "(p, axis, sphere, near1, near2)", ["polarUv"]],
    ["opPolarFar", "[d.vec3f, d.f32, d.u32, d.vec2f, d.f32], d.f32", "(q, sector, axis, gap, count)", ["polarUv"]],
    ["opPolarCopy", "[d.vec3f, d.f32, d.u32, d.u32], d.vec3f", "(q, sector, axis, n)", ["polarUv", "polarSet", "rot2"]],
    ["opTwist", "[d.vec3f, d.f32, d.u32], d.vec3f", "(q, k, axis)", ["rot2"]],
    ["opBend", "[d.vec3f, d.f32, d.u32], d.vec3f", "(q, k, axis)", ["rot2"]],
  ];
  const body = (name: string) => {
    const m = MODIFIER_WGSL.match(new RegExp(`fn ${name}\\([^)]*\\) -> \\w+ (\\{[\\s\\S]*?\\n\\})`));
    return m ? m[1] : "{}";
  };
  return fns
    .map(([name, sig, params, calls]) => {
      const uses = calls.length > 0 ? `.$uses({ ${calls.join(", ")} })` : "";
      return `const ${name} = tgpu.fn(${sig})\`${params} ${body(name)}\`${uses};`;
    })
    .join("\n\n");
})();
