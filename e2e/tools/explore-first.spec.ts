/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-first */
import { test } from "@playwright/test";
const D = process.env.SHOT_DIR ?? "/tmp";
test("first load", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${D}/first.png` });
});
