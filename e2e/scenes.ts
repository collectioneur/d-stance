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
  ["terrain", [0.2, 0.12, 4, 3]],
  ["gyroid", [0.15, 0.12, 0.01, 0]],
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

/** One group per modifier kind, spread on a grid. */
export function modifiersScene() {
  const at = (x: number, z: number) => [x, -0.3, z] as V3;
  return {
    id: "root",
    name: "Modifiers",
    items: [
      group([layer("sphere", [0.09, 0, 0, 0])], {
        position: at(-1, -0.6),
        modifiers: [{ kind: "repeat", spacing: [0.25, 0.25, 0.25], count: [3, 1, 3] }],
      }),
      layer("box", [0.12, 0.3, 0.12, 0], { position: at(0, -0.6), modifiers: [{ kind: "twist", amount: 4, axis: 1 }] }),
      group([layer("capsule", [0.04, 0.12, 0, 0], { position: [0.25, 0, 0] as V3, rotation: [0, 0, 90] as V3 })], {
        position: at(1, -0.6),
        modifiers: [{ kind: "polar", count: 8, axis: 1 }],
      }),
      group([layer("sphere", [0.12, 0, 0, 0], { position: [0.15, 0, 0] as V3 }), layer("box", [0.05, 0.2, 0.05, 0], { position: [0.15, 0, 0] as V3 })], {
        position: at(-1, 0.6),
        modifiers: [{ kind: "mirror", axes: [true, false, false] }],
      }),
      group(
        [
          layer("sphere", [0.25, 0, 0, 0], { modifiers: [{ kind: "onion", thickness: 0.02 }] }),
          layer("box", [0.3, 0.3, 0.3, 0], { position: [0, -0.25, 0] as V3, op: "subtract" }),
        ],
        { position: at(0, 0.6) },
      ),
      layer("cylinder", [0.06, 0.35, 0, 0], { position: at(1, 0.6), rotation: [0, 0, 90] as V3, modifiers: [{ kind: "bend", amount: 2.5, axis: 2 }, { kind: "round", radius: 0.02 }] }),
    ],
  };
}

/** Infinite grid of spheres (repeat count 0) — unbounded scene. */
export function infiniteScene() {
  return {
    id: "root",
    name: "Infinite",
    items: [
      group([layer("sphere", [0.15, 0, 0, 0])], { modifiers: [{ kind: "repeat", spacing: [0.6, 0.6, 0.6], count: [0, 1, 0] }] }),
    ],
  };
}

/** Noise and math surfaces: a terrain tile, a gyroid cube, a rough rock, noisy copies. */
export function noiseScene() {
  return {
    id: "root",
    name: "Noise",
    items: [
      layer("terrain", [0.7, 0.35, 2.2, 7], { position: [-0.3, 0, 0.1] as V3, material: { color: [0.45, 0.62, 0.38], roughness: 0.9, metalness: 0, emission: 0 } }),
      layer("gyroid", [0.22, 0.18, 0.012, 0], { position: [0.75, -0.35, -0.2] as V3, material: { color: [0.9, 0.55, 0.2], roughness: 0.4, metalness: 0, emission: 0 } }),
      layer("sphere", [0.2, 0, 0, 0], {
        position: [0.65, -0.3, 0.45] as V3,
        modifiers: [{ kind: "noise", amplitude: 0.05, scale: 6, octaves: 5, seed: 1 }],
        material: { color: [0.55, 0.52, 0.5], roughness: 0.8, metalness: 0, emission: 0 },
      }),
      group([layer("box", [0.07, 0.07, 0.07, 0.0], { modifiers: [{ kind: "noise", amplitude: 0.02, scale: 12, octaves: 3, seed: 0 }] })], {
        position: [-0.3, -0.75, -0.6] as V3,
        modifiers: [{ kind: "repeat", spacing: [0.22, 0.22, 0.22], count: [5, 1, 1] }],
      }),
    ],
  };
}

/** A little of everything that moves. */
export function animationScene() {
  return {
    id: "root",
    name: "Motion",
    items: [
      layer("box", [0.15, 0.15, 0.15, 0.0], {
        position: [-0.55, -0.3, 0] as V3,
        animation: [{ target: "rotation.y", wave: "linear", amount: 360, period: 4, phase: 0 }],
        material: { color: [0.2, 0.45, 0.95], roughness: 0.4, metalness: 0, emission: 0 },
      }),
      layer("sphere", [0.15, 0, 0, 0], {
        position: [0, -0.3, 0] as V3,
        animation: [{ target: "position.y", wave: "sine", amount: 0.12, period: 2, phase: 0 }],
        material: { color: [0.9, 0.25, 0.2], roughness: 0.3, metalness: 0, emission: 0 },
      }),
      layer("formula", [0.3, 0.5, 0, 0], {
        position: [0.6, -0.1, 0] as V3,
        formula: "y + 0.04*sin(length(x, z)*25 - t*4)",
      }),
      layer("torus", [0.12, 0.04, 0, 0], {
        position: [0, -0.3, 0.55] as V3,
        animation: [
          { target: "scale", wave: "sine", amount: 0.3, period: 1, phase: 0 },
          { target: "position.x", wave: "noise", amount: 0.05, period: 0.7, phase: 0 },
          { target: "emission", wave: "triangle", amount: 0.8, period: 2, phase: 0.5 },
        ],
        material: { color: [0.25, 0.85, 1], roughness: 0.4, metalness: 0, emission: 0.8 },
      }),
    ],
  };
}

/** Hover a sphere (left), click a box (right). Seen from the front at distance 2.5. */
export function interactionScene() {
  return {
    id: "root",
    name: "Reactive",
    items: [
      layer("sphere", [0.4, 0, 0, 0], {
        id: "ix-sphere",
        name: "Ball",
        position: [-0.7, 0, 0] as V3,
        material: { color: [0.9, 0.3, 0.2], roughness: 0.35, metalness: 0, emission: 0 },
        interaction: [
          { trigger: "hover", target: "scale", amount: 0.2 },
          { trigger: "hover", target: "emission", amount: 1.5 },
        ],
      }),
      layer("box", [0.3, 0.3, 0.3, 0], {
        id: "ix-box",
        name: "Crate",
        position: [0.7, 0, 0] as V3,
        material: { color: [0.25, 0.5, 0.95], roughness: 0.4, metalness: 0, emission: 0 },
        interaction: [{ trigger: "click", target: "rotation.z", amount: 45 }],
      }),
    ],
  };
}

/** Stroke points (x, y, z, r) along a curve. */
function strokePoints(n: number, at: (t: number) => [number, number, number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(...at(i / (n - 1)).map((v) => Math.round(v * 1e4) / 1e4));
  return out;
}

/** A ball with a clay spiral wound around it and a carved groove, plus a free stroke. */
export function sculptScene() {
  const spiral = strokePoints(90, (t) => {
    const a = t * Math.PI * 6;
    const y = -0.42 + t * 0.84;
    const rr = Math.sqrt(Math.max(0.0001, 0.42 * 0.42 - y * y)) + 0.02;
    return [Math.cos(a) * rr, y, Math.sin(a) * rr, 0.035 + 0.015 * Math.sin(t * Math.PI)];
  });
  const groove = strokePoints(40, (t) => {
    const a = -0.6 + t * 1.2;
    return [Math.sin(a) * 0.42, 0.05, -Math.cos(a) * 0.42, 0.05];
  });
  const free = strokePoints(60, (t) => [0.75 + 0.25 * Math.sin(t * Math.PI * 2), -0.5 + t * 0.8, 0.1 * Math.cos(t * 9), 0.03 + 0.04 * t]);
  return {
    id: "root",
    name: "Sculpt",
    items: [
      {
        kind: "group",
        id: "ball-sculpt",
        name: "Ball sculpt",
        position: [0, 0, 0] as V3,
        rotation: [0, 0, 0] as V3,
        scale: [1, 1, 1] as V3,
        op: "union",
        smoothK: 0.1,
        items: [
          layer("sphere", [0.4, 0, 0, 0], { id: "ball", name: "Ball", material: { color: [0.85, 0.55, 0.4], roughness: 0.5, metalness: 0, emission: 0 } }),
          layer("stroke", [1, 0, 0, 0], { id: "clay", name: "Ball · clay", op: "sUnion", smoothK: 0.04, stroke: { points: spiral } }),
          layer("stroke", [1, 0, 0, 0], { id: "carve", name: "Ball · carve", op: "sSubtract", smoothK: 0.02, stroke: { points: groove } }),
        ],
      },
      layer("stroke", [1, 0, 0, 0], { id: "free", name: "Stroke", stroke: { points: free } }),
    ],
  };
}
