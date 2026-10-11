import { useRef, useState } from "react";
import { pauseHistory, resumeHistory } from "../../store/sceneStore";
import { roundTo } from "../../utils/round";

// ── Shared numeric input ──────────────────────────────────────────────────────

/** The value all items share, or null when they differ (shown as "mixed"). */
export function common<T>(values: T[]): T | null {
  return values.every((v) => v === values[0]) ? values[0] : null;
}

/**
 * Number field. While focused it holds your text as typed (empty, "-", "0." are
 * fine) and applies every valid number live. On leaving, an empty or invalid
 * entry becomes `fallback` (the field's default; else the value at focus) and
 * the result is clamped to min/max. ↑/↓ step by `step` from the current value
 * (Shift ×10), Enter applies, Escape restores the value at focus. A "mixed"
 * field left empty changes nothing.
 */
type NumberProps = {
  /** null = selected items disagree. */
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  /** Value restored when the field is left empty or invalid. */
  fallback?: number;
  onChange: (v: number) => void;
};

export function NumericInput({ label, ...field }: NumberProps & { label: string }) {
  return (
    <div className="prop-row">
      <label className="prop-label">{label}</label>
      <NumberField {...field} ariaLabel={label} />
    </div>
  );
}

/** The bare input of NumericInput, for compact rows (x / y / z triples). */
export function NumberField({
  value,
  min,
  max,
  step = 0.01,
  decimals,
  fallback,
  onChange,
  ariaLabel,
  className,
}: NumberProps & { ariaLabel: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const atFocus = useRef<number | null>(null);

  const round = (n: number) => (decimals != null ? roundTo(n, decimals) : n);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const parse = (text: string) => {
    const n = parseFloat(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : null;
  };
  const commit = (n: number) => onChange(clamp(round(n)));
  const shown = value === null ? "" : String(round(value));

  function finish() {
    // Mixed at focus (atFocus null): an empty/invalid entry leaves every item as is.
    if (draft !== null && parse(draft) === null && atFocus.current !== null) {
      commit(fallback ?? atFocus.current);
    }
    setDraft(null);
    resumeHistory();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      if (atFocus.current !== null) commit(atFocus.current);
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // Our own stepping: exact multiples of `step` from the current value
      // (native stepping snaps to a grid based at `min`, e.g. 1 → 0.91).
      e.preventDefault();
      const base = (draft !== null ? parse(draft) : null) ?? value ?? fallback ?? 0;
      const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      const next = clamp(round(Number((base + delta).toFixed(10))));
      onChange(next);
      setDraft(String(next));
    }
  }

  return (
      <input
        className={`prop-input${className ? ` ${className}` : ""}`}
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        value={draft ?? shown}
        placeholder={value === null ? "mixed" : undefined}
        step={step}
        onFocus={(e) => {
          pauseHistory();
          atFocus.current = value;
          setDraft(shown);
          e.currentTarget.select();
        }}
        onBlur={finish}
        onKeyDown={onKeyDown}
        // A focused number field would eat panel scrolling as value changes.
        onWheel={(e) => e.currentTarget.blur()}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parse(e.target.value);
          if (n !== null) commit(n);
        }}
      />
  );
}
