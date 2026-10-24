/**
 * Geometry math for modifiers, shared by the viewport compiler and the code
 * export so both make the same decisions (neighbor cells, Lipschitz factors,
 * bounds). Spheres are (center, radius) in the space a modifier list acts in.
 */
import { scatterActive, type Axis, type Modifier, type Scatter, type Vec3 } from "../store/modifiers";

/** Bound radius standing in for "unbounded" (infinite repetition). */
export const UNBOUNDED = 1e5;

/**
 * A polar repeat turns a point into its sector's frame, then moves it by
 * this (radius along the plane's first axis) so the copy sits that far out.
 */
export function polarShift(m: Extract<Modifier, { kind: "polar" }>): Vec3 {
  const out: Vec3 = [0, 0, 0];
  out[planeAxes("polar", m.axis)[0]] = m.radius;
  return out;
}

/** Axes of the plane a polar / twist (rotation axis `a`) or bend acts in. */
export function planeAxes(kind: "polar" | "twist" | "bend", a: Axis): [Axis, Axis] {
  if (kind === "bend") return [((a + 1) % 3) as Axis, ((a + 2) % 3) as Axis];
  return a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
}

/**
 * Geometry sphere seen through one point modifier, in the modifier's input
 * space (the inverse image of the sphere the modifier's output sees).
 * Rotations about an axis keep distance to it, so polar / twist / bend only
 * need the sphere moved onto the axis and grown by how far it was.
 */
export function expandThrough(m: Modifier, c: Vec3, r: number): { c: Vec3; r: number } {
  switch (m.kind) {
    case "repeat": {
      ({ c, r } = scatterSphere(m, c, r));
      if (m.count.some((n) => n === 0)) return { c, r: UNBOUNDED };
      const half = m.spacing.map((s, a) => (s * Math.max(0, m.count[a] - 1)) / 2);
      return { c, r: r + Math.hypot(half[0], half[1], half[2]) };
    }
    case "mirror": {
      // The item and its reflection, offset to either side of the origin.
      const off = c.map((v, a) => (m.axes[a] ? Math.abs(v) + m.offset[a] : 0));
      return { c: c.map((v, a) => (m.axes[a] ? 0 : v)) as Vec3, r: r + Math.hypot(off[0], off[1], off[2]) };
    }
    case "polar":
    case "twist":
    case "bend": {
      const [u, v] = planeAxes(m.kind, m.axis);
      if (m.kind === "polar") c = polarSector(m, c);
      const out = [...c] as Vec3;
      out[u] = 0;
      out[v] = 0;
      return { c: out, r: r + Math.hypot(c[u], c[v]) };
    }
    case "elongate":
      return { c, r: r + Math.hypot(m.size[0], m.size[1], m.size[2]) };
    case "round":
      return { c, r: r + m.radius };
    case "onion":
      return { c, r: r + m.thickness };
  }
}

/**
 * Lipschitz bound of a twist / bend over a sphere: the rotation angle grows
 * by k per unit, so points at distance R from the axis move k·R per unit.
 */
export function deformLipschitz(m: Modifier, c: Vec3, r: number): number {
  if (m.kind !== "twist" && m.kind !== "bend") return 1;
  const [u, v] = planeAxes(m.kind, m.axis);
  const reach = m.kind === "bend" ? Math.hypot(c[u], c[v]) + r : Math.hypot(c[u], c[v]) + r;
  return Math.sqrt(1 + (m.amount * reach) ** 2);
}

/**
 * Repeats and polar repeats fold a point onto the nearest copy. That copy is
 * not always the nearest one: a shape that is not symmetric in its cell (a
 * cone: base on one side, tip on the other), or one wider than its cell /
 * sector, can be nearer to a neighbor's copy. A distance that ignores it
 * lets the march step through it (notches, spikes). So the shaders look
 * at the nearest copy and stop there when no other copy can be nearer (a
 * lower bound from the gap: how far copies stay inside their cell / sector,
 * negative when they reach past it). Otherwise each neighbor across the
 * faces toward the point runs when the distance to its bounding sphere beats
 * the result so far, and a lower bound of everything farther caps it. The
 * result is a true distance wherever it matters, so soft shadows see no
 * phantom occluders, and usually one copy is evaluated.
 */

/**
 * A repeat's copy sphere (c, r in its output space) once scattered: each
 * copy may move by up to the jitter, and turn and grow about its cell's
 * center.
 */
export function scatterSphere(m: Extract<Modifier, { kind: "repeat" }>, c: Vec3, r: number): { c: Vec3; r: number } {
  if (!scatterActive(m.scatter) || r >= UNBOUNDED) return { c, r };
  const s = m.scatter;
  return { c: [0, 0, 0], r: (Math.hypot(c[0], c[1], c[2]) + r) * (1 + s.size) + Math.hypot(s.jitter[0], s.jitter[1], s.jitter[2]) };
}

/** PCG hash (u32), bit-identical to the shaders' scatterHash. */
function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** A copy's hash, like the shaders' scatterBase. */
function scatterBase(id: Readonly<Vec3>, seed: number): number {
  const [x, y, z] = id.map((v) => Math.round(v * 2) >>> 0);
  return pcgHash(x ^ pcgHash(y ^ pcgHash(z ^ pcgHash(seed >>> 0))));
}

/** Value k of a copy's sequence in [−1, 1] (0–2 move, 3–5 turn, 6 size), like scatterValue. */
function scatterValue(base: number, k: number): number {
  return ((pcgHash((base + k) >>> 0) >>> 8) / 16777215) * 2 - 1;
}

/**
 * The copy in cell `id` (copy indices, as repeatCell gives them) of a
 * scattered repeat, as the shaders place it: moved by `offset`, turned by
 * `rotation` (degrees, Euler XYZ) about its cell's center, scaled by
 * `size`. For tests and tools; the shaders compute the same per point.
 */
export function scatterCopy(s: Scatter, id: Readonly<Vec3>): { offset: Vec3; rotation: Vec3; size: number } {
  const b = scatterBase(id, s.seed);
  return {
    offset: [0, 1, 2].map((k) => scatterValue(b, k) * s.jitter[k]) as Vec3,
    rotation: [0, 1, 2].map((k) => scatterValue(b, 3 + k) * s.spin[k]) as Vec3,
    size: 1 + scatterValue(b, 6) * s.size,
  };
}

/** Per axis, how far a repeat's copies stay inside their cell (sphere c, r in its output space). */
export function repeatGap(m: Extract<Modifier, { kind: "repeat" }>, c: Vec3, r: number): Vec3 {
  return m.spacing.map((s, a) => s / 2 - Math.abs(c[a]) - r) as Vec3;
}

/**
 * Copies of a polar repeat a point has to look at: the nearest three
 * (branch and bound as above), or all of them when the geometry reaches
 * farther around the axis than one sector (e.g. a shape on its own polar
 * axis covers every angle).
 */
export type PolarReach = "near" | "all";

/** Angular half-width of sphere (c, r) seen from the polar axis, and its center's angle. */
function polarSpan(m: Extract<Modifier, { kind: "polar" }>, c: Vec3, r: number): { angle: number; half: number } {
  const [u, v] = planeAxes("polar", m.axis);
  const d = Math.hypot(c[u], c[v]);
  return { angle: Math.abs(Math.atan2(c[v], c[u])), half: r >= d ? Math.PI : Math.asin(r / d) };
}

/** A sphere center in a polar's output space (after its shift), seen in its sector's frame (before it). */
export function polarSector(m: Extract<Modifier, { kind: "polar" }>, c: Readonly<Vec3>): Vec3 {
  const s = polarShift(m);
  return [c[0] + s[0], c[1] + s[1], c[2] + s[2]];
}

/** Geometry sphere (c, r) in the polar repeat's sector frame (polarSector). */
export function polarReach(m: Extract<Modifier, { kind: "polar" }>, c: Vec3, r: number): PolarReach {
  if (m.count <= 3) return "near"; // the nearest three are all of them
  const { angle, half } = polarSpan(m, c, r);
  return (angle + half) / ((2 * Math.PI) / m.count) <= 1.45 ? "near" : "all";
}

/** Radians a polar repeat's copies stay inside their sector, and how far they stay from the axis. */
export function polarGap(m: Extract<Modifier, { kind: "polar" }>, c: Vec3, r: number): [number, number] {
  const { angle, half } = polarSpan(m, c, r);
  const [u, v] = planeAxes("polar", m.axis);
  return [Math.max(-Math.PI, Math.PI / m.count - angle - half), Math.hypot(c[u], c[v]) - r];
}

/**
 * A polar copy's sphere center `c` in its plane (the polar's axes, in order),
 * turned by +1, −1, +2 and −2 sectors: the other copies' centers seen from a
 * copy's frame (opPolarOthers).
 */
export function polarTurned(m: Extract<Modifier, { kind: "polar" }>, c: Readonly<Vec3>): [number, number, number, number, number, number, number, number] {
  const [u, v] = planeAxes("polar", m.axis);
  const sector = (2 * Math.PI) / m.count;
  return [1, -1, 2, -2].flatMap((k) => {
    const a = k * sector;
    return [Math.cos(a) * c[u] - Math.sin(a) * c[v], Math.sin(a) * c[u] + Math.cos(a) * c[v]];
  }) as [number, number, number, number, number, number, number, number];
}

/** What a point-modifier list does to a sphere of geometry, and what it needs. */
export interface ModifierPlan {
  /** Per modifier (same order): polar copies to look at, else null. */
  polar: (PolarReach | null)[];
  /** Per modifier (same order): repeatGap / polarGap, else null. */
  gap: (Vec3 | [number, number] | null)[];
  /**
   * Per modifier (same order), for a repeat whose copies leave their cells
   * on a repeated axis (negative gap): the cells around a point it checks,
   * per axis 1 (one copy: stay), 2 (stay, toward the point) or 3 (also away);
   * null when the cells toward the point are enough (repeatStep).
   */
  ring: (Vec3 | null)[];
  /** Per modifier (same order): a scattered repeat's unscattered copy reach (|center| + radius), else null. */
  reach: (number | null)[];
  /** Per modifier (same order): a repeat's / polar's copy's bounding sphere in its output space, else null. */
  copy: ({ c: Vec3; r: number } | null)[];
  /** Combined 1 / Lipschitz of the deformations (twist, bend). */
  invL: number;
  /** The geometry sphere in the list's input space. */
  c: Vec3;
  r: number;
}

/**
 * Walks `point` modifiers outward from geometry sphere (c, r) — last
 * modifier first — growing the sphere into each modifier's input space.
 */
export function planPointModifiers(point: Modifier[], c: Vec3, r: number): ModifierPlan {
  const polar: ModifierPlan["polar"] = point.map(() => null);
  const gap: ModifierPlan["gap"] = point.map(() => null);
  const copy: ModifierPlan["copy"] = point.map(() => null);
  const ring: ModifierPlan["ring"] = point.map(() => null);
  const reach: ModifierPlan["reach"] = point.map(() => null);
  let invL = 1;
  for (let i = point.length - 1; i >= 0; i--) {
    const m = point[i];
    if (m.kind === "repeat") {
      const scattered = scatterSphere(m, c, r);
      copy[i] = { c: [...scattered.c] as Vec3, r: scattered.r };
      const g = repeatGap(m, scattered.c, scattered.r);
      gap[i] = g;
      if (g.some((v, a) => m.count[a] !== 1 && v < 0)) ring[i] = m.count.map((n, a) => (n === 1 ? 1 : g[a] < 0 ? 3 : 2)) as Vec3;
      if (scatterActive(m.scatter)) reach[i] = Math.hypot(c[0], c[1], c[2]) + r;
    }
    if (m.kind === "polar") {
      // Polar bounds work in the sector's frame, before the radius shift.
      const sc = polarSector(m, c);
      copy[i] = { c: sc, r };
      polar[i] = polarReach(m, sc, r);
      gap[i] = polarGap(m, sc, r);
    }
    invL /= deformLipschitz(m, c, r);
    ({ c, r } = expandThrough(m, c, r));
  }
  return { polar, gap, copy, ring, reach, invL, c, r };
}
