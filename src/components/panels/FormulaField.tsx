import { useEffect, useState } from "react";
import { pauseHistory, resumeHistory, useSceneStore, type ShapeLayer } from "../../store/sceneStore";
import { DEFAULT_FORMULA, FORMULA_EXAMPLES, FORMULA_MAX_LENGTH, parseFormula } from "../../sdf/formula";

/**
 * Formula editor: edits a draft, and every draft that parses goes straight to
 * the scene (the shape recompiles in the background). Errors point at the
 * character that broke.
 */
export function FormulaField({ layer, containerId }: { layer: ShapeLayer; containerId: string }) {
  const updateLayer = useSceneStore((s) => s.updateLayer);
  const stored = layer.formula ?? DEFAULT_FORMULA;
  const [draft, setDraft] = useState(stored);
  const [focused, setFocused] = useState(false);

  // Undo / another selection replaces the stored formula: follow it unless typing.
  useEffect(() => {
    if (!focused) setDraft(stored);
  }, [stored, focused]);

  const parsed = parseFormula(draft);
  const commit = (src: string) => {
    setDraft(src);
    if (parseFormula(src).ok) updateLayer(containerId, layer.id, { formula: src });
  };

  return (
    <>
      <div className="props-section-title props-section-title--row" style={{ marginTop: "16px" }}>
        Formula
        <select
          className="modifier-add"
          aria-label="Formula examples"
          value=""
          onChange={(e) => {
            const ex = FORMULA_EXAMPLES.find((x) => x.name === e.target.value);
            if (ex) commit(ex.source);
          }}
        >
          <option value="">Examples</option>
          {FORMULA_EXAMPLES.map((ex) => (
            <option key={ex.name} value={ex.name}>
              {ex.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className={`formula-input${parsed.ok ? "" : " formula-input--error"}`}
        aria-label="Formula"
        spellCheck={false}
        rows={3}
        maxLength={FORMULA_MAX_LENGTH}
        value={draft}
        onFocus={() => {
          setFocused(true);
          pauseHistory();
        }}
        onBlur={() => {
          setFocused(false);
          resumeHistory();
          // Leaving a broken draft restores what the shape is drawing.
          if (!parseFormula(draft).ok) setDraft(stored);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
          e.stopPropagation(); // editor hotkeys (W/E/R, Delete) stay out of the way
        }}
        onChange={(e) => commit(e.target.value)}
      />
      {parsed.ok ? (
        <p className="props-op-hint">
          f(x, y, z) is negative inside; y points up. Functions: sin, cos, sqrt, length, min, max, smoothstep, noise,
          fbm, smin…
        </p>
      ) : (
        <p className="formula-error" role="alert">
          {parsed.error.message}
          {draft.length > 0 && <span className="formula-error-at"> · at {parsed.error.at + 1}</span>}
        </p>
      )}
    </>
  );
}
