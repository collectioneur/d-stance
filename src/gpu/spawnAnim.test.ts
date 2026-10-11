import { describe, expect, test } from "vitest";
import { SpawnAnimator } from "./spawnAnim";
import { group, scene, shape } from "../test/fixtures";

describe("SpawnAnimator", () => {
  test("new shapes grow in; wrapping existing shapes into a group does not", () => {
    const ball = shape("sphere", { id: "ball" });
    const before = scene([ball]);
    const anim = new SpawnAnimator();
    anim.rootChanged(before, scene([ball, shape("box", { id: "box" })]), 0);
    expect(anim.frame(scene([ball, shape("box", { id: "box" })]), 10).animating).toBe(true);

    const wrapped = scene([group([ball, shape("stroke", { id: "st", stroke: { points: [0, 0, 0, 0.1] } })], { id: "g" })]);
    const quiet = new SpawnAnimator();
    quiet.rootChanged(before, wrapped, 0);
    expect(quiet.frame(wrapped, 10).animating).toBe(false);
    // And back (undo): the group goes, the ball stays — no shrinking.
    quiet.rootChanged(wrapped, before, 20);
    expect(quiet.frame(before, 30).animating).toBe(false);
  });

  test("quiet changes animate nothing", () => {
    const a = scene([shape("sphere", { id: "a" })]);
    const b = scene([shape("sphere", { id: "a" }), shape("box", { id: "b" })]);
    const anim = new SpawnAnimator();
    anim.rootChanged(a, b, 0, true);
    expect(anim.frame(b, 10).animating).toBe(false);
  });
});
