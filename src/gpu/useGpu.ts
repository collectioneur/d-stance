import { useEffect, type RefObject } from "react";
import { tgpu, d } from "typegpu";
import {
  createShader,
  PICK_PASS_GIZMO,
  PICK_PASS_SCENE,
  RENDER_MODE_CHROME,
  RENDER_MODE_CLASSIC,
} from "./shader";
import {
  useSceneStore,
  collectImageSdfs,
  findItem,
  topLevelSelection,
  pauseHistory,
  resumeHistory,
  MAX_IMAGES,
  type ObjectGroup,
  type SceneRoot,
} from "../store/sceneStore";
import { useCompileStore } from "../store/compileStore";
import { useGizmoStore } from "../store/gizmoStore";
import { useRenderStore, type RenderMode } from "../store/renderStore";
import { DEFAULT_VIEW, useViewStore } from "../store/viewStore";
import { QUALITY_PRESETS, dprForPreset } from "../utils/quality";
import { clientToPickPixel, getCanvasAspect } from "./camera";
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
import { compileScene, type CompiledScene } from "./sceneCompiler";
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
        imageSdfTexture,
      } = shader;
      const sceneDataGpu = root.unwrap(sceneData.buffer);

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

      function programFor(code: string): Program {
        const cached = programs.get(code);
        if (cached) {
          programs.delete(code);
          programs.set(code, cached);
          return cached;
        }
        const prog: Program = {
          code,
          pipeline: shader.createScenePipeline(code),
          ready: false,
          failed: false,
        };
        stats.compiles++;
        programs.set(code, prog);
        prog.pipeline.initAsync().then(
          () => {
            prog.ready = true;
          },
          (err: unknown) => {
            prog.failed = true;
            console.error("scene shader failed to compile", err);
          },
        );
        for (const key of programs.keys()) {
          if (programs.size <= PROGRAM_CACHE_SIZE) break;
          if (key !== active?.program.code && key !== code) programs.delete(key);
        }
        return prog;
      }

      /** Highlight strength per node: selection 1, hover cross-fade 0..1. */
      function writeMarks(scene: CompiledScene) {
        const v = scene.values;
        for (const index of scene.markIndex.values()) v[index] = 0;
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
      let compilePending = false;

      function syncSceneProgram(drawnRoot: SceneRoot, renderMode: RenderMode): boolean {
        if (drawnRoot !== latestRoot) {
          uploadImageSlots(drawnRoot);
          latest = compileScene(drawnRoot, COMPILE_OPTIONS);
          latestRoot = drawnRoot;
          dataDirty = true;
        }
        if (latest && latest.code !== active?.program.code) {
          const prog = programFor(latest.code);
          if (prog.ready) {
            active = { program: prog, scene: latest };
            pickItemIds = latest.leafIds;
            dataDirty = true;
          }
        } else if (latest && active && active.scene !== latest) {
          active = { program: active.program, scene: latest };
          pickItemIds = latest.leafIds;
        }
        // The compile indicator: the screen lags while the scene's program compiles.
        const pending = !!latest && latest.code !== active?.program.code && !programs.get(latest.code)?.failed;
        if (pending !== compilePending) {
          compilePending = pending;
          useCompileStore.setState({ since: pending ? performance.now() : null });
        }
        if (!active || !dataDirty) return false;
        const scene = active.scene;
        writeMarks(scene);
        root.device.queue.writeBuffer(sceneDataGpu, 0, scene.values);
        const { rootSelected } = useSceneStore.getState();
        sceneUniforms.write({
          boundsRadius: scene.boundsRadius,
          renderMode: renderMode === "classic" ? RENDER_MODE_CLASSIC : RENDER_MODE_CHROME,
          selectAll: rootSelected && scene.leafIds.length > 0 ? 1 : 0,
          _pad1: 0,
          boundsCenter: d.vec3f(0, 0, 0),
          _pad2: 0,
        });
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
        const id = readPickIdFromBytes(new Uint8Array(pickReadbackBuffer.getMappedRange()));
        pickReadbackBuffer.unmap();
        return id;
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

          const { root: sceneRoot, selectItem, toggleSelected, deselect } =
            useSceneStore.getState();

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

      const onPointerDown = (e: PointerEvent) => {
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
          gizmoHoverAxis || !hoverItemId || isInSelection(hoverItemId) ? null : hoverItemId;
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

        if (!pointerDown || e.button !== 0) return;
        pointerDown = false;

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
      canvas.addEventListener("pointerleave", clearObjectHover);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      function applyQualityPreset(qualityIndex: number) {
        const preset = QUALITY_PRESETS[qualityIndex];
        qualityUniforms.write({
          maxSteps: preset.maxSteps,
          reflSteps: preset.reflSteps,
          outlineSteps: preset.outlineSteps,
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
        const { renderMode, quality } = useRenderStore.getState();
        if (quality !== lastQuality) {
          applyQualityPreset(quality);
          lastQuality = quality;
        }
        if (lastRoot && sceneRoot !== lastRoot) spawnAnim.rootChanged(lastRoot, sceneRoot, now);
        // A new item grows in once the program on screen draws it (it may still be compiling).
        const drawn = spawnAnim.frame(sceneRoot, now, (id) => !!active?.scene.markIndex.has(id));
        if (
          selectedIds !== lastSelectedIds ||
          rootSelected !== lastRootSelected ||
          renderMode !== lastRenderMode
        ) {
          dataDirty = true;
        }
        lastRoot = sceneRoot;
        lastSelectedIds = selectedIds;
        lastRootSelected = rootSelected;
        lastRenderMode = renderMode;
        updateHoverUniforms(Math.min(0.1, (now - lastHoverFrame) / 1000));
        lastHoverFrame = now;
        const dataChanged = syncSceneProgram(drawn.root, renderMode);

        // Highlight only while dragging; hover feedback stays cursor-only.
        const activeGizmoAxis = gizmoDragging ? gizmoDragAxis : null;

        // Draw only when something on screen can have changed: a static
        // scene costs no GPU time (laptops stay cool and quiet).
        const [rx, ry] = getCameraRot();
        const view = [
          rx, ry, distance, canvas!.width, canvas!.height,
          useGizmoStore.getState().mode, activeGizmoAxis, imagesVersion,
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
              const fresh = shader.createScenePipeline(`${latest.code}\n// ${t0}`);
              await fresh.initAsync();
              return { total: performance.now() - t0, codeKb: latest.code.length / 1024 };
            },
            stats: () => ({ ...stats }),
            /** Items the program on screen draws (shapes and groups). */
            drawnIds: () => [...(active?.scene.markIndex.keys() ?? [])],
            /** How far an item's grow-in has run, 0..1; null when it is not growing in. */
            appearProgress: (id: string) => spawnAnim.progress(id, performance.now()),
            /** True once the program for the current store root is on screen. */
            synced: () => !!active && active.program.code === latest?.code && !dataDirty,
          },
        };
      }

      registeredCleanup = () => {
        clearTimeout(publishTimer);
        useCompileStore.setState({ since: null });
        unsubGizmoMode();
        observer.disconnect();
        cancelAnimationFrame(animFrameId);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerleave", clearObjectHover);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
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
