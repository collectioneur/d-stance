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
import { renderGlsl, renderShadertoy, renderWgsl, type RenderConstants } from "./renderTemplates";
import { generateSdfCode, PLACEHOLDER } from "../utils/generateSdfCode";
import { sceneBoundRadius, sceneFitSphere } from "../gpu/bounds";
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
  style: "classic" | "chrome";
  background: ExportBackground;
  motion: ExportMotion;
  quality: ExportQuality;
  /** "fit": orbit the scene's own center at a distance that frames it. */
  framing: ExportFraming;
  view: ViewState;
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
  scene: { wgsl: string; glsl: string; images: string[]; view: ExportView };
  mountOptions: { autoRotate: number; maxDpr: number };
}

/** "balanced" is the editor's default preset ("high"): the embed looks like the viewport. */
const QUALITY: Record<ExportQuality, { maxSteps: number; reflSteps: number; maxDpr: number }> = {
  fast: { maxSteps: 32, reflSteps: 12, maxDpr: 1.5 },
  balanced: { maxSteps: 48, reflSteps: 24, maxDpr: 2 },
  best: { maxSteps: 96, reflSteps: 32, maxDpr: 3 },
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

export function generateEmbed(root: SceneRoot, opts: EmbedOptions): EmbedExport {
  const sdf = generateSdfCode(root, null);
  const fnName = sdf.fnName;
  const quality = QUALITY[opts.quality];
  const constants: RenderConstants = {
    style: opts.style,
    background: opts.background,
    maxSteps: quality.maxSteps,
    reflSteps: quality.reflSteps,
    bounds: root.items.length > 0 ? sceneBoundRadius(root.items) + 0.05 : 0,
  };
  // An empty scene still needs a valid SDF function to compile.
  const emptyWgsl = `fn ${fnName}(p: vec3f) -> f32 {\n  return 1e10;\n}`;
  const emptyGlsl = `float ${fnName}(vec3 p) {\n  return 1e10;\n}`;
  const hasShapes = sdf.wgsl !== PLACEHOLDER;
  const sceneWgsl = hasShapes ? sdf.wgsl.replace(DATA_URL_LINE, "") : emptyWgsl;
  const sceneGlsl = hasShapes ? sdf.glsl.replace(DATA_URL_LINE, "") : emptyGlsl;

  const images = collectImages(root.items);
  const view = exportView(root, opts);
  const scene = {
    wgsl: renderWgsl(sceneWgsl, fnName, constants),
    glsl: renderGlsl(sceneGlsl, fnName, constants),
    images,
    view,
  };
  const mountOptions = { autoRotate: AUTO_ROTATE[opts.motion], maxDpr: quality.maxDpr };
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
  const toy = dropped > 0 ? generateSdfCode({ ...root, items: withoutImages(root.items) }, null) : sdf;
  const toyHasShapes = toy.glsl !== PLACEHOLDER;
  const shadertoy = renderShadertoy(
    toyHasShapes ? toy.glsl : `float ${toy.fnName}(vec3 p) {\n  return 1e10;\n}`,
    toy.fnName,
    constants,
    view,
  );

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

function exportView(root: SceneRoot, opts: EmbedOptions): ExportView {
  const { rotX, rotY, distance } = opts.view;
  const sphere = opts.framing === "fit" ? sceneFitSphere(root.items) : null;
  if (!sphere) return { rotX, rotY, distance, target: [0, 0, 0] };
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const radius = round(Math.max(sphere.radius, 0.05));
  return {
    rotX,
    rotY,
    distance: round((radius * 1.1) / Math.sin(HALF_FOV)),
    target: sphere.center.map(round) as [number, number, number],
    fit: radius,
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
