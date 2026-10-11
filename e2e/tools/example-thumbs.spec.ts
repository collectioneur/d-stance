/**
 * Regenerates src/assets/examples/<id>.jpg (the gallery thumbnails) with the
 * export renderer: PW_TOOLS=1 npx playwright test tools/example-thumbs
 */
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { openEditor, openHtml } from "../helpers";

test("example thumbnails", async ({ page }) => {
  await openEditor(page);
  const examples = await page.evaluate(async () => {
    const { EXAMPLES } = await import("/src/scene/examples.ts");
    const { generateEmbed } = await import("/src/export/embed.ts");
    const out: { id: string; scene: unknown }[] = [];
    for (const ex of EXAMPLES) {
      const root = await ex.build();
      const style = ex.look === "field" || ex.look === "cost" || ex.look === "normals" ? "classic" : ex.look;
      const e = generateEmbed(root, { style, background: "studio", motion: "still", quality: "best", framing: "fit", view: ex.view, loop: 8 } as never);
      // Fit covers every animated pose; a thumbnail shows one, so frame tighter.
      const zoom: Record<string, number> = { island: 0.55, lamp: 0.75, cloud: 0.8, neon: 0.85, button: 0.8, clay: 0.85 };
      const view = { ...e.scene.view, distance: e.scene.view.distance * (zoom[ex.id] ?? 0.8) };
      delete (view as { fit?: number }).fit;
      out.push({ id: ex.id, scene: { ...e.scene, view } });
    }
    return out;
  });
  for (const ex of examples) {
    await openHtml(page, `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="display:block;width:480px;height:300px"></canvas></body>`, `/__thumb-${ex.id}.html`);
    await page.evaluate(async (s) => {
      const { mount } = await import("/src/export/runtime.js");
      mount(document.getElementById("c") as HTMLCanvasElement, s as never, { animate: false, maxDpr: 1 });
    }, ex.scene);
    await expect(page.locator("#c")).toHaveAttribute("data-backend", /webgpu|webgl2/);
    await page.waitForTimeout(400);
    const jpg = await page.locator("#c").screenshot({ type: "jpeg", quality: 82 });
    writeFileSync(`src/assets/examples/${ex.id}.jpg`, jpg);
    console.log("THUMB", ex.id, jpg.length);
  }
});
