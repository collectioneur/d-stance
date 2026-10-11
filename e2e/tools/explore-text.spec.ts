/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-text */
import { test } from "@playwright/test";
import { openEditor, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";
test("text UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page);
  await waitForProgram(page);
  // clear default scene
  await page.evaluate(async () => {
    const { useSceneStore } = await import("/src/store/sceneStore.ts");
    const st = useSceneStore.getState();
    st.removeItems(st.root.items.map((i) => i.id));
  });
  const t = await page.evaluate(async () => {
    const { bakeText, DEFAULT_TEXT } = await import("/src/utils/textSdf.ts");
    await bakeText(DEFAULT_TEXT);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await bakeText({ ...DEFAULT_TEXT, content: `Hello ${i}` });
    return (performance.now() - t0) / 5;
  });
  console.log("BAKE ms", t.toFixed(1));
  await page.keyboard.press("Digit8");
  await page.waitForTimeout(800);
  await waitForProgram(page);
  await page.screenshot({ path: `${D}/text-01.png` });
  await page.getByLabel("Text", { exact: true }).fill("d-stance\nSDF");
  await page.waitForTimeout(600);
  await waitForProgram(page);
  await page.screenshot({ path: `${D}/text-02.png` });
  await page.getByLabel("Font", { exact: true }).selectOption("serif");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${D}/text-03.png` });
  await page.locator("body").click({ position: { x: 700, y: 820 } });
  await page.mouse.move(720, 450);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${D}/text-04.png`, clip: { x: 320, y: 150, width: 800, height: 600 } });
  console.log("ERRORS", JSON.stringify(errors));
});
