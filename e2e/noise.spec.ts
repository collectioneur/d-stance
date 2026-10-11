import { expect, test } from "@playwright/test";
import { canvasShot, canvasStats, imageDiff, openEditor, sceneRoot, sphere, waitForFrames, waitForProgram } from "./helpers";
import { noiseScene } from "./scenes";

test.describe("noise, terrain, gyroid, formula", () => {
  test("formula shape: palette, live edit, errors keep the last good shape, examples, reload", async ({ page }) => {
    const errors = await openEditor(page);
    await page.getByTitle(/All commands/).click();
    await page.keyboard.type("Formula");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700); // spawn animation
    await waitForProgram(page);
    const sphereLook = await canvasShot(page);
    expect((await canvasStats(page)).coverage).toBeGreaterThan(0.008);

    const field = page.getByLabel("Formula", { exact: true });
    await field.fill("length(x, y, z) - 0.2 +");
    await expect(page.getByRole("alert")).toContainText("ends too early");
    await waitForProgram(page);
    expect((await imageDiff(page, sphereLook, await canvasShot(page))).over16).toBeLessThan(0.001);

    await field.fill("max(abs(x), max(abs(y), abs(z))) - 0.3");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await waitForProgram(page);
    const cube = await canvasShot(page);
    expect((await imageDiff(page, sphereLook, cube)).over16).toBeGreaterThan(0.005);

    await page.getByLabel("Formula examples").selectOption("Gyroid");
    await waitForProgram(page);
    let root = await sceneRoot(page);
    expect((root.items[0] as { formula?: string }).formula).toContain("sin(x*12)");

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    root = await sceneRoot(page);
    expect((root.items[0] as { formula?: string }).formula).toContain("sin(x*12)");
    expect(errors).toEqual([]);
  });

  test("noise modifier roughens a sphere", async ({ page }) => {
    await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball", params: [0.3, 0, 0, 0] })] });
    await waitForProgram(page);
    const smooth = await canvasShot(page);
    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await page.getByLabel("Add modifier").selectOption("noise");
    await waitForProgram(page);
    const rough = await canvasShot(page);
    expect((await imageDiff(page, smooth, rough)).over16).toBeGreaterThan(0.003);
    await page.getByLabel("Seed").fill("5");
    await page.getByLabel("Seed").press("Enter");
    await waitForProgram(page);
    expect((await imageDiff(page, rough, await canvasShot(page))).over16).toBeGreaterThan(0.001);
  });

  test("terrain, gyroid and noise render in every mode", async ({ page }) => {
    for (const mode of ["classic", "chrome", "studio"]) {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      const errors = await openEditor(page, noiseScene() as never);
      await waitForProgram(page);
      await waitForFrames(page, 2);
      expect((await canvasStats(page)).coverage, mode).toBeGreaterThan(0.02);
      expect(errors, mode).toEqual([]);
    }
  });
});
