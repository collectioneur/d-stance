import { useState, useRef } from "react";
import { useStore } from "zustand";
import { Plus, Redo2, Undo2 } from "lucide-react";
import { temporalStore, undoScene, redoScene } from "../../store/sceneStore";
import {
  COPIED_ICON,
  COPY_LINK_ICON,
  IMAGE_ADD_ICON,
  IMAGE_HOTKEY,
  TEXT_HOTKEY,
  TEXT_ICON,
  SCULPT_ICON,
  addText,
  SHAPES,
  addShape,
  pickImageFile,
} from "../../utils/commands";
import { useBrushStore } from "../../scene/sculpt";
import { openPalette } from "../CommandPalette";
import { Wordmark } from "../Wordmark";

const isMac = navigator.platform.startsWith("Mac");
const paletteKey = isMac ? "⌘K" : "Ctrl+K";

export default function TopPanel() {
  const canUndo = useStore(temporalStore, (s) => s.pastStates.length > 0);
  const canRedo = useStore(temporalStore, (s) => s.futureStates.length > 0);
  const sculpting = useBrushStore((s) => s.active);
  const setSculpting = useBrushStore((s) => s.setActive);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="panel panel-top">
      <Wordmark />
      <div className="top-panel-divider" />
      <div className="top-panel-history">
        <button
          className="history-btn"
          onClick={undoScene}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
        >
          <Undo2 size={15} />
        </button>
        <button
          className="history-btn"
          onClick={redoScene}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
        >
          <Redo2 size={15} />
        </button>
        <button
          className="history-btn"
          onClick={handleCopyLink}
          title="Copy share link"
        >
          {copied ? <COPIED_ICON size={15} /> : <COPY_LINK_ICON size={15} />}
        </button>
      </div>
      <div className="top-panel-divider" />
      <div className="top-panel-shapes">
        {SHAPES.map(({ type, label, icon: Icon }, i) => (
          <button
            key={type}
            className="shape-btn shape-btn--icon"
            onClick={() => addShape(type)}
            title={`Add ${label} (${i + 1})`}
          >
            <Icon size={15} />
            <span className="shape-btn-key">{i + 1}</span>
          </button>
        ))}
        <button
          className="shape-btn shape-btn--icon"
          onClick={pickImageFile}
          title={`Add image as SDF (${IMAGE_HOTKEY}, or paste / drop an image)`}
        >
          <IMAGE_ADD_ICON size={15} />
          <span className="shape-btn-key">{IMAGE_HOTKEY}</span>
        </button>
        <button
          className="shape-btn shape-btn--icon"
          onClick={() => void addText()}
          title={`Add text (${TEXT_HOTKEY})`}
        >
          <TEXT_ICON size={15} />
          <span className="shape-btn-key">{TEXT_HOTKEY}</span>
        </button>
        <button
          className={`shape-btn shape-btn--icon${sculpting ? " shape-btn--on" : ""}`}
          onClick={() => setSculpting(!sculpting)}
          aria-pressed={sculpting}
          title="Sculpt: paint clay onto shapes or carve them (B)"
        >
          <SCULPT_ICON size={15} />
          <span className="shape-btn-key">B</span>
        </button>
        <button
          className="shape-btn shape-btn--icon"
          onClick={openPalette}
          title={`All commands (${paletteKey})`}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}
