/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-modifiers */
import { test } from "@playwright/test";
import { canvasShot, openEditor, waitForProgram } from "../helpers";
import { infiniteScene, modifiersScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
for (const [name, make] of [["modifiers", modifiersScene], ["infinite", infiniteScene]] as const) {
  test(`modifiers ${name}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
    const errors = await openEditor(page, make() as never);
    await waitForProgram(page);
    await canvasShot(page, `${D}/mod-${name}.png`);
    console.log(name, "ERRORS", JSON.stringify(errors));
  });
}
