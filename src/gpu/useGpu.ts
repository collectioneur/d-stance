import { useEffect, type RefObject } from "react";
import { tgpu, d } from "typegpu";
import {
  createShader,
  MAX_GPU_OBJECTS,
  MAX_INSTRUCTIONS,
  MAX_PICK_INSTRUCTIONS,
  MAX_PICK_OBJECTS,
  OPCODE_OP,
  GLOW_BAND_HI,
  OPCODE_PUSH_SHAPE,
  PICK_PASS_GIZMO,
  RENDER_MODE_CHROME,
  RENDER_MODE_CLASSIC,
  SHAPE_TYPE_INT,
  OP_TYPE_INT,
} from "./shader";
import {
  useSceneStore,
  collectImageSdfs,
  findItem,
  topLevelSelection,
  getAncestorGroups,
  pauseHistory,
  resumeHistory,
  IMAGE_ROUND_MAX,
  MAX_IMAGES,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type SceneRoot,
  type ShapeLayer,
} from "../store/sceneStore";
import { useGizmoStore } from "../store/gizmoStore";
import { useRenderStore, type RenderMode } from "../store/renderStore";
import { QUALITY_PRESETS, dprForPreset } from "../utils/quality";
import { clientToPickPixel, getCanvasAspect } from "./camera";
import {
  applyScaleFactorToItem,
  applyWorldRotationToItem,
  axisDeltaFromScreenDrag,
  beginAxisScreenDrag,
  beginRingDrag,
  beginScaleDrag,
  beginGroupDrag,
  getSelectionGizmoFrame,
  groupRotatePatches,
  groupScalePatches,
  groupTranslatePatches,
  type GroupDragTarget,
  ringTotalAngleFromScreenDrag,
  scaleFactorFromScreenDrag,
  getGizmoWorldPosition,
  getItemAncestorGroups,
  itemLocalToWorldPosition,
  GIZMO_MODE_ROTATE,
  GIZMO_MODE_SCALE,
  GIZMO_MODE_TRANSLATE,
  GIZMO_ARROW_LENGTH_RATIO,
  gizmoVisualScaleForDistance,
  isGizmoAxisNearScreen,
  pickGizmoAxisScreen,
  stabilizeGizmoHoverAxis,
  type GizmoPickMode,
  worldToItemLocalPosition,
  type AxisScreenDragState,
  type GizmoAxis,
  type GizmoHandle,
  type RingDragState,
  type ScaleDragState,
} from "./gizmo";
import { bakeShape, composeGroupCtx, identityCtx, type BakeCtx } from "./bake";
import { SpawnAnimator } from "./spawnAnim";
import { IMAGE_SDF_EMPTY_HALF, IMAGE_SDF_RES, decodeSdfPng } from "../utils/imageSdf";

type GizmoGpuPickResult = {
  axis: GizmoHandle | null;
  skipped: boolean;
};

type InstructionData = {
  opcode: number;
  shapeType: number;
  opType: number;
  smoothK: number;
  params: ReturnType<typeof d.vec4f>;
  row0: ReturnType<typeof d.vec3f>;
  factor: number;
  row1: ReturnType<typeof d.vec3f>;
  unionOnly: number;
  row2: ReturnType<typeof d.vec3f>;
  _pad2: number;
  offset: ReturnType<typeof d.vec3f>;
  _pad3: number;
  boundCenter: ReturnType<typeof d.vec3f>;
  boundRadius: number;
};

type ObjectInfoData = { start: number; count: number };

const EMPTY_INSTRUCTION: InstructionData = {
  opcode: 0,
  shapeType: 0,
  opType: 0,
  smoothK: 0,
  params: d.vec4f(0, 0, 0, 0),
  row0: d.vec3f(1, 0, 0),
  factor: 0,
  row1: d.vec3f(0, 1, 0),
  unionOnly: 0,
  row2: d.vec3f(0, 0, 1),
  _pad2: 0,
  offset: d.vec3f(0, 0, 0),
  _pad3: 0,
  boundCenter: d.vec3f(0, 0, 0),
  boundRadius: 0,
};

/** Slack so a tight primitive sphere never skips through on float error. */
const SHAPE_BOUND_EPS = 1e-3;

const EMPTY_OBJECT_INFO: ObjectInfoData = { start: 0, count: 0 };

/**
 * Image SDF data URL → texture array layer. Rebuilt by syncImageSlots before
 * every pack so PUSH_SHAPE params can reference the layer. Module-level
 * because the packers are module-level; there is one GPU root per app.
 */
const imageSlots = new Map<string, number>();

/** Drops unused slots, assigns free ones to new images. Returns the new pairs. */
function syncImageSlots(sceneRoot: SceneRoot): [string, number][] {
  const used = collectImageSdfs(sceneRoot.items);
  for (const sdf of imageSlots.keys()) if (!used.has(sdf)) imageSlots.delete(sdf);
  const taken = new Set(imageSlots.values());
  const added: [string, number][] = [];
  for (const sdf of used) {
    if (imageSlots.has(sdf)) continue;
    let slot = 0;
    while (slot < MAX_IMAGES && taken.has(slot)) slot++;
    if (slot >= MAX_IMAGES) break; // over cap (hostile hash): extra images render slot 0
    taken.add(slot);
    imageSlots.set(sdf, slot);
    added.push([sdf, slot]);
  }
  return added;
}

/** Resolution of the edge-rounding radius packed into params.w (local units). */
const IMAGE_ROUND_STEP = 0.001;

/**
 * GPU params for an image layer:
 * [halfSize, halfThickness, bold, round/STEP·1000 + invert·100 + layer].
 * All three packed parts are small integers (≤ 10⁷ with IMAGE_ROUND_MAX = 10),
 * so the f32 is exact and the shader can split it with floor/subtract.
 */
function packImageParams(layer: ShapeLayer): [number, number, number, number] {
  const [size, h, bold, invert] = layer.params;
  const slot = layer.image ? (imageSlots.get(layer.image.sdf) ?? 0) : 0;
  const round = Math.min(IMAGE_ROUND_MAX, Math.max(0, layer.image?.round ?? 0));
  const roundQ = Math.round(round / IMAGE_ROUND_STEP);
  return [size, h, bold, roundQ * 1000 + (invert > 0.5 ? 100 : 0) + slot];
}

function pushShapeInstruction(
  layer: ShapeLayer,
  ctx: BakeCtx,
  ancestors: ObjectGroup[],
  unionOnly: boolean,
  out: InstructionData[],
): void {
  const baked = bakeShape(ctx, layer.position, layer.rotation, layer.scale);
  const center = itemLocalToWorldPosition(layer.position, ancestors);
  let radius = shapeBoundRadius(layer);
  for (const group of ancestors) {
    radius *= maxAbsScale(group);
  }
  const params = layer.shapeType === "image" ? packImageParams(layer) : layer.params;
  out.push({
    opcode: OPCODE_PUSH_SHAPE,
    shapeType: SHAPE_TYPE_INT[layer.shapeType],
    opType: 0,
    smoothK: 0,
    params: d.vec4f(params[0], params[1], params[2], params[3]),
    row0: d.vec3f(baked.row0[0], baked.row0[1], baked.row0[2]),
    factor: baked.factor,
    row1: d.vec3f(baked.row1[0], baked.row1[1], baked.row1[2]),
    unionOnly: unionOnly ? 1 : 0,
    row2: d.vec3f(baked.row2[0], baked.row2[1], baked.row2[2]),
    _pad2: 0,
    offset: d.vec3f(baked.offset[0], baked.offset[1], baked.offset[2]),
    _pad3: 0,
    boundCenter: d.vec3f(center[0], center[1], center[2]),
    boundRadius: radius + SHAPE_BOUND_EPS,
  });
}

function pushOpInstruction(op: OpType, smoothK: number, out: InstructionData[]): void {
  out.push({
    ...EMPTY_INSTRUCTION,
    opcode: OPCODE_OP,
    opType: OP_TYPE_INT[op],
    smoothK,
  });
}

function groupCtx(ctx: BakeCtx, group: ObjectGroup): BakeCtx {
  return composeGroupCtx(ctx, group.position, group.rotation, group.scale);
}

/** Conservative shape bound radius in its own local space (rotation-invariant). */
function shapeBoundRadius(layer: ShapeLayer): number {
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
function sceneBoundRadius(items: SceneItem[]): number {
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

function maxAbsScale(group: ObjectGroup): number {
  return Math.max(
    Math.abs(group.scale[0]),
    Math.abs(group.scale[1]),
    Math.abs(group.scale[2]),
  );
}

/**
 * Conservative world bounding-sphere radius of the selected subtree, centered
 * at its pivot (getGizmoWorldPosition). Rotations preserve norms, so subtree
 * radius times ancestor max-scale product is a valid upper bound.
 */
function selectionBoundRadius(root: SceneRoot, itemId: string): number | null {
  const found = findItem(root, itemId);
  if (!found) return null;
  const ancestors = getItemAncestorGroups(root, itemId);
  if (!ancestors) return null;

  let r =
    found.item.kind === "layer"
      ? shapeBoundRadius(found.item)
      : maxAbsScale(found.item) * sceneBoundRadius(found.item.items);
  for (const group of ancestors) {
    r *= maxAbsScale(group);
  }
  return r;
}

/** Sphere around every selected item's bound sphere (outline-march gate). */
function selectionBounds(
  root: SceneRoot,
  ids: readonly string[],
): { center: [number, number, number]; radius: number } | null {
  const spheres: { c: [number, number, number]; r: number }[] = [];
  for (const id of topLevelSelection(root, ids)) {
    const c = getGizmoWorldPosition(root, id);
    const r = selectionBoundRadius(root, id);
    if (!c || r === null) return null;
    spheres.push({ c, r });
  }
  if (spheres.length === 0) return null;

  const center: [number, number, number] = [0, 0, 0];
  for (const { c } of spheres) {
    for (let k = 0; k < 3; k++) center[k] += c[k] / spheres.length;
  }
  let radius = 0;
  for (const { c, r } of spheres) {
    const dist = Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]);
    radius = Math.max(radius, dist + r);
  }
  return { center, radius };
}

function itemContributes(item: SceneItem): boolean {
  if (item.kind === "layer") return true;
  for (const child of item.items) {
    if (itemContributes(child)) return true;
  }
  return false;
}

/**
 * Compile items into postorder stack-machine instructions, baking `ctx` (the
 * accumulated ancestor transform) into every shape. Returns true when at
 * least one value was pushed; an OP is emitted only when both operands exist,
 * so empty groups contribute nothing instead of corrupting the stack.
 *
 * `unionOnlyAbove` is true when every CSG op from this list's result to the
 * stream root is hard union. A shape then also needs every op that consumes
 * it inside this list to be union — otherwise the shader must full-eval
 * (sphere dist is a lower bound; only min() keeps the zero-set identical).
 */
function compileItems(
  items: SceneItem[],
  ctx: BakeCtx,
  ancestors: ObjectGroup[],
  unionOnlyAbove: boolean,
  out: InstructionData[],
): boolean {
  const contributing: SceneItem[] = [];
  for (const item of items) {
    if (itemContributes(item)) contributing.push(item);
  }
  if (contributing.length === 0) return false;

  for (let i = 0; i < contributing.length; i++) {
    const item = contributing[i];
    let unionOnly = unionOnlyAbove;
    if (unionOnly) {
      if (i > 0 && item.op !== "union") unionOnly = false;
      if (unionOnly) {
        for (let j = i + 1; j < contributing.length; j++) {
          if (contributing[j].op !== "union") {
            unionOnly = false;
            break;
          }
        }
      }
    }

    if (item.kind === "layer") {
      pushShapeInstruction(item, ctx, ancestors, unionOnly, out);
    } else {
      compileItems(
        item.items,
        groupCtx(ctx, item),
        [...ancestors, item],
        unionOnly,
        out,
      );
    }
    if (i > 0) pushOpInstruction(item.op, item.smoothK, out);
  }
  return true;
}

function buildGpuData(root: SceneRoot): {
  instructions: InstructionData[];
  objectInfos: ObjectInfoData[];
  objectCount: number;
} {
  const instructions: InstructionData[] = [];
  const objectInfos: ObjectInfoData[] = [];

  if (root.items.length > 0) {
    compileItems(root.items, identityCtx(), [], true, instructions);
    if (instructions.length > 0) {
      objectInfos.push({ start: 0, count: instructions.length });
    }
  }

  const objectCount = objectInfos.length;

  while (instructions.length < MAX_INSTRUCTIONS) {
    instructions.push(EMPTY_INSTRUCTION);
  }
  while (objectInfos.length < MAX_GPU_OBJECTS) {
    objectInfos.push(EMPTY_OBJECT_INFO);
  }

  return { instructions, objectInfos, objectCount };
}

function buildSelectionGpuData(
  root: SceneRoot,
  selectedIds: readonly string[],
  rootSelected: boolean,
): {
  instructions: InstructionData[];
  count: number;
  enabled: boolean;
  usesSceneSdf: boolean;
} {
  const instructions: InstructionData[] = [];
  const ids = topLevelSelection(root, selectedIds);

  if (ids.length === 0) {
    const enabled = rootSelected && root.items.length > 0;

    while (instructions.length < MAX_INSTRUCTIONS) {
      instructions.push(EMPTY_INSTRUCTION);
    }

    return { instructions, count: 0, enabled, usesSceneSdf: enabled };
  }

  // Multi-selection outlines the hard union of each selected subtree.
  for (const id of ids) {
    const sub: InstructionData[] = [];
    if (!compileItemSubtreeInstructions(root, id, sub)) continue;
    const needsOp = instructions.length > 0;
    if (instructions.length + sub.length + (needsOp ? 1 : 0) > MAX_INSTRUCTIONS) break;
    instructions.push(...sub);
    if (needsOp) pushOpInstruction("union", 0, instructions);
  }

  const count = instructions.length;

  while (instructions.length < MAX_INSTRUCTIONS) {
    instructions.push(EMPTY_INSTRUCTION);
  }

  return { instructions, count, enabled: count > 0, usesSceneSdf: false };
}

/** Compile one scene item's CSG subtree with ancestor transforms baked in (for selection + pick). */
function compileItemSubtreeInstructions(
  root: SceneRoot,
  itemId: string,
  out: InstructionData[],
): boolean {
  const found = findItem(root, itemId);
  if (!found) return false;
  if (found.item.kind === "group" && found.item.items.length === 0) return false;

  const ancestors = getAncestorGroups(root, found.container.id);
  let ctx = identityCtx();
  for (const group of ancestors) {
    ctx = groupCtx(ctx, group);
  }

  if (found.item.kind === "layer") {
    pushShapeInstruction(found.item, ctx, ancestors, true, out);
    return true;
  }
  return compileItems(
    found.item.items,
    groupCtx(ctx, found.item),
    [...ancestors, found.item],
    true,
    out,
  );
}

function vec3xyz(v: ReturnType<typeof d.vec3f>): [number, number, number] {
  return [v.x, v.y, v.z];
}

function assertNear(got: number, want: number, label: string): void {
  if (Math.abs(got - want) > 1e-5) {
    throw new Error(`shape bound gate: ${label} got=${got} want=${want}`);
  }
}

function testSphere(
  id: string,
  position: [number, number, number],
  op: OpType = "union",
): ShapeLayer {
  return {
    kind: "layer",
    id,
    shapeType: "sphere",
    name: id,
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    params: [0.5, 0, 0, 0],
    op,
    smoothK: 0,
  };
}

function compileFlags(items: SceneItem[]): InstructionData[] {
  const out: InstructionData[] = [];
  compileItems(items, identityCtx(), [], true, out);
  return out.filter((instr) => instr.opcode === OPCODE_PUSH_SHAPE);
}

/** Flags + world sphere. Runs once at import (same convention as bake.ts). */
function assertShapeBoundGate(): void {
  const unioned = compileFlags([
    testSphere("a", [2, 0, 0]),
    testSphere("b", [-2, 0, 0], "union"),
  ]);
  if (unioned.length !== 2) {
    throw new Error(`shape bound gate: expected 2 union shapes, got ${unioned.length}`);
  }
  if (unioned[0].unionOnly !== 1 || unioned[1].unionOnly !== 1) {
    throw new Error("shape bound gate: hard-union siblings must set unionOnly");
  }
  const [ax, ay, az] = vec3xyz(unioned[0].boundCenter);
  assertNear(ax, 2, "union a.x");
  assertNear(ay, 0, "union a.y");
  assertNear(az, 0, "union a.z");
  assertNear(unioned[0].boundRadius, 0.5 + SHAPE_BOUND_EPS, "union a radius");

  const mixed = compileFlags([
    testSphere("a", [0, 0, 0]),
    testSphere("b", [3, 0, 0], "union"),
    testSphere("c", [0, 3, 0], "subtract"),
  ]);
  if (mixed.some((instr) => instr.unionOnly !== 0)) {
    throw new Error("shape bound gate: subtract anywhere above must clear unionOnly");
  }

  const sUnioned = compileFlags([
    testSphere("a", [0, 0, 0]),
    testSphere("b", [1, 0, 0], "sUnion"),
  ]);
  if (sUnioned.some((instr) => instr.unionOnly !== 0)) {
    throw new Error("shape bound gate: sUnion must clear unionOnly");
  }

  const group: ObjectGroup = {
    kind: "group",
    id: "g",
    name: "g",
    position: [1, 0, 0],
    rotation: [0, 0, 0],
    scale: [2, 2, 2],
    op: "union",
    smoothK: 0,
    items: [testSphere("inner", [0.5, 0, 0])],
  };
  const nested = compileFlags([group]);
  if (nested.length !== 1 || nested[0].unionOnly !== 1) {
    throw new Error("shape bound gate: scaled group child should stay unionOnly");
  }
  const [nx, ny, nz] = vec3xyz(nested[0].boundCenter);
  assertNear(nx, 2, "group child x");
  assertNear(ny, 0, "group child y");
  assertNear(nz, 0, "group child z");
  assertNear(nested[0].boundRadius, 1 + SHAPE_BOUND_EPS, "group child radius");

  const subtractGroup: ObjectGroup = {
    ...group,
    id: "sg",
    items: [testSphere("u0", [0, 0, 0]), testSphere("u1", [1, 0, 0], "union")],
  };
  const underSubtract = compileFlags([
    testSphere("base", [0, 0, 0]),
    { ...subtractGroup, op: "subtract" },
  ]);
  if (underSubtract.some((instr) => instr.unionOnly !== 0)) {
    throw new Error("shape bound gate: subtract-group subtree must full-eval");
  }

  const innerSub: ObjectGroup = {
    kind: "group",
    id: "is",
    name: "is",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    op: "union",
    smoothK: 0,
    items: [testSphere("a", [0, 0, 0]), testSphere("b", [1, 0, 0], "subtract")],
  };
  const inner = compileFlags([
    innerSub,
    testSphere("c", [2, 0, 0], "union"),
  ]);
  if (inner.length !== 3) {
    throw new Error(`shape bound gate: expected 3 inner-sub shapes, got ${inner.length}`);
  }
  if (inner[0].unionOnly !== 0 || inner[1].unionOnly !== 0) {
    throw new Error("shape bound gate: inner subtract must clear operand flags");
  }
  if (inner[2].unionOnly !== 1) {
    throw new Error("shape bound gate: union sibling of subtract-group stays unionOnly");
  }
}

assertShapeBoundGate();

/** Canvas pick: layers only. Groups are selected from the hierarchy panel. */
function collectPickableLayerIds(items: SceneItem[], out: string[]): void {
  for (const item of items) {
    if (item.kind === "layer") {
      out.push(item.id);
    } else if (item.items.length > 0) {
      collectPickableLayerIds(item.items, out);
    }
  }
}

function buildPickGpuData(root: SceneRoot): {
  instructions: InstructionData[];
  objectInfos: ObjectInfoData[];
  objectCount: number;
  itemIds: string[];
} {
  const instructions: InstructionData[] = [];
  const objectInfos: ObjectInfoData[] = [];
  const itemIds: string[] = [];

  const pickIds: string[] = [];
  collectPickableLayerIds(root.items, pickIds);

  for (const id of pickIds) {
    if (itemIds.length >= MAX_PICK_OBJECTS) break;

    const slot: InstructionData[] = [];
    if (!compileItemSubtreeInstructions(root, id, slot) || slot.length === 0) {
      continue;
    }
    if (instructions.length + slot.length > MAX_PICK_INSTRUCTIONS) break;

    const start = instructions.length;
    instructions.push(...slot);
    objectInfos.push({ start, count: slot.length });
    itemIds.push(id);
  }

  const objectCount = objectInfos.length;

  while (instructions.length < MAX_PICK_INSTRUCTIONS) {
    instructions.push(EMPTY_INSTRUCTION);
  }
  while (objectInfos.length < MAX_PICK_OBJECTS) {
    objectInfos.push(EMPTY_OBJECT_INFO);
  }

  return { instructions, objectInfos, objectCount, itemIds };
}

const DRAG_THRESHOLD_PX = 4;
const PICK_READBACK_BYTES_PER_ROW = 256;

const GIZMO_AXIS_DIR: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const GIZMO_AXIS_ID: Record<GizmoHandle, number> = {
  x: 1,
  y: 2,
  z: 3,
  c: 4,
};

function axisIdToCursor(axis: GizmoHandle | null): string {
  if (!axis) return "default";
  if (axis === "x") return "ew-resize";
  if (axis === "y") return "ns-resize";
  return "nwse-resize";
}

function readPickIdFromBytes(data: Uint8Array): number {
  return Math.max(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0);
}

const PICK_AXIS_ID: Record<number, GizmoHandle> = {
  1: "x",
  2: "y",
  3: "z",
  4: "c",
};

function axisFromPickByte(pickId: number): GizmoHandle | null {
  return PICK_AXIS_ID[pickId] ?? null;
}

export function useGpu(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let animFrameId = 0;
    let registeredCleanup: (() => void) | undefined;

    tgpu.init().then((root) => {
      if (cancelled) {
        root.destroy();
        return;
      }

      const context = root.configureContext({
        canvas,
        alphaMode: "premultiplied",
      });

      const {
        pipeline,
        cameraUniforms,
        sceneUniforms,
        selectionUniforms,
        gizmoUniforms,
        instructionsBuffer,
        objectInfoBuffer,
        selectionInstructionsBuffer,
        pickInstructionsBuffer,
        pickObjectInfoBuffer,
        pickUniforms,
        hoverUniforms,
        qualityUniforms,
        imageSdfTexture,
      } = createShader(root);

      // CPU mirror of the image SDF texture array (f16 bit patterns); "far
      // outside" so an empty or still-decoding slot renders as nothing.
      const imageTexels = new Uint16Array(IMAGE_SDF_RES * IMAGE_SDF_RES * MAX_IMAGES).fill(
        IMAGE_SDF_EMPTY_HALF,
      );
      imageSdfTexture.write(imageTexels);
      imageSlots.clear();

      function uploadImageSlots(sceneRoot: SceneRoot) {
        const added = syncImageSlots(sceneRoot);
        if (added.length === 0) return;
        const layerTexels = IMAGE_SDF_RES * IMAGE_SDF_RES;
        for (const [, slot] of added) {
          imageTexels.fill(IMAGE_SDF_EMPTY_HALF, slot * layerTexels, (slot + 1) * layerTexels);
        }
        imageSdfTexture.write(imageTexels);
        for (const [sdf, slot] of added) {
          decodeSdfPng(sdf).then(
            (texels) => {
              if (cancelled || imageSlots.get(sdf) !== slot) return;
              imageTexels.set(texels, slot * layerTexels);
              imageSdfTexture.write(imageTexels);
            },
            () => {
              /* undecodable PNG (hostile hash): slot stays empty */
            },
          );
        }
      }

      const pickFormat = navigator.gpu.getPreferredCanvasFormat();
      let pickTexture = root.device.createTexture({
        size: [1, 1],
        format: pickFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      let pickTextureView = pickTexture.createView();
      const pickReadbackBuffer = root.device.createBuffer({
        size: PICK_READBACK_BYTES_PER_ROW,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      function resizePickTarget(width: number, height: number) {
        pickTexture.destroy();
        pickTexture = root.device.createTexture({
          size: [width, height],
          format: pickFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        pickTextureView = pickTexture.createView();
      }

      let pickItemIds: string[] = [];

      let pointerDown = false;
      let dragged = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let rotX = 0.3;
      // Looking down at the scene (+y is down on screen), grid plane in view.
      let rotY = 0.4;
      let distance = 2.5;
      /** Live orbit preview while dragging; cleared on pointer up. */
      let orbitPreviewMouse: ReturnType<typeof d.vec2f> | null = null;
      let orbitPreviewRot: [number, number] | null = null;

      function getCameraRot(): [number, number] {
        return orbitPreviewRot ?? [rotX, rotY];
      }

      let lastSelectedIds: string[] = [];
      let lastRootSelected = false;
      let lastRenderMode: RenderMode | null = null;
      let lastQuality = useRenderStore.getState().quality;
      let targetMs = 1000 / QUALITY_PRESETS[lastQuality].fpsCap;
      let sceneGpuDirty = true;
      let pickInProgress = false;

      let gizmoDragging = false;
      let gizmoHoverAxis: GizmoHandle | null = null;
      let gizmoDragAxis: GizmoHandle | null = null;
      let gizmoDragStartWorld: [number, number, number] | null = null;
      let gizmoDragScreen: AxisScreenDragState | null = null;
      let gizmoDragRing: RingDragState | null = null;
      let gizmoDragScale: ScaleDragState | null = null;
      let gizmoDragItemId: string | null = null;
      let gizmoDragAncestors: ObjectGroup[] | null = null;
      /** Set when the drag drives a multi-selection (world-space pivot). */
      let gizmoDragGroup: GroupDragTarget[] | null = null;
      let cachedPickObjectCount = 0;

      let hoverGpuSeq = 0;
      let hoverPickRunning = false;
      let pendingHoverPick: {
        x: number;
        y: number;
        seq: number;
      } | null = null;

      function isGizmoVisibleMode(): boolean {
        const mode = useGizmoStore.getState().mode;
        return mode === "translate" || mode === "rotate" || mode === "scale";
      }

      function gizmoModeUniform(): number {
        const mode = useGizmoStore.getState().mode;
        if (mode === "rotate") return GIZMO_MODE_ROTATE;
        if (mode === "scale") return GIZMO_MODE_SCALE;
        return GIZMO_MODE_TRANSLATE;
      }

      function gizmoPickMode(): GizmoPickMode {
        return useGizmoStore.getState().mode;
      }

      function writeGizmoDisabled() {
        gizmoUniforms.write({
          enabled: 0,
          activeAxis: 0,
          mode: 0,
          _pad0: 0,
          position: d.vec3f(0, 0, 0),
          _pad: 0,
          scale: 0,
          axisX: d.vec3f(1, 0, 0),
          _padX: 0,
          axisY: d.vec3f(0, 1, 0),
          _padY: 0,
          axisZ: d.vec3f(0, 0, 1),
          _padZ: 0,
        });
      }

      function clearGizmoInteraction() {
        if (gizmoDragging) endGizmoDrag();
        gizmoHoverAxis = null;
        hoverGpuSeq += 1;
        pendingHoverPick = null;
        canvas!.style.cursor = "default";
      }

      function selectionGizmoFrame(sceneRoot: SceneRoot) {
        const { selectedIds, selectedItemId } = useSceneStore.getState();
        return getSelectionGizmoFrame(sceneRoot, selectedIds, selectedItemId);
      }

      function updateGizmoUniforms(
        sceneRoot: SceneRoot,
        cameraDistance: number,
        activeAxis: GizmoHandle | null,
      ) {
        const frame = isGizmoVisibleMode() ? selectionGizmoFrame(sceneRoot) : null;
        if (!frame) {
          writeGizmoDisabled();
          return;
        }
        const { pivot: pivotWorld, axes } = frame;

        const visualScale = gizmoVisualScaleForDistance(cameraDistance);
        gizmoUniforms.write({
          enabled: 1,
          activeAxis: activeAxis ? GIZMO_AXIS_ID[activeAxis] : 0,
          mode: gizmoModeUniform(),
          _pad0: 0,
          position: d.vec3f(pivotWorld[0], pivotWorld[1], pivotWorld[2]),
          _pad: 0,
          scale: visualScale,
          axisX: d.vec3f(axes.x[0], axes.x[1], axes.x[2]),
          _padX: 0,
          axisY: d.vec3f(axes.y[0], axes.y[1], axes.y[2]),
          _padY: 0,
          axisZ: d.vec3f(axes.z[0], axes.z[1], axes.z[2]),
          _padZ: 0,
        });
      }

      function setItemWorldPosition(
        itemId: string,
        worldPos: [number, number, number],
        ancestors: ObjectGroup[],
      ) {
        const found = findItem(useSceneStore.getState().root, itemId);
        if (!found) return;

        const localPos = worldToItemLocalPosition(worldPos, ancestors);
        const { updateLayer, updateGroup } = useSceneStore.getState();

        if (found.item.kind === "layer") {
          updateLayer(found.container.id, found.item.id, { position: localPos });
        } else {
          updateGroup(found.item.id, { position: localPos });
        }
      }

      /**
       * Runs the pick shader for the single pixel under the cursor (scissor)
       * and reads its id back. Callers own pickInProgress (one readback at a
       * time). pickPass is restored right after submit: queue writes are
       * ordered with submits, so normal frames keep drawing during readback.
       */
      async function readPickPixel(
        pickPass: number,
        objectCount: number,
        clientX: number,
        clientY: number,
      ): Promise<number | null> {
        const px = clientToPickPixel(clientX, clientY, canvas!);
        if (!px) return null;
        pickUniforms.write({ objectCount, pickPass });

        const encoder = root.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: pickTextureView, loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" },
          ],
        });
        pass.setScissorRect(px.x, px.y, 1, 1);
        pipeline.with(pass).draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: pickTexture, origin: { x: px.x, y: px.y, z: 0 } },
          { buffer: pickReadbackBuffer, bytesPerRow: PICK_READBACK_BYTES_PER_ROW },
          { width: 1, height: 1 },
        );
        root.device.queue.submit([encoder.finish()]);
        pickUniforms.write({ objectCount: cachedPickObjectCount, pickPass: 0 });
        await root.device.queue.onSubmittedWorkDone();

        await pickReadbackBuffer.mapAsync(GPUMapMode.READ);
        const id = readPickIdFromBytes(new Uint8Array(pickReadbackBuffer.getMappedRange()));
        pickReadbackBuffer.unmap();
        return id;
      }

      async function pickGizmoAxisGpu(
        clientX: number,
        clientY: number,
      ): Promise<GizmoGpuPickResult> {
        if (pickInProgress) return { axis: null, skipped: true };
        if (!isGizmoVisibleMode()) return { axis: null, skipped: false };

        const { root: sceneRoot, selectedItemId } = useSceneStore.getState();
        if (!selectedItemId) return { axis: null, skipped: false };

        pickInProgress = true;
        try {
          syncCameraUniform();
          updateGizmoUniforms(sceneRoot, distance, gizmoHoverAxis);

          const pickId = await readPickPixel(PICK_PASS_GIZMO, 0, clientX, clientY);
          if (pickId === null) return { axis: null, skipped: false };
          return { axis: axisFromPickByte(pickId), skipped: false };
        } finally {
          pickUniforms.write({
            objectCount: cachedPickObjectCount,
            pickPass: 0,
          });
          pickInProgress = false;
        }
      }

      async function drainGizmoHoverPicks() {
        if (hoverPickRunning) return;
        hoverPickRunning = true;
        try {
          while (pendingHoverPick) {
            const pick = pendingHoverPick;
            pendingHoverPick = null;

            let result = await pickGizmoAxisGpu(pick.x, pick.y);
            while (result.skipped && pick.seq === hoverGpuSeq) {
              pendingHoverPick = pendingHoverPick ?? pick;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              if (pick.seq !== hoverGpuSeq) break;
              const latest = pendingHoverPick ?? pick;
              pendingHoverPick = null;
              result = await pickGizmoAxisGpu(latest.x, latest.y);
              if (latest.seq !== hoverGpuSeq) break;
            }

            if (pick.seq !== hoverGpuSeq) continue;
            if (result.skipped) continue;

            const frame = selectionGizmoFrame(useSceneStore.getState().root);
            if (!frame) {
              gizmoHoverAxis = null;
              canvas!.style.cursor = "default";
              continue;
            }

            const { pivot: pivotWorld, axes } = frame;
            const mode = gizmoPickMode();
            const [rx, ry] = getCameraRot();
            const gizmoScale = gizmoVisualScaleForDistance(distance);

            const stabilized = result.axis
              ? stabilizeGizmoHoverAxis(
                  pick.x,
                  pick.y,
                  canvas!,
                  rx,
                  ry,
                  distance,
                  pivotWorld,
                  gizmoScale,
                  result.axis,
                  gizmoHoverAxis,
                  mode,
                  axes,
                )
              : pickGizmoAxisScreen(
                  mode,
                  pick.x,
                  pick.y,
                  canvas!,
                  rx,
                  ry,
                  distance,
                  pivotWorld,
                  gizmoScale,
                  axes,
                  gizmoHoverAxis,
                );
            gizmoHoverAxis = stabilized;
            canvas!.style.cursor = axisIdToCursor(stabilized);
          }
        } finally {
          hoverPickRunning = false;
          if (pendingHoverPick) void drainGizmoHoverPicks();
        }
      }

      async function tryStartGizmoDrag(
        clientX: number,
        clientY: number,
      ): Promise<boolean> {
        if (!isGizmoVisibleMode()) return false;

        const sceneRoot = useSceneStore.getState().root;
        const frame = selectionGizmoFrame(sceneRoot);
        if (!frame) return false;
        // Single item: its own drag path below. Several: world-space group drag.
        const selectedItemId = frame.ids[0];
        const group = frame.ids.length > 1 ? beginGroupDrag(sceneRoot, frame.ids) : null;

        const found = findItem(sceneRoot, selectedItemId);
        if (!found) return false;

        const pivotWorld = frame.pivot;
        const ancestors = getItemAncestorGroups(sceneRoot, selectedItemId);
        if (ancestors === null) return false;

        const mode = gizmoPickMode();
        const axes = frame.axes;
        const [rx, ry] = getCameraRot();
        const gizmoScale = gizmoVisualScaleForDistance(distance);

        let axis: GizmoHandle | null = null;

        if (
          gizmoHoverAxis &&
          isGizmoAxisNearScreen(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            gizmoScale,
            gizmoHoverAxis,
            mode,
            axes,
          )
        ) {
          axis = gizmoHoverAxis;
        } else {
          const gpuPick = await pickGizmoAxisGpu(clientX, clientY);
          axis = gpuPick.axis
            ? stabilizeGizmoHoverAxis(
                clientX,
                clientY,
                canvas!,
                rx,
                ry,
                distance,
                pivotWorld,
                gizmoScale,
                gpuPick.axis,
                gizmoHoverAxis,
                mode,
                axes,
              )
            : pickGizmoAxisScreen(
                mode,
                clientX,
                clientY,
                canvas!,
                rx,
                ry,
                distance,
                pivotWorld,
                gizmoScale,
                axes,
                gizmoHoverAxis,
              );
        }
        if (!axis) return false;

        if (mode === "scale") {
          if (!axes) return false;
          const scaleDrag = beginScaleDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            axis,
            axes,
            gizmoScale,
            found.item.scale,
          );
          if (!scaleDrag) return false;

          gizmoDragging = true;
          gizmoDragAxis = axis;
          gizmoDragItemId = selectedItemId;
          gizmoDragGroup = group;
          gizmoDragAncestors = ancestors;
          gizmoDragStartWorld = pivotWorld;
          gizmoDragScreen = null;
          gizmoDragRing = null;
          gizmoDragScale = scaleDrag;
          gizmoHoverAxis = axis;
          pauseHistory();
          canvas!.style.cursor = axisIdToCursor(axis);
          return true;
        }

        // Center handle exists only on the scale gizmo.
        if (axis === "c") return false;

        if (mode === "rotate") {
          if (!axes) return false;
          const worldAxis = axes[axis];
          const ringDrag = beginRingDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            worldAxis,
            axis,
            found.item.rotation,
          );
          if (!ringDrag) return false;

          gizmoDragging = true;
          gizmoDragAxis = axis;
          gizmoDragItemId = selectedItemId;
          gizmoDragGroup = group;
          gizmoDragAncestors = ancestors;
          gizmoDragStartWorld = pivotWorld;
          gizmoDragScreen = null;
          gizmoDragRing = ringDrag;
          gizmoDragScale = null;
          gizmoHoverAxis = axis;
          pauseHistory();
          canvas!.style.cursor = "grabbing";
          return true;
        }

        const axisDir = GIZMO_AXIS_DIR[axis];
        const dragScreen = beginAxisScreenDrag(
          clientX,
          clientY,
          canvas!,
          rx,
          ry,
          distance,
          pivotWorld,
          axisDir,
          gizmoScale * GIZMO_ARROW_LENGTH_RATIO,
        );
        if (!dragScreen) return false;

        gizmoDragging = true;
        gizmoDragAxis = axis;
        gizmoDragItemId = selectedItemId;
        gizmoDragGroup = group;
        gizmoDragAncestors = ancestors;
        gizmoDragStartWorld = pivotWorld;
        gizmoDragScreen = dragScreen;
        gizmoDragRing = null;
        gizmoDragScale = null;
        gizmoHoverAxis = axis;
        pauseHistory();
        canvas!.style.cursor = axisIdToCursor(axis);
        return true;
      }

      function updateGizmoDrag(clientX: number, clientY: number) {
        if (!gizmoDragging || !gizmoDragAxis || !gizmoDragItemId) {
          return;
        }

        const [rx, ry] = getCameraRot();

        if (gizmoDragScale) {
          const factor = scaleFactorFromScreenDrag(
            clientX,
            clientY,
            gizmoDragScale,
          );
          if (gizmoDragGroup && gizmoDragStartWorld) {
            useSceneStore.getState().updateTransforms(
              groupScalePatches(gizmoDragGroup, gizmoDragStartWorld, gizmoDragAxis, factor),
            );
            return;
          }
          applyScaleFactorToItem(
            useSceneStore.getState().root,
            gizmoDragItemId,
            gizmoDragScale,
            factor,
          );
          return;
        }

        if (gizmoDragRing) {
          const totalAngle = ringTotalAngleFromScreenDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            gizmoDragRing,
          );
          if (totalAngle !== null && gizmoDragGroup) {
            gizmoDragRing.totalAngleRad = totalAngle; // unwrap reference for the next move
            useSceneStore.getState().updateTransforms(
              groupRotatePatches(
                gizmoDragGroup,
                gizmoDragRing.pivotWorld,
                gizmoDragRing.worldAxis,
                totalAngle,
              ),
            );
          } else if (totalAngle !== null) {
            applyWorldRotationToItem(
              useSceneStore.getState().root,
              gizmoDragItemId,
              totalAngle,
              gizmoDragRing,
            );
          }
          return;
        }

        if (
          !gizmoDragStartWorld ||
          !gizmoDragScreen ||
          !gizmoDragAncestors ||
          gizmoDragAxis === "c"
        ) {
          return;
        }

        const axisDir = GIZMO_AXIS_DIR[gizmoDragAxis];
        const deltaT = axisDeltaFromScreenDrag(
          clientX,
          clientY,
          gizmoDragScreen,
        );

        if (gizmoDragGroup) {
          useSceneStore.getState().updateTransforms(
            groupTranslatePatches(gizmoDragGroup, [
              axisDir[0] * deltaT,
              axisDir[1] * deltaT,
              axisDir[2] * deltaT,
            ]),
          );
          return;
        }

        const newPivot: [number, number, number] = [
          gizmoDragStartWorld[0] + axisDir[0] * deltaT,
          gizmoDragStartWorld[1] + axisDir[1] * deltaT,
          gizmoDragStartWorld[2] + axisDir[2] * deltaT,
        ];
        const freshAncestors = getItemAncestorGroups(
          useSceneStore.getState().root,
          gizmoDragItemId,
        );
        if (!freshAncestors) return;
        setItemWorldPosition(gizmoDragItemId, newPivot, freshAncestors);
      }

      function endGizmoDrag() {
        if (!gizmoDragging) return;
        gizmoDragging = false;
        gizmoDragAxis = null;
        gizmoDragStartWorld = null;
        gizmoDragScreen = null;
        gizmoDragRing = null;
        gizmoDragScale = null;
        gizmoDragItemId = null;
        gizmoDragAncestors = null;
        gizmoDragGroup = null;
        resumeHistory();
      }

      function updateGizmoHover(clientX: number, clientY: number) {
        if (!isGizmoVisibleMode()) {
          hoverGpuSeq += 1;
          pendingHoverPick = null;
          gizmoHoverAxis = null;
          canvas!.style.cursor = "default";
          return;
        }

        const { selectedItemId } = useSceneStore.getState();
        if (!selectedItemId) {
          hoverGpuSeq += 1;
          pendingHoverPick = null;
          gizmoHoverAxis = null;
          canvas!.style.cursor = "default";
          return;
        }

        const seq = ++hoverGpuSeq;
        pendingHoverPick = { x: clientX, y: clientY, seq };
        void drainGizmoHoverPicks();
      }

      /** `additive`: Cmd/Ctrl/Shift-click toggles the hit item in the selection. */
      async function pickAt(clientX: number, clientY: number, additive: boolean) {
        // A hover pick runs on almost every mouse move; a click must wait for
        // it instead of being dropped (quick move-then-click lost selections).
        while (pickInProgress) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          if (cancelled) return;
        }
        pickInProgress = true;

        try {
          const pickId = await readPickPixel(1, cachedPickObjectCount, clientX, clientY);
          if (pickId === null) return;

          const { root: sceneRoot, selectItem, toggleSelected, deselect } =
            useSceneStore.getState();

          if (pickId === 0) {
            if (!additive) deselect();
            return;
          }

          const itemId = pickItemIds[pickId - 1];
          if (!itemId) return;

          const found = findItem(sceneRoot, itemId);
          if (!found || found.item.kind !== "layer") return;

          if (additive) toggleSelected(itemId);
          else selectItem(found.container.id, itemId);
        } finally {
          pickUniforms.write({
            objectCount: cachedPickObjectCount,
            pickPass: 0,
          });
          pickInProgress = false;
        }
      }

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        void tryStartGizmoDrag(e.clientX, e.clientY).then((started) => {
          if (started) return;
          pointerDown = true;
          dragged = false;
          orbitPreviewMouse = null;
          orbitPreviewRot = null;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
        });
      };

      // ── Object hover glow: the shape under the cursor, cross-faded ──
      let hoverItemId: string | null = null;
      let hoverQueued: { x: number; y: number } | null = null;
      let hoverPicking = false;
      /** Min gap between hover picks: each one stalls a frame on readback. */
      const HOVER_PICK_GAP_MS = 45;

      function clearObjectHover() {
        hoverQueued = null;
        hoverItemId = null;
      }

      async function drainObjectHover() {
        if (hoverPicking) return;
        hoverPicking = true;
        try {
          while (hoverQueued) {
            if (pickInProgress) {
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              continue;
            }
            const { x, y } = hoverQueued;
            hoverQueued = null;
            pickInProgress = true;
            let id: number | null = null;
            try {
              id = await readPickPixel(1, cachedPickObjectCount, x, y);
            } finally {
              pickUniforms.write({ objectCount: cachedPickObjectCount, pickPass: 0 });
              pickInProgress = false;
            }
            // A newer move may have cleared hover (drag start, left the canvas).
            if (id !== null && hoverQueued === null && !pointerDown && !gizmoDragging) {
              hoverItemId = id > 0 ? (pickItemIds[id - 1] ?? null) : null;
            }
            await new Promise((r) => setTimeout(r, HOVER_PICK_GAP_MS));
          }
        } finally {
          hoverPicking = false;
        }
      }

      /** `cur` follows the cursor; `prev` is the shape just left, fading out. */
      let glowCur: { id: string | null; s: number } = { id: null, s: 0 };
      let glowPrev: { id: string | null; s: number } = { id: null, s: 0 };
      let hoverWritten = { pickId: 0, strength: 0, prevPickId: 0, prevStrength: 0 };

      /** Selected itself, inside a selected group, or the whole scene is selected. */
      function isInSelection(itemId: string): boolean {
        const { root: sceneRoot, selectedIds, rootSelected } = useSceneStore.getState();
        if (rootSelected || selectedIds.includes(itemId)) return true;
        const ancestors = getItemAncestorGroups(sceneRoot, itemId) ?? [];
        return ancestors.some((g) => selectedIds.includes(g.id));
      }

      function updateHoverUniforms(dt: number) {
        // No hover glow on a gizmo handle (that's the target) or on the
        // selection (it already glows).
        const target =
          gizmoHoverAxis || !hoverItemId || isInSelection(hoverItemId) ? null : hoverItemId;
        if (target !== null && target !== glowCur.id) {
          if (target === glowPrev.id) {
            // Back onto the shape still fading out: pick it up where it is.
            [glowCur, glowPrev] = [glowPrev, glowCur];
          } else {
            if (glowCur.id !== null) glowPrev = glowCur;
            glowCur = { id: target, s: 0 };
          }
        }
        const k = Math.min(1, dt * 10);
        const ease = (v: number, to: number) => {
          const next = v + (to - v) * k;
          return Math.abs(to - next) < 0.002 ? to : next;
        };
        glowCur.s = ease(glowCur.s, target !== null && target === glowCur.id ? 1 : 0);
        glowPrev.s = ease(glowPrev.s, 0);
        if (glowPrev.s === 0) glowPrev.id = null;
        if (glowCur.s === 0 && target === null) glowCur.id = null;

        // Pick ids are rebuilt on every upload, so resolve the items each frame.
        const slot = (g: { id: string | null; s: number }) => {
          const index = g.id ? pickItemIds.indexOf(g.id) : -1;
          return { pickId: index + 1, strength: index >= 0 ? g.s : 0 };
        };
        const cur = slot(glowCur), prev = slot(glowPrev);
        const want = { pickId: cur.pickId, strength: cur.strength, prevPickId: prev.pickId, prevStrength: prev.strength };
        if (
          want.pickId !== hoverWritten.pickId || want.strength !== hoverWritten.strength ||
          want.prevPickId !== hoverWritten.prevPickId || want.prevStrength !== hoverWritten.prevStrength
        ) {
          hoverUniforms.write(want);
          hoverWritten = want;
        }
      }

      const onPointerMove = (e: PointerEvent) => {
        if (gizmoDragging) {
          clearObjectHover();
          updateGizmoDrag(e.clientX, e.clientY);
          return;
        }

        if (!pointerDown) {
          // Only the canvas itself: panels sit on top of it.
          if (e.target === canvas) {
            hoverQueued = { x: e.clientX, y: e.clientY };
            void drainObjectHover();
          } else {
            clearObjectHover();
          }
          updateGizmoHover(e.clientX, e.clientY);
          return;
        }
        clearObjectHover();

        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
          dragged = true;
          canvas!.style.cursor = "grabbing";
        }
        if (!dragged) return;
        const totalDx =
          ((e.clientX - dragStartX) / window.innerWidth) * Math.PI * 2;
        const totalDy =
          ((e.clientY - dragStartY) / window.innerHeight) * Math.PI * 2;
        const previewRx = rotX + totalDx;
        const previewRy = rotY + totalDy;
        orbitPreviewRot = [previewRx, previewRy];
        orbitPreviewMouse = d.vec2f(previewRx, previewRy);
      };

      const onPointerUp = (e: PointerEvent) => {
        if (gizmoDragging && e.button === 0) {
          endGizmoDrag();
          updateGizmoHover(e.clientX, e.clientY);
          return;
        }

        if (!pointerDown || e.button !== 0) return;
        pointerDown = false;

        if (dragged) {
          rotX += ((e.clientX - dragStartX) / window.innerWidth) * Math.PI * 2;
          rotY += ((e.clientY - dragStartY) / window.innerHeight) * Math.PI * 2;
          orbitPreviewMouse = null;
          orbitPreviewRot = null;
          updateGizmoHover(e.clientX, e.clientY);
        } else {
          void pickAt(e.clientX, e.clientY, e.metaKey || e.ctrlKey || e.shiftKey);
        }
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 10.0 : e.deltaY;
        distance = Math.max(
          0.5,
          Math.min(20.0, distance * Math.exp(px * 0.0001)),
        );
        syncCameraUniform();
      };

      const unsubGizmoMode = useGizmoStore.subscribe((state, prev) => {
        if (state.mode === prev.mode) return;
        clearGizmoInteraction();
      });

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerleave", clearObjectHover);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      function applyQualityPreset(qualityIndex: number) {
        const preset = QUALITY_PRESETS[qualityIndex];
        qualityUniforms.write({
          maxSteps: preset.maxSteps,
          reflSteps: preset.reflSteps,
          outlineSteps: preset.outlineSteps,
          _pad: 0,
        });
        targetMs = 1000 / preset.fpsCap;
        updateSize();
      }

      function updateSize() {
        const preset = QUALITY_PRESETS[useRenderStore.getState().quality];
        const dpr = dprForPreset(preset);
        canvas!.width = canvas!.clientWidth * dpr;
        canvas!.height = canvas!.clientHeight * dpr;
        if (canvas!.width > 0 && canvas!.height > 0) {
          resizePickTarget(canvas!.width, canvas!.height);
          syncCameraUniform();
        }
      }

      const startTime = performance.now();

      function syncCameraUniform() {
        const mouse = orbitPreviewMouse ?? d.vec2f(rotX, rotY);
        const aspect = getCanvasAspect(canvas!);
        cameraUniforms.write({
          time: (performance.now() - startTime) / 1000,
          aspect,
          mouse,
          distance,
        });
      }

      applyQualityPreset(lastQuality);

      const observer = new ResizeObserver(updateSize);
      observer.observe(canvas);
      let lastFrameTime = 0;
      let lastRoot: SceneRoot | null = null;

      function uploadSceneGpu(
        sceneRoot: SceneRoot,
        selectedIds: readonly string[],
        rootSelected: boolean,
        renderMode: RenderMode,
      ) {
        uploadImageSlots(sceneRoot);
        const { instructions, objectInfos, objectCount } = buildGpuData(sceneRoot);
        instructionsBuffer.write(instructions);
        objectInfoBuffer.write(objectInfos);
        sceneUniforms.write({
          objectCount,
          boundsRadius: sceneBoundRadius(sceneRoot.items) + 0.05,
          renderMode:
            renderMode === "classic" ? RENDER_MODE_CLASSIC : RENDER_MODE_CHROME,
          _pad1: 0,
          boundsCenter: d.vec3f(0, 0, 0),
          _pad2: 0,
        });

        const selection = buildSelectionGpuData(
          sceneRoot,
          selectedIds,
          rootSelected,
        );
        selectionInstructionsBuffer.write(selection.instructions);

        // Tight outline-march gate; falls back to scene bounds (root selection).
        let selBoundsCenter = d.vec3f(0, 0, 0);
        let selBoundsRadius = sceneBoundRadius(sceneRoot.items) + 0.05;
        if (selection.enabled && !selection.usesSceneSdf) {
          const bounds = selectionBounds(sceneRoot, selectedIds);
          if (bounds) {
            const { center, radius } = bounds;
            selBoundsCenter = d.vec3f(center[0], center[1], center[2]);
            selBoundsRadius = radius + GLOW_BAND_HI + 0.02;
          }
        }

        selectionUniforms.write({
          enabled: selection.enabled ? 1 : 0,
          usesSceneSdf: selection.usesSceneSdf ? 1 : 0,
          count: selection.count,
          boundsRadius: selBoundsRadius,
          boundsCenter: selBoundsCenter,
          _pad: 0,
        });

        const pick = buildPickGpuData(sceneRoot);
        pickInstructionsBuffer.write(pick.instructions);
        pickObjectInfoBuffer.write(pick.objectInfos);
        cachedPickObjectCount = pick.objectCount;
        pickUniforms.write({
          objectCount: cachedPickObjectCount,
          pickPass: 0,
        });
        pickItemIds = pick.itemIds;
      }

      const initialState = useSceneStore.getState();
      uploadSceneGpu(
        initialState.root,
        initialState.selectedIds,
        initialState.rootSelected,
        useRenderStore.getState().renderMode,
      );
      lastRoot = initialState.root;
      // Grow/shrink added and removed items; the store root stays untouched.
      const spawnAnim = new SpawnAnimator();
      let wasAnimating = false;
      let lastHoverFrame = 0;
      lastSelectedIds = initialState.selectedIds;
      lastRootSelected = initialState.rootSelected;
      lastRenderMode = useRenderStore.getState().renderMode;

      function frame(now: number) {
        if (now - lastFrameTime < targetMs) {
          animFrameId = requestAnimationFrame(frame);
          return;
        }
        lastFrameTime = now;

        const { root: sceneRoot, selectedIds, rootSelected } =
          useSceneStore.getState();
        const { renderMode, quality } = useRenderStore.getState();
        if (quality !== lastQuality) {
          applyQualityPreset(quality);
          lastQuality = quality;
        }
        if (lastRoot && sceneRoot !== lastRoot) spawnAnim.rootChanged(lastRoot, sceneRoot, now);
        const drawn = spawnAnim.frame(sceneRoot, now);
        if (
          sceneGpuDirty ||
          sceneRoot !== lastRoot ||
          selectedIds !== lastSelectedIds ||
          rootSelected !== lastRootSelected ||
          renderMode !== lastRenderMode ||
          drawn.animating ||
          wasAnimating // one more upload to land on the real root
        ) {
          uploadSceneGpu(drawn.root, selectedIds, rootSelected, renderMode);

          lastRoot = sceneRoot;
          lastSelectedIds = selectedIds;
          lastRootSelected = rootSelected;
          lastRenderMode = renderMode;
          sceneGpuDirty = false;
        }
        wasAnimating = drawn.animating;
        updateHoverUniforms(Math.min(0.1, (now - lastHoverFrame) / 1000));
        lastHoverFrame = now;

        // Highlight only while dragging; hover feedback stays cursor-only.
        const activeGizmoAxis = gizmoDragging ? gizmoDragAxis : null;
        updateGizmoUniforms(sceneRoot, distance, activeGizmoAxis);

        syncCameraUniform();
        pipeline.withColorAttachment({ view: context }).draw(3);
        // E2E and tooling wait on this; harmless in production.
        if (!canvas!.dataset.ready) canvas!.dataset.ready = "1";
        animFrameId = requestAnimationFrame(frame);
      }

      animFrameId = requestAnimationFrame(frame);

      registeredCleanup = () => {
        unsubGizmoMode();
        observer.disconnect();
        cancelAnimationFrame(animFrameId);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerleave", clearObjectHover);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        root.destroy();
        pickTexture.destroy();
        pickReadbackBuffer.destroy();
      };
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameId);
      registeredCleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
