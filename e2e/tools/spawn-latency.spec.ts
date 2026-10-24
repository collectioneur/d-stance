/** When a new shape reaches the screen and how much grow-in is left: PW_TOOLS=1 npx playwright test tools/spawn-latency */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { crowdScene } from "../scenes";
for (const n of [5, 40, 80, 110]) {
  test(`spawn latency ${n}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "classic", quality: 3 }, version: 0 })));
    await openEditor(page, crowdScene(n) as never);
    await waitForProgram(page);
    await page.locator("body").click({ position: { x: 700, y: 880 } });
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const w = window as any;
      const g = w.__dstance.gpu;
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", key: "2" }));
      const items = w.__dstance.scene().items;
      const id = items[items.length - 1].id;
      while (!g.drawnIds().includes(id)) await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      return { ms: performance.now() - t0, p: g.appearProgress(id) };
    });
    console.log(`SPAWN ${n} shapes: on screen after ${r.ms.toFixed(0)} ms, grow-in done: ${r.p === null ? "already over" : `${Math.round(r.p * 100)}%`}`);
  });
}
