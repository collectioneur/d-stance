import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Canvas from "./components/Canvas";
import TopPanel from "./components/panels/TopPanel";
import LeftPanel from "./components/panels/LeftPanel";
import RightPanel from "./components/panels/RightPanel";
import GizmoPanel from "./components/panels/GizmoPanel";
import TimelinePanel from "./components/panels/TimelinePanel";
import CommandPalette from "./components/CommandPalette";
import ImageImportDialog from "./components/ImageImportDialog";
import RenderModePanel from "./components/panels/RenderModePanel";
import QualityPanel from "./components/panels/QualityPanel";
import MobileGate from "./components/MobileGate";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { undoScene, redoScene } from "./store/sceneStore";
import { useGizmoStore } from "./store/gizmoStore";
import { usePersistence } from "./store/persistence";
import { openImageImport } from "./utils/commands";
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  pasteObjects,
} from "./scene/clipboard";
import { isImageFile } from "./utils/decodeImage";
import { setToastListener } from "./utils/toast";

/** Gap kept between the top-right render pill and the centered top bar, px. */
const RENDER_PILL_GAP = 8;
/** Matches --space-3, the pill's distance from the window edge. */
const EDGE_MARGIN = 12;

/**
 * True when the top-right render pill would run into the centered top bar —
 * then it docks bottom-center instead. Measured, so it follows width changes.
 */
function useRenderPillDocked(pillRef: RefObject<HTMLDivElement | null>): boolean {
  const [docked, setDocked] = useState(false);
  useLayoutEffect(() => {
    const update = () => {
      const pill = pillRef.current;
      const topBar = document.querySelector<HTMLElement>(".panel-top");
      if (!pill || !topBar) return;
      const needed = topBar.offsetWidth + 2 * (pill.offsetWidth + RENDER_PILL_GAP + EDGE_MARGIN);
      setDocked(window.innerWidth < needed);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [pillRef]);
  return docked;
}

/** Narrower than this the editor does not fit: show MobileGate instead. */
const MOBILE_QUERY = "(max-width: 799px)";

/**
 * The gate replaces the editor outright (not an overlay), so its global
 * hotkeys can't edit the scene unseen. Checked before WebGPU support so phones
 * get the mobile message.
 */
export default function App() {
  const narrow = useMediaQuery(MOBILE_QUERY);
  return narrow ? <MobileGate /> : <Editor />;
}

function Editor() {
  usePersistence();
  const renderPillRef = useRef<HTMLDivElement>(null);
  const renderPillDocked = useRenderPillDocked(renderPillRef);
  // Message outlives `toastOpen` so the toast can animate out with its text.
  const [toast, setToast] = useState("");
  const [toastOpen, setToastOpen] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    setToastListener((message) => {
      setToast(message);
      setToastOpen(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToastOpen(false), 2500);
    });
    return () => {
      setToastListener(null);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        undoScene();
      }
      if ((e.metaKey || e.ctrlKey) && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
        e.preventDefault();
        redoScene();
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyD") {
        e.preventDefault();
        duplicateSelection();
      }
      if (
        (e.code === "Delete" || e.code === "Backspace") &&
        !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        e.preventDefault();
        deleteSelection();
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const setMode = useGizmoStore.getState().setMode;
        if (e.code === "KeyW") {
          e.preventDefault();
          setMode("translate");
        } else if (e.code === "KeyE") {
          e.preventDefault();
          setMode("rotate");
        } else if (e.code === "KeyR") {
          e.preventDefault();
          setMode("scale");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Cmd+C copies the selected object; paste or drop an image anywhere →
  // import dialog, otherwise paste copied objects. Tree DnD carries no files,
  // so its drops fall through untouched.
  useEffect(() => {
    const imageOf = (files: FileList | undefined | null) =>
      Array.from(files ?? []).find(isImageFile);
    const isEditing = () => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
    };
    const onCopy = (e: ClipboardEvent) => {
      // Selected text (code view, labels) copies as text, as usual.
      const sel = window.getSelection();
      if (isEditing() || (sel && !sel.isCollapsed)) return;
      const text = copySelection();
      if (text && e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditing()) return;
      const file = imageOf(e.clipboardData?.files);
      if (file) {
        e.preventDefault();
        openImageImport(file);
        return;
      }
      if (pasteObjects(e.clipboardData?.getData("text/plain"))) e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const file = imageOf(e.dataTransfer?.files);
      if (file) {
        e.preventDefault();
        openImageImport(file);
      }
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!navigator.gpu) {
    return (
      <div className="no-webgpu">
        WebGPU is not supported in this browser.
        <br />
        <small>Try Chrome 113+ or Edge 113+</small>
      </div>
    );
  }

  return (
    <>
      <Canvas />
      <TopPanel />
      {/* Must stay before GizmoPanel: CSS lifts the gizmo bar above it when docked. */}
      <div
        ref={renderPillRef}
        className={`floating-pill ${renderPillDocked ? "floating-pill--bottom" : "floating-pill--top-right"}`}
      >
        <QualityPanel />
        <div className="top-panel-divider" aria-hidden />
        <RenderModePanel />
      </div>
      <LeftPanel />
      <RightPanel />
      <GizmoPanel />
      <TimelinePanel />
      <CommandPalette />
      <ImageImportDialog />
      <div className="toast motion-pop" data-open={toastOpen} role="status">
        {toast}
      </div>
    </>
  );
}
