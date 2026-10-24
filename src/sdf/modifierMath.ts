/**
 * Geometry math for modifiers, shared by the viewport compiler and the code
 * export so both make the same decisions (neighbor cells, Lipschitz factors,
 * bounds). Spheres are (center, radius) in the space a modifier list acts in.
 */
import type { Axis, Modifier, Vec3 } from "../store/modifiers";

/** Bound radius standing in for "unbounded" (infinite repetition). */
export const UNBOUNDED = 1e5;

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
      if (m.count.some((n) => n === 0)) return { c, r: UNBOUNDED };
      const half = m.spacing.map((s, a) => (s * Math.max(0, m.count[a] - 1)) / 2);
      return { c, r: r + Math.hypot(half[0], half[1], half[2]) };
    }
    case "mirror": {
      const off = c.map((v, a) => (m.axes[a] ? v : 0));
      return { c: c.map((v, a) => (m.axes[a] ? 0 : v)) as Vec3, r: r + Math.hypot(off[0], off[1], off[2]) };
    }
    case "polar":
    case "twist":
    case "bend": {
      const [u, v] = planeAxes(m.kind, m.axis);
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

/** Geometry sphere (c, r) in the polar repeat's output space. */
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
  let invL = 1;
  for (let i = point.length - 1; i >= 0; i--) {
    const m = point[i];
    if (m.kind === "repeat" || m.kind === "polar") copy[i] = { c: [...c] as Vec3, r };
    if (m.kind === "repeat") gap[i] = repeatGap(m, c, r);
    if (m.kind === "polar") {
      polar[i] = polarReach(m, c, r);
      gap[i] = polarGap(m, c, r);
    }
    invL /= deformLipschitz(m, c, r);
    ({ c, r } = expandThrough(m, c, r));
  }
  return { polar, gap, copy, invL, c, r };
}
