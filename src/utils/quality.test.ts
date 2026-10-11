import { expect, test } from "vitest";
import { QUALITY_PRESETS, assertQualityInvariants } from "./quality";

test("quality presets satisfy their invariants", () => {
  expect(() => assertQualityInvariants()).not.toThrow();
  expect(QUALITY_PRESETS.length).toBeGreaterThan(0);
});
