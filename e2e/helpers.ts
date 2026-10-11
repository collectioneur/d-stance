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

export function encodeScene(root: SceneJson, v = 13): string {
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
  await page.addStyleTag({
    content: "body * { visibility: hidden !important; } canvas { visibility: visible !important; }",
  });
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

/** Per-pixel comparison of two same-size PNGs (decoded in-page). */
export async function imageDiff(page: Page, a: Buffer, b: Buffer): Promise<{ meanAbs: number; over16: number }> {
  return page.evaluate(
    async ([a64, b64]) => {
      const load = async (b64s: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64s}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d")!;
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [x, y] = await Promise.all([load(a64), load(b64)]);
      if (x.length !== y.length) return { meanAbs: 255, over16: 1 };
      let sum = 0, over = 0, n = 0;
      for (let i = 0; i < x.length; i += 4) {
        const d = (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])) / 3;
        sum += d;
        if (d > 16) over++;
        n++;
      }
      return { meanAbs: sum / n, over16: over / n };
    },
    [a.toString("base64"), b.toString("base64")] as const,
  );
}

/** Waits until the compiled program for the current scene is on screen. */
export async function waitForProgram(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __dstance: { gpu: { synced(): boolean } } }).__dstance?.gpu?.synced());
  await waitForFrames(page, 2);
}

/** Bakes a ring-shaped image SDF in the page (real PNG data URL, like an import). */
export async function bakeTestImage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { analyzeImage, bakeImageSdf } = await import("/src/utils/imageSdf.ts");
    const c = new OffscreenCanvas(128, 128);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "#000";
    g.lineWidth = 18;
    g.beginPath();
    g.arc(64, 64, 40, 0, Math.PI * 2);
    g.stroke();
    const bmp = await createImageBitmap(c);
    const a = analyzeImage(bmp);
    return bakeImageSdf(bmp, a, a.threshold, a.invert)!;
  });
}

/** Serves `html` at a same-origin URL (secure context for WebGPU) and opens it. */
export async function openHtml(page: Page, html: string, path = "/__embed-test.html") {
  await page.route(`**${path}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(path);
}

/**
 * Client coordinates of world point `p` in the editor viewport (the orbit
 * camera of shader.ts / renderTemplates.ts: yaw in XZ, then pitch in YZ).
 */
export async function projectToScreen(page: Page, p: [number, number, number]): Promise<{ x: number; y: number }> {
  return page.evaluate(async (pt) => {
    const { useViewStore } = await import("/src/store/viewStore.ts");
    const { rotX, rotY, distance } = useViewStore.getState();
    const rot = (v: [number, number], a: number): [number, number] => [
      Math.cos(a) * v[0] + Math.sin(a) * v[1],
      -Math.sin(a) * v[0] + Math.cos(a) * v[1],
    ];
    // Camera basis = the rotation applied to the canonical axes.
    const turn = (v: [number, number, number]): [number, number, number] => {
      const [x, z] = rot([v[0], v[2]], rotX);
      const [y, z2] = rot([v[1], z], rotY);
      return [x, y, z2];
    };
    const ro = turn([0, 0, -distance]);
    const right = turn([1, 0, 0]);
    const down = turn([0, 1, 0]);
    const fwd = turn([0, 0, 1]);
    const v = [pt[0] - ro[0], pt[1] - ro[1], pt[2] - ro[2]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = dot(v, fwd);
    const ux = dot(v, right) / z;
    const uy = dot(v, down) / z;
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    const aspect = r.width / r.height;
    return { x: r.left + ((ux / aspect + 1) / 2) * r.width, y: r.top + ((uy + 1) / 2) * r.height };
  }, p);
}
