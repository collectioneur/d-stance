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
import { GLSL_HELPERS, TG_HELPERS, WGSL_HELPERS, primitiveCall } from "../sdf/primitives";

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
}
interface VarRhs {
  kind: "var";
  name: string;
}
type Rhs = ShapeRhs | VarRhs;

type Stmt =
  | { t: "point"; name: string; from: string; pos: V3 | null; rotRad: V3 | null; scale: V3 | null }
  | { t: "def"; name: string; rhs: Rhs }
  | { t: "combine"; name: string; op: OpType; k: number; rhs: Rhs };

interface Ir {
  stmts: Stmt[];
  result: string | null;
  usedShapes: Set<ShapeType>;
  usesRotation: boolean;
  usesSmin: boolean;
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
  const usedShapes = new Set<ShapeType>();
  const images: string[] = [];
  let usesRotation = false;
  let usesSmin = false;
  let accN = 0;
  let ptN = 0;

  function shapeRhs(layer: ShapeLayer, point: string, accScl: V3, dropPos: boolean): ShapeRhs {
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
    };
  }

  function groupPoint(group: ObjectGroup, point: string, dropPos: boolean): string {
    const pos = dropPos || isZero(group.position) ? null : group.position;
    const rot = isZero(group.rotation) ? null : toRad(group.rotation);
    const scale = isOne(group.scale) ? null : group.scale;
    if (!pos && !rot && !scale) return point;
    if (rot) usesRotation = true;
    const name = `q${++ptN}`;
    stmts.push({ t: "point", name, from: point, pos, rotRad: rot, scale });
    return name;
  }

  function walkItems(items: SceneItem[], point: string, accScl: V3): string | null {
    let acc: string | null = null;
    for (const item of items) {
      let rhs: Rhs | null = null;
      if (item.kind === "layer") {
        rhs = shapeRhs(item, point, accScl, false);
      } else if (item.items.length > 0) {
        const childPoint = groupPoint(item, point, false);
        const childAcc = walkItems(item.items, childPoint, mulV(accScl, item.scale));
        if (childAcc) rhs = { kind: "var", name: childAcc };
      }
      if (!rhs) continue;
      if (!acc) {
        acc = `d${accN++}`;
        stmts.push({ t: "def", name: acc, rhs });
      } else {
        if (SMOOTH_OPS.has(item.op)) usesSmin = true;
        stmts.push({ t: "combine", name: acc, op: item.op, k: item.smoothK, rhs });
      }
    }
    return acc;
  }

  const selected = selectedItemId ? findItemIn(root.items, selectedItemId) : null;
  let result: string | null;
  if (selected?.kind === "layer") {
    const acc = `d${accN++}`;
    stmts.push({ t: "def", name: acc, rhs: shapeRhs(selected, "p", [1, 1, 1], true) });
    result = acc;
  } else if (selected?.kind === "group") {
    const point = groupPoint(selected, "p", true);
    result = walkItems(selected.items, point, selected.scale);
  } else {
    result = walkItems(root.items, "p", [1, 1, 1]);
  }

  return { stmts, result, usedShapes, usesRotation, usesSmin, images };
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
  minFn: string;
  maxFn: string;
  divVec(e: string, v: V3): string;
  pointStmt(name: string, expr: string): string;
  defStmt(name: string, expr: string): string;
  assignStmt(name: string, expr: string): string;
  fnOpen(fn: string): string;
  fnClose: string;
  helpers: {
    shapes: Record<ShapeType, string>;
    rot: string;
    smin: string;
    imageSampler: string;
    image: (i: number, url: string) => string;
  };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const paren = (e: string) => (IDENT.test(e) ? e : `(${e})`);
const neg = (e: string) => (IDENT.test(e) ? `-${e}` : `-(${e})`);

function shapeCall(syn: Syntax, rhs: ShapeRhs): string {
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
  return Math.abs(rhs.factor - 1) > 1e-9 ? `${call} * ${fmt(rhs.factor)}` : call;
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
    for (const stmt of ir.stmts) {
      if (stmt.t === "point") body.push(syn.pointStmt(stmt.name, pointExpr(syn, stmt)));
      else if (stmt.t === "def") body.push(syn.defStmt(stmt.name, rhsExpr(syn, stmt.rhs)));
      else body.push(syn.assignStmt(stmt.name, combineExpr(syn, stmt.name, stmt.op, stmt.k, rhsExpr(syn, stmt.rhs))));
    }
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

  return [...helpers, `${syn.fnOpen(fnName)}\n${body.join("\n")}\n${syn.fnClose}`].join("\n\n");
}

const TG_SYNTAX: Syntax = {
  vec3: (v) => `d.vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `d.vec2f(${fmt(x)}, ${fmt(y)})`,
  minFn: "std.min",
  maxFn: "std.max",
  divVec: (e, v) => `${paren(e)} * d.vec3f(${fmtRecip(v[0])}, ${fmtRecip(v[1])}, ${fmtRecip(v[2])})`,
  pointStmt: (n, e) => `  const ${n} = ${e};`,
  defStmt: (n, e) => `  let ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `const ${fn} = (p: d.v3f): number => {\n  "use gpu";`,
  fnClose: "};",
  helpers: { shapes: TG_HELPERS, rot: TG_ROT, smin: TG_SMIN, imageSampler: TG_IMAGE_SAMPLER, image: TG_IMAGE },
};

const WGSL_SYNTAX: Syntax = {
  vec3: (v) => `vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `vec2f(${fmt(x)}, ${fmt(y)})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3f(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  pointStmt: (n, e) => `  let ${n} = ${e};`,
  defStmt: (n, e) => `  var ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `fn ${fn}(p: vec3f) -> f32 {`,
  fnClose: "}",
  helpers: { shapes: WGSL_HELPERS, rot: WGSL_ROT, smin: WGSL_SMIN, imageSampler: WGSL_IMAGE_SAMPLER, image: WGSL_IMAGE },
};

const GLSL_SYNTAX: Syntax = {
  vec3: (v) => `vec3(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  vec2: (x, y) => `vec2(${fmt(x)}, ${fmt(y)})`,
  minFn: "min",
  maxFn: "max",
  divVec: (e, v) => `${paren(e)} / vec3(${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])})`,
  pointStmt: (n, e) => `  vec3 ${n} = ${e};`,
  defStmt: (n, e) => `  float ${n} = ${e};`,
  assignStmt: (n, e) => `  ${n} = ${e};`,
  fnOpen: (fn) => `float ${fn}(vec3 p) {`,
  fnClose: "}",
  helpers: { shapes: GLSL_HELPERS, rot: GLSL_ROT, smin: GLSL_SMIN, imageSampler: "", image: GLSL_IMAGE },
};

// ── Public API ────────────────────────────────────────────────────────────────

const RESERVED = new Set([
  ...ALL_SHAPE_TYPES.map((t) => `sd${t[0].toUpperCase()}${t.slice(1)}`),
  "smin",
  "applyInvRotXYZ",
  "ndot2",
  "sdImageField",
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
