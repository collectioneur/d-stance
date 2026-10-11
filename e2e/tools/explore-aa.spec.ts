/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-aa */
import { test } from "@playwright/test";
import { canvasShot, imageDiff, openEditor, waitForProgram } from "../helpers";
import { csgScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("aa", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  await openEditor(page, csgScene() as never);
  await waitForProgram(page);
  await canvasShot(page);
  const d0 = await page.evaluate(() => (window as any).__dstance.gpu.stats().draws);
  // Nudge the camera: one sample right away, then the rest.
  await page.mouse.move(700, 600);
  await page.mouse.wheel(0, 10);
  await page.waitForTimeout(40);
  const one = await page.locator("canvas").screenshot();
  await canvasShot(page);
  const d1 = await page.evaluate(() => (window as any).__dstance.gpu.stats().draws);
  const many = await page.locator("canvas").screenshot();
  console.log("DRAWS", d0, d1, "diff", JSON.stringify(await imageDiff(page, one, many)));
  await page.screenshot({ path: `${D}/aa-on.png`, clip: { x: 560, y: 330, width: 320, height: 200 } });
});
