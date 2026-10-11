import { describe, expect, test } from "vitest";
import {
  MAX_STROKE_POINTS,
  STROKE_CHUNK,
  appendLine,
  packStroke,
  roundStroke,
  sanitizeStroke,
  simplifyLine,
  strokeBoundRadius,
  strokeChunkCount,
  strokeDistance,
  strokeFunction,
} from "./stroke";

const line = (n: number) => {
  const p: number[] = [];
  for (let i = 0; i < n; i++) p.push(i * 0.02, Math.sin(i / 5) * 0.1, 0, 0.03);
  return p;
};

describe("stroke", () => {
  test("distance: tapered capsules, breaks split lines, a single point is a sphere", () => {
    const s = { points: [0, 0, 0, 0.1, 1, 0, 0, 0.2] };
    expect(strokeDistance(s, 0, 1, 0)).toBeCloseTo(0.9, 9);
    expect(strokeDistance(s, 0.5, 1, 0)).toBeCloseTo(1 - 0.15, 9);
    expect(strokeDistance({ points: [0, 0, 0, 0.5] }, 0, 0, 2)).toBeCloseTo(1.5, 9);
    const broken = appendLine({ points: [0, 0, 0, 0.1] }, [2, 0, 0, 0.1])!;
    expect(broken.points.slice(4, 8)).toEqual([2, 0, 0, 0]); // break sits on the next line's start
    expect(strokeDistance(broken, 1, 0, 0)).toBeCloseTo(0.9, 9);
  });

  test("packing: one sphere per chunk, covering its segments, then the points", () => {
    const s = { points: line(50) };
    const packed = packStroke(s);
    const chunks = strokeChunkCount(50);
    expect(chunks).toBe(Math.ceil(49 / STROKE_CHUNK));
    expect(packed.length).toBe((chunks + 50) * 4);
    expect(packed.slice(chunks * 4)).toEqual(s.points);
    expect(strokeBoundRadius(s)).toBeGreaterThan(0.98);
  });

  test("simplify keeps the shape and the breaks, drops straight runs", () => {
    const straight: number[] = [];
    for (let i = 0; i <= 30; i++) straight.push(i * 0.01, 0, 0, 0.05);
    expect(simplifyLine(straight, 0.005)).toEqual([0, 0, 0, 0.05, 0.3, 0, 0, 0.05]);
    const curvy = simplifyLine(line(60), 0.003);
    for (let i = 0; i < 60; i++) {
      const x = i * 0.02;
      const y = Math.sin(i / 5) * 0.1;
      expect(strokeDistance({ points: curvy }, x, y, 0) + 0.03).toBeLessThan(0.0045);
    }
  });

  test("sanitize: finite numbers only, radius clamped, capped length, all-break strokes drop", () => {
    expect(sanitizeStroke({ points: [0, 0, 0, 9, 1, "x", 0, 1] })).toBeUndefined();
    expect(sanitizeStroke({ points: [0, 0, 0, 0] })).toBeUndefined();
    expect(sanitizeStroke({ points: [1e9, 0, 0, 9] })).toEqual({ points: [1000, 0, 0, 5] });
    expect(sanitizeStroke({ points: line(MAX_STROKE_POINTS + 50) })!.points).toHaveLength(MAX_STROKE_POINTS * 4);
    expect(sanitizeStroke("x")).toBeUndefined();
    expect(roundStroke([0.123456, 1])).toEqual([0.1235, 1]);
  });

  test("exported functions carry the packed data in every language", () => {
    const s = { points: line(20) };
    const wgsl = strokeFunction("stroke0", s, "wgsl");
    expect(wgsl).toContain("var<private> STROKE0_DATA: array<vec4f, 22>");
    expect(wgsl).toContain("fn stroke0(p: vec3f, thickness: f32, limit: f32) -> f32");
    expect(strokeFunction("stroke0", s, "glsl")).toContain("const vec4 STROKE0_DATA[22] = vec4[22](");
    expect(strokeFunction("stroke0", s, "typegpu")).toContain("tgpu.const(d.arrayOf(d.vec4f, 22)");
  });
});
