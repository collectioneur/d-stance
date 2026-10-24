import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ViewState } from "./viewStore";

export type ExportLook = "editor" | "classic" | "chrome" | "studio";
export type ExportBackground = "studio" | "transparent";
export type ExportMotion = "still" | "slow" | "spin";
export type ExportQuality = "fast" | "balanced" | "best";
export type ExportFormat = "html" | "module";
/** "custom": where the user left the camera in the preview. */
export type ExportFraming = "fit" | "editor" | "custom";

/**
 * Start view set by orbiting / zooming the embed preview. Kept for one scene
 * (by root id): a preference of this browser, not part of the saved scene.
 */
export interface CustomView {
  scene: string;
  /** Framing the preview showed when the user moved it. */
  base: "fit" | "editor";
  rotX: number;
  rotY: number;
  /** "fit": multiplies the fitted distance. */
  zoom: number;
  /** "editor": camera distance. */
  distance: number;
}

/** Embed export settings — a per-browser preference, not part of the scene. */
interface ExportState {
  look: ExportLook;
  background: ExportBackground;
  motion: ExportMotion;
  quality: ExportQuality;
  format: ExportFormat;
  framing: ExportFraming;
  custom: CustomView | null;
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
      custom: null,
      set: (patch) => set(patch),
    }),
    { name: "d-stance_export" },
  ),
);

export interface StartView {
  framing: "fit" | "editor";
  view: ViewState;
  zoom: number;
  /** The preview's custom view is in effect. */
  custom: boolean;
}

/** Camera an export of scene `sceneId` starts from. A custom view of another scene falls back to "fit". */
export function startView(
  s: { framing: ExportFraming; custom: CustomView | null },
  sceneId: string,
  editor: ViewState,
): StartView {
  const c = s.framing === "custom" && s.custom?.scene === sceneId ? s.custom : null;
  if (c) {
    return { framing: c.base, view: { rotX: c.rotX, rotY: c.rotY, distance: c.distance }, zoom: c.zoom, custom: true };
  }
  return { framing: s.framing === "editor" ? "editor" : "fit", view: editor, zoom: 1, custom: false };
}
