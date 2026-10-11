/**
 * Surface look of a shape. `color` is the sRGB value the user picked (0..1).
 * Shapes without their own material use the nearest ancestor group's, then
 * DEFAULT_MATERIAL (the editor's original gray). No imports: persistence and
 * the scene store both depend on this module.
 */
export type Material = {
  color: [number, number, number];
  /** 0 = mirror-sharp highlights, 1 = fully diffuse. */
  roughness: number;
  /** 0 = dielectric (plastic, paint), 1 = metal (reflections take the color). */
  metalness: number;
  /** Self-illumination strength in the color; 0 = off. */
  emission: number;
};

export const DEFAULT_MATERIAL: Readonly<Material> = Object.freeze({
  color: Object.freeze([0.72, 0.72, 0.72]) as unknown as [number, number, number],
  roughness: 0.5,
  metalness: 0,
  emission: 0,
});

export const EMISSION_MAX = 10;

export const MATERIAL_PRESETS: { name: string; material: Material }[] = [
  { name: "Clay", material: { color: [0.72, 0.72, 0.72], roughness: 0.5, metalness: 0, emission: 0 } },
  { name: "Plastic", material: { color: [0.86, 0.22, 0.2], roughness: 0.25, metalness: 0, emission: 0 } },
  { name: "Rubber", material: { color: [0.12, 0.12, 0.13], roughness: 0.9, metalness: 0, emission: 0 } },
  { name: "Gold", material: { color: [1, 0.78, 0.34], roughness: 0.2, metalness: 1, emission: 0 } },
  { name: "Steel", material: { color: [0.75, 0.76, 0.78], roughness: 0.32, metalness: 1, emission: 0 } },
  { name: "Copper", material: { color: [0.95, 0.56, 0.4], roughness: 0.35, metalness: 1, emission: 0 } },
  { name: "Neon", material: { color: [0.25, 0.85, 1], roughness: 0.4, metalness: 0, emission: 2.5 } },
];

const unit = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** A well-formed material, or undefined (to drop it) when `m` is not an object. Trust boundary. */
export function sanitizeMaterial(m: unknown): Material | undefined {
  if (typeof m !== "object" || m === null) return undefined;
  const raw = m as Record<string, unknown>;
  const c = Array.isArray(raw.color) ? raw.color : [];
  const d = DEFAULT_MATERIAL;
  const emission = typeof raw.emission === "number" && Number.isFinite(raw.emission) ? raw.emission : 0;
  return {
    color: [unit(c[0], d.color[0]), unit(c[1], d.color[1]), unit(c[2], d.color[2])],
    roughness: unit(raw.roughness, d.roughness),
    metalness: unit(raw.metalness, d.metalness),
    emission: Math.min(EMISSION_MAX, Math.max(0, emission)),
  };
}

export function materialsEqual(a: Material, b: Material): boolean {
  return (
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2] &&
    a.roughness === b.roughness &&
    a.metalness === b.metalness &&
    a.emission === b.emission
  );
}

/** "#rrggbb" ↔ sRGB 0..1 triplet (the color input's format). */
export function colorToHex(c: readonly [number, number, number]): string {
  return `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToColor(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
