import { useEffect, useRef, useState } from "react";
import { MAX_IMAGES, useSceneStore, wouldExceedImages } from "../store/sceneStore";
import {
  analyzeImage,
  bakeImageSdf,
  buildMask,
  maskPreview,
  type ImageAnalysis,
  type ImageCrop,
} from "../utils/imageSdf";
import { setImageImportListener } from "../utils/commands";
import { decodeImageFile } from "../utils/decodeImage";
import { showToast } from "../utils/toast";

const THRESHOLD_MIN = 0.02;
const THRESHOLD_MAX = 0.98;
/** Hit radius for crop edges/corners, in CSS px. */
const CROP_HANDLE_PX = 8;
/** Room around the image so crop handles at its edges are not clipped, in CSS px. */
const STAGE_INSET = 6;
/** The crop starts out covering the whole image, so the frame (and the feature) is visible. */
const FULL_CROP: ImageCrop = { x0: 0, y0: 0, x1: 1, y1: 1 };
const isFullCrop = (c: ImageCrop) => c.x0 <= 0 && c.y0 <= 0 && c.x1 >= 1 && c.y1 >= 1;
/** Smallest crop side, as a fraction of the image; below this a drag counts as a click. */
const CROP_MIN = 0.01;

/** Mounted once in App; opened via openImageImport(file) from commands.ts. */
export default function ImageImportDialog() {
  const [file, setFile] = useState<File | null>(null);
  // Closing keeps the dialog mounted until its exit animation ends.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    setImageImportListener((next) => {
      setFile(next);
      setClosing(false);
    });
    return () => setImageImportListener(null);
  }, []);
  if (!file) return null;
  return (
    <ImportBody
      key={file.name + file.size}
      file={file}
      closing={closing}
      onClose={() => setClosing(true)}
      onClosed={() => {
        setFile(null);
        setClosing(false);
      }}
    />
  );
}

// ── Crop interaction ──────────────────────────────────────────────────────────

/** -1 / 0 / 1 per axis: which edge (if any) a pointer is grabbing. */
type Grip = { hx: -1 | 0 | 1; hy: -1 | 0 | 1; inside: boolean };

type Drag =
  | { mode: "new"; sx: number; sy: number }
  | { mode: "move"; sx: number; sy: number; start: ImageCrop }
  | { mode: "resize"; grip: Grip; start: ImageCrop };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function gripAt(crop: ImageCrop, x: number, y: number, tolX: number, tolY: number): Grip {
  const nearX = x >= crop.x0 - tolX && x <= crop.x1 + tolX;
  const nearY = y >= crop.y0 - tolY && y <= crop.y1 + tolY;
  let hx: -1 | 0 | 1 = 0;
  let hy: -1 | 0 | 1 = 0;
  if (nearY) {
    if (Math.abs(x - crop.x0) <= tolX) hx = -1;
    else if (Math.abs(x - crop.x1) <= tolX) hx = 1;
  }
  if (nearX) {
    if (Math.abs(y - crop.y0) <= tolY) hy = -1;
    else if (Math.abs(y - crop.y1) <= tolY) hy = 1;
  }
  const inside = x > crop.x0 && x < crop.x1 && y > crop.y0 && y < crop.y1;
  return { hx, hy, inside };
}

/** `movable`: a full-image crop has nowhere to move, so dragging inside draws a new one. */
function cursorFor(g: Grip, movable: boolean): string {
  if (g.hx && g.hy) return g.hx === g.hy ? "nwse-resize" : "nesw-resize";
  if (g.hx) return "ew-resize";
  if (g.hy) return "ns-resize";
  return g.inside && movable ? "move" : "crosshair";
}

// ── Dialog body ───────────────────────────────────────────────────────────────

function ImportBody({
  file,
  closing,
  onClose,
  onClosed,
}: {
  file: File;
  /** Exit animation running: ignore input so Enter can't add the image twice. */
  closing: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [invert, setInvert] = useState(false);
  const [crop, setCrop] = useState<ImageCrop>(FULL_CROP);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState("crosshair");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    let alive = true;
    let bmp: ImageBitmap | null = null;
    decodeImageFile(file).then(
      (b) => {
        if (!alive) {
          b.close();
          return;
        }
        bmp = b;
        const a = analyzeImage(b);
        setBitmap(b);
        setAnalysis(a);
        setThreshold(a.threshold);
        setInvert(a.invert);
      },
      () => {
        showToast("Could not decode image");
        onClose();
      },
    );
    return () => {
      alive = false;
      bmp?.close();
    };
  }, [file, onClose]);

  // Preview box size → letterboxed stage size (we position the crop overlay
  // ourselves, so object-fit is not enough).
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!analysis || !c) return;
    c.width = analysis.width;
    c.height = analysis.height;
    const mask = buildMask(analysis.score, threshold, invert);
    c.getContext("2d")!.putImageData(maskPreview(mask, analysis.width, analysis.height), 0, 0);
  }, [analysis, threshold, invert]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closing) return;
      if (e.key === "Escape") onClose();
      if (e.key === "Enter") confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function confirm() {
    if (!bitmap || !analysis || busy) return;
    setBusy(true);
    // Yield one tick so the button repaints before the synchronous bake.
    setTimeout(() => {
      const cropped = isFullCrop(crop) ? null : crop;
      const sdf = bakeImageSdf(bitmap, analysis, threshold, invert, cropped);
      if (!sdf) {
        showToast(cropped ? "Nothing detected inside the crop" : "Nothing detected - adjust the threshold");
        setBusy(false);
        return;
      }
      const st = useSceneStore.getState();
      if (wouldExceedImages(st.root, sdf)) {
        showToast(`Too many images (max ${MAX_IMAGES})`);
        setBusy(false);
        return;
      }
      if (!st.addShapeToContainer(st.selectedContainerId, "image", { sdf })) {
        showToast("Scene too complex (max 256 operations)");
      }
      onClose();
    }, 0);
  }

  // ── Crop pointer handling (all hit-testing on the stage, in image fractions) ──

  function pointerNorm(e: React.PointerEvent): { x: number; y: number; tolX: number; tolY: number } {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
      tolX: CROP_HANDLE_PX / r.width,
      tolY: CROP_HANDLE_PX / r.height,
    };
  }

  function onStageDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !analysis) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointerNorm(e);
    const g = gripAt(crop, p.x, p.y, p.tolX, p.tolY);
    if (g.hx || g.hy) dragRef.current = { mode: "resize", grip: g, start: crop };
    else if (g.inside && !isFullCrop(crop)) dragRef.current = { mode: "move", sx: p.x, sy: p.y, start: crop };
    else dragRef.current = { mode: "new", sx: p.x, sy: p.y };
  }

  function onStageMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!analysis) return;
    const p = pointerNorm(e);
    const drag = dragRef.current;
    if (!drag) {
      setCursor(cursorFor(gripAt(crop, p.x, p.y, p.tolX, p.tolY), !isFullCrop(crop)));
      return;
    }
    if (drag.mode === "new") {
      setCrop({
        x0: Math.min(drag.sx, p.x),
        y0: Math.min(drag.sy, p.y),
        x1: Math.max(drag.sx, p.x),
        y1: Math.max(drag.sy, p.y),
      });
    } else if (drag.mode === "move") {
      const w = drag.start.x1 - drag.start.x0;
      const h = drag.start.y1 - drag.start.y0;
      const x0 = Math.min(1 - w, Math.max(0, drag.start.x0 + (p.x - drag.sx)));
      const y0 = Math.min(1 - h, Math.max(0, drag.start.y0 + (p.y - drag.sy)));
      setCrop({ x0, y0, x1: x0 + w, y1: y0 + h });
    } else {
      const { grip, start } = drag;
      const c = { ...start };
      if (grip.hx === -1) c.x0 = Math.min(p.x, start.x1 - CROP_MIN);
      if (grip.hx === 1) c.x1 = Math.max(p.x, start.x0 + CROP_MIN);
      if (grip.hy === -1) c.y0 = Math.min(p.y, start.y1 - CROP_MIN);
      if (grip.hy === 1) c.y1 = Math.max(p.y, start.y0 + CROP_MIN);
      setCrop(c);
    }
  }

  function onStageUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A plain click (no meaningful rectangle) resets the crop to the whole image.
    if (drag.mode === "new" && (crop.x1 - crop.x0 < CROP_MIN || crop.y1 - crop.y0 < CROP_MIN)) {
      setCrop(FULL_CROP);
    }
  }

  const thresholdFrac = (threshold - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN);
  const fit =
    analysis && box.w > 0
      ? Math.min((box.w - 2 * STAGE_INSET) / analysis.width, (box.h - 2 * STAGE_INSET) / analysis.height)
      : 0;
  const stageW = analysis ? analysis.width * fit : 0;
  const stageH = analysis ? analysis.height * fit : 0;

  return (
    <div
      className="image-dialog-overlay"
      data-state={closing ? "closed" : "open"}
      onClick={onClose}
    >
      <div
        className="image-dialog"
        role="dialog"
        aria-label="Import image"
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClosed();
        }}
      >
        <div className="image-dialog-title">Import image as SDF</div>
        <div className="image-dialog-preview" ref={previewRef}>
          {analysis ? (
            <div
              ref={stageRef}
              className="image-crop-stage"
              style={{ width: stageW, height: stageH, cursor }}
              onPointerDown={onStageDown}
              onPointerMove={onStageMove}
              onPointerUp={onStageUp}
              onPointerCancel={onStageUp}
              onPointerLeave={() => !dragRef.current && setCursor("crosshair")}
            >
              <canvas ref={canvasRef} />
              <div
                className="image-crop-box"
                style={{
                  left: `${crop.x0 * 100}%`,
                  top: `${crop.y0 * 100}%`,
                  width: `${(crop.x1 - crop.x0) * 100}%`,
                  height: `${(crop.y1 - crop.y0) * 100}%`,
                }}
                aria-hidden
              >
                <i className="image-crop-handle" data-corner="nw" />
                <i className="image-crop-handle" data-corner="ne" />
                <i className="image-crop-handle" data-corner="sw" />
                <i className="image-crop-handle" data-corner="se" />
              </div>
            </div>
          ) : (
            <span className="image-dialog-hint">Analyzing…</span>
          )}
        </div>
        <label className="image-dialog-row">
          <span>Threshold</span>
          <input
            className="ui-range"
            type="range"
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={0.01}
            value={threshold}
            disabled={!analysis}
            style={{ "--frac": thresholdFrac } as React.CSSProperties}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
          />
        </label>
        <label className="image-dialog-row">
          <span>Invert</span>
          <input
            className="ui-check"
            type="checkbox"
            checked={invert}
            disabled={!analysis}
            onChange={(e) => setInvert(e.target.checked)}
          />
        </label>
        <p className="image-dialog-hint">
          Light area becomes the shape. {analysis?.hasAlpha ? "Using alpha channel." : "Using brightness."}{" "}
          {!isFullCrop(crop) ? (
            <>
              Cropped -{" "}
              <button type="button" className="image-dialog-link" onClick={() => setCrop(FULL_CROP)}>
                reset
              </button>
              .
            </>
          ) : (
            "Drag the corners to crop."
          )}
        </p>
        <div className="image-dialog-actions">
          <button className="image-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="image-dialog-btn image-dialog-btn--primary"
            disabled={!analysis || busy}
            onClick={confirm}
          >
            {busy ? "Baking…" : "Add to scene"}
          </button>
        </div>
      </div>
    </div>
  );
}
