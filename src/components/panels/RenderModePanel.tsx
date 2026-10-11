import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useRenderStore, type RenderMode } from "../../store/renderStore";
import { RENDER_MODE_ICONS } from "../../utils/commands";
import { useSceneStore } from "../../store/sceneStore";
import { sceneFrameSphere } from "../../sdf/itemBounds";
import type { IconComponent } from "../MaskIcon";

type ModeEntry = { value: RenderMode; label: string; hint: string; icon: IconComponent };

const entry = (value: RenderMode, label: string, hint: string): ModeEntry => ({ value, label, hint, icon: RENDER_MODE_ICONS[value] });

const GROUPS: { title: string; modes: ModeEntry[] }[] = [
  {
    title: "Look",
    modes: [
      entry("classic", "Classic", "One light, fast"),
      entry("chrome", "Chrome", "Mirror reflections"),
      entry("studio", "Studio", "Materials, soft shadows, floor"),
      entry("neon", "Neon", "Glowing outlines in each color"),
      entry("volume", "Volume", "Shapes as clouds and smoke"),
    ],
  },
  {
    title: "Inspect",
    modes: [
      entry("field", "Field", "Distance on a slice: orange outside, blue inside"),
      entry("cost", "Cost", "March steps per pixel: blue cheap, red slow"),
      entry("normals", "Normals", "Surface directions as colors"),
    ],
  },
];
const MODES = GROUPS.flatMap((g) => g.modes);

export default function RenderModePanel() {
  const renderMode = useRenderStore((s) => s.renderMode);
  const setRenderMode = useRenderStore((s) => s.setRenderMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = MODES.find((m) => m.value === renderMode) ?? MODES[1];
  const ActiveIcon = active.icon;

  return (
    <div className="render-mode" ref={rootRef}>
      <button
        className="floating-pill-btn render-mode-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Render mode"
      >
        <span className="shape-btn-icon">
          <ActiveIcon size={14} />
        </span>
        <span className="shape-btn-label">{active.label}</span>
        <ChevronDown
          size={13}
          className={`render-mode-chevron${open ? " render-mode-chevron--open" : ""}`}
        />
      </button>
      {/* Always mounted so it can animate out. */}
      <div
        className="render-mode-list motion-pop"
        data-open={open}
        aria-hidden={!open}
        role="listbox"
      >
        {GROUPS.map((group) => (
          <div key={group.title} role="group" aria-label={group.title}>
            <div className="render-mode-group">{group.title}</div>
            {group.modes.map(({ value, label, hint, icon: Icon }) => (
              <button
                key={value}
                className={`render-mode-option${value === renderMode ? " render-mode-option--active" : ""}`}
                role="option"
                aria-selected={value === renderMode}
                title={hint}
                onClick={() => {
                  // Field: start with the slice through the middle of the scene.
                  if (value === "field" && renderMode !== "field") {
                    const sphere = sceneFrameSphere(useSceneStore.getState().root.items);
                    useRenderStore.getState().setSliceY(sphere ? Math.round(sphere.c[1] * 100) / 100 : 0);
                  }
                  setRenderMode(value);
                  setOpen(false);
                }}
              >
                <span className="shape-btn-icon">
                  <Icon size={14} />
                </span>
                <span className="shape-btn-label">{label}</span>
                {value === renderMode && (
                  <Check size={13} className="render-mode-check" />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
