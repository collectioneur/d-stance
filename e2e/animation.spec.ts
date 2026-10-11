import { expect, test, type Page } from "@playwright/test";
import { canvasShot, imageDiff, openEditor, openHtml, sceneRoot, sphere, waitForProgram } from "./helpers";
import { animationScene } from "./scenes";

const VIEW = { rotX: 0.3, rotY: 0.4, distance: 2.5 };

async function makeEmbed(page: Page, root: unknown, loop = 8) {
  return page.evaluate(
    async ([r, view, l]) => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      return generateEmbed(r as never, { style: "studio", background: "studio", motion: "still", quality: "fast", framing: "fit", view, loop: l } as never);
    },
    [root, VIEW, loop] as const,
  );
}

async function mountDirect(page: Page, scene: unknown, backend: "webgpu" | "webgl2") {
  await openHtml(page, `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="display:block;width:100vw;height:100vh"></canvas></body>`, `/__anim-${backend}.html`);
  await page.evaluate(
    async ([s, b]) => {
      const { mount } = await import("/src/export/runtime.js");
      mount(document.getElementById("c") as HTMLCanvasElement, s as never, { backend: b as "webgpu" });
    },
    [scene, backend] as const,
  );
  await expect(page.locator("#c")).toHaveAttribute("data-backend", backend);
  await page.waitForTimeout(300);
}

test.describe("animation", () => {
  test("preset → plays, Space pauses, scrubbing moves, tracks survive reload", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball", params: [0.25, 0, 0, 0] })] });
    await waitForProgram(page);
    const timeline = page.locator(".timeline");
    await expect(timeline).toHaveAttribute("data-open", "false");

    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await page.locator(".anim-preset", { hasText: "Float" }).click();
    await expect(timeline).toHaveAttribute("data-open", "true");
    await expect(page.getByLabel("Pause")).toBeVisible();

    // Playing: the picture keeps changing (Float: 2 s period).
    await page.waitForTimeout(300);
    const a = await canvasShot(page);
    await page.waitForTimeout(450);
    const b = await canvasShot(page);
    expect((await imageDiff(page, a, b)).over16).toBeGreaterThan(0.002);

    // Space pauses (focus outside inputs), the picture holds still.
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Play")).toBeVisible();
    await page.waitForTimeout(200);
    const c = await canvasShot(page);
    await page.waitForTimeout(400);
    expect((await imageDiff(page, c, await canvasShot(page))).over16).toBeLessThan(0.0005);

    // Scrubbing to another pose changes the picture while paused.
    const scrub = page.getByLabel("Scrub");
    await scrub.fill("0.5");
    await page.waitForTimeout(150);
    const top = await canvasShot(page);
    await scrub.fill("1.5");
    await page.waitForTimeout(150);
    expect((await imageDiff(page, top, await canvasShot(page))).over16).toBeGreaterThan(0.002);
    await expect(page.getByLabel("Time")).toHaveText("1.5s");

    // Tracks are part of the scene (hash + reload); the rest pose stays the stored one.
    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    const root = await sceneRoot(page);
    const ball = root.items[0] as { position: number[]; animation?: { target: string }[] };
    expect(ball.animation?.map((t) => t.target)).toEqual(["position.y"]);
    expect(ball.position).toEqual([0, 0, 0]);
    expect(errors).toEqual([]);
  });

  test("undo removes a preset; turning a track off stops the motion", async ({ page }) => {
    const errors = await openEditor(page, { id: "r", name: "S", items: [sphere({ id: "s", name: "Ball", params: [0.25, 0, 0, 0] })] });
    await waitForProgram(page);
    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await page.locator(".anim-preset", { hasText: "Orbit" }).click();
    await expect(page.getByLabel("Animated property")).toHaveCount(2);
    await page.getByLabel("Turn off track").first().click();
    await page.getByLabel("Turn off track").first().click();
    await expect(page.locator(".timeline")).toHaveAttribute("data-open", "false");
    await waitForProgram(page);
    const a = await canvasShot(page);
    await page.waitForTimeout(500);
    expect((await imageDiff(page, a, await canvasShot(page))).over16).toBeLessThan(0.0005);
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    const root = await sceneRoot(page);
    expect((root.items[0] as { animation?: unknown }).animation).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("animated embeds move on their own in both backends", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, animationScene());
    expect(out.scene.loop).toBe(8);
    for (const backend of ["webgpu", "webgl2"] as const) {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await mountDirect(page, out.scene, backend);
      const a = await page.locator("#c").screenshot();
      await page.waitForTimeout(400);
      const b = await page.locator("#c").screenshot();
      expect((await imageDiff(page, a, b)).over16, backend).toBeGreaterThan(0.002);
      expect(errors, backend).toEqual([]);
      await openEditor(page);
    }
  });

  test("reduced motion: embeds hold the first pose", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openEditor(page);
    const out = await makeEmbed(page, animationScene());
    await mountDirect(page, out.scene, "webgpu");
    const a = await page.locator("#c").screenshot();
    await page.waitForTimeout(400);
    expect((await imageDiff(page, a, await page.locator("#c").screenshot())).over16).toBeLessThan(0.0005);
  });

  test("animated exports compile in every style (WGSL, GLSL, Shadertoy)", async ({ page }) => {
    await openEditor(page);
    const errors = await page.evaluate(async (view) => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      const { animationScene } = await import("/e2e/scenes.ts");
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
      for (const style of ["classic", "chrome", "studio"]) {
        const e = generateEmbed(animationScene() as never, { style, background: "studio", motion: "still", quality: "balanced", framing: "fit", view, loop: 4 } as never);
        const info = await device.createShaderModule({ code: e.scene.wgsl }).getCompilationInfo();
        for (const m of info.messages) if (m.type === "error") out.push(`wgsl ${style}: ${m.lineNum}: ${m.message}`);
        const g = glslErr(e.scene.glsl);
        if (g) out.push(`glsl ${style}: ${g}`);
        const toy = glslErr(`#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform vec4 iMouse;\nuniform float iTime;\n${e.shadertoy}\nout vec4 o;\nvoid main() { mainImage(o, gl_FragCoord.xy); }`);
        if (toy) out.push(`shadertoy ${style}: ${toy}`);
      }
      return out;
    }, VIEW);
    expect(errors).toEqual([]);
  });
});
