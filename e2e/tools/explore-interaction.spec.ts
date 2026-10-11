/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-interaction */
import { test } from "@playwright/test";
import { openEditor, projectToScreen, waitForProgram } from "../helpers";
import { interactionScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("interaction UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, interactionScene() as never);
  await waitForProgram(page);
  await page.locator(".scene-item-name", { hasText: "Ball" }).click();
  await page.locator(".props-content").evaluate((el) => (el.scrollTop = el.scrollHeight - 700));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${D}/ix-01.png` });
  await page.getByRole("button", { name: "Try" }).click();
  const ball = await projectToScreen(page, [-0.7, 0, 0]);
  await page.mouse.move(ball.x, ball.y);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${D}/ix-02.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
