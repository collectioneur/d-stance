/** When the compile indicator shows on real scenes: PW_TOOLS=1 npx playwright test tools/compile-indicator */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
import { crowdScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
for (const n of [5, 40, 80, 110]) {
  test(`indicator ${n}`, async ({ page }) => {
    await openEditor(page, crowdScene(n) as never);
    await waitForProgram(page);
    await page.locator("body").click({ position: { x: 700, y: 880 } });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const el = document.querySelector(".compile-indicator")!;
      const w = window as any;
      w.__shownMs = null;
      const t0 = performance.now();
      w.__t0 = t0;
      new MutationObserver(() => {
        if (el.getAttribute("data-open") === "true" && w.__shownMs === null) w.__shownMs = performance.now() - w.__t0;
      }).observe(el, { attributes: true });
    });
    await page.evaluate(() => {
      (window as any).__t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit2", key: "2" }));
    });
    let shot = false;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(50);
      const open = await page.locator(".compile-indicator").getAttribute("data-open");
      if (open === "true" && !shot) {
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${D}/compile-${n}.png`, clip: { x: 520, y: 60, width: 400, height: 60 } });
        shot = true;
      }
    }
    const r = await page.evaluate(async () => {
      const { useCompileStore } = await import("/src/store/compileStore.ts");
      return { shownAfter: (window as any).__shownMs, stillCompiling: useCompileStore.getState().since !== null };
    });
    console.log(`INDICATOR ${n} shapes: ${r.shownAfter === null ? "never shown" : `shown after ${r.shownAfter.toFixed(0)} ms`}`);
  });
}
