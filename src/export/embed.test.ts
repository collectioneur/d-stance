import { describe, expect, test } from "vitest";
import { exportFileName, generateEmbed, type EmbedOptions } from "./embed";
import { FAKE_IMAGE_SDF, group, scene, shape } from "../test/fixtures";

const OPTS: EmbedOptions = {
  style: "classic",
  background: "studio",
  motion: "still",
  quality: "balanced",
  framing: "editor",
  view: { rotX: 0.3, rotY: 0.4, distance: 2.5 },
};

describe("embed export", () => {
  test("HTML snippet wires a canvas to the inlined runtime", () => {
    const out = generateEmbed(scene([shape("sphere")], "Hello"), OPTS);
    const id = out.html.match(/<canvas id="([^"]+)"/)![1];
    expect(id).toMatch(/^dstance-hello-[a-z0-9]+$/);
    expect(out.html).toContain(`mount(document.getElementById("${id}"), scene,`);
    expect(out.html).toContain("function mount(canvas, scene, options = {})");
    expect(out.html).not.toMatch(/^export function mount/m);
    expect(out.module).toMatch(/^export function mount/m);
    expect(out.module).toContain("export default function mountScene(canvas, options = {})");
  });

  test("scene names cannot break out of the script tag", () => {
    const out = generateEmbed(scene([shape("sphere")], "</script><img src=x onerror=alert(1)>"), OPTS);
    const script = out.html.slice(out.html.indexOf("<script"), out.html.lastIndexOf("</script>"));
    expect(script).not.toContain("</script>");
    expect(out.document).toContain("<title>&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</title>");
  });

  test("the render shader calls the generated scene function", () => {
    const out = generateEmbed(scene([shape("box")], "Crate"), OPTS);
    expect(out.scene.wgsl).toContain("fn sdCrate(p: vec3f) -> f32");
    expect(out.scene.wgsl).toContain("return sdCrate(p);");
    expect(out.scene.glsl).toContain("float sdCrate(vec3 p)");
    expect(out.scene.glsl).toMatch(/^#version 300 es/);
  });

  test("empty scenes still produce a valid program", () => {
    const out = generateEmbed(scene([], "Empty"), OPTS);
    expect(out.scene.wgsl).toContain("fn sdEmpty(p: vec3f) -> f32 {\n  return 1e10;\n}");
    expect(out.shadertoy).toContain("float sdEmpty(vec3 p) {\n  return 1e10;\n}");
  });

  test("images ship once, as data, not duplicated in shader comments", () => {
    const img = shape("image", { image: { sdf: FAKE_IMAGE_SDF } });
    const out = generateEmbed(scene([img, shape("image", { image: { sdf: FAKE_IMAGE_SDF } })]), OPTS);
    expect(out.scene.images).toEqual([FAKE_IMAGE_SDF]);
    expect(out.scene.wgsl).not.toContain(FAKE_IMAGE_SDF);
    expect(out.scene.glsl).not.toContain(FAKE_IMAGE_SDF);
  });

  test("Shadertoy drops image layers and says so", () => {
    const out = generateEmbed(
      scene([shape("sphere"), group([shape("image", { image: { sdf: FAKE_IMAGE_SDF } })])]),
      OPTS,
    );
    expect(out.shadertoyDropped).toBe(1);
    expect(out.shadertoy).toMatch(/^\/\/ 1 image layer was left out/);
    expect(out.shadertoy).not.toContain("imageTex");
    expect(out.shadertoy).toContain("void mainImage(out vec4 fragColor, in vec2 fragCoord)");
  });

  test("fit framing orbits the scene center at a framing distance", () => {
    const out = generateEmbed(scene([shape("sphere", { position: [2, 0, 0], params: [0.5, 0, 0, 0] })]), {
      ...OPTS,
      framing: "fit",
    });
    expect(out.scene.view.target).toEqual([2, 0, 0]);
    expect(out.scene.view.fit).toBeCloseTo(0.5);
    expect(out.scene.view.distance).toBeCloseTo((0.5 * 1.1) / Math.SQRT1_2, 4);
  });

  test("options become shader constants", () => {
    const chrome = generateEmbed(scene([shape("sphere")]), { ...OPTS, style: "chrome", background: "transparent", quality: "best" });
    expect(chrome.scene.wgsl).toContain("const STYLE = 1;");
    expect(chrome.scene.wgsl).toContain("const TRANSPARENT = true;");
    expect(chrome.scene.wgsl).toContain("const MAX_STEPS = 96;");
    expect(chrome.mountOptions.maxDpr).toBe(3);
    const spin = generateEmbed(scene([shape("sphere")]), { ...OPTS, motion: "spin" });
    expect(spin.mountOptions.autoRotate).toBeGreaterThan(0);
  });

  test("materials reach the renderer, inherited from groups", () => {
    const red = { color: [1, 0, 0] as [number, number, number], roughness: 0.3, metalness: 0, emission: 0 };
    const out = generateEmbed(
      scene([group([shape("sphere"), shape("box", { op: "sUnion" })], { material: red })], "Mats"),
      { ...OPTS, style: "studio" },
    );
    expect(out.scene.wgsl).toContain("fn sdMatsMaterial(p: vec3f) -> SdfMaterial");
    expect(out.scene.wgsl).toContain("SdfMaterial(vec3f(1.0, 0.0, 0.0), 0.3, 0.0, 0.0)");
    expect(out.scene.wgsl).toContain("mixMaterial(");
    expect(out.scene.glsl).toContain("SdfMaterial sdMatsMaterial(vec3 p)");
    expect(out.scene.wgsl).toContain("let m = sdMatsMaterial(p);");
  });

  test("studio floor sits under the lowest shape", () => {
    const out = generateEmbed(scene([shape("sphere", { position: [0, -1, 0], params: [0.5, 0, 0, 0] })]), {
      ...OPTS,
      style: "studio",
    });
    expect(out.scene.wgsl).toContain("const FLOOR_Y = -0.5;");
  });

  test("file names are slugs", () => {
    expect(exportFileName(scene([], "My Cool Scene!"), "html")).toBe("my-cool-scene.html");
    expect(exportFileName(scene([], "!!!"), "module")).toBe("scene.js");
  });
});

describe("embed animation", () => {
  const orbit = [
    { target: "position.x" as const, wave: "sine" as const, amount: 1, period: 4, phase: 0 },
    { target: "position.y" as const, wave: "sine" as const, amount: 0.5, period: 4, phase: 0.25 },
  ];

  test("still scenes carry no clock", () => {
    const out = generateEmbed(scene([shape("sphere")], "Still"), OPTS);
    expect(out.scene.loop).toBeUndefined();
    expect(out.shadertoy).toContain("uTime = iTime;");
  });

  test("animated scenes pass the looped clock to the scene functions", () => {
    const out = generateEmbed(scene([shape("sphere", { animation: orbit })], "Orbit"), { ...OPTS, loop: 6 });
    expect(out.scene.loop).toBe(6);
    expect(out.scene.wgsl).toContain("return sdOrbit(p, view.time);");
    expect(out.scene.wgsl).toContain("sdOrbitMaterial(p, view.time)");
    expect(out.scene.glsl).toContain("return sdOrbit(p, uTime);");
    expect(out.shadertoy).toContain("uTime = mod(iTime, 6.0);");
    expect(out.html).toContain('"loop": 6');
  });

  test("bounds, floor and framing cover every pose of the loop", () => {
    const rest = generateEmbed(scene([shape("sphere")]), { ...OPTS, style: "studio", framing: "fit" });
    const moving = generateEmbed(scene([shape("sphere", { animation: orbit })]), { ...OPTS, style: "studio", framing: "fit" });
    const bound = (wgsl: string) => Number(wgsl.match(/const BOUNDS = ([\d.]+);/)![1]);
    const floor = (wgsl: string) => Number(wgsl.match(/const FLOOR_Y = (-?[\d.]+);/)![1]);
    expect(bound(rest.scene.wgsl)).toBeCloseTo(0.55, 5);
    // Farthest pose: 1 off center (x and y swing out of phase), plus the 0.5 radius and 0.05 slack.
    expect(bound(moving.scene.wgsl)).toBeGreaterThanOrEqual(1.55);
    expect(floor(moving.scene.wgsl)).toBeGreaterThanOrEqual(1);
    expect(moving.scene.view.fit!).toBeGreaterThanOrEqual(1.5);
  });
});
