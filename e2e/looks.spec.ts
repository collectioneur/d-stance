import { expect, test } from "@playwright/test";
import { canvasShot, imageDiff, openEditor, waitForProgram } from "./helpers";
import { materialsScene } from "./scenes";

test.describe("render modes", () => {
  test("every look and inspect mode renders from the picker, distinctly", async ({ page }) => {
    const errors = await openEditor(page, materialsScene() as never);
    await waitForProgram(page);
    const shots: Record<string, Buffer> = { classic: await canvasShot(page) };
    for (const [mode, label] of [
      ["neon", "Neon"],
      ["volume", "Volume"],
      ["field", "Field"],
      ["cost", "Cost"],
      ["normals", "Normals"],
    ] as const) {
      await page.getByTitle("Render mode").click();
      await page.getByRole("option", { name: label }).click();
      await waitForProgram(page);
      await page.waitForTimeout(150);
      shots[mode] = await canvasShot(page);
      expect((await imageDiff(page, shots.classic, shots[mode])).over16, mode).toBeGreaterThan(0.01);
      const inspect = mode === "field" || mode === "cost" || mode === "normals";
      await expect(page.locator(".inspect-panel")).toHaveAttribute("data-open", String(inspect));
    }
    expect(errors).toEqual([]);
  });

  test("Field: the slice starts mid-scene and the slider moves it", async ({ page }) => {
    await openEditor(page, materialsScene() as never);
    await waitForProgram(page);
    await page.getByTitle("Render mode").click();
    await page.getByRole("option", { name: "Field" }).click();
    await waitForProgram(page);
    const slider = page.getByLabel("Slice height");
    const start = Number(await slider.inputValue());
    const a = await canvasShot(page);
    // Range inputs take a value on the step grid inside min..max.
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, (start + 0.15).toFixed(2));
    await page.waitForTimeout(200);
    expect((await imageDiff(page, a, await canvasShot(page))).over16).toBeGreaterThan(0.01);
    await expect(page.locator(".inspect-panel")).toContainText("lines every 0.05");
  });

  test("Cost legend shows the current step budget; an unknown stored mode falls back to Classic", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "hologram", quality: 3 }, version: 0 })));
    await openEditor(page, materialsScene() as never);
    await expect(page.getByTitle("Render mode")).toContainText("Classic");
    await page.getByTitle("Render mode").click();
    await page.getByRole("option", { name: "Cost" }).click();
    await expect(page.locator(".inspect-panel")).toContainText(/\d+ steps/);
  });
});
