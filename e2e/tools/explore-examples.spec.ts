/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-examples */
import { test } from "@playwright/test";
import { canvasShot, openEditor, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";
test("examples", async ({ page }) => {
  const errors = await openEditor(page);
  const ids: string[] = await page.evaluate(async () => (await import("/src/scene/examples.ts")).EXAMPLES.map((e) => e.id));
  for (const exId of ids) {
    await page.evaluate(async (i) => {
      const { EXAMPLES, loadExample } = await import("/src/scene/examples.ts");
      await loadExample(EXAMPLES.find((e) => e.id === i)!);
    }, exId);
    await waitForProgram(page);
    await page.waitForTimeout(1200);
    const ms = await page.evaluate(async () => (window as any).__dstance.gpu.frameMs(10));
    console.log("FRAME", exId, ms.toFixed(2));
    await canvasShot(page, `${D}/ex/${exId}.png`);
  }
  console.log("ERRORS", JSON.stringify(errors));
});
