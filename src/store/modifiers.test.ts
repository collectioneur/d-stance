import { describe, expect, test } from "vitest";
import { MAX_MODIFIERS, activeModifiers, createModifier, sanitizeModifier, sanitizeModifiers } from "./modifiers";

describe("modifiers", () => {
  test("every kind has a default that survives sanitizing", () => {
    for (const kind of ["repeat", "mirror", "polar", "twist", "bend", "elongate", "round", "onion"] as const) {
      const m = createModifier(kind, 0.4);
      expect(sanitizeModifier(m)).toEqual(m);
    }
  });

  test("new repeats space copies apart by the item's size", () => {
    const m = createModifier("repeat", 0.4);
    expect(m.kind === "repeat" && m.spacing[0]).toBe(1);
  });

  test("hostile values are clamped or dropped", () => {
    expect(sanitizeModifier({ kind: "repeat", spacing: [0, -5, "x"], count: [1e9, -3, 2.6] })).toEqual({
      kind: "repeat",
      spacing: [0.01, 0.01, 1],
      count: [64, 0, 3],
    });
    expect(sanitizeModifier({ kind: "polar", count: 0, axis: 7, radius: -3 })).toEqual({ kind: "polar", count: 1, axis: 1, radius: 0 });
    expect(sanitizeModifier({ kind: "twist", amount: Infinity, axis: 2 })).toEqual({ kind: "twist", amount: 2, axis: 2 });
    expect(sanitizeModifier({ kind: "onion", thickness: 0 })).toEqual({ kind: "onion", thickness: 0.001 });
    expect(sanitizeModifier({ kind: "evil" })).toBeUndefined();
    expect(sanitizeModifier("repeat")).toBeUndefined();
    expect(sanitizeModifier({ kind: "mirror", axes: [1, true, "yes"], offset: [1e9, "x", -2], off: "true" })).toEqual({
      kind: "mirror",
      axes: [false, true, false],
      offset: [100, 0, 0],
    });
  });

  test("polar repeats saved before the radius existed turn the item about its axis", () => {
    expect(sanitizeModifier({ kind: "polar", count: 6, axis: 1 })).toEqual({ kind: "polar", count: 6, axis: 1, radius: 0 });
  });

  test("a new polar repeat puts six copies just apart", () => {
    const m = createModifier("polar", 0.4);
    expect(m.kind === "polar" && m.radius).toBe(0.8);
  });

  test("mirrors saved before the distance existed reflect across the origin", () => {
    expect(sanitizeModifier({ kind: "mirror", axes: [true, false, false] })).toEqual({ kind: "mirror", axes: [true, false, false], offset: [0, 0, 0] });
  });

  test("a new mirror puts the item and its reflection just apart", () => {
    const m = createModifier("mirror", 0.4);
    expect(m.kind === "mirror" && m.offset[0]).toBe(0.4);
  });

  test("lists are capped and empty lists vanish", () => {
    const many = Array.from({ length: 20 }, () => ({ kind: "round", radius: 0.1 }));
    expect(sanitizeModifiers(many)).toHaveLength(MAX_MODIFIERS);
    expect(sanitizeModifiers([{ kind: "nope" }])).toBeUndefined();
    expect(sanitizeModifiers("x")).toBeUndefined();
  });

  test("switched-off modifiers do not take part", () => {
    expect(activeModifiers([{ kind: "round", radius: 1, off: true }, { kind: "onion", thickness: 0.1 }])).toEqual([
      { kind: "onion", thickness: 0.1 },
    ]);
  });
});
