import { describe, expect, test } from "vitest";
import {
  ANIMATION_PRESETS,
  MAX_TRACKS,
  WAVEFORMS,
  animHash,
  animateItem,
  animationExpr,
  evaluateAnimations,
  hasAnimation,
  sanitizeTrack,
  sanitizeTracks,
  trackOffset,
  waveAt,
  type Track,
} from "./animation";
import { group, scene, shape } from "../test/fixtures";

const track = (t: Partial<Track>): Track => ({ target: "position.x", wave: "sine", amount: 1, period: 2, phase: 0, ...t });

/** Runs a GLSL expression from animationExpr in JS (fract/sin/abs/ternary map 1:1). */
function runGlsl(expr: string, time: number): number {
  const fract = (x: number) => x - Math.floor(x);
  const animNoise = (u: number) => waveAt("noise", u);
  return new Function("time", "fract", "sin", "abs", "animNoise", `return ${expr};`)(
    time,
    fract,
    Math.sin,
    Math.abs,
    animNoise,
  ) as number;
}

describe("waves", () => {
  test("periodic waves stay in [-1, 1] and repeat every cycle", () => {
    for (const wave of WAVEFORMS.filter((w) => w !== "linear")) {
      for (let i = 0; i < 200; i++) {
        const u = i * 0.0731 - 3;
        const v = waveAt(wave, u);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        if (wave !== "noise") expect(waveAt(wave, u + 1)).toBeCloseTo(v, 9);
      }
    }
  });

  test("noise is continuous and deterministic", () => {
    for (let u = -2; u < 2; u += 0.01) expect(Math.abs(waveAt("noise", u + 0.001) - waveAt("noise", u))).toBeLessThan(0.01);
    expect(animHash(7)).toBe(animHash(7));
    expect(animHash(7)).not.toBe(animHash(8));
    for (let i = -50; i < 50; i++) {
      expect(animHash(i)).toBeGreaterThanOrEqual(0);
      expect(animHash(i)).toBeLessThan(1);
    }
  });

  test("shader expressions match the CPU for every waveform", () => {
    for (const wave of WAVEFORMS) {
      const tr = track({ wave, amount: 0.7, period: 1.3, phase: 0.2 });
      const expr = animationExpr(0.5, [tr], "time", "glsl");
      for (const t of [0, 0.31, 1.7, 5.05, 12.9]) {
        expect(runGlsl(expr, t)).toBeCloseTo(0.5 + trackOffset(tr, t), 5);
      }
    }
  });

  test("scale expressions multiply", () => {
    const tr = track({ target: "scale", amount: 0.25, period: 1 });
    expect(runGlsl(animationExpr(2, [tr], "time", "glsl", true), 0.25)).toBeCloseTo(2 * 1.25, 6);
  });
});

describe("animateItem", () => {
  test("presets move what they say", () => {
    const spin = ANIMATION_PRESETS.find((p) => p.name === "Spin")!;
    const box = shape("box", { animation: spin.tracks });
    expect(animateItem(box, 1).rotation[1]).toBeCloseTo(90, 6);
    const float = ANIMATION_PRESETS.find((p) => p.name === "Float")!;
    expect(animateItem(shape("sphere", { animation: float.tracks }), 0.5).position[1]).toBeCloseTo(0.08, 6);
  });

  test("scale never collapses below the minimum and tracks stack", () => {
    const s = shape("sphere", {
      animation: [track({ target: "scale", wave: "square", amount: -5, period: 1 }), track({ target: "param0", amount: 0.1, period: 4 })],
    });
    const at = animateItem(s, 0.1);
    expect(at.scale).toEqual([0.01, 0.01, 0.01]);
    expect(at.params[0]).toBeCloseTo(0.5 + 0.1 * Math.sin(2 * Math.PI * 0.025), 6);
  });

  test("glow only touches items that have a material, never goes negative", () => {
    const glow = [track({ target: "emission", amount: 5, period: 1 })];
    const plain = shape("sphere", { animation: glow });
    expect(animateItem(plain, 0.25).material).toBeUndefined();
    const lit = shape("sphere", { animation: glow, material: { color: [1, 0, 0], roughness: 0.5, metalness: 0, emission: 1 } });
    expect(animateItem(lit, 0.25).material!.emission).toBeCloseTo(6, 6);
    expect(animateItem(lit, 0.75).material!.emission).toBe(0);
  });

  test("switched-off tracks and still items stay at rest", () => {
    const off = shape("sphere", { animation: [{ ...track({}), off: true }] });
    expect(animateItem(off, 0.5)).toBe(off);
    const moving = shape("sphere", { id: "m", animation: [track({})] });
    const root = scene([moving]);
    expect(evaluateAnimations(root, 0.5, new Set(["m"]))).toBe(root);
  });

  test("evaluateAnimations shares subtrees that do not move", () => {
    const still = group([shape("box")]);
    const moving = group([shape("sphere", { animation: [track({})] })]);
    const root = scene([still, moving]);
    const out = evaluateAnimations(root, 0.5);
    expect(out).not.toBe(root);
    expect(out.items[0]).toBe(still);
    expect(out.items[1]).not.toBe(moving);
    expect(hasAnimation(root.items)).toBe(true);
    expect(hasAnimation([still])).toBe(false);
    expect(evaluateAnimations(scene([still]), 3).items[0]).toBe(still);
  });
});

describe("sanitizeTrack", () => {
  test("drops unknown targets and waves, clamps numbers", () => {
    expect(sanitizeTrack({ target: "constructor", wave: "sine" })).toBeUndefined();
    expect(sanitizeTrack({ target: "scale", wave: "eval" })).toBeUndefined();
    expect(sanitizeTrack(null)).toBeUndefined();
    expect(sanitizeTrack({ target: "scale", wave: "sine", amount: Infinity, period: 0, phase: 7 })).toEqual({
      target: "scale",
      wave: "sine",
      amount: 0,
      period: 0.05,
      phase: 1,
    });
  });

  test("lists are capped and empty lists vanish", () => {
    expect(sanitizeTracks([])).toBeUndefined();
    expect(sanitizeTracks("x")).toBeUndefined();
    expect(sanitizeTracks(Array.from({ length: 20 }, () => track({})))).toHaveLength(MAX_TRACKS);
  });
});
