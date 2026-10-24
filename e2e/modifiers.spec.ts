import { expect, test } from "@playwright/test";
import { canvasShot, canvasStats, imageDiff, openEditor, sceneRoot, sphere, waitForFrames, waitForProgram } from "./helpers";
import { infiniteScene, modifiersScene } from "./scenes";

type Mods = { modifiers?: { kind: string; off?: boolean }[] };

test.describe("modifiers", () => {
  test("add a repeat from the inspector, switch it off, remove it, undo, reload", async ({ page }) => {
    await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball", params: [0.15, 0, 0, 0] })] });
    await waitForProgram(page);
    const single = await canvasStats(page);

    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await page.getByLabel("Add modifier").selectOption("repeat");
    await page.getByLabel("Count Z").fill("3");
    await page.getByLabel("Count Z").press("Enter");
    await waitForProgram(page);
    const grid = await canvasStats(page);
    expect(grid.coverage).toBeGreaterThan(single.coverage * 3);
    await expect(page.locator(".scene-item-mods")).toHaveCount(1);

    await page.getByRole("button", { name: "Turn off Repeat" }).click();
    await waitForProgram(page);
    expect((await canvasStats(page)).coverage).toBeLessThan(grid.coverage * 0.4);
    let root = await sceneRoot(page);
    expect((root.items[0] as Mods).modifiers?.[0].off).toBe(true);

    await page.getByRole("button", { name: "Turn on Repeat" }).click();
    await page.getByRole("button", { name: "Remove Repeat" }).click();
    root = await sceneRoot(page);
    expect("modifiers" in root.items[0]).toBe(false);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Meta+z");
    root = await sceneRoot(page);
    expect((root.items[0] as Mods).modifiers?.[0].kind).toBe("repeat");

    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    root = await sceneRoot(page);
    expect((root.items[0] as Mods).modifiers?.[0].kind).toBe("repeat");
    expect((await canvasStats(page)).coverage).toBeGreaterThan(single.coverage * 3);
  });

  test("clicking a repeated copy selects its shape", async ({ page }) => {
    await openEditor(page, {
      id: "r",
      name: "S",
      items: [
        {
          kind: "group", id: "g", name: "Row", position: [0, -0.3, 0], rotation: [0, 0, 0], scale: [1, 1, 1], op: "union", smoothK: 0.1,
          modifiers: [{ kind: "repeat", spacing: [0.6, 0.6, 0.6], count: [3, 1, 1] }],
          items: [sphere({ id: "ball", name: "Ball", params: [0.2, 0, 0, 0] })],
        },
      ],
    });
    await waitForProgram(page);
    const bb = (await page.locator("canvas").boundingBox())!;
    // The left copy (x = −0.6) sits left of center on screen.
    await page.mouse.click(bb.x + bb.width * 0.424, bb.y + bb.height * 0.437);
    await expect(page.locator(".scene-item--selected .scene-item-name")).toHaveText("Ball");
  });

  test("polar copies that overlap their sectors match the copies placed by hand", async ({ page }) => {
    // A cone on its own polar axis overlaps every sector: before the copies
    // were looped over, each kept only its own wedge and the cuts grew spikes.
    const cone = (extra: Record<string, unknown>) =>
      sphere({ shapeType: "cone", name: "Cone", position: [0, -0.7, 0], params: [0.39, 0.6, 0, 0], ...extra });
    const shot = async (items: { id: string }[]) => {
      const errors = await openEditor(page, { id: "r", name: "S", items });
      await waitForProgram(page);
      // Shapes grow in once drawn: shoot them at full size.
      await expect
        .poll(() =>
          page.evaluate((ids) => {
            const g = (window as unknown as { __dstance: { gpu: { appearProgress(id: string): number | null } } }).__dstance.gpu;
            return ids.every((id) => (g.appearProgress(id) ?? 1) >= 1);
          }, items.map((i) => i.id)),
        )
        .toBe(true);
      await waitForFrames(page, 2);
      expect(errors).toEqual([]);
      return canvasShot(page);
    };
    const polar = await shot([cone({ id: "c", modifiers: [{ kind: "polar", count: 3, axis: 2 }] })]);
    const byHand = await shot([0, 120, 240].map((z, i) => cone({ id: `c${i}`, rotation: [0, 0, z] })));
    expect((await imageDiff(page, polar, byHand)).over16).toBeLessThan(0.002);
  });

  test("an infinite grid renders to the horizon", async ({ page }) => {
    const errors = await openEditor(page, infiniteScene() as never);
    await waitForProgram(page);
    const s = await canvasStats(page);
    expect(s.coverage).toBeGreaterThan(0.15);
    expect(errors).toEqual([]);
  });

  test("every modifier kind renders without errors in every mode", async ({ page }) => {
    for (const mode of ["classic", "chrome", "studio"]) {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      const errors = await openEditor(page, modifiersScene() as never);
      await waitForProgram(page);
      await waitForFrames(page, 2);
      expect((await canvasStats(page)).coverage, mode).toBeGreaterThan(0.02);
      expect(errors, mode).toEqual([]);
    }
  });
});
