import { expect, test, type Page } from "@playwright/test";
import { box, canvasShot, canvasStats, imageDiff, openEditor, sphere, waitForFrames, waitForProgram } from "./helpers";
import { csgScene } from "./scenes";

type Stats = { compiles: number; draws: number };
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __dstance: { gpu: { stats(): Stats } } }).__dstance.gpu.stats());
const store = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const s = (window as unknown as { __dstance: { store: { getState(): Record<string, (...x: unknown[]) => unknown> } } }).__dstance.store;
      return s.getState()[f as string](...(a as unknown[]));
    },
    [fn, args] as const,
  );

test.describe("compiled scene renderer", () => {
  test("a static scene stops drawing", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [sphere()] });
    await waitForProgram(page);
    await page.waitForTimeout(300);
    const a = await stats(page);
    await page.waitForTimeout(500);
    const b = await stats(page);
    expect(b.draws).toBe(a.draws);
  });

  test("moving a shape updates values without recompiling", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [sphere({ id: "s" })] });
    await waitForProgram(page);
    const before = await stats(page);
    const shot0 = await canvasShot(page);
    for (let i = 1; i <= 5; i++) {
      await store(page, "updateLayer", "r", "s", { position: [i * 0.1, 0, 0] });
      await waitForFrames(page, 1);
    }
    await waitForProgram(page);
    const after = await stats(page);
    expect(after.compiles).toBe(before.compiles);
    expect(after.draws).toBeGreaterThan(before.draws);
    const diff = await imageDiff(page, shot0, await canvasShot(page));
    expect(diff.over16).toBeGreaterThan(0.002);
  });

  test("structural edits recompile once and undo reuses the cached program", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [sphere({ id: "s" })] });
    await waitForProgram(page);
    const c0 = (await stats(page)).compiles;
    await page.getByTitle("Add Box (1)").click();
    await waitForProgram(page);
    const c1 = (await stats(page)).compiles;
    expect(c1).toBeGreaterThan(c0);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    await waitForProgram(page);
    await page.waitForTimeout(700); // spawn shrink animation lands on the old root
    await waitForProgram(page);
    expect((await stats(page)).compiles).toBe(c1);
  });

  test("changing an op re-renders the CSG", async ({ page }) => {
    await openEditor(page, {
      id: "r",
      name: "Scene",
      items: [box({ id: "b" }), sphere({ id: "s", position: [0.25, -0.25, 0.1] })],
    });
    await waitForProgram(page);
    const union = await canvasShot(page);
    await store(page, "updateLayer", "r", "s", { op: "subtract" });
    await waitForProgram(page);
    const sub = await canvasShot(page);
    expect((await imageDiff(page, union, sub)).over16).toBeGreaterThan(0.005);
  });

  test("selection glows, deselection clears it", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [box({ id: "b" })] });
    await waitForProgram(page);
    const plain = await canvasShot(page);
    await store(page, "setSelection", ["b"], "b");
    await waitForProgram(page);
    const selected = await canvasShot(page);
    expect((await imageDiff(page, plain, selected)).over16).toBeGreaterThan(0.002);
    await store(page, "deselect");
    await waitForProgram(page);
    expect((await imageDiff(page, plain, await canvasShot(page))).over16).toBeLessThan(0.0005);
  });

  test("root selection glows everything", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [box()] });
    await waitForProgram(page);
    const before = await canvasStats(page);
    await store(page, "selectRoot");
    await waitForProgram(page);
    const after = await canvasStats(page);
    expect(after.mean).toBeGreaterThan(before.mean);
  });

  test("picking resolves shapes inside transformed groups", async ({ page }) => {
    await openEditor(page, csgScene() as never);
    await waitForProgram(page);
    // Walk a few points and make sure every hit names a real layer.
    const c = page.locator("canvas");
    const bb = (await c.boundingBox())!;
    let hits = 0;
    for (const [fx, fy] of [[0.5, 0.48], [0.42, 0.5], [0.55, 0.45], [0.48, 0.36]]) {
      await page.mouse.click(bb.x + bb.width * fx, bb.y + bb.height * fy);
      await page.waitForTimeout(150);
      const id = await page.evaluate(() => (window as unknown as { __dstance: { store: { getState(): { selectedItemId: string | null } } } }).__dstance.store.getState().selectedItemId);
      if (id) {
        hits++;
        expect(id).toMatch(/^L\d+$/);
      }
    }
    expect(hits).toBeGreaterThan(1);
  });
});
