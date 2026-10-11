import { useEffect } from "react";
import { MousePointerClick } from "lucide-react";
import { useTryStore } from "../../store/tryStore";

/** Shown while the viewport plays the embed's interactions; Esc or Done returns to editing. */
export default function TryBanner() {
  const trying = useTryStore((s) => s.trying);
  const setTrying = useTryStore((s) => s.setTrying);

  useEffect(() => {
    if (!trying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setTrying(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [trying, setTrying]);

  return (
    <div className="try-banner motion-pop" data-open={trying} aria-hidden={!trying} role="status">
      <MousePointerClick size={13} />
      <span>Hover, click and move the pointer — like in your embed</span>
      <button type="button" className="try-banner-done" onClick={() => setTrying(false)} tabIndex={trying ? 0 : -1}>
        Done <kbd>Esc</kbd>
      </button>
    </div>
  );
}
