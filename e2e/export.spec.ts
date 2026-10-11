import { expect, test } from "@playwright/test";
import { openEditor } from "./helpers";

/**
 * Exported code must compile in real drivers, not just look right: WGSL goes
 * through the browser's WebGPU compiler, GLSL through WebGL2.
 */
test("exported WGSL and GLSL compile for every shape and op", async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    const { generateSdfCode } = await import("/src/utils/generateSdfCode.ts");
    const { kitchenSink } = await import("/src/test/fixtures.ts");
    const { modifiersScene, infiniteScene, animationScene, sculptScene } = await import("/e2e/scenes.ts");
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const wgslErrors: string[] = [];
    const glslErrors: string[] = [];
    for (const root of [kitchenSink(), modifiersScene(), infiniteScene(), animationScene(), sculptScene()]) {
    const out = generateSdfCode(root as never, null);
    const fn = out.fnName;
    const t = out.animated ? ", 1.25" : "";

    const wgsl = `${out.wgsl}
@fragment fn main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(${fn}(pos.xyz * 0.01${t}));
}`;
    const module = device.createShaderModule({ code: wgsl });
    const info = await module.getCompilationInfo();
    wgslErrors.push(...info.messages.filter((m) => m.type === "error").map((m) => `${root.name} ${m.lineNum}: ${m.message}`));

    const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
    const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(sh, `#version 300 es
precision highp float;
${out.glsl}
out vec4 o;
void main() { o = vec4(${fn}(gl_FragCoord.xyz * 0.01${t})); }`);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) glslErrors.push(`${root.name}: ${gl.getShaderInfoLog(sh)}`);
    }
    return { wgslErrors, glslLog: glslErrors.join("\n") };
  });
  expect(result.wgslErrors).toEqual([]);
  expect(result.glslLog).toBe("");
});
