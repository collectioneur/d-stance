/**
 * Bounding spheres of scene items with their modifiers, in the item's parent
 * frame. Used by the code export (neighbor / Lipschitz decisions shared with
 * the viewport via planPointModifiers) and for framing. The viewport compiler
 * computes the same spheres frame by frame while it builds its IR.
 */
import type { ObjectGroup, OpType, SceneItem } from "../store/sceneStore";
import { POINT_MODIFIERS, activeModifiers, type Modifier, type Vec3 } from "../store/modifiers";
import { maxAbsScale, shapeBoundRadius } from "../gpu/bounds";
import { itemLocalToWorldPosition } from "../gpu/gizmo";
import { UNBOUNDED, planPointModifiers, type ModifierPlan } from "./modifierMath";

export type Sphere = { c: Vec3; r: number };

const SMOOTH: ReadonlySet<OpType> = new Set(["sUnion", "sSubtract", "sIntersect"]);

function postGrow(mods: Modifier[]): number {
  let g = 0;
  for (const m of mods) {
    if (m.kind === "round") g += m.radius;
    else if (m.kind === "onion") g += m.thickness;
  }
  return g;
}

export function encloseAll(spheres: Sphere[]): Sphere {
  const c: Vec3 = [0, 0, 0];
  for (const s of spheres) for (let k = 0; k < 3; k++) c[k] += s.c[k] / spheres.length;
  let r = 0;
  for (const s of spheres) r = Math.max(r, Math.hypot(s.c[0] - c[0], s.c[1] - c[1], s.c[2] - c[2]) + s.r);
  return { c, r };
}

/**
 * Point-modifier plan of a shape (in its local, scaled frame around its
 * origin) — what the export needs to mirror the viewport.
 */
export function shapePlan(item: Extract<SceneItem, { kind: "layer" }>): ModifierPlan {
  const mods = activeModifiers(item.modifiers);
  const s = Math.max(Math.abs(item.scale[0]), Math.abs(item.scale[1]), Math.abs(item.scale[2]));
  return planPointModifiers(
    mods.filter((m) => POINT_MODIFIERS.has(m.kind)),
    [0, 0, 0],
    shapeBoundRadius(item) / s + postGrow(mods),
  );
}

/** Children sphere of a group in its own (local) frame, post modifiers included. */
export function groupLocalSphere(group: ObjectGroup): Sphere | null {
  const kids = group.items.map(itemSphere).filter((s): s is Sphere => !!s);
  if (kids.length === 0) return null;
  const s = encloseAll(kids);
  let bulge = 0;
  group.items.forEach((it, i) => {
    if (i > 0 && SMOOTH.has(it.op)) bulge = Math.max(bulge, Math.abs(it.smoothK) * 0.25);
  });
  return { c: s.c, r: s.r + bulge + postGrow(activeModifiers(group.modifiers)) };
}

export function groupPlan(group: ObjectGroup): ModifierPlan | null {
  const local = groupLocalSphere(group);
  if (!local) return null;
  const point = activeModifiers(group.modifiers).filter((m) => POINT_MODIFIERS.has(m.kind));
  return planPointModifiers(point, local.c, local.r);
}

/** Sphere around the item's geometry in its parent's frame; null for empty groups. */
export function itemSphere(item: SceneItem): Sphere | null {
  if (item.kind === "layer") {
    const plan = shapePlan(item);
    const s = Math.max(Math.abs(item.scale[0]), Math.abs(item.scale[1]), Math.abs(item.scale[2]));
    return { c: [...item.position], r: plan.r >= UNBOUNDED ? UNBOUNDED : plan.r * s };
  }
  const plan = groupPlan(item);
  if (!plan) return null;
  if (plan.r >= UNBOUNDED) return { c: [...item.position], r: UNBOUNDED };
  return {
    c: itemLocalToWorldPosition(plan.c, [item]) as Vec3,
    r: plan.r * maxAbsScale(item),
  };
}

/** Most the viewport / export march ever looks for the scene sphere. */
export const MAX_SCENE_RADIUS = 100;

/** Root-level spheres (world frame), modifiers included; empty groups skipped. */
export function rootSpheres(items: SceneItem[]): Sphere[] {
  return items.map(itemSphere).filter((s): s is Sphere => !!s);
}

/** Origin-centered march radius, like the viewport's (smooth bulge, cap). */
export function sceneMarchRadius(items: SceneItem[]): number {
  let r = 0;
  for (const s of rootSpheres(items)) r = Math.max(r, Math.hypot(s.c[0], s.c[1], s.c[2]) + s.r);
  items.forEach((it, i) => {
    if (i > 0 && SMOOTH.has(it.op)) r += Math.abs(it.smoothK) * 0.25;
  });
  return Math.min(MAX_SCENE_RADIUS, r + 0.05);
}

/**
 * Sphere to frame a camera on: center of the box around the root spheres,
 * farthest reach. Null when the scene is empty or unbounded (infinite repeat).
 */
export function sceneFrameSphere(items: SceneItem[]): Sphere | null {
  const spheres = rootSpheres(items);
  if (spheres.length === 0 || spheres.some((s) => s.r >= UNBOUNDED)) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { c, r } of spheres) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], c[k] - r);
      hi[k] = Math.max(hi[k], c[k] + r);
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3;
  let r = 0;
  for (const s of spheres) r = Math.max(r, Math.hypot(s.c[0] - c[0], s.c[1] - c[1], s.c[2] - c[2]) + s.r);
  return { c, r };
}

/** Lowest point of the scene (+Y is down) — where a studio floor goes. 0 if unbounded. */
export function sceneFloorY(items: SceneItem[]): number {
  let y = -Infinity;
  for (const s of rootSpheres(items)) {
    if (s.r >= UNBOUNDED) continue;
    y = Math.max(y, s.c[1] + s.r);
  }
  return Number.isFinite(y) ? Math.round(y * 1e4) / 1e4 : 0;
}
