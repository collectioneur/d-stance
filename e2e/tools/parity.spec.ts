/**
 * Compare current renders against $GOLDEN_DIR (see golden.spec.ts).
 *   GOLDEN_DIR=/tmp/golden PW_TOOLS=1 npx playwright test tools/parity --reporter=line
 */
import { test } from "@playwright/test";
import fs from "node:fs";
import { canvasShot, imageDiff, openEditor, waitForProgram } from "../helpers";
import { allShapesScene, csgScene } from "../scenes";
const DIR = process.env.GOLDEN_DIR!;
for (const mode of ["classic", "chrome"]) {
  for (const [name, make] of [["shapes", allShapesScene], ["csg", csgScene]] as const) {
    test(`parity ${name} ${mode}`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      await openEditor(page, make() as never);
      await waitForProgram(page);
      const shot = await canvasShot(page, `${DIR}/new-${name}-${mode}.png`);
      const diff = await imageDiff(page, shot, fs.readFileSync(`${DIR}/${name}-${mode}.png`));
      console.log(name, mode, JSON.stringify(diff));
    });
  }
}
