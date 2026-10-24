import { create } from "zustand";

/**
 * Committed viewport camera (orbit yaw / pitch in radians, distance). The
 * renderer owns the live camera and publishes it here after each orbit or
 * zoom settles, so exports can start from the view the user is looking at.
 */
export interface ViewState {
  rotX: number;
  rotY: number;
  distance: number;
}

export const DEFAULT_VIEW: ViewState = { rotX: 0.3, rotY: 0.4, distance: 2.5 };

export const useViewStore = create<ViewState>(() => ({ ...DEFAULT_VIEW }));
