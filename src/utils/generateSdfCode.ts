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
import { ANIM_HELPERS, activeTracks, animationExpr, type Track } from "../store/animation";
import {
  GLSL_HELPERS,
  MODIFIER_GLSL,
  MODIFIER_TG,
  MODIFIER_WGSL,
  NOISE_GLSL,
  NOISE_TG,
  NOISE_WGSL,
  TG_HELPERS,
  WGSL_HELPERS,
  primitiveCall,
} from "../sdf/primitives";
import { POINT_MODIFIERS, activeModifiers, type Modifier } from "../store/modifiers";
import { groupPlan, shapePlan } from "../sdf/itemBounds";
import type { ModifierPlan } from "../sdf/modifierMath";
import {
  formulaFunction,
  formulaNeeds,
  formulaUsesTime,
  parseFormula,
  sanitizeFormula,
  type FormulaLang,
} from "../sdf/formula";

export type CodeLang = "typegpu" | "wgsl" | "glsl";

export interface GeneratedSdf {
  fnName: string;
  /** The function takes a second parameter, `time` (seconds): something in the scene moves. */
  animated: boolean;
  typegpu: string;
  wgsl: string;
  glsl: string;
}

export const PLACEHOLDER = "// Nothing to export - add shapes to the scene";

const DEG_TO_RAD = Math.PI / 180;

/**
 * A number in the IR: a constant, or an animated value (base ± waves of
 * `time`, src/store/animation.ts) and products / minima of those. Constants
 * fold; anything animated is printed per language by fmtEx.
 */
type Ex =
  | number
  | { k: "anim"; base: number; tracks: Track[]; mul: boolean; min?: number }
  | { k: "mul"; a: Ex; b: Ex }
  | { k: "min3"; a: Ex; b: Ex; c: Ex }
  | { k: "scale"; a: Ex; s: number };

type V3 = readonly [Ex, Ex, Ex];

const isNum = (e: Ex): e is number => typeof e === "number";
const isZero = (v: V3) => v.every((c) => isNum(c) && Math.abs(c) < 1e-9);
const isOne = (v: V3) => v.every((c) => isNum(c) && Math.abs(c - 1) < 1e-9);
const isUniform = (v: V3) => v.every(isNum) && v[0] === v[1] && v[1] === v[2];
const exMul = (a: Ex, b: Ex): Ex =>
  isNum(a) && isNum(b) ? a * b : isNum(a) && a === 1 ? b : isNum(b) && b === 1 ? a : { k: "mul", a, b };
const minV = (v: V3): Ex =>
  v.every(isNum) ? Math.min(...(v as unknown as number[])) : { k: "min3", a: v[0], b: v[1], c: v[2] };
const mulV = (a: V3, b: V3): V3 => [exMul(a[0], b[0]), exMul(a[1], b[1]), exMul(a[2], b[2])];
const toRad = (deg: V3): V3 => deg.map((c) => (isNum(c) ? c * DEG_TO_RAD : { k: "scale", a: c, s: DEG_TO_RAD })) as unknown as V3;
const isOneEx = (e: Ex) => isNum(e) && Math.abs(e - 1) < 1e-9;
/** The value with every animation at rest (time 0 offsets ignored). */
function exAtRest(e: Ex): number {
  if (isNum(e)) return e;
  switch (e.k) {
    case "anim":
      return e.base;
    case "mul":
      return exAtRest(e.a) * exAtRest(e.b);
    case "min3":
      return Math.min(exAtRest(e.a), exAtRest(e.b), exAtRest(e.c));
    case "scale":
      return exAtRest(e.a) * e.s;
  }
}

function fmt(n: number): string {
  const s = parseFloat(n.toFixed(6)).toString();
  return /[.e]/.test(s) ? s : s + ".0";
}

function fmtPrecise(n: number): string {
  const s = parseFloat(n.toPrecision(9)).toString();
  return /[.e]/.test(s) ? s : s + ".0";
}

// ponytail: reciprocal-multiply instead of vec division for TypeGPU (no
// documented vec/vec `/` overload); full-precision literal keeps f32 parity.
function fmtRecip(n: number): string {
  const s = parseFloat((1 / n).toPrecision(9)).toString();
  return /[.e]/.test(s) ? s : s + ".0";
}

/** `time` is the animation clock: a parameter of every exported function of an animated scene. */
function fmtEx(e: Ex, syn: Syntax): string {
  if (isNum(e)) return fmt(e);
  switch (e.k) {
    case "anim": {
      const x = animationExpr(e.base, e.tracks, "time", syn.lang, e.mul);
      return e.min !== undefined ? `${syn.maxFn}(${x}, ${fmt(e.min)})` : x;
    }
    case "mul":
      return `(${fmtEx(e.a, syn)} * ${fmtEx(e.b, syn)})`;
    case "min3":
      return `${syn.minFn}(${syn.minFn}(${fmtEx(e.a, syn)}, ${fmtEx(e.b, syn)}), ${fmtEx(e.c, syn)})`;
    case "scale":
      return `(${fmtEx(e.a, syn)} * ${fmtPrecise(e.s)})`;
  }
}

function fmtRecipEx(e: Ex, syn: Syntax): string {
  return isNum(e) ? fmtRecip(e) : `(1.0 / ${fmtEx(e, syn)})`;
}

/** An item's numbers with its animation tracks folded in. */
interface ItemValues {
  position: V3;
  rotationDeg: V3;
  scale: V3;
  params: readonly [Ex, Ex, Ex, Ex];
  smoothK: Ex;
  emissionTracks: Track[];
}

function animated(base: number, tracks: Track[], mul = false, min?: number): Ex {
  return tracks.length === 0 ? base : { k: "anim", base, tracks, mul, ...(min !== undefined ? { min } : {}) };
}

function itemValues(item: SceneItem): ItemValues {
  const tracks = activeTracks(item.animation);
  const on = (target: string) => tracks.filter((t) => t.target === target);
  const axis = (prefix: string, v: readonly number[]) =>
    v.map((b, a) => animated(b, on(`${prefix}.${"xyz"[a]}`))) as unknown as V3;
  const scaleTracks = on("scale");
  const params = item.kind === "layer" ? item.params : [0, 0, 0, 0];
  return {
    position: axis("position", item.position),
    rotationDeg: axis("rotation", item.rotation),
    scale: item.scale.map((b) => animated(b, scaleTracks, true, 0.01)) as unknown as V3,
    params: params.map((b, i) => animated(b, on(`param${i}`))) as unknown as ItemValues["params"],
    smoothK: animated(item.smoothK, on("smoothK"), false, 0.001),
    emissionTracks: on("emission"),
  };
}

/** Material in the IR: emission may be animated. */
type MatEx = Omit<Material, "emission"> & { emission: Ex };

function matEx(m: Material, emissionTracks: Track[]): MatEx {
  return { ...m, emission: animated(m.emission, emissionTracks, false, 0) };
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
  factor: Ex;
  params: readonly [Ex, Ex, Ex, Ex];
  /** Index into Ir.images for shape "image"; -1 when the layer has no baked SDF. */
  imageIndex: number;
  /** Edge rounding radius for shape "image" (local units). */
  imageRound: number;
  /** Own material, else nearest ancestor group's, else the default. */
  material: MatEx;
  /** Distance modifiers on the shape's own result (local units). */
  post: PostMod[];
  /** Generated function for shapeType "formula". */
  formulaFn?: string;
}
interface VarRhs {
  kind: "var";
  name: string;
}
type Rhs = ShapeRhs | VarRhs;

/** Distance modifier. noise: `amount` = amplitude, sampled at `point`. */
type PostMod =
  | { kind: "round" | "onion"; amount: number }
  | { kind: "noise"; amount: number; scale: number; octaves: number; seed: number; speed: number; point: string };
type RepeatMod = Extract<Modifier, { kind: "repeat" }>;

type Stmt =
  | { t: "point"; name: string; from: string; pos: V3 | null; rotRad: V3 | null; scale: V3 | null }
  /** A shape's own local point (its transform), ahead of its point modifiers. */
  | { t: "shapePoint"; name: string; rhs: ShapeRhs }
  | { t: "pmod"; name: string; from: string; mod: Modifier }
  /** Repeat whose copies overlap: union over the cell and its neighbors. */
  | { t: "loop"; acc: string; from: string; point: string; mod: RepeatMod; mask: [boolean, boolean, boolean]; body: Stmt[]; result: string }
  | { t: "scale"; name: string; k: number }
  | { t: "post"; name: string; mod: PostMod }
  | { t: "def"; name: string; rhs: Rhs }
  | { t: "combine"; name: string; op: OpType; k: Ex; rhs: Rhs };

interface Ir {
  stmts: Stmt[];
  result: string | null;
  usedShapes: Set<ShapeType>;
  usesRotation: boolean;
  usesSmin: boolean;
  usesModifiers: boolean;
  usesNoise: boolean;
  /** Something reads the clock: exported functions take `time`. */
  animated: boolean;
  usesAnimNoise: boolean;
  /** Formula functions: [name, parsed source]. */
  formulas: [string, ReturnType<typeof parseFormula> & { ok: true }][];
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
  let usesNoise = false;
  let animatedScene = false;
  let usesAnimNoise = false;
  const formulas = new Map<string, string>();
  /** Item values with animation folded in; notes what the scene needs. */
  const values = (item: SceneItem): ItemValues => {
    const tracks = activeTracks(item.animation);
    if (tracks.length > 0) animatedScene = true;
    if (tracks.some((t) => t.wave === "noise")) usesAnimNoise = true;
    return itemValues(item);
  };
  const formulaList: Ir["formulas"] = [];
  let accN = 0;
  let ptN = 0;
  const emit = (stmt: Stmt) => sink.push(stmt);
  const freshPoint = () => `q${++ptN}`;

  /** `point`: the item's own point before its point modifiers (noise input). */
  function postMods(mods: Modifier[], unit: number, point: string): PostMod[] {
    const out: PostMod[] = [];
    for (const m of mods) {
      if (m.kind === "round") out.push({ kind: "round", amount: m.radius * unit });
      else if (m.kind === "onion") out.push({ kind: "onion", amount: m.thickness * unit });
      else if (m.kind === "noise") {
        usesNoise = true;
        if (m.speed) animatedScene = true;
        out.push({ kind: "noise", amount: m.amplitude * unit, scale: m.scale, octaves: m.octaves, seed: m.seed, speed: m.speed ?? 0, point });
      }
    }
    return out;
  }

  function shapeRhs(
    layer: ShapeLayer,
    point: string,
    accScl: V3,
    dropPos: boolean,
    inherited: MatEx,
  ): ShapeRhs {
    usedShapes.add(layer.shapeType);
    const V = values(layer);
    const rot = isZero(V.rotationDeg) ? null : toRad(V.rotationDeg);
    if (rot) usesRotation = true;
    let imageIndex = -1;
    if (layer.shapeType === "image" && layer.image) {
      imageIndex = images.indexOf(layer.image.sdf);
      if (imageIndex < 0) imageIndex = images.push(layer.image.sdf) - 1;
    }
    let formulaFn: string | undefined;
    if (layer.shapeType === "formula") {
      const src = sanitizeFormula(layer.formula);
      formulaFn = formulaName(src);
      if (formulaUsesTime(src)) animatedScene = true;
    }
    return {
      kind: "shape",
      shape: layer.shapeType,
      point,
      pos: dropPos || isZero(V.position) ? null : V.position,
      rotRad: rot,
      accScl: rot && !isUniform(accScl) ? accScl : null,
      scale: isOne(V.scale) ? null : V.scale,
      factor: exMul(minV(V.scale), minV(accScl)),
      params: V.params,
      imageIndex,
      imageRound: Math.max(0, layer.image?.round ?? 0),
      material: layer.material ? matEx(layer.material, V.emissionTracks) : inherited,
      post: [],
      formulaFn,
    };
  }

  function formulaName(src: string): string {
    const known = formulas.get(src);
    if (known) return known;
    const parsed = parseFormula(src);
    if (!parsed.ok) throw new Error(`formula should have been sanitized: ${src}`);
    const needs = formulaNeeds(parsed.ast);
    if (needs.noise) usesNoise = true;
    if (needs.smin) usesSmin = true;
    const name = `formula${formulas.size}`;
    formulas.set(src, name);
    formulaList.push([name, parsed]);
    return name;
  }

  /**
   * Point modifiers from index `i` on, then `body` at the resulting point.
   * Overlapping repeats become a loop over neighbor cells (same decision as
   * the viewport: planPointModifiers).
   */
  function withMods(point: Modifier[], plan: ModifierPlan, i: number, q: string, body: (q: string) => string | null): string | null {
    if (i === point.length) return body(q);
    const m = point[i];
    const neighbors = plan.neighbors[i];
    if (m.kind === "repeat" && neighbors?.some(Boolean)) {
      const acc = `d${accN++}`;
      const inner = freshPoint();
      const outer = sink;
      const loopBody: Stmt[] = [];
      sink = loopBody;
      const result = withMods(point, plan, i + 1, inner, body);
      sink = outer;
      if (!result) return null;
      emit({ t: "loop", acc, from: q, point: inner, mod: m, mask: neighbors, body: loopBody, result });
      return acc;
    }
    const next = freshPoint();
    emit({ t: "pmod", name: next, from: q, mod: m });
    return withMods(point, plan, i + 1, next, body);
  }

  /** A shape with modifiers: its value as an accumulator variable. */
  function moddedShape(layer: ShapeLayer, point: string, accScl: V3, dropPos: boolean, inherited: MatEx): string | null {
    usesModifiers = true;
    const mods = activeModifiers(layer.modifiers);
    const pointMods = mods.filter((m) => POINT_MODIFIERS.has(m.kind));
    const plan = shapePlan(layer);
    const full = shapeRhs(layer, point, accScl, dropPos, inherited);
    const local = freshPoint();
    emit({ t: "shapePoint", name: local, rhs: full });
    return withMods(pointMods, plan, 0, local, (q) => {
      const acc = `d${accN++}`;
      const rhs: ShapeRhs = {
        ...full,
        point: q,
        pos: null,
        rotRad: null,
        accScl: null,
        scale: null,
        factor: exMul(full.factor, plan.invL),
        post: postMods(mods, 1, local),
      };
      emit({ t: "def", name: acc, rhs });
      return acc;
    });
  }

  function groupPoint(group: ObjectGroup, point: string, dropPos: boolean): string {
    const V = values(group);
    const pos = dropPos || isZero(V.position) ? null : V.position;
    const rot = isZero(V.rotationDeg) ? null : toRad(V.rotationDeg);
    const scale = isOne(V.scale) ? null : V.scale;
    if (!pos && !rot && !scale) return point;
    if (rot) usesRotation = true;
    const name = freshPoint();
    emit({ t: "point", name, from: point, pos, rotRad: rot, scale });
    return name;
  }

  /** A group's value (its own transform, modifiers, children) as a variable. */
  function groupValue(group: ObjectGroup, point: string, accScl: V3, inherited: MatEx, dropPos: boolean): string | null {
    const childPoint = groupPoint(group, point, dropPos);
    const V = itemValues(group);
    const childAcc = mulV(accScl, V.scale);
    const material = group.material ? matEx(group.material, V.emissionTracks) : inherited;
    const mods = activeModifiers(group.modifiers);
    if (mods.length === 0) return walkItems(group.items, childPoint, childAcc, material);
    usesModifiers = true;
    const pointMods = mods.filter((m) => POINT_MODIFIERS.has(m.kind));
    const plan = groupPlan(group);
    if (!plan) return null;
    const acc = withMods(pointMods, plan, 0, childPoint, (q) => walkItems(group.items, q, childAcc, material));
    if (!acc) return null;
    if (Math.abs(plan.invL - 1) > 1e-9) emit({ t: "scale", name: acc, k: plan.invL });
    for (const post of postMods(mods, exAtRest(minV(childAcc)), childPoint)) emit({ t: "post", name: acc, mod: post });
    return acc;
  }

  function walkItems(items: SceneItem[], point: string, accScl: V3, inherited: MatEx): string | null {
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
        emit({ t: "combine", name: acc, op: item.op, k: itemValues(item).smoothK, rhs });
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
    const inherited = matEx(inheritedAt(selected.id), []);
    if (activeModifiers(selected.modifiers).length > 0) {
      result = moddedShape(selected, "p", [1, 1, 1], true, inherited);
    } else {
      const acc = `d${accN++}`;
      emit({ t: "def", name: acc, rhs: shapeRhs(selected, "p", [1, 1, 1], true, inherited) });
      result = acc;
    }
  } else if (selected?.kind === "group") {
    result = groupValue(selected, "p", [1, 1, 1], matEx(inheritedAt(selected.id), []), true);
  } else {
    result = walkItems(root.items, "p", [1, 1, 1], matEx(DEFAULT_MATERIAL, []));
  }

  return {
    stmts,
    result,
    usedShapes,
    usesRotation,
    usesSmin,
    usesModifiers,
    usesNoise,
    animated: animatedScene,
    usesAnimNoise,
    formulas: formulaList,
    images,
  };
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
  lang: FormulaLang;
  vec3(v: V3): string;
  vec2Expr(x: string, y: string): string;
  minFn: string;
  maxFn: string;
  divVec(e: string, v: V3): string;
  pointStmt(name: string, expr: string): string;
  defStmt(name: string, expr: string): string;
  assignStmt(name: string, expr: string): string;
  /** `animated`: the function takes the clock as a second parameter, `time`. */
  fnOpen(fn: string, animated: boolean): string;
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
    noise: string;
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

function shapeCall(syn: Syntax, rhs: ShapeRhs, time: string): string {
  const lp = shapeLocalPoint(syn, rhs);
  const P = rhs.params.map((p) => fmtEx(p, syn));
  let call: string;
  if (rhs.shape === "formula") {
    call = `${rhs.formulaFn}(${lp}, ${P[0]}, ${P[1]}, ${time})`;
  } else if (rhs.shape === "image") {
    call =
      rhs.imageIndex < 0
        ? fmt(1e10) // layer without a baked SDF contributes nothing
        : `sdImageTex${rhs.imageIndex}(${lp}, ${P[0]}, ${P[1]}, ${P[2]}, ${fmt(rhs.imageRound)}, ${fmt(exAtRest(rhs.params[3]) > 0.5 ? 1 : 0)})`;
  } else {
    call = primitiveCall(rhs.shape, lp, [P[0], P[1], P[2], P[3]], {
      vec2: (x, y) => syn.vec2Expr(x, y),
      vec3: (x, y, z) => syn.vec3Expr([x, y, z]),
    });
  }
  for (const m of rhs.post) call = postModExpr(syn, m, call, time);
  return isOneEx(rhs.factor) ? call : `${call} * ${fmtEx(rhs.factor, syn)}`;
}

function postModExpr(syn: Syntax, m: PostMod, d: string, time: string): string {
  if (m.kind !== "noise") {
    return m.kind === "round" ? `(${d} - ${fmt(m.amount)})` : `(${syn.absFn}(${d}) - ${fmt(m.amount)})`;
  }
  const flow = m.speed ? ` + ${syn.vec3Expr(["0.0", `${time} * ${fmt(m.speed)}`, "0.0"])}` : "";
  const input = `${m.point} * ${fmt(m.scale)}${m.seed ? ` + ${syn.vec3([m.seed * 7.13, m.seed * 3.71, m.seed * 5.37])}` : ""}${flow}`;
  return `(${d} + ${fmt(m.amount)} * fbm3(${input}, ${fmt(m.octaves)}))`;
}

const AXIS = ["x", "y", "z"] as const;

function modExpr(syn: Syntax, m: Modifier, q: string): string {
  switch (m.kind) {
    case "repeat":
      return `opRepeat(${q}, ${syn.vec3(m.spacing)}, ${syn.vec3(m.count)})`;
    case "mirror":
      return syn.vec3Expr(AXIS.map((k, a) => (m.axes[a] ? `${syn.absFn}(${q}.${k})` : `${q}.${k}`)));
    case "polar":
      return `opPolar(${q}, ${fmt((2 * Math.PI) / m.count)}, ${syn.uint(m.axis)})`;
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
function emitStmts(stmts: Stmt[], syn: Syntax, msyn: MaterialSyntax | null, depth: number, out: string[], time: string) {
  const pad = "  ".repeat(depth);
  const push = (line: string) => out.push(pad + line);
  const mat = (rhs: Rhs) => (rhs.kind === "var" ? matName(rhs.name) : msyn!.lit(rhs.material, syn));
  const rhsExpr = (syn: Syntax, rhs: Rhs) => (rhs.kind === "var" ? rhs.name : shapeCall(syn, rhs, time));
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
        const k = fmtEx(stmt.k, syn);
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
        push(syn.defStmt(stmt.acc, fmt(1e10)));
        if (msyn) push(msyn.defMat(matName(stmt.acc), msyn.lit(DEFAULT_MATERIAL, syn)));
        push(`  ${syn.loopOpen(n, 1 << stmt.mask.filter(Boolean).length)}`);
        const step = `cellStep(${n}, ${syn.vec3(stmt.mask.map((b) => (b ? 1 : 0)) as unknown as V3)})`;
        out.push(pad + "  " + syn.pointStmt(stmt.point, `opRepeatCell(${stmt.from}, ${syn.vec3(stmt.mod.spacing)}, ${syn.vec3(stmt.mod.count)}, ${step})`));
        emitStmts(stmt.body, syn, msyn, depth + 1, out, time);
        if (msyn) push(`    if (${stmt.result} < ${stmt.acc}) { ${matName(stmt.acc)} = ${matName(stmt.result)}; }`);
        out.push(pad + "  " + syn.assignStmt(stmt.acc, `${syn.minFn}(${stmt.acc}, ${stmt.result})`));
        push("  }");
        break;
      }
      case "scale":
        push(syn.assignStmt(stmt.name, `${stmt.name} * ${fmt(stmt.k)}`));
        break;
      case "post":
        push(syn.assignStmt(stmt.name, postModExpr(syn, stmt.mod, stmt.name, time)));
        break;
    }
  }
}

function combineExpr(syn: Syntax, acc: string, op: OpType, kEx: Ex, b: string): string {
  const k = fmtEx(kEx, syn);
  switch (op) {
    case "union":
      return `${syn.minFn}(${acc}, ${b})`;
    case "subtract":
      return `${syn.maxFn}(${acc}, ${neg(b)})`;
    case "intersect":
      return `${syn.maxFn}(${acc}, ${b})`;
    case "sUnion":
      return `smin(${acc}, ${b}, ${k})`;
    case "sSubtract":
      return `-smin(${neg(acc)}, ${b}, ${k})`;
    case "sIntersect":
      return `-smin(${neg(acc)}, ${neg(b)}, ${k})`;
  }
}

function pointExpr(syn: Syntax, stmt: Extract<Stmt, { t: "point" }>): string {
  let e = stmt.from;
  if (stmt.pos) e = `${e} - ${syn.vec3(stmt.pos)}`;
  if (stmt.rotRad) e = `applyInvRotXYZ(${e}, ${syn.vec3(stmt.rotRad)})`;
  if (stmt.scale) e = syn.divVec(e, stmt.scale);
  return e;
}

/** What formulas and flowing noise read as the clock: the `time` parameter, or a still 0. */
const clockArg = (ir: Ir) => (ir.animated ? "time" : "0.0");

function render(ir: Ir, fnName: string, syn: Syntax): string {
  if (!ir.result) return PLACEHOLDER;

  const time = clockArg(ir);
  const body: string[] = [];
  // Single shape → return the expression directly, no accumulator.
  const only = ir.stmts.length === 1 ? ir.stmts[0] : null;
  if (only?.t === "def" && only.rhs.kind === "shape") {
    body.push(`  return ${shapeCall(syn, only.rhs, time)};`);
  } else {
    emitStmts(ir.stmts, syn, null, 0, body, time);
    body.push(`  return ${ir.result};`);
  }

  const helpers: string[] = [];
  // Noise first: GLSL needs functions declared before use.
  if (ir.usesNoise || ir.usedShapes.has("terrain")) helpers.push(syn.helpers.noise);
  for (const shape of ALL_SHAPE_TYPES) {
    if (ir.usedShapes.has(shape)) helpers.push(syn.helpers.shapes[shape]);
  }
  if (ir.images.length > 0 && syn.helpers.imageSampler) helpers.push(syn.helpers.imageSampler);
  ir.images.forEach((url, i) => helpers.push(syn.helpers.image(i, url)));
  if (ir.usesRotation) helpers.push(syn.helpers.rot);
  if (ir.usesSmin) helpers.push(syn.helpers.smin);
  if (ir.usesAnimNoise) helpers.push(ANIM_HELPERS[syn.lang]);
  if (ir.usesModifiers) helpers.push(syn.helpers.modifiers);
  // Last: formulas may call smin / noise.
  for (const [name, parsed] of ir.formulas) helpers.push(formulaFunction(name, parsed.ast, syn.lang));

  return [...helpers, `${syn.fnOpen(fnName, ir.animated)}\n${body.join("\n")}\n${syn.fnClose}`].join("\n\n");
}

// ── Material function (embed renderer) ──────────────────────────────────────
// Recomputes the same CSG and carries the material along it, mirroring the
// viewport (sceneCompiler.ts combineStmt): union / intersect take the winning
// operand's material, smooth ops blend with the smooth-min weight, subtracts
// keep the cut shape's material. Evaluated once per pixel at the hit.

interface MaterialSyntax {
  decl: string;
  lit(m: MatEx, syn: Syntax): string;
  defMat(name: string, expr: string): string;
  tempF(name: string, expr: string): string;
  tempM(name: string, expr: string): string;
  fnOpen(fn: string, animated: boolean): string;
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
  lit: (m, syn) =>
    `SdfMaterial(vec3f(${m.color.map(fmt).join(", ")}), ${fmt(m.roughness)}, ${fmt(m.metalness)}, ${fmtEx(m.emission, syn)})`,
  defMat: (n, e) => `  var ${n} = ${e};`,
  tempF: (n, e) => `let ${n} = ${e};`,
  tempM: (n, e) => `let ${n} = ${e};`,
  fnOpen: (fn, animated) => `fn ${fn}(p: vec3f${animated ? ", time: f32" : ""}) -> SdfMaterial {`,
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
  lit: (m, syn) =>
    `SdfMaterial(vec3(${m.color.map(fmt).join(", ")}), ${fmt(m.roughness)}, ${fmt(m.metalness)}, ${fmtEx(m.emission, syn)})`,
  defMat: (n, e) => `  SdfMaterial ${n} = ${e};`,
  tempF: (n, e) => `float ${n} = ${e};`,
  tempM: (n, e) => `SdfMaterial ${n} = ${e};`,
  fnOpen: (fn, animated) => `SdfMaterial ${fn}(vec3 p${animated ? ", float time" : ""}) {`,
};

const matName = (acc: string) => `m${acc.slice(1)}`;

function renderMaterial(ir: Ir, fnName: string, syn: Syntax, msyn: MaterialSyntax): string {
  const body: string[] = [];
  if (!ir.result) {
    body.push(`  return ${msyn.lit(DEFAULT_MATERIAL, syn)};`);
  } else {
    emitStmts(ir.stmts, syn, msyn, 0, body, clockArg(ir));
    body.push(`  return ${matName(ir.result)};`);
  }
  return [msyn.decl, `${msyn.fnOpen(fnName, ir.animated)}\n${body.join("\n")}\n}`].join("\n\n");
}

const TG_SYNTAX: Syntax = {
  lang: "typegpu",
  vec3: (v) => `d.vec3f(${v.map((c) => fmtEx(c, TG_SYNTAX)).join(", ")})`,
  vec2Expr: (x, y) => `d.vec2f(${x}, ${y})`,
  minFn: "std.min",
  maxFn: "std.max",
  divVec: (e, v) => `${paren(e)} * d.vec3f(${v.map((c) => fmtRecipEx(c, TG_SYNTAX)).join(", ")})`,
  pointStmt: (n, e) => `  const ${n} = ${e};`,
  defStmt: (n, e) => `  let ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn, animated) => `const ${fn} = (p: d.v3f${animated ? ", time: number" : ""}): number => {\n  "use gpu";`,
  fnClose: "};",
  absFn: "std.abs",
  clampFn: "std.clamp",
  vec3Expr: (c) => `d.vec3f(${c.join(", ")})`,
  uint: (n) => `${n}`,
  loopOpen: (n, count) => `for (let ${n} = d.u32(0); ${n} < ${count}; ${n}++) {`,
  helpers: { shapes: TG_HELPERS, rot: TG_ROT, smin: TG_SMIN, modifiers: MODIFIER_TG, noise: NOISE_TG, imageSampler: TG_IMAGE_SAMPLER, image: TG_IMAGE },
};

const WGSL_SYNTAX: Syntax = {
  lang: "wgsl",
  vec3: (v) => `vec3f(${v.map((c) => fmtEx(c, WGSL_SYNTAX)).join(", ")})`,
  vec2Expr: (x, y) => `vec2f(${x}, ${y})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3f(${v.map((c) => fmtEx(c, WGSL_SYNTAX)).join(", ")})`,
  pointStmt: (n, e) => `  let ${n} = ${e};`,
  defStmt: (n, e) => `  var ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn, animated) => `fn ${fn}(p: vec3f${animated ? ", time: f32" : ""}) -> f32 {`,
  fnClose: "}",
  absFn: "abs",
  clampFn: "clamp",
  vec3Expr: (c) => `vec3f(${c.join(", ")})`,
  uint: (n) => `${n}u`,
  loopOpen: (n, count) => `for (var ${n} = 0u; ${n} < ${count}u; ${n}++) {`,
  helpers: { shapes: WGSL_HELPERS, rot: WGSL_ROT, smin: WGSL_SMIN, modifiers: MODIFIER_WGSL, noise: NOISE_WGSL, imageSampler: WGSL_IMAGE_SAMPLER, image: WGSL_IMAGE },
};

const GLSL_SYNTAX: Syntax = {
  lang: "glsl",
  vec3: (v) => `vec3(${v.map((c) => fmtEx(c, GLSL_SYNTAX)).join(", ")})`,
  vec2Expr: (x, y) => `vec2(${x}, ${y})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3(${v.map((c) => fmtEx(c, GLSL_SYNTAX)).join(", ")})`,
  pointStmt: (n, e) => `  vec3 ${n} = ${e};`,
  defStmt: (n, e) => `  float ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn, animated) => `float ${fn}(vec3 p${animated ? ", float time" : ""}) {`,
  fnClose: "}",
  absFn: "abs",
  clampFn: "clamp",
  vec3Expr: (c) => `vec3(${c.join(", ")})`,
  uint: (n) => `${n}`,
  loopOpen: (n, count) => `for (int ${n} = 0; ${n} < ${count}; ${n}++) {`,
  helpers: { shapes: GLSL_HELPERS, rot: GLSL_ROT, smin: GLSL_SMIN, modifiers: MODIFIER_GLSL, noise: NOISE_GLSL, imageSampler: "", image: GLSL_IMAGE },
};

// ── Public API ────────────────────────────────────────────────────────────────

const RESERVED = new Set([
  ...ALL_SHAPE_TYPES.map((t) => `sd${t[0].toUpperCase()}${t.slice(1)}`),
  "smin",
  "applyInvRotXYZ",
  "ndot2",
  "sdImageField",
  "opRepeat",
  "opRepeatCell",
  "cellStep",
  "rot2",
  "opPolar",
  "opTwist",
  "opBend",
  "noiseHash3",
  "noiseHash2",
  "gradientNoise3",
  "fbm3",
  "valueNoised2",
  "terrainHeight",
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
    animated: ir.animated,
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
