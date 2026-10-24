import { expect, test, type Page } from "@playwright/test";
import { canvasShot, canvasStats, imageDiff, openEditor, sceneRoot, sphere, waitForFrames, waitForProgram } from "./helpers";
import { infiniteScene, modifiersScene } from "./scenes";

type Mods = { modifiers?: { kind: string; off?: boolean }[] };

/** The canvas once `items` are drawn at full size (shapes grow in once drawn). */
async function shot(page: Page, items: { id: string }[]) {
  const errors = await openEditor(page, { id: "r", name: "S", items });
  await waitForProgram(page);
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
}

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
    const polar = await shot(page, [cone({ id: "c", modifiers: [{ kind: "polar", count: 3, axis: 2, radius: 0 }] })]);
    const byHand = await shot(page, [0, 120, 240].map((z, i) => cone({ id: `c${i}`, rotation: [0, 0, z] })));
    expect((await imageDiff(page, polar, byHand)).over16).toBeLessThan(0.002);
  });

  test("repeated copies that are not symmetric in their cell match the copies placed by hand", async ({ page }) => {
    // A cone's tip and base sit on opposite sides of its cell: near a cell
    // face the neighbor's base can be nearer than the cell's own tip. When
    // only the nearest cell's copy was measured, rays stepped through the
    // neighbor and cut notches into the base rims.
    const cone = (extra: Record<string, unknown>) => sphere({ shapeType: "cone", name: "Cone", params: [0.4, 0.6, 0, 0], ...extra });
    const repeated = await shot(page, [cone({ id: "c", position: [0, -1, 0], modifiers: [{ kind: "repeat", spacing: [1.8, 1.8, 1.8], count: [3, 3, 3] }] })]);
    const cells = [-1, 0, 1].flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => [x, y, z])));
    const byHand = await shot(page, cells.map(([x, y, z], i) => cone({ id: `c${i}`, position: [1.8 * x, -1 + 1.8 * y, 1.8 * z] })));
    // Notched rims: ~0.09% of pixels differ; exact: ~0.01%.
    expect((await imageDiff(page, repeated, byHand)).over16).toBeLessThan(0.0003);
  });

  test("a mirror at a distance matches the copies placed by hand", async ({ page }) => {
    // Mirror x at distance 0.8 in the cone's own frame (turned 30° about z):
    // the cone and its reflection sit 0.8 to either side along that frame's
    // x axis. The cone's bound (and so the scene's, it stands at the origin)
    // must reach them, or the march cuts them off.
    const cone = (extra: Record<string, unknown>) =>
      sphere({ shapeType: "cone", name: "Cone", rotation: [0, 0, 30], params: [0.4, 0.6, 0, 0], ...extra });
    const at: [number, number, number] = [0, 0, 0];
    const mirrored = await shot(page, [cone({ id: "c", position: at, modifiers: [{ kind: "mirror", axes: [true, false, false], offset: [0.8, 0, 0] }] })]);
    const a = Math.PI / 6;
    const byHand = await shot(page, [
      cone({ id: "c0", position: [at[0] + 0.8 * Math.cos(a), at[1] + 0.8 * Math.sin(a), at[2]] }),
      cone({ id: "c1", position: [at[0] - 0.8 * Math.cos(a), at[1] - 0.8 * Math.sin(a), at[2]] }),
    ]);
    expect((await imageDiff(page, mirrored, byHand)).over16).toBeLessThan(0.002);
  });

  test("a polar repeat with a radius matches a ring of copies placed by hand", async ({ page }) => {
    const cone = (extra: Record<string, unknown>) => sphere({ shapeType: "cone", name: "Cone", params: [0.3, 0.5, 0, 0], ...extra });
    const at = [0, -0.6, 0];
    const ring = await shot(page, [cone({ id: "c", position: at, modifiers: [{ kind: "polar", count: 6, axis: 1, radius: 1 }] })]);
    const byHand = await shot(
      page,
      [0, 1, 2, 3, 4, 5].map((k) => {
        const a = (k * Math.PI) / 3;
        return cone({ id: `c${k}`, position: [at[0] + Math.cos(a), at[1], at[2] + Math.sin(a)] });
      }),
    );
    expect((await imageDiff(page, ring, byHand)).over16).toBeLessThan(0.002);
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
