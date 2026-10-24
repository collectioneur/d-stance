import { expect, test, type Page } from "@playwright/test";
import { box, canvasShot, openEditor, sceneRoot, sphere, waitForProgram } from "./helpers";

const RED = { color: [0.9, 0.1, 0.1], roughness: 0.5, metalness: 0, emission: 0 };
const BLUE = { color: [0.1, 0.2, 0.9], roughness: 0.5, metalness: 0, emission: 0 };

async function setMode(page: Page, mode: string) {
  await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
}

/** Average color of the region around a canvas-relative point (fx, fy in 0..1). */
async function colorAt(page: Page, fx: number, fy: number, r = 6) {
  const png = await canvasShot(page);
  return page.evaluate(
    async ([b64, x, y, rad]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const cx = Math.round(x * bmp.width), cy = Math.round(y * bmp.height);
      const d = g.getImageData(cx - rad, cy - rad, rad * 2, rad * 2).data;
      let rr = 0, gg = 0, bb = 0;
      for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
      const n = d.length / 4;
      return [rr / n, gg / n, bb / n];
    },
    [png.toString("base64"), fx, fy, r] as const,
  );
}

test.describe("materials", () => {
  for (const mode of ["classic", "chrome", "studio"]) {
    test(`a red shape renders red (${mode})`, async ({ page }) => {
      await setMode(page, mode);
      await openEditor(page, { id: "r", name: "S", items: [sphere({ position: [0, -0.6, 0], material: RED })] });
      await waitForProgram(page);
      const [r, g, b] = await colorAt(page, 0.5, 0.4);
      expect(r, mode).toBeGreaterThan(g * 1.6);
      expect(r, mode).toBeGreaterThan(b * 1.6);
    });
  }

  test("subtract keeps the body's color on the cut walls", async ({ page }) => {
    await setMode(page, "classic");
    await openEditor(page, {
      id: "r",
      name: "S",
      items: [
        box({ position: [0, -0.6, 0], material: RED }),
        sphere({ position: [0.2, -0.85, -0.25], params: [0.35, 0, 0, 0], op: "subtract", material: BLUE }),
      ],
    });
    await waitForProgram(page);
    const png = await canvasShot(page);
    const blueish = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let blue = 0, red = 0;
      for (let i = 0; i < d.length; i += 4) {
        // Saturated material blue; the grid's blue axis line is much greener.
        if (d[i + 2] > 120 && d[i] < d[i + 2] * 0.35 && d[i + 1] < d[i + 2] * 0.35) blue++;
        if (d[i] > 120 && d[i] > d[i + 2] * 1.5) red++;
      }
      return { blue, red };
    }, png.toString("base64"));
    expect(blueish.red).toBeGreaterThan(2000);
    expect(blueish.blue).toBeLessThan(blueish.red * 0.01);
  });

  test("group material is inherited, own material wins", async ({ page }) => {
    await setMode(page, "classic");
    await openEditor(page, {
      id: "r",
      name: "S",
      items: [
        {
          kind: "group", id: "g", name: "G", position: [0, -0.6, 0], rotation: [0, 0, 0], scale: [1, 1, 1], op: "union", smoothK: 0.1,
          material: BLUE,
          items: [sphere({ position: [-0.6, 0, 0], params: [0.3, 0, 0, 0] }), sphere({ position: [0.6, 0, 0], params: [0.3, 0, 0, 0], material: RED })],
        },
      ],
    });
    await waitForProgram(page);
    const left = await colorAt(page, 0.39, 0.4);
    const right = await colorAt(page, 0.61, 0.4);
    expect(left[2]).toBeGreaterThan(left[0] * 1.5);
    expect(right[0]).toBeGreaterThan(right[2] * 1.5);
  });

  test("studio floor darkens under the object", async ({ page }) => {
    await setMode(page, "studio");
    await openEditor(page, { id: "r", name: "S", items: [sphere({ position: [0, -0.45, 0], params: [0.3, 0, 0, 0] })] });
    await waitForProgram(page);
    // Shadow falls down-right of the sphere on screen (key light from the top-left).
    const nearShadow = await colorAt(page, 0.54, 0.62, 10);
    const farFloor = await colorAt(page, 0.2, 0.8, 10);
    expect(nearShadow[0] + 6).toBeLessThan(farFloor[0] + 30);
  });

  test("inspector: preset, color, reset, undo, reload", async ({ page }) => {
    await openEditor(page, { id: "r", name: "S", items: [box({ id: "b", name: "Crate" })] });
    await page.locator(".scene-item-name", { hasText: "Crate" }).click();
    await page.getByRole("listitem", { name: "Gold material" }).click();
    let root = await sceneRoot(page);
    expect((root.items[0] as { material?: { metalness: number } }).material?.metalness).toBe(1);
    await expect(page.locator(".scene-item-color")).toHaveCount(1);

    await page.getByLabel("Hex color").fill("#00ff00");
    await page.getByLabel("Hex color").press("Enter");
    root = await sceneRoot(page);
    expect((root.items[0] as { material?: { color: number[] } }).material?.color).toEqual([0, 1, 0]);

    await page.getByRole("button", { name: "Reset" }).click();
    root = await sceneRoot(page);
    expect("material" in root.items[0]).toBe(false);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    root = await sceneRoot(page);
    expect((root.items[0] as { material?: { color: number[] } }).material?.color).toEqual([0, 1, 0]);

    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    root = await sceneRoot(page);
    expect((root.items[0] as { material?: { color: number[] } }).material?.color).toEqual([0, 1, 0]);
  });

  test("material edits on a multi-selection apply to all", async ({ page }) => {
    await openEditor(page, { id: "r", name: "S", items: [box({ id: "a", name: "A" }), sphere({ id: "b", name: "B" })] });
    await page.locator(".scene-item-name", { hasText: "A" }).click();
    await page.locator(".scene-item-name", { hasText: "B" }).click({ modifiers: ["Meta"] });
    await page.getByRole("listitem", { name: "Neon material" }).click();
    const root = await sceneRoot(page);
    for (const item of root.items as { material?: { emission: number } }[]) {
      expect(item.material?.emission).toBeGreaterThan(0);
    }
  });
});
