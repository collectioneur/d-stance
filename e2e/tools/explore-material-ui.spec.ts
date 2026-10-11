/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-material-ui */
import { test } from "@playwright/test";
import { box, openEditor, sphere, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";
test("material UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, { id: "r", name: "Scene", items: [box({ id: "b", name: "Crate" }), sphere({ id: "s", name: "Ball", position: [0.6, -0.2, 0] })] });
  await waitForProgram(page);
  await page.locator(".scene-item-name", { hasText: "Ball" }).click();
  await page.getByRole("listitem", { name: "Gold material" }).click();
  await waitForProgram(page);
  await page.locator(".props-content").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: `${D}/mui-01.png` });
  await page.locator(".scene-item-name", { hasText: "Crate" }).click();
  await page.getByLabel("Hex color").fill("#3a7bd5");
  await page.getByLabel("Hex color").press("Enter");
  await waitForProgram(page);
  await page.locator(".props-content").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: `${D}/mui-02.png` });
  console.log("ERRORS", JSON.stringify(errors));
});
