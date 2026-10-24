import { describe, expect, test } from "vitest";
import { planPointModifiers, polarReach } from "./modifierMath";

const polar = (count: number, axis: 0 | 1 | 2 = 1) => ({ kind: "polar" as const, count, axis });

describe("polar repeat reach", () => {
  test("a spoke inside its sector needs only its own copy", () => {
    expect(polarReach(polar(6), [1, 0, 0], 0.2)).toBe("sector");
  });

  test("a spoke wider than its sector needs the next copy on each side", () => {
    expect(polarReach(polar(16), [1, 0, 0], 0.2)).toBe("neighbors");
  });

  test("geometry around the axis, or wider than one neighbor, needs every copy", () => {
    // The cone that grew spikes: polar on a shape centered on the axis.
    expect(polarReach(polar(3, 2), [0, 0, 0], 0.7)).toBe("all");
    expect(polarReach(polar(3), [1, 0, 0], 0.9)).toBe("all");
    expect(polarReach(polar(8), [1, 0, 0], 0.95)).toBe("all");
  });

  test("the angle is measured in the polar's own plane", () => {
    // Axis x: the plane is (y, z); an offset along x does not move the spoke off the axis.
    expect(polarReach(polar(6, 0), [5, 0, 0], 0.2)).toBe("all");
    expect(polarReach(polar(6, 0), [0, 1, 0], 0.2)).toBe("sector");
  });

  test("a spoke off its sector's center line reaches further", () => {
    expect(polarReach(polar(6), [1, 0, 0], 0.3)).toBe("sector");
    expect(polarReach(polar(6), [Math.cos(0.4), 0, Math.sin(0.4)], 0.3)).toBe("neighbors");
  });

  test("one copy is never a loop", () => {
    expect(polarReach(polar(1), [0, 0, 0], 1)).toBe("sector");
  });

  test("the plan records it per modifier, seen through the later modifiers", () => {
    const plan = planPointModifiers(
      [polar(6), { kind: "repeat", spacing: [3, 3, 3], count: [2, 1, 1] }],
      [0, 0, 0],
      0.2,
    );
    // The repeat's copies sit on both sides of the axis: as one sphere they
    // cover it, so the plan conservatively checks every copy.
    expect(plan.polar).toEqual(["all", null]);
    expect(planPointModifiers([polar(6)], [1, 0, 0], 0.2).polar).toEqual(["sector"]);
  });
});
