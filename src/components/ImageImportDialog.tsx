import { useEffect, useRef, useState } from "react";
import { MAX_IMAGES, useSceneStore, wouldExceedImages } from "../store/sceneStore";
import {
  analyzeImage,
  bakeImageSdf,
  buildMask,
  maskPreview,
  type ImageAnalysis,
} from "../utils/imageSdf";
import { setImageImportListener } from "../utils/commands";
import { decodeImageFile } from "../utils/decodeImage";
import { showToast } from "../utils/toast";

const THRESHOLD_MIN = 0.02;
const THRESHOLD_MAX = 0.98;

/** Mounted once in App; opened via openImageImport(file) from commands.ts. */
export default function ImageImportDialog() {
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    setImageImportListener(setFile);
    return () => setImageImportListener(null);
  }, []);
  if (!file) return null;
  return <ImportBody key={file.name + file.size} file={file} onClose={() => setFile(null)} />;
}

function ImportBody({ file, onClose }: { file: File; onClose: () => void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [invert, setInvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
      const sdf = bakeImageSdf(bitmap, analysis, threshold, invert);
      if (!sdf) {
        showToast("Nothing detected — adjust the threshold");
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

  const thresholdFrac = (threshold - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN);

  return (
    <div className="image-dialog-overlay" onClick={onClose}>
      <div
        className="image-dialog"
        role="dialog"
        aria-label="Import image"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="image-dialog-title">Import image as SDF</div>
        <div className="image-dialog-preview">
          {analysis ? (
            <canvas ref={canvasRef} />
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
          Light area becomes the shape. {analysis?.hasAlpha ? "Using alpha channel." : "Using brightness."}
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
