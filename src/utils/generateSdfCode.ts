import {
  ALL_SHAPE_TYPES,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type SceneRoot,
  type ShapeLayer,
  type ShapeType,
} from "../store/sceneStore";
import { IMAGE_SDF_RES, IMAGE_SDF_STEP_PX } from "./imageSdf";
import { DEFAULT_MATERIAL, type Material } from "../store/material";
import {
  GLSL_HELPERS,
  MODIFIER_GLSL,
  MODIFIER_TG,
  MODIFIER_WGSL,
  TG_HELPERS,
  WGSL_HELPERS,
  primitiveCall,
} from "../sdf/primitives";
import { POINT_MODIFIERS, activeModifiers, type Modifier } from "../store/modifiers";
import { groupPlan, shapePlan } from "../sdf/itemBounds";
import { polarTurned, type ModifierPlan, type PolarReach } from "../sdf/modifierMath";

export type CodeLang = "typegpu" | "wgsl" | "glsl";

export interface GeneratedSdf {
  fnName: string;
  typegpu: string;
  wgsl: string;
  glsl: string;
}

export const PLACEHOLDER = "// Nothing to export - add shapes to the scene";

const DEG_TO_RAD = Math.PI / 180;

type V3 = readonly [number, number, number];

const isZero = (v: V3) => v.every((c) => Math.abs(c) < 1e-9);
const isOne = (v: V3) => v.every((c) => Math.abs(c - 1) < 1e-9);
const isUniform = (v: V3) => v[0] === v[1] && v[1] === v[2];
const minV = (v: V3) => Math.min(v[0], v[1], v[2]);
const mulV = (a: V3, b: V3): V3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const toRad = (deg: V3): V3 => [deg[0] * DEG_TO_RAD, deg[1] * DEG_TO_RAD, deg[2] * DEG_TO_RAD];

function fmt(n: number): string {
  const s = parseFloat(n.toFixed(6)).toString();
  return /[.e]/.test(s) ? s : s + ".0";
}

// ponytail: reciprocal-multiply instead of vec division for TypeGPU (no
// documented vec/vec `/` overload); full-precision literal keeps f32 parity.
function fmtRecip(n: number): string {
  const s = parseFloat((1 / n).toPrecision(9)).toString();
  return /[.e]/.test(s) ? s : s + ".0";
}

// ── IR ────────────────────────────────────────────────────────────────────────

interface ShapeRhs {
  kind: "shape";
  shape: ShapeType;
  point: string;
  pos: V3 | null;
  rotRad: V3 | null;
  /** Non-uniform accumulated ancestor scale — triggers unsheared-rotation trick. */
  accScl: V3 | null;
  scale: V3 | null;
  /** min(scale) * min(accScl) conservative distance factor. */
  factor: number;
  params: [number, number, number, number];
  /** Index into Ir.images for shape "image"; -1 when the layer has no baked SDF. */
  imageIndex: number;
  /** Edge rounding radius for shape "image" (local units). */
  imageRound: number;
  /** Own material, else nearest ancestor group's, else the default. */
  material: Material;
  /** Distance modifiers on the shape's own result (local units). */
  post: PostMod[];
}
interface VarRhs {
  kind: "var";
  name: string;
}
type Rhs = ShapeRhs | VarRhs;

type PostMod = { kind: "round" | "onion"; amount: number };
type RepeatMod = Extract<Modifier, { kind: "repeat" }>;
type PolarMod = Extract<Modifier, { kind: "polar" }>;
/** The copies an overlapping repeat / polar repeat loops over. */
/** The copies a repeat / polar repeat loops over (see withMods). */
type CopySphere = { c: V3; r: number };
type Copies =
  | { kind: "repeat"; mod: RepeatMod; gap: V3; copy: CopySphere }
  | { kind: "polar"; mod: PolarMod; reach: PolarReach; gap: [number, number]; copy: CopySphere };

type Stmt =
  | { t: "point"; name: string; from: string; pos: V3 | null; rotRad: V3 | null; scale: V3 | null }
  /** A shape's own local point (its transform), ahead of its point modifiers. */
  | { t: "shapePoint"; name: string; rhs: ShapeRhs }
  | { t: "pmod"; name: string; from: string; mod: Modifier }
  /** Repeat / polar repeat: union over the copies a point can be nearest to, `unit`: step space → result. */
  | { t: "loop"; acc: string; from: string; point: string; copies: Copies; unit: number; body: Stmt[]; result: string }
  | { t: "scale"; name: string; k: number }
  | { t: "post"; name: string; mod: PostMod }
  | { t: "def"; name: string; rhs: Rhs }
  | { t: "combine"; name: string; op: OpType; k: number; rhs: Rhs };

interface Ir {
  stmts: Stmt[];
  result: string | null;
  usedShapes: Set<ShapeType>;
  usesRotation: boolean;
  usesSmin: boolean;
  usesModifiers: boolean;
  /** Distinct baked image SDF data URLs, in order of first use. */
  images: string[];
}

const SMOOTH_OPS = new Set<OpType>(["sUnion", "sSubtract", "sIntersect"]);

function findItemIn(items: SceneItem[], itemId: string): SceneItem | null {
  for (const item of items) {
    if (item.id === itemId) return item;
    if (item.kind === "group") {
      const found = findItemIn(item.items, itemId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Build language-neutral statements mirroring the viewport shader math
 * (see src/gpu/shader.ts): per-group applyParentTransform, unsheared shape
 * rotation under non-uniform ancestor scale, min-scale distance factors.
 * Selected node's own position is dropped so the model sits at the origin.
 */
function buildIr(root: SceneRoot, selectedItemId: string | null): Ir {
  const stmts: Stmt[] = [];
  let sink = stmts;
  const usedShapes = new Set<ShapeType>();
  const images: string[] = [];
  let usesRotation = false;
  let usesSmin = false;
  let usesModifiers = false;
  let accN = 0;
  let ptN = 0;
  const emit = (stmt: Stmt) => sink.push(stmt);
  const freshPoint = () => `q${++ptN}`;

  function postMods(mods: Modifier[], unit: number): PostMod[] {
    const out: PostMod[] = [];
    for (const m of mods) {
      if (m.kind === "round") out.push({ kind: "round", amount: m.radius * unit });
      else if (m.kind === "onion") out.push({ kind: "onion", amount: m.thickness * unit });
    }
    return out;
  }

  function shapeRhs(
    layer: ShapeLayer,
    point: string,
    accScl: V3,
    dropPos: boolean,
    inherited: Material,
  ): ShapeRhs {
    usedShapes.add(layer.shapeType);
    const rot = isZero(layer.rotation) ? null : toRad(layer.rotation);
    if (rot) usesRotation = true;
    let imageIndex = -1;
    if (layer.shapeType === "image" && layer.image) {
      imageIndex = images.indexOf(layer.image.sdf);
      if (imageIndex < 0) imageIndex = images.push(layer.image.sdf) - 1;
    }
    return {
      kind: "shape",
      shape: layer.shapeType,
      point,
      pos: dropPos || isZero(layer.position) ? null : layer.position,
      rotRad: rot,
      accScl: rot && !isUniform(accScl) ? accScl : null,
      scale: isOne(layer.scale) ? null : layer.scale,
      factor: minV(layer.scale) * minV(accScl),
      params: layer.params,
      imageIndex,
      imageRound: Math.max(0, layer.image?.round ?? 0),
      material: layer.material ?? inherited,
      post: [],
    };
  }

  /**
   * Point modifiers from index `i` on, then `body` at the resulting point.
   * Overlapping repeats and polar repeats become a loop over the copies a
   * point can be nearest to (same decision as the viewport:
   * planPointModifiers).
   */
  function withMods(
    point: Modifier[],
    plan: ModifierPlan,
    i: number,
    q: string,
    unit: number,
    body: (q: string) => string | null,
  ): string | null {
    if (i === point.length) return body(q);
    const m = point[i];
    // Same loops as the viewport's withSteps (branch and bound over copies).
    const copies: Copies | null =
      m.kind === "repeat"
        ? { kind: "repeat", mod: m, gap: plan.gap[i] as V3, copy: plan.copy[i]! }
        : m.kind === "polar"
          ? { kind: "polar", mod: m, reach: plan.polar[i]!, gap: plan.gap[i] as [number, number], copy: plan.copy[i]! }
          : null;
    if (copies) {
      const acc = `d${accN++}`;
      const inner = freshPoint();
      const outer = sink;
      const loopBody: Stmt[] = [];
      sink = loopBody;
      const result = withMods(point, plan, i + 1, inner, unit, body);
      sink = outer;
      if (!result) return null;
      emit({ t: "loop", acc, from: q, point: inner, copies, unit, body: loopBody, result });
      return acc;
    }
    const next = freshPoint();
    emit({ t: "pmod", name: next, from: q, mod: m });
    return withMods(point, plan, i + 1, next, unit, body);
  }

  /** A shape with modifiers: its value as an accumulator variable. */
  function moddedShape(layer: ShapeLayer, point: string, accScl: V3, dropPos: boolean, inherited: Material): string | null {
    usesModifiers = true;
    const mods = activeModifiers(layer.modifiers);
    const pointMods = mods.filter((m) => POINT_MODIFIERS.has(m.kind));
    const plan = shapePlan(layer);
    const full = shapeRhs(layer, point, accScl, dropPos, inherited);
    const local = freshPoint();
    emit({ t: "shapePoint", name: local, rhs: full });
    return withMods(pointMods, plan, 0, local, full.factor * plan.invL, (q) => {
      const acc = `d${accN++}`;
      const rhs: ShapeRhs = {
        ...full,
        point: q,
        pos: null,
        rotRad: null,
        accScl: null,
        scale: null,
        factor: full.factor * plan.invL,
        post: postMods(mods, 1),
      };
      emit({ t: "def", name: acc, rhs });
      return acc;
    });
  }

  function groupPoint(group: ObjectGroup, point: string, dropPos: boolean): string {
    const pos = dropPos || isZero(group.position) ? null : group.position;
    const rot = isZero(group.rotation) ? null : toRad(group.rotation);
    const scale = isOne(group.scale) ? null : group.scale;
    if (!pos && !rot && !scale) return point;
    if (rot) usesRotation = true;
    const name = freshPoint();
    emit({ t: "point", name, from: point, pos, rotRad: rot, scale });
    return name;
  }

  /** A group's value (its own transform, modifiers, children) as a variable. */
  function groupValue(group: ObjectGroup, point: string, accScl: V3, inherited: Material, dropPos: boolean): string | null {
    const childPoint = groupPoint(group, point, dropPos);
    const childAcc = mulV(accScl, group.scale);
    const material = group.material ?? inherited;
    const mods = activeModifiers(group.modifiers);
    if (mods.length === 0) return walkItems(group.items, childPoint, childAcc, material);
    usesModifiers = true;
    const pointMods = mods.filter((m) => POINT_MODIFIERS.has(m.kind));
    const plan = groupPlan(group);
    if (!plan) return null;
    const acc = withMods(pointMods, plan, 0, childPoint, minV(childAcc), (q) => walkItems(group.items, q, childAcc, material));
    if (!acc) return null;
    if (Math.abs(plan.invL - 1) > 1e-9) emit({ t: "scale", name: acc, k: plan.invL });
    for (const post of postMods(mods, minV(childAcc))) emit({ t: "post", name: acc, mod: post });
    return acc;
  }

  function walkItems(items: SceneItem[], point: string, accScl: V3, inherited: Material): string | null {
    let acc: string | null = null;
    for (const item of items) {
      let rhs: Rhs | null = null;
      if (item.kind === "layer") {
        if (activeModifiers(item.modifiers).length > 0) {
          const v = moddedShape(item, point, accScl, false, inherited);
          if (v) rhs = { kind: "var", name: v };
        } else {
          rhs = shapeRhs(item, point, accScl, false, inherited);
        }
      } else if (item.items.length > 0) {
        const v = groupValue(item, point, accScl, inherited, false);
        if (v) rhs = { kind: "var", name: v };
      }
      if (!rhs) continue;
      if (!acc) {
        acc = `d${accN++}`;
        emit({ t: "def", name: acc, rhs });
      } else {
        if (SMOOTH_OPS.has(item.op)) usesSmin = true;
        emit({ t: "combine", name: acc, op: item.op, k: item.smoothK, rhs });
      }
    }
    return acc;
  }

  const selected = selectedItemId ? findItemIn(root.items, selectedItemId) : null;
  const inheritedAt = (id: string) => {
    let found: Material = DEFAULT_MATERIAL;
    const walk = (items: SceneItem[], inherited: Material): boolean => {
      for (const item of items) {
        if (item.id === id) {
          found = inherited;
          return true;
        }
        if (item.kind === "group" && walk(item.items, item.material ?? inherited)) return true;
      }
      return false;
    };
    walk(root.items, DEFAULT_MATERIAL);
    return found;
  };
  let result: string | null;
  if (selected?.kind === "layer") {
    if (activeModifiers(selected.modifiers).length > 0) {
      result = moddedShape(selected, "p", [1, 1, 1], true, inheritedAt(selected.id));
    } else {
      const acc = `d${accN++}`;
      emit({ t: "def", name: acc, rhs: shapeRhs(selected, "p", [1, 1, 1], true, inheritedAt(selected.id)) });
      result = acc;
    }
  } else if (selected?.kind === "group") {
    result = groupValue(selected, "p", [1, 1, 1], inheritedAt(selected.id), true);
  } else {
    result = walkItems(root.items, "p", [1, 1, 1], DEFAULT_MATERIAL);
  }

  return { stmts, result, usedShapes, usesRotation, usesSmin, usesModifiers, images };
}

// Image SDF texel → distance. Must match sdImage in src/gpu/shader.ts.
// t = STEP · (r·255 − 128.5 + g) reassembles the coarse (R) + residual (G)
// bytes into d_px / RES; distance = t · 2s.
const IMG_STEP = `(${fmt(IMAGE_SDF_STEP_PX)} / ${fmt(IMAGE_SDF_RES)})`; // exact, unlike a 6-digit literal
const IMG_NOTE = `${IMAGE_SDF_RES}×${IMAGE_SDF_RES} baked signed-distance PNG, 16-bit split over .r (coarse) + .g (residual); linear filtering, clamp to edge`;

// Per-image texture binding + sampling wrapper. `i` = image index.
const TG_IMAGE = (i: number, url: string) => `// Image ${i}: ${IMG_NOTE}.
// Load once: imageTex${i}.write(await createImageBitmap(await (await fetch(IMAGE_${i})).blob()));
const IMAGE_${i} = "${url}";
const imageTex${i} = root.createTexture({ size: [${IMAGE_SDF_RES}, ${IMAGE_SDF_RES}], format: "rgba8unorm" }).$usage("sampled", "render");
const imageTex${i}View = imageTex${i}.createView(d.texture2d(d.f32));
const sdImageTex${i} = (p: d.v3f, s: number, h: number, bold: number, rnd: number, invert: number): number => {
  "use gpu";
  const uv = d.vec2f(p.x, p.y) * (0.5 / s) + d.vec2f(0.5); // row 0 = −Y (d-stance viewport is Y-down); flip uv.y for Y-up cameras
  const rg = std.textureSampleLevel(imageTex${i}View.$, imageSampler.$, uv, 0);
  const t = (rg.x * 255.0 - 128.5 + rg.y) * ${IMG_STEP};
  return sdImageField(p, t, s, h, bold, rnd, invert);
};`;

const TG_IMAGE_SAMPLER = `const imageSampler = root.createSampler({
  magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
});`;

const WGSL_IMAGE = (i: number, url: string) => `// Image ${i}: ${IMG_NOTE}.
// ${url}
@group(0) @binding(${i + 1}) var imageTex${i}: texture_2d<f32>;
fn sdImageTex${i}(p: vec3f, s: f32, h: f32, bold: f32, rnd: f32, invert: f32) -> f32 {
  let uv = p.xy / s * 0.5 + 0.5; // row 0 = −Y (d-stance viewport is Y-down); flip uv.y for Y-up cameras
  let rg = textureSampleLevel(imageTex${i}, imageSampler, uv, 0.0).xy;
  let t = (rg.x * 255.0 - 128.5 + rg.y) * ${IMG_STEP};
  return sdImageField(p, t, s, h, bold, rnd, invert);
}`;

const WGSL_IMAGE_SAMPLER = `// Linear, clamp-to-edge.
@group(0) @binding(0) var imageSampler: sampler;`;

const GLSL_IMAGE = (i: number, url: string) => `// Image ${i}: ${IMG_NOTE}.
// ${url}
uniform sampler2D imageTex${i};
float sdImageTex${i}(vec3 p, float s, float h, float bold, float rnd, float invert) {
  vec2 uv = p.xy / s * 0.5 + 0.5; // row 0 = −Y (d-stance viewport is Y-down); flip uv.y for Y-up cameras
  vec2 rg = textureLod(imageTex${i}, uv, 0.0).rg;
  float t = (rg.x * 255.0 - 128.5 + rg.y) * ${IMG_STEP};
  return sdImageField(p, t, s, h, bold, rnd, invert);
}`;

const TG_ROT = `const applyInvRotXYZ = (lp: d.v3f, rot: d.v3f): d.v3f => {
  "use gpu";
  const czn = std.cos(-rot.z); const szn = std.sin(-rot.z);
  const p1 = d.vec3f(czn * lp.x - szn * lp.y, szn * lp.x + czn * lp.y, lp.z);
  const cyn = std.cos(-rot.y); const syn = std.sin(-rot.y);
  const p2 = d.vec3f(cyn * p1.x + syn * p1.z, p1.y, -syn * p1.x + cyn * p1.z);
  const cxn = std.cos(-rot.x); const sxn = std.sin(-rot.x);
  return d.vec3f(p2.x, cxn * p2.y - sxn * p2.z, sxn * p2.y + cxn * p2.z);
};`;

const WGSL_ROT = `fn applyInvRotXYZ(lp: vec3f, rot: vec3f) -> vec3f {
  let czn = cos(-rot.z); let szn = sin(-rot.z);
  let p1 = vec3f(czn * lp.x - szn * lp.y, szn * lp.x + czn * lp.y, lp.z);
  let cyn = cos(-rot.y); let syn = sin(-rot.y);
  let p2 = vec3f(cyn * p1.x + syn * p1.z, p1.y, -syn * p1.x + cyn * p1.z);
  let cxn = cos(-rot.x); let sxn = sin(-rot.x);
  return vec3f(p2.x, cxn * p2.y - sxn * p2.z, sxn * p2.y + cxn * p2.z);
}`;

const GLSL_ROT = `vec3 applyInvRotXYZ(vec3 lp, vec3 rot) {
  float czn = cos(-rot.z); float szn = sin(-rot.z);
  vec3 p1 = vec3(czn * lp.x - szn * lp.y, szn * lp.x + czn * lp.y, lp.z);
  float cyn = cos(-rot.y); float syn = sin(-rot.y);
  vec3 p2 = vec3(cyn * p1.x + syn * p1.z, p1.y, -syn * p1.x + cyn * p1.z);
  float cxn = cos(-rot.x); float sxn = sin(-rot.x);
  return vec3(p2.x, cxn * p2.y - sxn * p2.z, sxn * p2.y + cxn * p2.z);
}`;

const TG_SMIN = `const smin = (a: number, b: number, k: number): number => {
  "use gpu";
  const h = std.clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return std.mix(b, a, h) - k * h * (1.0 - h);
};`;

const WGSL_SMIN = `fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}`;

const GLSL_SMIN = `float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}`;

// ── Renderers ─────────────────────────────────────────────────────────────────

interface Syntax {
  vec3(v: V3): string;
  vec2(x: number, y: number): string;
  vec4(v: V3, w: number): string;
  minFn: string;
  maxFn: string;
  divVec(e: string, v: V3): string;
  pointStmt(name: string, expr: string): string;
  defStmt(name: string, expr: string): string;
  assignStmt(name: string, expr: string): string;
  fnOpen(fn: string): string;
  fnClose: string;
  absFn: string;
  clampFn: string;
  vec3Expr(c: readonly string[]): string;
  uint(n: number): string;
  loopOpen(n: string, count: number): string;
  helpers: {
    shapes: Record<ShapeType, string>;
    rot: string;
    smin: string;
    modifiers: string;
    imageSampler: string;
    image: (i: number, url: string) => string;
  };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const paren = (e: string) => (IDENT.test(e) ? e : `(${e})`);
const neg = (e: string) => (IDENT.test(e) ? `-${e}` : `-(${e})`);

/** The shape's local point: its transform applied to rhs.point. */
function shapeLocalPoint(syn: Syntax, rhs: ShapeRhs): string {
  let lp = rhs.point;
  if (rhs.pos) lp = `${lp} - ${syn.vec3(rhs.pos)}`;
  if (rhs.rotRad) {
    if (rhs.accScl) {
      lp = syn.divVec(`applyInvRotXYZ(${paren(lp)} * ${syn.vec3(rhs.accScl)}, ${syn.vec3(rhs.rotRad)})`, rhs.accScl);
    } else {
      lp = `applyInvRotXYZ(${lp}, ${syn.vec3(rhs.rotRad)})`;
    }
  }
  if (rhs.scale) lp = syn.divVec(lp, rhs.scale);
  return lp;
}

function shapeCall(syn: Syntax, rhs: ShapeRhs): string {
  const lp = shapeLocalPoint(syn, rhs);
  const [p0, p1, p2, p3] = rhs.params;
  let call: string;
  if (rhs.shape === "image") {
    call =
      rhs.imageIndex < 0
        ? fmt(1e10) // layer without a baked SDF contributes nothing
        : `sdImageTex${rhs.imageIndex}(${lp}, ${fmt(p0)}, ${fmt(p1)}, ${fmt(p2)}, ${fmt(rhs.imageRound)}, ${fmt(p3 > 0.5 ? 1 : 0)})`;
  } else {
    call = primitiveCall(rhs.shape, lp, [fmt(p0), fmt(p1), fmt(p2), fmt(p3)], {
      vec2: (x, y) => syn.vec2(Number(x), Number(y)),
      vec3: (x, y, z) => syn.vec3([Number(x), Number(y), Number(z)]),
    });
  }
  for (const m of rhs.post) {
    call = m.kind === "round" ? `(${call} - ${fmt(m.amount)})` : `(${syn.absFn}(${call}) - ${fmt(m.amount)})`;
  }
  return Math.abs(rhs.factor - 1) > 1e-9 ? `${call} * ${fmt(rhs.factor)}` : call;
}

const AXIS = ["x", "y", "z"] as const;

function modExpr(syn: Syntax, m: Modifier, q: string): string {
  switch (m.kind) {
    case "mirror":
      return syn.vec3Expr(
        AXIS.map((k, a) => {
          if (!m.axes[a]) return `${q}.${k}`;
          const d = m.offset[a];
          return d === 0 ? `${syn.absFn}(${q}.${k})` : `${syn.absFn}(${q}.${k} + ${fmt(d)}) - ${fmt(d)}`;
        }),
      );
    case "twist":
      return `opTwist(${q}, ${fmt(m.amount)}, ${syn.uint(m.axis)})`;
    case "bend":
      return `opBend(${q}, ${fmt(m.amount)}, ${syn.uint(m.axis)})`;
    case "elongate":
      return `${q} - ${syn.clampFn}(${q}, ${syn.vec3([-m.size[0], -m.size[1], -m.size[2]])}, ${syn.vec3(m.size)})`;
    default:
      throw new Error(`not a point modifier: ${m.kind}`);
  }
}

/**
 * Statement lines for the SDF (msyn null) or the material function (msyn
 * set: every accumulator dN carries a material mN alongside).
 */
function emitStmts(stmts: Stmt[], syn: Syntax, msyn: MaterialSyntax | null, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  const push = (line: string) => out.push(pad + line);
  const mat = (rhs: Rhs) => (rhs.kind === "var" ? matName(rhs.name) : msyn!.lit(rhs.material));
  for (const stmt of stmts) {
    switch (stmt.t) {
      case "point":
        push(syn.pointStmt(stmt.name, pointExpr(syn, stmt)));
        break;
      case "shapePoint":
        push(syn.pointStmt(stmt.name, shapeLocalPoint(syn, stmt.rhs)));
        break;
      case "pmod":
        push(syn.pointStmt(stmt.name, modExpr(syn, stmt.mod, stmt.from)));
        break;
      case "def":
        push(syn.defStmt(stmt.name, rhsExpr(syn, stmt.rhs)));
        if (msyn) push(msyn.defMat(matName(stmt.name), mat(stmt.rhs)));
        break;
      case "combine": {
        if (!msyn) {
          push(syn.assignStmt(stmt.name, combineExpr(syn, stmt.name, stmt.op, stmt.k, rhsExpr(syn, stmt.rhs))));
          break;
        }
        const a = stmt.name;
        const m = matName(a);
        const k = fmt(stmt.k);
        let update = "";
        if (stmt.op === "union") update = ` if (t < ${a}) { ${m} = tm; }`;
        else if (stmt.op === "intersect") update = ` if (t > ${a}) { ${m} = tm; }`;
        else if (stmt.op === "sUnion") update = ` ${m} = mixMaterial(${m}, tm, sminWeight(${a}, t, ${k}));`;
        else if (stmt.op === "sIntersect") update = ` ${m} = mixMaterial(${m}, tm, sminWeight(-${a}, -t, ${k}));`;
        push(
          `  { ${msyn.tempF("t", rhsExpr(syn, stmt.rhs))} ${msyn.tempM("tm", mat(stmt.rhs))}${update} ${a} = ${combineExpr(syn, a, stmt.op, stmt.k, "t")}; }`,
        );
        break;
      }
      case "loop": {
        const n = `n${stmt.acc.slice(1)}`;
        const c = stmt.copies;
        const unit = fmt(stmt.unit);
        const k = stmt.acc.slice(1);
        const lo = `lo${k}`;
        let count: number;
        let copy: string;
        // Nearest copy first; see the viewport's SceneCompiler.nearest.
        let near: { others: string; bound: string; far: string } | null = null;
        if (c.kind === "repeat") {
          const [sp, cnt, gap] = [c.mod.spacing, c.mod.count, c.gap].map((v) => syn.vec3(v));
          const sphere = syn.vec4(c.copy.c, c.copy.r);
          const cell = `cell${k}`;
          push(syn.pointStmt(cell, `repeatCell(${stmt.from}, ${sp}, ${cnt})`));
          count = 8;
          copy = `opRepeatNear(${stmt.from}, ${sp}, ${cell}, ${n})`;
          near = {
            others: `opRepeatOthers(${stmt.from}, ${sp}, ${cnt}, ${cell}, ${sphere})`,
            bound: `opRepeatNearBound(${stmt.from}, ${sp}, ${cnt}, ${cell}, ${sphere}, ${n})`,
            far: `opRepeatFar(${stmt.from}, ${sp}, ${cnt}, ${cell}, ${gap})`,
          };
        } else {
          const sector = fmt((2 * Math.PI) / c.mod.count);
          const axis = syn.uint(c.mod.axis);
          if (c.reach === "all") {
            count = c.mod.count;
            copy = `opPolarCopy(${stmt.from}, ${sector}, ${axis}, ${n})`;
          } else {
            const gap = syn.vec2(c.gap[0], c.gap[1]);
            const sphere = syn.vec4(c.copy.c, c.copy.r);
            const t = polarTurned(c.mod, c.copy.c);
            const own = `own${k}`;
            push(syn.pointStmt(own, `opPolarNear(${stmt.from}, ${sector}, ${axis}, ${syn.uint(0)})`));
            count = Math.min(3, c.mod.count);
            copy = `opPolarNear(${stmt.from}, ${sector}, ${axis}, ${n})`;
            near = {
              others: `opPolarOthers(${own}, ${axis}, ${sphere}, ${syn.vec4([t[0], t[1], t[2]], t[3])}, ${syn.vec4([t[4], t[5], t[6]], t[7])})`,
              bound: `opPolarNearBound(${stmt.from}, ${sector}, ${axis}, ${sphere}, ${n})`,
              far: `opPolarFar(${stmt.from}, ${sector}, ${axis}, ${gap}, ${fmt(c.mod.count)})`,
            };
          }
        }
        if (near) push(syn.defStmt(lo, `${near.others} * ${unit}`));
        push(syn.defStmt(stmt.acc, fmt(1e10)));
        if (msyn) push(msyn.defMat(matName(stmt.acc), msyn.lit(DEFAULT_MATERIAL)));
        push(`  ${syn.loopOpen(n, count)}`);
        if (near) {
          push(`    if (${n} > ${syn.uint(0)}) {`);
          push(`      if (${stmt.acc} <= ${lo}) { break; }`);
          push(`      if (${near.bound} * ${unit} >= ${stmt.acc}) { continue; }`);
          push(`    }`);
        }
        out.push(pad + "  " + syn.pointStmt(stmt.point, copy));
        emitStmts(stmt.body, syn, msyn, depth + 1, out);
        if (msyn) push(`    if (${stmt.result} < ${stmt.acc}) { ${matName(stmt.acc)} = ${matName(stmt.result)}; }`);
        out.push(pad + "  " + syn.assignStmt(stmt.acc, `${syn.minFn}(${stmt.acc}, ${stmt.result})`));
        push("  }");
        if (near) push(`  if (${stmt.acc} > ${lo}) { ${syn.assignStmt(stmt.acc, `${syn.minFn}(${stmt.acc}, ${near.far} * ${unit})`).trim()} }`);
        break;
      }
      case "scale":
        push(syn.assignStmt(stmt.name, `${stmt.name} * ${fmt(stmt.k)}`));
        break;
      case "post":
        push(
          syn.assignStmt(
            stmt.name,
            stmt.mod.kind === "round"
              ? `${stmt.name} - ${fmt(stmt.mod.amount)}`
              : `${syn.absFn}(${stmt.name}) - ${fmt(stmt.mod.amount)}`,
          ),
        );
        break;
    }
  }
}

function rhsExpr(syn: Syntax, rhs: Rhs): string {
  return rhs.kind === "var" ? rhs.name : shapeCall(syn, rhs);
}

function combineExpr(syn: Syntax, acc: string, op: OpType, k: number, b: string): string {
  switch (op) {
    case "union":
      return `${syn.minFn}(${acc}, ${b})`;
    case "subtract":
      return `${syn.maxFn}(${acc}, ${neg(b)})`;
    case "intersect":
      return `${syn.maxFn}(${acc}, ${b})`;
    case "sUnion":
      return `smin(${acc}, ${b}, ${fmt(k)})`;
    case "sSubtract":
      return `-smin(${neg(acc)}, ${b}, ${fmt(k)})`;
    case "sIntersect":
      return `-smin(${neg(acc)}, ${neg(b)}, ${fmt(k)})`;
  }
}

function pointExpr(syn: Syntax, stmt: Extract<Stmt, { t: "point" }>): string {
  let e = stmt.from;
  if (stmt.pos) e = `${e} - ${syn.vec3(stmt.pos)}`;
  if (stmt.rotRad) e = `applyInvRotXYZ(${e}, ${syn.vec3(stmt.rotRad)})`;
  if (stmt.scale) e = syn.divVec(e, stmt.scale);
  return e;
}

function render(ir: Ir, fnName: string, syn: Syntax): string {
  if (!ir.result) return PLACEHOLDER;

  const body: string[] = [];
  // Single shape → return the expression directly, no accumulator.
  if (ir.stmts.length === 1 && ir.stmts[0].t === "def") {
    body.push(`  return ${rhsExpr(syn, ir.stmts[0].rhs)};`);
  } else {
    emitStmts(ir.stmts, syn, null, 0, body);
    body.push(`  return ${ir.result};`);
  }

  const helpers: string[] = [];
  for (const shape of ALL_SHAPE_TYPES) {
    if (ir.usedShapes.has(shape)) helpers.push(syn.helpers.shapes[shape]);
  }
  if (ir.images.length > 0 && syn.helpers.imageSampler) helpers.push(syn.helpers.imageSampler);
  ir.images.forEach((url, i) => helpers.push(syn.helpers.image(i, url)));
  if (ir.usesRotation) helpers.push(syn.helpers.rot);
  if (ir.usesSmin) helpers.push(syn.helpers.smin);
  if (ir.usesModifiers) helpers.push(syn.helpers.modifiers);

  return [...helpers, `${syn.fnOpen(fnName)}\n${body.join("\n")}\n${syn.fnClose}`].join("\n\n");
}

// ── Material function (embed renderer) ──────────────────────────────────────
// Recomputes the same CSG and carries the material along it, mirroring the
// viewport (sceneCompiler.ts combineStmt): union / intersect take the winning
// operand's material, smooth ops blend with the smooth-min weight, subtracts
// keep the cut shape's material. Evaluated once per pixel at the hit.

interface MaterialSyntax {
  decl: string;
  lit(m: Material): string;
  defMat(name: string, expr: string): string;
  tempF(name: string, expr: string): string;
  tempM(name: string, expr: string): string;
  fnOpen(fn: string): string;
}

const WGSL_MAT: MaterialSyntax = {
  decl: `struct SdfMaterial {
  color: vec3f,   // sRGB
  roughness: f32,
  metalness: f32,
  emission: f32,
}

fn mixMaterial(a: SdfMaterial, b: SdfMaterial, t: f32) -> SdfMaterial {
  return SdfMaterial(mix(a.color, b.color, t), mix(a.roughness, b.roughness, t), mix(a.metalness, b.metalness, t), mix(a.emission, b.emission, t));
}

// Weight of b in smin(a, b, k): 0 = all a, 1 = all b.
fn sminWeight(a: f32, b: f32, k: f32) -> f32 {
  return 1.0 - clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
}`,
  lit: (m) =>
    `SdfMaterial(vec3f(${m.color.map(fmt).join(", ")}), ${fmt(m.roughness)}, ${fmt(m.metalness)}, ${fmt(m.emission)})`,
  defMat: (n, e) => `  var ${n} = ${e};`,
  tempF: (n, e) => `let ${n} = ${e};`,
  tempM: (n, e) => `let ${n} = ${e};`,
  fnOpen: (fn) => `fn ${fn}(p: vec3f) -> SdfMaterial {`,
};

const GLSL_MAT: MaterialSyntax = {
  decl: `struct SdfMaterial {
  vec3 color; // sRGB
  float roughness;
  float metalness;
  float emission;
};

SdfMaterial mixMaterial(SdfMaterial a, SdfMaterial b, float t) {
  return SdfMaterial(mix(a.color, b.color, t), mix(a.roughness, b.roughness, t), mix(a.metalness, b.metalness, t), mix(a.emission, b.emission, t));
}

// Weight of b in smin(a, b, k): 0 = all a, 1 = all b.
float sminWeight(float a, float b, float k) {
  return 1.0 - clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
}`,
  lit: (m) =>
    `SdfMaterial(vec3(${m.color.map(fmt).join(", ")}), ${fmt(m.roughness)}, ${fmt(m.metalness)}, ${fmt(m.emission)})`,
  defMat: (n, e) => `  SdfMaterial ${n} = ${e};`,
  tempF: (n, e) => `float ${n} = ${e};`,
  tempM: (n, e) => `SdfMaterial ${n} = ${e};`,
  fnOpen: (fn) => `SdfMaterial ${fn}(vec3 p) {`,
};

const matName = (acc: string) => `m${acc.slice(1)}`;

function renderMaterial(ir: Ir, fnName: string, syn: Syntax, msyn: MaterialSyntax): string {
  const body: string[] = [];
  if (!ir.result) {
    body.push(`  return ${msyn.lit(DEFAULT_MATERIAL)};`);
  } else {
    emitStmts(ir.stmts, syn, msyn, 0, body);
    body.push(`  return ${matName(ir.result)};`);
  }
  return [msyn.decl, `${msyn.fnOpen(fnName)}\n${body.join("\n")}\n}`].join("\n\n");
}

const TG_SYNTAX: Syntax = {
  vec3: (v) => `d.vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `d.vec2f(${fmt(x)}, ${fmt(y)})`,
  vec4: (v, w) => `d.vec4f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}, ${fmt(w)})`,
  minFn: "std.min",
  maxFn: "std.max",
  divVec: (e, v) => `${paren(e)} * d.vec3f(${fmtRecip(v[0])}, ${fmtRecip(v[1])}, ${fmtRecip(v[2])})`,
  pointStmt: (n, e) => `  const ${n} = ${e};`,
  defStmt: (n, e) => `  let ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `const ${fn} = (p: d.v3f): number => {\n  "use gpu";`,
  fnClose: "};",
  absFn: "std.abs",
  clampFn: "std.clamp",
  vec3Expr: (c) => `d.vec3f(${c.join(", ")})`,
  uint: (n) => `${n}`,
  loopOpen: (n, count) => `for (let ${n} = d.u32(0); ${n} < ${count}; ${n}++) {`,
  helpers: { shapes: TG_HELPERS, rot: TG_ROT, smin: TG_SMIN, modifiers: MODIFIER_TG, imageSampler: TG_IMAGE_SAMPLER, image: TG_IMAGE },
};

const WGSL_SYNTAX: Syntax = {
  vec3: (v) => `vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `vec2f(${fmt(x)}, ${fmt(y)})`,
  vec4: (v, w) => `vec4f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}, ${fmt(w)})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  pointStmt: (n, e) => `  let ${n} = ${e};`,
  defStmt: (n, e) => `  var ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `fn ${fn}(p: vec3f) -> f32 {`,
  fnClose: "}",
  absFn: "abs",
  clampFn: "clamp",
  vec3Expr: (c) => `vec3f(${c.join(", ")})`,
  uint: (n) => `${n}u`,
  loopOpen: (n, count) => `for (var ${n} = 0u; ${n} < ${count}u; ${n}++) {`,
  helpers: { shapes: WGSL_HELPERS, rot: WGSL_ROT, smin: WGSL_SMIN, modifiers: MODIFIER_WGSL, imageSampler: WGSL_IMAGE_SAMPLER, image: WGSL_IMAGE },
};

const GLSL_SYNTAX: Syntax = {
  vec3: (v) => `vec3(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `vec2(${fmt(x)}, ${fmt(y)})`,
  vec4: (v, w) => `vec4(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}, ${fmt(w)})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  pointStmt: (n, e) => `  vec3 ${n} = ${e};`,
  defStmt: (n, e) => `  float ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `float ${fn}(vec3 p) {`,
  fnClose: "}",
  absFn: "abs",
  clampFn: "clamp",
  vec3Expr: (c) => `vec3(${c.join(", ")})`,
  uint: (n) => `${n}`,
  loopOpen: (n, count) => `for (int ${n} = 0; ${n} < ${count}; ${n}++) {`,
  helpers: { shapes: GLSL_HELPERS, rot: GLSL_ROT, smin: GLSL_SMIN, modifiers: MODIFIER_GLSL, imageSampler: "", image: GLSL_IMAGE },
};

// ── Public API ────────────────────────────────────────────────────────────────

const RESERVED = new Set([
  ...ALL_SHAPE_TYPES.map((t) => `sd${t[0].toUpperCase()}${t.slice(1)}`),
  "smin",
  "applyInvRotXYZ",
  "ndot2",
  "sdImageField",
  "repeatCell",
  "repeatDir",
  "repeatHas",
  "repeatStep",
  "opRepeatNear",
  "opRepeatNearBound",
  "opRepeatOthers",
  "opRepeatFar",
  "rot2",
  "polarUv",
  "polarSet",
  "opPolarNear",
  "opPolarNearBound",
  "opPolarOthers",
  "opPolarFar",
  "opPolarCopy",
  "opTwist",
  "opBend",
]);

function sdfFnName(nodeName: string): string {
  const base = nodeName
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  let fn = `sd${base || "Model"}`;
  if (RESERVED.has(fn) || /^sdImageTex\d+$/.test(fn)) fn += "Model";
  return fn;
}

export function generateSdfCode(root: SceneRoot, selectedItemId: string | null): GeneratedSdf {
  const selected = selectedItemId ? findItemIn(root.items, selectedItemId) : null;
  const fnName = sdfFnName(selected ? selected.name : root.name);
  const ir = buildIr(root, selectedItemId);
  return {
    fnName,
    typegpu: render(ir, fnName, TG_SYNTAX),
    wgsl: render(ir, fnName, WGSL_SYNTAX),
    glsl: render(ir, fnName, GLSL_SYNTAX),
  };
}

export interface GeneratedMaterial {
  /** `${sdfFnName}Material(p)` → SdfMaterial at a surface point. */
  fnName: string;
  wgsl: string;
  glsl: string;
}

/**
 * Material function for the whole scene, pairing with `generateSdfCode(root,
 * null)`'s SDF (same name + "Material"). Needs that SDF's helpers in scope.
 */
export function generateMaterialCode(root: SceneRoot): GeneratedMaterial {
  const fnName = `${sdfFnName(root.name)}Material`;
  const ir = buildIr(root, null);
  return {
    fnName,
    wgsl: renderMaterial(ir, fnName, WGSL_SYNTAX, WGSL_MAT),
    glsl: renderMaterial(ir, fnName, GLSL_SYNTAX, GLSL_MAT),
  };
}
