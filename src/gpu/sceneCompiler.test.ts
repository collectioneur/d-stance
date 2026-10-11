import { describe, expect, test } from "vitest";
import { compileScene, countDataSlots, DATA_SLOTS } from "./sceneCompiler";
import { group, kitchenSink, scene, shape } from "../test/fixtures";
import type { SceneRoot } from "../store/sceneStore";

const OPTS = { imageLayer: () => 3 };
const compile = (root: SceneRoot) => compileScene(root, OPTS);

describe("scene compiler", () => {
  test("empty scene is infinitely far", () => {
    const out = compile(scene([]));
    expect(out.code).toContain("return 1e10;");
    expect(out.leafIds).toEqual([]);
    expect(out.slotCount).toBe(0);
  });

  test("same structure → same code; values carry the numbers", () => {
    const a = compile(scene([shape("box", { id: "x", position: [1, 2, 3] })]));
    const b = compile(scene([shape("box", { id: "y", position: [-4, 0, 9], params: [1, 2, 3, 0] })]));
    expect(a.code).toBe(b.code);
    expect(Array.from(a.values)).not.toEqual(Array.from(b.values));
  });

  test("structure changes change the code", () => {
    const base = compile(scene([shape("box"), shape("sphere")])).code;
    expect(compile(scene([shape("box"), shape("torus")])).code).not.toBe(base);
    expect(compile(scene([shape("box"), shape("sphere", { op: "subtract" })])).code).not.toBe(base);
    expect(compile(scene([group([shape("box")]), shape("sphere")])).code).not.toBe(base);
  });

  test("values follow the baked transform", () => {
    const out = compile(scene([shape("sphere", { position: [1, 2, 3], params: [0.7, 0, 0, 0] })]));
    const v = out.values;
    // rows (identity) with offset −position in w
    expect(Array.from(v.slice(0, 12))).toEqual([1, 0, 0, -1, 0, 1, 0, -2, 0, 0, 1, -3]);
    expect(v[12]).toBeCloseTo(0.7); // params.x
    expect(v[16]).toBe(1); // factor
    expect(Array.from(v.slice(20, 23))).toEqual([1, 2, 3]); // bound center
    expect(v[23]).toBeCloseTo(0.7 + 1e-3); // bound radius
  });

  test("leaf ids and marks cover the tree in order", () => {
    const root = kitchenSink();
    const out = compile(root);
    const layers: string[] = [];
    const all: string[] = [];
    const walk = (items: SceneRoot["items"]) =>
      items.forEach((i) => {
        all.push(i.id);
        if (i.kind === "layer") layers.push(i.id);
        else walk(i.items);
      });
    walk(root.items);
    expect(out.leafIds).toEqual(layers);
    expect([...out.markIndex.keys()].sort()).toEqual([...all].sort());
  });

  test("helpers are namespaced so they cannot collide with TypeGPU names", () => {
    const code = compile(kitchenSink()).code;
    expect(code).not.toMatch(/(?<!ds_)\bsd[A-Z]\w*\(/);
    expect(code).toContain("fn ds_sdSphere(");
    expect(code).toContain("fn ds_sdScene(p: vec3f) -> f32");
    expect(code).toContain("fn ds_sceneInfo(p: vec3f) -> DsInfo");
  });

  test("image layers sample their texture layer", () => {
    const out = compile(kitchenSink());
    const imageIdx = out.leafIds.indexOf("im");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(out.code).toContain("ds_sdImage(");
    // layer index from the callback lands in the image extra slot (.z)
    const found = [...out.values].some((x, i) => i % 4 === 2 && x === 3);
    expect(found).toBe(true);
  });

  test("union siblings are gated by their bounds; subtract never is", () => {
    const code = compile(
      scene([shape("box"), shape("sphere"), shape("torus", { op: "subtract" })]),
    ).code;
    const sdf = code.slice(code.indexOf("fn ds_sdScene"), code.indexOf("fn ds_sceneInfo"));
    expect(sdf.match(/if \(ds_bound\(p, \d+u\) < a0\)/g)).toHaveLength(1);
    expect(sdf).toMatch(/a0 = max\(a0, -v\d+\);/);
  });

  test("smooth union gates include k", () => {
    const code = compile(scene([shape("box"), shape("sphere", { op: "sUnion" })])).code;
    expect(code).toMatch(/< a0 \+ dsData\[\d+\]\.y\)/);
  });

  test("long union runs are chunked and chunk bounds enclose members", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      shape("sphere", { position: [i * 0.5, 0, 0], params: [0.2, 0, 0, 0] }),
    );
    const out = compile(scene(items));
    const sdf = out.code.slice(out.code.indexOf("fn ds_sdScene"), out.code.indexOf("fn ds_sceneInfo"));
    // 19 gated members + 3 chunk gates (8 + 8 + 3)
    expect(sdf.match(/if \(ds_bound/g)!.length).toBe(19 + 3);
    expect(countDataSlots(scene(items).items)).toBe(out.slotCount);
  });

  test("group bounds enclose children and smooth bulge", () => {
    const root = scene([
      group([
        shape("sphere", { position: [1, 0, 0], params: [0.5, 0, 0, 0] }),
        shape("sphere", { position: [-1, 0, 0], params: [0.5, 0, 0, 0], op: "sUnion", smoothK: 0.4 }),
      ]),
    ]);
    const out = compile(root);
    // group slots come first: misc, bound
    const r = out.values[7];
    expect(r).toBeGreaterThanOrEqual(1.5 + 0.1);
  });

  test("the head of a hard-union scene may stand in its sphere far away", () => {
    const code = compile(scene([shape("box"), shape("sphere")])).code;
    expect(code).toMatch(/var v\d+ = ds_bound\(p, 5u\);\n\s+if \(v\d+ <= 0\.15\)/);
    const notUnion = compile(scene([shape("box"), shape("sphere", { op: "subtract" })])).code;
    expect(notUnion).not.toMatch(/<= 0\.15/);
  });

  test("slot budget fits the uniform binding for a capped scene", () => {
    const items = Array.from({ length: 128 }, () => shape("image", { image: { sdf: "x" } }));
    expect(countDataSlots(items)).toBeLessThan(DATA_SLOTS);
  });
});

describe("scene compiler materials", () => {
  const red = { color: [1, 0, 0] as [number, number, number], roughness: 0.2, metalness: 0.7, emission: 1.5 };
  const blue = { color: [0, 0, 1] as [number, number, number], roughness: 0.4, metalness: 0, emission: 0 };

  test("leaf material slots carry color, roughness, metalness, emission", () => {
    const out = compile(scene([shape("sphere", { material: red })]));
    expect(Array.from(out.values.slice(24, 32))).toEqual([1, 0, 0, 0.2, 0.7, 1.5, 0, 0].map((v) => Math.fround(v)));
  });

  test("default material when none is set", () => {
    const out = compile(scene([shape("sphere")]));
    expect(out.values[24]).toBeCloseTo(0.72);
    expect(out.values[27]).toBeCloseTo(0.5);
  });

  test("group materials are inherited; own materials win", () => {
    const out = compile(scene([group([shape("sphere"), shape("box", { material: red })], { material: blue })]));
    // group slots 0-1, first leaf at 2 (material at +6), second leaf at 10
    expect(Array.from(out.values.slice((2 + 6) * 4, (2 + 6) * 4 + 3))).toEqual([0, 0, 1]);
    expect(Array.from(out.values.slice((10 + 6) * 4, (10 + 6) * 4 + 3))).toEqual([1, 0, 0]);
  });

  test("material changes never change the code", () => {
    const a = compile(scene([shape("sphere", { material: red })])).code;
    const b = compile(scene([shape("sphere", { material: blue })])).code;
    const c = compile(scene([shape("sphere")])).code;
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("info pass blends materials per op", () => {
    const code = compile(
      scene([
        shape("box"),
        shape("sphere", { op: "sUnion" }),
        shape("sphere", { op: "subtract" }),
        shape("sphere", { op: "intersect" }),
      ]),
    ).code;
    const info = code.slice(code.indexOf("fn ds_sceneInfo"));
    expect(info).toMatch(/ds_mixMat\(m\d+, w\d+, ds_sminT\(a\d+, v\d+, /);
    expect(info).toMatch(/if \(v\d+ > a\d+\) \{ m\d+ = w\d+; \}/);
    expect(info).toContain("return DsInfo(info.x, info.y, mat.c.xyz, mat.c.w, mat.e.x, mat.e.y);");
  });
});

describe("scene compiler modifiers", () => {
  const rep = (count: [number, number, number], spacing = 1) => ({
    kind: "repeat" as const,
    spacing: [spacing, spacing, spacing] as [number, number, number],
    count,
  });

  test("a group with point modifiers evaluates its children in its own frame", () => {
    const code = compile(scene([group([shape("sphere", { params: [0.2, 0, 0, 0] })], { modifiers: [rep([3, 1, 1])] })])).code;
    const sdf = code.slice(code.indexOf("fn ds_sdScene"), code.indexOf("fn ds_sceneInfo"));
    expect(sdf).toMatch(/let q\d+ = ds_xf\(p, \d+u\);/);
    expect(sdf).toMatch(/let q\d+ = ds_opRepeat\(q\d+, /);
    expect(sdf).toMatch(/ds_sdSphere\(ds_xf\(q\d+, \d+u\)/);
  });

  test("copies that overlap their cell loop over neighbor cells", () => {
    const tight = compile(scene([group([shape("sphere", { params: [0.48, 0, 0, 0] })], { modifiers: [rep([3, 1, 3])] })])).code;
    const body = (code: string) => code.slice(code.indexOf("fn ds_sdScene"));
    expect(body(tight)).toContain("< 4u; n");
    expect(body(tight)).toContain("ds_opRepeatCell(");
    const loose = compile(scene([group([shape("sphere", { params: [0.2, 0, 0, 0] })], { modifiers: [rep([3, 1, 3])] })])).code;
    expect(body(loose)).not.toContain("ds_opRepeatCell(");
  });

  test("twist and bend scale the result by 1 / Lipschitz", () => {
    const out = compile(scene([shape("box", { modifiers: [{ kind: "twist", amount: 3, axis: 1 }] })]));
    const factor = out.values[16];
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1);
  });

  test("infinite repetition is unbounded and the march radius is capped", () => {
    const out = compile(scene([group([shape("sphere")], { modifiers: [rep([0, 1, 0])] })]));
    expect(out.boundsRadius).toBeLessThanOrEqual(100);
    expect(out.boundsRadius).toBeGreaterThan(50);
  });

  test("bounds grow with limited repetition", () => {
    const plain = compile(scene([group([shape("sphere", { params: [0.2, 0, 0, 0] })])])).boundsRadius;
    const repeated = compile(scene([group([shape("sphere", { params: [0.2, 0, 0, 0] })], { modifiers: [rep([5, 1, 1])] })])).boundsRadius;
    expect(repeated).toBeGreaterThan(plain + 1.9);
  });

  test("a scaled group with modifiers keeps its children inside its bounds", () => {
    const out = compile(
      scene([group([shape("sphere", { position: [0.5, 0, 0], params: [0.3, 0, 0, 0] })], { scale: [3, 3, 3], modifiers: [{ kind: "mirror", axes: [true, false, false] }] })]),
    );
    // group bound slot: radius must cover the mirrored sphere: (0.5 + 0.3) * 3
    expect(out.values[7]).toBeGreaterThanOrEqual(2.4);
  });

  test("distance modifiers rewrite the result; switched-off ones vanish", () => {
    const code = compile(scene([shape("sphere", { modifiers: [{ kind: "onion", thickness: 0.05 }] })])).code;
    expect(code).toMatch(/\(abs\(ds_sdSphere\(q\d+, dsData\[\d+\]\.x\)\) - dsData\[\d+\]\.x\)/);
    const off = compile(scene([shape("sphere", { modifiers: [{ kind: "onion", thickness: 0.05, off: true }] })])).code;
    expect(off).toBe(compile(scene([shape("sphere")])).code);
  });

  test("modifier amounts are values, not code", () => {
    const a = compile(scene([group([shape("sphere", { params: [0.1, 0, 0, 0] })], { modifiers: [rep([3, 1, 1], 1)] })])).code;
    const b = compile(scene([group([shape("sphere", { params: [0.1, 0, 0, 0] })], { modifiers: [rep([5, 1, 1], 2)] })])).code;
    expect(a).toBe(b);
  });
});

describe("scene compiler formulas", () => {
  test("formula shapes compile to one function per distinct source", () => {
    const out = compile(
      scene([
        shape("formula", { formula: "length(x, y, z) - 0.2" }),
        shape("formula", { formula: "length(x, y, z) - 0.2" }),
        shape("formula", { formula: "smin(x, y, 0.1) + fbm(x, y, z)" }),
      ]),
    );
    expect(out.code.match(/fn ds_formula\d+\(/g)).toHaveLength(2);
    expect(out.code).toContain("ds_smin(x, y, 0.1)");
    expect(out.code).toContain("ds_fbm3(vec3f(x, y, z), 4.0)");
  });

  test("editing a formula changes the code; size and safety do not", () => {
    const a = compile(scene([shape("formula", { formula: "length(x, y, z) - 0.2", params: [0.5, 0.5, 0, 0] })])).code;
    const b = compile(scene([shape("formula", { formula: "length(x, y, z) - 0.3", params: [0.5, 0.5, 0, 0] })])).code;
    const c = compile(scene([shape("formula", { formula: "length(x, y, z) - 0.2", params: [0.9, 0.2, 0, 0] })])).code;
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });
});
