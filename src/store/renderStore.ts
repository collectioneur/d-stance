import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_QUALITY,
  QUALITY_PRESET_COUNT,
} from "../utils/quality";

/** Looks (also exportable) and inspect modes (editor tools for SDF work). */
export type RenderMode = "classic" | "chrome" | "studio" | "neon" | "volume" | "field" | "cost" | "normals";

export const LOOK_MODES: readonly RenderMode[] = ["classic", "chrome", "studio", "neon", "volume"];
export const INSPECT_MODES: readonly RenderMode[] = ["field", "cost", "normals"];

interface RenderState {
  renderMode: RenderMode;
  quality: number;
  /** Field mode: slice plane height (world Y, +Y is down). */
  sliceY: number;
  setRenderMode: (m: RenderMode) => void;
  setQuality: (q: number) => void;
  setSliceY: (y: number) => void;
}

export const useRenderStore = create<RenderState>()(
  persist(
    (set) => ({
      renderMode: "classic",
      quality: DEFAULT_QUALITY,
      sliceY: 0,
      setRenderMode: (m) => set({ renderMode: m }),
      setSliceY: (y) => set({ sliceY: Number.isFinite(y) ? Math.max(-10, Math.min(10, y)) : 0 }),
      setQuality: (q) =>
        set({
          quality: Math.max(0, Math.min(QUALITY_PRESET_COUNT - 1, Math.round(q))),
        }),
    }),
    {
      name: "d-stance_render_mode",
      // A mode this build does not know (older / newer storage) falls back to Classic.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<RenderState>;
        const known = [...LOOK_MODES, ...INSPECT_MODES].includes(p.renderMode as RenderMode);
        return { ...current, ...p, renderMode: known ? (p.renderMode as RenderMode) : current.renderMode };
      },
    },
  ),
);
