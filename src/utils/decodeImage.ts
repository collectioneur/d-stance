/**
 * File → ImageBitmap for the image importer.
 *
 * Rasters go straight through createImageBitmap. SVG needs a detour:
 * createImageBitmap(Blob) rejects SVG outright in Chrome/Safari, and Firefox
 * only accepts it when the root has absolute width/height. So we parse the
 * SVG, pin an explicit pixel size on the root (keeping the aspect ratio from
 * width/height or viewBox), load it through <img> and draw it onto a canvas.
 */

/** Long side of the raster an SVG is rendered at before SDF analysis. */
const SVG_RASTER_SIZE = 1024;
/** Intrinsic size the SVG spec assigns to a root with neither size nor viewBox. */
const SVG_DEFAULT_W = 300;
const SVG_DEFAULT_H = 150;

/** CSS absolute units → px. Only the ratio matters unless we synthesize a viewBox. */
const UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
};

export function isSvgFile(file: File): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

/** Anything the importer can decode (some sources hand over SVG with an empty type). */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || isSvgFile(file);
}

export async function decodeImageFile(file: File): Promise<ImageBitmap> {
  if (!isSvgFile(file)) return createImageBitmap(file);
  return rasterizeSvg(await file.text());
}

// ── SVG ──────────────────────────────────────────────────────────────────────

/** Absolute length in px, or null for missing / percentage / relative units. */
function absoluteLength(v: string | null): number | null {
  if (!v) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!m) return null;
  const factor = UNIT_PX[m[2].toLowerCase()];
  if (factor === undefined) return null;
  const n = parseFloat(m[1]) * factor;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseViewBox(v: string | null): [number, number, number, number] | null {
  if (!v) return null;
  const p = v.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x)) || p[2] <= 0 || p[3] <= 0) {
    return null;
  }
  return [p[0], p[1], p[2], p[3]];
}

/** Intrinsic size in px following the SVG sizing rules (width/height, then viewBox ratio). */
function intrinsicSize(root: Element): { w: number; h: number; viewBox: string | null } {
  const w = absoluteLength(root.getAttribute("width"));
  const h = absoluteLength(root.getAttribute("height"));
  const vb = parseViewBox(root.getAttribute("viewBox"));
  const viewBox = vb ? vb.join(" ") : null;
  if (w && h) return { w, h, viewBox };
  if (vb) {
    const ratio = vb[2] / vb[3];
    if (w) return { w, h: w / ratio, viewBox };
    if (h) return { w: h * ratio, h, viewBox };
    return { w: vb[2], h: vb[3], viewBox };
  }
  return { w: w ?? SVG_DEFAULT_W, h: h ?? SVG_DEFAULT_H, viewBox: null };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG failed to load"));
    img.src = url;
  });
}

async function rasterizeSvg(text: string): Promise<ImageBitmap> {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) {
    throw new Error("Invalid SVG");
  }

  const { w, h, viewBox } = intrinsicSize(root);
  const scale = SVG_RASTER_SIZE / Math.max(w, h);
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));

  // Without a viewBox the content would not scale with the new width/height,
  // so synthesize one from the original intrinsic size.
  if (!viewBox) root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  root.setAttribute("width", String(pw));
  root.setAttribute("height", String(ph));

  const svg = new XMLSerializer().serializeToString(root);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await loadImage(url);
    const canvas = new OffscreenCanvas(pw, ph);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, pw, ph);
    return createImageBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}
