import { describe, expect, test } from "vitest";
import {
  MAX_INTERACTIVE,
  MAX_REACTIONS,
  REST_STATE,
  easeToward,
  hasInteraction,
  interactiveSlots,
  reactionOffsets,
  sanitizeReaction,
  sanitizeReactions,
  slotChain,
  type InteractionState,
} from "./interaction";
import { evaluateAnimations } from "./animation";
import { group, scene, shape } from "../test/fixtures";

const hover = { trigger: "hover" as const, target: "scale" as const, amount: 0.2 };
const click = { trigger: "click" as const, target: "rotation.y" as const, amount: 180 };
const follow = { trigger: "pointerX" as const, target: "position.x" as const, amount: 0.3 };

describe("interactive slots", () => {
  test("hover / click items get slots in tree order with their interactive parent", () => {
    const root = scene([
      group([shape("box", { id: "b", interaction: [click] }), shape("sphere", { id: "plain" })], { id: "g", interaction: [hover] }),
      shape("torus", { id: "t", interaction: [follow] }),
      shape("cone", { id: "c", interaction: [{ ...hover, off: true }] }),
    ]);
    const s = interactiveSlots(root.items);
    expect(s.ids).toEqual(["g", "b"]);
    expect(s.parent).toEqual([-1, 0]);
    expect(s.hoverable).toEqual([true, false]);
    expect(s.clickable).toEqual([false, true]);
    expect(s.pointer).toBe(true);
    expect(slotChain(s, 1)).toEqual([1, 0]);
    expect(hasInteraction(root.items)).toBe(true);
    expect(hasInteraction([shape("cone", { interaction: [{ ...hover, off: true }] })])).toBe(false);
  });

  test("slots are capped; items past the cap stay at rest", () => {
    const items = Array.from({ length: MAX_INTERACTIVE + 5 }, (_, i) => shape("sphere", { id: `s${i}`, interaction: [hover] }));
    const s = interactiveSlots(items);
    expect(s.ids).toHaveLength(MAX_INTERACTIVE);
    expect(s.slot.has(`s${MAX_INTERACTIVE}`)).toBe(false);
  });
});

describe("reactions", () => {
  test("offsets scale with the eased state and stack with animation", () => {
    const ball = shape("sphere", {
      id: "s",
      position: [0.1, 0, 0],
      interaction: [hover, follow],
      animation: [{ target: "position.x", wave: "linear", amount: 1, period: 1, phase: 0 }],
    });
    const state: InteractionState = { hover: new Map([["s", 0.5]]), click: new Map(), pointer: [-1, 0] };
    expect(reactionOffsets(ball, state)).toEqual([
      { target: "scale", value: 0.1 },
      { target: "position.x", value: -0.3 },
    ]);
    expect(reactionOffsets(ball, REST_STATE)).toEqual([]);
    const out = evaluateAnimations(scene([ball]), 0.25, undefined, (it) => reactionOffsets(it as never, state)).items[0];
    expect(out.position[0]).toBeCloseTo(0.1 + 0.25 - 0.3, 9);
    expect(out.scale).toEqual([1.1, 1.1, 1.1]);
  });

  test("easing reaches the target and snaps when close", () => {
    let v = 0;
    for (let i = 0; i < 30; i++) v = easeToward(v, 1, 1 / 60);
    expect(v).toBe(1);
    expect(easeToward(0.999, 1, 1 / 60)).toBe(1);
    expect(easeToward(0, 1, 1)).toBe(1);
  });

  test("sanitizing drops unknown triggers / targets and clamps", () => {
    expect(sanitizeReaction({ trigger: "keydown", target: "scale", amount: 1 })).toBeUndefined();
    expect(sanitizeReaction({ trigger: "hover", target: "__proto__", amount: 1 })).toBeUndefined();
    expect(sanitizeReaction({ trigger: "hover", target: "scale", amount: "1" })).toEqual({ trigger: "hover", target: "scale", amount: 0 });
    expect(sanitizeReaction({ trigger: "click", target: "emission", amount: 1e9, off: true })).toEqual({ trigger: "click", target: "emission", amount: 1e4, off: true });
    expect(sanitizeReactions(Array.from({ length: 20 }, () => hover))).toHaveLength(MAX_REACTIONS);
    expect(sanitizeReactions([])).toBeUndefined();
  });
});
