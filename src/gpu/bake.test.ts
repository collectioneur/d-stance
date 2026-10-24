import { expect, test } from "vitest";
import { assertBakeParity, bakeShape, composeGroupCtx, identityCtx } from "./bake";

test("baked affine matches the sequential reference transform", () => {
  expect(() => assertBakeParity()).not.toThrow();
});

test("identity shape bakes to identity", () => {
  const b = bakeShape(identityCtx(), [0, 0, 0], [0, 0, 0], [1, 1, 1]);
  expect(b.row0).toEqual([1, 0, 0]);
  expect(b.row1).toEqual([0, 1, 0]);
  expect(b.row2).toEqual([0, 0, 1]);
  expect(b.offset).toEqual([0, 0, 0]);
  expect(b.factor).toBe(1);
});

test("group scale feeds the distance factor", () => {
  const ctx = composeGroupCtx(identityCtx(), [1, 2, 3], [0, 0, 0], [2, 3, 4]);
  const b = bakeShape(ctx, [0, 0, 0], [0, 0, 0], [0.5, 1, 1]);
  expect(b.factor).toBeCloseTo(0.5 * 2);
  // p = group position maps to the shape origin.
  const p = [1, 2, 3];
  const q = [b.row0, b.row1, b.row2].map(
    (r, i) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + b.offset[i],
  );
  q.forEach((c) => expect(c).toBeCloseTo(0));
});
