import { expect, test, type Page } from "@playwright/test";
import { bakeTestImage, box, canvasShot, imageDiff, openEditor, openHtml, sphere, waitForProgram } from "./helpers";
import { csgScene } from "./scenes";

type Opts = { style: "classic" | "chrome"; background: "studio" | "transparent"; motion: "still"; quality: "fast" | "balanced" | "best" };
const VIEW = { rotX: 0.3, rotY: 0.4, distance: 2.5 };

async function makeEmbed(page: Page, root: unknown, opts: Partial<Opts> = {}) {
  return page.evaluate(
    async ([r, o, view]) => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      return generateEmbed(r as never, { style: "classic", background: "studio", motion: "still", quality: "balanced", framing: "editor", view, ...(o as object) } as never);
    },
    [root, opts, VIEW] as const,
  );
}

async function waitDrawn(page: Page, selector = "canvas") {
  await expect(page.locator(selector)).toHaveAttribute("data-backend", /webgpu|webgl2/);
  await page.waitForTimeout(300);
}

/** Renders the embed's scene with the runtime directly, forcing a backend. */
async function mountDirect(page: Page, scene: unknown, backend: "webgpu" | "webgl2") {
  await openHtml(page, `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="display:block;width:100vw;height:100vh"></canvas></body>`, `/__mount-${backend}.html`);
  await page.evaluate(
    async ([s, b]) => {
      const { mount } = await import("/src/export/runtime.js");
      mount(document.getElementById("c") as HTMLCanvasElement, s as never, { backend: b as "webgpu" });
    },
    [scene, backend] as const,
  );
  await waitDrawn(page, "#c");
}

const SCENE = { id: "r", name: "Embed Test", items: [box({ id: "b" }), sphere({ id: "s", position: [0.35, -0.2, 0], op: "sUnion", smoothK: 0.2 })] };

test.describe("embed export", () => {
  test("HTML snippet renders in a plain page with WebGPU", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await openHtml(page, out.document);
    await waitDrawn(page);
    expect(await page.locator("canvas").getAttribute("data-backend")).toBe("webgpu");
    const shot = await page.locator("canvas").screenshot();
    expect(shot.length).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });

  test("WebGPU and WebGL2 backends draw the same image", async ({ page }) => {
    for (const style of ["classic", "chrome"] as const) {
      await openEditor(page);
      const out = await makeEmbed(page, csgScene(), { style });
      await mountDirect(page, out.scene, "webgpu");
      const gpu = await page.locator("#c").screenshot();
      await openEditor(page);
      await mountDirect(page, out.scene, "webgl2");
      expect(await page.locator("#c").getAttribute("data-backend")).toBe("webgl2");
      const gl = await page.locator("#c").screenshot();
      const diff = await imageDiff(page, gpu, gl);
      expect(diff.over16, style).toBeLessThan(0.003);
    }
  });

  test("embed matches the editor viewport (objects only)", async ({ page }) => {
    // Lifted above the grid plane: the editor draws grid lines over anything
    // behind the plane, the embed has no grid.
    const lifted = { id: "r", name: "Lifted", items: [{ kind: "group", id: "lift", name: "Lift", position: [0, -0.8, 0], rotation: [0, 0, 0], scale: [1, 1, 1], op: "union", smoothK: 0.1, items: csgScene().items }] };
    for (const mode of ["classic", "chrome"] as const) {
      await page.addInitScript((m) => localStorage.setItem("d-stance_render_mode", JSON.stringify({ state: { renderMode: m, quality: 3 }, version: 0 })), mode);
      await openEditor(page, lifted as never);
      await waitForProgram(page);
      const editor = await canvasShot(page);
      const out = await makeEmbed(page, lifted, { style: mode });
      await mountDirect(page, out.scene, "webgpu");
      const embed = await page.locator("#c").screenshot();
      // Same camera, same shading; the editor adds grid lines, so compare
      // only pixels the editor shows as lit surface.
      const d = await page.evaluate(
        async ([a64, b64]) => {
          const load = async (s: string) => {
            const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            c.getContext("2d")!.drawImage(bmp, 0, 0);
            return c.getContext("2d")!.getImageData(0, 0, bmp.width, bmp.height).data;
          };
          const [x, y] = await Promise.all([load(a64), load(b64)]);
          const w = Math.round(Math.sqrt((x.length / 4) * 1.6)); // 16:10 canvas
          const lit = (i: number) => 0.3 * x[i] + 0.59 * x[i + 1] + 0.11 * x[i + 2] >= 70;
          let n = 0, bad = 0;
          for (let i = 4 * (w + 1); i < x.length - 4 * (w + 1); i += 4) {
            // Interior surface pixels only: silhouettes legitimately differ
            // by a pixel (culling changes how grazing rays converge).
            if (!lit(i) || !lit(i - 4) || !lit(i + 4) || !lit(i - 4 * w) || !lit(i + 4 * w)) continue;
            n++;
            if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 48) bad++;
          }
          return { n, bad: bad / Math.max(n, 1) };
        },
        [editor.toString("base64"), embed.toString("base64")] as const,
      );
      expect(d.n, mode).toBeGreaterThan(2000);
      expect(d.bad, mode).toBeLessThan(0.02);
    }
  });

  test("every option combination compiles (WGSL + GLSL + Shadertoy)", async ({ page }) => {
    await openEditor(page);
    const errors = await page.evaluate(async (view) => {
      const { generateEmbed } = await import("/src/export/embed.ts");
      const { kitchenSink } = await import("/src/test/fixtures.ts");
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter!.requestDevice();
      const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
      const glslErr = (src: string) => {
        const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? null : gl.getShaderInfoLog(sh);
      };
      const out: string[] = [];
      for (const root of [kitchenSink(), { id: "e", name: "Empty", items: [] }]) {
        for (const style of ["classic", "chrome"]) {
          for (const background of ["studio", "transparent"]) {
            for (const quality of ["fast", "best"]) {
              const e = generateEmbed(root as never, { style, background, quality, motion: "still", framing: background === "studio" ? "fit" : "editor", view } as never);
              const info = await device.createShaderModule({ code: e.scene.wgsl }).getCompilationInfo();
              for (const m of info.messages) if (m.type === "error") out.push(`wgsl ${style}/${background}: ${m.lineNum}: ${m.message}`);
              const g = glslErr(e.scene.glsl);
              if (g) out.push(`glsl ${style}/${background}: ${g}`);
              const toy = glslErr(`#version 300 es\nprecision highp float;\nuniform vec3 iResolution;\nuniform vec4 iMouse;\nuniform float iTime;\n${e.shadertoy}\nout vec4 o;\nvoid main() { mainImage(o, gl_FragCoord.xy); }`);
              if (toy) out.push(`shadertoy ${style}/${background}: ${toy}`);
            }
          }
        }
      }
      return out;
    }, VIEW);
    expect(errors).toEqual([]);
  });

  test("image layers render in both backends", async ({ page }) => {
    await openEditor(page);
    const sdf = await bakeTestImage(page);
    const root = { id: "r", name: "Logo", items: [{ ...box(), shapeType: "image", params: [0.6, 0.08, 0, 0], image: { sdf } }] };
    const out = await makeEmbed(page, root);
    expect(out.scene.images).toEqual([sdf]);
    expect(out.html).not.toContain(`// ${sdf.slice(0, 40)}`);
    for (const backend of ["webgpu", "webgl2"] as const) {
      await openEditor(page);
      await mountDirect(page, out.scene, backend);
      const lit = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 300));
        const c = document.getElementById("c") as HTMLCanvasElement;
        return c.dataset.backend;
      });
      expect(lit).toBe(backend);
      const shot = await page.locator("#c").screenshot();
      const stats = await page.evaluate(async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d")!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 16) if (d[i] > 90) lit++;
        return lit / (d.length / 16);
      }, shot.toString("base64"));
      expect(stats, backend).toBeGreaterThan(0.01);
    }
  });
});

test.describe("embed behaviour", () => {
  const far = { id: "r", name: "Far Away", items: [box({ position: [3, -2, 4], params: [0.3, 0.3, 0.3, 0] })] };

  async function stats(page: Page, sel = "canvas") {
    const png = await page.locator(sel).first().screenshot();
    return page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < bmp.height; y += 2) for (let x = 0; x < bmp.width; x += 2) {
        const i = (y * bmp.width + x) * 4;
        if (d[i] > 90 && Math.abs(d[i] - d[i + 2]) < 40) { n++; sx += x; sy += y; }
      }
      const corner = [d[0], d[1], d[2]];
      return { coverage: n / ((bmp.width * bmp.height) / 4), cx: sx / n / bmp.width, cy: sy / n / bmp.height, corner };
    }, png.toString("base64"));
  }

  test("fit framing centers an off-origin scene", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, far, { framing: "fit" } as never);
    expect(out.scene.view.target).toEqual([3, -2, 4]);
    await openHtml(page, out.document);
    await waitDrawn(page);
    const s = await stats(page);
    expect(s.coverage).toBeGreaterThan(0.03);
    expect(Math.abs(s.cx - 0.5)).toBeLessThan(0.1);
    expect(Math.abs(s.cy - 0.5)).toBeLessThan(0.1);
  });

  test("transparent background shows the page behind", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE, { background: "transparent" });
    await openHtml(page, `<!doctype html><body style="margin:0;background:rgb(200,30,30)">${out.html}</body>`);
    await waitDrawn(page);
    const s = await stats(page);
    expect(s.corner[0]).toBeGreaterThan(180);
    expect(s.corner[1]).toBeLessThan(60);
  });

  test("drag orbits, ctrl+wheel zooms; a plain wheel scrolls the page until the scene is clicked", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE, { framing: "fit" } as never);
    await openHtml(page, `<!doctype html><body style="margin:0;height:3000px;background:#000">${out.html}</body>`);
    await waitDrawn(page);
    const c = page.locator("canvas");
    const bb = (await c.boundingBox())!;
    const mid = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    const before = await c.screenshot();
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + 150, mid.y, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const rotated = await c.screenshot();
    expect((await imageDiff(page, before, rotated)).over16).toBeGreaterThan(0.01);

    await page.mouse.move(mid.x, mid.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const zoomed = await c.screenshot();
    expect((await imageDiff(page, rotated, zoomed)).over16).toBeGreaterThan(0.01);

    // The drag above activated the scene: a plain wheel zooms while the
    // pointer stays on it.
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect((await imageDiff(page, zoomed, await c.screenshot())).over16).toBeGreaterThan(0.01);

    // Leaving deactivates it: back on the scene, a plain wheel scrolls and a
    // hint says how to zoom.
    await page.mouse.move(mid.x, bb.y + bb.height + 100);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const hint = page.getByText(/or click the scene to zoom/);
    await expect(hint).toHaveCSS("opacity", "1");
    await expect(hint).toHaveCSS("opacity", "0", { timeout: 3000 });
  });

  test("on a page that cannot scroll, a plain wheel zooms", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE, { framing: "fit" } as never);
    await openHtml(page, out.document);
    await waitDrawn(page);
    const c = page.locator("canvas");
    const bb = (await c.boundingBox())!;
    const before = await c.screenshot();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    expect((await imageDiff(page, before, await c.screenshot())).over16).toBeGreaterThan(0.01);
    await expect(page.getByText(/or click the scene to zoom/)).toHaveCount(0);
  });

  test("touch pinch and Safari trackpad gestures zoom", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE, { framing: "fit" } as never);
    await openHtml(page, `<!doctype html><body style="margin:0;height:3000px"><canvas id="c" style="display:block;width:600px;height:400px"></canvas></body>`, "/__pinch.html");
    await page.evaluate(async (scene) => {
      const { mount } = await import("/src/export/runtime.js");
      const w = window as unknown as { views: { zoom: number }[] };
      w.views = [];
      mount(document.getElementById("c") as HTMLCanvasElement, scene as never, { onView: (v) => w.views.push(v) });
    }, out.scene);
    await waitDrawn(page, "#c");
    const lastZoom = () => page.evaluate(() => (window as unknown as { views: { zoom: number }[] }).views.at(-1)?.zoom);

    // Two fingers spreading apart: closer.
    const cdp = await page.context().newCDPSession(page);
    const points = (d: number) => [
      { x: 300 - d, y: 200, id: 1 },
      { x: 300 + d, y: 200, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(40) });
    for (let d = 50; d <= 120; d += 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(d) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(lastZoom).toBeCloseTo(40 / 120, 1);
    expect(await page.evaluate(() => scrollY)).toBe(0);

    // Safari: pinching the trackpad in to half doubles the distance.
    const prevented = await page.evaluate(() => {
      const c = document.getElementById("c")!;
      const fire = (type: string, scale: number) => {
        const e = new Event(type, { cancelable: true });
        Object.defineProperty(e, "scale", { value: scale });
        c.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return [fire("gesturestart", 1), fire("gesturechange", 0.75), fire("gesturechange", 0.5), fire("gestureend", 0.5)];
    });
    expect(prevented).toEqual([true, true, true, true]);
    await expect.poll(lastZoom).toBeCloseTo((40 / 120) * 2, 2);
  });

  test("JS module export mounts from an import", async ({ page }) => {
    await openEditor(page);
    const out = await makeEmbed(page, SCENE);
    await openHtml(page, `<!doctype html><body style="margin:0"><canvas id="m" style="width:600px;height:400px"></canvas></body>`);
    await page.evaluate(async (src) => {
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const mod = await import(/* @vite-ignore */ url);
      mod.default(document.getElementById("m"));
    }, out.module);
    await expect(page.locator("#m")).toHaveAttribute("data-backend", "webgpu");
  });

  test("editor preview renders and download saves the file", async ({ page }) => {
    await openEditor(page, SCENE);
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Embed", exact: true }).click();
    const frame = page.frameLocator(".embed-preview-frame");
    await expect(frame.locator("canvas")).toHaveAttribute("data-backend", /webgpu|webgl2/);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download embed-test\.html/ }).click();
    expect((await download).suggestedFilename()).toBe("embed-test.html");
    await page.getByLabel("Format").selectOption("module");
    const dl2 = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download embed-test\.js/ }).click();
    expect((await dl2).suggestedFilename()).toBe("embed-test.js");
  });

  test("orbiting and zooming the preview sets the start view without restarting it", async ({ page }) => {
    await openEditor(page, SCENE);
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Embed", exact: true }).click();
    const frame = page.frameLocator(".embed-preview-frame");
    await expect(frame.locator("canvas")).toHaveAttribute("data-backend", /webgpu|webgl2/);
    await page.waitForTimeout(500);
    const iframe = page.locator(".embed-preview-frame");
    const doc = await iframe.getAttribute("srcdoc");
    const exportState = () =>
      page.evaluate(async () => {
        const { useExportStore } = await import("/src/store/exportStore.ts");
        const { framing, custom } = useExportStore.getState();
        return { framing, custom };
      });

    const bb = (await iframe.boundingBox())!;
    const mid = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + 60, mid.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await exportState()).framing).toBe("custom");
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await exportState()).custom?.zoom ?? 1).toBeLessThan(1);

    const { custom } = await exportState();
    expect(custom!.base).toBe("fit");
    expect(custom!.rotX).not.toBeCloseTo(0.3, 2);
    await expect(page.getByLabel("Framing")).toHaveValue("custom");
    await expect(page.locator(".code-pre")).toContainText(`"rotX": ${custom!.rotX}`);
    await expect(page.locator(".code-pre")).toContainText(`"zoom": ${custom!.zoom}`);
    // The preview already shows that view: it keeps running instead of reloading.
    await page.waitForTimeout(600);
    expect(await iframe.getAttribute("srcdoc")).toBe(doc);

    await page.getByRole("button", { name: "Reset the start view" }).click();
    await expect(page.getByLabel("Framing")).toHaveValue("fit");
    expect((await exportState()).custom).toBeNull();
    await expect.poll(() => iframe.getAttribute("srcdoc")).toBe(doc);
  });
});
