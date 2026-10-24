import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, ExternalLink, RotateCcw } from "lucide-react";
import type { EmbedExport } from "../../export/embed";
import type { EmbedView } from "../../export/runtime";
import {
  startView,
  useExportStore,
  type CustomView,
  type ExportBackground,
  type ExportFormat,
  type ExportFraming,
  type ExportLook,
  type ExportMotion,
  type ExportQuality,
} from "../../store/exportStore";
import { useViewStore } from "../../store/viewStore";

type Choice<T extends string> = { value: T; label: string };

const LOOKS: Choice<ExportLook>[] = [
  { value: "editor", label: "Same as editor" },
  { value: "classic", label: "Classic" },
  { value: "chrome", label: "Chrome" },
];
const BACKGROUNDS: Choice<ExportBackground>[] = [
  { value: "studio", label: "Studio" },
  { value: "transparent", label: "Transparent" },
];
const MOTIONS: Choice<ExportMotion>[] = [
  { value: "still", label: "Still" },
  { value: "slow", label: "Slow spin" },
  { value: "spin", label: "Spin" },
];
const QUALITIES: Choice<ExportQuality>[] = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "best", label: "Best" },
];
const FORMATS: Choice<ExportFormat>[] = [
  { value: "html", label: "HTML" },
  { value: "module", label: "JS module" },
];
const FRAMINGS: Choice<ExportFraming>[] = [
  { value: "fit", label: "Fit scene" },
  { value: "editor", label: "Editor view" },
];
const CUSTOM: Choice<ExportFraming> = { value: "custom", label: "Custom" };

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (v: T) => void;
  children?: ReactNode;
}) {
  return (
    <div className={children ? "prop-row embed-row--action" : "prop-row"}>
      <label className="prop-label">{label}</label>
      <select
        className="prop-input prop-select"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}

function blobUrl(text: string, type: string): string {
  return URL.createObjectURL(new Blob([text], { type }));
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Embed settings, live preview and file actions. The preview is the exported
 * document itself in a sandboxed frame — what you see is what you paste.
 * Orbiting or zooming it sets the export's start view.
 */
export function EmbedPanel({ exp, sceneId, fileName }: { exp: EmbedExport; sceneId: string; fileName: string }) {
  const s = useExportStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hasCustom = s.custom?.scene === sceneId;
  const custom = s.framing === "custom" && hasCustom;

  // Reloads settle (gizmo drags) before the frame restarts. A view the
  // preview itself reported only catches the export up: the frame already
  // shows it and keeps running.
  const [previewDoc, setPreviewDoc] = useState(exp.preview);
  const adopted = useRef<CustomView | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (adopted.current && adopted.current === useExportStore.getState().custom && !pending.current) {
      adopted.current = null;
      return;
    }
    pending.current = true;
    const id = setTimeout(() => {
      pending.current = false;
      setPreviewDoc(exp.preview);
    }, 400);
    return () => clearTimeout(id);
  }, [exp.preview]);
  useEffect(() => {
    adopted.current = null;
  }, [s.custom]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const v = (e.data as { dstanceView?: Partial<EmbedView> } | null)?.dstanceView;
      if (!v) return;
      const { rotX, rotY, distance, zoom } = v;
      if (![rotX, rotY, distance, zoom].every((n) => typeof n === "number" && Number.isFinite(n))) return;
      const state = useExportStore.getState();
      const shown = startView(state, sceneId, useViewStore.getState());
      const next: CustomView = {
        scene: sceneId,
        base: shown.framing,
        rotX: round(rotX!),
        rotY: round(rotY!),
        zoom: round(zoom!),
        distance: round(distance!),
      };
      adopted.current = next;
      state.set({ framing: "custom", custom: next });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sceneId]);

  const download = () => {
    const isModule = s.format === "module";
    const url = blobUrl(isModule ? exp.module : exp.document, isModule ? "text/javascript" : "text/html");
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openTab = () => {
    const url = blobUrl(exp.document, "text/html");
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="embed-panel">
      <div className="embed-preview">
        <iframe
          ref={frameRef}
          title="Embed preview"
          className="embed-preview-frame"
          sandbox="allow-scripts"
          srcDoc={previewDoc}
        />
        <button type="button" className="embed-preview-open" onClick={openTab} title="Open in a new tab">
          <ExternalLink size={12} />
        </button>
      </div>
      <p className="embed-preview-hint">Drag or scroll the preview to set where the camera starts.</p>
      <Select label="Look" value={s.look} options={LOOKS} onChange={(look) => s.set({ look })} />
      <Select
        label="Framing"
        value={custom ? "custom" : s.framing === "editor" ? "editor" : "fit"}
        options={hasCustom ? [...FRAMINGS, CUSTOM] : FRAMINGS}
        onChange={(framing) => s.set({ framing })}
      >
        {custom && (
          <button
            type="button"
            className="embed-reset"
            title="Reset the start view"
            aria-label="Reset the start view"
            onClick={() => s.set({ framing: s.custom!.base, custom: null })}
          >
            <RotateCcw size={11} />
          </button>
        )}
      </Select>
      <Select
        label="Background"
        value={s.background}
        options={BACKGROUNDS}
        onChange={(background) => s.set({ background })}
      />
      <Select label="Motion" value={s.motion} options={MOTIONS} onChange={(motion) => s.set({ motion })} />
      <Select label="Quality" value={s.quality} options={QUALITIES} onChange={(quality) => s.set({ quality })} />
      <Select label="Format" value={s.format} options={FORMATS} onChange={(format) => s.set({ format })} />
      <button type="button" className="embed-download" onClick={download}>
        <Download size={13} />
        Download {fileName}
      </button>
    </div>
  );
}
