/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-looks */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { materialsScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
for (const mode of ["neon", "volume", "field", "cost", "normals"]) {
  test(`look ${mode}`, async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && warnings.push(m.text().slice(0, 300)));
    await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3, sliceY: 0 }, version: 0 })), mode);
    await openEditor(page, materialsScene() as never);
    await waitForProgram(page);
    await page.waitForTimeout(500);
    const ms = await page.evaluate(async () => (window as any).__dstance.gpu.frameMs(20));
    console.log(`FRAME ${mode} ${ms.toFixed(2)}ms`);
    await page.screenshot({ path: `${D}/look-${mode}.png` });
    console.log("WARN", mode, JSON.stringify(warnings));
  });
}
