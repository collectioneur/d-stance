import { describe, expect, test } from "vitest";
import { expandThrough, planPointModifiers, polarGap, polarReach, repeatGap, scatterCopy, scatterSphere } from "./modifierMath";

const polar = (count: number, axis: 0 | 1 | 2 = 1, radius = 0) => ({ kind: "polar" as const, count, axis, radius });

describe("polar repeat reach", () => {
  test("spokes within a sector and a half of their own need only the nearest three copies", () => {
    expect(polarReach(polar(6), [1, 0, 0], 0.2)).toBe("near");
    expect(polarReach(polar(16), [1, 0, 0], 0.2)).toBe("near");
  });

  test("geometry reaching farther around the axis needs every copy", () => {
    // The cone that grew spikes, with more copies: a shape on its own polar axis.
    expect(polarReach(polar(5, 2), [0, 0, 0], 0.7)).toBe("all");
    expect(polarReach(polar(64), [1, 0, 0], 0.2)).toBe("all");
    expect(polarReach(polar(8), [1, 0, 0], 0.95)).toBe("all");
  });

  test("three copies or fewer are always the nearest three", () => {
    expect(polarReach(polar(3, 2), [0, 0, 0], 0.7)).toBe("near");
    expect(polarReach(polar(1), [0, 0, 0], 1)).toBe("near");
  });

  test("the angle is measured in the polar's own plane", () => {
    // Axis x: the plane is (y, z); an offset along x keeps the spoke on the axis.
    expect(polarReach(polar(6, 0), [5, 0, 0], 0.2)).toBe("all");
    expect(polarReach(polar(6, 0), [0, 1, 0], 0.2)).toBe("near");
  });
});

describe("mirror bounds", () => {
  test("the item and its reflection, to either side of the origin", () => {
    // A sphere of radius 0.5 at x = 0.2, mirrored in x at distance 1: copies
    // at ±1.2, so the sphere around both sits at 0 with radius 1.7.
    const out = expandThrough({ kind: "mirror", axes: [true, false, false], offset: [1, 5, 5] }, [0.2, 0.3, 0], 0.5);
    expect(out.c).toEqual([0, 0.3, 0]);
    expect(out.r).toBeCloseTo(1.7);
  });
});

describe("polar radius", () => {
  test("the ring of copies around the axis bounds the item", () => {
    // A sphere of radius 0.5 at the origin, 1 out from a y axis: a ring of radius 1.5.
    const out = expandThrough(polar(6, 1, 1), [0, 0.2, 0], 0.5);
    expect(out.c).toEqual([0, 0.2, 0]);
    expect(out.r).toBeCloseTo(1.5);
  });

  test("copies moved off the axis need only the nearest three", () => {
    expect(planPointModifiers([polar(6)], [0, 0, 0], 0.5).polar).toEqual(["all"]);
    expect(planPointModifiers([polar(6, 1, 2)], [0, 0, 0], 0.5).polar).toEqual(["near"]);
  });
});

describe("scatter", () => {
  const sc = { jitter: [0.2, 0.1, 0] as [number, number, number], spin: [30, 0, 10] as [number, number, number], size: 0.25, seed: 7 };
  const rep = { kind: "repeat" as const, spacing: [2, 2, 2] as [number, number, number], count: [4, 1, 1] as [number, number, number], scatter: sc };

  test("a scattered copy's sphere covers every move, turn and size about its cell", () => {
    const out = scatterSphere(rep, [0.1, 0, 0], 0.4);
    expect(out.c).toEqual([0, 0, 0]);
    expect(out.r).toBeCloseTo(0.5 * 1.25 + Math.hypot(0.2, 0.1));
    expect(scatterSphere({ ...rep, scatter: undefined }, [0.1, 0, 0], 0.4)).toEqual({ c: [0.1, 0, 0], r: 0.4 });
  });

  test("copies scattered out of their cells check the whole ring of cells", () => {
    expect(planPointModifiers([{ ...rep, scatter: undefined }], [0, 0, 0], 0.4).ring).toEqual([null]);
    // Out on x (stay, toward, away); y and z have one copy each (stay).
    expect(planPointModifiers([{ ...rep, scatter: { ...sc, jitter: [0.9, 0, 0] } }], [0, 0, 0], 0.4).ring).toEqual([[3, 1, 1]]);
    // Only repeated axes count.
    expect(planPointModifiers([{ ...rep, scatter: undefined }], [0, 0, 0], 0.9).ring).toEqual([null]);
  });

  test("each cell gets its own copy, the same every time, within the limits", () => {
    const ids: [number, number, number][] = [[-1.5, 0, 0], [-0.5, 0, 0], [0.5, 0, 0], [1.5, 0, 0]];
    const copies = ids.map((id) => scatterCopy(sc, id));
    expect(scatterCopy(sc, [0.5, 0, 0])).toEqual(copies[2]);
    // Half-integer cells (even counts) do not collide.
    expect(new Set(copies.map((c) => c.size)).size).toBe(4);
    for (const c of copies) {
      c.offset.forEach((v, i) => expect(Math.abs(v)).toBeLessThanOrEqual(sc.jitter[i]));
      c.rotation.forEach((v, i) => expect(Math.abs(v)).toBeLessThanOrEqual(sc.spin[i]));
      expect(Math.abs(c.size - 1)).toBeLessThanOrEqual(sc.size);
    }
    expect(scatterCopy({ ...sc, seed: 8 }, [0.5, 0, 0])).not.toEqual(copies[2]);
  });
});

describe("copy gaps", () => {
  test("a repeat's copies stay half a cell minus their reach inside it", () => {
    const gap = repeatGap({ kind: "repeat", spacing: [2, 1, 4], count: [3, 3, 0] }, [0.5, 0, 0], 0.3);
    expect(gap[0]).toBeCloseTo(0.2);
    expect(gap[1]).toBeCloseTo(0.2);
    expect(gap[2]).toBeCloseTo(1.7);
    // Copies wider than their cell: a negative gap.
    expect(repeatGap({ kind: "repeat", spacing: [1, 1, 1], count: [2, 1, 1] }, [0, 0, 0], 0.7)[0]).toBeCloseTo(-0.2);
  });

  test("a polar repeat's copies stay inside their sector and off the axis", () => {
    const [angle, axis] = polarGap(polar(6), [1, 0, 0], 0.2);
    expect(angle).toBeCloseTo(Math.PI / 6 - Math.asin(0.2));
    expect(axis).toBeCloseTo(0.8);
    // Off the sector's center line: less room on the near side.
    expect(polarGap(polar(6), [Math.cos(0.3), 0, Math.sin(0.3)], 0.2)[0]).toBeCloseTo(Math.PI / 6 - 0.3 - Math.asin(0.2));
  });

  test("the plan records them per modifier, seen through the later modifiers", () => {
    const plan = planPointModifiers(
      [polar(6), { kind: "repeat", spacing: [3, 3, 3], count: [2, 1, 1] }],
      [0, 0, 0],
      0.2,
    );
    // The repeat's two copies, as one sphere, sit around the polar axis: every copy.
    expect(plan.polar).toEqual(["all", null]);
    expect(plan.gap[1]).toEqual([1.3, 1.3, 1.3].map((v) => expect.closeTo(v)));
  });
});
