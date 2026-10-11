import { useEffect, type RefObject } from "react";
import { tgpu, d } from "typegpu";
import {
  createShader,
  PICK_DEPTH_RANGE,
  PICK_PASS_DEPTH,
  PICK_PASS_GIZMO,
  PICK_PASS_SCENE,
  RENDER_MODE_CHROME,
  RENDER_MODE_CLASSIC,
  RENDER_MODE_COST,
  RENDER_MODE_FIELD,
  RENDER_MODE_NEON,
  RENDER_MODE_NORMALS,
  RENDER_MODE_STUDIO,
  RENDER_MODE_VOLUME,
} from "./shader";
import {
  useSceneStore,
  collectImageSdfs,
  findItem,
  topLevelSelection,
  pauseHistory,
  validateRoot,
  resumeHistory,
  MAX_IMAGES,
  type ObjectGroup,
  type SceneItem,
  type SceneRoot,
} from "../store/sceneStore";
import { useGizmoStore } from "../store/gizmoStore";
import { useRenderStore, type RenderMode } from "../store/renderStore";
import { DEFAULT_VIEW, useViewStore } from "../store/viewStore";
import { QUALITY_PRESETS, dprForPreset } from "../utils/quality";
import { clientToPickPixel, computeCameraRayFromClient, getCanvasAspect, type Vec3 } from "./camera";
import {
  applyScaleFactorToItem,
  applyWorldRotationToItem,
  axisDeltaFromScreenDrag,
  beginAxisScreenDrag,
  beginRingDrag,
  beginScaleDrag,
  beginGroupDrag,
  getSelectionGizmoFrame,
  groupRotatePatches,
  groupScalePatches,
  groupTranslatePatches,
  type GroupDragTarget,
  ringTotalAngleFromScreenDrag,
  scaleFactorFromScreenDrag,
  getItemAncestorGroups,
  GIZMO_MODE_ROTATE,
  GIZMO_MODE_SCALE,
  GIZMO_MODE_TRANSLATE,
  GIZMO_ARROW_LENGTH_RATIO,
  gizmoVisualScaleForDistance,
  isGizmoAxisNearScreen,
  pickGizmoAxisScreen,
  stabilizeGizmoHoverAxis,
  type GizmoPickMode,
  worldToItemLocalPosition,
  type AxisScreenDragState,
  type GizmoAxis,
  type GizmoHandle,
  type RingDragState,
  type ScaleDragState,
} from "./gizmo";
import { compileScene, sceneUsesTime as compileUsesTime, type CompiledScene } from "./sceneCompiler";
import { evaluateAnimations, hasAnimation } from "../store/animation";
import { useTimelineStore } from "../store/timelineStore";
import { useTryStore } from "../store/tryStore";
import {
  PREVIEW_STROKE_ID,
  finishLine,
  planStroke,
  useBrushCursor,
  useBrushStore,
  withPreviewLine,
  withStrokeLine,
  type BrushMode,
  type StrokePlan,
} from "../scene/sculpt";
import { MAX_STROKE_POINTS } from "../sdf/stroke";
import { sceneFrameSphere } from "../sdf/itemBounds";
import { showToast } from "../utils/toast";
import {
  easeToward,
  hasInteraction,
  interactiveSlots,
  reactionOffsets,
  slotChain,
  type InteractionState,
  type InteractiveSlots,
} from "../store/interaction";
import { SpawnAnimator } from "./spawnAnim";
import { IMAGE_SDF_EMPTY_HALF, IMAGE_SDF_RES, decodeSdfPng } from "../utils/imageSdf";

type GizmoGpuPickResult = {
  axis: GizmoHandle | null;
  skipped: boolean;
};

/**
 * Image SDF data URL → texture array layer. Rebuilt by syncImageSlots before
 * every compile so the scene data can reference the layer. Module-level
 * because there is one GPU root per app.
 */
const imageSlots = new Map<string, number>();

/** Drops unused slots, assigns free ones to new images. Returns the new pairs. */
function syncImageSlots(sceneRoot: SceneRoot): [string, number][] {
  const used = collectImageSdfs(sceneRoot.items);
  for (const sdf of imageSlots.keys()) if (!used.has(sdf)) imageSlots.delete(sdf);
  const taken = new Set(imageSlots.values());
  const added: [string, number][] = [];
  for (const sdf of used) {
    if (imageSlots.has(sdf)) continue;
    let slot = 0;
    while (slot < MAX_IMAGES && taken.has(slot)) slot++;
    if (slot >= MAX_IMAGES) break; // over cap (hostile hash): extra images render slot 0
    taken.add(slot);
    imageSlots.set(sdf, slot);
    added.push([sdf, slot]);
  }
  return added;
}

const COMPILE_OPTIONS = { imageLayer: (sdf: string) => imageSlots.get(sdf) ?? 0 };

/** Compiled pipelines kept for quick undo/redo across structural edits. */
const PROGRAM_CACHE_SIZE = 12;

const DRAG_THRESHOLD_PX = 4;
const PICK_READBACK_BYTES_PER_ROW = 256;

const GIZMO_AXIS_DIR: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const GIZMO_AXIS_ID: Record<GizmoHandle, number> = {
  x: 1,
  y: 2,
  z: 3,
  c: 4,
};

function axisIdToCursor(axis: GizmoHandle | null): string {
  if (!axis) return "default";
  if (axis === "x") return "ew-resize";
  if (axis === "y") return "ns-resize";
  return "nwse-resize";
}

/** Scene pick id: low byte in R and B (BGRA/RGBA agnostic), high byte in G. */
function readPickIdFromBytes(data: Uint8Array): number {
  return (data[0] ?? 0) + 256 * (data[1] ?? 0);
}

const PICK_AXIS_ID: Record<number, GizmoHandle> = {
  1: "x",
  2: "y",
  3: "z",
  4: "c",
};

function axisFromPickByte(pickId: number): GizmoHandle | null {
  return PICK_AXIS_ID[pickId] ?? null;
}

export function useGpu(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let animFrameId = 0;
    let registeredCleanup: (() => void) | undefined;

    tgpu.init().then((root) => {
      if (cancelled) {
        root.destroy();
        return;
      }

      const context = root.configureContext({
        canvas,
        alphaMode: "premultiplied",
      });

      const shader = createShader(root);
      const {
        cameraUniforms,
        sceneUniforms,
        gizmoUniforms,
        pickUniforms,
        qualityUniforms,
        sceneData,
        strokeData,
        imageSdfTexture,
      } = shader;
      const sceneDataGpu = root.unwrap(sceneData.buffer);
      const strokeDataGpu = root.unwrap(strokeData.buffer);
      /** Last stroke data uploaded (skip the upload when a scene has the same). */
      let writtenStrokes: Float32Array | null = null;

      // ── Compiled scene programs ──
      // Structure → WGSL (sceneCompiler.ts). Each distinct code string gets
      // its own pipeline, compiled off the critical path with initAsync; the
      // previous program keeps drawing (with its own values) until the new
      // one is ready, so structural edits never stall a frame.
      type ScenePipeline = ReturnType<typeof shader.createScenePipeline>;
      type Program = { code: string; pipeline: ScenePipeline; ready: boolean; failed: boolean };
      const programs = new Map<string, Program>(); // insertion order = LRU
      /** Counters for tests and perf probes. */
      const stats = { compiles: 0, draws: 0 };
      /** Program on screen + the compiled scene whose layout its data follows. */
      let active: { program: Program; scene: CompiledScene } | null = null;
      /** Newest compile of the drawn root; becomes active once its program is ready. */
      let latest: CompiledScene | null = null;
      let latestRoot: SceneRoot | null = null;
      let dataDirty = true;

      const MODE_IDS: Record<RenderMode, number> = {
        classic: RENDER_MODE_CLASSIC,
        chrome: RENDER_MODE_CHROME,
        studio: RENDER_MODE_STUDIO,
        neon: RENDER_MODE_NEON,
        volume: RENDER_MODE_VOLUME,
        field: RENDER_MODE_FIELD,
        cost: RENDER_MODE_COST,
        normals: RENDER_MODE_NORMALS,
      };
      const modeId = (mode: RenderMode) => MODE_IDS[mode] ?? RENDER_MODE_CLASSIC;

      /** Programs are per (render mode, scene code): see renderModeSlot in shader.ts. */
      function programFor(code: string, mode: RenderMode): Program {
        const key = `${mode}\n${code}`;
        const cached = programs.get(key);
        if (cached) {
          programs.delete(key);
          programs.set(key, cached);
          return cached;
        }
        const prog: Program = {
          code: key,
          pipeline: shader.createScenePipeline(code, modeId(mode)),
          ready: false,
          failed: false,
        };
        stats.compiles++;
        programs.set(key, prog);
        prog.pipeline.initAsync().then(
          () => {
            prog.ready = true;
          },
          (err: unknown) => {
            prog.failed = true;
            console.error("scene shader failed to compile", err);
          },
        );
        for (const k of programs.keys()) {
          if (programs.size <= PROGRAM_CACHE_SIZE) break;
          if (k !== active?.program.code && k !== key) programs.delete(k);
        }
        return prog;
      }

      /** Highlight strength per node: selection 1, hover cross-fade 0..1. */
      function writeMarks(scene: CompiledScene) {
        const v = scene.values;
        for (const index of scene.markIndex.values()) v[index] = 0;
        if (useTryStore.getState().trying) return; // the scene as the viewer sees it
        const { root: sceneRoot, selectedIds } = useSceneStore.getState();
        for (const id of topLevelSelection(sceneRoot, selectedIds)) {
          const index = scene.markIndex.get(id);
          if (index !== undefined) v[index] = 1;
        }
        for (const g of [glowCur, glowPrev]) {
          const index = g.id ? scene.markIndex.get(g.id) : undefined;
          if (index !== undefined) v[index] = Math.max(v[index], g.s);
        }
      }

      /**
       * Compile the drawn root when it changed, promote a ready program, and
       * upload values that match the active program's layout.
       */
      let writtenTime = -1;

      function syncSceneProgram(drawnRoot: SceneRoot, renderMode: RenderMode, time: number): boolean {
        if (drawnRoot !== latestRoot) {
          uploadImageSlots(drawnRoot);
          latest = compileScene(drawnRoot, COMPILE_OPTIONS);
          latestRoot = drawnRoot;
          dataDirty = true;
        }
        const wantKey = latest ? `${renderMode}\n${latest.code}` : "";
        if (latest && wantKey !== active?.program.code) {
          const prog = programFor(latest.code, renderMode);
          if (prog.ready) {
            active = { program: prog, scene: latest };
            pickItemIds = latest.leafIds;
            dataDirty = true;
          }
        } else if (latest && active && active.scene !== latest) {
          active = { program: active.program, scene: latest };
          pickItemIds = latest.leafIds;
        }
        if (!active || (!dataDirty && time === writtenTime)) return false;
        const scene = active.scene;
        if (dataDirty) {
          writeMarks(scene);
          root.device.queue.writeBuffer(sceneDataGpu, 0, scene.values);
          if (scene.strokes !== writtenStrokes && scene.strokes.length > 0) {
            root.device.queue.writeBuffer(strokeDataGpu, 0, scene.strokes);
          }
          writtenStrokes = scene.strokes;
        }
        const { rootSelected } = useSceneStore.getState();
        sceneUniforms.write({
          boundsRadius: scene.boundsRadius,
          skipLeaf: 0,
          selectAll: rootSelected && scene.leafIds.length > 0 && !useTryStore.getState().trying ? 1 : 0,
          time,
          boundsCenter: d.vec3f(0, 0, 0),
          sliceY: useRenderStore.getState().sliceY,
        });
        writtenTime = time;
        dataDirty = false;
        return true;
      }

      // CPU mirror of the image SDF texture array (f16 bit patterns); "far
      // outside" so an empty or still-decoding slot renders as nothing.
      const imageTexels = new Uint16Array(IMAGE_SDF_RES * IMAGE_SDF_RES * MAX_IMAGES).fill(
        IMAGE_SDF_EMPTY_HALF,
      );
      imageSdfTexture.write(imageTexels);
      imageSlots.clear();

      /** Bumped when a decoded image lands in the texture (forces a redraw). */
      let imagesVersion = 0;

      function uploadImageSlots(sceneRoot: SceneRoot) {
        const added = syncImageSlots(sceneRoot);
        if (added.length === 0) return;
        const layerTexels = IMAGE_SDF_RES * IMAGE_SDF_RES;
        for (const [, slot] of added) {
          imageTexels.fill(IMAGE_SDF_EMPTY_HALF, slot * layerTexels, (slot + 1) * layerTexels);
        }
        imageSdfTexture.write(imageTexels);
        for (const [sdf, slot] of added) {
          decodeSdfPng(sdf).then(
            (texels) => {
              if (cancelled || imageSlots.get(sdf) !== slot) return;
              imageTexels.set(texels, slot * layerTexels);
              imageSdfTexture.write(imageTexels);
              imagesVersion++;
            },
            () => {
              /* undecodable PNG (hostile hash): slot stays empty */
            },
          );
        }
      }

      const pickFormat = navigator.gpu.getPreferredCanvasFormat();
      let pickTexture = root.device.createTexture({
        size: [1, 1],
        format: pickFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      let pickTextureView = pickTexture.createView();
      const pickReadbackBuffer = root.device.createBuffer({
        size: PICK_READBACK_BYTES_PER_ROW,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      function resizePickTarget(width: number, height: number) {
        pickTexture.destroy();
        pickTexture = root.device.createTexture({
          size: [width, height],
          format: pickFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        pickTextureView = pickTexture.createView();
      }

      let pickItemIds: string[] = [];

      let pointerDown = false;
      let dragged = false;
      let dragStartX = 0;
      let dragStartY = 0;
      // Looking down at the scene (+y is down on screen), grid plane in view.
      let rotX = DEFAULT_VIEW.rotX;
      let rotY = DEFAULT_VIEW.rotY;
      let distance = DEFAULT_VIEW.distance;
      useViewStore.setState({ ...DEFAULT_VIEW });
      const publishView = () => useViewStore.setState({ rotX, rotY, distance });
      // Wheel zoom fires in bursts: publish once it settles.
      let publishTimer: ReturnType<typeof setTimeout> | undefined;
      const publishViewSoon = () => {
        clearTimeout(publishTimer);
        publishTimer = setTimeout(publishView, 250);
      };
      /** Live orbit preview while dragging; cleared on pointer up. */
      let orbitPreviewMouse: ReturnType<typeof d.vec2f> | null = null;
      let orbitPreviewRot: [number, number] | null = null;

      function getCameraRot(): [number, number] {
        return orbitPreviewRot ?? [rotX, rotY];
      }

      let lastSelectedIds: string[] = [];
      let lastRootSelected = false;
      let lastRenderMode: RenderMode | null = null;
      let lastQuality = useRenderStore.getState().quality;
      let targetMs = 1000 / QUALITY_PRESETS[lastQuality].fpsCap;
      let pickInProgress = false;

      let gizmoDragging = false;
      let gizmoHoverAxis: GizmoHandle | null = null;
      let gizmoDragAxis: GizmoHandle | null = null;
      let gizmoDragStartWorld: [number, number, number] | null = null;
      let gizmoDragScreen: AxisScreenDragState | null = null;
      let gizmoDragRing: RingDragState | null = null;
      let gizmoDragScale: ScaleDragState | null = null;
      let gizmoDragItemId: string | null = null;
      let gizmoDragAncestors: ObjectGroup[] | null = null;
      /** Set when the drag drives a multi-selection (world-space pivot). */
      let gizmoDragGroup: GroupDragTarget[] | null = null;

      let hoverGpuSeq = 0;
      let hoverPickRunning = false;
      let pendingHoverPick: {
        x: number;
        y: number;
        seq: number;
      } | null = null;

      function isGizmoVisibleMode(): boolean {
        if (useTryStore.getState().trying || useBrushStore.getState().active) return false;
        const mode = useGizmoStore.getState().mode;
        return mode === "translate" || mode === "rotate" || mode === "scale";
      }

      function gizmoModeUniform(): number {
        const mode = useGizmoStore.getState().mode;
        if (mode === "rotate") return GIZMO_MODE_ROTATE;
        if (mode === "scale") return GIZMO_MODE_SCALE;
        return GIZMO_MODE_TRANSLATE;
      }

      function gizmoPickMode(): GizmoPickMode {
        return useGizmoStore.getState().mode;
      }

      function writeGizmoDisabled() {
        gizmoUniforms.write({
          enabled: 0,
          activeAxis: 0,
          mode: 0,
          _pad0: 0,
          position: d.vec3f(0, 0, 0),
          _pad: 0,
          scale: 0,
          axisX: d.vec3f(1, 0, 0),
          _padX: 0,
          axisY: d.vec3f(0, 1, 0),
          _padY: 0,
          axisZ: d.vec3f(0, 0, 1),
          _padZ: 0,
        });
      }

      function clearGizmoInteraction() {
        if (gizmoDragging) endGizmoDrag();
        gizmoHoverAxis = null;
        hoverGpuSeq += 1;
        pendingHoverPick = null;
        canvas!.style.cursor = "default";
      }

      function selectionGizmoFrame(sceneRoot: SceneRoot) {
        const { selectedIds, selectedItemId } = useSceneStore.getState();
        return getSelectionGizmoFrame(sceneRoot, selectedIds, selectedItemId);
      }

      function updateGizmoUniforms(
        sceneRoot: SceneRoot,
        cameraDistance: number,
        activeAxis: GizmoHandle | null,
      ) {
        const frame = isGizmoVisibleMode() ? selectionGizmoFrame(sceneRoot) : null;
        if (!frame) {
          writeGizmoDisabled();
          return;
        }
        const { pivot: pivotWorld, axes } = frame;

        const visualScale = gizmoVisualScaleForDistance(cameraDistance);
        gizmoUniforms.write({
          enabled: 1,
          activeAxis: activeAxis ? GIZMO_AXIS_ID[activeAxis] : 0,
          mode: gizmoModeUniform(),
          _pad0: 0,
          position: d.vec3f(pivotWorld[0], pivotWorld[1], pivotWorld[2]),
          _pad: 0,
          scale: visualScale,
          axisX: d.vec3f(axes.x[0], axes.x[1], axes.x[2]),
          _padX: 0,
          axisY: d.vec3f(axes.y[0], axes.y[1], axes.y[2]),
          _padY: 0,
          axisZ: d.vec3f(axes.z[0], axes.z[1], axes.z[2]),
          _padZ: 0,
        });
      }

      function setItemWorldPosition(
        itemId: string,
        worldPos: [number, number, number],
        ancestors: ObjectGroup[],
      ) {
        const found = findItem(useSceneStore.getState().root, itemId);
        if (!found) return;

        const localPos = worldToItemLocalPosition(worldPos, ancestors);
        const { updateLayer, updateGroup } = useSceneStore.getState();

        if (found.item.kind === "layer") {
          updateLayer(found.container.id, found.item.id, { position: localPos });
        } else {
          updateGroup(found.item.id, { position: localPos });
        }
      }

      /**
       * Runs the pick shader for the single pixel under the cursor (scissor)
       * and reads its id back. Callers own pickInProgress (one readback at a
       * time). pickPass is restored right after submit: queue writes are
       * ordered with submits, so normal frames keep drawing during readback.
       */
      async function readPickPixel(
        pickPass: number,
        clientX: number,
        clientY: number,
      ): Promise<number | null> {
        const bytes = await readPickBytes(pickPass, clientX, clientY);
        return bytes ? readPickIdFromBytes(bytes) : null;
      }

      /** One pixel of a pick pass, raw RGBA / BGRA bytes. */
      async function readPickBytes(
        pickPass: number,
        clientX: number,
        clientY: number,
      ): Promise<Uint8Array | null> {
        const px = clientToPickPixel(clientX, clientY, canvas!);
        const pipeline = active?.program.pipeline;
        if (!px || !pipeline) return null;
        pickUniforms.write({ pickPass });

        const encoder = root.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: pickTextureView, loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" },
          ],
        });
        pass.setScissorRect(px.x, px.y, 1, 1);
        pipeline.with(pass).draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: pickTexture, origin: { x: px.x, y: px.y, z: 0 } },
          { buffer: pickReadbackBuffer, bytesPerRow: PICK_READBACK_BYTES_PER_ROW },
          { width: 1, height: 1 },
        );
        root.device.queue.submit([encoder.finish()]);
        pickUniforms.write({ pickPass: 0 });
        await root.device.queue.onSubmittedWorkDone();

        await pickReadbackBuffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(pickReadbackBuffer.getMappedRange(0, 4)).slice();
        pickReadbackBuffer.unmap();
        return bytes;
      }

      async function pickGizmoAxisGpu(
        clientX: number,
        clientY: number,
      ): Promise<GizmoGpuPickResult> {
        if (pickInProgress) return { axis: null, skipped: true };
        if (!isGizmoVisibleMode()) return { axis: null, skipped: false };

        const { root: sceneRoot, selectedItemId } = useSceneStore.getState();
        if (!selectedItemId) return { axis: null, skipped: false };

        pickInProgress = true;
        try {
          syncCameraUniform();
          updateGizmoUniforms(sceneRoot, distance, gizmoHoverAxis);

          const pickId = await readPickPixel(PICK_PASS_GIZMO, clientX, clientY);
          if (pickId === null) return { axis: null, skipped: false };
          return { axis: axisFromPickByte(pickId), skipped: false };
        } finally {
          pickUniforms.write({ pickPass: 0 });
          pickInProgress = false;
        }
      }

      async function drainGizmoHoverPicks() {
        if (hoverPickRunning) return;
        hoverPickRunning = true;
        try {
          while (pendingHoverPick) {
            const pick = pendingHoverPick;
            pendingHoverPick = null;

            let result = await pickGizmoAxisGpu(pick.x, pick.y);
            while (result.skipped && pick.seq === hoverGpuSeq) {
              pendingHoverPick = pendingHoverPick ?? pick;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              if (pick.seq !== hoverGpuSeq) break;
              const latest = pendingHoverPick ?? pick;
              pendingHoverPick = null;
              result = await pickGizmoAxisGpu(latest.x, latest.y);
              if (latest.seq !== hoverGpuSeq) break;
            }

            if (pick.seq !== hoverGpuSeq) continue;
            if (result.skipped) continue;

            const frame = selectionGizmoFrame(useSceneStore.getState().root);
            if (!frame) {
              gizmoHoverAxis = null;
              canvas!.style.cursor = "default";
              continue;
            }

            const { pivot: pivotWorld, axes } = frame;
            const mode = gizmoPickMode();
            const [rx, ry] = getCameraRot();
            const gizmoScale = gizmoVisualScaleForDistance(distance);

            const stabilized = result.axis
              ? stabilizeGizmoHoverAxis(
                  pick.x,
                  pick.y,
                  canvas!,
                  rx,
                  ry,
                  distance,
                  pivotWorld,
                  gizmoScale,
                  result.axis,
                  gizmoHoverAxis,
                  mode,
                  axes,
                )
              : pickGizmoAxisScreen(
                  mode,
                  pick.x,
                  pick.y,
                  canvas!,
                  rx,
                  ry,
                  distance,
                  pivotWorld,
                  gizmoScale,
                  axes,
                  gizmoHoverAxis,
                );
            gizmoHoverAxis = stabilized;
            canvas!.style.cursor = axisIdToCursor(stabilized);
          }
        } finally {
          hoverPickRunning = false;
          if (pendingHoverPick) void drainGizmoHoverPicks();
        }
      }

      async function tryStartGizmoDrag(
        clientX: number,
        clientY: number,
      ): Promise<boolean> {
        if (!isGizmoVisibleMode()) return false;

        const sceneRoot = useSceneStore.getState().root;
        const frame = selectionGizmoFrame(sceneRoot);
        if (!frame) return false;
        // Single item: its own drag path below. Several: world-space group drag.
        const selectedItemId = frame.ids[0];
        const group = frame.ids.length > 1 ? beginGroupDrag(sceneRoot, frame.ids) : null;

        const found = findItem(sceneRoot, selectedItemId);
        if (!found) return false;

        const pivotWorld = frame.pivot;
        const ancestors = getItemAncestorGroups(sceneRoot, selectedItemId);
        if (ancestors === null) return false;

        const mode = gizmoPickMode();
        const axes = frame.axes;
        const [rx, ry] = getCameraRot();
        const gizmoScale = gizmoVisualScaleForDistance(distance);

        let axis: GizmoHandle | null = null;

        if (
          gizmoHoverAxis &&
          isGizmoAxisNearScreen(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            gizmoScale,
            gizmoHoverAxis,
            mode,
            axes,
          )
        ) {
          axis = gizmoHoverAxis;
        } else {
          const gpuPick = await pickGizmoAxisGpu(clientX, clientY);
          axis = gpuPick.axis
            ? stabilizeGizmoHoverAxis(
                clientX,
                clientY,
                canvas!,
                rx,
                ry,
                distance,
                pivotWorld,
                gizmoScale,
                gpuPick.axis,
                gizmoHoverAxis,
                mode,
                axes,
              )
            : pickGizmoAxisScreen(
                mode,
                clientX,
                clientY,
                canvas!,
                rx,
                ry,
                distance,
                pivotWorld,
                gizmoScale,
                axes,
                gizmoHoverAxis,
              );
        }
        if (!axis) return false;

        if (mode === "scale") {
          if (!axes) return false;
          const scaleDrag = beginScaleDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            axis,
            axes,
            gizmoScale,
            found.item.scale,
          );
          if (!scaleDrag) return false;

          gizmoDragging = true;
          gizmoDragAxis = axis;
          gizmoDragItemId = selectedItemId;
          gizmoDragGroup = group;
          gizmoDragAncestors = ancestors;
          gizmoDragStartWorld = pivotWorld;
          gizmoDragScreen = null;
          gizmoDragRing = null;
          gizmoDragScale = scaleDrag;
          gizmoHoverAxis = axis;
          pauseHistory();
          canvas!.style.cursor = axisIdToCursor(axis);
          return true;
        }

        // Center handle exists only on the scale gizmo.
        if (axis === "c") return false;

        if (mode === "rotate") {
          if (!axes) return false;
          const worldAxis = axes[axis];
          const ringDrag = beginRingDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            pivotWorld,
            worldAxis,
            axis,
            found.item.rotation,
          );
          if (!ringDrag) return false;

          gizmoDragging = true;
          gizmoDragAxis = axis;
          gizmoDragItemId = selectedItemId;
          gizmoDragGroup = group;
          gizmoDragAncestors = ancestors;
          gizmoDragStartWorld = pivotWorld;
          gizmoDragScreen = null;
          gizmoDragRing = ringDrag;
          gizmoDragScale = null;
          gizmoHoverAxis = axis;
          pauseHistory();
          canvas!.style.cursor = "grabbing";
          return true;
        }

        const axisDir = GIZMO_AXIS_DIR[axis];
        const dragScreen = beginAxisScreenDrag(
          clientX,
          clientY,
          canvas!,
          rx,
          ry,
          distance,
          pivotWorld,
          axisDir,
          gizmoScale * GIZMO_ARROW_LENGTH_RATIO,
        );
        if (!dragScreen) return false;

        gizmoDragging = true;
        gizmoDragAxis = axis;
        gizmoDragItemId = selectedItemId;
        gizmoDragGroup = group;
        gizmoDragAncestors = ancestors;
        gizmoDragStartWorld = pivotWorld;
        gizmoDragScreen = dragScreen;
        gizmoDragRing = null;
        gizmoDragScale = null;
        gizmoHoverAxis = axis;
        pauseHistory();
        canvas!.style.cursor = axisIdToCursor(axis);
        return true;
      }

      function updateGizmoDrag(clientX: number, clientY: number) {
        if (!gizmoDragging || !gizmoDragAxis || !gizmoDragItemId) {
          return;
        }

        const [rx, ry] = getCameraRot();

        if (gizmoDragScale) {
          const factor = scaleFactorFromScreenDrag(
            clientX,
            clientY,
            gizmoDragScale,
          );
          if (gizmoDragGroup && gizmoDragStartWorld) {
            useSceneStore.getState().updateTransforms(
              groupScalePatches(gizmoDragGroup, gizmoDragStartWorld, gizmoDragAxis, factor),
            );
            return;
          }
          applyScaleFactorToItem(
            useSceneStore.getState().root,
            gizmoDragItemId,
            gizmoDragScale,
            factor,
          );
          return;
        }

        if (gizmoDragRing) {
          const totalAngle = ringTotalAngleFromScreenDrag(
            clientX,
            clientY,
            canvas!,
            rx,
            ry,
            distance,
            gizmoDragRing,
          );
          if (totalAngle !== null && gizmoDragGroup) {
            gizmoDragRing.totalAngleRad = totalAngle; // unwrap reference for the next move
            useSceneStore.getState().updateTransforms(
              groupRotatePatches(
                gizmoDragGroup,
                gizmoDragRing.pivotWorld,
                gizmoDragRing.worldAxis,
                totalAngle,
              ),
            );
          } else if (totalAngle !== null) {
            applyWorldRotationToItem(
              useSceneStore.getState().root,
              gizmoDragItemId,
              totalAngle,
              gizmoDragRing,
            );
          }
          return;
        }

        if (
          !gizmoDragStartWorld ||
          !gizmoDragScreen ||
          !gizmoDragAncestors ||
          gizmoDragAxis === "c"
        ) {
          return;
        }

        const axisDir = GIZMO_AXIS_DIR[gizmoDragAxis];
        const deltaT = axisDeltaFromScreenDrag(
          clientX,
          clientY,
          gizmoDragScreen,
        );

        if (gizmoDragGroup) {
          useSceneStore.getState().updateTransforms(
            groupTranslatePatches(gizmoDragGroup, [
              axisDir[0] * deltaT,
              axisDir[1] * deltaT,
              axisDir[2] * deltaT,
            ]),
          );
          return;
        }

        const newPivot: [number, number, number] = [
          gizmoDragStartWorld[0] + axisDir[0] * deltaT,
          gizmoDragStartWorld[1] + axisDir[1] * deltaT,
          gizmoDragStartWorld[2] + axisDir[2] * deltaT,
        ];
        const freshAncestors = getItemAncestorGroups(
          useSceneStore.getState().root,
          gizmoDragItemId,
        );
        if (!freshAncestors) return;
        setItemWorldPosition(gizmoDragItemId, newPivot, freshAncestors);
      }

      function endGizmoDrag() {
        if (!gizmoDragging) return;
        gizmoDragging = false;
        gizmoDragAxis = null;
        gizmoDragStartWorld = null;
        gizmoDragScreen = null;
        gizmoDragRing = null;
        gizmoDragScale = null;
        gizmoDragItemId = null;
        gizmoDragAncestors = null;
        gizmoDragGroup = null;
        resumeHistory();
      }

      function updateGizmoHover(clientX: number, clientY: number) {
        if (!isGizmoVisibleMode()) {
          hoverGpuSeq += 1;
          pendingHoverPick = null;
          gizmoHoverAxis = null;
          canvas!.style.cursor = "default";
          return;
        }

        const { selectedItemId } = useSceneStore.getState();
        if (!selectedItemId) {
          hoverGpuSeq += 1;
          pendingHoverPick = null;
          gizmoHoverAxis = null;
          canvas!.style.cursor = "default";
          return;
        }

        const seq = ++hoverGpuSeq;
        pendingHoverPick = { x: clientX, y: clientY, seq };
        void drainGizmoHoverPicks();
      }

      /** `additive`: Cmd/Ctrl/Shift-click toggles the hit item in the selection. */
      async function pickAt(clientX: number, clientY: number, additive: boolean) {
        // Something else may select while the pick is in flight (a shape
        // added by hotkey): that newer selection wins over this click.
        const selectionAtClick = useSceneStore.getState().selectedIds.join("\n");
        // A hover pick runs on almost every mouse move; a click must wait for
        // it instead of being dropped (quick move-then-click lost selections).
        while (pickInProgress) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          if (cancelled) return;
        }
        pickInProgress = true;

        try {
          // Ids index the program that drew the pick; it may swap mid-readback.
          const ids = pickItemIds;
          const pickId = await readPickPixel(PICK_PASS_SCENE, clientX, clientY);
          if (pickId === null) return;

          const { root: sceneRoot, selectItem, toggleSelected, deselect, selectedIds } =
            useSceneStore.getState();
          if (selectedIds.join("\n") !== selectionAtClick) return;

          if (useTryStore.getState().trying) {
            if (pickId > 0 && ids[pickId - 1]) tryClick(ids[pickId - 1]);
            return;
          }

          if (pickId === 0) {
            if (!additive) deselect();
            return;
          }

          const itemId = ids[pickId - 1];
          if (!itemId) return;

          const found = findItem(sceneRoot, itemId);
          if (!found || found.item.kind !== "layer") return;

          if (additive) toggleSelected(itemId);
          else selectItem(found.container.id, itemId);
        } finally {
          pickUniforms.write({ pickPass: 0 });
          pickInProgress = false;
        }
      }

      // ── Sculpt: paint strokes onto surfaces (or into the air) ──
      type SculptStroke = {
        /** Set once the first pick lands (input before that waits in `pending`). */
        plan: StrokePlan | null;
        rootBefore: SceneRoot | null;
        /** Local points (x, y, z, r) of this stroke. */
        line: number[];
        last: Vec3 | null;
        /** Ray distance of the last point: the stroke continues at it off the surface. */
        depth: number;
        radius: number;
        /** Cursor samples waiting for their surface pick, oldest first. */
        pending: { x: number; y: number; pressure: number }[];
        busy: boolean;
        /** The button came up (possibly before the stroke got going). */
        ended: boolean;
      };
      /** The stroke under the pointer (input goes here); earlier ones may still be finishing. */
      let sculpt: SculptStroke | null = null;
      /** Strokes run one after another: each plans on the scene the previous one left. */
      let strokeChain: Promise<void> = Promise.resolve();
      /** The next store change is a live edit: no appear / vanish animation. */
      let quietRootChange = false;
      /** Ray distance under the cursor (brush ring size), null off the scene. */
      let sculptHoverDepth: number | null = null;

      const sculptActive = () => useBrushStore.getState().active && !useTryStore.getState().trying;

      /** Waits for the pick pipeline and runs `fn` with it. */
      async function withPick<T>(fn: () => Promise<T>): Promise<T | null> {
        while (pickInProgress) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          if (cancelled) return null;
        }
        pickInProgress = true;
        try {
          return await fn();
        } finally {
          pickUniforms.write({ pickPass: 0 });
          pickInProgress = false;
        }
      }

      /** Ray distance to the surface under (x, y); the stroke being painted does not count. */
      async function depthAt(x: number, y: number): Promise<number | null> {
        const skip = sculpt ? pickItemIds.indexOf(PREVIEW_STROKE_ID) + 1 : 0;
        if (skip) sceneUniforms.patch({ skipLeaf: skip });
        const b = await readPickBytes(PICK_PASS_DEPTH, x, y);
        if (skip) sceneUniforms.patch({ skipLeaf: 0 });
        if (!b) return null;
        // Low byte in R and B, high in G, middle in A (see PICK_PASS_DEPTH).
        const v = b[0] + b[3] * 256 + b[1] * 65536;
        return v === 0 ? null : ((v - 1) / 16777214) * PICK_DEPTH_RANGE;
      }

      function rayAt(x: number, y: number) {
        const [rx, ry] = getCameraRot();
        return computeCameraRayFromClient(x, y, canvas!, rx, ry, distance);
      }

      /** Pen pressure scales the brush; mouse and touch paint at full size. */
      const pressureScale = (e: PointerEvent) => (e.pointerType === "pen" ? 0.3 + 1.4 * Math.min(1, Math.max(0, e.pressure)) : 1);

      function sculptAddPoint(s: SculptStroke, world: Vec3, radius: number) {
        const plan = s.plan!;
        const spacing = radius * 0.3;
        const from = s.last;
        const steps = from ? Math.min(32, Math.floor(Math.hypot(world[0] - from[0], world[1] - from[1], world[2] - from[2]) / spacing)) : 1;
        if (from && steps < 1) return;
        for (let i = 1; i <= steps; i++) {
          const k = from ? i / steps : 1;
          const p: Vec3 = from
            ? [from[0] + (world[0] - from[0]) * k, from[1] + (world[1] - from[1]) * k, from[2] + (world[2] - from[2]) * k]
            : world;
          const local = plan.toLocal(p);
          s.line.push(local[0], local[1], local[2], radius * plan.localScale);
        }
        s.last = world;
        // Past the layer's room the preview stops growing; the end simplifies the line.
        if (s.line.length / 4 > MAX_STROKE_POINTS) return;
        const next = withPreviewLine(plan, s.line);
        if (!validateRoot(next)) {
          quietRootChange = true;
          useSceneStore.setState({ root: next });
        }
      }

      async function startSculpt(s: SculptStroke, e: PointerEvent) {
        const brush = useBrushStore.getState();
        const mode: BrushMode = e.altKey ? (brush.mode === "clay" ? "carve" : "clay") : brush.mode;
        const x = e.clientX;
        const y = e.clientY;
        const picked = await withPick(async () => ({
          id: await readPickPixel(PICK_PASS_SCENE, x, y),
          t: await depthAt(x, y),
          ids: pickItemIds,
        }));
        const ray = rayAt(x, y);
        if (!picked || !ray) {
          if (sculpt === s) sculpt = null;
          return;
        }
        const state = useSceneStore.getState();
        const hitId = picked.t !== null && picked.id ? (picked.ids[picked.id - 1] ?? null) : null;
        const plan = planStroke(state.root, hitId, { ...brush, mode }, state.selectedContainerId, () => crypto.randomUUID());
        if (!plan) {
          if (sculpt === s) sculpt = null;
          if (mode === "carve" && !hitId) showToast("Carve on a surface");
          return;
        }
        // Off the scene: paint on the plane through the scene center that faces the camera.
        let t = picked.t;
        if (t === null) {
          const sphere = sceneFrameSphere(state.root.items);
          const c = sphere?.c ?? [0, 0, 0];
          t = Math.max(0.2, (c[0] - ray.origin[0]) * ray.direction[0] + (c[1] - ray.origin[1]) * ray.direction[1] + (c[2] - ray.origin[2]) * ray.direction[2]);
        }
        pauseHistory();
        s.plan = plan;
        s.rootBefore = state.root;
        s.depth = t;
        const first = s.pending.shift();
        s.radius = brush.radius * (first?.pressure ?? 1);
        sculptAddPoint(s, [ray.origin[0] + ray.direction[0] * t, ray.origin[1] + ray.direction[1] * t, ray.origin[2] + ray.direction[2] * t], s.radius);
        await drainSculpt(s);
        if (s.ended) await endSculpt(s);
      }

      async function drainSculpt(s: SculptStroke) {
        if (!s.plan || s.busy) return;
        s.busy = true;
        try {
          while (s.pending.length > 0) {
            const { x, y, pressure } = s.pending.shift()!;
            const t = await withPick(() => depthAt(x, y));
            const ray = rayAt(x, y);
            if (!ray) break;
            // Off the surface the line goes on at the depth it had.
            const k = t ?? s.depth;
            if (t !== null) s.depth = t;
            const r = useBrushStore.getState().radius * pressure;
            sculptAddPoint(s, [ray.origin[0] + ray.direction[0] * k, ray.origin[1] + ray.direction[1] * k, ray.origin[2] + ray.direction[2] * k], r);
          }
        } finally {
          s.busy = false;
        }
      }

      async function endSculpt(s: SculptStroke) {
        s.ended = true;
        if (!s.plan) return; // startSculpt finishes it
        while (s.busy || s.pending.length > 0) {
          if (!s.busy) await drainSculpt(s);
          else await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        if (sculpt === s) sculpt = null;
        const line = finishLine(s.line, s.radius * s.plan.localScale);
        const done = line.length >= 4 ? withStrokeLine(s.plan.root, s.plan, line) : null;
        quietRootChange = true;
        useSceneStore.setState({ root: done && !validateRoot(done) ? done : s.rootBefore! });
        resumeHistory();
      }

      async function updateSculptHover(x: number, y: number) {
        if (sculpt || pickInProgress) return;
        sculptHoverDepth = await withPick(() => depthAt(x, y));
      }

      /** Screen radius (CSS px) of the brush at the cursor, for the ring overlay. */
      function brushRingPx(): number {
        const rect = canvas!.getBoundingClientRect();
        const depth = sculpt?.depth ?? sculptHoverDepth ?? distance;
        return (useBrushStore.getState().radius / Math.max(depth, 0.05)) * (rect.height / 2);
      }

      const onPointerDown = (e: PointerEvent) => {
        if (sculptActive()) {
          // Sculpt: left paints, right / ⌘ / Ctrl + left orbits.
          const orbit = e.button === 2 || (e.button === 0 && (e.metaKey || e.ctrlKey));
          if (e.button === 0 && !orbit) {
            if (sculpt && !sculpt.ended) return;
            canvas!.setPointerCapture(e.pointerId);
            const s: SculptStroke = {
              plan: null, rootBefore: null, line: [], last: null, depth: distance, radius: 0,
              pending: [{ x: e.clientX, y: e.clientY, pressure: pressureScale(e) }], busy: false, ended: false,
            };
            sculpt = s;
            strokeChain = strokeChain.then(() => startSculpt(s, e)).catch((err) => console.error(err));
            return;
          }
          if (!orbit) return;
          pointerDown = true;
          dragged = false;
          orbitPreviewMouse = null;
          orbitPreviewRot = null;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          return;
        }
        if (e.button !== 0) return;
        void tryStartGizmoDrag(e.clientX, e.clientY).then((started) => {
          if (started) return;
          pointerDown = true;
          dragged = false;
          orbitPreviewMouse = null;
          orbitPreviewRot = null;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
        });
      };

      // ── Try mode: hover / click / pointer drive reactions (like the embed) ──
      let ixSlots: InteractiveSlots | null = null;
      let ixSlotsFor: SceneRoot | null = null;
      const ixHover = new Map<string, number>();
      const ixClick = new Map<string, number>();
      /** Items toggled on by clicks (ids). */
      const ixClicked = new Set<string>();
      const ixPointer: [number, number] = [0, 0];
      const ixPointerTo: [number, number] = [0, 0];
      let ixState: InteractionState | null = null;

      function slotsFor(sceneRoot: SceneRoot): InteractiveSlots | null {
        if (sceneRoot !== ixSlotsFor) {
          ixSlots = hasInteraction(sceneRoot.items) ? interactiveSlots(sceneRoot.items) : null;
          ixSlotsFor = sceneRoot;
        }
        return ixSlots;
      }

      /** The interactive items a shape belongs to: its own slot and its interactive ancestors'. */
      function interactiveChain(sceneRoot: SceneRoot, shapeId: string): string[] {
        const slots = slotsFor(sceneRoot);
        if (!slots) return [];
        const path = [...(getItemAncestorGroups(sceneRoot, shapeId) ?? []).map((g) => g.id), shapeId];
        for (let i = path.length - 1; i >= 0; i--) {
          const slot = slots.slot.get(path[i]);
          if (slot !== undefined) return slotChain(slots, slot).map((s) => slots.ids[s]);
        }
        return [];
      }

      function tryClick(shapeId: string) {
        const sceneRoot = useSceneStore.getState().root;
        const slots = slotsFor(sceneRoot);
        if (!slots) return;
        for (const id of interactiveChain(sceneRoot, shapeId)) {
          if (!slots.clickable[slots.slot.get(id)!]) continue;
          if (ixClicked.has(id)) ixClicked.delete(id);
          else ixClicked.add(id);
        }
      }

      /**
       * Eases every state toward what the viewer is doing (all back to rest
       * outside Try mode). Returns the state to draw with, null at rest.
       */
      function stepInteraction(sceneRoot: SceneRoot, dt: number): InteractionState | null {
        const trying = useTryStore.getState().trying;
        if (!trying) {
          ixClicked.clear();
          ixPointerTo[0] = 0;
          ixPointerTo[1] = 0;
        }
        const hovered = new Set(trying && hoverItemId ? interactiveChain(sceneRoot, hoverItemId) : []);
        let moving = false;
        const step = (states: Map<string, number>, on: Set<string>) => {
          for (const id of on) if (!states.has(id)) states.set(id, 0);
          for (const [id, v] of states) {
            const next = easeToward(v, on.has(id) ? 1 : 0, dt);
            if (next === 0 && !on.has(id)) states.delete(id);
            else states.set(id, next);
            if (next !== v) moving = true;
          }
        };
        step(ixHover, hovered);
        step(ixClick, ixClicked);
        for (let a = 0; a < 2; a++) {
          const next = easeToward(ixPointer[a], ixPointerTo[a], dt);
          if (next !== ixPointer[a]) moving = true;
          ixPointer[a] = next;
        }
        const atRest = ixHover.size === 0 && ixClick.size === 0 && ixPointer[0] === 0 && ixPointer[1] === 0;
        if (atRest) {
          ixState = null;
        } else if (moving || !ixState) {
          ixState = { hover: new Map(ixHover), click: new Map(ixClick), pointer: [ixPointer[0], ixPointer[1]] };
        }
        return ixState;
      }

      const onTryPointer = (e: PointerEvent) => {
        if (!useTryStore.getState().trying) return;
        const r = canvas!.getBoundingClientRect();
        ixPointerTo[0] = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        ixPointerTo[1] = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      };

      // ── Object hover glow: the shape under the cursor, cross-faded ──
      let hoverItemId: string | null = null;
      let hoverQueued: { x: number; y: number } | null = null;
      let hoverPicking = false;
      /** Min gap between hover picks: each one stalls a frame on readback. */
      const HOVER_PICK_GAP_MS = 45;

      function clearObjectHover() {
        hoverQueued = null;
        hoverItemId = null;
      }

      async function drainObjectHover() {
        if (hoverPicking) return;
        hoverPicking = true;
        try {
          while (hoverQueued) {
            if (pickInProgress) {
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              continue;
            }
            const { x, y } = hoverQueued;
            hoverQueued = null;
            pickInProgress = true;
            let id: number | null = null;
            const ids = pickItemIds;
            try {
              id = await readPickPixel(PICK_PASS_SCENE, x, y);
            } finally {
              pickUniforms.write({ pickPass: 0 });
              pickInProgress = false;
            }
            // A newer move may have cleared hover (drag start, left the canvas).
            if (id !== null && hoverQueued === null && !pointerDown && !gizmoDragging) {
              hoverItemId = id > 0 ? (ids[id - 1] ?? null) : null;
            }
            await new Promise((r) => setTimeout(r, HOVER_PICK_GAP_MS));
          }
        } finally {
          hoverPicking = false;
        }
      }

      /** `cur` follows the cursor; `prev` is the shape just left, fading out. */
      let glowCur: { id: string | null; s: number } = { id: null, s: 0 };
      let glowPrev: { id: string | null; s: number } = { id: null, s: 0 };
      let hoverWritten = { cur: "", curS: 0, prev: "", prevS: 0 };

      /** Selected itself, inside a selected group, or the whole scene is selected. */
      function isInSelection(itemId: string): boolean {
        const { root: sceneRoot, selectedIds, rootSelected } = useSceneStore.getState();
        if (rootSelected || selectedIds.includes(itemId)) return true;
        const ancestors = getItemAncestorGroups(sceneRoot, itemId) ?? [];
        return ancestors.some((g) => selectedIds.includes(g.id));
      }

      function updateHoverUniforms(dt: number) {
        // No hover glow on a gizmo handle (that's the target) or on the
        // selection (it already glows).
        const target =
          gizmoHoverAxis || !hoverItemId || useTryStore.getState().trying || isInSelection(hoverItemId) ? null : hoverItemId;
        if (target !== null && target !== glowCur.id) {
          if (target === glowPrev.id) {
            // Back onto the shape still fading out: pick it up where it is.
            [glowCur, glowPrev] = [glowPrev, glowCur];
          } else {
            if (glowCur.id !== null) glowPrev = glowCur;
            glowCur = { id: target, s: 0 };
          }
        }
        const k = Math.min(1, dt * 10);
        const ease = (v: number, to: number) => {
          const next = v + (to - v) * k;
          return Math.abs(to - next) < 0.002 ? to : next;
        };
        glowCur.s = ease(glowCur.s, target !== null && target === glowCur.id ? 1 : 0);
        glowPrev.s = ease(glowPrev.s, 0);
        if (glowPrev.s === 0) glowPrev.id = null;
        if (glowCur.s === 0 && target === null) glowCur.id = null;

        // Strengths live in the scene data (writeMarks); re-upload on change.
        const want = { cur: glowCur.id ?? "", curS: glowCur.s, prev: glowPrev.id ?? "", prevS: glowPrev.s };
        if (
          want.cur !== hoverWritten.cur || want.curS !== hoverWritten.curS ||
          want.prev !== hoverWritten.prev || want.prevS !== hoverWritten.prevS
        ) {
          dataDirty = true;
          hoverWritten = want;
        }
      }

      const onPointerMove = (e: PointerEvent) => {
        if (sculptActive()) {
          useBrushCursor.getState().move(e.clientX, e.clientY, brushRingPx(), e.target === canvas || !!sculpt);
          if (sculpt && !sculpt.ended) {
            // Every sample gets its own surface pick, so fast strokes follow the
            // surface instead of cutting chords through it. Far behind: keep the newest.
            sculpt.pending.push({ x: e.clientX, y: e.clientY, pressure: pressureScale(e) });
            if (sculpt.pending.length > 96) sculpt.pending.splice(1, sculpt.pending.length - 96);
            void drainSculpt(sculpt);
            return;
          }
          if (!pointerDown && e.target === canvas) void updateSculptHover(e.clientX, e.clientY);
        }
        if (gizmoDragging) {
          clearObjectHover();
          updateGizmoDrag(e.clientX, e.clientY);
          return;
        }

        if (!pointerDown) {
          // Only the canvas itself: panels sit on top of it.
          if (e.target === canvas) {
            hoverQueued = { x: e.clientX, y: e.clientY };
            void drainObjectHover();
          } else {
            clearObjectHover();
          }
          updateGizmoHover(e.clientX, e.clientY);
          return;
        }
        clearObjectHover();

        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!dragged && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
          dragged = true;
          canvas!.style.cursor = "grabbing";
        }
        if (!dragged) return;
        const totalDx =
          ((e.clientX - dragStartX) / window.innerWidth) * Math.PI * 2;
        const totalDy =
          ((e.clientY - dragStartY) / window.innerHeight) * Math.PI * 2;
        const previewRx = rotX + totalDx;
        const previewRy = rotY + totalDy;
        orbitPreviewRot = [previewRx, previewRy];
        orbitPreviewMouse = d.vec2f(previewRx, previewRy);
      };

      const onPointerUp = (e: PointerEvent) => {
        if (gizmoDragging && e.button === 0) {
          endGizmoDrag();
          updateGizmoHover(e.clientX, e.clientY);
          return;
        }

        if (sculpt && !sculpt.ended && e.button === 0) {
          void endSculpt(sculpt);
          return;
        }
        const sculptOrbit = sculptActive() && (e.button === 2 || e.button === 0);
        if (!pointerDown || (e.button !== 0 && !sculptOrbit)) return;
        pointerDown = false;
        if (sculptOrbit && !dragged) return; // a click in sculpt mode never selects

        if (dragged) {
          rotX += ((e.clientX - dragStartX) / window.innerWidth) * Math.PI * 2;
          rotY += ((e.clientY - dragStartY) / window.innerHeight) * Math.PI * 2;
          publishView();
          orbitPreviewMouse = null;
          orbitPreviewRot = null;
          updateGizmoHover(e.clientX, e.clientY);
        } else {
          void pickAt(e.clientX, e.clientY, e.metaKey || e.ctrlKey || e.shiftKey);
        }
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 10.0 : e.deltaY;
        distance = Math.max(
          0.5,
          Math.min(20.0, distance * Math.exp(px * 0.0001)),
        );
        publishViewSoon();
        syncCameraUniform();
      };

      const unsubGizmoMode = useGizmoStore.subscribe((state, prev) => {
        if (state.mode === prev.mode) return;
        clearGizmoInteraction();
      });

      canvas.addEventListener("pointerdown", onPointerDown);
      // Right-drag orbits while sculpting: no context menu there.
      const onContextMenu = (e: MouseEvent) => {
        if (sculptActive()) e.preventDefault();
      };
      canvas.addEventListener("contextmenu", onContextMenu);
      canvas.addEventListener("pointerleave", clearObjectHover);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointermove", onTryPointer);
      window.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      function applyQualityPreset(qualityIndex: number) {
        const preset = QUALITY_PRESETS[qualityIndex];
        qualityUniforms.write({
          maxSteps: preset.maxSteps,
          reflSteps: preset.reflSteps,
          shadowSteps: preset.shadowSteps,
          zero: 0,
        });
        targetMs = 1000 / preset.fpsCap;
        updateSize();
      }

      function updateSize() {
        const preset = QUALITY_PRESETS[useRenderStore.getState().quality];
        const dpr = dprForPreset(preset);
        canvas!.width = canvas!.clientWidth * dpr;
        canvas!.height = canvas!.clientHeight * dpr;
        if (canvas!.width > 0 && canvas!.height > 0) {
          resizePickTarget(canvas!.width, canvas!.height);
          syncCameraUniform();
        }
      }

      const startTime = performance.now();

      function syncCameraUniform() {
        const mouse = orbitPreviewMouse ?? d.vec2f(rotX, rotY);
        const aspect = getCanvasAspect(canvas!);
        cameraUniforms.write({
          time: (performance.now() - startTime) / 1000,
          aspect,
          mouse,
          distance,
        });
      }

      applyQualityPreset(lastQuality);

      const observer = new ResizeObserver(updateSize);
      observer.observe(canvas);
      let lastFrameTime = 0;
      let lastRoot: SceneRoot | null = null;

      const initialState = useSceneStore.getState();
      lastRoot = initialState.root;
      // Grow/shrink added and removed items; the store root stays untouched.
      const spawnAnim = new SpawnAnimator();
      let lastHoverFrame = 0;
      let lastView = "";
      let lastDrawnRoot: SceneRoot | null = null;
      let sceneAnimated = false;
      let lastTrying = false;
      let lastSliceY = 0;
      let animatedFor: SceneRoot | null = null;
      let lastTick = performance.now();
      let lastActive: { program: Program; scene: CompiledScene } | null = null;
      lastSelectedIds = initialState.selectedIds;
      lastRootSelected = initialState.rootSelected;
      lastRenderMode = useRenderStore.getState().renderMode;

      function frame(now: number) {
        if (now - lastFrameTime < targetMs) {
          animFrameId = requestAnimationFrame(frame);
          return;
        }
        lastFrameTime = now;

        const { root: sceneRoot, selectedIds, rootSelected } =
          useSceneStore.getState();
        const { renderMode, quality, sliceY } = useRenderStore.getState();
        if (quality !== lastQuality) {
          applyQualityPreset(quality);
          lastQuality = quality;
        }
        if (lastRoot && sceneRoot !== lastRoot) spawnAnim.rootChanged(lastRoot, sceneRoot, now, quietRootChange);
        quietRootChange = false;
        const spawned = spawnAnim.frame(sceneRoot, now);
        // Procedural animation: the clock runs only while something moves; a
        // dragged item holds its rest pose so the gizmo moves what you see.
        if (sceneRoot !== animatedFor) {
          sceneAnimated = hasAnimation(sceneRoot.items) || compileUsesTime(sceneRoot);
          animatedFor = sceneRoot;
        }
        const timeline = useTimelineStore.getState();
        if (sceneAnimated && timeline.playing) timeline.tick(Math.min(0.1, (now - lastTick) / 1000));
        lastTick = now;
        const time = sceneAnimated ? useTimelineStore.getState().time : 0;
        const still = gizmoDragging ? new Set(useSceneStore.getState().selectedIds) : undefined;
        const ix = stepInteraction(sceneRoot, Math.min(0.1, (now - lastHoverFrame) / 1000));
        const react = ix ? (item: unknown) => reactionOffsets(item as SceneItem, ix) : undefined;
        const drawn = {
          root: sceneAnimated || ix ? evaluateAnimations(spawned.root, time, still, react) : spawned.root,
          animating: spawned.animating,
        };
        const trying = useTryStore.getState().trying;
        if (
          selectedIds !== lastSelectedIds ||
          rootSelected !== lastRootSelected ||
          renderMode !== lastRenderMode ||
          trying !== lastTrying ||
          sliceY !== lastSliceY
        ) {
          dataDirty = true;
        }
        lastTrying = trying;
        lastSliceY = sliceY;
        lastRoot = sceneRoot;
        lastSelectedIds = selectedIds;
        lastRootSelected = rootSelected;
        lastRenderMode = renderMode;
        updateHoverUniforms(Math.min(0.1, (now - lastHoverFrame) / 1000));
        lastHoverFrame = now;
        const dataChanged = syncSceneProgram(drawn.root, renderMode, time);

        // Highlight only while dragging; hover feedback stays cursor-only.
        const activeGizmoAxis = gizmoDragging ? gizmoDragAxis : null;

        // Draw only when something on screen can have changed: a static
        // scene costs no GPU time (laptops stay cool and quiet).
        const [rx, ry] = getCameraRot();
        const view = [
          rx, ry, distance, canvas!.width, canvas!.height,
          useGizmoStore.getState().mode, activeGizmoAxis, imagesVersion, trying, useBrushStore.getState().active,
          active?.program.code.length, quality,
        ].join("|");
        if (active && (dataChanged || view !== lastView || drawn.root !== lastDrawnRoot || active !== lastActive)) {
          updateGizmoUniforms(sceneRoot, distance, activeGizmoAxis);
          syncCameraUniform();
          active.program.pipeline.withColorAttachment({ view: context }).draw(3);
          stats.draws++;
          lastView = view;
          lastDrawnRoot = drawn.root;
          lastActive = active;
          // E2E and tooling wait on this; harmless in production.
          if (!canvas!.dataset.ready) canvas!.dataset.ready = "1";
        }
        animFrameId = requestAnimationFrame(frame);
      }

      animFrameId = requestAnimationFrame(frame);

      if (import.meta.env.DEV) {
        // Perf probes for e2e/bench: GPU time per frame, pipeline compile time.
        const w = window as unknown as { __dstance?: Record<string, unknown> };
        w.__dstance = {
          ...w.__dstance,
          gpu: {
            async frameMs(frames = 30) {
              if (!active) return NaN;
              await root.device.queue.onSubmittedWorkDone();
              const t0 = performance.now();
              for (let i = 0; i < frames; i++) {
                active.program.pipeline.withColorAttachment({ view: context }).draw(3);
              }
              await root.device.queue.onSubmittedWorkDone();
              return (performance.now() - t0) / frames;
            },
            /** Fresh (uncached) compile of the current scene's program. */
            async compileMs() {
              if (!latest) return null;
              const t0 = performance.now();
              const fresh = shader.createScenePipeline(`${latest.code}\n// ${t0}`, modeId(useRenderStore.getState().renderMode));
              await fresh.initAsync();
              return { total: performance.now() - t0, codeKb: latest.code.length / 1024 };
            },
            stats: () => ({ ...stats }),
            /** Raw depth-pick bytes and decoded ray distance at a client point. */
            async depthProbe(x: number, y: number, skip = 0) {
              return withPick(async () => {
                sceneUniforms.patch({ skipLeaf: skip });
                const bytes = [...((await readPickBytes(PICK_PASS_DEPTH, x, y)) ?? [])];
                sceneUniforms.patch({ skipLeaf: 0 });
                return { bytes, t: bytes.length ? ((bytes[0] + bytes[3] * 256 + bytes[1] * 65536 - 1) / 16777214) * PICK_DEPTH_RANGE : null };
              });
            },
            /** True once the program for the current store root is on screen. */
            synced: () =>
              !!active &&
              active.program.code === `${useRenderStore.getState().renderMode}\n${latest?.code}` &&
              !dataDirty,
          },
        };
      }

      registeredCleanup = () => {
        clearTimeout(publishTimer);
        unsubGizmoMode();
        observer.disconnect();
        cancelAnimationFrame(animFrameId);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("pointerleave", clearObjectHover);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointermove", onTryPointer);
        canvas.removeEventListener("wheel", onWheel);
        root.destroy();
        pickTexture.destroy();
        pickReadbackBuffer.destroy();
      };
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameId);
      registeredCleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
