/**
 * GPU frame time and compile time per reference scene.
 *   PW_TOOLS=1 npx playwright test tools/bench --reporter=line | grep RESULT
 */
import { test } from "@playwright/test";
import { openEditor, waitForFrames } from "../helpers";
import { crowdScene, allShapesScene, csgScene, infiniteScene, modifiersScene, noiseScene } from "../scenes";
const scenes: [string, () => unknown][] = [
  ["shapes22", allShapesScene],
  ["csg", csgScene],
  ["crowd60", () => crowdScene(60)],
  ["crowd120", () => crowdScene(120)],
  ["union120", () => crowdScene(120, false)],
  ["union250", () => crowdScene(250, false)],
  ["modifiers", modifiersScene],
  ["infinite", infiniteScene],
  ["noise", noiseScene],
];
for (const mode of ["classic", "chrome", "studio"]) {
  for (const [name, make] of scenes) {
    test(`bench ${name} ${mode}`, async ({ page }) => {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      await openEditor(page, make() as never);
      await page.waitForFunction(() => { const g = (window as any).__dstance?.gpu; return g && (!g.synced || g.synced()); });
      await waitForFrames(page, 5);
      const r = await page.evaluate(async () => {
        const g = (window as any).__dstance.gpu;
        await g.frameMs(5);
        const a = await g.frameMs(40);
        const b = await g.frameMs(40);
        const c = g.compileMs ? await g.compileMs() : null;
        return { frame: Math.min(a, b), compile: c };
      });
      console.log(`RESULT ${name} ${mode} ${JSON.stringify(r)}`);
    });
  }
}
