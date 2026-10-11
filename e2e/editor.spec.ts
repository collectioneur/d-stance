import { expect, test } from "@playwright/test";
import { box, canvasStats, openEditor, sceneRoot, sphere, waitForFrames, waitForProgram } from "./helpers";

test.describe("editor smoke", () => {
  test("empty scene renders the grid without errors", async ({ page }) => {
    const errors = await openEditor(page);
    const stats = await canvasStats(page);
    expect(stats.mean).toBeGreaterThan(5); // not a black canvas
    expect(stats.coverage).toBeLessThan(0.01);
    expect(errors).toEqual([]);
  });

  test("a scene from the hash renders in the middle", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "Scene", items: [sphere()] });
    const stats = await canvasStats(page);
    expect(stats.coverage).toBeGreaterThan(0.01);
    expect(stats.cx).toBeGreaterThan(0.35);
    expect(stats.cx).toBeLessThan(0.65);
    expect(errors).toEqual([]);
  });

  test("toolbar adds a shape, tree and canvas follow", async ({ page }) => {
    await openEditor(page);
    const before = await canvasStats(page);
    await page.getByTitle("Add Sphere (2)").click();
    await expect(page.locator(".scene-item-name", { hasText: "Sphere 1" })).toBeVisible();
    await page.waitForTimeout(600); // spawn animation
    await waitForProgram(page);
    const after = await canvasStats(page);
    expect(after.coverage).toBeGreaterThan(before.coverage + 0.01);
  });

  test("click on the canvas selects, empty space deselects", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [box({ name: "Crate" })] });
    const c = page.locator("canvas");
    const bb = (await c.boundingBox())!;
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await expect(page.locator(".scene-item--selected .scene-item-name")).toHaveText("Crate");
    await page.mouse.click(bb.x + bb.width * 0.3, bb.y + bb.height * 0.85);
    await expect(page.locator(".scene-item--selected")).toHaveCount(0);
  });

  test("undo / redo via keyboard", async ({ page }) => {
    await openEditor(page);
    await page.getByTitle("Add Sphere (2)").click();
    await page.getByTitle("Add Box (1)").click();
    await expect(page.locator(".scene-item-name")).toHaveCount(3); // root + 2
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    await expect(page.locator(".scene-item-name")).toHaveCount(2);
    await page.keyboard.press("Meta+Shift+z");
    await expect(page.locator(".scene-item-name")).toHaveCount(3);
  });

  test("scene survives a reload through the hash", async ({ page }) => {
    await openEditor(page);
    await page.getByTitle("Add Torus (3)").click();
    await page.waitForTimeout(1300); // persistence debounce is 1s
    await page.reload();
    await waitForFrames(page);
    const root = await sceneRoot(page);
    expect(root.items.map((i) => i.name)).toEqual(["Torus 1"]);
  });
});
