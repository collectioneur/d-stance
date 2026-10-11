/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-sculpt */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { sculptScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("sculpt scene", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, sculptScene() as never);
  await waitForProgram(page);
  await page.waitForTimeout(400);
  const ms = await page.evaluate(async () => (window as any).__dstance.gpu.frameMs(20));
  console.log("FRAME", ms.toFixed(2));
  await page.screenshot({ path: `${D}/sculpt-01.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
