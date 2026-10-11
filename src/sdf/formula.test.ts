import { describe, expect, test } from "vitest";
import { FORMULA_EXAMPLES, emitFormula, formulaFunction, formulaNeeds, parseFormula, sanitizeFormula, DEFAULT_FORMULA } from "./formula";

const wgsl = (src: string) => {
  const p = parseFormula(src);
  if (!p.ok) throw new Error(p.error.message);
  return emitFormula(p.ast, "wgsl");
};

describe("formula language", () => {
  test("precedence: ^ over unary minus over * / over + -", () => {
    expect(wgsl("1 + 2 * 3")).toBe("(1.0 + (2.0 * 3.0))");
    expect(wgsl("-x^2")).toBe("(-pow(x, 2.0))");
    expect(wgsl("2^-1")).toBe("pow(2.0, (-1.0))");
    expect(wgsl("(1 + 2) * 3")).toBe("((1.0 + 2.0) * 3.0)");
    expect(wgsl("x - y - z")).toBe("((x - y) - z)");
  });

  test("constants, functions and per-language spellings", () => {
    expect(wgsl("pi")).toBe("3.14159265");
    expect(wgsl("length(x, y)")).toBe("length(vec2f(x, y))");
    expect(wgsl("mod(x, 2)")).toBe("(x - 2.0 * floor(x / 2.0))");
    const p = parseFormula("atan2(y, x) + fbm(x, y, z) + sin(x)");
    if (!p.ok) throw new Error();
    expect(emitFormula(p.ast, "glsl")).toBe("((atan(y, x) + fbm3(vec3(x, y, z), 4.0)) + sin(x))");
    expect(emitFormula(p.ast, "typegpu")).toBe("((std.atan2(y, x) + fbm3(d.vec3f(x, y, z), 4.0)) + std.sin(x))");
  });

  test("errors name the problem and where it is", () => {
    const cases: [string, RegExp, number][] = [
      ["length(x, y", /Missing “\)”/, 11],
      ["foo(x)", /Unknown function “foo”/, 0],
      ["x + q", /Unknown name “q”/, 4],
      ["sin(x, y)", /sin takes 1 argument/, 0],
      ["clamp(x, 1)", /clamp takes 3 arguments/, 0],
      ["x +", /ends too early/, 3],
      ["x $ y", /Unexpected “\$”/, 2],
      ["", /Write a formula/, 0],
    ];
    for (const [src, msg, at] of cases) {
      const p = parseFormula(src);
      expect(p.ok, src).toBe(false);
      if (!p.ok) {
        expect(p.error.message, src).toMatch(msg);
        expect(p.error.at, src).toBe(at);
      }
    }
  });

  test("hostile input cannot inject code", () => {
    for (const src of ["x); fn evil() {", "x /* */", "x`${1}`", "constructor(x)", "__proto__", "toString + x", "hasOwnProperty(x)"]) {
      expect(parseFormula(src).ok, src).toBe(false);
    }
    expect(parseFormula("x".repeat(700)).ok).toBe(false);
    expect(parseFormula("(".repeat(80) + "x" + ")".repeat(80)).ok).toBe(false);
  });

  test("sanitize keeps valid formulas, replaces the rest", () => {
    expect(sanitizeFormula("length(x, y, z) - 0.2")).toBe("length(x, y, z) - 0.2");
    expect(sanitizeFormula("nope(")).toBe(DEFAULT_FORMULA);
    expect(sanitizeFormula(42)).toBe(DEFAULT_FORMULA);
  });

  test("every example parses", () => {
    for (const ex of FORMULA_EXAMPLES) expect(parseFormula(ex.source).ok, ex.name).toBe(true);
  });

  test("helpers a formula needs", () => {
    const p = parseFormula("smin(x, y, 0.1) + noise(x, y, z)");
    if (!p.ok) throw new Error();
    expect(formulaNeeds(p.ast)).toEqual({ noise: true, smin: true });
  });

  test("the shape function flips y up and clips to its cube", () => {
    const p = parseFormula("y");
    if (!p.ok) throw new Error();
    const fn = formulaFunction("f0", p.ast, "wgsl");
    expect(fn).toContain("let y = -p.y;");
    expect(fn).toContain("return max((y) * safety, length(max(b, vec3f(0.0)))");
  });
});
