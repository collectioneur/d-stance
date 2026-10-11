/**
 * Ready-to-ship exports of the whole scene:
 *  - html:      a <canvas> + inline module script — paste into any page
 *  - module:    an ES module, `import mount from "./scene.js"; mount(canvas)`
 *  - document:  a standalone .html file (download / open in a tab)
 *  - shadertoy: GLSL for Shadertoy's Image tab
 *
 * The scene SDF is the same code the WGSL / GLSL exports show
 * (generateSdfCode); renderTemplates.ts wraps it in the viewport's camera and
 * shading; runtime.js is inlined verbatim and picks WebGPU or WebGL2.
 */
import runtimeSource from "./runtime.js?raw";
import {
  renderGlsl,
  renderShadertoy,
  renderWgsl,
  type EmbedStyle,
  type RenderConstants,
  type SceneFns,
} from "./renderTemplates";
import { generateMaterialCode, generateSdfCode, PLACEHOLDER } from "../utils/generateSdfCode";
import { sceneFloorY, sceneFrameSphere, sceneMarchRadius, type Sphere } from "../sdf/itemBounds";
import { evaluateAnimations, hasAnimation } from "../store/animation";
import {
  hasInteraction,
  interactiveSlots,
  reactionOffsets,
  REST_STATE,
  type InteractionState,
  type InteractiveSlots,
} from "../store/interaction";
import { IMAGE_SDF_PREFIX } from "../utils/imageSdf";
import type { SceneItem, SceneRoot } from "../store/sceneStore";
import type {
  ExportBackground,
  ExportFormat,
  ExportFraming,
  ExportMotion,
  ExportQuality,
} from "../store/exportStore";
import type { ViewState } from "../store/viewStore";

export interface EmbedOptions {
  style: EmbedStyle;
  background: ExportBackground;
  motion: ExportMotion;
  quality: ExportQuality;
  /** "fit": orbit the scene's own center at a distance that frames it. */
  framing: ExportFraming;
  view: ViewState;
  /** Animation loop length (the editor timeline's), seconds. */
  loop?: number;
}

type ExportView = ViewState & { target: [number, number, number]; fit?: number };

export interface EmbedExport {
  html: string;
  module: string;
  document: string;
  shadertoy: string;
  /** Shapes Shadertoy cannot show (image layers need textures). */
  shadertoyDropped: number;
  /** Raw scene object handed to `mount` (tests, previews). */
  scene: { wgsl: string; glsl: string; images: string[]; view: ExportView; loop?: number; interact?: EmbedInteract };
  mountOptions: { autoRotate: number; maxDpr: number; aa: number };
}

/** What the runtime needs to drive reactions (absent when nothing reacts). */
export interface EmbedInteract {
  /** Per interactive item (pick id − 1): its nearest interactive ancestor, −1 = none. */
  parent: number[];
  hoverable: boolean[];
  clickable: boolean[];
  /** Something follows the pointer: track it over the page. */
  pointer: boolean;
}

/** "balanced" is the editor's default preset ("high"): the embed looks like the viewport. */
const QUALITY: Record<ExportQuality, { maxSteps: number; reflSteps: number; shadowSteps: number; maxDpr: number; aa: number }> = {
  fast: { maxSteps: 32, reflSteps: 12, shadowSteps: 16, maxDpr: 1.5, aa: 4 },
  balanced: { maxSteps: 48, reflSteps: 24, shadowSteps: 24, maxDpr: 2, aa: 16 },
  best: { maxSteps: 96, reflSteps: 32, shadowSteps: 32, maxDpr: 3, aa: 32 },
};

const AUTO_ROTATE: Record<ExportMotion, number> = { still: 0, slow: 0.15, spin: 0.5 };

/** Data URLs live in `images`; the per-image comment lines would double the size. */
const DATA_URL_LINE = new RegExp(`^// ${IMAGE_SDF_PREFIX}.*$\\n?`, "gm");

function withoutImages(items: SceneItem[]): SceneItem[] {
  return items
    .filter((item) => item.kind !== "layer" || item.shapeType !== "image")
    .map((item) => (item.kind === "group" ? { ...item, items: withoutImages(item.items) } : item));
}

function countImages(items: SceneItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "layer") n += item.shapeType === "image" ? 1 : 0;
    else n += countImages(item.items);
  }
  return n;
}

/** JSON that is safe inside an inline <script> (no `</script>` breakouts). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
}

/** `export function mount` → `function mount` for inline (non-imported) use. */
const runtimeInline = runtimeSource.replace(/^export function mount/m, "function mount");

/** Editor default (timelineStore). */
const DEFAULT_LOOP = 8;

interface Extent {
  /** Ray-march bound around the origin. */
  march: number;
  floorY: number;
  /** Null when empty or unbounded. */
  frame: Sphere | null;
}

/**
 * Where the scene can be. A moving scene is sampled over its loop: the march
 * bound, floor and framing cover every pose, not just the first one.
 */
function sceneExtent(root: SceneRoot, loop: number, slots: InteractiveSlots | null): Extent {
  const at = (items: SceneItem[]): Extent => ({
    march: items.length > 0 ? sceneMarchRadius(items) : 0,
    floorY: sceneFloorY(items),
    frame: sceneFrameSphere(items),
  });
  const rest = at(root.items);
  const animated = hasAnimation(root.items);
  if (!animated && !slots) return rest;
  // Reactions: everything hovered and clicked, the pointer in each corner.
  const states: InteractionState[] = [REST_STATE];
  if (slots) {
    const all = new Map(slots.ids.map((id) => [id, 1]));
    for (const pointer of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) states.push({ hover: all, click: all, pointer });
  }
  // ~30 poses a second, at most 240 in all; the margin covers motion between samples.
  const n = animated ? Math.max(8, Math.floor(Math.min(240, Math.max(16, Math.ceil(loop * 30))) / states.length)) : 1;
  let { march, floorY } = rest;
  let reach = rest.frame?.r ?? 0;
  let bounded = rest.frame !== null;
  for (let k = 0; k < n * states.length; k++) {
    const state = states[k % states.length];
    const i = Math.floor(k / states.length);
    if (i === 0 && state === REST_STATE) continue;
    const extra = state === REST_STATE ? undefined : (item: Parameters<typeof reactionOffsets>[0]) => reactionOffsets(item, state);
    const pose = at(evaluateAnimations(root, (loop * i) / n, undefined, extra).items);
    march = Math.max(march, pose.march);
    floorY = Math.max(floorY, pose.floorY);
    if (!pose.frame || !rest.frame) {
      bounded = false;
      continue;
    }
    const c = rest.frame.c;
    const f = pose.frame;
    reach = Math.max(reach, Math.hypot(f.c[0] - c[0], f.c[1] - c[1], f.c[2] - c[2]) + f.r);
  }
  const grow = (v: number) => Math.round(v * 1.03 * 1e4) / 1e4;
  return {
    march: grow(march),
    floorY: Math.round((floorY + 0.03 * (floorY - rest.floorY)) * 1e4) / 1e4,
    frame: bounded && rest.frame ? { c: rest.frame.c, r: grow(reach) } : null,
  };
}

export function generateEmbed(root: SceneRoot, opts: EmbedOptions): EmbedExport {
  const quality = QUALITY[opts.quality];
  const slots = hasInteraction(root.items) ? interactiveSlots(root.items) : null;
  const fns = sceneFns(root, slots);
  const loop = fns.wgsl.animated ? (opts.loop ?? DEFAULT_LOOP) : undefined;
  const extent = sceneExtent(root, loop ?? DEFAULT_LOOP, slots);
  const fit = extent.frame;
  const constants: RenderConstants = {
    style: opts.style,
    background: opts.background,
    maxSteps: quality.maxSteps,
    reflSteps: quality.reflSteps,
    shadowSteps: quality.shadowSteps,
    bounds: extent.march,
    floorY: extent.floorY,
    floorCenter: fit?.c ?? [0, 0, 0],
    floorReach: Math.max(fit?.r ?? 1, 0.2),
    ...(loop ? { loop } : {}),
  };
  const images = collectImages(root.items);
  const view = exportView(fit, opts);
  const scene = {
    wgsl: renderWgsl(fns.wgsl, constants),
    glsl: renderGlsl(fns.glsl, constants),
    images,
    view,
    ...(loop ? { loop } : {}),
    ...(slots
      ? { interact: { parent: slots.parent, hoverable: slots.hoverable, clickable: slots.clickable, pointer: slots.pointer } }
      : {}),
  };
  const mountOptions = { autoRotate: AUTO_ROTATE[opts.motion], maxDpr: quality.maxDpr, aa: quality.aa };
  // Stable per scene, distinct between scenes sharing a page.
  const id = `dstance-${slug(root.name)}-${hash(scene.wgsl + images.join("")).toString(36)}`;

  const html = `<!-- ${root.name} — made with d-stance. Drag to orbit, ctrl/⌘ + scroll to zoom. -->
<canvas id="${id}" style="display:block;width:100%;height:420px"></canvas>
<script type="module">
${runtimeInline}
const scene = ${scriptJson(scene)};
mount(document.getElementById(${JSON.stringify(id)}), scene, ${JSON.stringify(mountOptions)});
</script>
`;

  const module = `// ${root.name} — made with d-stance.
// import mountScene from "./${slug(root.name)}.js";
// const stop = mountScene(document.querySelector("canvas")); // stop() to clean up

${runtimeSource}
const scene = ${JSON.stringify(scene, null, 2)};

export default function mountScene(canvas, options = {}) {
  return mount(canvas, scene, { ...${JSON.stringify(mountOptions)}, ...options });
}
`;

  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(root.name)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0e0e0e; }
  #${id} { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
${html.replace(' style="display:block;width:100%;height:420px"', "")}</body>
</html>
`;

  const dropped = countImages(root.items);
  // Shadertoy has no hover / click: reactions sit at rest there.
  const toyFns = dropped > 0 || slots ? sceneFns(dropped > 0 ? { ...root, items: withoutImages(root.items) } : root, null) : fns;
  const shadertoy = renderShadertoy(toyFns.glsl, constants, view);

  return {
    html,
    module,
    document,
    shadertoy:
      dropped > 0
        ? `// ${dropped} image layer${dropped > 1 ? "s were" : " was"} left out: Shadertoy cannot load custom textures.\n${shadertoy}`
        : shadertoy,
    shadertoyDropped: dropped,
    scene,
    mountOptions,
  };
}

/** Vertical half-FOV of the viewport camera (rd = normalize(uv, 1)). */
const HALF_FOV = Math.PI / 4;

function exportView(frame: Sphere | null, opts: EmbedOptions): ExportView {
  const { rotX, rotY, distance } = opts.view;
  // Unbounded scenes (infinite repeat) keep the editor's view.
  const sphere = opts.framing === "fit" ? frame : null;
  if (!sphere) return { rotX, rotY, distance, target: [0, 0, 0] };
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const radius = round(Math.max(sphere.r, 0.05));
  return {
    rotX,
    rotY,
    distance: round((radius * 1.1) / Math.sin(HALF_FOV)),
    target: sphere.c.map(round) as [number, number, number],
    fit: radius,
  };
}

/** Scene SDF + material functions per language; empty scenes get stubs that compile. */
function sceneFns(root: SceneRoot, slots: InteractiveSlots | null): { wgsl: SceneFns; glsl: SceneFns } {
  const opts = slots ? { interactive: slots } : {};
  const sdf = generateSdfCode(root, null, opts);
  const mat = generateMaterialCode(root, opts);
  const interactiveCount = slots ? { interactiveCount: slots.ids.length } : {};
  const empty = sdf.wgsl === PLACEHOLDER;
  const name = sdf.fnName;
  return {
    wgsl: {
      sdf: empty ? `fn ${name}(p: vec3f) -> f32 {\n  return 1e10;\n}` : sdf.wgsl.replace(DATA_URL_LINE, ""),
      sdfName: name,
      material: mat.wgsl,
      materialName: mat.fnName,
      animated: sdf.animated,
      ...interactiveCount,
    },
    glsl: {
      sdf: empty ? `float ${name}(vec3 p) {\n  return 1e10;\n}` : sdf.glsl.replace(DATA_URL_LINE, ""),
      sdfName: name,
      material: mat.glsl,
      materialName: mat.fnName,
      animated: sdf.animated,
      ...interactiveCount,
    },
  };
}

function collectImages(items: SceneItem[], out: string[] = []): string[] {
  for (const item of items) {
    if (item.kind === "layer") {
      if (item.shapeType === "image" && item.image && !out.includes(item.image.sdf)) {
        out.push(item.image.sdf);
      }
    } else {
      collectImages(item.items, out);
    }
  }
  return out;
}

/** FNV-1a, 32 bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function exportFileName(root: SceneRoot, format: ExportFormat): string {
  return `${slug(root.name)}.${format === "module" ? "js" : "html"}`;
}
