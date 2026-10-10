import { useEffect, useState } from "react";
import Canvas from "./components/Canvas";
import TopPanel from "./components/panels/TopPanel";
import LeftPanel from "./components/panels/LeftPanel";
import RightPanel from "./components/panels/RightPanel";
import GizmoPanel from "./components/panels/GizmoPanel";
import CommandPalette from "./components/CommandPalette";
import ImageImportDialog from "./components/ImageImportDialog";
import RenderModePanel from "./components/panels/RenderModePanel";
import QualityPanel from "./components/panels/QualityPanel";
import { undoScene, redoScene } from "./store/sceneStore";
import { useGizmoStore } from "./store/gizmoStore";
import { usePersistence } from "./store/persistence";
import { openImageImport } from "./utils/commands";
import { copySelection, duplicateSelection, pasteObjects } from "./scene/clipboard";
import { isImageFile } from "./utils/decodeImage";
import { setToastListener } from "./utils/toast";

export default function App() {
  usePersistence();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    setToastListener((message) => {
      setToast(message);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 2500);
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
      <div className="floating-pill floating-pill--top-right">
        <QualityPanel />
        <div className="top-panel-divider" aria-hidden />
        <RenderModePanel />
      </div>
      <LeftPanel />
      <RightPanel />
      <GizmoPanel />
      <CommandPalette />
      <ImageImportDialog />
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(20, 20, 20, 0.92)",
            color: "#f0f0f0",
            padding: "10px 16px",
            borderRadius: 8,
            fontSize: 13,
            zIndex: 1000,
            pointerEvents: "none",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
