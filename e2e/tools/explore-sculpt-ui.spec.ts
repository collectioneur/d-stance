/** SHOT_DIR=/tmp PW_TOOLS=1 npx playwright test tools/explore-sculpt-ui */
import { test } from "@playwright/test";
import { openEditor, projectToScreen, sphere, waitForProgram } from "../helpers";
const D = process.env.SHOT_DIR ?? "/tmp";
test("sculpt UI", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "studio", quality: 3 }, version: 0 })));
  const errors = await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "ball", name: "Ball", params: [0.4, 0, 0, 0], material: { color: [0.85, 0.55, 0.4], roughness: 0.5, metalness: 0, emission: 0 } })] });
  await waitForProgram(page);
  await page.locator("body").click({ position: { x: 700, y: 870 } });
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(300);
  const c = await projectToScreen(page, [0, 0, 0]);
  // A clay stroke across the ball.
  await page.mouse.move(c.x - 50, c.y - 20);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(c.x - 50 + i * 3.5, c.y - 20 + Math.sin(i / 4) * 25);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const dump = async (tag: string) => {
    const root = await page.evaluate(async () => (await import("/src/store/sceneStore.ts")).useSceneStore.getState().root);
    console.log("TREE", tag, JSON.stringify(root.items.map((i: any) => i.kind === "group" ? { g: i.name, items: i.items.map((x: any) => `${x.name}:${x.op}:${(x.stroke?.points.length ?? 0) / 4}`) } : `${i.name}:${(i.stroke?.points.length ?? 0) / 4}`)));
  };
  await dump("after clay");
  // A carve stroke (Alt).
  await page.keyboard.down("Alt");
  await page.mouse.move(c.x - 60, c.y + 40);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(c.x - 60 + i * 6, c.y + 40);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(500);
  // A free stroke in the air.
  await page.mouse.move(c.x + 160, c.y - 120);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(c.x + 160 + Math.cos(i / 3) * 40, c.y - 120 + i * 8);
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.mouse.move(c.x, c.y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${D}/sculpt-ui.png` });
  const root = await page.evaluate(async () => (await import("/src/store/sceneStore.ts")).useSceneStore.getState().root);
  console.log("TREE", JSON.stringify(root.items.map((i: any) => i.kind === "group" ? { g: i.name, items: i.items.map((x: any) => `${x.name}:${x.op}:${(x.stroke?.points.length ?? 0) / 4}`) } : `${i.name}:${(i.stroke?.points.length ?? 0) / 4}`)));
  console.log("ERRORS", JSON.stringify(errors));
});
