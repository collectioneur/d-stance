/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-anim */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { animationScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("animation UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, animationScene() as never);
  await waitForProgram(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${D}/anim-01.png` });
  await page.locator(".scene-item-name", { hasText: "sphere" }).click();
  await page.locator(".props-content").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${D}/anim-02.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
