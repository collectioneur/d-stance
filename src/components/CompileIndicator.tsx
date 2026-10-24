import { useEffect, useState } from "react";
import { useCompileStore } from "../store/compileStore";

/** Compiles shorter than this never show (small scenes take 25–80 ms). */
export const SHOW_AFTER_MS = 250;
/** Once shown, stay at least this long: a flash reads as a glitch. */
export const MIN_SHOWN_MS = 400;
/** Past this, count the seconds so a long compile reads as progress, not a hang. */
const COUNT_AFTER_MS = 1000;

/**
 * "Compiling scene…" while the picture lags a structural edit (new shape,
 * op change, regrouping): the new program builds in the background and the
 * old one keeps drawing. Quick compiles stay invisible.
 */
export default function CompileIndicator() {
  const since = useCompileStore((s) => s.since);
  const [shownAt, setShownAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (since !== null) {
      if (shownAt !== null) return;
      const t = setTimeout(() => setShownAt(performance.now()), Math.max(0, since + SHOW_AFTER_MS - performance.now()));
      return () => clearTimeout(t);
    }
    if (shownAt === null) return;
    const t = setTimeout(() => setShownAt(null), Math.max(0, shownAt + MIN_SHOWN_MS - performance.now()));
    return () => clearTimeout(t);
  }, [since, shownAt]);

  // Tick the seconds counter only while it is on screen and still compiling.
  useEffect(() => {
    if (shownAt === null || since === null) return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [shownAt, since]);

  const open = shownAt !== null;
  const elapsed = since !== null ? now - since : 0;
  return (
    <div className="compile-indicator motion-pop" data-open={open} aria-hidden={!open} role="status" aria-live="polite">
      <span className="compile-spinner" aria-hidden />
      <span>Compiling scene…</span>
      {since !== null && elapsed > COUNT_AFTER_MS && <span className="compile-time">{(elapsed / 1000).toFixed(1)} s</span>}
    </div>
  );
}
