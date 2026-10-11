import type { Material, Modifier, ObjectGroup, OpType, SceneItem, SceneRoot, ShapeLayer, ShapeType } from "../store/sceneStore";
import { defaultParams } from "../store/sceneStore";
import type { Track } from "../store/animation";

type V3 = [number, number, number];

let n = 0;
const nextId = (prefix: string) => `${prefix}-${++n}`;

export function shape(
  shapeType: ShapeType,
  opts: Partial<Omit<ShapeLayer, "kind" | "shapeType">> = {},
): ShapeLayer {
  return {
    kind: "layer",
    id: opts.id ?? nextId(shapeType),
    shapeType,
    name: opts.name ?? shapeType,
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
    params: opts.params ?? [...defaultParams(shapeType)],
    op: opts.op ?? "union",
    smoothK: opts.smoothK ?? 0.1,
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.material ? { material: opts.material } : {}),
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.formula ? { formula: opts.formula } : {}),
    ...(opts.animation ? { animation: opts.animation } : {}),
  };
}

export function group(
  items: SceneItem[],
  opts: Partial<{
    id: string;
    name: string;
    position: V3;
    rotation: V3;
    scale: V3;
    op: OpType;
    smoothK: number;
    material: Material;
    modifiers: Modifier[];
    animation: Track[];
  }> = {},
): ObjectGroup {
  return {
    kind: "group",
    id: opts.id ?? nextId("group"),
    name: opts.name ?? "Group",
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
    op: opts.op ?? "union",
    smoothK: opts.smoothK ?? 0.1,
    ...(opts.material ? { material: opts.material } : {}),
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.animation ? { animation: opts.animation } : {}),
    items,
  };
}

export function scene(items: SceneItem[], name = "Scene"): SceneRoot {
  return { id: "root", name, items };
}

/** A smallest-possible syntactically valid image SDF data URL (not a real PNG). */
export const FAKE_IMAGE_SDF = "data:image/png;base64,iVBORw0KGgo=";

/**
 * A scene exercising every hard path: all shape types, nested groups with
 * rotation and non-uniform scale, every CSG op.
 */
export function kitchenSink(): SceneRoot {
  const ops: OpType[] = ["union", "subtract", "intersect", "sUnion", "sSubtract", "sIntersect"];
  return scene([
    shape("sphere", { id: "s1", position: [0.2, -0.1, 0.3] }),
    shape("box", {
      id: "b1",
      op: "sUnion",
      smoothK: 0.2,
      rotation: [10, 20, 30],
      material: { color: [0.9, 0.2, 0.1], roughness: 0.3, metalness: 1, emission: 0.5 },
    }),
    group(
      [
        shape("torus", { id: "t1", scale: [1, 2, 1] }),
        shape("cylinder", { id: "c1", op: "subtract", rotation: [90, 0, 0] }),
        group(
          [
            shape("capsule", { id: "cap1" }),
            shape("cone", { id: "cone1", op: ops[2] }),
          ],
          { id: "g2", rotation: [0, 45, 0], scale: [1, 0.5, 2], op: "sIntersect", smoothK: 0.05 },
        ),
      ],
      { id: "g1", position: [1, 0, 0], rotation: [30, 0, 0], scale: [2, 1, 1], op: "sSubtract", smoothK: 0.15 },
    ),
    shape("roundedBox", { id: "rb" }),
    shape("boxFrame", { id: "bf" }),
    shape("cappedTorus", { id: "ct" }),
    shape("link", { id: "lk" }),
    shape("hexPrism", { id: "hp" }),
    shape("triPrism", { id: "tp" }),
    shape("roundedCylinder", { id: "rc" }),
    shape("roundCone", { id: "rco" }),
    shape("solidAngle", { id: "sa" }),
    shape("cutSphere", { id: "cs" }),
    shape("cutHollowSphere", { id: "chs" }),
    shape("deathStar", { id: "ds" }),
    shape("rhombus", { id: "rh" }),
    shape("octahedron", { id: "oc" }),
    shape("pyramid", { id: "py" }),
    shape("vesica", { id: "ve" }),
    shape("terrain", { id: "te" }),
    shape("gyroid", { id: "gy", modifiers: [{ kind: "noise", amplitude: 0.02, scale: 8, octaves: 3, seed: 2 }] }),
    shape("formula", { id: "fo", formula: "smin(length(x, y, z) - 0.3, y + 0.1, 0.1) + 0.02*fbm(x*4, y*4, z*4) - atan2(x, z)*0" }),
    shape("image", { id: "im", image: { sdf: FAKE_IMAGE_SDF, round: 0.02 } }),
  ]);
}
