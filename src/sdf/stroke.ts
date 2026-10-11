/**
 * Sculpt strokes: polylines of (x, y, z, radius) points in the layer's local
 * space, a radius ≤ 0 marks a break between lines. The SDF is the union of
 * tapered capsules between neighbors (radius lerped along the segment; the
 * taper between neighbors is gentle, so it stays a safe distance bound).
 *
 * Evaluation walks chunks of STROKE_CHUNK segments and skips a chunk whose
 * bounding sphere is farther than the best distance so far, so a long stroke
 * costs a handful of sphere tests plus the segments near the point.
 *
 * Packed layout (GPU buffer in the editor, constant array in exports):
 * [chunk spheres (center, radius) × chunks][points × count].
 *
 * No imports from the scene store (persistence and the store depend on this).
 */

export const STROKE_CHUNK = 16;
/** Points per stroke layer (strokes on one target append until full). */
export const MAX_STROKE_POINTS = 1024;
/** vec4 slots of the editor's stroke buffer: every stroke's points + chunk spheres. */
export const MAX_STROKE_DATA = 16384;
/** Radii and coordinates a persisted stroke may carry. */
export const MAX_STROKE_RADIUS = 5;
const MAX_COORD = 1000;

export type Stroke = { points: number[] };

export function strokeCount(stroke: Stroke | undefined): number {
  return stroke ? Math.floor(stroke.points.length / 4) : 0;
}

/** Segments evaluated: n − 1, or one degenerate segment (a sphere) for a single point. */
export function strokeSegments(count: number): number {
  return count <= 1 ? count : count - 1;
}

export function strokeChunkCount(count: number): number {
  return Math.ceil(strokeSegments(count) / STROKE_CHUNK);
}

/** Bounding sphere of segments [c·CHUNK, c·CHUNK + CHUNK) (both ends of each). */
function chunkSphere(points: readonly number[], count: number, c: number): [number, number, number, number] {
  const i0 = c * STROKE_CHUNK;
  const i1 = Math.min(i0 + STROKE_CHUNK, count - 1);
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (let i = i0; i <= i1; i++) {
    cx += points[i * 4];
    cy += points[i * 4 + 1];
    cz += points[i * 4 + 2];
    n++;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let r = 0;
  for (let i = i0; i <= i1; i++) {
    const rad = Math.max(0, points[i * 4 + 3]);
    r = Math.max(r, Math.hypot(points[i * 4] - cx, points[i * 4 + 1] - cy, points[i * 4 + 2] - cz) + rad);
  }
  return [cx, cy, cz, r];
}

/** Chunk spheres followed by the points, as flat vec4 data. */
export function packStroke(stroke: Stroke): number[] {
  const count = strokeCount(stroke);
  const out: number[] = [];
  for (let c = 0; c < strokeChunkCount(count); c++) out.push(...chunkSphere(stroke.points, count, c));
  for (let i = 0; i < count * 4; i++) out.push(stroke.points[i]);
  return out;
}

/** Local bound radius around the layer origin (thickness 1). */
export function strokeBoundRadius(stroke: Stroke | undefined): number {
  let r = 0;
  const p = stroke?.points ?? [];
  for (let i = 0; i + 3 < p.length; i += 4) r = Math.max(r, Math.hypot(p[i], p[i + 1], p[i + 2]) + Math.max(0, p[i + 3]));
  return r;
}

/** Distance to the stroke at (x, y, z), thickness 1 — CPU reference for tests and tools. */
export function strokeDistance(stroke: Stroke, x: number, y: number, z: number, thickness = 1): number {
  const count = strokeCount(stroke);
  const p = stroke.points;
  let best = 1e10;
  for (let s = 0; s < strokeSegments(count); s++) {
    let a = s * 4;
    let b = Math.min(s + 1, count - 1) * 4;
    // Next to a break the segment shrinks to a sphere on its live end.
    if (p[a + 3] <= 0 && p[b + 3] <= 0) continue;
    if (p[a + 3] <= 0) a = b;
    else if (p[b + 3] <= 0) b = a;
    const pax = x - p[a], pay = y - p[a + 1], paz = z - p[a + 2];
    const bax = p[b] - p[a], bay = p[b + 1] - p[a + 1], baz = p[b + 2] - p[a + 2];
    const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / Math.max(bax * bax + bay * bay + baz * baz, 1e-8)));
    const d = Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - (p[a + 3] + (p[b + 3] - p[a + 3]) * h) * thickness;
    best = Math.min(best, d);
  }
  return best;
}

/**
 * Ramer–Douglas–Peucker on one line (points with radius), keeping points
 * whose position or radius deviates more than `tolerance`. Breaks survive.
 */
export function simplifyLine(points: readonly number[], tolerance: number): number[] {
  const n = Math.floor(points.length / 4);
  if (n <= 2) return [...points];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let worst = -1, worstD = tolerance;
    const ax = points[s * 4], ay = points[s * 4 + 1], az = points[s * 4 + 2], ar = points[s * 4 + 3];
    const bx = points[e * 4], by = points[e * 4 + 1], bz = points[e * 4 + 2], br = points[e * 4 + 3];
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-12);
    for (let i = s + 1; i < e; i++) {
      const px = points[i * 4] - ax, py = points[i * 4 + 1] - ay, pz = points[i * 4 + 2] - az;
      const h = Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / len2));
      const off = Math.hypot(px - dx * h, py - dy * h, pz - dz * h);
      const radiusOff = Math.abs(points[i * 4 + 3] - (ar + (br - ar) * h));
      const d = Math.max(off, radiusOff);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 4], points[i * 4 + 1], points[i * 4 + 2], points[i * 4 + 3]);
  return out;
}

/**
 * Appends a line to a stroke, after a break point (radius 0, placed on the
 * line's start so chunk spheres do not stretch). Null when it would not fit.
 */
export function appendLine(stroke: Stroke | undefined, line: readonly number[]): Stroke | null {
  const prev = stroke?.points ?? [];
  const next = prev.length > 0 ? [...prev, line[0], line[1], line[2], 0, ...line] : [...line];
  return next.length / 4 > MAX_STROKE_POINTS ? null : { points: next };
}

/** A well-formed stroke, or undefined. Trust boundary (hash links). */
export function sanitizeStroke(raw: unknown): Stroke | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const pts = (raw as { points?: unknown }).points;
  if (!Array.isArray(pts) || pts.length < 4) return undefined;
  const n = Math.min(MAX_STROKE_POINTS, Math.floor(pts.length / 4));
  const out: number[] = [];
  for (let i = 0; i < n * 4; i++) {
    const v = pts[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    out.push(i % 4 === 3 ? Math.min(MAX_STROKE_RADIUS, Math.max(0, v)) : Math.min(MAX_COORD, Math.max(-MAX_COORD, v)));
  }
  return out.some((v, i) => i % 4 === 3 && v > 0) ? { points: out } : undefined;
}

/** Rounded to 4 decimals: hash links stay short, the shape does not move. */
export function roundStroke(points: readonly number[]): number[] {
  return points.map((v) => Math.round(v * 1e4) / 1e4);
}

// ── Shader sources (exports) ─────────────────────────────────────────────────

const STROKE_SEG_WGSL = `// Tapered capsule a → b (xyz, radius in w); radius ≤ 0 is a break: next to
// one the segment is a sphere on its live end.
fn strokeSeg(p: vec3f, a0: vec4f, b0: vec4f, thickness: f32) -> f32 {
  if (a0.w <= 0.0 && b0.w <= 0.0) { return 1e10; }
  let a = select(a0, b0, a0.w <= 0.0);
  let b = select(b0, a, b0.w <= 0.0);
  let pa = p - a.xyz;
  let ba = b.xyz - a.xyz;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(a.w, b.w, h) * thickness;
}`;

const STROKE_SEG_GLSL = `// Tapered capsule a → b (xyz, radius in w); radius ≤ 0 is a break: next to
// one the segment is a sphere on its live end.
float strokeSeg(vec3 p, vec4 a0, vec4 b0, float thickness) {
  if (a0.w <= 0.0 && b0.w <= 0.0) return 1e10;
  vec4 a = a0.w <= 0.0 ? b0 : a0;
  vec4 b = b0.w <= 0.0 ? a : b0;
  vec3 pa = p - a.xyz;
  vec3 ba = b.xyz - a.xyz;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h) - mix(a.w, b.w, h) * thickness;
}`;

const STROKE_SEG_TG = `// Tapered capsule a → b (xyz, radius in w); radius ≤ 0 is a break: next to
// one the segment is a sphere on its live end.
const strokeSeg = (p: d.v3f, a0: d.v4f, b0: d.v4f, thickness: number): number => {
  "use gpu";
  if (a0.w <= 0.0 && b0.w <= 0.0) {
    return 1e10;
  }
  const a = std.select(a0, b0, a0.w <= 0.0);
  const b = std.select(b0, a, b0.w <= 0.0);
  const pa = p - a.xyz;
  const ba = b.xyz - a.xyz;
  const h = std.clamp(std.dot(pa, ba) / std.max(std.dot(ba, ba), 1e-8), 0.0, 1.0);
  return std.length(pa - ba * h) - std.mix(a.w, b.w, h) * thickness;
};`;

export const STROKE_HELPERS = { wgsl: STROKE_SEG_WGSL, glsl: STROKE_SEG_GLSL, typegpu: STROKE_SEG_TG } as const;

const lit = (n: number) => {
  const s = parseFloat(n.toFixed(5)).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
};

/**
 * Data + distance function for one stroke, `${name}(p, thickness, limit)`:
 * `limit` is how close the stroke must be to still change the caller's
 * result (1e10 when unknown); chunks beyond it are skipped.
 */
export function strokeFunction(name: string, stroke: Stroke, lang: "wgsl" | "glsl" | "typegpu"): string {
  const count = strokeCount(stroke);
  const chunks = strokeChunkCount(count);
  const data = packStroke(stroke);
  const n = data.length / 4;
  const DATA = `${name.toUpperCase()}_DATA`;
  const vecs = (ctor: string) => {
    const rows: string[] = [];
    for (let i = 0; i < n; i++) rows.push(`${ctor}(${data.slice(i * 4, i * 4 + 4).map(lit).join(", ")})`);
    return rows.join(",\n  ");
  };
  const last = count - 1;
  const segs = strokeSegments(count);
  const note = `// Stroke: ${count} points (x, y, z, radius), ${chunks} chunk spheres first.`;
  if (lang === "wgsl") {
    return `${note}
var<private> ${DATA}: array<vec4f, ${n}> = array<vec4f, ${n}>(
  ${vecs("vec4f")}
);

fn ${name}(p: vec3f, thickness: f32, limit: f32) -> f32 {
  var best = max(limit, 1e-4);
  for (var c = 0u; c < ${chunks}u; c++) {
    let s = ${DATA}[c];
    if (length(p - s.xyz) - s.w * max(thickness, 1.0) > best) { continue; }
    let end = min(c * ${STROKE_CHUNK}u + ${STROKE_CHUNK}u, ${segs}u);
    for (var i = c * ${STROKE_CHUNK}u; i < end; i++) {
      best = min(best, strokeSeg(p, ${DATA}[${chunks}u + i], ${DATA}[${chunks}u + min(i + 1u, ${last}u)], thickness));
    }
  }
  return best;
}`;
  }
  if (lang === "glsl") {
    return `${note}
const vec4 ${DATA}[${n}] = vec4[${n}](
  ${vecs("vec4")}
);

float ${name}(vec3 p, float thickness, float limit) {
  float best = max(limit, 1e-4);
  for (int c = 0; c < ${chunks}; c++) {
    vec4 s = ${DATA}[c];
    if (length(p - s.xyz) - s.w * max(thickness, 1.0) > best) continue;
    int end = min(c * ${STROKE_CHUNK} + ${STROKE_CHUNK}, ${segs});
    for (int i = c * ${STROKE_CHUNK}; i < end; i++) {
      best = min(best, strokeSeg(p, ${DATA}[${chunks} + i], ${DATA}[${chunks} + min(i + 1, ${last})], thickness));
    }
  }
  return best;
}`;
  }
  return `${note}
const ${DATA} = tgpu.const(d.arrayOf(d.vec4f, ${n}), [
  ${vecs("d.vec4f")},
]);

const ${name} = (p: d.v3f, thickness: number, limit: number): number => {
  "use gpu";
  let best = std.max(limit, 1e-4);
  for (let c = d.u32(0); c < ${chunks}; c++) {
    const s = ${DATA}.$[c];
    if (std.length(p - s.xyz) - s.w * std.max(thickness, 1.0) > best) {
      continue;
    }
    const end = std.min(c * ${STROKE_CHUNK} + ${STROKE_CHUNK}, d.u32(${segs}));
    for (let i = c * ${STROKE_CHUNK}; i < end; i++) {
      best = std.min(best, strokeSeg(p, ${DATA}.$[${chunks} + i], ${DATA}.$[${chunks} + std.min(i + 1, d.u32(${last}))], thickness));
    }
  }
  return best;
};`;
}

// ── Import-time self-check ───────────────────────────────────────────────────

function assertStroke() {
  const check = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`stroke self-check failed: ${what}`);
  };
  // A straight line of 40 points: chunk spheres must cover every segment.
  const pts: number[] = [];
  for (let i = 0; i < 40; i++) pts.push(i * 0.05, Math.sin(i) * 0.1, 0, 0.05 + 0.01 * (i % 3));
  const stroke = { points: pts };
  const count = strokeCount(stroke);
  const data = packStroke(stroke);
  check(data.length === (strokeChunkCount(count) + count) * 4, "packed length");
  for (let c = 0; c < strokeChunkCount(count); c++) {
    const [cx, cy, cz, r] = data.slice(c * 4, c * 4 + 4);
    for (let i = c * STROKE_CHUNK; i <= Math.min(c * STROKE_CHUNK + STROKE_CHUNK, count - 1); i++) {
      const d = Math.hypot(pts[i * 4] - cx, pts[i * 4 + 1] - cy, pts[i * 4 + 2] - cz) + pts[i * 4 + 3];
      check(d <= r + 1e-9, `chunk ${c} covers point ${i}`);
    }
  }
  check(Math.abs(strokeDistance({ points: [0, 0, 0, 0.5] }, 1, 0, 0) - 0.5) < 1e-9, "single point is a sphere");
  check(strokeDistance({ points: [0, 0, 0, 0.1, 1, 0, 0, 0, 1, 0, 0, 0.1] }, 0.5, 0, 0) > 0.3, "breaks split lines");
}
assertStroke();
