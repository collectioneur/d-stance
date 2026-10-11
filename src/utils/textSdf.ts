/**
 * Text → baked 2D SDF (the same PNG an image layer carries), so a text layer
 * is an image layer that remembers how it was made (`image.text`) and can be
 * re-baked when the words or the font change.
 *
 * Layout: lines are measured by their ink, the block is centered in the
 * padded square at MASK_SDF_SIZE px (font size chosen so the longer side
 * fills it), the alpha is thresholded and encodeMaskSdf runs the exact EDT.
 */
import { MASK_SDF_PAD, MASK_SDF_SIZE, encodeMaskSdf } from "./imageSdf";

export type TextAlign = "left" | "center" | "right";

export interface TextSpec {
  /** Up to MAX_TEXT_LINES lines. */
  content: string;
  /** A TEXT_FONTS key, or "custom:<family>" for an installed font. */
  font: string;
  /** 100–900. */
  weight: number;
  italic: boolean;
  /** Extra space between letters, in em. */
  spacing: number;
  align: TextAlign;
}

/** Image params of a new text layer: half width 0.8 (≈ 1.2 units of ink), half thickness 0.08. */
export const TEXT_PARAMS: [number, number, number, number] = [0.8, 0.08, 0, 0];

export const DEFAULT_TEXT: TextSpec = { content: "Hello", font: "inter", weight: 800, italic: false, spacing: 0, align: "center" };

export const MAX_TEXT_CHARS = 120;
export const MAX_TEXT_LINES = 4;
export const MIN_SPACING_EM = -0.2;
export const MAX_SPACING_EM = 1;

/** Fonts the editor offers. Inter and JetBrains Mono ship with the app (variable weights). */
export const TEXT_FONTS: { key: string; label: string; css: string }[] = [
  { key: "inter", label: "Inter", css: '"Inter Variable", Inter, sans-serif' },
  { key: "mono", label: "Mono", css: '"JetBrains Mono Variable", ui-monospace, monospace' },
  { key: "serif", label: "Serif", css: 'Georgia, "Times New Roman", serif' },
  { key: "rounded", label: "Rounded", css: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", sans-serif' },
  { key: "system", label: "System", css: "system-ui, sans-serif" },
];

const CUSTOM = "custom:";
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 \-]{0,39}$/;

export function customFamily(font: string): string | null {
  if (!font.startsWith(CUSTOM)) return null;
  const family = font.slice(CUSTOM.length).trim();
  return FAMILY.test(family) ? family : null;
}

export function customFont(family: string): string {
  return `${CUSTOM}${family}`;
}

/** CSS font-family list for a spec (unknown fonts fall back to Inter). */
export function fontFamily(font: string): string {
  const known = TEXT_FONTS.find((f) => f.key === font);
  if (known) return known.css;
  const family = customFamily(font);
  return family ? `"${family}", ${TEXT_FONTS[0].css}` : TEXT_FONTS[0].css;
}

export function fontCss(spec: TextSpec, px: number): string {
  return `${spec.italic ? "italic " : ""}${spec.weight} ${px}px ${fontFamily(spec.font)}`;
}

/** Text without control characters, at most MAX_TEXT_LINES lines and MAX_TEXT_CHARS characters. */
export function cleanText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  return flat.split("\n").slice(0, MAX_TEXT_LINES).join("\n").slice(0, MAX_TEXT_CHARS);
}

/** A well-formed spec, or undefined (dropped). Trust boundary (hash links). */
export function sanitizeTextSpec(raw: unknown): TextSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.content !== "string") return undefined;
  const content = cleanText(r.content);
  const font =
    typeof r.font === "string" && (TEXT_FONTS.some((f) => f.key === r.font) || customFamily(r.font)) ? r.font : DEFAULT_TEXT.font;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    content,
    font,
    weight: Math.round(num(r.weight, DEFAULT_TEXT.weight, 100, 900)),
    italic: r.italic === true,
    spacing: num(r.spacing, 0, MIN_SPACING_EM, MAX_SPACING_EM),
    align: r.align === "left" || r.align === "right" ? r.align : "center",
  };
}

/** Waits for the font (bundled web fonts load lazily); system fonts resolve at once. */
export async function ensureFont(spec: TextSpec): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.load(fontCss(spec, 100), spec.content || "A");
  } catch {
    /* unknown family: the canvas falls back */
  }
}

type Ink = { left: number; right: number; ascent: number; descent: number; width: number };

function measureLines(ctx: CanvasRenderingContext2D, lines: string[]): Ink[] {
  return lines.map((line) => {
    const m = ctx.measureText(line || " ");
    return {
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
      width: m.width,
    };
  });
}

/**
 * Bake `spec` into an image-layer SDF PNG. Null when there is nothing to
 * draw (empty or whitespace-only text). Synchronous after ensureFont.
 */
export function bakeTextSdf(spec: TextSpec): string | null {
  const lines = cleanText(spec.content).split("\n");
  if (lines.every((l) => l.trim() === "")) return null;
  const S = MASK_SDF_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Measure at a reference size, then scale the font so the block fills the square.
  const REF = 100;
  const setFont = (px: number) => {
    ctx.font = fontCss(spec, px);
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spec.spacing * px}px`;
  };
  setFont(REF);
  const lineGap = REF * 1.15;
  const layout = (ink: Ink[], gap: number) => {
    const widest = Math.max(...ink.map((m) => m.width));
    // Pen x per line (align within the widest advance), ink box of the block.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const pens = ink.map((m, i) => {
      const pen = spec.align === "left" ? 0 : spec.align === "right" ? widest - m.width : (widest - m.width) / 2;
      const base = i * gap;
      if (lines[i].trim() !== "") {
        x0 = Math.min(x0, pen - m.left);
        x1 = Math.max(x1, pen + m.right);
        y0 = Math.min(y0, base - m.ascent);
        y1 = Math.max(y1, base + m.descent);
      }
      return { pen, base };
    });
    return { pens, x0, x1, y0, y1 };
  };
  const ref = layout(measureLines(ctx, lines), lineGap);
  const inner = S * (1 - 2 * MASK_SDF_PAD);
  const px = (REF * inner) / Math.max(ref.x1 - ref.x0, ref.y1 - ref.y0, 1);

  setFont(px);
  const fit = layout(measureLines(ctx, lines), lineGap * (px / REF));
  const ox = S / 2 - (fit.x0 + fit.x1) / 2;
  const oy = S / 2 - (fit.y0 + fit.y1) / 2;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  lines.forEach((line, i) => ctx.fillText(line, ox + fit.pens[i].pen, oy + fit.pens[i].base));

  const { data } = ctx.getImageData(0, 0, S, S);
  const mask = new Uint8Array(S * S);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return encodeMaskSdf(mask);
}

/** Layer name for a text: its first line, shortened. */
export function textLayerName(content: string): string {
  const first = content.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  if (!first) return "Text";
  return first.length > 24 ? `${first.slice(0, 23)}…` : first;
}

/** Bake after the font is ready. */
export async function bakeText(spec: TextSpec): Promise<string | null> {
  await ensureFont(spec);
  return bakeTextSdf(spec);
}
