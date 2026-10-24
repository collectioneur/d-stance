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
    /** Multiplies the fitted distance (default 1). */
    zoom?: number;
  };
}

export interface MountOptions {
  orbit?: boolean;
  zoom?: boolean;
  /**
   * When a plain wheel (two-finger trackpad scroll) zooms. "auto" (default):
   * when it would not scroll the page or a container, or after a click on the
   * scene. ctrl/⌘ + wheel and pinches always zoom.
   */
  wheel?: "auto" | "always" | "modifier";
  /** Radians per second; 0 = still. */
  autoRotate?: number;
  maxDpr?: number;
  backend?: "auto" | "webgpu" | "webgl2";
  /** Called when the user leaves the camera somewhere (after a drag, zoom or pinch). */
  onView?: (view: EmbedView) => void;
}

export interface EmbedView {
  rotX: number;
  rotY: number;
  distance: number;
  /** Multiplier of the fitted distance (only meaningful with `fit`). */
  zoom: number;
}

/** Starts rendering `scene` into `canvas`; returns a function that stops it. */
export function mount(canvas: HTMLCanvasElement, scene: EmbedScene, options?: MountOptions): () => void;
