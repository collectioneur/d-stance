/** Smoke-test a production build: npm run build && npx vite preview --port 5180, then PW_TOOLS=1 npx playwright test tools/prod */
import { expect, test } from "@playwright/test";
import { encodeScene, sphere, box } from "../helpers";
test("production build renders a scene", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:5180/#${encodeScene({ id: "r", name: "S", items: [sphere(), box({ position: [0.6, 0, 0], op: "sUnion" })] })}`);
  await expect(page.locator("canvas")).toHaveAttribute("data-ready", "1");
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT ?? "/tmp/prod.png" });
  expect(errors).toEqual([]);
});
