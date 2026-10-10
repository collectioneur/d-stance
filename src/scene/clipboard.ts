import {
  cloneWithNewIds,
  countInstructions,
  findItem,
  MAX_IMAGES,
  useSceneStore,
  type InsertRejectReason,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type ShapeLayer,
  type SceneRoot,
} from "../store/sceneStore";
import { showToast } from "../utils/toast";

/**
 * In-memory object clipboard. Holds snapshots, not ids, so editing or deleting
 * the originals after Cmd+C does not change what gets pasted.
 */
let clipItems: SceneItem[] = [];
/**
 * Items that count as "the copied thing" when placing a paste: the originals,
 * then the result of the last paste. Selecting one of them pastes next to it
 * instead of inside it, so repeated Cmd+V on a group lines copies up.
 */
let clipSourceIds: string[] = [];
/**
 * Text written to the system clipboard on copy. Paste uses clipItems only while
 * this text is still there — anything copied later (text, an image) wins.
 */
let clipToken: string | null = null;

const REJECT_MESSAGE: Record<InsertRejectReason, string> = {
  cap: "Scene too complex (max 256 operations)",
  depth: "Nesting too deep (max 16 levels)",
  images: `Too many images (max ${MAX_IMAGES})`,
  invalid_parent: "Invalid paste target",
};

/** Snapshots the selected item. Returns the text for the system clipboard, or null if nothing to copy. */
export function copySelection(): string | null {
  const { root, selectedItemId } = useSceneStore.getState();
  const found = selectedItemId ? findItem(root, selectedItemId) : null;
  if (!found) return null;

  clipItems = [structuredClone(found.item)];
  clipSourceIds = [found.item.id];
  clipToken = `d-stance: ${found.item.name}`;
  return clipToken;
}

/**
 * Selected shape → after it in its container. Selected group → inside it, at the
 * end (like adding a shape), unless that group is what was copied → after it.
 * Nothing / root selected → end of root.
 */
function pasteTarget(
  root: SceneRoot,
  selectedItemId: string | null,
): { containerId: string; index: number } {
  const found = selectedItemId ? findItem(root, selectedItemId) : null;
  if (!found) return { containerId: root.id, index: root.items.length };
  if (found.item.kind === "group" && !clipSourceIds.includes(found.item.id)) {
    return { containerId: found.item.id, index: found.item.items.length };
  }
  return { containerId: found.container.id, index: found.index + 1 };
}

/**
 * Pastes the clipboard if `systemText` is still our copy token.
 * Returns true when the paste was ours to handle (even if a cap rejected it).
 */
export function pasteObjects(systemText: string | undefined): boolean {
  if (clipItems.length === 0 || systemText !== clipToken) return false;

  const state = useSceneStore.getState();
  const items = clipItems.map(cloneWithNewIds);
  const { containerId, index } = pasteTarget(state.root, state.selectedItemId);
  const reason = state.insertItems(containerId, index, items);
  if (reason) {
    showToast(REJECT_MESSAGE[reason]);
    return true;
  }
  clipSourceIds = items.map((item) => item.id);
  return true;
}

/** Cmd+D: copy of the selected item right after it. Leaves the clipboard alone. */
export function duplicateSelection(): void {
  const state = useSceneStore.getState();
  const found = state.selectedItemId ? findItem(state.root, state.selectedItemId) : null;
  if (!found) return;

  const reason = state.insertItems(found.container.id, found.index + 1, [
    cloneWithNewIds(found.item),
  ]);
  if (reason) showToast(REJECT_MESSAGE[reason]);
}

/** Clone must get fresh ids on every node and pack to the same instruction count. */
function assertCloneParity(): void {
  const layer = (id: string, op: OpType): ShapeLayer => ({
    kind: "layer",
    id,
    shapeType: "sphere",
    name: id,
    position: [1, 2, 3],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    params: [0.5, 0, 0, 0],
    op,
    smoothK: 0.1,
  });
  const tree: ObjectGroup = {
    kind: "group",
    id: "g",
    name: "g",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    op: "union",
    smoothK: 0.1,
    items: [layer("a", "union"), layer("b", "subtract")],
  };
  const copy = cloneWithNewIds(tree) as ObjectGroup;

  const ids = (it: SceneItem): string[] =>
    it.kind === "group" ? [it.id, ...it.items.flatMap(ids)] : [it.id];
  const before = new Set(ids(tree));
  if (ids(copy).some((id) => before.has(id))) {
    throw new Error("cloneWithNewIds: id reused");
  }
  if (countInstructions([copy]) !== countInstructions([tree])) {
    throw new Error("cloneWithNewIds: instruction count drift");
  }
  if (copy.items[0].position === tree.items[0].position) {
    throw new Error("cloneWithNewIds: shallow copy");
  }
}

assertCloneParity();
