import { create } from "zustand";

/**
 * "Try" mode: the viewport behaves like the exported embed — hover, click
 * and pointer drive interaction reactions; selection and the gizmo rest.
 */
interface TryState {
  trying: boolean;
  setTrying: (trying: boolean) => void;
}

export const useTryStore = create<TryState>()((set) => ({
  trying: false,
  setTrying: (trying) => set({ trying }),
}));
