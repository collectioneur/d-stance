/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-modifier-ui */
import { test } from "@playwright/test";
import { openEditor, sphere, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";
test("modifier UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball", params: [0.2, 0, 0, 0] })] });
  await waitForProgram(page);
  await page.locator(".scene-item-name", { hasText: "Ball" }).click();
  await page.getByLabel("Add modifier").selectOption("repeat");
  await page.getByLabel("Count Z").fill("3");
  await page.getByLabel("Count Z").press("Enter");
  await page.getByLabel("Add modifier").selectOption("twist");
  await waitForProgram(page);
  await page.locator(".props-content").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: `${D}/modui-01.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
