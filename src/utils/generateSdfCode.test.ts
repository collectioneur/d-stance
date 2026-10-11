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

describe("generateSdfCode modifiers", () => {
  test("modifiers are emitted with helpers, in every language", () => {
    const root = scene([
      group([shape("sphere", { params: [0.48, 0, 0, 0] })], {
        modifiers: [{ kind: "repeat", spacing: [1, 1, 1], count: [3, 1, 1] }, { kind: "twist", amount: 2, axis: 1 }],
      }),
      shape("box", { op: "sUnion", modifiers: [{ kind: "round", radius: 0.05 }, { kind: "mirror", axes: [true, false, false] }] }),
    ]);
    const out = generateSdfCode(root, null);
    for (const code of [out.wgsl, out.glsl, out.typegpu]) {
      expect(code).toContain("opRepeatCell(");
      expect(code).toContain("opTwist(");
      expect(code).toMatch(/- 0\.05\)/);
    }
    expect(out.wgsl).toContain("fn opRepeat(");
    expect(out.glsl).toContain("vec3 opRepeat(");
    expect(out.typegpu).toContain("const opRepeat = tgpu.fn(");
    expect(out.wgsl).toMatch(/d0 = d0 \* 0\.\d+;/);
  });

  test("modifier output is stable", () => {
    const root = scene([
      group([shape("capsule")], { modifiers: [{ kind: "polar", count: 6, axis: 1 }, { kind: "elongate", size: [0.1, 0, 0] }] }),
      shape("torus", { op: "subtract", modifiers: [{ kind: "onion", thickness: 0.02 }, { kind: "bend", amount: 1, axis: 2 }] }),
    ]);
    const out = generateSdfCode(root, null);
    expect(out.wgsl).toMatchSnapshot("wgsl");
    expect(out.glsl).toMatchSnapshot("glsl");
  });
});

describe("generateSdfCode animation", () => {
  const spin = { target: "rotation.y" as const, wave: "linear" as const, amount: 360, period: 4, phase: 0 };

  test("still scenes keep the one-argument signature", () => {
    const out = generateSdfCode(scene([shape("sphere")], "Still"), null);
    expect(out.animated).toBe(false);
    expect(out.wgsl).toContain("fn sdStill(p: vec3f) -> f32");
    expect(out.wgsl).not.toContain("time");
  });

  test("animated numbers become expressions of time in every language", () => {
    const root = scene([shape("box", { animation: [spin] }), shape("sphere", { op: "sUnion", animation: [{ ...spin, target: "smoothK", wave: "sine", amount: 0.05 }] })], "Spin");
    const out = generateSdfCode(root, null);
    expect(out.animated).toBe(true);
    expect(out.wgsl).toContain("fn sdSpin(p: vec3f, time: f32) -> f32");
    expect(out.glsl).toContain("float sdSpin(vec3 p, float time)");
    expect(out.typegpu).toContain("const sdSpin = (p: d.v3f, time: number): number =>");
    // Each moving value is computed once, at the top.
    expect(out.wgsl).toContain("fn sdSpin(p: vec3f, time: f32) -> f32 {\n  let a0 = (360.0 * (time / 4.0));\n  let a1 = max((0.1 + 0.05 * sin(6.2831853 * time / 4.0)), 0.001);");
    expect(out.wgsl).toContain("applyInvRotXYZ(p, vec3f(0.0, (a0 * 0.0174532925), 0.0))");
    expect(out.wgsl).toContain("d0 = smin(d0, sdSphere(p, 0.5), a1);");
    expect(out.typegpu).toContain("std.sin(");
  });

  test("animated scale divides the point and the distance factor follows", () => {
    const pulse = { target: "scale" as const, wave: "sine" as const, amount: 0.2, period: 1, phase: 0 };
    const out = generateSdfCode(scene([shape("sphere", { animation: [pulse] })], "Pulse"), null);
    expect(out.wgsl).toContain("let a0 = max((1.0 * (1.0 + 0.2 * sin(6.2831853 * time / 1.0))), 0.01);");
    expect(out.wgsl).toContain("return sdSphere(p / vec3f(a0, a0, a0), 0.5) * a0;");
    expect(out.typegpu).toContain("const a0 = std.max(");
    expect(out.typegpu).toContain("p * d.vec3f((1.0 / a0), (1.0 / a0), (1.0 / a0))");
  });

  test("noise waves ship their helper; others do not", () => {
    const wobble = { ...spin, wave: "noise" as const, target: "position.x" as const, amount: 0.1 };
    expect(generateSdfCode(scene([shape("box", { animation: [wobble] })]), null).wgsl).toContain("fn animNoise(");
    expect(generateSdfCode(scene([shape("box", { animation: [spin] })]), null).wgsl).not.toContain("animNoise");
  });

  test("formulas reading t and flowing noise animate the export too", () => {
    const f = generateSdfCode(scene([shape("formula", { formula: "length(x, y, z) - 0.3 - 0.05 * sin(t)" })]), null);
    expect(f.animated).toBe(true);
    expect(f.wgsl).toContain("formula0(p, 0.5, 0.5, time)");
    const n = generateSdfCode(
      scene([shape("sphere", { modifiers: [{ kind: "noise", amplitude: 0.05, scale: 4, octaves: 3, seed: 0, speed: 0.5 }] })]),
      null,
    );
    expect(n.animated).toBe(true);
    expect(n.wgsl).toContain("vec3f(0.0, time * 0.5, 0.0)");
  });

  test("switched-off tracks export a still scene", () => {
    const out = generateSdfCode(scene([shape("box", { animation: [{ ...spin, off: true }] })]), null);
    expect(out.animated).toBe(false);
  });

  test("glow animation reaches the material function", () => {
    const mat = { color: [1, 0.5, 0] as [number, number, number], roughness: 0.4, metalness: 0, emission: 1 };
    const glow = { ...spin, target: "emission" as const, wave: "sine" as const, amount: 1, period: 2 };
    const out = generateMaterialCode(scene([shape("sphere", { material: mat, animation: [glow] })], "Lamp"));
    expect(out.wgsl).toContain("fn sdLampMaterial(p: vec3f, time: f32) -> SdfMaterial");
    expect(out.wgsl).toContain("max((1.0 + 1.0 * sin(6.2831853 * time / 2.0)), 0.0)");
  });
});

describe("generateSdfCode interaction", () => {
  const hover = { trigger: "hover" as const, target: "scale" as const, amount: 0.2 };
  const root = () =>
    scene(
      [
        group([shape("box", { id: "b", interaction: [{ trigger: "click", target: "rotation.z", amount: 45 }] })], { id: "g", interaction: [hover] }),
        shape("sphere", { id: "s", op: "sUnion", interaction: [{ trigger: "pointerY", target: "position.y", amount: 0.1 }] }),
      ],
      "Ix",
    );

  test("without the option reactions sit at rest (code tab)", () => {
    const out = generateSdfCode(root(), null);
    expect(out.wgsl).not.toMatch(/ix\[|pointer/);
    expect(generateMaterialCode(root()).wgsl).not.toContain("id:");
  });

  test("embed code reads per-item states and the pointer; materials carry the owner id", async () => {
    const { interactiveSlots } = await import("../store/interaction");
    const ix = interactiveSlots(root().items);
    const out = generateSdfCode(root(), null, { interactive: ix });
    expect(out.wgsl).toContain("let a0 = max((1.0 * (1.0 + 0.2 * ix[0].x)), 0.01);");
    expect(out.wgsl).toContain("(45.0 * ix[1].y)");
    expect(out.wgsl).toContain("(0.1 * view.pointer.y)");
    expect(out.glsl).toContain("uIx[0].x");
    expect(out.glsl).toContain("uPointer.y");
    const mat = generateMaterialCode(root(), { interactive: ix });
    expect(mat.wgsl).toContain("id: f32,");
    expect(mat.wgsl).toContain("select(a.id, b.id, t > 0.5)");
    // Box: own slot 1 → id 2; sphere: no item trigger, no interactive parent → 0.
    expect(mat.wgsl).toMatch(/SdfMaterial\(vec3f\(0\.72, 0\.72, 0\.72\), 0\.5, 0\.0, 0\.0, 2\.0\)/);
    expect(mat.wgsl).toMatch(/SdfMaterial\(vec3f\(0\.72, 0\.72, 0\.72\), 0\.5, 0\.0, 0\.0, 0\.0\)/);
    expect(mat.glsl).toContain("t > 0.5 ? b.id : a.id");
  });
});
