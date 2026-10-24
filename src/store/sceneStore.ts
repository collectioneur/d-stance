import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { temporal } from "zundo";
import { applyMoveToRoot } from "../scene/arboristAdapter";
import { loadInitialState } from "./persistence";
import { showToast } from "../utils/toast";

export type ShapeType =
  | "sphere"
  | "box"
  | "torus"
  | "cylinder"
  | "capsule"
  | "cone"
  | "roundedBox"
  | "boxFrame"
  | "cappedTorus"
  | "link"
  | "hexPrism"
  | "triPrism"
  | "roundedCylinder"
  | "roundCone"
  | "solidAngle"
  | "cutSphere"
  | "cutHollowSphere"
  | "deathStar"
  | "rhombus"
  | "octahedron"
  | "pyramid"
  | "vesica"
  | "image";
export type OpType = "union" | "subtract" | "intersect" | "sUnion" | "sSubtract" | "sIntersect";

import type { Material } from "./material";
import type { Modifier } from "./modifiers";
export type { Material } from "./material";
export type { Modifier } from "./modifiers";

export type ShapeLayer = {
  kind: "layer";
  id: string;
  shapeType: ShapeType;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ in degrees
  scale: [number, number, number]; // local scale applied after own rotation
  params: [number, number, number, number];
  op: OpType; // ignored when index 0 in parent items
  smoothK: number;
  /**
   * Only for shapeType "image": baked 2D SDF as a PNG data URL (see
   * utils/imageSdf.ts) and the edge rounding radius (local units, ≥ 0).
   */
  image?: { sdf: string; round?: number };
  material?: Material;
  /** Domain / distance modifiers in the shape's own space (src/store/modifiers.ts). */
  modifiers?: Modifier[];
};

export type ObjectGroup = {
  kind: "group";
  id: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number]; // Euler XYZ in degrees
  scale: [number, number, number];
  op: OpType;
  smoothK: number;
  /** Default for descendant shapes that have no material of their own. */
  material?: Material;
  /** Domain / distance modifiers applied in the group's frame to all children. */
  modifiers?: Modifier[];
  items: SceneItem[];
};

export type SceneItem = ShapeLayer | ObjectGroup;

export type SceneRoot = {
  id: string;
  name: string;
  items: SceneItem[];
};

export type SceneContainer = SceneRoot | ObjectGroup;

/**
 * Scene size budget, counted by `countInstructions` (shapes plus the CSG ops
 * joining them). Keeps the compiled shader's size, compile time and data
 * slots (sceneCompiler.ts DATA_SLOTS) in a range that stays interactive.
 */
export const MAX_INSTRUCTIONS = 256;
export const UNDO_LIMIT = 100;
/** Max nested group depth (UI and drag-and-drop limit). */
export const MAX_TRANSFORM_DEPTH = 16;
/** Distinct image SDF textures per scene (layers of the GPU texture array). */
export const MAX_IMAGES = 8;
/** Upper bound for `image.round` (inspector slider range). */
export const IMAGE_ROUND_MAX = 10;

const DEFAULT_PARAMS: Record<ShapeType, [number, number, number, number]> = {
  sphere: [0.5, 0, 0, 0],
  box: [0.4, 0.4, 0.4, 0],
  torus: [0.4, 0.15, 0, 0],
  cylinder: [0.3, 0.5, 0, 0],
  capsule: [0.25, 0.4, 0, 0],
  cone: [0.4, 0.6, 0, 0],
  roundedBox: [0.35, 0.35, 0.35, 0.1],
  boxFrame: [0.4, 0.4, 0.4, 0.05],
  cappedTorus: [0.4, 0.15, 120, 0], // R, r, aperture in degrees
  link: [0.25, 0.3, 0.1, 0], // half length, major R, minor r
  hexPrism: [0.4, 0.4, 0, 0],
  triPrism: [0.4, 0.4, 0, 0],
  roundedCylinder: [0.3, 0.1, 0.4, 0],
  roundCone: [0.35, 0.15, 0.7, 0], // bottom r, top r, height
  solidAngle: [45, 0.5, 0, 0], // aperture in degrees, radius
  cutSphere: [0.5, 0.2, 0, 0], // radius, cut height
  cutHollowSphere: [0.5, 0.2, 0.03, 0], // radius, cut height, thickness
  deathStar: [0.5, 0.35, 0.5, 0], // sphere R, carved R, offset
  rhombus: [0.5, 0.3, 0.1, 0.02], // half diag a, half diag b, half height, corner r
  octahedron: [0.5, 0, 0, 0],
  pyramid: [0.7, 0.7, 0, 0], // base width, height
  vesica: [0.5, 0.25, 0, 0], // radius, offset
  image: [0.5, 0.1, 0, 0], // half size, half thickness, bold, invert (0/1)
};

const TYPE_LABEL: Record<ShapeType, string> = {
  sphere: "Sphere",
  box: "Box",
  torus: "Torus",
  cylinder: "Cylinder",
  capsule: "Capsule",
  cone: "Cone",
  roundedBox: "Rounded Box",
  boxFrame: "Box Frame",
  cappedTorus: "Capped Torus",
  link: "Link",
  hexPrism: "Hex Prism",
  triPrism: "Tri Prism",
  roundedCylinder: "Rounded Cylinder",
  roundCone: "Round Cone",
  solidAngle: "Solid Angle",
  cutSphere: "Cut Sphere",
  cutHollowSphere: "Cut Hollow Sphere",
  deathStar: "Death Star",
  rhombus: "Rhombus",
  octahedron: "Octahedron",
  pyramid: "Pyramid",
  vesica: "Vesica",
  image: "Image",
};

export const ALL_SHAPE_TYPES = Object.keys(TYPE_LABEL) as ShapeType[];

/** Default params for a new shape of this type (also the inspector's reset value). */
export function defaultParams(type: ShapeType): readonly [number, number, number, number] {
  return DEFAULT_PARAMS[type];
}

export function shapeLabel(type: ShapeType): string {
  return TYPE_LABEL[type];
}

export function zeroCounters(): Record<ShapeType, number> {
  return Object.fromEntries(ALL_SHAPE_TYPES.map((t) => [t, 0])) as Record<
    ShapeType,
    number
  >;
}

export function createDefaultRoot(): SceneRoot {
  return {
    id: crypto.randomUUID(),
    name: "Scene",
    items: [],
  };
}

export function countInstructions(items: SceneItem[]): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "layer") {
      count += 1;
      if (i > 0) count += 1;
    } else {
      if (item.items.length > 0) count += 2 + countInstructions(item.items);
      if (i > 0) count += 1;
    }
  }
  return count;
}

export function wouldExceedCap(root: SceneRoot, extra: number): boolean {
  return countInstructions(root.items) + extra > MAX_INSTRUCTIONS;
}

/** Distinct baked image SDFs in the tree (duplicates share one GPU slot). */
export function collectImageSdfs(items: SceneItem[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.kind === "layer") {
      if (item.image) out.add(item.image.sdf);
    } else {
      collectImageSdfs(item.items, out);
    }
  }
  return out;
}

export function wouldExceedImages(root: SceneRoot, sdf: string): boolean {
  const used = collectImageSdfs(root.items);
  return !used.has(sdf) && used.size >= MAX_IMAGES;
}

export type ItemTransformPatch = Partial<Pick<ShapeLayer, "position" | "rotation" | "scale">>;

export type InsertRejectReason = "cap" | "depth" | "images" | "invalid_parent";

/** Caps checked on a finished tree — simpler than predicting each edit's delta. */
export function validateRoot(root: SceneRoot): InsertRejectReason | null {
  if (countInstructions(root.items) > MAX_INSTRUCTIONS) return "cap";
  if (maxGroupDepth(root.items) > MAX_TRANSFORM_DEPTH) return "depth";
  if (collectImageSdfs(root.items).size > MAX_IMAGES) return "images";
  return null;
}

/**
 * Selected ids an operation should act on, in tree order: an item whose
 * ancestor is also selected is dropped (it moves, copies, dies with the ancestor).
 */
export function topLevelSelection(root: SceneRoot, ids: readonly string[]): string[] {
  const want = new Set(ids);
  const out: string[] = [];
  const walk = (items: SceneItem[]) => {
    for (const item of items) {
      if (want.has(item.id)) out.push(item.id);
      else if (item.kind === "group") walk(item.items);
    }
  };
  walk(root.items);
  return out;
}

/** Deep copy with a fresh id on every node, so the copy never aliases its source. */
export function cloneWithNewIds(item: SceneItem): SceneItem {
  const copy = structuredClone(item);
  const reId = (it: SceneItem) => {
    it.id = crypto.randomUUID();
    if (it.kind === "group") it.items.forEach(reId);
  };
  reId(copy);
  return copy;
}

function isObjectGroup(container: SceneContainer): container is ObjectGroup {
  return (container as ObjectGroup).kind === "group";
}

function extraInstructionsForNewShape(container: SceneContainer): number {
  if (isObjectGroup(container) && container.items.length === 0) {
    return 3;
  }
  return container.items.length === 0 ? 1 : 2;
}

function extraInstructionsForNewGroup(container: SceneContainer): number {
  return container.items.length === 0 ? 0 : 1;
}

function getContainerDepthInItems(
  items: SceneItem[],
  containerId: string,
  depth: number,
): number {
  for (const item of items) {
    if (item.kind === "group") {
      if (item.id === containerId) return depth + 1;
      const found = getContainerDepthInItems(item.items, containerId, depth + 1);
      if (found >= 0) return found;
    }
  }
  return -1;
}

export function getContainerDepth(root: SceneRoot, containerId: string): number {
  if (root.id === containerId) return 0;
  return getContainerDepthInItems(root.items, containerId, 0);
}

export function wouldExceedDepth(root: SceneRoot, containerId: string): boolean {
  const depth = getContainerDepth(root, containerId);
  if (depth < 0) return true;
  return depth + 1 > MAX_TRANSFORM_DEPTH;
}

export function maxGroupDepth(items: SceneItem[], currentDepth = 0): number {
  let max = currentDepth;
  for (const item of items) {
    if (item.kind === "group") {
      max = Math.max(max, maxGroupDepth(item.items, currentDepth + 1));
    }
  }
  return max;
}

export function findContainer(
  root: SceneRoot,
  containerId: string,
): SceneContainer | null {
  if (root.id === containerId) return root;
  for (const item of root.items) {
    if (item.kind === "group") {
      const found = findContainerInGroup(item, containerId);
      if (found) return found;
    }
  }
  return null;
}

function findContainerInGroup(
  group: ObjectGroup,
  containerId: string,
): SceneContainer | null {
  if (group.id === containerId) return group;
  for (const item of group.items) {
    if (item.kind === "group") {
      const found = findContainerInGroup(item, containerId);
      if (found) return found;
    }
  }
  return null;
}

/** Groups from outermost ancestor down to containerId (inclusive when container is a group). */
export function getAncestorGroups(root: SceneRoot, containerId: string): ObjectGroup[] {
  if (root.id === containerId) return [];

  function search(items: SceneItem[], path: ObjectGroup[]): ObjectGroup[] | null {
    for (const item of items) {
      if (item.kind !== "group") continue;
      const nextPath = [...path, item];
      if (item.id === containerId) return nextPath;
      const found = search(item.items, nextPath);
      if (found) return found;
    }
    return null;
  }

  return search(root.items, []) ?? [];
}

export function findItem(
  root: SceneRoot,
  itemId: string,
): { item: SceneItem; container: SceneContainer; index: number } | null {
  return findItemInItems(root.items, root, itemId);
}

function findItemInItems(
  items: SceneItem[],
  container: SceneContainer,
  itemId: string,
): { item: SceneItem; container: SceneContainer; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.id === itemId) {
      return { item, container, index: i };
    }
    if (item.kind === "group") {
      const found = findItemInItems(item.items, item, itemId);
      if (found) return found;
    }
  }
  return null;
}

function mapRootContainer(
  root: SceneRoot,
  containerId: string,
  mapItems: (items: SceneItem[]) => SceneItem[],
): SceneRoot {
  if (root.id === containerId) {
    return { ...root, items: mapItems(root.items) };
  }
  return {
    ...root,
    items: root.items.map((item) =>
      item.kind === "group" ? mapGroupContainer(item, containerId, mapItems) : item,
    ),
  };
}

function mapGroupContainer(
  group: ObjectGroup,
  containerId: string,
  mapItems: (items: SceneItem[]) => SceneItem[],
): ObjectGroup {
  if (group.id === containerId) {
    return { ...group, items: mapItems(group.items) };
  }
  return {
    ...group,
    items: group.items.map((item) =>
      item.kind === "group" ? mapGroupContainer(item, containerId, mapItems) : item,
    ),
  };
}

function mapRootItem(
  root: SceneRoot,
  itemId: string,
  mapItem: (item: SceneItem) => SceneItem,
): SceneRoot {
  return {
    ...root,
    items: root.items.map((item) => mapItemDeep(item, itemId, mapItem)),
  };
}

function mapItemDeep(
  item: SceneItem,
  itemId: string,
  mapItem: (item: SceneItem) => SceneItem,
): SceneItem {
  if (item.id === itemId) {
    return mapItem(item);
  }
  if (item.kind === "group") {
    return {
      ...item,
      items: item.items.map((child) => mapItemDeep(child, itemId, mapItem)),
    };
  }
  return item;
}

/**
 * Selection fields for `ids` with `activeId` as the active item (inspector,
 * gizmo, add target). Drops ids missing from `root`; falls back to the last id.
 */
function selectionPatch(root: SceneRoot, ids: readonly string[], activeId: string | null) {
  const live = ids.filter((id) => findItem(root, id) !== null);
  const active =
    activeId !== null && live.includes(activeId) ? activeId : (live[live.length - 1] ?? null);
  const found = active ? findItem(root, active) : null;
  return {
    selectedIds: found ? live : [],
    selectedItemId: found ? active : null,
    selectedContainerId: found
      ? found.item.kind === "group"
        ? found.item.id
        : found.container.id
      : root.id,
    rootSelected: false,
  };
}

interface SceneState {
  root: SceneRoot;
  selectedContainerId: string;
  /** Active item of the selection (inspector, gizmo); always in `selectedIds`. */
  selectedItemId: string | null;
  /** Whole selection in click order; empty when nothing (or the root) is selected. */
  selectedIds: string[];
  /** True when Scene root is explicitly selected (not deselected). */
  rootSelected: boolean;
  counters: Record<ShapeType, number>;
  groupCounter: number;

  addShapeToContainer: (
    containerId: string,
    shapeType: ShapeType,
    image?: ShapeLayer["image"],
  ) => boolean;
  addGroupToContainer: (containerId: string) => boolean;
  /** Splices ready-made items (fresh ids) into a container and selects the last one. */
  insertItems: (
    containerId: string,
    index: number,
    items: SceneItem[],
  ) => InsertRejectReason | null;
  /** Copies each top-level item of `ids` right after its original; selects the copies. */
  duplicateItems: (ids: string[]) => InsertRejectReason | null;
  removeItem: (containerId: string, itemId: string) => void;
  /** Removes `ids` and everything under them in one undo step. */
  removeItems: (ids: string[]) => void;
  updateLayer: (
    containerId: string,
    layerId: string,
    patch: Partial<
      Pick<
        ShapeLayer,
        "name" | "position" | "rotation" | "scale" | "params" | "op" | "smoothK" | "image" | "material" | "modifiers"
      >
    >,
  ) => void;
  moveItems: (dragIds: string[], parentId: string | null, index: number) => boolean;
  renameItem: (itemId: string, name: string) => void;
  updateGroup: (
    groupId: string,
    patch: Partial<
      Pick<ObjectGroup, "name" | "position" | "rotation" | "scale" | "op" | "smoothK" | "material" | "modifiers">
    >,
  ) => void;
  updateRootName: (name: string) => void;
  /** Transform edits for several items (layers or groups) in one store update. */
  updateTransforms: (patches: ReadonlyMap<string, ItemTransformPatch>) => void;
  /** Rewrites each item in `ids` with `map` (inspector edits on a multi-selection). */
  updateItems: (ids: readonly string[], map: (item: SceneItem) => SceneItem) => void;
  selectRoot: () => void;
  deselect: () => void;
  selectItem: (containerId: string, itemId: string) => void;
  setSelection: (ids: string[], activeId: string | null) => void;
  /** Cmd/Shift-click on the canvas: add or drop one item. */
  toggleSelected: (itemId: string) => void;
}

const _saved = loadInitialState();
const _initialRoot = _saved.root ?? createDefaultRoot();

export const useSceneStore = create<SceneState>()(
  temporal(
    (set, get) => ({
      root: _initialRoot,
      selectedContainerId: _initialRoot.id,
      selectedItemId: null,
      selectedIds: [],
      rootSelected: false,
      // Merge: scenes saved before new shapes existed lack their counter keys.
      counters: { ...zeroCounters(), ..._saved.counters },
      groupCounter: _saved.groupCounter ?? 0,

      addShapeToContainer: (containerId, shapeType, image) => {
        const state = get();
        const container = findContainer(state.root, containerId);
        if (!container) return false;

        const extra = extraInstructionsForNewShape(container);
        if (wouldExceedCap(state.root, extra)) return false;
        if ((shapeType === "image") !== !!image) return false;
        if (image && wouldExceedImages(state.root, image.sdf)) return false;

        const count = state.counters[shapeType] + 1;
        const newLayer: ShapeLayer = {
          kind: "layer",
          id: crypto.randomUUID(),
          shapeType,
          name: `${TYPE_LABEL[shapeType]} ${count}`,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          params: [...DEFAULT_PARAMS[shapeType]],
          op: "union",
          smoothK: 0.1,
          ...(image ? { image } : {}),
        };

        set({
          root: mapRootContainer(state.root, containerId, (items) => [
            ...items,
            newLayer,
          ]),
          counters: { ...state.counters, [shapeType]: count },
          selectedContainerId: containerId,
          selectedItemId: newLayer.id,
          selectedIds: [newLayer.id],
          rootSelected: false,
        });
        return true;
      },

      addGroupToContainer: (containerId) => {
        const state = get();
        const container = findContainer(state.root, containerId);
        if (!container) return false;

        if (wouldExceedDepth(state.root, containerId)) return false;

        const extra = extraInstructionsForNewGroup(container);
        if (wouldExceedCap(state.root, extra)) return false;

        const count = state.groupCounter + 1;
        const newGroup: ObjectGroup = {
          kind: "group",
          id: crypto.randomUUID(),
          name: `Object ${count}`,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          op: "union",
          smoothK: 0.1,
          items: [],
        };

        set({
          root: mapRootContainer(state.root, containerId, (items) => [
            ...items,
            newGroup,
          ]),
          groupCounter: count,
          selectedContainerId: newGroup.id,
          selectedItemId: newGroup.id,
          selectedIds: [newGroup.id],
          rootSelected: false,
        });
        return true;
      },

      insertItems: (containerId, index, items) => {
        const state = get();
        if (items.length === 0) return null;
        if (!findContainer(state.root, containerId)) return "invalid_parent";

        const newRoot = mapRootContainer(state.root, containerId, (list) => {
          const next = [...list];
          next.splice(index, 0, ...items);
          return next;
        });
        const reason = validateRoot(newRoot);
        if (reason) return reason;

        const ids = items.map((item) => item.id);
        set({ root: newRoot, ...selectionPatch(newRoot, ids, ids[ids.length - 1]) });
        return null;
      },

      duplicateItems: (ids) => {
        const state = get();
        let newRoot = state.root;
        const copyIds: string[] = [];
        let activeCopy: string | null = null;
        for (const id of topLevelSelection(state.root, ids)) {
          const found = findItem(newRoot, id);
          if (!found) continue;
          const copy = cloneWithNewIds(found.item);
          newRoot = mapRootContainer(newRoot, found.container.id, (list) => {
            const next = [...list];
            next.splice(found.index + 1, 0, copy);
            return next;
          });
          copyIds.push(copy.id);
          if (id === state.selectedItemId) activeCopy = copy.id;
        }
        if (copyIds.length === 0) return null;
        const reason = validateRoot(newRoot);
        if (reason) return reason;

        set({ root: newRoot, ...selectionPatch(newRoot, copyIds, activeCopy) });
        return null;
      },

      removeItem: (_containerId, itemId) => get().removeItems([itemId]),

      removeItems: (ids) => {
        const state = get();
        const drop = new Set(ids);
        if (drop.size === 0) return;
        const strip = (items: SceneItem[]): SceneItem[] =>
          items
            .filter((item) => !drop.has(item.id))
            .map((item) => (item.kind === "group" ? { ...item, items: strip(item.items) } : item));
        const newRoot = { ...state.root, items: strip(state.root.items) };

        const patch = selectionPatch(newRoot, state.selectedIds, state.selectedItemId);
        set({
          root: newRoot,
          ...patch,
          // Root selection survives deleting something else (e.g. a row's X button).
          rootSelected: patch.selectedItemId === null && state.rootSelected,
        });
      },

      // Values stored full-precision; rounding is display-only (NumericInput).
      updateLayer: (containerId, layerId, patch) =>
        set((state) => ({
          root: mapRootContainer(state.root, containerId, (items) =>
            items.map((item) =>
              item.kind === "layer" && item.id === layerId ? { ...item, ...patch } : item,
            ),
          ),
        })),

      updateGroup: (groupId, patch) =>
        set((state) => ({
          root: mapRootItem(state.root, groupId, (item) =>
            item.kind === "group" ? { ...item, ...patch } : item,
          ),
        })),

      updateTransforms: (patches) =>
        set((state) => {
          const apply = (items: SceneItem[]): SceneItem[] =>
            items.map((item) => {
              const patch = patches.get(item.id);
              const next = patch ? { ...item, ...patch } : item;
              return next.kind === "group" ? { ...next, items: apply(next.items) } : next;
            });
          return { root: { ...state.root, items: apply(state.root.items) } };
        }),

      updateItems: (ids, map) =>
        set((state) => {
          const want = new Set(ids);
          const apply = (items: SceneItem[]): SceneItem[] =>
            items.map((item) => {
              const next = want.has(item.id) ? map(item) : item;
              return next.kind === "group" ? { ...next, items: apply(next.items) } : next;
            });
          return { root: { ...state.root, items: apply(state.root.items) } };
        }),

      updateRootName: (name) =>
        set((state) => ({
          root: { ...state.root, name },
        })),

      selectRoot: () =>
        set((state) => ({
          selectedContainerId: state.root.id,
          selectedItemId: null,
          selectedIds: [],
          rootSelected: true,
        })),

      deselect: () =>
        set((state) => ({
          selectedContainerId: state.root.id,
          selectedItemId: null,
          selectedIds: [],
          rootSelected: false,
        })),

      selectItem: (_containerId, itemId) =>
        set((state) => {
          if (!findItem(state.root, itemId)) return state;
          return selectionPatch(state.root, [itemId], itemId);
        }),

      setSelection: (ids, activeId) =>
        set((state) => selectionPatch(state.root, ids, activeId)),

      toggleSelected: (itemId) =>
        set((state) => {
          if (!state.selectedIds.includes(itemId)) {
            return selectionPatch(state.root, [...state.selectedIds, itemId], itemId);
          }
          const rest = state.selectedIds.filter((id) => id !== itemId);
          const active = state.selectedItemId === itemId ? null : state.selectedItemId;
          return selectionPatch(state.root, rest, active);
        }),

      moveItems: (dragIds, parentId, index) => {
        const state = get();
        const result = applyMoveToRoot(state.root, dragIds, parentId, index);
        if ("reason" in result) {
          if (result.reason === "cycle") {
            showToast("Cannot move into itself or its children");
          } else if (result.reason === "depth") {
            showToast("Nesting too deep (max 16 levels)");
          } else if (result.reason === "invalid_parent") {
            showToast("Invalid drop target");
          }
          return false;
        }

        const newRoot = result.root;
        // Keep the selection (the container of the active item may have changed);
        // dragging with nothing selected selects what was dragged.
        const selection =
          state.selectedIds.length > 0
            ? selectionPatch(newRoot, state.selectedIds, state.selectedItemId)
            : selectionPatch(newRoot, dragIds, dragIds[0] ?? null);
        set({ root: newRoot, ...selection });
        return true;
      },

      renameItem: (itemId, name) => {
        const state = get();
        const found = findItem(state.root, itemId);
        if (!found) return;

        if (found.item.kind === "layer") {
          set({
            root: mapRootContainer(state.root, found.container.id, (items) =>
              items.map((item) =>
                item.kind === "layer" && item.id === itemId ? { ...item, name } : item,
              ),
            ),
          });
        } else {
          set({
            root: mapRootItem(state.root, itemId, (item) =>
              item.kind === "group" ? { ...item, name } : item,
            ),
          });
        }
      },
    }),
    {
      partialize: (state) => ({
        root: state.root,
        counters: state.counters,
        groupCounter: state.groupCounter,
      }),
      equality: shallow,
      limit: UNDO_LIMIT,
    },
  ),
);

export const temporalStore = useSceneStore.temporal;

if (_saved.root?.items?.length) {
  temporalStore.getState().clear();
}

type HistorySnapshot = Pick<SceneState, "root" | "counters" | "groupCounter">;
let historyPausedAt: HistorySnapshot | null = null;

/**
 * Pause undo tracking for a continuous edit (gizmo drag, typing in a field).
 * zundo records nothing while paused, so `resumeHistory` pushes the state from
 * here as one undo step — otherwise the whole edit would be missing from history.
 */
export function pauseHistory() {
  if (historyPausedAt) return;
  const { root, counters, groupCounter } = useSceneStore.getState();
  historyPausedAt = { root, counters, groupCounter };
  temporalStore.getState().pause();
}

export function resumeHistory() {
  const before = historyPausedAt;
  if (!before) return;
  historyPausedAt = null;
  temporalStore.getState().resume();
  if (useSceneStore.getState().root !== before.root) {
    temporalStore.setState((t) => ({
      pastStates: [...t.pastStates, before].slice(-UNDO_LIMIT),
      futureStates: [],
    }));
  }
}

export function undoScene() {
  temporalStore.getState().undo();
  const root = useSceneStore.getState().root;
  useSceneStore.setState({
    selectedContainerId: root.id,
    selectedItemId: null,
    selectedIds: [],
    rootSelected: false,
  });
}

export function redoScene() {
  temporalStore.getState().redo();
  const root = useSceneStore.getState().root;
  useSceneStore.setState({
    selectedContainerId: root.id,
    selectedItemId: null,
    selectedIds: [],
    rootSelected: false,
  });
}
