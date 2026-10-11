import { describe, expect, test } from "vitest";
import { finishLine, planStroke, withStrokeLine } from "./sculpt";
import { findItem, type ObjectGroup, type ShapeLayer } from "../store/sceneStore";
import { group, scene, shape } from "../test/fixtures";

let n = 0;
const newId = () => `new-${++n}`;
const clay = { mode: "clay" as const, smooth: 0.03, symmetry: false };
const carve = { mode: "carve" as const, smooth: 0.02, symmetry: false };
const mat = { color: [0.9, 0.2, 0.1] as [number, number, number], roughness: 0.4, metalness: 0, emission: 0 };

describe("planStroke", () => {
  test("a shape becomes an object in its own frame; clay takes its material", () => {
    const ball = shape("sphere", { id: "ball", name: "Ball", position: [1, 2, 3], rotation: [0, 90, 0], op: "sUnion", material: mat });
    const root = scene([shape("box", { id: "other" }), ball]);
    const plan = planStroke(root, "ball", clay, root.id, newId)!;
    const g = plan.root.items[1] as ObjectGroup;
    expect(g.kind).toBe("group");
    expect(g.name).toBe("Ball");
    expect(g.position).toEqual([1, 2, 3]);
    expect(g.rotation).toEqual([0, 90, 0]);
    expect(g.op).toBe("sUnion");
    expect(g.items[0]).toMatchObject({ id: "ball", position: [0, 0, 0], rotation: [0, 0, 0], op: "union" });
    const stroke = g.items[1] as ShapeLayer;
    expect(stroke).toMatchObject({ shapeType: "stroke", op: "sUnion", smoothK: 0.03, name: "Ball · clay", material: mat });
    expect(plan.containerId).toBe(g.id);
    // World → the ball's frame: its center maps to the origin.
    expect(plan.toLocal([1, 2, 3]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0]);
  });

  test("same mode appends to the last layer; a new mode starts a layer; strokes resolve to their shape", () => {
    const root = scene([shape("sphere", { id: "ball" })]);
    let plan = planStroke(root, "ball", clay, root.id, newId)!;
    let r = withStrokeLine(plan.root, plan, [0, 0, 0.5, 0.05, 0.1, 0, 0.5, 0.05])!;
    const clayId = plan.layerId;
    // Painting again on the clay itself: same layer, old points kept.
    plan = planStroke(r, clayId, clay, r.id, newId)!;
    expect(plan.layerId).toBe(clayId);
    expect(plan.before).toHaveLength(8);
    r = withStrokeLine(plan.root, plan, [0, 0.2, 0.5, 0.05])!;
    const layer = findItem(r, clayId)!.item as ShapeLayer;
    expect(layer.stroke!.points).toHaveLength(16); // 2 + break + 1
    // Carve: a new layer after the clay, subtracting.
    plan = planStroke(r, "ball", carve, r.id, newId)!;
    expect(plan.layerId).not.toBe(clayId);
    const items = (r.items[0] as ObjectGroup).items.length;
    const after = (plan.root.items[0] as ObjectGroup).items;
    expect((after[after.length - 1] as ShapeLayer).op).toBe("sSubtract");
    expect((plan.root.items[0] as ObjectGroup).items).toHaveLength(items + 1);
  });

  test("symmetry lives on the layer as an X mirror; toggling it starts a new layer", () => {
    const root = scene([shape("sphere", { id: "ball" })]);
    const sym = planStroke(root, "ball", { ...clay, symmetry: true }, root.id, newId)!;
    const r = withStrokeLine(sym.root, sym, [0.2, 0, 0, 0.05])!;
    expect((findItem(r, sym.layerId)!.item as ShapeLayer).modifiers).toEqual([{ kind: "mirror", axes: [true, false, false] }]);
    expect(planStroke(r, "ball", clay, r.id, newId)!.layerId).not.toBe(sym.layerId);
  });

  test("an object made by sculpting is reused; carving air does nothing; clay in air goes to the container", () => {
    const g = group([shape("sphere", { id: "ball" })], { id: "g", position: [0, 1, 0], scale: [2, 2, 2] });
    const root = scene([g]);
    const plan = planStroke(root, "ball", clay, root.id, newId)!;
    expect(plan.containerId).toBe("g");
    expect(plan.localScale).toBeCloseTo(0.5, 9);
    expect(plan.toLocal([0, 1, 0])).toEqual([0, 0, 0]);
    expect(planStroke(root, null, carve, root.id, newId)).toBeNull();
    const free = planStroke(root, null, clay, root.id, newId)!;
    expect(free.containerId).toBe(root.id);
    expect((free.root.items[free.root.items.length - 1] as ShapeLayer).shapeType).toBe("stroke");
  });
});

describe("finishLine", () => {
  test("simplifies straight runs, tapers the ends, rounds", () => {
    const line: number[] = [];
    for (let i = 0; i <= 20; i++) line.push(i * 0.01, 0, 0, 0.05);
    const out = finishLine(line, 0.05);
    expect(out.length / 4).toBe(2);
    const curve: number[] = [];
    for (let i = 0; i <= 40; i++) curve.push(Math.cos(i / 6), Math.sin(i / 6), 0.123456789, 0.05);
    const c = finishLine(curve, 0.05);
    expect(c.length / 4).toBeGreaterThan(6);
    expect(c[3]).toBeLessThan(0.05);
    expect(c[2]).toBe(0.1235);
  });
});
