/** Screenshots of the export UI: SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-embed */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { csgScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("explore embed UI", async ({ page }) => {
  const errors = await openEditor(page, csgScene() as never);
  await waitForProgram(page);
  await page.getByRole("button", { name: "Code" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${D}/embed-01.png` });
  const frame = page.frameLocator(".embed-preview-frame");
  console.log("preview backend:", await frame.locator("canvas").getAttribute("data-backend", { timeout: 5000 }).catch(() => "none"));
  await page.getByLabel("Look").selectOption("chrome");
  await page.getByLabel("Motion").selectOption("spin");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${D}/embed-02.png` });
  await page.getByRole("button", { name: "Shadertoy" }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${D}/embed-03.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
