/**
 * Scene compiler: CSG tree → WGSL + a flat value buffer.
 *
 * The tree's *structure* (node kinds, shape types, CSG ops, which subtrees can
 * be culled) becomes straight-line WGSL; every *number* (baked transforms,
 * params, smooth k, bounds, highlight marks) lives in `dsData`, a uniform
 * array of vec4f. Dragging a gizmo or a slider only rewrites values; adding,
 * removing, re-parenting or changing a shape type / op produces new code,
 * which useGpu.ts compiles in the background (see ProgramCache there).
 *
 * Two functions are generated from the same walk:
 *   ds_sdScene(p, standIn) → f32 hot path: march, normals, AO, reflections,
 *                                 soft shadows (standIn: see Emitter.node)
 *   ds_sceneInfo(p) → vec4f      once per pixel at the hit:
 *                                 x = highlight glow (selection / hover)
 *                                 y = pick id (leaf index + 1, 0 = none)
 *
 * Primitive sources are the exact WGSL the code export emits
 * (src/sdf/primitives.ts), prefixed `ds_` so they cannot collide with names
 * TypeGPU generates for the rest of the shader.
 */
import { MODIFIER_WGSL, WGSL_HELPERS, primitiveCall } from "../sdf/primitives";
import {
  ALL_SHAPE_TYPES,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type SceneRoot,
  type ShapeLayer,
} from "../store/sceneStore";
import { bakeShape, composeGroupCtx, identityCtx, type BakeCtx } from "./bake";
import { DEFAULT_MATERIAL, type Material } from "../store/material";
import { POINT_MODIFIERS, activeModifiers, type Axis, type Modifier, type Vec3 } from "../store/modifiers";
import { UNBOUNDED, polarTurned, type ModifierPlan, type PolarReach } from "../sdf/modifierMath";
import { groupPlan, shapePlan, shapeReach } from "../sdf/itemBounds";
import { maxAbsScale } from "./bounds";
import { itemLocalToWorldPosition } from "./gizmo";

/** vec4f slots in the uniform value buffer (64 KiB = default binding limit). */
export const DATA_SLOTS = 4096;
/**
 * Cull a union-only subtree to its bounding sphere only beyond this distance.
 * The march hits at `HIT_EPS·t` / leftover `REST_HIT_EPS`; returning a smaller
 * sphere distance would paint the bounding sphere as the surface.
 */
export const CULL_DIST = 0.15;
/** Slack so a tight primitive sphere never culls through on float error. */
export const BOUND_EPS = 1e-3;
/** Highlight band: |own SDF| below LO glows fully, fades out by HI. */
export const GLOW_BAND_LO = 0.004;
export const GLOW_BAND_HI = 0.035;

/** Data identifier inside generated WGSL; useGpu binds it via `$uses`. */
export const DATA_IDENT = "dsData";
export const IMAGE_TEX_IDENT = "dsImageTex";
export const IMAGE_SAMPLER_IDENT = "dsImageSampler";

export interface CompiledScene {
  /** WGSL declarations. Equal code ⇔ same value layout (cache key). */
  code: string;
  /** `slotCount` vec4f values, ready for the uniform buffer. */
  values: Float32Array<ArrayBuffer>;
  slotCount: number;
  /** Pick id − 1 → layer id. */
  leafIds: string[];
  /** Item id → float index of its highlight strength in `values`. */
  markIndex: Map<string, number>;
  /** Conservative origin-centered scene bounding radius. */
  boundsRadius: number;
}

export interface CompileOptions {
  /** Texture array layer holding this baked image SDF. */
  imageLayer(sdf: string): number;
}

// ── IR ───────────────────────────────────────────────────────────────────────

/** A point-modifier step as emitted (structure only; numbers live in slots). */
type PointStep =
  | { kind: "repeat"; slot: number }
  | { kind: "mirror"; slot: number; axes: [boolean, boolean, boolean] }
  | { kind: "polar"; slot: number; axis: Axis; reach: PolarReach }
  | { kind: "twist" | "bend"; slot: number; axis: Axis }
  | { kind: "elongate"; slot: number };

/** A distance-modifier step: `.x` of the slot is the amount (already in result units). */
type PostStep = { kind: "round" | "onion"; slot: number };

interface LeafNode {
  kind: "leaf";
  layer: ShapeLayer;
  base: number;
  /** Every CSG op from this node to the scene root is hard union. */
  cull: boolean;
  pickId: number;
  center: Vec3;
  radius: number;
  steps: PointStep[];
  post: PostStep[];
}

interface GroupNode {
  kind: "group";
  group: ObjectGroup;
  base: number;
  cull: boolean;
  children: IrNode[];
  center: Vec3;
  radius: number;
  /**
   * Set when the group has point modifiers: its children live in their own
   * frame — the group's local point (3 affine slots at `xf`) after `steps`.
   * Bounds inside the frame are in frame units; misc.w holds the frame's
   * distance scale.
   */
  frame: { xf: number; steps: PointStep[] } | null;
  post: PostStep[];
  /** Twist / bend: misc.x = 1/Lipschitz, applied to the group's result. */
  lipschitz: boolean;
}

/**
 * Virtual subgroup of a long run of hard-union siblings (min is associative,
 * so regrouping never changes the result). Its sphere gates all members at
 * once — a cheap two-level hierarchy for flat scenes. Membership follows list
 * order, not positions, so moving shapes never changes the code.
 */
interface ChunkNode {
  kind: "chunk";
  base: number;
  members: IrNode[];
  center: Vec3;
  radius: number;
}

type IrNode = LeafNode | GroupNode | ChunkNode;

/** Hard-union runs at least this long are split into chunks of CHUNK_SIZE. */
const CHUNK_MIN_RUN = 8;
const CHUNK_SIZE = 8;

function nodeOp(node: IrNode): OpType {
  return node.kind === "leaf" ? node.layer.op : node.kind === "group" ? node.group.op : "union";
}

function boundSlotOf(node: IrNode): number {
  return node.kind === "leaf" ? node.base + 5 : node.kind === "group" ? node.base + 1 : node.base;
}

const LEAF_SLOTS = 8; // rows+offset ×3, params, misc, bound, material ×2
/** Leaf material slots: (sRGB color, roughness), (metalness, emission, _, _). */
const MAT = 6;
const IMAGE_EXTRA_SLOTS = 1; // round, invert, layer
const GROUP_SLOTS = 2; // misc, bound
/** The march never needs to look farther than this for the scene sphere. */
const MAX_SCENE_RADIUS = 100;

/**
 * misc slot layout. Leaf: x = factor, y = smooth k, z = highlight.
 * Group: x = 1/Lipschitz (twist / bend), y = smooth k, z = highlight,
 * w = frame distance scale (groups with point modifiers).
 */
const MISC = 0;

function itemContributes(item: SceneItem): boolean {
  if (item.kind === "layer") return true;
  return item.items.some(itemContributes);
}

const SMOOTH_OPS: ReadonlySet<OpType> = new Set(["sUnion", "sSubtract", "sIntersect"]);

/** Smallest sphere-ish enclosure of child spheres (centroid + max reach). */
function encloseSpheres(nodes: IrNode[]): { center: Vec3; radius: number } {
  const center: Vec3 = [0, 0, 0];
  for (const n of nodes) for (let k = 0; k < 3; k++) center[k] += n.center[k] / nodes.length;
  let radius = 0;
  for (const n of nodes) {
    const d = Math.hypot(n.center[0] - center[0], n.center[1] - center[1], n.center[2] - center[2]);
    radius = Math.max(radius, d + n.radius);
  }
  return { center, radius };
}

class Builder {
  slots = 0;
  values: number[] = [];
  leafIds: string[] = [];
  markIndex = new Map<string, number>();

  constructor(private opts: CompileOptions) {}

  alloc(n: number): number {
    const base = this.slots;
    this.slots += n;
    for (let i = 0; i < n * 4; i++) this.values.push(0);
    return base;
  }

  set(slot: number, x: number, y: number, z: number, w: number) {
    const i = slot * 4;
    this.values[i] = x;
    this.values[i + 1] = y;
    this.values[i + 2] = z;
    this.values[i + 3] = w;
  }

  /**
   * Allocates and fills the point steps for `mods` acting on geometry `c, r`
   * (frame / local units, after the mods). Returns the steps, the sphere in
   * the mods' input space and the combined 1/Lipschitz factor.
   */
  /** Allocates and fills the slots of `mods`' point steps, following `plan`. */
  pointSteps(mods: Modifier[], plan: ModifierPlan): PointStep[] {
    const point = mods.filter((m) => POINT_MODIFIERS.has(m.kind));
    const steps = point.map((m, i): PointStep => {
      switch (m.kind) {
        case "repeat": {
          const slot = this.alloc(4);
          const copy = plan.copy[i]!;
          this.set(slot, ...m.spacing, 0);
          this.set(slot + 1, ...m.count, 0);
          this.set(slot + 2, ...(plan.gap[i] as Vec3), 0);
          this.set(slot + 3, ...copy.c, copy.r);
          return { kind: "repeat", slot };
        }
        case "mirror": {
          const slot = this.alloc(1);
          this.set(slot, ...m.offset, 0);
          return { kind: "mirror", slot, axes: [...m.axes] };
        }
        case "polar": {
          const slot = this.alloc(4);
          const copy = plan.copy[i]!;
          const turned = polarTurned(m, copy.c);
          this.set(slot, m.count, (2 * Math.PI) / m.count, ...(plan.gap[i] as [number, number]));
          this.set(slot + 1, ...copy.c, copy.r);
          this.set(slot + 2, turned[0], turned[1], turned[2], turned[3]);
          this.set(slot + 3, turned[4], turned[5], turned[6], turned[7]);
          return { kind: "polar", slot, axis: m.axis, reach: plan.polar[i]! };
        }
        case "twist":
        case "bend": {
          const slot = this.alloc(1);
          this.set(slot, m.amount, 0, 0, 0);
          return { kind: m.kind, slot, axis: m.axis };
        }
        case "elongate": {
          const slot = this.alloc(1);
          this.set(slot, ...m.size, 0);
          return { kind: "elongate", slot };
        }
        default:
          throw new Error(`not a point modifier: ${m.kind}`);
      }
    });
    return steps;
  }

  /** Distance steps; `unit` converts the modifier's amount to result units. */
  postSteps(mods: Modifier[], unit: number): { post: PostStep[]; grow: number } {
    const post: PostStep[] = [];
    let grow = 0;
    for (const m of mods) {
      if (m.kind !== "round" && m.kind !== "onion") continue;
      const amount = m.kind === "round" ? m.radius : m.thickness;
      const slot = this.alloc(1);
      this.set(slot, amount * unit, 0, 0, 0);
      post.push({ kind: m.kind, slot });
      grow += amount;
    }
    return { post, grow };
  }

  leaf(
    layer: ShapeLayer,
    ctx: BakeCtx,
    frameAncestors: ObjectGroup[],
    cull: boolean,
    inherited: Material,
  ): LeafNode {
    const image = layer.shapeType === "image";
    const base = this.alloc(LEAF_SLOTS + (image ? IMAGE_EXTRA_SLOTS : 0));
    const mods = activeModifiers(layer.modifiers);
    const baked = bakeShape(ctx, layer.position, layer.rotation, layer.scale);
    // Shape modifiers run in the shape's local (scaled) frame, around its origin.
    const shapeScale = Math.max(Math.abs(layer.scale[0]), Math.abs(layer.scale[1]), Math.abs(layer.scale[2]));
    const { post } = this.postSteps(mods, 1);
    const local = shapePlan(layer);
    const steps = this.pointSteps(mods, local);
    this.set(base, ...baked.row0, baked.offset[0]);
    this.set(base + 1, ...baked.row1, baked.offset[1]);
    this.set(base + 2, ...baked.row2, baked.offset[2]);
    const [a, b, c, w] = layer.params;
    this.set(base + 3, a, b, c, w);
    this.set(base + 4 + MISC, baked.factor * local.invL, layer.smoothK, 0, 0);
    const center = itemLocalToWorldPosition(layer.position, frameAncestors) as Vec3;
    const reach = shapeReach(local);
    let radius = reach >= UNBOUNDED ? UNBOUNDED : reach * shapeScale;
    for (const g of frameAncestors) radius *= maxAbsScale(g);
    radius = Math.min(UNBOUNDED, radius + BOUND_EPS);
    this.set(base + 5, ...center, radius);
    const mat = layer.material ?? inherited;
    this.set(base + MAT, ...mat.color, mat.roughness);
    this.set(base + MAT + 1, mat.metalness, mat.emission, 0, 0);
    if (image) {
      const round = Math.max(0, layer.image?.round ?? 0);
      const layerIdx = layer.image ? this.opts.imageLayer(layer.image.sdf) : 0;
      this.set(base + LEAF_SLOTS, round, w > 0.5 ? 1 : 0, layerIdx, layer.image ? 1 : 0);
    }
    this.markIndex.set(layer.id, (base + 4) * 4 + 2);
    this.leafIds.push(layer.id);
    return {
      kind: "leaf",
      layer,
      base,
      cull,
      pickId: this.leafIds.length,
      center,
      radius,
      steps,
      post,
    };
  }

  group(
    item: ObjectGroup,
    ctx: BakeCtx,
    frameAncestors: ObjectGroup[],
    cull: boolean,
    inherited: Material,
  ): GroupNode {
    const base = this.alloc(GROUP_SLOTS);
    const mods = activeModifiers(item.modifiers);
    const hasFrame = mods.some((m) => POINT_MODIFIERS.has(m.kind));
    const inner = composeGroupCtx(ctx, item.position, item.rotation, item.scale);
    const frameScale = Math.min(Math.abs(inner.accScl[0]), Math.abs(inner.accScl[1]), Math.abs(inner.accScl[2]));
    let xf = 0;
    if (hasFrame) {
      xf = this.alloc(3);
      this.set(xf, inner.m[0], inner.m[1], inner.m[2], inner.b[0]);
      this.set(xf + 1, inner.m[3], inner.m[4], inner.m[5], inner.b[1]);
      this.set(xf + 2, inner.m[6], inner.m[7], inner.m[8], inner.b[2]);
    }
    // Children: in the group's own frame when it has point modifiers (bounds
    // relative to it, transforms baked from its local point), else baked
    // straight through as before.
    const children = hasFrame
      ? this.items(item.items, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], b: [0, 0, 0], accScl: inner.accScl }, [], false, item.material ?? inherited)
      : this.items(item.items, inner, [...frameAncestors, item], cull && mods.length === 0, item.material ?? inherited);
    const sphere = encloseSpheres(children);
    // Smooth ops bulge the surface outward by at most k/4.
    let bulge = 0;
    for (let c = 1; c < children.length; c++) {
      const child = children[c];
      if (child.kind === "chunk") continue; // hard union only
      const op = nodeOp(child);
      const k = child.kind === "leaf" ? child.layer.smoothK : child.group.smoothK;
      if (SMOOTH_OPS.has(op)) bulge = Math.max(bulge, Math.abs(k) * 0.25);
    }
    let center = sphere.center;
    let radius = sphere.radius + bulge;
    // Post modifiers act on the result in world-scaled units.
    const { post, grow } = this.postSteps(mods, frameScale);
    let steps: PointStep[] = [];
    let invL = 1;
    if (hasFrame) {
      // The plan (shared with the export) grows the children's sphere, in the
      // group's local units, through the modifiers; then it is carried into
      // the parent's frame.
      const plan = groupPlan(item)!;
      steps = this.pointSteps(mods, plan);
      invL = plan.invL;
      if (plan.r >= UNBOUNDED) {
        radius = UNBOUNDED;
      } else {
        center = itemLocalToWorldPosition(plan.c, [...frameAncestors, item]) as Vec3;
        radius = plan.r * maxAbsScale(item);
        for (const g of frameAncestors) radius *= maxAbsScale(g);
      }
    } else if (grow > 0) {
      let chain = maxAbsScale(item);
      for (const g of frameAncestors) chain *= maxAbsScale(g);
      radius += grow * chain;
    }
    radius = Math.min(UNBOUNDED, radius + BOUND_EPS);
    this.set(base + MISC, invL, item.smoothK, 0, frameScale);
    this.set(base + 1, ...center, radius);
    this.markIndex.set(item.id, (base + MISC) * 4 + 2);
    return {
      kind: "group",
      group: item,
      base,
      cull,
      children,
      center,
      radius,
      frame: hasFrame ? { xf, steps } : null,
      post,
      lipschitz: invL !== 1 || steps.some((s) => s.kind === "twist" || s.kind === "bend"),
    };
  }

  /**
   * Postorder walk mirroring the old instruction packer: an item may be culled
   * to its bounding sphere only when every op consuming it — here and above —
   * is hard union (sphere distance is a lower bound; only min() keeps the
   * zero set identical). `frameAncestors`: groups between the current frame
   * (world, or the nearest group with point modifiers) and these items.
   */
  items(
    items: SceneItem[],
    ctx: BakeCtx,
    frameAncestors: ObjectGroup[],
    unionAbove: boolean,
    inherited: Material = DEFAULT_MATERIAL,
  ): IrNode[] {
    const list = items.filter(itemContributes);
    const out: IrNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      let cull = unionAbove;
      if (cull && i > 0 && item.op !== "union") cull = false;
      if (cull) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[j].op !== "union") {
            cull = false;
            break;
          }
        }
      }
      if (item.kind === "layer") {
        // A modified shape's result is rewritten; its sphere must not stand in.
        const modded = activeModifiers(item.modifiers).length > 0;
        out.push(this.leaf(item, ctx, frameAncestors, cull && !modded, inherited));
      } else {
        out.push(this.group(item, ctx, frameAncestors, cull, inherited));
      }
    }
    return this.chunkRuns(out);
  }

  /** Splits long runs of hard-union siblings (never the list head) into chunks. */
  chunkRuns(list: IrNode[]): IrNode[] {
    const out: IrNode[] = list.slice(0, 1);
    let i = 1;
    while (i < list.length) {
      let j = i;
      while (j < list.length && nodeOp(list[j]) === "union") j++;
      if (j - i >= CHUNK_MIN_RUN) {
        out.push(...this.chunk(list.slice(i, j)));
        i = j;
      } else {
        out.push(list[i]);
        i++;
      }
    }
    return out;
  }

  chunk(run: IrNode[]): IrNode[] {
    if (run.length < CHUNK_MIN_RUN) return run;
    const chunks: IrNode[] = [];
    for (let i = 0; i < run.length; i += CHUNK_SIZE) {
      const members = run.slice(i, i + CHUNK_SIZE);
      if (members.length === 1) {
        chunks.push(members[0]);
        continue;
      }
      const base = this.alloc(1);
      const sphere = encloseSpheres(members);
      const radius = Math.min(UNBOUNDED, sphere.radius + BOUND_EPS);
      this.set(base, ...sphere.center, radius);
      chunks.push({ kind: "chunk", base, members, center: sphere.center, radius });
    }
    return this.chunk(chunks);
  }
}

// ── WGSL emission ────────────────────────────────────────────────────────────

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** Generated function names that must not collide with TypeGPU's. */
const PRIMITIVE_HELPERS = (() => {
  const names = new Set<string>();
  for (const src of [...ALL_SHAPE_TYPES.map((t) => WGSL_HELPERS[t]), MODIFIER_WGSL]) {
    for (const m of src.matchAll(/fn (\w+)\(/g)) names.add(m[1]);
  }
  return names;
})();

function prefixHelpers(src: string): string {
  return src.replace(/\b([A-Za-z_]\w*)\b/g, (m) => (PRIMITIVE_HELPERS.has(m) ? `ds_${m}` : m));
}

const D = DATA_IDENT;
const slot = (i: number) => `${D}[${i}]`;
const CALL_SYNTAX = {
  vec2: (x: string, y: string) => `vec2f(${x}, ${y})`,
  vec3: (x: string, y: string, z: string) => `vec3f(${x}, ${y}, ${z})`,
};

/** Primitive call at local point expression `lp` (no factor). */
function leafCall(node: LeafNode, lp: string): string {
  const b = node.base;
  const P = slot(b + 3);
  if (node.layer.shapeType === "image") return `ds_sdImage(${lp}, ${P}, ${slot(b + LEAF_SLOTS)})`;
  const params = [`${P}.x`, `${P}.y`, `${P}.z`, `${P}.w`] as const;
  // Prefer a swizzle when a primitive takes the first three params as a vector.
  const call = primitiveCall(node.layer.shapeType, lp, params, {
    ...CALL_SYNTAX,
    vec3: (x, y, z) =>
      x === params[0] && y === params[1] && z === params[2] ? `${P}.xyz` : CALL_SYNTAX.vec3(x, y, z),
    vec2: (x, y) => (x === params[0] && y === params[1] ? `${P}.xy` : CALL_SYNTAX.vec2(x, y)),
  });
  return `ds_${call}`;
}

/** Point steps that map one point to one point (repeats and polars loop over copies instead). */
function stepExpr(s: Exclude<PointStep, { kind: "repeat" | "polar" }>, q: string): string {
  switch (s.kind) {
    case "mirror": {
      const o = slot(s.slot);
      const c = ["x", "y", "z"].map((k, a) => (s.axes[a] ? `abs(${q}.${k} + ${o}.${k}) - ${o}.${k}` : `${q}.${k}`));
      return `vec3f(${c.join(", ")})`;
    }
    case "twist":
      return `ds_opTwist(${q}, ${slot(s.slot)}.x, ${s.axis}u)`;
    case "bend":
      return `ds_opBend(${q}, ${slot(s.slot)}.x, ${s.axis}u)`;
    case "elongate":
      return `(${q} - clamp(${q}, -${slot(s.slot)}.xyz, ${slot(s.slot)}.xyz))`;
  }
}

function postExpr(s: PostStep, d: string): string {
  return s.kind === "round" ? `(${d} - ${slot(s.slot)}.x)` : `(abs(${d}) - ${slot(s.slot)}.x)`;
}

function combine(op: OpType, a: string, b: string, k: string): string {
  switch (op) {
    case "union":
      return `min(${a}, ${b})`;
    case "subtract":
      return `max(${a}, -${b})`;
    case "intersect":
      return `max(${a}, ${b})`;
    case "sUnion":
      return `ds_smin(${a}, ${b}, ${k})`;
    case "sSubtract":
      return `-ds_smin(-${a}, ${b}, ${k})`;
    case "sIntersect":
      return `-ds_smin(-${a}, -${b}, ${k})`;
  }
}

/** A node's value: distance expression and (info pass only) its material. */
type Val = { d: string; m: string };

/**
 * Where a fold evaluates: the point variable, and the expression scaling
 * frame-unit bound distances to result units (null = world, scale 1).
 */
interface Frame {
  p: string;
  f: string | null;
}

const WORLD: Frame = { p: "p", f: null };

class Emitter {
  lines: string[] = [];
  private n = 0;

  /** `info`: also track materials and highlight / pick marks (once-per-pixel pass). */
  constructor(private info: boolean) {}

  fresh(prefix: string) {
    return `${prefix}${this.n++}`;
  }

  push(depth: number, line: string) {
    this.lines.push("  ".repeat(depth) + line);
  }

  bound(node: IrNode, frame: Frame): string {
    const b = `ds_bound(${frame.p}, ${boundSlotOf(node)}u)`;
    return frame.f ? `(${b} * ${frame.f})` : b;
  }

  /**
   * Emits the CSG fold of `nodes`; returns the accumulator.
   *
   * Union-like children are gated by their bounding sphere against the
   * running result: union = min(acc, b) equals acc whenever b ≥ acc, and
   * b ≥ (distance to b's sphere), so a child whose sphere is farther than
   * acc cannot change the result (sUnion: farther than acc + k). Returning
   * acc there is still a lower bound of the true distance, and near the
   * child's surface its sphere distance is small, so the zero set is exact.
   * This turns a flat list of N shapes into N cheap sphere tests plus the
   * few shapes actually near the ray. The info pass widens the gate by the
   * glow band so highlights and picking still see every nearby node.
   */
  nodes(nodes: IrNode[], depth: number, frame: Frame = WORLD): Val {
    const id = this.n++;
    const acc = { d: `a${id}`, m: `m${id}` };
    const head = nodes[0];
    if (head.kind === "chunk") throw new Error("chunk cannot head a list");
    const h = this.node(head, depth, head.cull, frame);
    this.push(depth, `var ${acc.d} = ${h.d};`);
    if (this.info) this.push(depth, `var ${acc.m} = ${h.m};`);
    for (let i = 1; i < nodes.length; i++) this.combineInto(acc, nodes[i], depth, frame);
    return acc;
  }

  combineInto(acc: Val, node: IrNode, depth: number, frame: Frame) {
    const op = nodeOp(node);
    const k = node.kind === "chunk" ? "" : `${slot(node.base + (node.kind === "leaf" ? 4 : 0))}.y`;
    if (op !== "union" && op !== "sUnion") {
      if (node.kind === "chunk") throw new Error("chunks are hard union");
      this.combineStmt(op, acc, this.node(node, depth, false, frame), k, depth);
      return;
    }
    let gate = acc.d;
    if (op === "sUnion") gate += ` + ${k}`;
    if (this.info) gate += ` + ${f(GLOW_BAND_HI)}`;
    this.push(depth, `if (${this.bound(node, frame)} < ${gate}) {`);
    if (node.kind === "chunk") {
      for (const m of node.members) this.combineInto(acc, m, depth + 1, frame);
    } else {
      this.combineStmt(op, acc, this.node(node, depth + 1, false, frame), k, depth + 1);
    }
    this.push(depth, `}`);
  }

  /**
   * acc ⊕ v. Materials follow the distances: union / intersect take the
   * winning operand's, smooth ops blend with the smooth-min weight, and a
   * subtraction keeps the cut shape's material (hole walls match the body).
   */
  combineStmt(op: OpType, acc: Val, v: Val, k: string, depth: number) {
    if (this.info) {
      if (op === "union") this.push(depth, `if (${v.d} < ${acc.d}) { ${acc.m} = ${v.m}; }`);
      else if (op === "intersect") this.push(depth, `if (${v.d} > ${acc.d}) { ${acc.m} = ${v.m}; }`);
      else if (op === "sUnion") {
        this.push(depth, `${acc.m} = ds_mixMat(${acc.m}, ${v.m}, ds_sminT(${acc.d}, ${v.d}, ${k}));`);
      } else if (op === "sIntersect") {
        this.push(depth, `${acc.m} = ds_mixMat(${acc.m}, ${v.m}, ds_sminT(-${acc.d}, -${v.d}, ${k}));`);
      }
    }
    this.push(depth, `${acc.d} = ${combine(op, acc.d, v.d, k)};`);
  }

  /**
   * One node's value. `cull`: every op from here to the root is hard union,
   * so beyond `standIn` (ds_sdScene's argument: CULL_DIST for marches; huge
   * where the distance is read as "how near is geometry", like soft shadows)
   * the sphere distance itself may stand in (used for the first child of a
   * list, which has no running result to gate on).
   */
  node(node: LeafNode | GroupNode, depth: number, cull: boolean, frame: Frame): Val {
    const id = this.n++;
    const out = { d: `v${id}`, m: `w${id}` };
    if (cull) {
      this.push(depth, `var ${out.d} = ${this.bound(node, frame)};`);
      if (this.info) this.push(depth, `var ${out.m} = ds_defaultMat();`);
      this.push(depth, `if (${out.d} <= ${this.info ? f(CULL_DIST) : "standIn"}) {`);
      const val = this.value(node, depth + 1, frame);
      this.push(depth + 1, `${out.d} = ${val.d};`);
      if (this.info) this.push(depth + 1, `${out.m} = ${val.m};`);
      this.push(depth, `}`);
    } else {
      const val = this.value(node, depth, frame);
      this.push(depth, `let ${out.d} = ${val.d};`);
      if (this.info) this.push(depth, `let ${out.m} = ${val.m};`);
    }
    if (this.info) {
      const markSlot = node.kind === "leaf" ? node.base + 4 : node.base;
      if (node.kind === "leaf") {
        this.push(depth, `ds_markLeaf(&info, ${out.d}, ${slot(markSlot)}.z, ${f(node.pickId)});`);
      } else {
        this.push(depth, `ds_mark(&info, ${out.d}, ${slot(markSlot)}.z);`);
      }
    }
    return out;
  }

  /** Full value; groups emit their children first. */
  value(node: LeafNode | GroupNode, depth: number, frame: Frame): Val {
    return node.kind === "leaf" ? this.leafValue(node, depth, frame) : this.groupValue(node, depth, frame);
  }

  leafValue(node: LeafNode, depth: number, frame: Frame): Val {
    const b = node.base;
    const mat = `ds_mat(${b + MAT}u)`;
    const xf = `ds_xf(${frame.p}, ${b}u)`;
    const factor = `${slot(b + 4)}.x`;
    if (node.steps.length === 0 && node.post.length === 0) {
      return { d: `${leafCall(node, xf)} * ${factor}`, m: mat };
    }
    const q0 = this.fresh("q");
    this.push(depth, `let ${q0} = ${xf};`);
    return this.withSteps(node.steps, q0, factor, depth, (q) => {
      let e = leafCall(node, q);
      for (const s of node.post) e = postExpr(s, e);
      return { d: `${e} * ${factor}`, m: mat };
    });
  }

  groupValue(node: GroupNode, depth: number, frame: Frame): Val {
    let res: Val;
    if (!node.frame) {
      res = this.nodes(node.children, depth, frame);
    } else {
      const q0 = this.fresh("q");
      this.push(depth, `let ${q0} = ds_xf(${frame.p}, ${node.frame.xf}u);`);
      const inner = `${slot(node.base)}.w`;
      res = this.withSteps(node.frame.steps, q0, inner, depth, (q, d) => this.nodes(node.children, d, { p: q, f: inner }));
    }
    if (!node.lipschitz && node.post.length === 0) return res;
    const g = this.fresh("g");
    this.push(depth, `var ${g} = ${res.d}${node.lipschitz ? ` * ${slot(node.base)}.x` : ""};`);
    for (const s of node.post) this.push(depth, `${g} = ${postExpr(s, g)};`);
    return { d: g, m: res.m };
  }

  /**
   * Applies point steps to `q`, then `body`. Repeats and polar repeats check
   * the copies a point can be nearest to (see modifierMath.ts); geometry
   * around a polar axis loops over every copy. Bounds are in step space,
   * times `unit` into result units.
   */
  withSteps(steps: PointStep[], q: string, unit: string, depth: number, body: (q: string, depth: number) => Val): Val {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const rest = steps.slice(i + 1);
      if (s.kind === "repeat") {
        const [sp, cnt, gap] = [0, 1, 2].map((k) => `${slot(s.slot + k)}.xyz`);
        const sphere = slot(s.slot + 3);
        const id = this.fresh("c");
        this.push(depth, `let ${id} = ds_repeatCell(${q}, ${sp}, ${cnt});`);
        return this.nearest(
          { count: "8u", rest, unit, depth, body },
          `ds_opRepeatOthers(${q}, ${sp}, ${cnt}, ${id}, ${sphere})`,
          (n) => `ds_opRepeatNearBound(${q}, ${sp}, ${cnt}, ${id}, ${sphere}, ${n})`,
          (n) => `ds_opRepeatNear(${q}, ${sp}, ${id}, ${n})`,
          `ds_opRepeatFar(${q}, ${sp}, ${cnt}, ${id}, ${gap})`,
        );
      }
      if (s.kind === "polar") {
        const v = slot(s.slot);
        if (s.reach === "all") {
          return this.copyLoop({ count: `u32(${v}.x)`, rest, unit, depth, body }, (n) => `ds_opPolarCopy(${q}, ${v}.y, ${s.axis}u, ${n})`);
        }
        const sphere = slot(s.slot + 1);
        const own = this.fresh("q");
        this.push(depth, `let ${own} = ds_opPolarNear(${q}, ${v}.y, ${s.axis}u, 0u);`);
        return this.nearest(
          { count: `min(3u, u32(${v}.x))`, rest, unit, depth, body },
          `ds_opPolarOthers(${own}, ${s.axis}u, ${sphere}, ${slot(s.slot + 2)}, ${slot(s.slot + 3)})`,
          (n) => `ds_opPolarNearBound(${q}, ${v}.y, ${s.axis}u, ${sphere}, ${n})`,
          (n) => `ds_opPolarNear(${q}, ${v}.y, ${s.axis}u, ${n})`,
          `ds_opPolarFar(${q}, ${v}.y, ${s.axis}u, ${v}.zw, ${v}.x)`,
        );
      }
      const qn = this.fresh("q");
      this.push(depth, `let ${qn} = ${stepExpr(s, q)};`);
      q = qn;
    }
    return body(q, depth);
  }

  /**
   * Union over candidate copies, nearest first (n = 0). Stops when no other
   * copy can be nearer than the result (`others`), skips a candidate whose
   * `bound(n)` cannot beat it, and caps the result by `far` (the copies no
   * candidate covers) when that is not settled.
   */
  nearest(
    loop: CopyLoop,
    others: string,
    bound: (n: string) => string,
    copy: (n: string) => string,
    far: string,
  ): Val {
    const { unit, depth } = loop;
    const lo = this.fresh("t");
    this.push(depth, `let ${lo} = ${others} * ${unit};`);
    const acc = this.copyLoop(loop, copy, (n, r) => [
      `if (${n} > 0u) {`,
      `  if (${r} <= ${lo}) { break; }`,
      `  if (${bound(n)} * ${unit} >= ${r}) { continue; }`,
      `}`,
    ]);
    this.push(depth, `if (${acc.d} > ${lo}) { ${acc.d} = min(${acc.d}, ${far} * ${unit}); }`);
    return acc;
  }

  /** Union over `count` copies: `copy(n)` is copy n's point, `rest` then `body` run on it after `guard`'s lines. */
  copyLoop(loop: CopyLoop, copy: (n: string) => string, guard?: (n: string, acc: string) => string[]): Val {
    const { count, rest, unit, depth, body } = loop;
    const id = this.n++;
    const acc = { d: `r${id}`, m: `rm${id}` };
    const n = `n${id}`;
    this.push(depth, `var ${acc.d} = 1e10;`);
    if (this.info) this.push(depth, `var ${acc.m} = ds_defaultMat();`);
    this.push(depth, `for (var ${n} = 0u; ${n} < ${count}; ${n}++) {`);
    for (const line of guard?.(n, acc.d) ?? []) this.push(depth + 1, line);
    const qn = this.fresh("q");
    this.push(depth + 1, `let ${qn} = ${copy(n)};`);
    const inner = this.withSteps(rest, qn, unit, depth + 1, body);
    const t = this.fresh("t");
    this.push(depth + 1, `let ${t} = ${inner.d};`);
    if (this.info) this.push(depth + 1, `if (${t} < ${acc.d}) { ${acc.m} = ${inner.m}; }`);
    this.push(depth + 1, `${acc.d} = min(${acc.d}, ${t});`);
    this.push(depth, `}`);
    return acc;
  }
}

/** What a copy loop runs: `count` copies, then the remaining steps and the body in `unit`s. */
interface CopyLoop {
  count: string;
  rest: PointStep[];
  unit: string;
  depth: number;
  body: (q: string, depth: number) => Val;
}

const RUNTIME_WGSL = `fn ds_xf(p: vec3f, i: u32) -> vec3f {
  let a = ${D}[i];
  let b = ${D}[i + 1u];
  let c = ${D}[i + 2u];
  return vec3f(dot(a.xyz, p) + a.w, dot(b.xyz, p) + b.w, dot(c.xyz, p) + c.w);
}

fn ds_bound(p: vec3f, i: u32) -> f32 {
  let s = ${D}[i];
  return length(p - s.xyz) - s.w;
}

fn ds_smin(a: f32, b: f32, kIn: f32) -> f32 {
  let k = max(kIn, 1e-6);
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// info.x = glow, info.y = pick id, info.z = |d| of the picked leaf.
fn ds_mark(info: ptr<function, vec4f>, d: f32, strength: f32) {
  let glow = strength * (1.0 - smoothstep(${f(GLOW_BAND_LO)}, ${f(GLOW_BAND_HI)}, abs(d)));
  (*info).x = max((*info).x, glow);
}

fn ds_markLeaf(info: ptr<function, vec4f>, d: f32, strength: f32, id: f32) {
  ds_mark(info, d, strength);
  if (abs(d) < (*info).z) {
    (*info).z = abs(d);
    (*info).y = id;
  }
}

// Materials (sRGB color, roughness), (metalness, emission, _, _); see MAT.
struct DsMat { c: vec4f, e: vec4f }

fn ds_mat(i: u32) -> DsMat {
  return DsMat(${D}[i], ${D}[i + 1u]);
}

fn ds_defaultMat() -> DsMat {
  return DsMat(vec4f(${DEFAULT_MATERIAL.color.map(f).join(", ")}, ${f(DEFAULT_MATERIAL.roughness)}), vec4f(${f(DEFAULT_MATERIAL.metalness)}, ${f(DEFAULT_MATERIAL.emission)}, 0.0, 0.0));
}

fn ds_mixMat(a: DsMat, b: DsMat, t: f32) -> DsMat {
  return DsMat(mix(a.c, b.c, t), mix(a.e, b.e, t));
}

// Weight of b in ds_smin(a, b, k): 0 = all a, 1 = all b.
fn ds_sminT(a: f32, b: f32, kIn: f32) -> f32 {
  let k = max(kIn, 1e-6);
  return 1.0 - clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
}

struct DsInfo {
  glow: f32,
  id: f32,
  color: vec3f,
  roughness: f32,
  metalness: f32,
  emission: f32,
}

// Baked image SDF (src/utils/imageSdf.ts): r16float texel t = d_px / RES.
// P = (half size, half thickness, bold, _), X = (round, invert, layer, has image).
fn ds_sdImage(q: vec3f, P: vec4f, X: vec4f) -> f32 {
  if (X.w < 0.5) { return 1e10; }
  // Viewport camera sits at -Z with screen-up = world -Y, so image row 0
  // (top) maps to -Y and the logo reads upright from the default view.
  let uv = q.xy * (0.5 / P.x) + vec2f(0.5);
  let t = textureSampleLevel(${IMAGE_TEX_IDENT}, ${IMAGE_SAMPLER_IDENT}, uv, i32(X.z), 0.0).x;
  return ds_sdImageField(q, t, P.x, P.y, P.z, X.x, X.y);
}`;

/** Every helper is emitted: unused WGSL functions cost nothing at runtime. */
const HELPERS_WGSL = [
  ...ALL_SHAPE_TYPES.map((t) => prefixHelpers(WGSL_HELPERS[t])),
  prefixHelpers(MODIFIER_WGSL),
  RUNTIME_WGSL,
].join("\n\n");

export function compileScene(root: SceneRoot, opts: CompileOptions): CompiledScene {
  const builder = new Builder(opts);
  const ir = builder.items(root.items, identityCtx(), [], true);

  const sdf = new Emitter(false);
  const sdfAcc = ir.length > 0 ? sdf.nodes(ir, 1).d : "1e10";
  const info = new Emitter(true);
  const infoMat = ir.length > 0 ? info.nodes(ir, 1).m : "ds_defaultMat()";

  const code = [
    HELPERS_WGSL,
    `fn ds_sdScene(p: vec3f, standIn: f32) -> f32 {\n${sdf.lines.join("\n")}\n  return ${sdfAcc};\n}`,
    `fn ds_sceneInfo(p: vec3f) -> DsInfo {
  var info = vec4f(0.0, 0.0, 1e9, 0.0);
${info.lines.join("\n")}
  let mat = ${infoMat};
  return DsInfo(info.x, info.y, mat.c.xyz, mat.c.w, mat.e.x, mat.e.y);
}`,
  ].join("\n\n");

  if (builder.slots > DATA_SLOTS) {
    throw new Error(`scene needs ${builder.slots} data slots (max ${DATA_SLOTS})`);
  }

  return {
    code,
    values: new Float32Array(builder.values),
    slotCount: builder.slots,
    leafIds: builder.leafIds,
    markIndex: builder.markIndex,
    boundsRadius: sceneRadius(ir),
  };
}

/** Origin-centered radius enclosing every root node (march bounds), capped. */
function sceneRadius(ir: IrNode[]): number {
  let r = 0;
  for (const n of ir) r = Math.max(r, Math.hypot(n.center[0], n.center[1], n.center[2]) + n.radius);
  // Smooth ops at the root bulge by at most k/4.
  for (let i = 1; i < ir.length; i++) {
    const n = ir[i];
    if (n.kind !== "chunk" && SMOOTH_OPS.has(nodeOp(n))) {
      r += Math.abs(n.kind === "leaf" ? n.layer.smoothK : n.group.smoothK) * 0.25;
    }
  }
  return Math.min(MAX_SCENE_RADIUS, r + 0.05);
}

/** Slots a tree needs — the hard cap behind `validateRoot`. */
export function countDataSlots(items: SceneItem[]): number {
  const builder = new Builder({ imageLayer: () => 0 });
  builder.items(items, identityCtx(), [], true);
  return builder.slots;
}
