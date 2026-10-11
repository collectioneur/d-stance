/**
 * Scripted "manual" session with screenshots for eyeballing a change:
 *   SHOT_DIR=/tmp/shots PW_TOOLS=1 npx playwright test tools/explore
 */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";

test("explore editor flow", async ({ page }) => {
  const errors = await openEditor(page);
  const shot = async (name: string) => {
    await waitForProgram(page);
    await page.screenshot({ path: `${D}/${name}.png` });
  };
  await page.getByTitle("Add Box (1)").click();
  await page.getByTitle("Add Sphere (2)").click();
  await page.waitForTimeout(700);
  await shot("01-added");

  // Drag the selected sphere's X arrow (gizmo at screen center, arrow points right).
  const bb = (await page.locator("canvas").boundingBox())!;
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await page.mouse.move(cx + 50, cy);
  await page.waitForTimeout(150);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + 50 + i * 15, cy, { steps: 2 });
  }
  await page.mouse.up();
  await shot("02-dragged");

  // Smooth union via the inspector.
  await page.getByTitle("Smooth Union").click();
  await shot("03-smooth");

  // Hover the box (left of center now).
  await page.mouse.move(cx - 40, cy + 10);
  await page.waitForTimeout(500);
  await shot("04-hover");

  // Chrome render mode.
  await page.getByTitle("Render mode").click();
  await page.getByRole("option", { name: /Chrome/ }).click();
  await shot("05-chrome");

  // Code tab.
  await page.getByRole("button", { name: "Code" }).click();
  await shot("06-code");
  console.log("ERRORS", JSON.stringify(errors));
});
