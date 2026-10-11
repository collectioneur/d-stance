export interface EmbedScene {
  wgsl: string;
  glsl: string;
  /** Baked image SDF PNG data URLs, bound as imageTex0..N. */
  images: string[];
  view: {
    rotX: number;
    rotY: number;
    distance: number;
    /** Orbit center (default origin). */
    target?: [number, number, number];
    /** Keep a sphere of this radius around `target` in frame. */
    fit?: number;
  };
  /** Animated scene: seconds before the clock (the shaders' time) wraps. */
  loop?: number;
  /** Reactions to hover / click / pointer (index = pick id − 1). */
  interact?: {
    /** Nearest interactive ancestor of each item, −1 = none. */
    parent: number[];
    hoverable: boolean[];
    clickable: boolean[];
    /** Something follows the pointer anywhere on the page. */
    pointer: boolean;
  };
}

export interface MountOptions {
  orbit?: boolean;
  zoom?: boolean;
  /** Radians per second; 0 = still. */
  autoRotate?: number;
  /** Play the scene's animation (default true; off under prefers-reduced-motion). */
  animate?: boolean;
  maxDpr?: number;
  backend?: "auto" | "webgpu" | "webgl2";
}

/** Starts rendering `scene` into `canvas`; returns a function that stops it. */
export function mount(canvas: HTMLCanvasElement, scene: EmbedScene, options?: MountOptions): () => void;
