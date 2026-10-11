/**
 * GPU frame time and compile time per reference scene.
 *   PW_TOOLS=1 npx playwright test tools/bench --reporter=line | grep RESULT
 */
import { test } from "@playwright/test";
import { openEditor, waitForFrames } from "../helpers";
import { animationScene, sculptScene, crowdScene, allShapesScene, csgScene, infiniteScene, modifiersScene, noiseScene } from "../scenes";

/** Every shape of a crowd floating out of step: per-frame CPU evaluation + uniform upload. */
function animatedCrowd(count: number) {
  const root = crowdScene(count) as { items: Record<string, unknown>[] };
  root.items.forEach((it, i) => (it.animation = [{ target: "position.y", wave: "sine", amount: 0.05, period: 2, phase: (i % 10) / 10 }]));
  return root;
}
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
  ["anim", animationScene],
  ["animCrowd120", () => animatedCrowd(120)],
  ["sculpt", sculptScene],
  ["sculptHeavy", heavySculpt],
];

/** A ball under six 600-point clay spirals (3600 stroke points). */
function heavySculpt() {
  const root = sculptScene() as { items: { items?: Record<string, unknown>[] }[] };
  const obj = root.items[0].items!;
  for (let k = 0; k < 6; k++) {
    const pts: number[] = [];
    for (let i = 0; i < 600; i++) {
      const t = i / 599;
      const a = t * Math.PI * 10 + k;
      const y = -0.4 + t * 0.8;
      const rr = Math.sqrt(Math.max(0.0001, 0.16 - y * y)) + 0.01;
      pts.push(Math.cos(a) * rr, y, Math.sin(a) * rr, 0.02);
    }
    obj.push({ ...obj[1], id: `heavy${k}`, stroke: { points: pts } });
  }
  return root;
}
const MODES = process.env.BENCH_MODES?.split(",") ?? ["classic", "chrome", "studio"];
for (const mode of MODES) {
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
