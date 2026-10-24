import type { ObjectGroup, SceneItem, ShapeLayer } from "../store/sceneStore";
import { itemLocalToWorldPosition } from "./gizmo";

/** Conservative shape bound radius in its own local space (rotation-invariant). */
export function shapeBoundRadius(layer: ShapeLayer): number {
  const [a, b, c, w] = layer.params;
  const maxScale = Math.max(
    Math.abs(layer.scale[0]),
    Math.abs(layer.scale[1]),
    Math.abs(layer.scale[2]),
  );
  let r: number;
  switch (layer.shapeType) {
    case "sphere":
    case "octahedron":
    case "cutSphere":
    case "deathStar":
    case "vesica":
      r = a;
      break;
    case "box":
      r = Math.hypot(a, b, c);
      break;
    case "image":
      // 2D field is clamped to the [-a, a]² square, so bold can't escape it.
      r = Math.hypot(a, a, b);
      break;
    case "roundedBox":
    case "boxFrame":
      r = Math.hypot(a, b, c) + w;
      break;
    case "torus":
    case "capsule":
    case "cappedTorus":
      r = a + b;
      break;
    case "link":
      r = a + b + c;
      break;
    case "roundedCylinder":
      r = Math.hypot(a, b + c);
      break;
    case "roundCone":
      // Base circle r1 sits at y=0, top cap r2 at y=h — not origin-centered.
      r = Math.max(a, b + c);
      break;
    case "solidAngle":
      r = b;
      break;
    case "cutHollowSphere":
      r = a + c;
      break;
    case "rhombus":
      r = Math.hypot(a + w, b + w, c);
      break;
    case "hexPrism":
      // Corner circumradius = inradius * 2/sqrt(3).
      r = Math.hypot(a * 1.1548, b);
      break;
    default: // cylinder, cone, triPrism, pyramid
      // ponytail: hypot of first two params over-covers prisms/pyramid a bit;
      // exact per-shape circumradii is the upgrade path.
      r = Math.hypot(a, b);
      break;
  }
  return r * maxScale;
}

/**
 * Conservative scene bounding-sphere radius centered at world origin.
 * Rotations don't change norms, so |groupPos| + maxScale * childRadius is a
 * valid upper bound without any matrix math. Smooth ops bulge outward at most
 * k/4, folded in via maxSmoothK.
 * ponytail: origin-centered sphere is loose for off-center scenes; upgrade
 * path is a proper transformed AABB merge.
 */
export function sceneBoundRadius(items: SceneItem[]): number {
  let r = 0;
  let maxK = 0;
  for (const item of items) {
    if (item.kind === "layer") {
      const [x, y, z] = item.position;
      r = Math.max(r, Math.hypot(x, y, z) + shapeBoundRadius(item));
    } else {
      const [x, y, z] = item.position;
      const maxScale = Math.max(
        Math.abs(item.scale[0]),
        Math.abs(item.scale[1]),
        Math.abs(item.scale[2]),
      );
      r = Math.max(
        r,
        Math.hypot(x, y, z) + maxScale * sceneBoundRadius(item.items),
      );
    }
    maxK = Math.max(maxK, item.smoothK ?? 0);
  }
  return r + maxK * 0.25;
}

export function maxAbsScale(group: ObjectGroup): number {
  return Math.max(
    Math.abs(group.scale[0]),
    Math.abs(group.scale[1]),
    Math.abs(group.scale[2]),
  );
}

/**
 * Tight-ish world bounding sphere of every shape (center of the box around
 * the shapes' own bound spheres + farthest reach). For framing, not culling.
 */
export function sceneFitSphere(items: SceneItem[]): { center: [number, number, number]; radius: number } | null {
  const spheres: { c: [number, number, number]; r: number }[] = [];
  const walk = (list: SceneItem[], ancestors: ObjectGroup[]) => {
    for (const item of list) {
      if (item.kind === "group") {
        walk(item.items, [...ancestors, item]);
        continue;
      }
      let r = shapeBoundRadius(item);
      for (const g of ancestors) r *= maxAbsScale(g);
      spheres.push({ c: itemLocalToWorldPosition(item.position, ancestors) as [number, number, number], r });
    }
  };
  walk(items, []);
  if (spheres.length === 0) return null;
  // Center of the box around all spheres: tighter than the centroid when
  // shapes cluster on one side.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const { c, r } of spheres) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], c[k] - r);
      hi[k] = Math.max(hi[k], c[k] + r);
    }
  }
  const center: [number, number, number] = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as [number, number, number];
  let radius = 0;
  for (const { c, r } of spheres) {
    radius = Math.max(radius, Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]) + r);
  }
  return { center, radius };
}
