/**
 * Sculpting: where a brush stroke goes in the scene and how its points get
 * there. Pure functions over the scene tree (the renderer feeds them picks).
 *
 * - On a shape: the shape becomes an object (group) holding it and its
 *   strokes; the group takes the shape's position and rotation, so strokes
 *   live in the shape's frame (X symmetry mirrors across the shape, moving
 *   the object moves the sculpt) and carving only cuts that object.
 * - Strokes append to the object's last stroke layer while the brush mode
 *   stays the same (and it has room); switching Clay ↔ Carve starts a new
 *   layer, so later clay can refill earlier carves.
 * - In empty space (Clay only): strokes go to the given container.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  findItem,
  getAncestorGroups,
  type ObjectGroup,
  type SceneItem,
  type SceneRoot,
  type ShapeLayer,
} from "../store/sceneStore";
import { DEFAULT_MATERIAL, type Material } from "../store/material";
import { MAX_STROKE_POINTS, appendLine, roundStroke, simplifyLine, strokeCount } from "../sdf/stroke";
import { worldToItemLocalPosition } from "../gpu/gizmo";
import type { Modifier } from "../store/modifiers";

export type BrushMode = "clay" | "carve";

export interface BrushState {
  active: boolean;
  mode: BrushMode;
  /** World units. */
  radius: number;
  /** Smooth-union / -subtract k of new stroke layers. */
  smooth: number;
  /** Mirror across the object's X axis. */
  symmetry: boolean;
  setActive: (active: boolean) => void;
  set: (patch: Partial<Omit<BrushState, "active" | "set" | "setActive">>) => void;
}

export const MIN_BRUSH_RADIUS = 0.005;
export const MAX_BRUSH_RADIUS = 1;

export const useBrushStore = create<BrushState>()(
  persist(
    (set) => ({
      active: false,
      mode: "clay",
      radius: 0.05,
      smooth: 0.03,
      symmetry: false,
      setActive: (active) => set({ active }),
      set: (patch) =>
        set((s) => ({
          ...patch,
          radius: Math.min(MAX_BRUSH_RADIUS, Math.max(MIN_BRUSH_RADIUS, patch.radius ?? s.radius)),
          smooth: Math.min(0.5, Math.max(0, patch.smooth ?? s.smooth)),
        })),
    }),
    // The tool itself starts off on every visit; the brush is remembered.
    { name: "d-stance_brush", partialize: ({ mode, radius, smooth, symmetry }) => ({ mode, radius, smooth, symmetry }) },
  ),
);

/** Brush ring overlay: where the cursor is and how big the brush looks there (CSS px). */
export const useBrushCursor = create<{
  x: number;
  y: number;
  r: number;
  visible: boolean;
  move: (x: number, y: number, r: number, visible: boolean) => void;
}>()((set) => ({
  x: 0,
  y: 0,
  r: 0,
  visible: false,
  move: (x, y, r, visible) => set({ x, y, r, visible }),
}));

const mirrorX = (): Modifier => ({ kind: "mirror", axes: [true, false, false] });

const isStroke = (item: SceneItem | undefined): item is ShapeLayer => item?.kind === "layer" && item.shapeType === "stroke";
const hasMirror = (item: SceneItem) => (item.modifiers ?? []).some((m) => m.kind === "mirror" && !m.off);
const opFor = (mode: BrushMode) => (mode === "clay" ? "sUnion" : "sSubtract");

/** What the shape renders with: its own material, else the nearest ancestor group's. */
function renderedMaterial(root: SceneRoot, item: SceneItem): Material {
  if (item.material) return item.material;
  const found = findItem(root, item.id);
  const ancestors = found ? getAncestorGroups(root, found.container.id) : [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const m = ancestors[i].material;
    if (m) return m;
  }
  return DEFAULT_MATERIAL;
}

function mapItems(items: SceneItem[], containerId: string, rootId: string, map: (items: SceneItem[]) => SceneItem[]): SceneItem[] {
  if (containerId === rootId) return map(items);
  return items.map((it) => (it.kind === "group" ? { ...it, items: it.id === containerId ? map(it.items) : mapItems(it.items, containerId, rootId, map) } : it));
}

function replaceContainerItems(root: SceneRoot, containerId: string, map: (items: SceneItem[]) => SceneItem[]): SceneRoot {
  return { ...root, items: mapItems(root.items, containerId, root.id, map) };
}

export interface StrokePlan {
  /** The scene with the target wrapped and the stroke layer in place (no points yet if new). */
  root: SceneRoot;
  containerId: string;
  layerId: string;
  /** Points the layer had before this stroke. */
  before: number[];
  /** World → container-local position. */
  toLocal: (p: readonly [number, number, number]) => [number, number, number];
  /** World length → local length (ancestor scales). */
  localScale: number;
}

/**
 * Prepares a stroke that starts on `hitLayerId` (or in empty space, null).
 * Null when nothing should happen (carving air, a full layer that cannot grow).
 */
export function planStroke(
  root: SceneRoot,
  hitLayerId: string | null,
  brush: Pick<BrushState, "mode" | "smooth" | "symmetry">,
  fallbackContainerId: string,
  newId: () => string,
): StrokePlan | null {
  let next = root;
  let containerId: string;
  let name = "Stroke";
  let material: Material | undefined;

  if (hitLayerId) {
    const hit = findItem(root, hitLayerId);
    if (!hit) return null;
    // A stroke stands for the shape it was sculpted on: the first non-stroke before it.
    let index = hit.index;
    while (index > 0 && isStroke(hit.container.items[index])) index--;
    const base = hit.container.items[index];
    if (isStroke(base)) {
      // Strokes all the way down (sculpted from scratch): keep painting there.
      containerId = hit.container.id;
    } else {
      const container = hit.container;
      const ready =
        container.id !== root.id &&
        index === 0 &&
        container.items.slice(1).every(isStroke);
      if (ready) {
        containerId = container.id;
      } else {
        // Wrap: the object takes the shape's place, position and rotation.
        const group: ObjectGroup = {
          kind: "group",
          id: newId(),
          name: base.name,
          position: [...base.position],
          rotation: [...base.rotation],
          scale: [1, 1, 1],
          op: base.op,
          smoothK: base.smoothK,
          items: [{ ...base, position: [0, 0, 0], rotation: [0, 0, 0], op: "union" } as SceneItem],
        };
        next = replaceContainerItems(next, container.id, (items) => items.map((it) => (it.id === base.id ? group : it)));
        containerId = group.id;
      }
      name = base.name;
      if (brush.mode === "clay") material = renderedMaterial(root, base);
    }
  } else {
    if (brush.mode === "carve") return null;
    containerId = fallbackContainerId;
  }

  const container = containerId === next.id ? next : (findItem(next, containerId)?.item as ObjectGroup | undefined);
  if (!container) return null;
  const items = containerId === next.id ? next.items : (container as ObjectGroup).items;
  const last = items[items.length - 1];
  const op = hitLayerId ? opFor(brush.mode) : "union";
  let layerId: string;
  let before: number[] = [];
  if (
    isStroke(last) &&
    // The first item's op does not combine with anything.
    (items.length === 1 || last.op === op) &&
    hasMirror(last) === brush.symmetry &&
    strokeCount(last.stroke) < MAX_STROKE_POINTS * 0.8
  ) {
    layerId = last.id;
    before = last.stroke?.points ?? [];
  } else {
    const layer: ShapeLayer = {
      kind: "layer",
      id: newId(),
      shapeType: "stroke",
      name: hitLayerId ? `${name} · ${brush.mode}` : "Stroke",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      params: [1, 0, 0, 0],
      op,
      smoothK: brush.smooth,
      ...(material ? { material: { ...material } } : {}),
      ...(brush.symmetry ? { modifiers: [mirrorX()] } : {}),
    };
    next = replaceContainerItems(next, containerId, (its) => [...its, layer]);
    layerId = layer.id;
  }

  const ancestors = getAncestorGroups(next, containerId);
  let localScale = 1;
  for (const g of ancestors) localScale /= (Math.abs(g.scale[0]) + Math.abs(g.scale[1]) + Math.abs(g.scale[2])) / 3;
  return {
    root: next,
    containerId,
    layerId,
    before,
    toLocal: (p) => worldToItemLocalPosition([p[0], p[1], p[2]], ancestors) as [number, number, number],
    localScale,
  };
}

/** The scene with the stroke layer holding `before` plus `line` (local points). */
export function withStrokeLine(root: SceneRoot, plan: Pick<StrokePlan, "containerId" | "layerId" | "before">, line: readonly number[]): SceneRoot | null {
  const stroke = appendLine(plan.before.length > 0 ? { points: plan.before } : undefined, line);
  if (!stroke) return null;
  return replaceContainerItems(root, plan.containerId, (items) =>
    items.map((it) => (it.id === plan.layerId && it.kind === "layer" ? { ...it, stroke } : it)),
  );
}

/**
 * The finished line: simplified (keeps the shape within a tenth of the
 * radius), ends tapered so clay blends in, rounded for short links.
 */
export function finishLine(line: readonly number[], radius: number): number[] {
  const simple = simplifyLine(line, radius * 0.1);
  const n = simple.length / 4;
  if (n >= 3) {
    const taper = Math.min(3, Math.floor(n / 2));
    for (let i = 0; i < taper; i++) {
      const k = 0.45 + 0.55 * ((i + 1) / (taper + 1));
      simple[i * 4 + 3] *= k;
      simple[(n - 1 - i) * 4 + 3] *= k;
    }
  }
  return roundStroke(simple);
}

/** Id of the temporary layer that shows a stroke while it is being painted. */
export const PREVIEW_STROKE_ID = "sculpt-preview";

/**
 * The scene while painting: the plan's scene plus a preview layer (same
 * settings as the stroke's layer) holding just this stroke's line, right
 * after that layer. The depth pick skips it, so a stroke never climbs onto
 * itself; the end merges the line into the real layer (withStrokeLine).
 */
export function withPreviewLine(plan: Pick<StrokePlan, "root" | "containerId" | "layerId">, line: readonly number[]): SceneRoot {
  if (line.length < 4) return plan.root;
  return replaceContainerItems(plan.root, plan.containerId, (items) => {
    const at = items.findIndex((it) => it.id === plan.layerId);
    const layer = items[at] as ShapeLayer;
    const preview: ShapeLayer = { ...layer, id: PREVIEW_STROKE_ID, name: `${layer.name} (painting)`, stroke: { points: [...line] } };
    // A brand-new layer has no points yet: the preview stands in for it.
    const empty = strokeCount(layer.stroke) === 0;
    return empty ? items.map((it, i) => (i === at ? { ...preview, op: layer.op } : it)) : [...items.slice(0, at + 1), preview, ...items.slice(at + 1)];
  });
}
