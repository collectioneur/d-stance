import { tgpu, d, std } from "typegpu";
import { fullScreenTriangle } from "typegpu/common";
import { MAX_IMAGES } from "../store/sceneStore";
import { IMAGE_SDF_RES } from "../utils/imageSdf";
import {
  CULL_DIST,
  DATA_IDENT,
  DATA_SLOTS,
  IMAGE_SAMPLER_IDENT,
  IMAGE_TEX_IDENT,
} from "./sceneCompiler";

type TgpuRoot = Awaited<ReturnType<typeof tgpu.init>>;

// The scene SDF is not written here: sceneCompiler.ts generates WGSL per scene
// structure and useGpu.ts plugs it into the two slots below. Everything in
// this file is fixed (camera, shading, grid, gizmo).

const CameraUniforms = d.struct({
  time: d.f32,
  aspect: d.f32,
  mouse: d.vec2f,
  distance: d.f32,
});

const SceneUniforms = d.struct({
  boundsRadius: d.f32, // conservative world-space bounding sphere of scene
  _pad0: d.u32,
  selectAll: d.u32, // 1 = scene root selected: every surface glows
  _pad1: d.f32,
  boundsCenter: d.vec3f,
  _pad2: d.f32,
});

const GizmoUniforms = d.struct({
  enabled: d.u32,
  activeAxis: d.u32,
  mode: d.u32,
  _pad0: d.u32,
  position: d.vec3f,
  _pad: d.f32,
  scale: d.f32,
  axisX: d.vec3f,
  _padX: d.f32,
  axisY: d.vec3f,
  _padY: d.f32,
  axisZ: d.vec3f,
  _padZ: d.f32,
});

const PickUniforms = d.struct({
  pickPass: d.u32,
});

const QualityUniforms = d.struct({
  maxSteps: d.f32,
  reflSteps: d.f32,
  shadowSteps: d.f32,
  /**
   * Always 0. Loop bounds built from it are opaque to the shader compiler, so
   * loops that call the (large, generated) scene SDF stay loops instead of
   * being unrolled into one inlined copy per tap — IQ's ZERO trick.
   */
  zero: d.u32,
});

const RAY_MISS_T = 50.0;
/** In-loop hit: `dist < HIT_EPS * max(t,1)`. Same scale as the reflection march. */
const HIT_EPS = 0.001;
/**
 * Out-of-steps leftover. Grazing rays on potato never reach HIT_EPS; accepting
 * any leftover paints a noisy halo. This is "already hugging the surface".
 * ponytail: inflates the silhouette by ~REST_HIT_EPS; upgrade is pixel-radius.
 */
const REST_HIT_EPS = 0.01;

/** Pick pass: scene object ids (16 bit: low byte in R and B, high byte in G). */
export const PICK_PASS_SCENE = 1;
/** Pick pass: ray-march translate gizmo, output axis id 1/2/3 in R. */
export const PICK_PASS_GIZMO = 2;

/** Cheap lit shading (no reflection bounce, iteration-based AO). */
export const RENDER_MODE_CLASSIC = 0;
/** Reflective chrome shading (reflection march + AO + tonemap). */
export const RENDER_MODE_CHROME = 1;
/** Physically based materials, soft shadows, AO, floor shadow. */
export const RENDER_MODE_STUDIO = 2;

/** What the generated scene knows about a surface point (ds_sceneInfo). */
export const SceneInfo = d.struct({
  glow: d.f32, // selection / hover highlight 0..1
  id: d.f32, // pick id (leaf index + 1), 0 = none
  color: d.vec3f, // sRGB albedo, blended through the CSG
  roughness: d.f32,
  metalness: d.f32,
  emission: d.f32,
});

/**
 * Render mode is baked per pipeline (each mode is its own cached program), so
 * the driver never sees the other modes' code: a smaller shader with less
 * register pressure, and Studio's extra SDF call sites cost nothing elsewhere.
 */
const renderModeSlot = tgpu.slot(RENDER_MODE_CLASSIC);

/** Generated scene SDF: world point → signed distance. */
const sceneSdfSlot = tgpu.slot<(p: d.v3f, standIn: number) => number>();
/** Generated scene info at a surface point. */
const sceneInfoSlot = tgpu.slot<(p: d.v3f) => d.InferGPU<typeof SceneInfo>>();

export function createShader(root: TgpuRoot) {
  const cameraUniforms = root.createUniform(CameraUniforms, {
    time: 0,
    aspect: 1,
    mouse: d.vec2f(0.3, 0.4),
    distance: 2.5,
  });
  const sceneUniforms = root.createUniform(SceneUniforms, {
    boundsRadius: 0,
    _pad0: 0,
    selectAll: 0,
    _pad1: 0,
    boundsCenter: d.vec3f(0, 0, 0),
    _pad2: 0,
  });
  const gizmoUniforms = root.createUniform(GizmoUniforms, {
    enabled: 0,
    activeAxis: 0,
    mode: 0,
    _pad0: 0,
    position: d.vec3f(0.0, 0.0, 0.0),
    _pad: 0,
    scale: 0.3,
    axisX: d.vec3f(1.0, 0.0, 0.0),
    _padX: 0,
    axisY: d.vec3f(0.0, 1.0, 0.0),
    _padY: 0,
    axisZ: d.vec3f(0.0, 0.0, 1.0),
    _padZ: 0,
  });
  const pickUniforms = root.createUniform(PickUniforms, { pickPass: 0 });
  const qualityUniforms = root.createUniform(QualityUniforms, {
    maxSteps: 48,
    reflSteps: 24,
    shadowSteps: 24,
    zero: 0,
  });

  /** Every number of the compiled scene (see sceneCompiler.ts). */
  const sceneData = root.createUniform(d.arrayOf(d.vec4f, DATA_SLOTS));

  // Baked 2D SDFs of imported images, one array layer per distinct image.
  // r16float texel t (= d_px / RES) ⇒ distance = t · (2 · halfSize).
  // Written by useGpu.ts as one RES×RES×MAX_IMAGES f16 block.
  const imageSdfTexture = root
    .createTexture({
      size: [IMAGE_SDF_RES, IMAGE_SDF_RES, MAX_IMAGES],
      format: "r16float",
    })
    .$usage("sampled");
  const imageSdfView = imageSdfTexture.createView(d.texture2dArray(d.f32));
  const imageSdfSampler = root.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const sdBox = (p: d.v3f, b: d.v3f): number => {
    "use gpu";
    const q = std.abs(p) - b;
    return (
      std.length(std.max(q, d.vec3f(0.0))) +
      std.min(std.max(q.x, std.max(q.y, q.z)), 0.0)
    );
  };

  const divAccSclBy = (acc: d.v3f, s: d.v3f): d.v3f => {
    "use gpu";
    return d.vec3f(acc.x / s.x, acc.y / s.y, acc.z / s.z);
  };

  const mulVec3 = (a: d.v3f, b: d.v3f): d.v3f => {
    "use gpu";
    return d.vec3f(a.x * b.x, a.y * b.y, a.z * b.z);
  };

  const sdScene = (p: d.v3f): number => {
    "use gpu";
    return sceneSdfSlot.$(p, CULL_DIST);
  };

  /**
   * Scene distance without far shapes' bounding spheres standing in for
   * them: soft shadows read the distance as "how near is geometry", and a
   * sphere around a far shape would darken them in rings.
   */
  const sdSceneExact = (p: d.v3f): number => {
    "use gpu";
    return sceneSdfSlot.$(p, 1e10);
  };

  // Ray vs sphere: returns (tEnter, tExit); tExit < 0 = miss.
  const raySphere = (
    ro: d.v3f,
    rd: d.v3f,
    center: d.v3f,
    r: number,
  ): d.v2f => {
    "use gpu";
    const oc = ro - center;
    const b = std.dot(oc, rd);
    const h = b * b - (std.dot(oc, oc) - r * r);
    if (h < 0.0) {
      return d.vec2f(0.0, -1.0);
    }
    const sh = std.sqrt(h);
    return d.vec2f(std.max(-b - sh, 0.0), -b + sh);
  };

  // Ray vs scene bounding sphere.
  const rayBounds = (ro: d.v3f, rd: d.v3f): d.v2f => {
    "use gpu";
    return raySphere(
      ro,
      rd,
      sceneUniforms.$.boundsCenter,
      sceneUniforms.$.boundsRadius,
    );
  };

  const GIZMO_ARROW_LEN = 0.85;
  const GIZMO_SHAFT_R = 0.035;
  const GIZMO_HEAD_R = 0.08;
  const GIZMO_HEAD_LEN = 0.18;
  const GIZMO_RING_MAJOR = 0.85;
  const GIZMO_RING_TUBE = 0.035;
  const GIZMO_MODE_ROTATE = 1;
  const GIZMO_MODE_SCALE = 2;
  /** Must match gizmo.ts GIZMO_SCALE_HEAD_HALF_RATIO / GIZMO_CENTER_HALF_RATIO. */
  const GIZMO_SCALE_HEAD_HALF = 0.07;
  const GIZMO_CENTER_HALF = 0.055;

  const sdCapsuleSeg = (p: d.v3f, a: d.v3f, b: d.v3f, r: number): number => {
    "use gpu";
    const pa = p - a;
    const ba = b - a;
    const h = std.clamp(std.dot(pa, ba) / std.dot(ba, ba), 0.0, 1.0);
    return std.length(pa - ba * h) - r;
  };

  const sdAxisArrow = (gp: d.v3f, dir: d.v3f, s: number): number => {
    "use gpu";
    const arrowLen = s * GIZMO_ARROW_LEN;
    const shaftR = s * GIZMO_SHAFT_R;
    const headR = s * GIZMO_HEAD_R;
    const headLen = s * GIZMO_HEAD_LEN;
    const tip = dir * arrowLen;
    const shaftEnd = dir * (arrowLen - headLen);
    const dShaft = sdCapsuleSeg(gp, d.vec3f(0.0), shaftEnd, shaftR);
    const dHead = std.length(gp - tip) - headR;
    return std.min(dShaft, dHead);
  };

  const evalTranslateGizmo = (p: d.v3f): d.v2f => {
    "use gpu";
    const origin = gizmoUniforms.$.position;
    const s = gizmoUniforms.$.scale;
    const gp = p - origin;
    const dx = sdAxisArrow(gp, d.vec3f(1.0, 0.0, 0.0), s);
    const dy = sdAxisArrow(gp, d.vec3f(0.0, 1.0, 0.0), s);
    const dz = sdAxisArrow(gp, d.vec3f(0.0, 0.0, 1.0), s);
    let best = dx;
    let axis = d.f32(1.0);
    if (dy < best) {
      best = dy;
      axis = d.f32(2.0);
    }
    if (dz < best) {
      best = dz;
      axis = d.f32(3.0);
    }
    return d.vec2f(best, axis);
  };

  const sdWorldAxisRing = (gp: d.v3f, axis: d.v3f, s: number): number => {
    "use gpu";
    const majorR = s * GIZMO_RING_MAJOR;
    const tubeR = s * GIZMO_RING_TUBE;
    const along = std.dot(gp, axis);
    const perp = gp - axis * along;
    const q = d.vec2f(std.length(perp) - majorR, along);
    return std.length(q) - tubeR;
  };

  const evalRotateGizmo = (p: d.v3f): d.v2f => {
    "use gpu";
    const origin = gizmoUniforms.$.position;
    const s = gizmoUniforms.$.scale;
    const gp = p - origin;
    const dx = sdWorldAxisRing(gp, gizmoUniforms.$.axisX, s);
    const dy = sdWorldAxisRing(gp, gizmoUniforms.$.axisY, s);
    const dz = sdWorldAxisRing(gp, gizmoUniforms.$.axisZ, s);
    let best = dx;
    let axis = d.f32(1.0);
    if (dy < best) {
      best = dy;
      axis = d.f32(2.0);
    }
    if (dz < best) {
      best = dz;
      axis = d.f32(3.0);
    }
    return d.vec2f(best, axis);
  };

  // Arrow with a cube head (scale-gizmo convention, distinct from the
  // translate arrows). Cube is oriented along the handle axis; the u/v basis
  // must match gizmo.ts ringPlaneBasis so CPU pick sees identical geometry.
  const sdScaleHandle = (gp: d.v3f, axis: d.v3f, s: number): number => {
    "use gpu";
    const arrowLen = s * GIZMO_ARROW_LEN;
    const shaftR = s * GIZMO_SHAFT_R;
    const half = s * GIZMO_SCALE_HEAD_HALF;

    let hint = d.vec3f(0.0, 1.0, 0.0);
    if (std.abs(axis.y) >= 0.9) {
      hint = d.vec3f(1.0, 0.0, 0.0);
    }
    const u = std.normalize(std.cross(hint, axis));
    const v = std.cross(axis, u);

    const dShaft = sdCapsuleSeg(gp, d.vec3f(0.0), axis * (arrowLen - half), shaftR);

    const rel = gp - axis * arrowLen;
    const local = d.vec3f(std.dot(rel, axis), std.dot(rel, u), std.dot(rel, v));
    const dHead = sdBox(local, d.vec3f(half, half, half));
    return std.min(dShaft, dHead);
  };

  const evalScaleGizmo = (p: d.v3f): d.v2f => {
    "use gpu";
    const origin = gizmoUniforms.$.position;
    const s = gizmoUniforms.$.scale;
    const gp = p - origin;
    const dx = sdScaleHandle(gp, gizmoUniforms.$.axisX, s);
    const dy = sdScaleHandle(gp, gizmoUniforms.$.axisY, s);
    const dz = sdScaleHandle(gp, gizmoUniforms.$.axisZ, s);
    const half = s * GIZMO_CENTER_HALF;
    const dc = sdBox(gp, d.vec3f(half, half, half));
    let best = dx;
    let axis = d.f32(1.0);
    if (dy < best) {
      best = dy;
      axis = d.f32(2.0);
    }
    if (dz < best) {
      best = dz;
      axis = d.f32(3.0);
    }
    if (dc < best) {
      best = dc;
      axis = d.f32(4.0);
    }
    return d.vec2f(best, axis);
  };

  const evalGizmo = (p: d.v3f): d.v2f => {
    "use gpu";
    if (gizmoUniforms.$.mode === d.u32(GIZMO_MODE_ROTATE)) {
      return evalRotateGizmo(p);
    }
    if (gizmoUniforms.$.mode === d.u32(GIZMO_MODE_SCALE)) {
      return evalScaleGizmo(p);
    }
    return evalTranslateGizmo(p);
  };

  const gizmoAxisColor = (axis: number): d.v3f => {
    "use gpu";
    const active = gizmoUniforms.$.activeAxis;
    const axisId = d.u32(std.round(axis));
    const isActive =
      (active === d.u32(1) && axisId === d.u32(1)) ||
      (active === d.u32(2) && axisId === d.u32(2)) ||
      (active === d.u32(3) && axisId === d.u32(3)) ||
      (active === d.u32(4) && axisId === d.u32(4));
    let full = d.vec3f(0.38, 0.58, 1.0);
    if (axisId === d.u32(1)) {
      full = d.vec3f(1.0, 0.3, 0.3);
    }
    if (axisId === d.u32(2)) {
      full = d.vec3f(0.3, 1.0, 0.3);
    }
    if (axisId === d.u32(4)) {
      full = d.vec3f(0.9, 0.9, 0.9);
    }
    if (isActive) {
      return full * 1.2;
    }
    // Resting: desaturated + dimmed so the gizmo sits with the muted UI.
    const gray = d.vec3f(0.62, 0.62, 0.62);
    return std.mix(full, gray, d.f32(0.35)) * 0.6;
  };

  const GIZMO_HIT_EPS = 0.00015;
  // Conservative bounding-sphere radius in units of gizmo scale. Max extents:
  // translate 0.85+0.08 (head), rotate 0.85+0.035 (tube),
  // scale 0.85+0.07·√3 (cube corner) — all ≤ 0.98.
  const GIZMO_BOUND_RADIUS = 1.05;
  // Self-check (runs on CPU at shader build): gate sphere must cover every
  // handle, otherwise the march silently clips geometry.
  const maxGizmoExtent = Math.max(
    GIZMO_ARROW_LEN + GIZMO_HEAD_R,
    GIZMO_RING_MAJOR + GIZMO_RING_TUBE,
    GIZMO_ARROW_LEN + GIZMO_SCALE_HEAD_HALF * Math.sqrt(3),
    GIZMO_CENTER_HALF * Math.sqrt(3),
  );
  if (maxGizmoExtent > GIZMO_BOUND_RADIUS) {
    throw new Error(
      `GIZMO_BOUND_RADIUS ${GIZMO_BOUND_RADIUS} < max handle extent ${maxGizmoExtent}`,
    );
  }

  const rayMarchGizmo = (ro: d.v3f, rd: d.v3f): d.v2f => {
    "use gpu";
    // Gizmo covers a few % of the screen; skip the 32-step march everywhere else.
    const bounds = raySphere(
      ro,
      rd,
      gizmoUniforms.$.position,
      gizmoUniforms.$.scale * GIZMO_BOUND_RADIUS,
    );
    if (bounds.y < 0.0) {
      return d.vec2f(RAY_MISS_T + 1.0, 0.0);
    }
    let t = bounds.x;
    let hitAxis = d.f32(0.0);
    let converged = false;
    for (let i = d.f32(0.0); i < d.f32(32.0); i += d.f32(1.0)) {
      const p = ro + rd * t;
      const g = evalGizmo(p);
      const dist = g.x;
      hitAxis = g.y;
      if (dist < GIZMO_HIT_EPS) {
        converged = true;
        break;
      }
      t += dist * 0.85;
      if (t > bounds.y) {
        break;
      }
    }
    if (!converged) {
      return d.vec2f(RAY_MISS_T + 1.0, 0.0);
    }
    return d.vec2f(t, hitAxis);
  };

  // ── Chrome shading ────────────────────────────────────────────────────────

  const acesTonemap = (x: d.v3f): d.v3f => {
    "use gpu";
    const num = mulVec3(x, x * 2.51 + d.vec3f(0.03));
    const den = mulVec3(x, x * 2.43 + d.vec3f(0.59)) + d.vec3f(0.14);
    return std.min(std.max(divAccSclBy(num, den), d.vec3f(0.0)), d.vec3f(1.0));
  };

  // Procedural studio environment: dark gray room + softbox strips.
  // ponytail: analytic bands instead of an HDRI texture — good enough for
  // chrome reflections; upgrade path is a real cubemap if art needs it.
  const envColor = (rd: d.v3f): d.v3f => {
    "use gpu";
    // World +y is down on screen: "up" in the studio is -y.
    const dirUp = 0.0 - rd.y;
    const up = dirUp * 0.5 + 0.5;
    let v = std.mix(0.015, 0.06, up);

    const horizLen = std.max(std.length(d.vec2f(rd.x, rd.z)), 0.0001);
    const hx = rd.x / horizLen;
    const hz = rd.z / horizLen;

    // Tall vertical softbox, front-left
    const a1 = std.max(hx * -0.7071 - hz * 0.7071, 0.0);
    const s1 =
      std.pow(a1, 22.0) * (1.0 - std.smoothstep(0.55, 0.9, std.abs(rd.y)));

    // Narrower vertical strip, right
    const a2 = std.max(hx * 0.866 - hz * 0.5, 0.0);
    const s2 =
      std.pow(a2, 40.0) * (1.0 - std.smoothstep(0.5, 0.85, std.abs(rd.y)));

    // Broad overhead softbox
    const sTop = std.smoothstep(0.35, 0.85, dirUp);

    // Faint floor bounce so downward faces aren't dead black
    const sBot = std.smoothstep(0.3, 0.9, rd.y);

    v += s1 * 3.2 + s2 * 2.2 + sTop * 1.4 + sBot * 0.05;
    return d.vec3f(v, v, v);
  };

  // 3-tap SDF ambient occlusion (IQ style)
  const calcAO = (p: d.v3f, n: d.v3f): number => {
    "use gpu";
    let occ = d.f32(0.0);
    let sca = d.f32(1.0);
    const taps = d.f32(3 + qualityUniforms.$.zero);
    for (let i = d.f32(1.0); i <= taps; i += d.f32(1.0)) {
      const hr = 0.01 + 0.12 * (i / 3.0);
      const dd = sdScene(p + n * hr);
      occ += (hr - dd) * sca;
      sca *= 0.65;
    }
    return std.clamp(1.0 - 1.6 * occ, 0.0, 1.0);
  };

  // Returns (t, lastDist). lastDist is the SDF value at the hit point,
  // reused by calcNormalCheap so the forward-difference normal needs only
  // 3 extra sdScene taps instead of calcNormal's 4. Breaks before stepping
  // (unlike the primary rayMarch) so t and lastDist describe the same point;
  // the old post-step point could land inside the surface.
  const rayMarchReflection = (ro: d.v3f, rd: d.v3f): d.v2f => {
    "use gpu";
    const bounds = rayBounds(ro, rd);
    if (bounds.y < 0.0) {
      return d.vec2f(100.0, 0.0);
    }
    let t = bounds.x;
    let dist = d.f32(0.0);
    for (
      let i = d.f32(0.0);
      i < qualityUniforms.$.reflSteps;
      i += d.f32(1.0)
    ) {
      const p = ro + rd * t;
      dist = sdScene(p);
      if (dist < 0.001 * std.max(t, 1.0)) {
        break;
      }
      t += dist;
      if (t > bounds.y) {
        return d.vec2f(100.0, 0.0);
      }
    }
    return d.vec2f(t, dist);
  };

  // Cheap normal for reflection hits: forward difference against the SDF
  // value d0 already computed by the reflection march — 3 sdScene evals
  // instead of calcNormal's 4. Subtracting d0 cancels the "hit point is not
  // exactly on the surface" offset, so this matches the tetrahedral normal
  // bit-exact in practice (verified via screenshot diff).
  // ponytail: only feeds envColor of the second bounce; upgrade path is full
  // calcNormal if reflections ever shade more than env.
  const calcNormalCheap = (p: d.v3f, d0: number): d.v3f => {
    "use gpu";
    const eps = 0.001;
    let n = d.vec3f(0.0);
    for (let i = d.u32(0); i < d.u32(3) + qualityUniforms.$.zero; i += d.u32(1)) {
      let e = d.vec3f(1.0, 0.0, 0.0);
      if (i === d.u32(1)) {
        e = d.vec3f(0.0, 1.0, 0.0);
      } else if (i === d.u32(2)) {
        e = d.vec3f(0.0, 0.0, 1.0);
      }
      n += e * (sdScene(p + e * eps) - d0);
    }
    return std.normalize(n);
  };

  // Tetrahedral normal: taps at eps·(1,-1,-1), (-1,-1,1), (-1,1,-1), (1,1,1).
  const calcNormal = (p: d.v3f): d.v3f => {
    "use gpu";
    const eps = 0.001;
    let n = d.vec3f(0.0);
    for (let i = d.u32(0); i < d.u32(4) + qualityUniforms.$.zero; i += d.u32(1)) {
      let e = d.vec3f(1.0, 1.0, 1.0);
      if (i === d.u32(0)) {
        e = d.vec3f(1.0, -1.0, -1.0);
      } else if (i === d.u32(1)) {
        e = d.vec3f(-1.0, -1.0, 1.0);
      } else if (i === d.u32(2)) {
        e = d.vec3f(-1.0, 1.0, -1.0);
      }
      n += e * sdScene(p + e * eps);
    }
    return std.normalize(n);
  };

  // ── Materials ──────────────────────────────────────────────────────────────

  /** Soft shadow toward `rd` (IQ): 1 = lit, 0 = occluded. */
  const softShadow = (ro: d.v3f, rd: d.v3f): number => {
    "use gpu";
    const span = rayBounds(ro, rd);
    if (span.y < 0.0) {
      return 1.0;
    }
    let res = d.f32(1.0);
    let t = std.max(span.x, 0.02);
    for (let i = d.f32(0.0); i < qualityUniforms.$.shadowSteps; i += d.f32(1.0)) {
      const h = sdSceneExact(ro + rd * t);
      res = std.min(res, (8.0 * h) / t);
      t += std.clamp(h, 0.01, 0.2);
      if (res < 0.002 || t > span.y) {
        break;
      }
    }
    const r = std.clamp(res, 0.0, 1.0);
    return r * r * (3.0 - 2.0 * r);
  };

  /** Chrome reflections take the hue of the material (gray stays neutral). */
  const chromeTint = (c: d.v3f): d.v3f => {
    "use gpu";
    const hi = std.max(c.x, std.max(c.y, c.z));
    const lo = std.min(c.x, std.min(c.y, c.z));
    const sat = std.select(d.f32(0.0), (hi - lo) / hi, hi > 0.001);
    return std.mix(d.vec3f(1.0), c / std.max(hi, 0.001), sat);
  };

  /** Classic: one key light, iteration AO; tuned so the default material matches the original gray. */
  const shadeClassic = (N: d.v3f, viewDir: d.v3f, iterations: number, info: d.InferGPU<typeof SceneInfo>): d.v3f => {
    "use gpu";
    const lightDir = std.normalize(d.vec3f(2.0, -3.0, -1.0));
    const diff = std.max(std.dot(N, lightDir), 0.0);
    const fresnel = std.pow(1.0 - std.abs(std.dot(N, viewDir)), 3.0) * 0.5;
    const halfDir = std.normalize(lightDir + viewDir);
    // roughness 0.5 → exponent 64, strength 1.5 (the original look).
    const shininess = std.exp2(9.0 - 6.0 * info.roughness);
    const spec = std.pow(std.max(std.dot(N, halfDir), 0.0), shininess) * 3.0 * (1.0 - info.roughness);
    const ao = 1.0 - std.clamp(iterations / 64.0, 0.0, 1.0) * 0.4;
    // The output is sqrt-encoded, so square the sRGB pick (≈ linear) and
    // rescale so the default gray (0.72) lands exactly where it always did.
    const base = (info.color * info.color) / 0.72;
    const specCol = std.mix(d.vec3f(1.0), base, info.metalness);
    const diffCol = base * (1.0 - info.metalness * 0.85);
    const lit = (diffCol * (diff * 0.8 + 0.2) + specCol * spec + base * fresnel) * ao + base * info.emission;
    return std.sqrt(std.max(lit, d.vec3f(0.0)));
  };

  /**
   * Physically based shading: GGX key light with soft shadow, sky + studio
   * reflections, AO. Shadow and AO (geometry only) run before the material is
   * fetched: holding scene info across a march loop costs registers.
   * Returns (color, glow) via SceneShade.
   */
  const shadeStudio = (pos: d.v3f, N: d.v3f, rd: d.v3f): d.v4f => {
    "use gpu";
    const V = rd * -1.0;
    const L = std.normalize(d.vec3f(-1.2, -3.0, -1.6));
    const NdotL = std.max(std.dot(N, L), 0.0);
    let shadow = d.f32(0.0);
    if (NdotL > 0.0) {
      shadow = softShadow(pos + N * 0.003, L);
    }
    const ao = calcAO(pos, N);

    const info = sceneInfoSlot.$(pos);
    const albedo = std.pow(std.max(info.color, d.vec3f(0.0)), d.vec3f(2.2));
    const rough = std.clamp(info.roughness, 0.045, 1.0);
    const metal = std.clamp(info.metalness, 0.0, 1.0);
    const F0 = std.mix(d.vec3f(0.04), albedo, metal);
    const NdotV = std.max(std.dot(N, V), 0.0001);

    let col = albedo * info.emission;
    if (NdotL > 0.0) {
      const a2 = rough * rough * rough * rough;
      const H = std.normalize(L + V);
      const NdotH = std.max(std.dot(N, H), 0.0);
      const VdotH = std.max(std.dot(V, H), 0.0);
      const dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
      const D = a2 / (3.14159265 * dd * dd);
      const k = ((rough + 1.0) * (rough + 1.0)) / 8.0;
      const G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
      const F = F0 + (d.vec3f(1.0) - F0) * std.pow(1.0 - VdotH, 5.0);
      const spec = (F * (D * G)) / std.max(4.0 * NdotV * NdotL, 0.0001);
      const kd = (d.vec3f(1.0) - F) * (1.0 - metal);
      col = col + ((kd * albedo) / 3.14159265 + spec) * (2.6 * NdotL * shadow);
    }
    // Hemisphere sky for diffuse ambient ("up" is −Y).
    const upness = 0.5 - 0.5 * N.y;
    const sky = std.mix(d.vec3f(0.035, 0.035, 0.04), d.vec3f(0.3, 0.31, 0.34), upness);
    col = col + albedo * (1.0 - metal) * sky * ao;
    const Fr = F0 + (std.max(d.vec3f(1.0 - rough), F0) - F0) * std.pow(1.0 - NdotV, 5.0);
    const glow = info.glow;

    // Reflections: studio softboxes, blurred toward the room tone with
    // roughness; smooth surfaces also see the scene itself.
    const R = std.reflect(rd, N);
    let env = envColor(R);
    if (rough < 0.35 && qualityUniforms.$.reflSteps > d.f32(0.0)) {
      const reflRo = pos + N * 0.003;
      const refl = rayMarchReflection(reflRo, R);
      if (refl.x <= RAY_MISS_T) {
        const pRefl = reflRo + R * refl.x;
        env = envColor(std.reflect(R, calcNormalCheap(pRefl, refl.y))) * 0.5;
      }
    }
    env = std.mix(env, d.vec3f(0.1), std.clamp(rough * 1.3, 0.0, 1.0));
    col = col + env * Fr * ao;
    return d.vec4f(std.pow(acesTonemap(col), d.vec3f(1.0 / 2.2)), glow);
  };

  const rayMarch = (ro: d.v3f, rd: d.v3f): d.v2f => {
    "use gpu";
    // Bounding-sphere gate: rays that miss the scene skip marching entirely,
    // rays that hit start at the sphere entry instead of the camera.
    const bounds = rayBounds(ro, rd);
    if (bounds.y < 0.0) {
      return d.vec2f(RAY_MISS_T + 10.0, 0.0);
    }
    let t = bounds.x;
    let iterations = d.f32(0.0);
    let dist = d.f32(0.0);
    for (let i = d.f32(0.0); i < qualityUniforms.$.maxSteps; i += d.f32(1.0)) {
      const p = ro + rd * t;
      dist = sdScene(p);
      iterations += 1.0;
      t += dist;
      if (dist < HIT_EPS * std.max(t, 1.0)) {
        return d.vec2f(t, iterations);
      }
      if (t > bounds.y) {
        return d.vec2f(RAY_MISS_T + 10.0, iterations);
      }
    }
    if (dist < REST_HIT_EPS) {
      return d.vec2f(t, iterations);
    }
    return d.vec2f(RAY_MISS_T + 10.0, iterations);
  };

  // ── Reference grid on the y = 0 plane (Blender-style: lines only) ──

  /** Anti-aliased grid line coverage for grid coords `g` with pixel footprint `w`. */
  const gridCoverage = (g: d.v2f, w: d.v2f): number => {
    "use gpu";
    const a = std.abs(std.fract(g - 0.5) - 0.5) / std.max(w, d.vec2f(0.0001));
    return 1.0 - std.clamp(std.min(a.x, a.y), 0.0, 1.0);
  };

  /** Coverage of the single line coord = 0 (a world axis on the grid). */
  const axisCoverage = (coord: number, w: number): number => {
    "use gpu";
    return 1.0 - std.clamp(std.abs(coord) / std.max(w, 0.0001), 0.0, 1.0);
  };

  const rot2D = (angle: number): d.m2x2f => {
    "use gpu";
    const c = std.cos(angle);
    const s = std.sin(angle);
    return d.mat2x2f(c, -s, s, c);
  };

  const fragment = ({ uv }: { uv: d.v2f }) => {
    "use gpu";

    const pickPass = pickUniforms.$.pickPass;
    const isScenePickPass = pickPass === d.u32(PICK_PASS_SCENE);
    const isGizmoPickPass = pickPass === d.u32(PICK_PASS_GIZMO);
    const sampleUv = d.vec2f(uv.x, uv.y);
    const uvn = sampleUv * 2.0 - d.vec2f(1.0, 1.0);
    const uvCorrected = d.vec2f(uvn.x * cameraUniforms.$.aspect, uvn.y);
    let ro = d.vec3f(0, 0, 0 - cameraUniforms.$.distance);
    let rd = std.normalize(d.vec3f(uvCorrected.x, uvCorrected.y, 1.0));

    const rotH = rot2D(cameraUniforms.$.mouse.x);
    const roXZ = rotH * d.vec2f(ro.x, ro.z);
    ro = d.vec3f(roXZ.x, ro.y, roXZ.y);
    const rdXZ = rotH * d.vec2f(rd.x, rd.z);
    rd = d.vec3f(rdXZ.x, rd.y, rdXZ.y);

    const rotV = rot2D(cameraUniforms.$.mouse.y);
    const roYZ = rotV * d.vec2f(ro.y, ro.z);
    ro = d.vec3f(ro.x, roYZ.x, roYZ.y);
    const rdYZ = rotV * d.vec2f(rd.y, rd.z);
    rd = d.vec3f(rd.x, rdYZ.x, rdYZ.y);

    // Grid plane hit + line coverage. fwidth needs uniform control flow, so
    // this runs for every pixel before any branching; misses get a far t.
    const flatRay = std.abs(rd.y) < 0.0001;
    const tPlaneRaw = (0.0 - ro.y) / std.select(rd.y, d.f32(0.0001), flatRay);
    const tPlane = std.select(
      d.f32(RAY_MISS_T + 10.0),
      tPlaneRaw,
      !flatRay && tPlaneRaw > 0.0,
    );
    const gridP = ro + rd * std.min(tPlane, RAY_MISS_T);
    const gridXZ = d.vec2f(gridP.x, gridP.z);
    const minorW = std.fwidth(gridXZ * 4.0);
    const majorW = std.fwidth(gridXZ);
    const minorGrid =
      gridCoverage(gridXZ * 4.0, minorW) *
      (1.0 - std.smoothstep(0.25, 0.6, std.max(minorW.x, minorW.y)));
    const majorGrid = gridCoverage(gridXZ, majorW * 1.5);
    const xAxisLine = axisCoverage(gridXZ.y, majorW.y * 2.0); // z = 0: the X axis
    const zAxisLine = axisCoverage(gridXZ.x, majorW.x * 2.0); // x = 0: the Z axis

    if (isGizmoPickPass) {
      if (gizmoUniforms.$.enabled !== d.u32(1)) {
        return d.vec4f(0.0, 0.0, 0.0, 0.0);
      }
      const gizmoPick = rayMarchGizmo(ro, rd);
      if (gizmoPick.x > RAY_MISS_T) {
        return d.vec4f(0.0, 0.0, 0.0, 0.0);
      }
      const idNorm = gizmoPick.y / 255.0;
      return d.vec4f(idNorm, idNorm, idNorm, 1.0);
    }

    // One march serves the pick pass and the image: each call site inlines
    // the generated scene SDF again.
    const sceneResult = rayMarch(ro, rd);
    const tScene = sceneResult.x;

    if (isScenePickPass) {
      const tPick = tScene;
      if (tPick > RAY_MISS_T) {
        return d.vec4f(0.0, 0.0, 0.0, 0.0);
      }
      const hitP = ro + rd * tPick;
      // 16-bit id; low byte in R and B so BGRA and RGBA targets read the same.
      const id = sceneInfoSlot.$(hitP).id;
      const hi = std.floor(id / 256.0);
      const lo = (id - hi * 256.0) / 255.0;
      return d.vec4f(lo, hi / 255.0, lo, 1.0);
    }

    const sceneHit = tScene <= RAY_MISS_T;

    // Background: super-dark gray vertical gradient + vignette (sRGB direct)
    const gradT = std.clamp(uvn.y * 0.5 + 0.5, 0.0, 1.0);
    const bg = std.mix(
      d.vec3f(0.055, 0.055, 0.055), // #0E0E0E bottom
      d.vec3f(0.118, 0.118, 0.118), // #1E1E1E top
      gradT,
    );
    const vig = 1.0 - 0.35 * std.dot(uvCorrected, uvCorrected) * 0.5;
    let col = bg * std.clamp(vig, 0.0, 1.0);

    if (sceneHit) {
      const pos = ro + rd * tScene;
      const N = calcNormal(pos);
      const viewDir = d.vec3f(-rd.x, -rd.y, -rd.z);

      // The scene info (material, glow) is fetched as late as possible: holding
      // it across a march loop that inlines the scene SDF costs registers.
      let glow = d.f32(0.0);
      if (renderModeSlot.$ === RENDER_MODE_CLASSIC) {
        // Classic: single light, no secondary marches — cheap.
        const info = sceneInfoSlot.$(pos);
        col = shadeClassic(N, viewDir, sceneResult.y, info);
        glow = info.glow;
      } else if (renderModeSlot.$ === RENDER_MODE_STUDIO) {
        const shaded = shadeStudio(pos, N, rd);
        col = d.vec3f(shaded.x, shaded.y, shaded.z);
        glow = shaded.w;
      } else {
        // Chrome: one real reflection bounce sees the scene itself.
        const R = std.reflect(rd, N);
        const reflRo = pos + N * 0.003;
        let reflCol = envColor(R);
        if (qualityUniforms.$.reflSteps > d.f32(0.0)) {
          const refl = rayMarchReflection(reflRo, R);
          if (refl.x <= RAY_MISS_T) {
            const pRefl = reflRo + R * refl.x;
            const nRefl = calcNormalCheap(pRefl, refl.y);
            // ponytail: second bounce is env-only, no third march — invisible past bounce 2
            reflCol = envColor(std.reflect(R, nRefl)) * 0.85;
          }
        }

        const ndv = std.max(std.dot(N, viewDir), 0.0);
        const fresnel = 0.55 + 0.45 * std.pow(1.0 - ndv, 5.0);

        // Crisp key highlight for extra sparkle
        const lightDir = std.normalize(d.vec3f(-1.5, -2.5, -2.0));
        const halfDir = std.normalize(lightDir + viewDir);
        const spec = std.pow(std.max(std.dot(N, halfDir), 0.0), 220.0) * 2.5;

        const ao = calcAO(pos, N);
        const info = sceneInfoSlot.$(pos);
        glow = info.glow;
        const hdr =
          (reflCol * fresnel + d.vec3f(spec, spec, spec)) * std.mix(0.5, 1.0, ao) +
          info.color * info.emission;
        // Tint after tonemapping so bright reflections keep the metal's hue.
        col =
          std.pow(acesTonemap(hdr), d.vec3f(1.0 / 2.2, 1.0 / 2.2, 1.0 / 2.2)) *
          chromeTint(info.color);
      }

      // Glow: a soft fresnel rim on selected shapes (constant) and on the
      // hovered one (cross-fading with the one just left); fades across joins.
      if (sceneUniforms.$.selectAll === d.u32(1)) {
        glow = d.f32(1.0);
      }
      if (glow > 0.0) {
        const rim = std.pow(1.0 - std.max(std.dot(N, viewDir), 0.0), 2.5);
        col = col + d.vec3f(0.55, 0.66, 0.85) * ((rim * 0.5 + 0.1) * glow);
      }
    }

    // Studio floor: the grid plane catches the key light's soft shadow and
    // contact occlusion around the scene (background pixels only).
    if (
      renderModeSlot.$ === RENDER_MODE_STUDIO &&
      !sceneHit &&
      tPlane <= RAY_MISS_T
    ) {
      const reach = sceneUniforms.$.boundsRadius;
      const near = 1.0 - std.smoothstep(reach * 0.6, reach * 2.2, std.length(gridXZ));
      if (near > 0.001) {
        const floorP = d.vec3f(gridP.x, -0.002, gridP.z);
        const L = std.normalize(d.vec3f(-1.2, -3.0, -1.6));
        const shadow = softShadow(floorP, L);
        const occl = calcAO(floorP, d.vec3f(0.0, -1.0, 0.0));
        const lightness = std.mix(0.35, 1.0, shadow) * std.mix(0.45, 1.0, occl);
        col = col * std.mix(1.0, lightness, near * 0.9) + d.vec3f(0.035) * (near * lightness);
      }
    }

    // Grid lines over the background, and over anything below the plane.
    if (tPlane <= RAY_MISS_T && (!sceneHit || tPlane < tScene)) {
      const fade =
        (1.0 - std.smoothstep(2.0, 7.0, std.length(gridXZ))) *
        std.smoothstep(0.02, 0.2, std.abs(rd.y));
      col = std.mix(col, d.vec3f(0.42), (minorGrid * 0.06 + majorGrid * 0.14) * fade);
      col = std.mix(col, d.vec3f(0.85, 0.3, 0.3), xAxisLine * 0.55 * fade);
      col = std.mix(col, d.vec3f(0.35, 0.52, 0.9), zAxisLine * 0.55 * fade);
    }

    if (gizmoUniforms.$.enabled === d.u32(1)) {
      const gizmoResult = rayMarchGizmo(ro, rd);
      const tGizmo = gizmoResult.x;
      const gizmoHit = tGizmo <= RAY_MISS_T;
      if (gizmoHit) {
        const gizmoPos = ro + rd * tGizmo;
        const eps = 0.001;
        const gx =
          evalGizmo(gizmoPos + d.vec3f(eps, 0.0, 0.0)).x -
          evalGizmo(gizmoPos - d.vec3f(eps, 0.0, 0.0)).x;
        const gy =
          evalGizmo(gizmoPos + d.vec3f(0.0, eps, 0.0)).x -
          evalGizmo(gizmoPos - d.vec3f(0.0, eps, 0.0)).x;
        const gz =
          evalGizmo(gizmoPos + d.vec3f(0.0, 0.0, eps)).x -
          evalGizmo(gizmoPos - d.vec3f(0.0, 0.0, eps)).x;
        const gN = std.normalize(d.vec3f(gx, gy, gz));
        const viewDir = std.normalize(d.vec3f(-rd.x, -rd.y, -rd.z));
        const rim = std.pow(1.0 - std.abs(std.dot(gN, viewDir)), 1.5) * 0.35;
        const axisCol = gizmoAxisColor(gizmoResult.y);
        const gizmoLit = axisCol * (0.85 + rim);
        col = std.mix(col, gizmoLit, d.f32(0.92));
      }
    }

    return d.vec4f(col, 1.0);
  };

  /**
   * Render pipeline for one compiled scene (sceneCompiler.ts `code`). The
   * caller owns caching and async init; buffers above are shared by all.
   */
  function createScenePipeline(code: string, renderMode: number) {
    const decl = tgpu["~unstable"].declare(code).$uses({
      [DATA_IDENT]: sceneData,
      [IMAGE_TEX_IDENT]: imageSdfView,
      [IMAGE_SAMPLER_IDENT]: imageSdfSampler,
    });
    const sdf = tgpu.fn([d.vec3f, d.f32], d.f32)`(p, standIn) { DS_SCENE return ds_sdScene(p, standIn); }`.$uses({
      DS_SCENE: decl,
    });
    const info = tgpu.fn([d.vec3f], SceneInfo)`(p) {
      DS_SCENE let i = ds_sceneInfo(p);
      return Info(i.glow, i.id, i.color, i.roughness, i.metalness, i.emission);
    }`.$uses({ DS_SCENE: decl, Info: SceneInfo });
    return root
      .with(sceneSdfSlot, sdf)
      .with(sceneInfoSlot, info)
      .with(renderModeSlot, renderMode)
      .createRenderPipeline({
        vertex: fullScreenTriangle,
        fragment,
      });
  }

  return {
    createScenePipeline,
    cameraUniforms,
    sceneUniforms,
    gizmoUniforms,
    pickUniforms,
    qualityUniforms,
    sceneData,
    imageSdfTexture,
  };
}
