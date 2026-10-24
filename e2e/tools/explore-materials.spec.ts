/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-materials */
import { test } from "@playwright/test";
import { canvasShot, openEditor, waitForProgram } from "../helpers";
import { materialsScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
for (const mode of ["classic", "chrome", "studio"]) {
  test(`materials ${mode}`, async ({ page }) => {
    await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
    const errors = await openEditor(page, materialsScene() as never);
    await waitForProgram(page);
    await canvasShot(page, `${D}/mat-${mode}.png`);
    console.log(mode, "ERRORS", JSON.stringify(errors));
  });
}
