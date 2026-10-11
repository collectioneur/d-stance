import { expect, type Page } from "@playwright/test";

/** Any JSON-able scene root (see src/store/sceneStore.ts SceneRoot). */
export type SceneJson = { id: string; name: string; items: unknown[] };

let counter = 0;
export const uid = (p = "id") => `${p}-${++counter}`;

export function sphere(extra: Record<string, unknown> = {}) {
  return {
    kind: "layer",
    id: uid("sphere"),
    shapeType: "sphere",
    name: "Sphere",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    params: [0.5, 0, 0, 0],
    op: "union",
    smoothK: 0.1,
    ...extra,
  };
}

export function box(extra: Record<string, unknown> = {}) {
  return { ...sphere(), id: uid("box"), shapeType: "box", name: "Box", params: [0.4, 0.4, 0.4, 0], ...extra };
}

export function encodeScene(root: SceneJson, v = 6): string {
  const json = JSON.stringify({ v, root, counters: {}, groupCounter: 0 });
  return Buffer.from(json, "utf8").toString("base64");
}

/** Opens the editor on a fresh origin state with `root` loaded from the hash. */
export async function openEditor(page: Page, root?: SceneJson) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // Each test gets a fresh browser context, so storage starts empty.
  await page.goto(root ? `/#${encodeScene(root)}` : "/");
  await waitForFrames(page);
  return errors;
}

/** Waits until the renderer has presented a few frames. */
export async function waitForFrames(page: Page, frames = 3) {
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "1");
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames + 2,
  );
}

export type PixelStats = {
  /** Mean luminance 0..255. */
  mean: number;
  /** Fraction of pixels that look like a lit surface (bright, unsaturated). */
  coverage: number;
  /** Centroid of covered pixels in [0,1]² (NaN when none). */
  cx: number;
  cy: number;
};

/** Canvas pixels only: the floating panels are hidden for the shot. */
export async function canvasShot(page: Page, path?: string): Promise<Buffer> {
  await page.addStyleTag({ content: "#root > *:not(canvas) { visibility: hidden !important; }" });
  await waitForFrames(page, 1);
  const png = await page.locator("canvas").screenshot({ path });
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
    if (s.textContent?.includes("visibility: hidden !important")) s.remove();
  }));
  return png;
}

/** Screenshot the canvas and measure it in-page (no image deps in node). */
export async function canvasStats(page: Page): Promise<PixelStats> {
  const png = await canvasShot(page);
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
    const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    // Background, grid and axis lines stay dark or saturated; shapes are lit
    // and near-gray in both render modes.
    const isObject = (i: number) => {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      return lum(i) > 62 && Math.max(r, g, b) - Math.min(r, g, b) < 60;
    };
    let sum = 0, cov = 0, sx = 0, sy = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        sum += lum(i);
        if (isObject(i)) {
          cov++;
          sx += x;
          sy += y;
        }
      }
    }
    const n = Math.ceil(height / 2) * Math.ceil(width / 2);
    return { mean: sum / n, coverage: cov / n, cx: sx / cov / width, cy: sy / cov / height };
  }, png.toString("base64"));
}

/** Current scene root as stored by the app (dev builds expose the store). */
export async function sceneRoot(page: Page): Promise<SceneJson & { items: { id: string; name: string }[] }> {
  return page.evaluate(() => (window as unknown as { __dstance: { scene: () => unknown } }).__dstance.scene()) as never;
}
