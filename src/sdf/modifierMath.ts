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
    case "noise":
      return { c, r: r + noiseReach(m) };
  }
}

/** Largest displacement fbm3 can produce (its sum is about ±1.4 at most). */
export function noiseReach(m: Extract<Modifier, { kind: "noise" }>): number {
  return m.amplitude * 1.4;
}

/**
 * 1 / Lipschitz of the distance modifiers: noise adds a field whose slope is
 * about amplitude · scale · 1.6 per octave (empirical — the strict bound is
 * ~2× and would halve marching speed for no visible gain).
 */
export function postInvLipschitz(mods: Modifier[]): number {
  let invL = 1;
  for (const m of mods) {
    if (m.kind === "noise") invL /= 1 + m.amplitude * m.scale * 1.6 * m.octaves;
  }
  return invL;
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
 * Axes on which a repeat's copies reach past their cell (sphere c, r in the
 * repeat's output space): those need the neighbor cell evaluated too, or the
 * overlap is cut off.
 */
export function repeatNeighbors(m: Extract<Modifier, { kind: "repeat" }>, c: Vec3, r: number): [boolean, boolean, boolean] {
  return m.count.map((n, a) => n !== 1 && Math.abs(c[a]) + r > m.spacing[a] * 0.45) as [boolean, boolean, boolean];
}

/** What a point-modifier list does to a sphere of geometry, and what it needs. */
export interface ModifierPlan {
  /** Per modifier (same order): repeat neighbor axes, else null. */
  neighbors: ([boolean, boolean, boolean] | null)[];
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
  const neighbors: ModifierPlan["neighbors"] = point.map(() => null);
  let invL = 1;
  for (let i = point.length - 1; i >= 0; i--) {
    const m = point[i];
    if (m.kind === "repeat") neighbors[i] = repeatNeighbors(m, c, r);
    invL /= deformLipschitz(m, c, r);
    ({ c, r } = expandThrough(m, c, r));
  }
  return { neighbors, invL, c, r };
}
