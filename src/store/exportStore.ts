import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExportLook = "editor" | "classic" | "chrome" | "studio";
export type ExportBackground = "studio" | "transparent";
export type ExportMotion = "still" | "slow" | "spin";
export type ExportQuality = "fast" | "balanced" | "best";
export type ExportFormat = "html" | "module";
export type ExportFraming = "fit" | "editor";

/** Embed export settings — a per-browser preference, not part of the scene. */
interface ExportState {
  look: ExportLook;
  background: ExportBackground;
  motion: ExportMotion;
  quality: ExportQuality;
  format: ExportFormat;
  framing: ExportFraming;
  set: (patch: Partial<Omit<ExportState, "set">>) => void;
}

export const useExportStore = create<ExportState>()(
  persist(
    (set) => ({
      look: "editor",
      background: "studio",
      motion: "still",
      quality: "balanced",
      format: "html",
      framing: "fit",
      set: (patch) => set(patch),
    }),
    { name: "d-stance_export" },
  ),
);
