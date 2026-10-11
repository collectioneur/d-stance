import { describe, expect, test } from "vitest";
import { generateSdfCode, PLACEHOLDER } from "./generateSdfCode";
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
