/**
 * Example scenes: each shows off a few features at their best (look,
 * camera, motion), built in code so they stay valid as the schema grows.
 * Loading one is a normal, undoable scene change.
 */
import {
  defaultParams,
  useSceneStore,
  validateRoot,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type SceneRoot,
  type ShapeLayer,
  type ShapeType,
} from "../store/sceneStore";
import type { Material } from "../store/material";
import type { Track } from "../store/animation";
import type { Reaction } from "../store/interaction";
import type { Modifier } from "../store/modifiers";
import { useRenderStore, type RenderMode } from "../store/renderStore";
import { requestView, type ViewState } from "../store/viewStore";
import { useTimelineStore } from "../store/timelineStore";
import { bakeText, DEFAULT_TEXT, type TextSpec } from "../utils/textSdf";
import { roundStroke } from "../sdf/stroke";
import { showToast } from "../utils/toast";

type V3 = [number, number, number];

export interface Example {
  id: string;
  title: string;
  /** One line: what it shows. */
  blurb: string;
  look: RenderMode;
  view: ViewState;
  build: () => Promise<SceneRoot>;
}

const id = () => crypto.randomUUID();

const mat = (color: V3, roughness = 0.4, metalness = 0, emission = 0): Material => ({ color, roughness, metalness, emission });

function layer(
  shapeType: ShapeType,
  name: string,
  opts: {
    params?: [number, number, number, number];
    position?: V3;
    rotation?: V3;
    scale?: V3;
    op?: OpType;
    smoothK?: number;
    material?: Material;
    modifiers?: Modifier[];
    animation?: Track[];
    interaction?: Reaction[];
    extra?: Partial<ShapeLayer>;
  } = {},
): ShapeLayer {
  return {
    kind: "layer",
    id: id(),
    shapeType,
    name,
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
    params: opts.params ?? [...defaultParams(shapeType)],
    op: opts.op ?? "union",
    smoothK: opts.smoothK ?? 0.1,
    ...(opts.material ? { material: opts.material } : {}),
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.animation ? { animation: opts.animation } : {}),
    ...(opts.interaction ? { interaction: opts.interaction } : {}),
    ...opts.extra,
  };
}

function group(
  name: string,
  items: SceneItem[],
  opts: { position?: V3; rotation?: V3; scale?: V3; op?: OpType; smoothK?: number; material?: Material; modifiers?: Modifier[]; animation?: Track[]; interaction?: Reaction[] } = {},
): ObjectGroup {
  return {
    kind: "group",
    id: id(),
    name,
    position: opts.position ?? [0, 0, 0],
    rotation: opts.rotation ?? [0, 0, 0],
    scale: opts.scale ?? [1, 1, 1],
    op: opts.op ?? "union",
    smoothK: opts.smoothK ?? 0.1,
    ...(opts.material ? { material: opts.material } : {}),
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.animation ? { animation: opts.animation } : {}),
    ...(opts.interaction ? { interaction: opts.interaction } : {}),
    items,
  };
}

const root = (name: string, items: SceneItem[]): SceneRoot => ({ id: id(), name, items });

async function textLayer(spec: Partial<TextSpec>, name: string, opts: Parameters<typeof layer>[2] = {}): Promise<ShapeLayer | null> {
  const text = { ...DEFAULT_TEXT, ...spec };
  const sdf = await bakeText(text);
  if (!sdf) return null;
  return layer("image", name, { ...opts, extra: { image: { sdf, text, round: 0.01 } } });
}

/** A line of stroke points (x, y, z, r) along `at`, rounded like painted ones. */
function strokeLine(n: number, at: (t: number) => [number, number, number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(...at(i / (n - 1)));
  return roundStroke(out);
}

const float: Track = { target: "position.y", wave: "sine", amount: 0.06, period: 4, phase: 0 };
const UP_DOWN_VIEW: ViewState = { rotX: 0.35, rotY: 0.45, distance: 2.6 };

export const EXAMPLES: Example[] = [
  {
    id: "clay",
    title: "Clay critter",
    blurb: "Sculpted with the clay brush: strokes, carves, mirror",
    look: "studio",
    view: { rotX: -0.5, rotY: 0.3, distance: 1.7 },
    build: async () => {
      const body = mat([0.86, 0.54, 0.38], 0.55);
      const spiral = strokeLine(70, (t) => {
        const a = t * Math.PI * 4.5;
        const y = -0.12 - t * 0.3;
        const r = 0.32 * (1 - t * 0.75);
        return [Math.cos(a) * r, y - 0.18, Math.sin(a) * r + 0.02, 0.055 * (1 - t * 0.6)];
      });
      const ear = (side: number) => strokeLine(12, (t) => [side * (0.12 + t * 0.1), -0.3 - t * 0.12, -0.05 + t * 0.02, 0.06 - t * 0.02]);
      const mouth = strokeLine(14, (t) => [(t - 0.5) * 0.18, 0.02 + Math.sin(t * Math.PI) * 0.04, -0.37, 0.018]);
      const eye = (x: number) => layer("sphere", "Eye", { params: [0.055, 0, 0, 0], position: [x, -0.08, -0.32], material: mat([0.06, 0.06, 0.08], 0.15) });
      return root("Clay critter", [
        group("Critter", [
          layer("sphere", "Body", { params: [0.38, 0, 0, 0], material: body }),
          layer("stroke", "Body · clay", { op: "sUnion", smoothK: 0.05, material: body, extra: { stroke: { points: spiral } } }),
          layer("stroke", "Body · clay", { op: "sUnion", smoothK: 0.04, material: body, modifiers: [{ kind: "mirror", axes: [true, false, false] }], extra: { stroke: { points: ear(1) } } }),
          layer("stroke", "Body · carve", { op: "sSubtract", smoothK: 0.02, extra: { stroke: { points: mouth } } }),
          eye(-0.12),
          eye(0.12),
        ], { animation: [float] }),
      ]);
    },
  },
  {
    id: "neon",
    title: "Neon sign",
    blurb: "Text to 3D, glowing materials, the Neon look",
    look: "neon",
    view: { rotX: 0, rotY: 0.08, distance: 2.4 },
    build: async () => {
      const words = await textLayer({ content: "open\nlate", font: "rounded", weight: 700 }, "open late", {
        params: [0.62, 0.035, 0.012, 0],
        material: mat([1, 0.25, 0.55], 0.3, 0, 1.2),
        animation: [{ target: "emission", wave: "noise", amount: 0.5, period: 0.35, phase: 0 }],
      });
      const frame = layer("boxFrame", "Frame", { params: [0.78, 0.55, 0.03, 0.018], material: mat([0.2, 0.8, 1], 0.3, 0, 1) });
      return root("Neon sign", [frame, ...(words ? [words] : [])]);
    },
  },
  {
    id: "cloud",
    title: "Cumulus",
    blurb: "Smooth unions rendered as a volume, drifting",
    look: "volume",
    view: { rotX: 0.25, rotY: 0.2, distance: 2.7 },
    build: async () => {
      const white = mat([0.96, 0.96, 0.98], 0.6);
      const puff = (x: number, y: number, z: number, r: number, phase: number) =>
        layer("sphere", "Puff", {
          params: [r, 0, 0, 0],
          position: [x, y, z],
          op: "sUnion",
          smoothK: 0.18,
          animation: [{ target: "scale", wave: "sine", amount: 0.06, period: 5, phase }],
        });
      return root("Cumulus", [
        group(
          "Cloud",
          [
            puff(0, 0, 0, 0.38, 0),
            puff(-0.42, 0.1, 0.05, 0.28, 0.2),
            puff(0.44, 0.08, -0.02, 0.3, 0.45),
            puff(0.12, -0.24, 0.08, 0.27, 0.7),
            puff(-0.18, -0.16, -0.1, 0.24, 0.9),
            puff(0.75, 0.16, 0.06, 0.18, 0.3),
            puff(-0.72, 0.18, -0.04, 0.17, 0.6),
          ],
          { material: white, animation: [{ target: "position.x", wave: "sine", amount: 0.05, period: 8, phase: 0 }] },
        ),
      ]);
    },
  },
  {
    id: "island",
    title: "Floating island",
    blurb: "Terrain hills, a noise-roughened rock, a slow float",
    look: "studio",
    view: { rotX: 0.6, rotY: 0.55, distance: 2.9 },
    build: async () => {
      const grass = mat([0.42, 0.68, 0.32], 0.8);
      const rock = mat([0.48, 0.42, 0.38], 0.9);
      const tree = (x: number, z: number, h: number) =>
        group("Tree", [
          layer("cylinder", "Trunk", { params: [0.025, 0.08, 0, 0], position: [0, -0.08, 0], material: mat([0.4, 0.27, 0.16], 0.8) }),
          layer("cone", "Crown", { params: [0.11, 0.22 * h, 0, 0], position: [0, -0.32 * h, 0], rotation: [180, 0, 0], material: mat([0.2, 0.5, 0.28], 0.7) }),
        ], { position: [x, -0.1, z] });
      return root("Floating island", [
        group(
          "Island",
          [
            // Round hills: a terrain tile cut by a cylinder.
            group("Ground", [
              layer("terrain", "Hills", { params: [0.7, 0.16, 2.2, 7], material: grass }),
              layer("cylinder", "Rim", { params: [0.58, 0.5, 0, 0], op: "intersect", smoothK: 0.03 }),
            ]),
            // Rock: the lower half of a squashed ball, roughened ("up" is −Y).
            group(
              "Rock",
              [
                layer("sphere", "Mass", { params: [0.6, 0, 0, 0], scale: [1, 0.85, 1], position: [0, 0.02, 0] }),
                layer("box", "Cut", { params: [0.8, 0.5, 0.8, 0], position: [0, 0.5, 0], op: "intersect" }),
              ],
              { op: "sUnion", smoothK: 0.04, material: rock, modifiers: [{ kind: "noise", amplitude: 0.045, scale: 5, octaves: 4, seed: 3 }] },
            ),
            tree(-0.25, 0.1, 1),
            tree(0.18, -0.2, 0.8),
            tree(0.3, 0.2, 1.15),
          ],
          { position: [0, -0.2, 0], animation: [float, { target: "rotation.y", wave: "linear", amount: 360, period: 40, phase: 0 }] },
        ),
      ]);
    },
  },
  {
    id: "button",
    title: "Press me",
    blurb: "Hover and click reactions — press Try, then export",
    look: "studio",
    view: { rotX: 0.15, rotY: 0.55, distance: 1.8 },
    build: async () => {
      const label = await textLayer({ content: "press", font: "inter", weight: 800 }, "press", {
        params: [0.32, 0.03, 0.005, 0],
        position: [0, -0.175, 0.01],
        rotation: [-90, 0, 0],
        material: mat([1, 1, 1], 0.3, 0, 0.3),
      });
      return root("Press me", [
        group(
          "Button",
          [
            layer("roundedBox", "Cap", {
              params: [0.42, 0.08, 0.2, 0.08],
              material: mat([0.35, 0.4, 1], 0.25),
              interaction: [{ trigger: "hover", target: "emission", amount: 0.6 }],
            }),
            ...(label ? [label] : []),
          ],
          {
            interaction: [
              { trigger: "hover", target: "position.y", amount: -0.05 },
              { trigger: "click", target: "rotation.x", amount: 180 },
              { trigger: "pointerX", target: "rotation.z", amount: -8 },
            ],
          },
        ),
        layer("cylinder", "Base", { params: [0.6, 0.03, 0, 0], position: [0, 0.14, 0], material: mat([0.13, 0.13, 0.15], 0.5) }),
      ]);
    },
  },
  {
    id: "lamp",
    title: "Gyroid lamp",
    blurb: "A gyroid shell around a glowing core, slowly turning",
    look: "studio",
    view: { ...UP_DOWN_VIEW, distance: 2.1 },
    build: async () => {
      return root("Gyroid lamp", [
        group(
          "Lamp",
          [
            layer("sphere", "Shell", { params: [0.45, 0, 0, 0], material: mat([0.9, 0.86, 0.8], 0.35, 0.2) }),
            layer("sphere", "Hollow", { params: [0.42, 0, 0, 0], op: "subtract" }),
            layer("gyroid", "Lattice", { params: [0.5, 0.18, 0.025, 0], op: "intersect", smoothK: 0.02 }),
          ],
          { animation: [{ target: "rotation.y", wave: "linear", amount: 360, period: 24, phase: 0 }] },
        ),
        layer("sphere", "Core", {
          params: [0.2, 0, 0, 0],
          material: mat([1, 0.75, 0.4], 0.5, 0, 2.2),
          animation: [{ target: "emission", wave: "sine", amount: 0.5, period: 3, phase: 0 }],
        }),
        layer("cylinder", "Stand", { params: [0.04, 0.3, 0, 0], position: [0, 0.75, 0], material: mat([0.15, 0.15, 0.16], 0.3, 1) }),
      ]);
    },
  },
];

/** Replaces the scene with `example` (one undo step), its look and its camera. */
export async function loadExample(example: Example): Promise<boolean> {
  const next = await example.build();
  if (validateRoot(next)) {
    showToast("This example does not fit");
    return false;
  }
  const had = useSceneStore.getState().root.items.length > 0;
  useSceneStore.setState({
    root: next,
    selectedContainerId: next.id,
    selectedItemId: null,
    selectedIds: [],
    rootSelected: false,
  });
  useRenderStore.getState().setRenderMode(example.look);
  useTimelineStore.getState().seek(0);
  useTimelineStore.getState().play();
  requestView(example.view);
  if (had) showToast(`Loaded “${example.title}” — ${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Z brings your scene back`);
  return true;
}
