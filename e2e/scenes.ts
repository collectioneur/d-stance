/**
 * Reference scenes for render-parity and perf tests. Plain JSON in the
 * persisted SceneRoot shape, spread out so every shape is visible from the
 * default camera.
 */
type V3 = [number, number, number];

const SHAPES: [string, number[]][] = [
  ["sphere", [0.18, 0, 0, 0]],
  ["box", [0.15, 0.15, 0.15, 0]],
  ["torus", [0.15, 0.05, 0, 0]],
  ["cylinder", [0.12, 0.18, 0, 0]],
  ["capsule", [0.08, 0.12, 0, 0]],
  ["cone", [0.15, 0.2, 0, 0]],
  ["roundedBox", [0.13, 0.13, 0.13, 0.04]],
  ["boxFrame", [0.15, 0.15, 0.15, 0.02]],
  ["cappedTorus", [0.15, 0.05, 120, 0]],
  ["link", [0.08, 0.1, 0.035, 0]],
  ["hexPrism", [0.15, 0.15, 0, 0]],
  ["triPrism", [0.15, 0.15, 0, 0]],
  ["roundedCylinder", [0.12, 0.04, 0.15, 0]],
  ["roundCone", [0.12, 0.05, 0.25, 0]],
  ["solidAngle", [45, 0.2, 0, 0]],
  ["cutSphere", [0.18, 0.07, 0, 0]],
  ["cutHollowSphere", [0.18, 0.07, 0.015, 0]],
  ["deathStar", [0.18, 0.13, 0.18, 0]],
  ["rhombus", [0.18, 0.1, 0.04, 0.01]],
  ["octahedron", [0.18, 0, 0, 0]],
  ["pyramid", [0.25, 0.25, 0, 0]],
  ["vesica", [0.18, 0.09, 0, 0]],
];

let n = 0;
function layer(shapeType: string, params: number[], extra: Record<string, unknown> = {}) {
  return {
    kind: "layer",
    id: `L${++n}`,
    shapeType,
    name: `${shapeType} ${n}`,
    position: [0, 0, 0] as V3,
    rotation: [0, 0, 0] as V3,
    scale: [1, 1, 1] as V3,
    params,
    op: "union",
    smoothK: 0.1,
    ...extra,
  };
}

function group(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    kind: "group",
    id: `G${++n}`,
    name: `Group ${n}`,
    position: [0, 0, 0] as V3,
    rotation: [0, 0, 0] as V3,
    scale: [1, 1, 1] as V3,
    op: "union",
    smoothK: 0.1,
    items,
    ...extra,
  };
}

/** Every primitive on a 6×4 grid, slightly rotated. */
export function allShapesScene() {
  const items = SHAPES.map(([t, p], i) =>
    layer(t, p, {
      position: [((i % 6) - 2.5) * 0.45, 0, (Math.floor(i / 6) - 1.5) * 0.45] as V3,
      rotation: [15, 25 * i, 0] as V3,
    }),
  );
  return { id: "root", name: "All shapes", items };
}

/** Each CSG op inside a transformed group, plus nested non-uniform scale. */
export function csgScene() {
  const ops = ["union", "subtract", "intersect", "sUnion", "sSubtract", "sIntersect"];
  const items = ops.map((op, i) =>
    group(
      [
        layer("box", [0.15, 0.15, 0.15, 0]),
        layer("sphere", [0.19, 0, 0, 0], { op, smoothK: 0.08, position: [0.08, -0.08, 0.05] as V3 }),
      ],
      {
        position: [((i % 3) - 1) * 0.6, 0, (Math.floor(i / 3) - 0.5) * 0.6] as V3,
        rotation: [0, 30 * i, 10] as V3,
        scale: i % 2 ? ([1.3, 0.8, 1] as V3) : ([1, 1, 1] as V3),
      },
    ),
  );
  items.push(
    group(
      [
        group([layer("torus", [0.15, 0.04, 0, 0], { rotation: [90, 0, 0] as V3 })], {
          scale: [1, 2, 1] as V3,
          rotation: [0, 0, 30] as V3,
        }),
        layer("capsule", [0.05, 0.2, 0, 0], { op: "sUnion", smoothK: 0.1, position: [0.15, 0, 0] as V3 }),
      ],
      { position: [0, -0.4, 0.9] as V3, scale: [0.8, 0.8, 1.5] as V3, rotation: [20, 40, 0] as V3 },
    ),
  );
  return { id: "root", name: "CSG", items };
}

/** N small shapes, for perf. `mixed` sprinkles smooth unions between them. */
export function crowdScene(count: number, mixed = true) {
  const side = Math.ceil(Math.sqrt(count));
  const items = Array.from({ length: count }, (_, i) =>
    layer(i % 3 === 0 ? "box" : i % 3 === 1 ? "sphere" : "torus", i % 3 === 0 ? [0.08, 0.08, 0.08, 0] : i % 3 === 1 ? [0.1, 0, 0, 0] : [0.08, 0.03, 0, 0], {
      position: [((i % side) - side / 2) * 0.28, 0, (Math.floor(i / side) - side / 2) * 0.28] as V3,
      op: mixed && i % 7 === 3 ? "sUnion" : "union",
    }),
  );
  return { id: "root", name: "Crowd", items };
}

/** Materials showcase: colors, metals, emission, a smooth blend and a cut. */
export function materialsScene() {
  const mat = (color: [number, number, number], roughness: number, metalness: number, emission = 0) => ({
    color,
    roughness,
    metalness,
    emission,
  });
  return {
    id: "root",
    name: "Materials",
    items: [
      layer("sphere", [0.22, 0, 0, 0], { position: [-0.7, -0.22, -0.3] as V3, material: mat([0.86, 0.22, 0.2], 0.25, 0) }),
      layer("torus", [0.2, 0.07, 0, 0], { position: [0, -0.25, -0.35] as V3, rotation: [70, 0, 0] as V3, material: mat([1, 0.78, 0.34], 0.2, 1) }),
      layer("capsule", [0.08, 0.15, 0, 0], { position: [0.7, -0.25, -0.3] as V3, material: mat([0.25, 0.85, 1], 0.4, 0, 2.5) }),
      group(
        [
          layer("box", [0.18, 0.18, 0.18, 0], { material: mat([0.2, 0.35, 0.95], 0.4, 0) }),
          layer("sphere", [0.2, 0, 0, 0], { position: [0.25, -0.1, 0] as V3, op: "sUnion", smoothK: 0.2, material: mat([1, 0.85, 0.1], 0.4, 0) }),
        ],
        { position: [-0.45, -0.22, 0.4] as V3 },
      ),
      group(
        [
          layer("box", [0.2, 0.2, 0.2, 0], { material: mat([0.86, 0.22, 0.2], 0.5, 0) }),
          layer("sphere", [0.25, 0, 0, 0], { position: [0.12, -0.12, -0.12] as V3, op: "subtract", material: mat([0.1, 0.9, 0.2], 0.5, 0) }),
        ],
        { position: [0.45, -0.22, 0.4] as V3, rotation: [0, 30, 0] as V3 },
      ),
    ],
  };
}
