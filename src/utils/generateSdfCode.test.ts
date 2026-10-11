import { describe, expect, test } from "vitest";
import { generateMaterialCode, generateSdfCode, PLACEHOLDER } from "./generateSdfCode";
import { group, kitchenSink, scene, shape } from "../test/fixtures";

describe("generateSdfCode", () => {
  test("empty scene exports the placeholder", () => {
    const out = generateSdfCode(scene([]), null);
    expect(out.wgsl).toBe(PLACEHOLDER);
    expect(out.glsl).toBe(PLACEHOLDER);
    expect(out.typegpu).toBe(PLACEHOLDER);
  });

  test("single shape returns its expression directly", () => {
    const out = generateSdfCode(scene([shape("sphere", { name: "Ball" })], "My Scene"), null);
    expect(out.fnName).toBe("sdMyScene");
    expect(out.wgsl).toContain("fn sdMyScene(p: vec3f) -> f32 {\n  return sdSphere(p, 0.5);\n}");
    expect(out.glsl).toContain("float sdMyScene(vec3 p) {\n  return sdSphere(p, 0.5);\n}");
  });

  test("selected node exports at the origin", () => {
    const root = scene([shape("box", { id: "a", name: "Crate", position: [3, 4, 5] })]);
    const out = generateSdfCode(root, "a");
    expect(out.fnName).toBe("sdCrate");
    expect(out.wgsl).not.toContain("vec3f(3.0, 4.0, 5.0)");
  });

  test("only used helpers are emitted", () => {
    const out = generateSdfCode(scene([shape("sphere"), shape("box", { op: "sUnion" })]), null);
    expect(out.wgsl).toContain("fn sdSphere");
    expect(out.wgsl).toContain("fn sdBox");
    expect(out.wgsl).toContain("fn smin");
    expect(out.wgsl).not.toContain("fn sdTorus");
    expect(out.wgsl).not.toContain("applyInvRotXYZ");
  });

  test("names never collide with helpers", () => {
    const out = generateSdfCode(scene([shape("sphere")], "Sphere"), null);
    expect(out.fnName).toBe("sdSphereModel");
  });

  test("kitchen sink output is stable", () => {
    const out = generateSdfCode(kitchenSink(), null);
    expect(out.wgsl).toMatchSnapshot("wgsl");
    expect(out.glsl).toMatchSnapshot("glsl");
    expect(out.typegpu).toMatchSnapshot("typegpu");
  });

  test("nested group transforms are emitted in order", () => {
    const root = scene([
      group([group([shape("sphere")], { position: [0, 1, 0] })], { rotation: [0, 90, 0] }),
    ]);
    const wgsl = generateSdfCode(root, null).wgsl;
    const rot = wgsl.indexOf("applyInvRotXYZ(p,");
    const pos = wgsl.indexOf("- vec3f(0.0, 1.0, 0.0)");
    expect(rot).toBeGreaterThan(-1);
    expect(pos).toBeGreaterThan(rot);
  });
});

describe("generateMaterialCode", () => {
  test("default material when nothing is set", () => {
    const out = generateMaterialCode(scene([shape("sphere")], "Plain"));
    expect(out.fnName).toBe("sdPlainMaterial");
    expect(out.wgsl).toContain("var m0 = SdfMaterial(vec3f(0.72, 0.72, 0.72), 0.5, 0.0, 0.0);");
    expect(out.wgsl).toContain("return m0;");
  });

  test("each op carries materials like the viewport", () => {
    const m = (r: number) => ({ color: [r, 0, 0] as [number, number, number], roughness: 0.5, metalness: 0, emission: 0 });
    const root = scene([
      shape("box", { material: m(0.1) }),
      shape("sphere", { op: "union", material: m(0.2) }),
      shape("sphere", { op: "subtract", material: m(0.3) }),
      shape("sphere", { op: "intersect", material: m(0.4) }),
      shape("sphere", { op: "sUnion", material: m(0.5) }),
      shape("sphere", { op: "sIntersect", material: m(0.6) }),
    ]);
    const wgsl = generateMaterialCode(root).wgsl;
    expect(wgsl).toContain("if (t < d0) { m0 = tm; }");
    expect(wgsl).toContain("if (t > d0) { m0 = tm; }");
    expect(wgsl).toContain("m0 = mixMaterial(m0, tm, sminWeight(d0, t, 0.1));");
    expect(wgsl).toContain("m0 = mixMaterial(m0, tm, sminWeight(-d0, -t, 0.1));");
    // subtract: the cut keeps the body's material
    const subLine = wgsl.split("\n").find((l) => l.includes("vec3f(0.3, 0.0, 0.0)"))!;
    expect(subLine).not.toContain("m0 = tm");
  });

  test("group materials apply to children without their own", () => {
    const blue = { color: [0, 0, 1] as [number, number, number], roughness: 0.5, metalness: 0, emission: 0 };
    const own = { color: [0, 1, 0] as [number, number, number], roughness: 0.5, metalness: 0, emission: 0 };
    const out = generateMaterialCode(scene([group([shape("sphere"), shape("box", { material: own })], { material: blue })]));
    expect(out.wgsl).toContain("vec3f(0.0, 0.0, 1.0)");
    expect(out.wgsl).toContain("vec3f(0.0, 1.0, 0.0)");
    expect(out.glsl).toContain("SdfMaterial m0 = SdfMaterial(vec3(0.0, 0.0, 1.0)");
  });
});
