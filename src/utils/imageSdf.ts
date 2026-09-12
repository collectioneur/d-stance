/**
 * Image → 2D signed distance field, baked on the CPU into a 16-bit PNG.
 *
 * Pipeline (see bakeImageSdf):
 *   bitmap → foreground score (alpha, or luminance) → Otsu threshold → mask
 *   → crop to mask bbox, pad to a square → re-rasterize at SUPERSAMPLE×RES
 *   → exact Euclidean distance transform → box-average down to RES
 *   → split into coarse (R) + residual (G) bytes → PNG data URL.
 *
 * The supersampled EDT + averaging is what makes the result resolution
 * independent: the zero contour lands at sub-pixel positions, so bilinear
 * sampling on the GPU gives smooth edges at any zoom (Valve 2007 trick).
 *
 * Encoding (16 bit, covers the whole texture so there is no plateau for
 * smooth-union to blend against):
 *   R = round(d / STEP_PX) + 128            coarse, STEP_PX per level
 *   G = (d / STEP_PX − round(d / STEP_PX) + ½) · 255   residual
 *   d_px = STEP_PX · (R − 128.5 + G / 255)
 * Contract shared with shader.ts / generateSdfCode.ts:
 *   normalized t = d_px / RES  ⇒  distance = t · textureWidth
 * In-app the PNG is decoded to r16float (t directly), so filtering happens on
 * the reassembled value. Exported code samples .rg and reassembles per tap.
 * Outside the texture square the shader uses √(dBox² + dEdge²): the nearest
 * content point c lies inside the square, so for p outside and q = its
 * clamp onto the square, ∠(p−q, c−q) ≥ 90° and |p−c|² ≥ |p−q|² + |q−c|².
 */

/** Texture side in pixels. */
export const IMAGE_SDF_RES = 256;
/** Coarse quantization step (R channel) in texture pixels; R covers ±RES. */
export const IMAGE_SDF_STEP_PX = 2;
export const IMAGE_SDF_PREFIX = "data:image/png;base64,";
/** Upper bound for a persisted PNG; anything larger is treated as hostile. */
export const IMAGE_SDF_MAX_CHARS = 400_000;
/** f16 bit pattern for "far outside" — what empty texture slots hold. */
export const IMAGE_SDF_EMPTY_HALF = 0x7bff; // 65504, the largest finite f16

const SUPERSAMPLE = 4;
const ANALYSIS_MAX = 512;
/** Padding on each side of the crop square, as a fraction of the side. */
const PAD = 1 / 8; // room for `bold` and for the field to settle before the edge

export type ImageAnalysis = {
  width: number;
  height: number;
  /** Per-pixel foreground score in [0,1]. */
  score: Float32Array;
  hasAlpha: boolean;
  /** Otsu threshold on `score`. */
  threshold: number;
  /** True when the border looks like foreground (bright background). */
  invert: boolean;
};

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreOf(data: Uint8ClampedArray, hasAlpha: boolean): Float32Array {
  const n = data.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = hasAlpha
      ? data[o + 3] / 255
      : (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
  }
  return out;
}

function detectAlpha(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** Otsu's threshold on a [0,1] score array (256-bin histogram). */
export function otsu(score: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < score.length; i++) hist[Math.min(255, (score[i] * 255) | 0)]++;
  const total = score.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let firstT = 127;
  let lastT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      firstT = lastT = t;
    } else if (between === best) {
      lastT = t; // plateau (empty bins between the modes): take its middle
    }
  }
  return ((firstT + lastT) / 2 + 0.5) / 255;
}

/** Crop rectangle as fractions of the source image, x0 < x1, y0 < y1 in [0, 1]. */
export type ImageCrop = { x0: number; y0: number; x1: number; y1: number };

function drawToCanvas(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  fill: string | null,
  src?: [number, number, number, number],
  /** Destination-space clip; everything outside stays `fill` (background). */
  clip?: [number, number, number, number],
): ImageData {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip[0], clip[1], clip[2], clip[3]);
    ctx.clip();
  }
  if (src) ctx.drawImage(bitmap, src[0], src[1], src[2], src[3], 0, 0, w, h);
  else ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export function analyzeImage(bitmap: ImageBitmap): ImageAnalysis {
  const s = Math.min(1, ANALYSIS_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * s));
  const height = Math.max(1, Math.round(bitmap.height * s));
  const { data } = drawToCanvas(bitmap, width, height, null);
  const hasAlpha = detectAlpha(data);
  const score = scoreOf(data, hasAlpha);
  const threshold = otsu(score);

  // Border heuristic: whatever dominates the frame edge is the background.
  let borderSum = 0;
  let borderN = 0;
  for (let x = 0; x < width; x++) {
    borderSum += score[x] + score[(height - 1) * width + x];
    borderN += 2;
  }
  for (let y = 1; y < height - 1; y++) {
    borderSum += score[y * width] + score[y * width + width - 1];
    borderN += 2;
  }
  const invert = borderSum / borderN > threshold;
  return { width, height, score, hasAlpha, threshold, invert };
}

export function buildMask(score: Float32Array, threshold: number, invert: boolean): Uint8Array {
  const mask = new Uint8Array(score.length);
  for (let i = 0; i < score.length; i++) mask[i] = (score[i] > threshold) !== invert ? 1 : 0;
  return mask;
}

export function maskPreview(mask: Uint8Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 235 : 25;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

// ── Euclidean distance transform (Felzenszwalb & Huttenlocher) ────────────────

const INF = 1e20;

function dt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** In-place squared EDT of `grid` (0 = seed, INF = empty). */
function edt2d(grid: Float32Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, h, out, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(f, w, out, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = out[x];
  }
}

/** Signed distance in pixels (negative inside), boundary at pixel edges. */
export function sdfFromMask(mask: Uint8Array, w: number, h: number): Float32Array {
  const toInside = new Float32Array(mask.length);
  const toOutside = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    toInside[i] = mask[i] ? 0 : INF;
    toOutside[i] = mask[i] ? INF : 0;
  }
  edt2d(toInside, w, h);
  edt2d(toOutside, w, h);
  const sdf = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    sdf[i] = mask[i]
      ? -(Math.sqrt(toOutside[i]) - 0.5)
      : Math.sqrt(toInside[i]) - 0.5;
  }
  return sdf;
}

// ── Encoding ──────────────────────────────────────────────────────────────────

/** Distance in texture px → [R, G] bytes. Saturates at both ends. */
export function encodeSdfBytes(distPx: number): [number, number] {
  const u = distPx / IMAGE_SDF_STEP_PX;
  const r = Math.min(255, Math.max(0, Math.round(u) + 128));
  const g = Math.round((u - (r - 128) + 0.5) * 255); // residual vs. the clamped R
  return [r, g < 0 ? 0 : g > 255 ? 255 : g];
}

/** [R, G] bytes → distance in texture px. */
export function decodeSdfBytes(r: number, g: number): number {
  return IMAGE_SDF_STEP_PX * (r - 128.5 + g / 255);
}

/** Box-average the supersampled field down to RES², then quantize to RGBA. */
function downsampleEncode(sdf: Float32Array, srcSize: number): Uint8ClampedArray {
  const k = srcSize / IMAGE_SDF_RES;
  const out = new Uint8ClampedArray(IMAGE_SDF_RES * IMAGE_SDF_RES * 4);
  const inv = 1 / (k * k * k); // k² samples, then /k to convert src px → dst px
  for (let y = 0; y < IMAGE_SDF_RES; y++) {
    for (let x = 0; x < IMAGE_SDF_RES; x++) {
      let sum = 0;
      for (let dy = 0; dy < k; dy++) {
        const row = (y * k + dy) * srcSize + x * k;
        for (let dx = 0; dx < k; dx++) sum += sdf[row + dx];
      }
      const [r, g] = encodeSdfBytes(sum * inv);
      const o = (y * IMAGE_SDF_RES + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = 0;
      out[o + 3] = 255; // opaque, or the canvas would premultiply R/G
    }
  }
  return out;
}

function rgbaToPng(rgba: Uint8ClampedArray): string {
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SDF_RES;
  canvas.height = IMAGE_SDF_RES;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(IMAGE_SDF_RES, IMAGE_SDF_RES);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// ── f16 ───────────────────────────────────────────────────────────────────────

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** IEEE binary16 bit pattern of `v` (round-to-nearest-even). */
export function floatToHalf(v: number): number {
  f32Scratch[0] = v;
  const x = u32Scratch[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++; // may carry into exp: correct
  return half;
}

/**
 * Full bake. Returns a PNG data URL, or null when the mask is empty.
 * `threshold` / `invert` normally come from analyzeImage (user-adjustable).
 * `crop` limits the shape to a sub-rectangle of the image; outside it the
 * source reads as background.
 */
export function bakeImageSdf(
  bitmap: ImageBitmap,
  analysis: ImageAnalysis,
  threshold: number,
  invert: boolean,
  crop: ImageCrop | null = null,
): string | null {
  const { width, height } = analysis;
  const mask = buildMask(analysis.score, threshold, invert);
  // Search window for the content bbox, in analysis pixels.
  const wx0 = crop ? Math.max(0, Math.floor(crop.x0 * width)) : 0;
  const wy0 = crop ? Math.max(0, Math.floor(crop.y0 * height)) : 0;
  const wx1 = crop ? Math.min(width, Math.ceil(crop.x1 * width)) : width;
  const wy1 = crop ? Math.min(height, Math.ceil(crop.y1 * height)) : height;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = wy0; y < wy1; y++) {
    for (let x = wx0; x < wx1; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;

  // Padded square crop in source-bitmap pixels (may extend past the image).
  const sx = bitmap.width / width;
  const sy = bitmap.height / height;
  const bw = (x1 - x0 + 1) * sx;
  const bh = (y1 - y0 + 1) * sy;
  const side = Math.max(bw, bh) / (1 - 2 * PAD);
  const cx = (x0 + x1 + 1) * 0.5 * sx;
  const cy = (y0 + y1 + 1) * 0.5 * sy;

  const S = IMAGE_SDF_RES * SUPERSAMPLE;
  // Out-of-image area must read as background: transparent for alpha
  // sources, otherwise the background luminance implied by `invert`.
  const fill = analysis.hasAlpha ? null : invert ? "#fff" : "#000";
  const ox = cx - side / 2;
  const oy = cy - side / 2;
  // Crop → destination px of the S×S raster (source px minus origin, scaled).
  const k = S / side;
  const clip: [number, number, number, number] | undefined = crop
    ? [
        (crop.x0 * bitmap.width - ox) * k,
        (crop.y0 * bitmap.height - oy) * k,
        (crop.x1 - crop.x0) * bitmap.width * k,
        (crop.y1 - crop.y0) * bitmap.height * k,
      ]
    : undefined;
  const { data } = drawToCanvas(bitmap, S, S, fill, [ox, oy, side, side], clip);
  const hiMask = buildMask(scoreOf(data, analysis.hasAlpha), threshold, invert);
  const sdf = sdfFromMask(hiMask, S, S);
  return rgbaToPng(downsampleEncode(sdf, S));
}

/** Trust-boundary check for persisted values. */
export function isImageSdfDataUrl(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= IMAGE_SDF_MAX_CHARS &&
    v.startsWith(IMAGE_SDF_PREFIX) &&
    /^[A-Za-z0-9+/]+=*$/.test(v.slice(IMAGE_SDF_PREFIX.length))
  );
}

/**
 * Decode a baked PNG to RES² normalized distances (d_px / RES) as f16 bit
 * patterns, ready for an r16float texture upload.
 */
export async function decodeSdfPng(dataUrl: string): Promise<Uint16Array> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(IMAGE_SDF_RES, IMAGE_SDF_RES);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, IMAGE_SDF_RES, IMAGE_SDF_RES);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, IMAGE_SDF_RES, IMAGE_SDF_RES);
  const out = new Uint16Array(IMAGE_SDF_RES * IMAGE_SDF_RES);
  for (let i = 0; i < out.length; i++) {
    out[i] = floatToHalf(decodeSdfBytes(data[i * 4], data[i * 4 + 1]) / IMAGE_SDF_RES);
  }
  return out;
}

// ── Import-time self-check ────────────────────────────────────────────────────

function assertImageSdf() {
  const n = 64;
  const r = 20;
  const mask = new Uint8Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      mask[y * n + x] = Math.hypot(x - 32, y - 32) <= r ? 1 : 0;
  const sdf = sdfFromMask(mask, n, n);
  const check = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`imageSdf self-check failed: ${what}`);
  };
  check(Math.abs(sdf[32 * n + 32] + r) < 1, `center ${sdf[32 * n + 32]} ≈ -${r}`);
  check(Math.abs(sdf[32 * n + 62] - 10) < 1, `outside ${sdf[32 * n + 62]} ≈ 10`);
  check(Math.abs(sdf[32 * n + 52] - 0) <= 1, `edge ${sdf[32 * n + 52]} ≈ 0`);
  for (const dpx of [7.25, -7.25, 0, 0.003, -0.003, 131.7, -100.2, 253]) {
    const [r8, g8] = encodeSdfBytes(dpx);
    check(Math.abs(decodeSdfBytes(r8, g8) - dpx) < 0.01, `u16 round trip ${dpx}`);
  }
  check(encodeSdfBytes(1e9)[0] === 255 && encodeSdfBytes(-1e9)[0] === 0, "u16 clamp");
  check(floatToHalf(1) === 0x3c00 && floatToHalf(-1) === 0xbc00, "f16 ±1");
  check(floatToHalf(0.5) === 0x3800 && floatToHalf(0) === 0, "f16 0.5 / 0");
  check(floatToHalf(65504) === IMAGE_SDF_EMPTY_HALF, "f16 max");
  check(floatToHalf(3e-5) === 0x01f7, "f16 subnormal");
  check(otsu(new Float32Array([0, 0, 0, 1, 1, 1])) > 0.3, "otsu bimodal");
}
assertImageSdf();
