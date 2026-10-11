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
}

export interface MountOptions {
  orbit?: boolean;
  zoom?: boolean;
  /** Radians per second; 0 = still. */
  autoRotate?: number;
  maxDpr?: number;
  backend?: "auto" | "webgpu" | "webgl2";
}

/** Starts rendering `scene` into `canvas`; returns a function that stops it. */
export function mount(canvas: HTMLCanvasElement, scene: EmbedScene, options?: MountOptions): () => void;
