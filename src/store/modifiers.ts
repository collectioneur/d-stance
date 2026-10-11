/**
 * Modifiers (IQ-style domain operations) on shapes and groups.
 *
 * Point modifiers rewrite the evaluation point before the SDF (repeat,
 * mirror, polar, twist, bend, elongate); distance modifiers rewrite the
 * result (round, onion). They run in the item's own space — for a group,
 * after its transform, so children are repeated / twisted in the group's
 * frame; for a shape, in its local (scaled) frame. Point modifiers apply in
 * list order to the point, distance modifiers in list order to the result.
 *
 * No imports: persistence and the scene store depend on this module.
 */

export type Axis = 0 | 1 | 2;
export type Vec3 = [number, number, number];

export type Modifier = (
  | {
      kind: "repeat";
      /** Cell size per axis (local units, ≥ MIN_SPACING). */
      spacing: Vec3;
      /** Copies per axis: 1 = not repeated, 0 = infinite, n ≥ 2 = n copies centered on the origin. */
      count: Vec3;
    }
  | { kind: "mirror"; axes: [boolean, boolean, boolean] }
  | { kind: "polar"; count: number; axis: Axis }
  | { kind: "twist"; /** radians per unit along the axis */ amount: number; axis: Axis }
  | { kind: "bend"; /** radians per unit along the bent direction */ amount: number; axis: Axis }
  | { kind: "elongate"; size: Vec3 }
  | { kind: "round"; radius: number }
  | { kind: "onion"; thickness: number }
) & {
  /** Temporarily switched off (kept in the list). */
  off?: boolean;
};

export type ModifierKind = Modifier["kind"];

export const POINT_MODIFIERS: ReadonlySet<ModifierKind> = new Set([
  "repeat",
  "mirror",
  "polar",
  "twist",
  "bend",
  "elongate",
]);

export const MAX_MODIFIERS = 8;
export const MIN_SPACING = 0.01;
export const MAX_REPEAT_COUNT = 64;
export const MAX_POLAR_COUNT = 64;
export const MAX_DEFORM = 50;

export const MODIFIER_LABEL: Record<ModifierKind, string> = {
  repeat: "Repeat",
  mirror: "Mirror",
  polar: "Polar repeat",
  twist: "Twist",
  bend: "Bend",
  elongate: "Elongate",
  round: "Round",
  onion: "Onion (shell)",
};

export const MODIFIER_HINT: Record<ModifierKind, string> = {
  repeat: "Copies along each axis. Count 0 repeats forever.",
  mirror: "Reflects the positive side onto the negative.",
  polar: "Copies around an axis, like spokes.",
  twist: "Rotates slices more the farther they are along the axis.",
  bend: "Curls the shape around an axis.",
  elongate: "Stretches the middle without scaling the ends.",
  round: "Rounds every edge by the radius.",
  onion: "Hollows into a shell of this thickness.",
};

/**
 * A new modifier of `kind`. `extent` is the item's current bound radius in its
 * own space, so a fresh repeat spaces copies just apart.
 */
export function createModifier(kind: ModifierKind, extent = 0.5): Modifier {
  const gap = Math.max(MIN_SPACING, Math.round(extent * 2.5 * 20) / 20);
  switch (kind) {
    case "repeat":
      return { kind, spacing: [gap, gap, gap], count: [3, 1, 1] };
    case "mirror":
      return { kind, axes: [true, false, false] };
    case "polar":
      return { kind, count: 6, axis: 1 };
    case "twist":
      return { kind, amount: 2, axis: 1 };
    case "bend":
      return { kind, amount: 1, axis: 2 };
    case "elongate":
      return { kind, size: [0.2, 0, 0] };
    case "round":
      return { kind, radius: 0.05 };
    case "onion":
      return { kind, thickness: 0.03 };
  }
}

const num = (v: unknown, fallback: number, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const int = (v: unknown, fallback: number, lo: number, hi: number) => Math.round(num(v, fallback, lo, hi));
const axis = (v: unknown, fallback: Axis): Axis => (v === 0 || v === 1 || v === 2 ? v : fallback);
const vec = (v: unknown, fallback: Vec3, lo: number, hi: number): Vec3 => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0], fallback[0], lo, hi), num(a[1], fallback[1], lo, hi), num(a[2], fallback[2], lo, hi)];
};

/** A well-formed modifier, or undefined (dropped). Trust boundary. */
export function sanitizeModifier(m: unknown): Modifier | undefined {
  if (typeof m !== "object" || m === null) return undefined;
  const raw = m as Record<string, unknown>;
  const off = raw.off === true ? { off: true } : {};
  switch (raw.kind) {
    case "repeat": {
      const c = Array.isArray(raw.count) ? raw.count : [];
      return {
        kind: "repeat",
        spacing: vec(raw.spacing, [1, 1, 1], MIN_SPACING, 100),
        count: [int(c[0], 1, 0, MAX_REPEAT_COUNT), int(c[1], 1, 0, MAX_REPEAT_COUNT), int(c[2], 1, 0, MAX_REPEAT_COUNT)],
        ...off,
      };
    }
    case "mirror": {
      const a = Array.isArray(raw.axes) ? raw.axes : [];
      return { kind: "mirror", axes: [a[0] === true, a[1] === true, a[2] === true], ...off };
    }
    case "polar":
      return { kind: "polar", count: int(raw.count, 6, 1, MAX_POLAR_COUNT), axis: axis(raw.axis, 1), ...off };
    case "twist":
      return { kind: "twist", amount: num(raw.amount, 2, -MAX_DEFORM, MAX_DEFORM), axis: axis(raw.axis, 1), ...off };
    case "bend":
      return { kind: "bend", amount: num(raw.amount, 1, -MAX_DEFORM, MAX_DEFORM), axis: axis(raw.axis, 2), ...off };
    case "elongate":
      return { kind: "elongate", size: vec(raw.size, [0.2, 0, 0], 0, 10), ...off };
    case "round":
      return { kind: "round", radius: num(raw.radius, 0.05, 0, 10), ...off };
    case "onion":
      return { kind: "onion", thickness: num(raw.thickness, 0.03, 0.001, 10), ...off };
    default:
      return undefined;
  }
}

/** Sanitized list (unknown entries dropped, capped at MAX_MODIFIERS); undefined when empty. */
export function sanitizeModifiers(list: unknown): Modifier[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list.map(sanitizeModifier).filter((m): m is Modifier => !!m).slice(0, MAX_MODIFIERS);
  return out.length > 0 ? out : undefined;
}

/** Modifiers that take part in evaluation. */
export function activeModifiers(list: readonly Modifier[] | undefined): Modifier[] {
  return (list ?? []).filter((m) => !m.off);
}
