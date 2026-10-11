import { useEffect } from "react";
import { FlipHorizontal2 } from "lucide-react";
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS, useBrushCursor, useBrushStore, type BrushMode } from "../../scene/sculpt";
import { useTryStore } from "../../store/tryStore";

const MODES: { value: BrushMode; label: string; hint: string }[] = [
  { value: "clay", label: "Clay", hint: "Adds material, blending into the surface" },
  { value: "carve", label: "Carve", hint: "Cuts grooves into the surface" },
];

/** Logarithmic slider position ↔ radius (fine control for small brushes). */
const toSlider = (r: number) => Math.log(r / MIN_BRUSH_RADIUS) / Math.log(MAX_BRUSH_RADIUS / MIN_BRUSH_RADIUS);
const fromSlider = (v: number) => MIN_BRUSH_RADIUS * Math.pow(MAX_BRUSH_RADIUS / MIN_BRUSH_RADIUS, v);

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.tagName === "SELECT" || !!el?.isContentEditable;
};

/**
 * Brush settings while sculpting (bottom center, where the gizmo bar sits),
 * plus the keys: B toggles the tool, [ ] resize the brush, Esc leaves.
 */
export default function SculptBar() {
  const brush = useBrushStore();
  const trying = useTryStore((s) => s.trying);
  const open = brush.active && !trying;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing() || e.metaKey || e.ctrlKey) return;
      const st = useBrushStore.getState();
      if (e.code === "KeyB" && !e.altKey) {
        e.preventDefault();
        st.setActive(!st.active);
      } else if (st.active && e.key === "Escape") {
        st.setActive(false);
      } else if (st.active && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        st.set({ radius: st.radius * (e.key === "]" ? 1.15 : 1 / 1.15) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) useBrushCursor.getState().move(0, 0, 0, false);
  }, [open]);

  return (
    <div className="sculpt-dock">
      <div className="sculpt-bar motion-pop" data-open={open} aria-hidden={!open} role="toolbar" aria-label="Sculpt brush">
        <div className="segmented sculpt-modes" role="radiogroup" aria-label="Brush">
          <span className="segmented-indicator" style={{ transform: `translateX(${brush.mode === "clay" ? 0 : 100}%)` }} />
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={brush.mode === m.value}
              title={`${m.hint} (hold Alt for the other)`}
              className={`segmented-btn${brush.mode === m.value ? " segmented-btn--active" : ""}`}
              onClick={() => brush.set({ mode: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="sculpt-field" title="Brush size ( [ and ] )">
          Size
          <input
            type="range"
            aria-label="Brush size"
            min={0}
            max={1}
            step={0.001}
            value={toSlider(brush.radius)}
            onChange={(e) => brush.set({ radius: fromSlider(Number(e.target.value)) })}
          />
        </label>
        <label className="sculpt-field" title="How softly new strokes blend in">
          Smooth
          <input
            type="range"
            aria-label="Brush smoothness"
            min={0}
            max={0.2}
            step={0.005}
            value={brush.smooth}
            onChange={(e) => brush.set({ smooth: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className={`sculpt-toggle${brush.symmetry ? " sculpt-toggle--on" : ""}`}
          aria-pressed={brush.symmetry}
          title="Mirror strokes across the object's X axis"
          onClick={() => brush.set({ symmetry: !brush.symmetry })}
        >
          <FlipHorizontal2 size={13} />
          Mirror X
        </button>
        <span className="sculpt-hint" title="Alt: the other brush · [ ] size">Right- or ⌘-drag orbits</span>
        <button type="button" className="sculpt-done" onClick={() => brush.setActive(false)} title="Back to editing (B or Esc)">
          Done
        </button>
      </div>
    </div>
  );
}

/** The brush outline at the cursor, sized to what it would paint there. */
export function BrushRing() {
  const { x, y, r, visible } = useBrushCursor();
  const mode = useBrushStore((s) => s.mode);
  return (
    <div
      className={`brush-ring brush-ring--${mode}`}
      data-visible={visible}
      style={{ transform: `translate(${x - r}px, ${y - r}px)`, width: r * 2, height: r * 2 }}
      aria-hidden
    />
  );
}
