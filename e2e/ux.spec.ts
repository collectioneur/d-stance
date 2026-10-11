import { expect, test } from "@playwright/test";
import { openEditor, sceneRoot, sphere, waitForProgram, waitSettled } from "./helpers";
import { animationScene } from "./scenes";

test.describe("ux", () => {
  test("an empty scene welcomes with examples; loading one is a single undo step", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "Scene", items: [] });
    const welcome = page.locator(".welcome");
    await expect(welcome).toHaveAttribute("data-open", "true");
    await expect(page.locator(".welcome .example-card")).toHaveCount(6);
    await page.locator(".welcome .example-card", { hasText: "Floating island" }).click();
    await expect.poll(async () => (await sceneRoot(page)).name).toBe("Floating island");
    await expect(welcome).toHaveAttribute("data-open", "false");
    await expect(page.getByTitle("Render mode")).toContainText("Studio");
    await waitForProgram(page);

    await page.locator("body").click({ position: { x: 700, y: 880 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await sceneRoot(page)).items.length).toBe(0);
    // Dismissed for this visit: emptying the scene again does not bring it back.
    await expect(welcome).toHaveAttribute("data-open", "false");
    expect(errors).toEqual([]);
  });

  test("Start empty dismisses; the palette and the wordmark open the gallery; Esc closes", async ({ page }) => {
    await openEditor(page, { id: "r", name: "Scene", items: [] });
    await page.getByRole("button", { name: "Start empty" }).click();
    await expect(page.locator(".welcome")).toHaveAttribute("data-open", "false");

    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Examples");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Examples" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Examples" })).toHaveCount(0);

    await page.getByRole("button", { name: /d-stance — examples/ }).click();
    const dialog = page.getByRole("dialog", { name: "Examples" });
    await dialog.locator(".example-card", { hasText: "Neon sign" }).click();
    await expect.poll(async () => (await sceneRoot(page)).name).toBe("Neon sign");
    await expect(page.getByTitle("Render mode")).toContainText("Neon");
  });

  test("? lists the shortcuts", async ({ page }) => {
    await openEditor(page);
    await page.locator("body").click({ position: { x: 700, y: 880 } });
    await page.keyboard.press("Shift+Slash");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Sculpt on / off");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("dragging a field's label scrubs its value as one undo step", async ({ page }) => {
    await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball" })] });
    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    const label = page.locator(".prop-label--scrub", { hasText: /^X$/ });
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const x = async () => ((await sceneRoot(page)).items[0] as { position: number[] }).position[0];
    await expect.poll(x).toBeGreaterThan(0.1);
    await page.locator("body").click({ position: { x: 700, y: 880 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(x).toBe(0);
  });

  test("the tree marks animated items; a still view gets anti-aliasing samples", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "classic", quality: 3 }, version: 0 })));
    await openEditor(page, animationScene() as never);
    await expect(page.locator(".scene-item-mods[title='Animated']").first()).toBeVisible();
    // Still scene: one image, then 15 more samples, then nothing.
    await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s" })] });
    await waitForProgram(page);
    await waitSettled(page);
    const draws = () => page.evaluate(() => (window as unknown as { __dstance: { gpu: { stats(): { draws: number } } } }).__dstance.gpu.stats().draws);
    const settled = await draws();
    expect(settled).toBeGreaterThanOrEqual(16);
    await page.waitForTimeout(300);
    expect(await draws()).toBe(settled);
  });
});
