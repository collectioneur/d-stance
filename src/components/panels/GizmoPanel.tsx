import { useGizmoStore, type GizmoMode } from "../../store/gizmoStore";
import { useSceneStore } from "../../store/sceneStore";
import { useTryStore } from "../../store/tryStore";
import { useBrushStore } from "../../scene/sculpt";
import { GIZMO_ICONS } from "../../utils/commands";
import type { IconComponent } from "../MaskIcon";

const MODES: { value: GizmoMode; label: string; icon: IconComponent; hotkey: string }[] = [
  { value: "translate", label: "Move", icon: GIZMO_ICONS.translate, hotkey: "W" },
  { value: "rotate", label: "Rotate", icon: GIZMO_ICONS.rotate, hotkey: "E" },
  { value: "scale", label: "Scale", icon: GIZMO_ICONS.scale, hotkey: "R" },
];

export default function GizmoPanel() {
  const mode = useGizmoStore((s) => s.mode);
  const setMode = useGizmoStore((s) => s.setMode);
  const trying = useTryStore((s) => s.trying);
  const sculpting = useBrushStore((s) => s.active);
  const hasSelection = useSceneStore((s) => s.selectedItemId !== null) && !trying && !sculpting;

  const activeIndex = MODES.findIndex((m) => m.value === mode);

  // Stays mounted so it can animate out when the selection clears.
  return (
    <div className="gizmo-dock">
      <div
        className="segmented segmented--floating motion-pop"
        data-open={hasSelection}
        aria-hidden={!hasSelection}
        role="radiogroup"
        aria-label="Gizmo mode"
      >
        <span
          className="segmented-indicator"
          style={{ transform: `translateX(${activeIndex * 100}%)` }}
        />
        {MODES.map(({ value, label, icon: Icon, hotkey }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`segmented-btn${mode === value ? " segmented-btn--active" : ""}`}
            title={`${label} (${hotkey})`}
            onClick={() => setMode(value)}
          >
            <span className="shape-btn-icon">
              <Icon size={14} />
            </span>
            <span className="shape-btn-label">{label}</span>
            <span className="shape-btn-key">{hotkey}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
