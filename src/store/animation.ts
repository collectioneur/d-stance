/**
 * Procedural animation: tracks that drive one number of a shape or group
 * over time — value(t) = base + amount · wave(t / period + phase).
 *
 * The editor evaluates tracks on the CPU every frame (evaluateAnimations →
 * the compiler sees plain numbers, so playback never recompiles). The code
 * export writes the same formula into the shader as an expression of time
 * (see animationExpr), so embeds animate on their own.
 *
 * No imports from the scene store (persistence and the store depend on this).
 */
import type { Material } from "./material";
import type { Modifier } from "./modifiers";

export type Waveform = "sine" | "triangle" | "saw" | "square" | "bounce" | "noise" | "linear";

export type TrackTarget =
  | "position.x"
  | "position.y"
  | "position.z"
  | "rotation.x"
  | "rotation.y"
  | "rotation.z"
  | "scale"
  | "param0"
  | "param1"
  | "param2"
  | "param3"
  | "smoothK"
  | "emission";

export type Track = {
  target: TrackTarget;
  wave: Waveform;
  /**
   * Swing around the base value, in the property's units (degrees for
   * rotation). Scale tracks swing by this fraction of the base. Linear tracks
   * change by `amount` per period.
   */
  amount: number;
  /** Seconds per cycle. */
  period: number;
  /** Offset into the cycle, 0..1. */
  phase: number;
  off?: boolean;
};

/** What an item looks like to the animator. */
interface Animatable {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  params?: [number, number, number, number];
  smoothK: number;
  material?: Material;
  modifiers?: Modifier[];
  animation?: Track[];
}

export const MAX_TRACKS = 8;
export const MIN_PERIOD = 0.05;
export const MAX_PERIOD = 600;

export const WAVEFORMS: Waveform[] = ["sine", "triangle", "saw", "square", "bounce", "noise", "linear"];

export const WAVE_LABEL: Record<Waveform, string> = {
  sine: "Sine",
  triangle: "Triangle",
  saw: "Saw",
  square: "Square",
  bounce: "Bounce",
  noise: "Noise",
  linear: "Steady",
};

export const TARGET_LABEL: Record<TrackTarget, string> = {
  "position.x": "Position X",
  "position.y": "Position Y",
  "position.z": "Position Z",
  "rotation.x": "Rotation X",
  "rotation.y": "Rotation Y",
  "rotation.z": "Rotation Z",
  scale: "Scale",
  param0: "Size 1",
  param1: "Size 2",
  param2: "Size 3",
  param3: "Size 4",
  smoothK: "Smooth K",
  emission: "Glow",
};

const TARGETS = Object.keys(TARGET_LABEL) as TrackTarget[];

/** One-click starting points. "Up" is −Y in this editor. */
export const ANIMATION_PRESETS: { name: string; hint: string; tracks: Track[] }[] = [
  { name: "Spin", hint: "Turn around the vertical axis", tracks: [{ target: "rotation.y", wave: "linear", amount: 360, period: 4, phase: 0 }] },
  { name: "Float", hint: "Drift up and down", tracks: [{ target: "position.y", wave: "sine", amount: 0.08, period: 2, phase: 0 }] },
  { name: "Pulse", hint: "Grow and shrink", tracks: [{ target: "scale", wave: "sine", amount: 0.12, period: 1, phase: 0 }] },
  { name: "Wobble", hint: "Rock from side to side", tracks: [{ target: "rotation.z", wave: "sine", amount: 12, period: 1.5, phase: 0 }] },
  {
    name: "Orbit",
    hint: "Circle around its spot",
    tracks: [
      { target: "position.x", wave: "sine", amount: 0.3, period: 4, phase: 0 },
      { target: "position.z", wave: "sine", amount: 0.3, period: 4, phase: 0.25 },
    ],
  },
  { name: "Bounce", hint: "Hop off the ground", tracks: [{ target: "position.y", wave: "bounce", amount: -0.25, period: 1, phase: 0 }] },
  { name: "Glow", hint: "Breathe light", tracks: [{ target: "emission", wave: "sine", amount: 1, period: 2, phase: 0 }] },
];

// ── Waves ───────────────────────────────────────────────────────────────────

/** Integer hash → [0, 1); bit-identical to the shader's animHash. */
export function animHash(i: number): number {
  let u = Math.imul(i | 0, 1597334673) >>> 0;
  u = (u ^ (u >>> 16)) >>> 0;
  u = Math.imul(u, 3812015801) >>> 0;
  return (u >>> 8) / 16777216;
}

const fract = (x: number) => x - Math.floor(x);

/** Wave value at cycle position u (u = t / period + phase). */
export function waveAt(wave: Waveform, u: number): number {
  switch (wave) {
    case "sine":
      return Math.sin(2 * Math.PI * u);
    case "triangle":
      return 1 - 4 * Math.abs(fract(u + 0.25) - 0.5);
    case "saw":
      return 2 * fract(u) - 1;
    case "square":
      return fract(u) < 0.5 ? 1 : -1;
    case "bounce":
      return Math.abs(Math.sin(Math.PI * u));
    case "noise": {
      const i = Math.floor(u);
      const f = u - i;
      const s = f * f * (3 - 2 * f);
      return (animHash(i) * (1 - s) + animHash(i + 1) * s) * 2 - 1;
    }
    case "linear":
      return u;
  }
}

export function trackOffset(track: Track, t: number): number {
  return track.amount * waveAt(track.wave, t / track.period + track.phase);
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export function activeTracks(tracks: readonly Track[] | undefined): Track[] {
  return (tracks ?? []).filter((t) => !t.off);
}

export function hasAnimation(items: readonly { animation?: Track[]; items?: unknown }[]): boolean {
  for (const item of items) {
    if (activeTracks(item.animation).length > 0) return true;
    if (Array.isArray(item.items) && hasAnimation(item.items as never)) return true;
  }
  return false;
}

/** `item` with its tracks applied at time t (same object when nothing moves). */
export function animateItem<T extends Animatable>(item: T, t: number): T {
  const tracks = activeTracks(item.animation);
  if (tracks.length === 0) return item;
  const position = [...item.position] as [number, number, number];
  const rotation = [...item.rotation] as [number, number, number];
  const scale = [...item.scale] as [number, number, number];
  const params = item.params ? ([...item.params] as [number, number, number, number]) : undefined;
  let smoothK = item.smoothK;
  let emissionOffset = 0;
  let touchedMaterial = false;
  for (const track of tracks) {
    const v = trackOffset(track, t);
    switch (track.target) {
      case "position.x":
      case "position.y":
      case "position.z":
        position["xyz".indexOf(track.target[9])] += v;
        break;
      case "rotation.x":
      case "rotation.y":
      case "rotation.z":
        rotation["xyz".indexOf(track.target[9])] += v;
        break;
      case "scale":
        for (let a = 0; a < 3; a++) scale[a] = Math.max(0.01, scale[a] * (1 + v));
        break;
      case "param0":
      case "param1":
      case "param2":
      case "param3":
        if (params) params[Number(track.target[5])] += v;
        break;
      case "smoothK":
        smoothK = Math.max(0.001, smoothK + v);
        break;
      case "emission":
        emissionOffset += v;
        touchedMaterial = true;
        break;
    }
  }
  const out = { ...item, position, rotation, scale, smoothK } as T;
  if (params) (out as Animatable).params = params;
  if (touchedMaterial && item.material) {
    (out as Animatable).material = { ...item.material, emission: Math.max(0, item.material.emission + emissionOffset) };
  }
  return out;
}

type Tree = { items: (Animatable & { kind: string; id: string; items?: unknown[] })[] };

/**
 * The tree with every track applied at time t. Items in `still` (e.g. the one
 * being dragged with the gizmo) keep their rest pose. Subtrees without tracks
 * are shared, not copied.
 */
export function evaluateAnimations<R extends Tree>(root: R, t: number, still?: ReadonlySet<string>): R {
  const walk = (items: Tree["items"]): Tree["items"] => {
    let changed = false;
    const out = items.map((item) => {
      let next = still?.has(item.id) ? item : animateItem(item, t);
      if (item.kind === "group" && Array.isArray(item.items)) {
        const kids = walk(item.items as Tree["items"]);
        if (kids !== item.items) next = { ...next, items: kids };
      }
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : items;
  };
  const items = walk(root.items);
  return items === root.items ? root : { ...root, items };
}

// ── Sanitizing (trust boundary) ─────────────────────────────────────────────

const num = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export function sanitizeTrack(raw: unknown): Track | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!TARGETS.includes(r.target as TrackTarget)) return undefined;
  if (!WAVEFORMS.includes(r.wave as Waveform)) return undefined;
  return {
    target: r.target as TrackTarget,
    wave: r.wave as Waveform,
    amount: num(r.amount, 0, -1e4, 1e4),
    period: num(r.period, 2, MIN_PERIOD, MAX_PERIOD),
    phase: num(r.phase, 0, 0, 1),
    ...(r.off === true ? { off: true } : {}),
  };
}

export function sanitizeTracks(list: unknown): Track[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list.map(sanitizeTrack).filter((t): t is Track => !!t).slice(0, MAX_TRACKS);
  return out.length > 0 ? out : undefined;
}

// ── Shader expressions (export) ─────────────────────────────────────────────

export type AnimLang = "wgsl" | "glsl" | "typegpu";

/** Shader source of the wave helpers, per language. */
export const ANIM_HELPERS: Record<AnimLang, string> = {
  wgsl: `// Animation waves (d-stance): value = base + amount * wave(t / period + phase).
fn animHash(i: i32) -> f32 {
  var u = bitcast<u32>(i) * 1597334673u;
  u = (u ^ (u >> 16u)) * 3812015801u;
  return f32(u >> 8u) / 16777216.0;
}

fn animNoise(u: f32) -> f32 {
  let i = floor(u);
  let f = u - i;
  let s = f * f * (3.0 - 2.0 * f);
  return mix(animHash(i32(i)), animHash(i32(i) + 1), s) * 2.0 - 1.0;
}`,
  glsl: `// Animation waves (d-stance): value = base + amount * wave(t / period + phase).
float animHash(int i) {
  uint u = uint(i) * 1597334673u;
  u = (u ^ (u >> 16u)) * 3812015801u;
  return float(u >> 8u) / 16777216.0;
}

float animNoise(float u) {
  float i = floor(u);
  float f = u - i;
  float s = f * f * (3.0 - 2.0 * f);
  return mix(animHash(int(i)), animHash(int(i) + 1), s) * 2.0 - 1.0;
}`,
  typegpu: `// Animation waves (d-stance): value = base + amount * wave(t / period + phase).
const animHash = tgpu.fn([d.i32], d.f32)\`(i) {
  var u = bitcast<u32>(i) * 1597334673u;
  u = (u ^ (u >> 16u)) * 3812015801u;
  return f32(u >> 8u) / 16777216.0;
}\`;

const animNoise = tgpu.fn([d.f32], d.f32)\`(u) {
  let i = floor(u);
  let f = u - i;
  let s = f * f * (3.0 - 2.0 * f);
  return mix(animHash(i32(i)), animHash(i32(i) + 1), s) * 2.0 - 1.0;
}\`.$uses({ animHash });`,
};

function lit(n: number): string {
  const s = parseFloat(n.toFixed(6)).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Shader expression of a wave at cycle position `u` (an expression). */
function waveExpr(wave: Waveform, u: string, lang: AnimLang): string {
  const std = (f: string) => (lang === "typegpu" ? `std.${f}` : f);
  switch (wave) {
    case "sine":
      return `${std("sin")}(6.2831853 * ${u})`;
    case "triangle":
      return `(1.0 - 4.0 * ${std("abs")}(${std("fract")}(${u} + 0.25) - 0.5))`;
    case "saw":
      return `(2.0 * ${std("fract")}(${u}) - 1.0)`;
    case "square":
      return lang === "glsl"
        ? `(fract(${u}) < 0.5 ? 1.0 : -1.0)`
        : `${std("select")}(-1.0, 1.0, ${std("fract")}(${u}) < 0.5)`;
    case "bounce":
      return `${std("abs")}(${std("sin")}(3.14159265 * ${u}))`;
    case "noise":
      return `animNoise(${u})`;
    case "linear":
      return `(${u})`;
  }
}

/**
 * Expression for `base` driven by `tracks` hitting one property at time
 * `time`. Scale tracks multiply; everything else adds.
 */
export function animationExpr(base: number, tracks: Track[], time: string, lang: AnimLang, multiply = false): string {
  if (tracks.length === 0) return lit(base);
  const terms = tracks.map((t) => {
    const u = t.phase ? `(${time} / ${lit(t.period)} + ${lit(t.phase)})` : `${time} / ${lit(t.period)}`;
    return `${lit(t.amount)} * ${waveExpr(t.wave, u, lang)}`;
  });
  if (multiply) return `(${lit(base)} * (1.0 + ${terms.join(" + ")}))`;
  return `(${lit(base)} + ${terms.join(" + ")})`;
}
