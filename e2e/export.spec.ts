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
    const out = generateSdfCode(kitchenSink(), null);
    const fn = out.fnName;

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter!.requestDevice();
    const wgsl = `${out.wgsl}
@fragment fn main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(${fn}(pos.xyz * 0.01));
}`;
    const module = device.createShaderModule({ code: wgsl });
    const info = await module.getCompilationInfo();
    const wgslErrors = info.messages.filter((m) => m.type === "error").map((m) => `${m.lineNum}: ${m.message}`);

    const gl = new OffscreenCanvas(4, 4).getContext("webgl2")!;
    const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(sh, `#version 300 es
precision highp float;
${out.glsl}
out vec4 o;
void main() { o = vec4(${fn}(gl_FragCoord.xyz * 0.01)); }`);
    gl.compileShader(sh);
    const glslLog = gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? "" : gl.getShaderInfoLog(sh);
    return { wgslErrors, glslLog };
  });
  expect(result.wgslErrors).toEqual([]);
  expect(result.glslLog).toBe("");
});
