import type { SceneItem, SceneRoot } from "../store/sceneStore";
import { MIN_SCALE } from "../utils/scale";

/**
 * Appear / vanish animation for scene items. Draw-only: the store, undo and
 * persistence never see it. The packer is handed a copy of the root where
 * animating items are scaled about their own pivot.
 *
 * - Appear (add, paste, duplicate, redo): grow from 0 with a small overshoot.
 * - Vanish (delete, undo of an add): the pre-removal root is drawn for a moment
 *   with the removed items shrinking, so a subtract visibly closes up. Any
 *   further edit cancels it at once (that root is stale by then).
 */
const APPEAR_MS = 320;
const VANISH_MS = 200;
/** Bulk changes (scene load, big undo) just snap. */
const MAX_ANIMATED = 24;
/** Smallest animated factor; scale itself is still clamped to MIN_SCALE. */
const MIN_FACTOR = 0.02;

/** Overshoots ~6% around t≈0.7, then settles on 1. */
export function easeOutBack(t: number): number {
  const c1 = 1.25;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

const easeInCubic = (t: number) => t * t * t;

function collectIds(items: SceneItem[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    out.add(item.id);
    if (item.kind === "group") collectIds(item.items, out);
  }
  return out;
}

/** Ids in `ids` with no ancestor in `ids` (a pasted group animates as one). */
function topLevel(items: SceneItem[], ids: Set<string>, out: string[] = []): string[] {
  for (const item of items) {
    if (ids.has(item.id)) out.push(item.id);
    else if (item.kind === "group") topLevel(item.items, ids, out);
  }
  return out;
}

function findById(items: SceneItem[], id: string): SceneItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.kind === "group") {
      const found = findById(item.items, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Whether item `id` (in `items`) holds anything from `other`: wrapping or
 * unwrapping existing shapes is a restructure, not an add or a delete.
 */
function holdsAny(items: SceneItem[], id: string, other: Set<string>): boolean {
  const item = findById(items, id);
  if (!item || item.kind !== "group") return false;
  for (const child of collectIds(item.items)) if (other.has(child)) return true;
  return false;
}

function scaleItems(items: SceneItem[], factors: Map<string, number>): SceneItem[] {
  return items.map((item) => {
    const f = factors.get(item.id);
    const next: SceneItem =
      f === undefined
        ? item
        : { ...item, scale: item.scale.map((v) => Math.max(MIN_SCALE, v * f)) as [number, number, number] };
    return next.kind === "group" ? { ...next, items: scaleItems(next.items, factors) } : next;
  });
}

export class SpawnAnimator {
  private appear = new Map<string, number>();
  private vanish: { ids: string[]; start: number; from: SceneRoot; after: SceneRoot } | null = null;

  /**
   * Call when the store root changes (not for the first root). `quiet`:
   * the change animates nothing (live edits such as sculpt strokes).
   */
  rootChanged(prev: SceneRoot, next: SceneRoot, now: number, quiet = false): void {
    this.vanish = null;
    if (quiet) return;
    const before = collectIds(prev.items);
    const after = collectIds(next.items);
    const added = new Set([...after].filter((id) => !before.has(id)));
    const removed = new Set([...before].filter((id) => !after.has(id)));

    for (const id of this.appear.keys()) if (!after.has(id)) this.appear.delete(id);
    if (added.size > 0 && added.size <= MAX_ANIMATED) {
      for (const id of topLevel(next.items, added)) if (!holdsAny(next.items, id, before)) this.appear.set(id, now);
    }
    // Pure removals only: drawing `prev` must not hide any other change.
    if (removed.size > 0 && added.size === 0 && removed.size <= MAX_ANIMATED) {
      const ids = topLevel(prev.items, removed).filter((id) => !holdsAny(prev.items, id, after));
      if (ids.length > 0) this.vanish = { ids, start: now, from: prev, after: next };
    }
  }

  /** The root to draw at `now`, and whether anything is still animating. */
  frame(root: SceneRoot, now: number): { root: SceneRoot; animating: boolean } {
    const factors = new Map<string, number>();
    for (const [id, start] of this.appear) {
      const t = (now - start) / APPEAR_MS;
      if (t >= 1) this.appear.delete(id);
      else factors.set(id, Math.max(MIN_FACTOR, easeOutBack(Math.max(0, t))));
    }

    const v = this.vanish;
    if (v && v.after === root) {
      const t = (now - v.start) / VANISH_MS;
      if (t < 1) {
        const f = Math.max(MIN_FACTOR, 1 - easeInCubic(Math.max(0, t)));
        for (const id of v.ids) factors.set(id, f);
        return { root: { ...v.from, items: scaleItems(v.from.items, factors) }, animating: true };
      }
    }
    this.vanish = null;

    if (factors.size === 0) return { root, animating: false };
    return { root: { ...root, items: scaleItems(root.items, factors) }, animating: true };
  }
}

function assertSpawnAnim(): void {
  if (easeOutBack(0) !== 0 || Math.abs(easeOutBack(1) - 1) > 1e-12) {
    throw new Error("spawnAnim: easing must run 0 → 1");
  }
  const layer = (id: string): SceneItem => ({
    kind: "layer", id, shapeType: "sphere", name: id, position: [0, 0, 0], rotation: [0, 0, 0],
    scale: [1, 1, 1], params: [0.5, 0, 0, 0], op: "union", smoothK: 0.1,
  });
  const group: SceneItem = {
    kind: "group", id: "g", name: "g", position: [0, 0, 0], rotation: [0, 0, 0],
    scale: [1, 1, 1], op: "union", smoothK: 0.1, items: [layer("c")],
  };
  const prev: SceneRoot = { id: "r", name: "r", items: [layer("a")] };
  const next: SceneRoot = { id: "r", name: "r", items: [layer("a"), group] };
  const anim = new SpawnAnimator();
  anim.rootChanged(prev, next, 0);
  const drawn = anim.frame(next, 0).root.items;
  const g = drawn[1] as Extract<SceneItem, { kind: "group" }>;
  // The pasted group scales; its child must not compound the factor.
  if (g.scale[0] !== MIN_SCALE * 2 || g.items[0].scale[0] !== 1 || drawn[0].scale[0] !== 1) {
    throw new Error("spawnAnim: only the top-level added item may scale");
  }
}

assertSpawnAnim();
