import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Playback of procedural animation in the editor. `time` loops over
 * `duration`; exports loop the same way (embed runtime, Shadertoy).
 */
interface TimelineState {
  playing: boolean;
  /** Seconds into the loop. */
  time: number;
  /** Loop length in seconds. */
  duration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  setDuration: (d: number) => void;
  /** Advance by dt seconds while playing (renderer clock). */
  tick: (dt: number) => void;
}

export const MIN_DURATION = 0.5;
export const MAX_DURATION = 120;

export const useTimelineStore = create<TimelineState>()(
  persist(
    (set, get) => ({
      playing: true,
      time: 0,
      duration: 8,
      play: () => set({ playing: true }),
      pause: () => set({ playing: false }),
      toggle: () => set({ playing: !get().playing }),
      seek: (t) => {
        const d = get().duration;
        set({ time: ((t % d) + d) % d });
      },
      setDuration: (d) => {
        const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, d));
        set({ duration, time: get().time % duration });
      },
      tick: (dt) => {
        const { playing, time, duration } = get();
        if (playing) set({ time: (time + dt) % duration });
      },
    }),
    {
      name: "d-stance_timeline",
      partialize: (s) => ({ duration: s.duration }),
    },
  ),
);
