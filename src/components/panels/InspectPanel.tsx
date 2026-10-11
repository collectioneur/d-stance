import { useRenderStore } from "../../store/renderStore";
import { useSceneStore } from "../../store/sceneStore";
import { QUALITY_PRESETS } from "../../utils/quality";
import { sceneMarchRadius } from "../../sdf/itemBounds";

/**
 * Legend (and the slice control) for the inspect render modes, bottom right.
 * Field: slice height; Cost: what the colors mean in steps; Normals: axes.
 */
export default function InspectPanel() {
  const mode = useRenderStore((s) => s.renderMode);
  const sliceY = useRenderStore((s) => s.sliceY);
  const setSliceY = useRenderStore((s) => s.setSliceY);
  const quality = useRenderStore((s) => s.quality);
  const root = useSceneStore((s) => s.root);
  const open = mode === "field" || mode === "cost" || mode === "normals";
  // The slice sweeps the scene's bounds (+Y is down: negative is up).
  const reach = Math.max(0.5, Math.ceil((root.items.length > 0 ? Math.min(sceneMarchRadius(root.items), 10) : 1) * 10) / 10);

  return (
    <div className="inspect-panel motion-pop" data-open={open} aria-hidden={!open}>
      {mode === "field" && (
        <>
          <div className="inspect-legend">
            <span className="inspect-swatch" style={{ background: "#e69a4d" }} /> outside
            <span className="inspect-swatch" style={{ background: "#a6d9ff" }} /> inside
            <span className="inspect-swatch" style={{ background: "#fff" }} /> surface · lines every 0.05
          </div>
          <label className="inspect-row">
            Slice
            <input
              type="range"
              className="inspect-slider"
              aria-label="Slice height"
              min={-reach}
              max={reach}
              step={0.01}
              // Up is −Y in the editor: the slider reads bottom → top.
              value={-sliceY}
              onChange={(e) => setSliceY(-Number(e.target.value))}
            />
            <span className="inspect-value">{(-sliceY).toFixed(2)}</span>
          </label>
        </>
      )}
      {mode === "cost" && (
        <div className="inspect-legend inspect-legend--column">
          <span className="inspect-ramp" />
          <span className="inspect-ramp-labels">
            <span>1 step</span>
            <span>{QUALITY_PRESETS[quality]?.maxSteps ?? "max"} steps</span>
          </span>
        </div>
      )}
      {mode === "normals" && (
        <div className="inspect-legend">
          <span className="inspect-swatch" style={{ background: "#ff8080" }} /> +X
          <span className="inspect-swatch" style={{ background: "#80ff80" }} /> up
          <span className="inspect-swatch" style={{ background: "#8080ff" }} /> toward −Z
        </div>
      )}
    </div>
  );
}
