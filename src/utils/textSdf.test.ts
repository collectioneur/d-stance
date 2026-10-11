import { describe, expect, test } from "vitest";
import {
  DEFAULT_TEXT,
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  cleanText,
  customFamily,
  customFont,
  fontCss,
  fontFamily,
  sanitizeTextSpec,
  textLayerName,
} from "./textSdf";

describe("text spec", () => {
  test("cleanText strips control characters and caps lines and length", () => {
    expect(cleanText("a\u0000b\tc\r\nd")).toBe("abc\nd");
    expect(cleanText("1\n2\n3\n4\n5\n6").split("\n")).toHaveLength(MAX_TEXT_LINES);
    expect(cleanText("x".repeat(500))).toHaveLength(MAX_TEXT_CHARS);
  });

  test("fonts: known keys, safe custom families, everything else falls back", () => {
    expect(fontFamily("mono")).toContain("JetBrains Mono");
    expect(fontFamily(customFont("Helvetica Neue"))).toMatch(/^"Helvetica Neue", "Inter Variable"/);
    expect(customFamily(customFont('x"; } body { color: red'))).toBeNull();
    expect(fontFamily(customFont('x"; } body {'))).toBe(fontFamily("inter"));
    expect(fontFamily("comic")).toBe(fontFamily("inter"));
    expect(fontCss({ ...DEFAULT_TEXT, italic: true, weight: 300 }, 50)).toMatch(/^italic 300 50px "Inter Variable"/);
  });

  test("sanitizing clamps numbers, whitelists fonts and drops non-text", () => {
    expect(sanitizeTextSpec({ content: "Hi", font: "evil", weight: 5000, spacing: -9, align: "justify", italic: "yes" })).toEqual({
      content: "Hi",
      font: "inter",
      weight: 900,
      italic: false,
      spacing: -0.2,
      align: "center",
    });
    expect(sanitizeTextSpec({ content: "Hi", font: customFont("Futura"), weight: 450.4, align: "right", italic: true })).toMatchObject({
      font: "custom:Futura",
      weight: 450,
      align: "right",
      italic: true,
    });
    expect(sanitizeTextSpec({ content: 42 })).toBeUndefined();
    expect(sanitizeTextSpec(null)).toBeUndefined();
  });

  test("layer names follow the first line", () => {
    expect(textLayerName("\n  Hello world \nmore")).toBe("Hello world");
    expect(textLayerName("   ")).toBe("Text");
    expect(textLayerName("a".repeat(40))).toHaveLength(24);
  });
});
