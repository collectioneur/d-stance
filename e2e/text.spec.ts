import { expect, test, type Page } from "@playwright/test";
import { canvasShot, canvasStats, imageDiff, openEditor, sceneRoot, waitForProgram } from "./helpers";

type TextLayer = { id: string; name: string; shapeType: string; image?: { sdf: string; text?: { content: string; font: string } } };

async function textLayers(page: Page): Promise<TextLayer[]> {
  const root = await sceneRoot(page);
  return (root.items as TextLayer[]).filter((i) => i.image?.text);
}

/** Waits for the debounced re-bake to land in the store, then for the frame. */
async function waitBaked(page: Page, content: string) {
  await expect.poll(async () => (await textLayers(page))[0]?.image?.text?.content).toBe(content);
  await waitForProgram(page);
  await page.waitForTimeout(150);
}

test.describe("text", () => {
  test("add, type, restyle, undo, reload", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "Scene", items: [] });
    await page.getByTitle(/Add text/).click();
    await expect.poll(async () => (await textLayers(page)).length).toBe(1);
    await waitForProgram(page);
    await page.waitForTimeout(700); // spawn animation
    let [layer] = await textLayers(page);
    expect(layer.name).toBe("Hello");
    expect(layer.shapeType).toBe("image");
    await expect(page.locator(".scene-item-name", { hasText: "Hello" })).toBeVisible();
    expect((await canvasStats(page)).coverage).toBeGreaterThan(0.01);
    const hello = await canvasShot(page);

    // Typing re-bakes and renames the layer with it.
    const field = page.getByLabel("Text", { exact: true });
    await field.fill("WOW");
    await waitBaked(page, "WOW");
    [layer] = await textLayers(page);
    expect(layer.name).toBe("WOW");
    const wow = await canvasShot(page);
    expect((await imageDiff(page, hello, wow)).over16).toBeGreaterThan(0.003);

    // Another font is another shape.
    await page.getByLabel("Font", { exact: true }).selectOption("serif");
    await expect.poll(async () => (await textLayers(page))[0].image?.text?.font).toBe("serif");
    await waitForProgram(page);
    expect((await imageDiff(page, wow, await canvasShot(page))).over16).toBeGreaterThan(0.003);

    // Clearing the words keeps the last shape on screen.
    const sdfBefore = (await textLayers(page))[0].image!.sdf;
    await field.fill("");
    await waitBaked(page, "");
    expect((await textLayers(page))[0].image!.sdf).toBe(sdfBefore);
    await field.fill("WOW");
    await waitBaked(page, "WOW");

    // A renamed layer keeps its name when the words change.
    await page.locator(".scene-item-name", { hasText: "WOW" }).dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Title");
    await page.keyboard.press("Enter");
    await field.fill("WOW!");
    await waitBaked(page, "WOW!");
    expect((await textLayers(page))[0].name).toBe("Title");

    // Undo walks the words back; the field follows.
    await page.locator("body").click({ position: { x: 700, y: 870 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await textLayers(page))[0].image?.text?.content).toBe("WOW");

    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    [layer] = await textLayers(page);
    expect(layer.image?.text).toMatchObject({ content: "WOW", font: "serif" });
    expect(errors).toEqual([]);
  });

  test("hotkey 8 adds text; multiline text aligns", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "Scene", items: [] });
    await page.locator("body").click({ position: { x: 700, y: 870 } });
    await page.keyboard.press("Digit8");
    await expect.poll(async () => (await textLayers(page)).length).toBe(1);
    await page.getByLabel("Text", { exact: true }).fill("ONE\nTWO LINES");
    await waitBaked(page, "ONE\nTWO LINES");
    const center = await canvasShot(page);
    await page.getByLabel("Align left").click();
    await expect.poll(async () => ((await textLayers(page))[0].image?.text as { align?: string }).align).toBe("left");
    await waitForProgram(page);
    expect((await imageDiff(page, center, await canvasShot(page))).over16).toBeGreaterThan(0.002);
    expect(errors).toEqual([]);
  });

  test("text exports like an image layer and renders in the embed", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [] });
    await page.getByTitle(/Add text/).click();
    await expect.poll(async () => (await textLayers(page)).length).toBe(1);
    const out = await page.evaluate(async () => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      const { useSceneStore } = await import("/src/store/sceneStore.ts");
      return generateEmbed(useSceneStore.getState().root, { style: "studio", background: "studio", motion: "still", quality: "fast", framing: "fit", view: { rotX: 0, rotY: 0, distance: 2.5 } });
    });
    expect(out.scene.images).toHaveLength(1);
    expect(out.scene.wgsl).toContain("sdImageTex0(");
  });
});
