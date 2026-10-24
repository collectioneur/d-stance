import { create } from "zustand";

/**
 * Whether the picture lags the scene because its new program is still
 * compiling (useGpu publishes start and end only, never per frame).
 */
interface CompileState {
  /** performance.now() when the current compile started; null when the screen is up to date. */
  since: number | null;
}

export const useCompileStore = create<CompileState>(() => ({ since: null }));
