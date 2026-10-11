/**
 * Formula shapes: a user-written scalar field f(x, y, z), negative inside.
 *
 * A tiny, closed language — numbers, x / y / z, + − * / ^, parentheses,
 * a whitelist of functions and constants — parsed here (recursive descent, no
 * eval) and emitted as WGSL, GLSL or TypeGPU. `y` points up (the editor's
 * world +Y points down on screen), so formulas read like math.
 *
 * The field rarely is an exact distance; the shape multiplies it by its
 * `safety` param (≤ 1) for marching and clips it to a cube of `size`.
 */

export type FormulaLang = "wgsl" | "glsl" | "typegpu";

type Node =
  | { t: "num"; v: number }
  | { t: "var"; name: "x" | "y" | "z" }
  | { t: "neg"; a: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

export interface FormulaError {
  message: string;
  /** Character offset of the problem. */
  at: number;
}

export type ParsedFormula = { ok: true; ast: Node } | { ok: false; error: FormulaError };

export const FORMULA_MAX_LENGTH = 600;
const MAX_DEPTH = 64;

/** name → [min args, max args]. */
const FUNCTIONS: Record<string, [number, number]> = {
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  asin: [1, 1],
  acos: [1, 1],
  atan: [1, 1],
  atan2: [2, 2],
  sqrt: [1, 1],
  abs: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  fract: [1, 1],
  sign: [1, 1],
  exp: [1, 1],
  log: [1, 1],
  pow: [2, 2],
  min: [2, 2],
  max: [2, 2],
  clamp: [3, 3],
  mix: [3, 3],
  smoothstep: [3, 3],
  step: [2, 2],
  mod: [2, 2],
  length: [2, 3],
  smin: [3, 3],
  noise: [3, 3],
  fbm: [3, 3],
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: Math.PI * 2, e: Math.E };

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

export const FORMULA_EXAMPLES: { name: string; source: string }[] = [
  { name: "Sphere", source: "length(x, y, z) - 0.4" },
  { name: "Gyroid", source: "abs(sin(x*12)*cos(y*12) + sin(y*12)*cos(z*12) + sin(z*12)*cos(x*12)) / 12 - 0.01" },
  { name: "Waves", source: "y - 0.08*sin(x*9)*cos(z*9)" },
  { name: "Blobs", source: "length(x, y, z) - 0.35 + 0.08*sin(x*14)*sin(y*14)*sin(z*14)" },
  { name: "Rock", source: "length(x, y, z) - 0.35 + 0.06*fbm(x*5, y*5, z*5)" },
  { name: "Twisted", source: "max(abs(x*cos(y*6) - z*sin(y*6)) - 0.1, abs(x*sin(y*6) + z*cos(y*6)) - 0.1)" },
];

export const DEFAULT_FORMULA = FORMULA_EXAMPLES[0].source;

// ── Parsing ─────────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  private depth = 0;

  constructor(private src: string) {}

  fail(message: string, at = this.i): never {
    throw { message, at } satisfies FormulaError;
  }

  skip() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  peek(): string {
    this.skip();
    return this.src[this.i] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const n = this.expr();
    this.skip();
    if (this.i < this.src.length) this.fail(`Unexpected “${this.src[this.i]}”`);
    return n;
  }

  enter() {
    if (++this.depth > MAX_DEPTH) this.fail("Formula is nested too deeply");
  }

  // expr := term (('+' | '-') term)*
  expr(): Node {
    this.enter();
    let a = this.term();
    for (;;) {
      const c = this.peek();
      if (c !== "+" && c !== "-") break;
      this.i++;
      a = { t: "bin", op: c, a, b: this.term() };
    }
    this.depth--;
    return a;
  }

  // term := unary (('*' | '/') unary)*
  term(): Node {
    let a = this.unary();
    for (;;) {
      const c = this.peek();
      if (c !== "*" && c !== "/") break;
      this.i++;
      a = { t: "bin", op: c, a, b: this.unary() };
    }
    return a;
  }

  // unary := '-' unary | power
  unary(): Node {
    if (this.eat("-")) {
      this.enter();
      const n: Node = { t: "neg", a: this.unary() };
      this.depth--;
      return n;
    }
    if (this.eat("+")) return this.unary();
    return this.power();
  }

  // power := atom ('^' unary)?   (right-associative, binds tighter than unary minus on the left)
  power(): Node {
    const a = this.atom();
    if (this.eat("^")) return { t: "bin", op: "^", a, b: this.unary() };
    return a;
  }

  atom(): Node {
    this.skip();
    const start = this.i;
    const c = this.src[this.i] ?? "";
    if (c === "(") {
      this.i++;
      const n = this.expr();
      if (!this.eat(")")) this.fail("Missing “)”");
      return n;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      const v = Number(num[0]);
      if (!Number.isFinite(v)) this.fail("Number is too large", start);
      return { t: "num", v };
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!id) this.fail(c ? `Unexpected “${c}”` : "Formula ends too early");
    this.i += id[0].length;
    const name = id[0];
    if (this.peek() === "(") {
      // Own keys only: "constructor" & co. live on Object.prototype.
      const arity = Object.prototype.hasOwnProperty.call(FUNCTIONS, name) ? FUNCTIONS[name] : null;
      if (!arity) this.fail(`Unknown function “${name}”`, start);
      this.i++;
      const args: Node[] = [];
      if (!this.eat(")")) {
        do args.push(this.expr());
        while (this.eat(","));
        if (!this.eat(")")) this.fail("Missing “)”");
      }
      if (args.length < arity[0] || args.length > arity[1]) {
        const want = arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]}–${arity[1]}`;
        this.fail(`${name} takes ${want} argument${arity[1] > 1 ? "s" : ""}`, start);
      }
      return { t: "call", fn: name, args };
    }
    if (name === "x" || name === "y" || name === "z") return { t: "var", name };
    if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return { t: "num", v: CONSTANTS[name] };
    return this.fail(`Unknown name “${name}” (use x, y, z, pi, tau, e)`, start);
  }
}

export function parseFormula(src: string): ParsedFormula {
  if (src.length > FORMULA_MAX_LENGTH) {
    return { ok: false, error: { message: `Keep it under ${FORMULA_MAX_LENGTH} characters`, at: FORMULA_MAX_LENGTH } };
  }
  if (!src.trim()) return { ok: false, error: { message: "Write a formula, e.g. length(x, y, z) - 0.4", at: 0 } };
  try {
    return { ok: true, ast: new Parser(src).parse() };
  } catch (e) {
    if (e && typeof e === "object" && "message" in e && "at" in e) return { ok: false, error: e as FormulaError };
    throw e;
  }
}

/** Valid formulas pass; anything else becomes the default (trust boundary). */
export function sanitizeFormula(v: unknown): string {
  return typeof v === "string" && parseFormula(v).ok ? v : DEFAULT_FORMULA;
}

// ── Emission ────────────────────────────────────────────────────────────────

function num(v: number): string {
  const s = parseFloat(v.toPrecision(9)).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
}

const STD = (lang: FormulaLang, fn: string) => (lang === "typegpu" ? `std.${fn}` : fn);

/**
 * Expression in `lang`. Variables read `x`, `y`, `z` (declared by the caller,
 * y already flipped to point up). Helpers used: smin, fbm3, gradientNoise3
 * (from the shared sources) and, for mod, plain floor math.
 */
export function emitFormula(ast: Node, lang: FormulaLang): string {
  const go = (n: Node): string => {
    switch (n.t) {
      case "num":
        return n.v < 0 ? `(${num(n.v)})` : num(n.v);
      case "var":
        return n.name;
      case "neg":
        return `(-${go(n.a)})`;
      case "bin": {
        const a = go(n.a);
        const b = go(n.b);
        if (n.op === "^") return `${STD(lang, "pow")}(${a}, ${b})`;
        return `(${a} ${n.op} ${b})`;
      }
      case "call": {
        const args = n.args.map(go);
        const vec3 = (xs: string[]) =>
          lang === "wgsl" ? `vec3f(${xs.join(", ")})` : lang === "glsl" ? `vec3(${xs.join(", ")})` : `d.vec3f(${xs.join(", ")})`;
        switch (n.fn) {
          case "atan2":
            return lang === "glsl" ? `atan(${args[0]}, ${args[1]})` : `${STD(lang, "atan2")}(${args[0]}, ${args[1]})`;
          case "atan":
            return `${STD(lang, "atan")}(${args[0]})`;
          case "mod":
            return `(${args[0]} - ${args[1]} * ${STD(lang, "floor")}(${args[0]} / ${args[1]}))`;
          case "length":
            return `${STD(lang, "length")}(${args.length === 2 ? (lang === "wgsl" ? `vec2f(${args.join(", ")})` : lang === "glsl" ? `vec2(${args.join(", ")})` : `d.vec2f(${args.join(", ")})`) : vec3(args)})`;
          case "smin":
            return `smin(${args.join(", ")})`;
          case "noise":
            return `gradientNoise3(${vec3(args)})`;
          case "fbm":
            return `fbm3(${vec3(args)}, 4.0)`;
          default:
            return `${STD(lang, n.fn)}(${args.join(", ")})`;
        }
      }
    }
  };
  return go(ast);
}

/** Which shared helpers a formula needs. */
export function formulaNeeds(ast: Node): { noise: boolean; smin: boolean } {
  const out = { noise: false, smin: false };
  const walk = (n: Node) => {
    if (n.t === "call") {
      if (n.fn === "noise" || n.fn === "fbm") out.noise = true;
      if (n.fn === "smin") out.smin = true;
      n.args.forEach(walk);
    } else if (n.t === "neg") walk(n.a);
    else if (n.t === "bin") {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(ast);
  return out;
}

/**
 * The SDF of a formula shape as a function `name(p) -> distance` in `lang`:
 * field × safety, clipped to a cube of half size `size`.
 */
export function formulaFunction(name: string, ast: Node, lang: FormulaLang): string {
  const body = emitFormula(ast, lang);
  if (lang === "wgsl") {
    return `fn ${name}(p: vec3f, size: f32, safety: f32) -> f32 {
  let x = p.x;
  let y = -p.y;
  let z = p.z;
  let b = abs(p) - vec3f(size);
  return max((${body}) * safety, length(max(b, vec3f(0.0))) + min(max(b.x, max(b.y, b.z)), 0.0));
}`;
  }
  if (lang === "glsl") {
    return `float ${name}(vec3 p, float size, float safety) {
  float x = p.x;
  float y = -p.y;
  float z = p.z;
  vec3 b = abs(p) - vec3(size);
  return max((${body}) * safety, length(max(b, vec3(0.0))) + min(max(b.x, max(b.y, b.z)), 0.0));
}`;
  }
  return `const ${name} = (p: d.v3f, size: number, safety: number): number => {
  "use gpu";
  const x = p.x;
  const y = -p.y;
  const z = p.z;
  const b = std.abs(p) - d.vec3f(size);
  return std.max((${body}) * safety, std.length(std.max(b, d.vec3f(0.0))) + std.min(std.max(b.x, std.max(b.y, b.z)), 0.0));
};`;
}
