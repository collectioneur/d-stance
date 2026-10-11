import { useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import type { EmbedExport } from "../../export/embed";
import {
  useExportStore,
  type ExportBackground,
  type ExportFormat,
  type ExportFraming,
  type ExportLook,
  type ExportMotion,
  type ExportQuality,
} from "../../store/exportStore";

type Choice<T extends string> = { value: T; label: string };

const LOOKS: Choice<ExportLook>[] = [
  { value: "editor", label: "Same as editor" },
  { value: "classic", label: "Classic" },
  { value: "chrome", label: "Chrome" },
  { value: "studio", label: "Studio" },
  { value: "neon", label: "Neon" },
  { value: "volume", label: "Volume" },
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

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="prop-row">
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
    </div>
  );
}

/** Settles a fast-changing value (gizmo drags) before heavy work uses it. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function blobUrl(text: string, type: string): string {
  return URL.createObjectURL(new Blob([text], { type }));
}

/**
 * Embed settings, live preview and file actions. The preview is the exported
 * document itself in a sandboxed frame — what you see is what you paste.
 */
export function EmbedPanel({ exp, fileName }: { exp: EmbedExport; fileName: string }) {
  const s = useExportStore();
  const previewDoc = useSettled(exp.document, 400);

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
          title="Embed preview"
          className="embed-preview-frame"
          sandbox="allow-scripts"
          srcDoc={previewDoc}
        />
        <button type="button" className="embed-preview-open" onClick={openTab} title="Open in a new tab">
          <ExternalLink size={12} />
        </button>
      </div>
      <Select label="Look" value={s.look} options={LOOKS} onChange={(look) => s.set({ look })} />
      <Select label="Framing" value={s.framing} options={FRAMINGS} onChange={(framing) => s.set({ framing })} />
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
