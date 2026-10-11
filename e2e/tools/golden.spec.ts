/**
 * Capture reference renders into $GOLDEN_DIR (run on the baseline branch).
 *   GOLDEN_DIR=/tmp/golden PW_TOOLS=1 npx playwright test tools/golden
 */
import { test } from "@playwright/test";
import { canvasShot, openEditor } from "../helpers";
import { allShapesScene, csgScene } from "../scenes";
const DIR = process.env.GOLDEN_DIR!;
for (const mode of ["classic", "chrome"]) {
  for (const [name, make] of [["shapes", allShapesScene], ["csg", csgScene]] as const) {
    test(`golden ${name} ${mode}`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      await openEditor(page, make() as never);
      await canvasShot(page, `${DIR}/${name}-${mode}.png`);
    });
  }
}
