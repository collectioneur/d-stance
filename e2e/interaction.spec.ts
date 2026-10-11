import { expect, test, type Page } from "@playwright/test";
import { canvasShot, imageDiff, openEditor, openHtml, projectToScreen, sceneRoot, waitForProgram } from "./helpers";
import { interactionScene } from "./scenes";

const VIEW = { rotX: 0, rotY: 0, distance: 2.5 };

async function makeEmbed(page: Page, root: unknown, style = "studio") {
  return page.evaluate(
    async ([r, view, s]) => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      return generateEmbed(r as never, { style: s, background: "studio", motion: "still", quality: "fast", framing: "editor", view } as never);
    },
    [root, VIEW, style] as const,
  );
}

async function mountDirect(page: Page, scene: unknown, backend: "webgpu" | "webgl2") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(m.text()));
  await openHtml(page, `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="display:block;width:800px;height:600px"></canvas></body>`, `/__ix-${backend}.html`);
  await page.evaluate(
    async ([s, b]) => {
      const { mount } = await import("/src/export/runtime.js");
      mount(document.getElementById("c") as HTMLCanvasElement, s as never, { backend: b as "webgpu" });
    },
    [scene, backend] as const,
  );
  await expect(page.locator("#c")).toHaveAttribute("data-backend", backend);
  await page.waitForTimeout(250);
  return errors;
}

const shot = (page: Page) => page.locator("#c").screenshot();
/** Lets the eased states settle (~0.2 s to 90%). */
const settle = (page: Page) => page.waitForTimeout(450);

for (const backend of ["webgpu", "webgl2"] as const) {
  test.describe(`embed interaction (${backend})`, () => {
    test("hover reacts and lets go; the cursor shows what is clickable", async ({ page }) => {
      await openEditor(page);
      const out = await makeEmbed(page, interactionScene());
      expect(out.scene.interact).toEqual({ parent: [-1, -1], hoverable: [true, false], clickable: [false, true], pointer: false });
      const errors = await mountDirect(page, out.scene, backend);
      const canvas = page.locator("#c");
      await page.mouse.move(790, 10);
      await settle(page);
      const rest = await shot(page);

      // Left sphere: hover grows and lights it.
      await page.mouse.move(316, 300);
      await expect(canvas).toHaveAttribute("data-hovered", "1");
      await settle(page);
      const hovered = await shot(page);
      expect((await imageDiff(page, rest, hovered)).over16).toBeGreaterThan(0.01);
      expect(await canvas.evaluate((c) => (c as HTMLElement).style.cursor)).toBe("grab");

      // Right box is clickable: pointer cursor.
      await page.mouse.move(484, 300);
      await expect(canvas).toHaveAttribute("data-hovered", "2");
      expect(await canvas.evaluate((c) => (c as HTMLElement).style.cursor)).toBe("pointer");

      // Off everything: back to rest.
      await page.mouse.move(790, 10);
      await expect(canvas).toHaveAttribute("data-hovered", "0");
      await settle(page);
      expect((await imageDiff(page, rest, await shot(page))).over16).toBeLessThan(0.001);
      expect(errors).toEqual([]);
    });

    test("click toggles, a second click toggles back, a drag does not", async ({ page }) => {
      await openEditor(page);
      const out = await makeEmbed(page, interactionScene());
      await mountDirect(page, out.scene, backend);
      await page.mouse.move(790, 10);
      await settle(page);
      const rest = await shot(page);

      await page.mouse.click(484, 300);
      await page.mouse.move(790, 10);
      await settle(page);
      const clicked = await shot(page);
      // The box turned 45°: its corners moved (~0.6% of the canvas).
      expect((await imageDiff(page, rest, clicked)).over16).toBeGreaterThan(0.003);

      // Orbit drag starting on the box: no toggle (the view turns instead).
      await page.mouse.move(484, 300);
      await page.mouse.down();
      await page.mouse.move(530, 300, { steps: 4 });
      await page.mouse.move(484, 300, { steps: 4 });
      await page.mouse.up();
      await page.mouse.move(790, 10);
      await settle(page);
      expect((await imageDiff(page, clicked, await shot(page))).over16).toBeLessThan(0.002);

      await page.mouse.click(484, 300);
      await page.mouse.move(790, 10);
      await settle(page);
      expect((await imageDiff(page, rest, await shot(page))).over16).toBeLessThan(0.002);
    });

    test("pointer reactions follow the cursor across the page", async ({ page }) => {
      await openEditor(page);
      const root = interactionScene();
      (root.items[0] as Record<string, unknown>).interaction = [{ trigger: "pointerX", target: "position.x", amount: 0.3 }];
      const out = await makeEmbed(page, root);
      expect(out.scene.interact?.pointer).toBe(true);
      await mountDirect(page, out.scene, backend);
      await page.mouse.move(5, 300);
      await settle(page);
      const left = await shot(page);
      await page.mouse.move(795, 300);
      await settle(page);
      const right = await shot(page);
      expect((await imageDiff(page, left, right)).over16).toBeGreaterThan(0.01);
    });
  });
}

test("interactive exports compile in every style (WGSL with pick, GLSL with PICK)", async ({ page }) => {
  await openEditor(page);
  const errors = await page.evaluate(async (view) => {
    const { generateEmbed } = await import("/src/export/embed.ts");
    const { interactionScene, animationScene } = await import("/e2e/scenes.ts");
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
    const glslErr = (src: string) => {
      const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? "" : gl.getShaderInfoLog(sh);
    };
    const anim = animationScene() as { items: Record<string, unknown>[] };
    anim.items[1].interaction = [{ trigger: "hover", target: "emission", amount: 2 }];
    anim.items[2].interaction = [{ trigger: "pointerY", target: "rotation.x", amount: 20 }];
    const out: string[] = [];
    for (const root of [interactionScene(), anim]) {
      for (const style of ["classic", "chrome", "studio"]) {
        const e = generateEmbed(root as never, { style, background: "studio", motion: "still", quality: "balanced", framing: "fit", view } as never);
        if (!e.scene.wgsl.includes("fn fs_pick")) out.push(`no pick entry (${style})`);
        const info = await device.createShaderModule({ code: e.scene.wgsl }).getCompilationInfo();
        for (const m of info.messages) if (m.type === "error") out.push(`wgsl ${style}: ${m.lineNum}: ${m.message}`);
        const g = glslErr(e.scene.glsl);
        if (g) out.push(`glsl ${style}: ${g}`);
        const pick = glslErr(e.scene.glsl.replace(/^(#version[^\n]*\n)/, "$1#define PICK 1\n"));
        if (pick) out.push(`glsl pick ${style}: ${pick}`);
        const toy = glslErr(`#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform vec4 iMouse;\nuniform float iTime;\n${e.shadertoy}\nout vec4 o;\nvoid main() { mainImage(o, gl_FragCoord.xy); }`);
        if (toy) out.push(`shadertoy ${style}: ${toy}`);
      }
    }
    return out;
  }, VIEW);
  expect(errors).toEqual([]);
});

test.describe("editor interaction", () => {
  test("inspector presets, Try mode plays hover and click without touching the selection, Esc returns", async ({ page }) => {
    const errors = await openEditor(page, interactionScene() as never);
    await waitForProgram(page);
    await page.locator(".scene-item-name", { hasText: "Ball" }).click();
    await expect(page.getByLabel("Reacting property")).toHaveCount(2);
    await page.locator(".anim-preset", { hasText: "Lift" }).click();
    await expect(page.getByLabel("Reacting property")).toHaveCount(3);
    await page.getByLabel("Remove reaction").last().click();
    await expect(page.getByLabel("Reacting property")).toHaveCount(2);

    const ball = await projectToScreen(page, [-0.7, 0, 0]);
    const crate = await projectToScreen(page, [0.7, 0, 0]);
    await page.mouse.move(5, 450);
    await page.waitForTimeout(300);
    const editing = await canvasShot(page);

    await page.getByRole("button", { name: "Try" }).click();
    await expect(page.locator(".try-banner")).toHaveAttribute("data-open", "true");
    await page.waitForTimeout(300);
    const rest = await canvasShot(page);
    // Selection glow and gizmo are gone: the scene as the viewer sees it.
    expect((await imageDiff(page, editing, rest)).over16).toBeGreaterThan(0.001);

    await page.mouse.move(ball.x, ball.y);
    await page.waitForTimeout(600);
    const hovered = await canvasShot(page);
    expect((await imageDiff(page, rest, hovered)).over16).toBeGreaterThan(0.01);

    await page.mouse.click(crate.x, crate.y);
    await page.mouse.move(5, 450);
    await page.waitForTimeout(600);
    const clicked = await canvasShot(page);
    expect((await imageDiff(page, rest, clicked)).over16).toBeGreaterThan(0.002);
    // Clicking in Try mode does not select.
    const selected = await page.evaluate(async () => (await import("/src/store/sceneStore.ts")).useSceneStore.getState().selectedIds);
    expect(selected).toEqual(["ix-sphere"]);

    await page.keyboard.press("Escape");
    await expect(page.locator(".try-banner")).toHaveAttribute("data-open", "false");
    await page.waitForTimeout(600);
    expect((await imageDiff(page, editing, await canvasShot(page))).over16).toBeLessThan(0.001);

    // Reactions are part of the scene (hash + reload).
    await page.waitForTimeout(1300);
    await page.reload();
    await waitForProgram(page);
    const root = await sceneRoot(page);
    expect((root.items[0] as { interaction?: unknown[] }).interaction).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test("the embed preview carries the reactions", async ({ page }) => {
    await openEditor(page, interactionScene() as never);
    await waitForProgram(page);
    const html = await page.evaluate(async () => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      const { useSceneStore } = await import("/src/store/sceneStore.ts");
      return generateEmbed(useSceneStore.getState().root, { style: "studio", background: "studio", motion: "still", quality: "fast", framing: "fit", view: { rotX: 0, rotY: 0, distance: 2.5 } }).html;
    });
    expect(html).toContain('"interact"');
    expect(html).toContain("fs_pick");
  });
});
