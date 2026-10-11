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
// origin; even counts straddle it.
fn opRepeat(q: vec3f, s: vec3f, c: vec3f) -> vec3f {
  let h = max(c - 1.0, vec3f(0.0)) * 0.5;
  let shift = h - floor(h);
  let lim = clamp(round(q / s - shift) + shift, -h, h);
  return q - s * select(lim, round(q / s), c < vec3f(0.5));
}

// The cell nearest to q, or (step = 1 on an axis) its neighbor toward q.
fn opRepeatCell(q: vec3f, s: vec3f, c: vec3f, step: vec3f) -> vec3f {
  let h = max(c - 1.0, vec3f(0.0)) * 0.5;
  let shift = h - floor(h);
  let inf = c < vec3f(0.5);
  let base = select(round(q / s - shift) + shift, round(q / s), inf);
  let id = base + sign(q / s - base) * step;
  return q - s * select(clamp(id, -h, h), id, inf);
}

// Bits of n spread over the axes set in mask (neighbor cell n of 2^axes).
fn cellStep(n: u32, mask: vec3f) -> vec3f {
  var bit = 0u;
  var out = vec3f(0.0);
  if (mask.x > 0.5) { out.x = f32(n & 1u); bit = 1u; }
  if (mask.y > 0.5) { out.y = f32((n >> bit) & 1u); bit += 1u; }
  if (mask.z > 0.5) { out.z = f32((n >> bit) & 1u); }
  return out;
}

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Polar repetition around an axis; sector = 2π / count.
fn opPolar(q: vec3f, sector: f32, axis: u32) -> vec3f {
  var uv = q.yz;
  if (axis == 1u) { uv = q.xz; } else if (axis == 2u) { uv = q.xy; }
  let r = rot2(uv, -sector * round(atan2(uv.y, uv.x) / sector));
  if (axis == 0u) { return vec3f(q.x, r.x, r.y); }
  if (axis == 1u) { return vec3f(r.x, q.y, r.y); }
  return vec3f(r.x, r.y, q.z);
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
// origin; even counts straddle it.
vec3 opRepeat(vec3 q, vec3 s, vec3 c) {
  vec3 h = max(c - 1.0, 0.0) * 0.5;
  vec3 shift = h - floor(h);
  vec3 lim = clamp(round(q / s - shift) + shift, -h, h);
  return q - s * mix(lim, round(q / s), lessThan(c, vec3(0.5)));
}

// The cell nearest to q, or (step = 1 on an axis) its neighbor toward q.
vec3 opRepeatCell(vec3 q, vec3 s, vec3 c, vec3 step) {
  vec3 h = max(c - 1.0, 0.0) * 0.5;
  vec3 shift = h - floor(h);
  bvec3 inf = lessThan(c, vec3(0.5));
  vec3 base = mix(round(q / s - shift) + shift, round(q / s), inf);
  vec3 id = base + sign(q / s - base) * step;
  return q - s * mix(clamp(id, -h, h), id, inf);
}

// Bits of n spread over the axes set in mask (neighbor cell n of 2^axes).
vec3 cellStep(int n, vec3 mask) {
  int bit = 0;
  vec3 o = vec3(0.0);
  if (mask.x > 0.5) { o.x = float(n & 1); bit = 1; }
  if (mask.y > 0.5) { o.y = float((n >> bit) & 1); bit += 1; }
  if (mask.z > 0.5) { o.z = float((n >> bit) & 1); }
  return o;
}

vec2 rot2(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Polar repetition around an axis; sector = 2π / count.
vec3 opPolar(vec3 q, float sector, int axis) {
  vec2 uv = axis == 0 ? q.yz : axis == 1 ? q.xz : q.xy;
  vec2 r = rot2(uv, -sector * round(atan(uv.y, uv.x) / sector));
  if (axis == 0) return vec3(q.x, r.x, r.y);
  if (axis == 1) return vec3(r.x, q.y, r.y);
  return vec3(r.x, r.y, q.z);
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
  const fns: [string, string, string][] = [
    ["opRepeat", "[d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, c)"],
    ["opRepeatCell", "[d.vec3f, d.vec3f, d.vec3f, d.vec3f], d.vec3f", "(q, s, c, step)"],
    ["cellStep", "[d.u32, d.vec3f], d.vec3f", "(n, mask)"],
    ["rot2", "[d.vec2f, d.f32], d.vec2f", "(v, a)"],
    ["opPolar", "[d.vec3f, d.f32, d.u32], d.vec3f", "(q, sector, axis)"],
    ["opTwist", "[d.vec3f, d.f32, d.u32], d.vec3f", "(q, k, axis)"],
    ["opBend", "[d.vec3f, d.f32, d.u32], d.vec3f", "(q, k, axis)"],
  ];
  const body = (name: string) => {
    const m = MODIFIER_WGSL.match(new RegExp(`fn ${name}\\([^)]*\\) -> \\w+ (\\{[\\s\\S]*?\\n\\})`));
    return m ? m[1] : "{}";
  };
  return fns
    .map(([name, sig, params]) => {
      const uses = name === "opPolar" || name === "opTwist" || name === "opBend" ? ".$uses({ rot2 })" : "";
      return `const ${name} = tgpu.fn(${sig})\`${params} ${body(name)}\`${uses};`;
    })
    .join("\n\n");
})();
