import { expect, test, type Page } from "@playwright/test";
import { canvasShot, imageDiff, openEditor, projectToScreen, sceneRoot, sphere, waitForProgram } from "./helpers";
import { sculptScene } from "./scenes";

type Item = { id: string; kind: string; name: string; op?: string; shapeType?: string; stroke?: { points: number[] }; modifiers?: unknown[]; items?: Item[] };

const BALL = { id: "r", name: "S", items: [sphere({ id: "ball", name: "Ball", params: [0.4, 0, 0, 0] })] };

async function stroke(page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 16) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  await page.mouse.up();
}

async function items(page: Page): Promise<Item[]> {
  return (await sceneRoot(page)).items as Item[];
}

/** Sculpting is on, the canvas is focused, the cursor is off the scene. */
async function startSculpting(page: Page) {
  await page.locator("body").click({ position: { x: 700, y: 870 } });
  await page.waitForTimeout(200);
  await page.keyboard.press("KeyB");
  await expect(page.locator(".sculpt-bar")).toHaveAttribute("data-open", "true");
}

test.describe("sculpt", () => {
  test("B toggles the tool; the gizmo bar steps aside; Esc and Done leave", async ({ page }) => {
    await openEditor(page, BALL);
    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await expect(page.locator(".gizmo-dock .segmented")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("KeyB");
    await expect(page.locator(".sculpt-bar")).toHaveAttribute("data-open", "true");
    await expect(page.locator(".gizmo-dock .segmented")).toHaveAttribute("data-open", "false");
    await page.keyboard.press("]");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sculpt-bar")).toHaveAttribute("data-open", "false");
    await page.getByTitle(/Sculpt: paint clay/).click();
    await expect(page.locator(".sculpt-bar")).toHaveAttribute("data-open", "true");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".sculpt-bar")).toHaveAttribute("data-open", "false");
  });

  test("clay on a shape: the shape becomes an object; one undo takes the whole stroke back", async ({ page }) => {
    const errors = await openEditor(page, BALL);
    await waitForProgram(page);
    const before = await canvasShot(page);
    await startSculpting(page);
    const c = await projectToScreen(page, [0, 0, 0]);
    await stroke(page, { x: c.x - 40, y: c.y - 10 }, 80, 20);
    await expect.poll(async () => (await items(page))[0].items?.[1]?.stroke?.points.length ?? 0).toBeGreaterThanOrEqual(8);
    await page.waitForTimeout(300); // the stroke finishes (simplify, taper)
    const obj = (await items(page))[0];
    expect(obj.name).toBe("Ball");
    expect(obj.items!.map((i) => [i.name, i.op])).toEqual([
      ["Ball", "union"],
      ["Ball · clay", "sUnion"],
    ]);
    const pts = obj.items![1].stroke!.points;
    expect(pts.length / 4).toBeGreaterThanOrEqual(2);
    // On the surface: every point sits about the ball's radius from its center.
    console.log("PTS", JSON.stringify(pts.map((v) => Math.round(v * 1000) / 1000)));
    for (let i = 0; i < pts.length; i += 4) expect(Math.hypot(pts[i], pts[i + 1], pts[i + 2])).toBeCloseTo(0.4, 1);
    await waitForProgram(page);
    // A thin bead (radius 0.05) across the ball.
    expect((await imageDiff(page, before, await canvasShot(page))).over16).toBeGreaterThan(0.0008);

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await items(page))[0].kind).toBe("layer");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await items(page))[0].kind).toBe("group");
    expect(errors).toEqual([]);
  });

  test("Alt carves; carving the air does nothing; clay in the air makes a free stroke", async ({ page }) => {
    await openEditor(page, BALL);
    await waitForProgram(page);
    await startSculpting(page);
    const c = await projectToScreen(page, [0, 0, 0]);
    await page.keyboard.down("Alt");
    await stroke(page, { x: c.x - 30, y: c.y + 10 }, 60, 0);
    await page.keyboard.up("Alt");
    await expect.poll(async () => (await items(page))[0].items?.[1]?.op).toBe("sSubtract");

    await page.keyboard.down("Alt");
    await stroke(page, { x: c.x + 300, y: c.y - 200 }, 40, 40);
    await page.keyboard.up("Alt");
    await expect(page.locator(".toast")).toContainText("Carve on a surface");
    expect(await items(page)).toHaveLength(1);

    await stroke(page, { x: c.x + 300, y: c.y - 200 }, 60, 80);
    await expect.poll(async () => (await items(page))[1]?.stroke?.points.length ?? 0).toBeGreaterThanOrEqual(8);
    const free = (await items(page))[1];
    expect(free.shapeType).toBe("stroke");
    expect(free.stroke!.points.length / 4).toBeGreaterThanOrEqual(2);
  });

  test("Mirror X lives on the stroke layer; right-drag orbits without painting", async ({ page }) => {
    await openEditor(page, BALL);
    await waitForProgram(page);
    await startSculpting(page);
    await page.getByRole("button", { name: "Mirror X" }).click();
    const c = await projectToScreen(page, [0, 0, 0]);
    await stroke(page, { x: c.x + 10, y: c.y - 30 }, 30, 40);
    await expect.poll(async () => (await items(page))[0].items?.[1]?.modifiers).toEqual([{ kind: "mirror", axes: [true, false, false] }]);
    await page.getByRole("button", { name: "Mirror X" }).click();

    const count = JSON.stringify(await items(page)).length;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(c.x + 150, c.y + 20, { steps: 8 });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(300);
    expect(JSON.stringify(await items(page)).length).toBe(count);
    const view = await page.evaluate(async () => (await import("/src/store/viewStore.ts")).useViewStore.getState().rotX);
    expect(view).not.toBeCloseTo(0.3, 2);
  });

  test("sculpted scenes reload from the link and look the same", async ({ page }) => {
    const errors = await openEditor(page, sculptScene() as never);
    await waitForProgram(page);
    const a = await canvasShot(page);
    await page.reload();
    await waitForProgram(page);
    expect((await imageDiff(page, a, await canvasShot(page))).over16).toBeLessThan(0.001);
    const root = await sceneRoot(page);
    expect(((root.items[0] as Item).items![1] as Item).stroke!.points.length).toBe(90 * 4);
    expect(errors).toEqual([]);
  });

  test("sculpted scenes export: embed compiles and renders strokes in both backends", async ({ page }) => {
    await openEditor(page);
    const errors = await page.evaluate(async () => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      const { generateSdfCode } = await import("/src/utils/generateSdfCode.ts");
      const { sculptScene } = await import("/e2e/scenes.ts");
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter!.requestDevice();
      const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
      const glslErr = (src: string) => {
        const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? "" : gl.getShaderInfoLog(sh);
      };
      const out: string[] = [];
      for (const style of ["classic", "studio", "volume"]) {
        const e = generateEmbed(sculptScene() as never, { style, background: "studio", motion: "still", quality: "fast", framing: "fit", view: { rotX: 0.3, rotY: 0.4, distance: 2.5 } } as never);
        const info = await device.createShaderModule({ code: e.scene.wgsl }).getCompilationInfo();
        for (const m of info.messages) if (m.type === "error") out.push(`wgsl ${style} ${m.lineNum}: ${m.message}`);
        const g = glslErr(e.scene.glsl);
        if (g) out.push(`glsl ${style}: ${g}`);
      }
      const code = generateSdfCode(sculptScene() as never, null);
      if (!code.typegpu.includes("tgpu.const(d.arrayOf(d.vec4f")) out.push("typegpu strokes");
      return out;
    });
    expect(errors).toEqual([]);
  });
});
