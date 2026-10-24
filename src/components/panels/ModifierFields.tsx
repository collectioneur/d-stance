import { ArrowDown, ArrowUp, Eye, EyeOff, X } from "lucide-react";
import { useSceneStore, type SceneItem } from "../../store/sceneStore";
import {
  MAX_DEFORM,
  MAX_MODIFIERS,
  MAX_POLAR_COUNT,
  MAX_REPEAT_COUNT,
  MIN_SPACING,
  MODIFIER_HINT,
  MODIFIER_LABEL,
  POINT_MODIFIERS,
  createModifier,
  type Axis,
  type Modifier,
  type ModifierKind,
  type Vec3,
} from "../../store/modifiers";
import { shapeBoundRadius } from "../../gpu/bounds";
import { groupLocalSphere } from "../../sdf/itemBounds";
import { NumberField } from "./fields";

const KINDS: ModifierKind[] = ["repeat", "mirror", "polar", "twist", "bend", "elongate", "round", "onion"];
const AXES = ["X", "Y", "Z"] as const;

/** The item's size in its own space, so new modifiers start with sensible numbers. */
function ownExtent(item: SceneItem): number {
  if (item.kind === "layer") {
    const s = Math.max(Math.abs(item.scale[0]), Math.abs(item.scale[1]), Math.abs(item.scale[2]));
    return shapeBoundRadius(item) / s;
  }
  const s = groupLocalSphere(item);
  return s ? Math.max(0.05, Math.min(10, Math.hypot(...s.c) + s.r)) : 0.5;
}

function Vec3Row({
  label,
  value,
  min,
  max,
  step,
  integer,
  onChange,
}: {
  label: string;
  value: Vec3;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (v: Vec3) => void;
}) {
  return (
    <div className="prop-row">
      <label className="prop-label">{label}</label>
      <div className="vec3-field">
        {AXES.map((axis, a) => (
          <NumberField
            key={axis}
            className="prop-input--compact"
            ariaLabel={`${label} ${axis}`}
            value={value[a]}
            min={min}
            max={max}
            step={step}
            decimals={integer ? 0 : 2}
            fallback={value[a]}
            onChange={(v) => {
              const next = [...value] as Vec3;
              next[a] = integer ? Math.round(v) : v;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function AxisPicker({ value, onChange, label = "Axis" }: { value: Axis; onChange: (a: Axis) => void; label?: string }) {
  return (
    <div className="prop-row">
      <label className="prop-label">{label}</label>
      <div className="axis-picker" role="radiogroup" aria-label={label}>
        {AXES.map((axis, a) => (
          <button
            key={axis}
            type="button"
            role="radio"
            aria-checked={value === a}
            className={`axis-picker-btn${value === a ? " axis-picker-btn--active" : ""}`}
            onClick={() => onChange(a as Axis)}
          >
            {axis}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScalarRow({
  label,
  value,
  min,
  max,
  step,
  integer,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="prop-row">
      <label className="prop-label">{label}</label>
      <NumberField
        ariaLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        decimals={integer ? 0 : 3}
        fallback={value}
        onChange={(v) => onChange(integer ? Math.round(v) : v)}
      />
    </div>
  );
}

function ModifierBody({ m, onChange }: { m: Modifier; onChange: (m: Modifier) => void }) {
  switch (m.kind) {
    case "repeat":
      return (
        <>
          <Vec3Row label="Spacing" value={m.spacing} min={MIN_SPACING} max={100} step={0.05} onChange={(spacing) => onChange({ ...m, spacing })} />
          <Vec3Row label="Count" value={m.count} min={0} max={MAX_REPEAT_COUNT} step={1} integer onChange={(count) => onChange({ ...m, count })} />
        </>
      );
    case "mirror":
      return (
        <>
          <div className="prop-row">
            <label className="prop-label">Axes</label>
            <div className="axis-picker" role="group" aria-label="Mirror axes">
              {AXES.map((axis, a) => (
                <button
                  key={axis}
                  type="button"
                  aria-pressed={m.axes[a]}
                  className={`axis-picker-btn${m.axes[a] ? " axis-picker-btn--active" : ""}`}
                  onClick={() => {
                    const axes = [...m.axes] as [boolean, boolean, boolean];
                    axes[a] = !axes[a];
                    onChange({ ...m, axes });
                  }}
                >
                  {axis}
                </button>
              ))}
            </div>
          </div>
          <Vec3Row label="Distance" value={m.offset} min={-100} max={100} step={0.05} onChange={(offset) => onChange({ ...m, offset })} />
        </>
      );
    case "polar":
      return (
        <>
          <ScalarRow label="Count" value={m.count} min={1} max={MAX_POLAR_COUNT} step={1} integer onChange={(count) => onChange({ ...m, count })} />
          <AxisPicker value={m.axis} onChange={(axis) => onChange({ ...m, axis })} />
        </>
      );
    case "twist":
    case "bend":
      return (
        <>
          <ScalarRow label="Amount" value={m.amount} min={-MAX_DEFORM} max={MAX_DEFORM} step={0.1} onChange={(amount) => onChange({ ...m, amount })} />
          <AxisPicker value={m.axis} onChange={(axis) => onChange({ ...m, axis })} />
        </>
      );
    case "elongate":
      return <Vec3Row label="Size" value={m.size} min={0} max={10} step={0.05} onChange={(size) => onChange({ ...m, size })} />;
    case "round":
      return <ScalarRow label="Radius" value={m.radius} min={0} max={10} step={0.01} onChange={(radius) => onChange({ ...m, radius })} />;
    case "onion":
      return <ScalarRow label="Thickness" value={m.thickness} min={0.001} max={10} step={0.005} onChange={(thickness) => onChange({ ...m, thickness })} />;
  }
}

/**
 * Modifier stack of one shape or group: add, edit, switch off, reorder,
 * remove. Point modifiers act on the point in list order, distance
 * modifiers on the result.
 */
export function ModifierFields({ item }: { item: SceneItem }) {
  const updateItems = useSceneStore((s) => s.updateItems);
  const mods = item.modifiers ?? [];
  const setMods = (next: Modifier[]) =>
    updateItems([item.id], (it) => {
      const { modifiers: _drop, ...rest } = it;
      return (next.length > 0 ? { ...rest, modifiers: next } : rest) as SceneItem;
    });
  const replace = (i: number, m: Modifier) => setMods(mods.map((x, j) => (j === i ? m : x)));
  const move = (i: number, by: number) => {
    const next = [...mods];
    const [m] = next.splice(i, 1);
    next.splice(i + by, 0, m);
    setMods(next);
  };

  return (
    <>
      <div className="props-section-title props-section-title--row" style={{ marginTop: "16px" }}>
        Modifiers
        <select
          className="modifier-add"
          aria-label="Add modifier"
          value=""
          disabled={mods.length >= MAX_MODIFIERS}
          onChange={(e) => {
            const kind = e.target.value as ModifierKind;
            if (kind) setMods([...mods, createModifier(kind, ownExtent(item))]);
          }}
        >
          <option value="">+ Add</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {MODIFIER_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {mods.length === 0 && (
        <p className="props-op-hint">
          Repeat, mirror, twist, bend, round or hollow this {item.kind === "group" ? "object" : "shape"}.
        </p>
      )}
      {mods.map((m, i) => (
        <div key={i} className={`modifier-card${m.off ? " modifier-card--off" : ""}`}>
          <div className="modifier-card-head" title={MODIFIER_HINT[m.kind]}>
            <span className="modifier-card-name">
              {MODIFIER_LABEL[m.kind]}
              {!POINT_MODIFIERS.has(m.kind) && <span className="modifier-card-kind">distance</span>}
            </span>
            <button
              type="button"
              className="modifier-card-btn"
              title={m.off ? "Turn on" : "Turn off"}
              aria-label={m.off ? `Turn on ${MODIFIER_LABEL[m.kind]}` : `Turn off ${MODIFIER_LABEL[m.kind]}`}
              onClick={() => replace(i, m.off ? (({ off: _o, ...rest }) => rest as Modifier)(m) : { ...m, off: true })}
            >
              {m.off ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button type="button" className="modifier-card-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              className="modifier-card-btn"
              title="Move down"
              aria-label="Move down"
              disabled={i === mods.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown size={12} />
            </button>
            <button
              type="button"
              className="modifier-card-btn"
              title="Remove"
              aria-label={`Remove ${MODIFIER_LABEL[m.kind]}`}
              onClick={() => setMods(mods.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </div>
          <ModifierBody m={m} onChange={(next) => replace(i, next)} />
        </div>
      ))}
    </>
  );
}
