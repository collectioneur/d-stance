import { test } from "@playwright/test";
import fs from "node:fs";
import { canvasShot, openEditor, openHtml, waitForProgram } from "../helpers";
import { csgScene } from "../scenes";
const D = process.env.SHOT_DIR ?? "/tmp";
test("embed vs editor shots", async ({ page }) => {
  const lifted = { id: "r", name: "Lifted", items: [{ kind: "group", id: "lift", name: "Lift", position: [0, -0.8, 0], rotation: [0, 0, 0], scale: [1, 1, 1], op: "union", smoothK: 0.1, items: csgScene().items }] };
  await page.addInitScript(() => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: "classic", quality: 3 }, version: 0 })));
  await openEditor(page, lifted as never);
  await waitForProgram(page);
  const a = await canvasShot(page, `${D}/cmp-editor.png`);
  const out = await page.evaluate(async (root) => {
    const { generateEmbed } = await import("/src/export/embed.ts");
    return generateEmbed(root as never, { style: "classic", background: "studio", motion: "still", quality: "balanced", view: { rotX: 0.3, rotY: 0.4, distance: 2.5 } } as never);
  }, lifted);
  await openHtml(page, out.document);
  await page.waitForTimeout(800);
  const b = await page.locator("canvas").screenshot({ path: `${D}/cmp-embed.png` });
  const diff = await page.evaluate(async ([a64, b64]) => {
    const load = async (s: string) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext("2d")!.drawImage(bmp, 0, 0); return c.getContext("2d")!.getImageData(0, 0, bmp.width, bmp.height); };
    const [x, y] = await Promise.all([load(a64), load(b64)]);
    const c = new OffscreenCanvas(x.width, x.height); const g = c.getContext("2d")!; const o = g.createImageData(x.width, x.height);
    for (let i = 0; i < x.data.length; i += 4) { const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i+1] - y.data[i+1]) + Math.abs(x.data[i+2] - y.data[i+2]); o.data[i] = Math.min(255, d * 4); o.data[i+1] = x.data[i] / 3; o.data[i+2] = 0; o.data[i+3] = 255; }
    g.putImageData(o, 0, 0); const blob = await c.convertToBlob(); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; buf.forEach((v) => (s += String.fromCharCode(v))); return btoa(s);
  }, [a.toString("base64"), b.toString("base64")] as const);
  fs.writeFileSync(`${D}/cmp-diff.png`, Buffer.from(diff, "base64"));
});
