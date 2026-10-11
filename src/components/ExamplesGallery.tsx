import { useEffect, useState } from "react";
import { create } from "zustand";
import { EXAMPLES, loadExample, type Example } from "../scene/examples";
import { useSceneStore } from "../store/sceneStore";

const THUMBS = import.meta.glob<string>("../assets/examples/*.jpg", { query: "?url", import: "default", eager: true });
const thumb = (id: string) => THUMBS[`../assets/examples/${id}.jpg`];

const useGallery = create<{ open: boolean; dismissed: boolean }>(() => ({ open: false, dismissed: false }));

/** Opens the examples dialog (palette, wordmark). */
export function openExamples() {
  useGallery.setState({ open: true });
}

function Cards({ onPick }: { onPick: (ex: Example) => void }) {
  return (
    <div className="examples-grid">
      {EXAMPLES.map((ex) => (
        <button key={ex.id} type="button" className="example-card" onClick={() => onPick(ex)}>
          <img src={thumb(ex.id)} alt="" loading="lazy" />
          <span className="example-card-title">{ex.title}</span>
          <span className="example-card-blurb">{ex.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Examples: a welcome card over an empty scene (until the first shape or a
 * dismiss), and the same gallery as a dialog from the palette or the wordmark.
 */
export default function ExamplesGallery() {
  const { open, dismissed } = useGallery();
  const empty = useSceneStore((s) => s.root.items.length === 0);
  const [closing, setClosing] = useState(false);
  const welcome = empty && !dismissed && !open;

  // The first shape ends the welcome for this visit.
  useEffect(() => {
    if (!empty) useGallery.setState({ dismissed: true });
  }, [empty]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setClosing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = (ex: Example) => {
    useGallery.setState({ dismissed: true });
    setClosing(open);
    void loadExample(ex);
  };

  return (
    <>
      <div className="welcome motion-pop" data-open={welcome} aria-hidden={!welcome}>
        <div className="welcome-card" role="region" aria-label="Welcome">
          <div className="welcome-head">
            <span className="welcome-title">Start from an example</span>
            <button type="button" className="welcome-skip" onClick={() => useGallery.setState({ dismissed: true })}>
              Start empty
            </button>
          </div>
          <Cards onPick={pick} />
          <p className="welcome-tips">
            <kbd>1</kbd>–<kbd>6</kbd> shapes · <kbd>7</kbd> image · <kbd>8</kbd> text · <kbd>B</kbd> sculpt · <kbd>⌘K</kbd> everything else · <kbd>?</kbd> shortcuts
          </p>
        </div>
      </div>
      {open && (
        <div
          className="image-dialog-overlay"
          data-state={closing ? "closed" : "open"}
          onClick={() => setClosing(true)}
          onAnimationEnd={(e) => {
            if (closing && e.target === e.currentTarget) {
              setClosing(false);
              useGallery.setState({ open: false });
            }
          }}
        >
          <div className="image-dialog examples-dialog" role="dialog" aria-label="Examples" onClick={(e) => e.stopPropagation()}>
            <div className="image-dialog-title">Examples</div>
            <Cards onPick={pick} />
            <p className="examples-note">Loading replaces the scene — undo brings yours back.</p>
          </div>
        </div>
      )}
    </>
  );
}
