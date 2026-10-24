import { describe, expect, test } from "vitest";
import { SpawnAnimator } from "./spawnAnim";
import { scene, shape } from "../test/fixtures";

describe("SpawnAnimator grow-in", () => {
  const before = scene([shape("sphere", { id: "a" })]);
  const after = scene([shape("sphere", { id: "a" }), shape("box", { id: "b" })]);
  const scaleOf = (r: ReturnType<SpawnAnimator["frame"]>) => r.root.items[1].scale[0];

  test("waits at its smallest size until the item is drawn, then grows from 0", () => {
    const anim = new SpawnAnimator();
    anim.rootChanged(before, after, 0);
    // 200 ms of compiling: not on screen yet, the clock has not started.
    expect(scaleOf(anim.frame(after, 200, () => false))).toBeLessThan(0.05);
    expect(anim.progress("b", 200)).toBe(0);
    // First frame it is drawn: the grow-in starts here.
    anim.frame(after, 210, (id) => id === "b");
    expect(anim.progress("b", 210)).toBe(0);
    expect(anim.progress("b", 370)).toBeCloseTo(0.5, 5);
    expect(anim.frame(after, 400, () => true).animating).toBe(true);
    expect(anim.frame(after, 600, () => true).animating).toBe(false);
    expect(scaleOf(anim.frame(after, 600, () => true))).toBe(1);
  });

  test("a slow compile is waited out; one that never draws the item is let go after 10 s", () => {
    const anim = new SpawnAnimator();
    anim.rootChanged(before, after, 0);
    anim.frame(after, 3000, () => false);
    expect(anim.progress("b", 3000)).toBe(0);
    anim.frame(after, 10_100, () => false);
    expect(anim.progress("b", 10_260)).toBeCloseTo(0.5, 5);
  });

  test("without a drawn check it starts at once (old behavior)", () => {
    const anim = new SpawnAnimator();
    anim.rootChanged(before, after, 0);
    anim.frame(after, 0);
    expect(anim.progress("b", 160)).toBeCloseTo(0.5, 5);
  });
});
