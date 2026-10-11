import { useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  useSceneStore,
  getAncestorGroups,
  findItem,
  pauseHistory,
  resumeHistory,
  type SceneItem,
  type SceneRoot,
} from "../../store/sceneStore";
import {
  DEFAULT_MATERIAL,
  EMISSION_MAX,
  MATERIAL_PRESETS,
  colorToHex,
  hexToColor,
  materialsEqual,
  type Material,
} from "../../store/material";
import { NumericInput, common } from "./fields";

/** What a shape or group actually renders with: own, else nearest ancestor group's, else default. */
export function effectiveMaterial(root: SceneRoot, item: SceneItem): Material {
  if (item.material) return item.material;
  const found = findItem(root, item.id);
  const ancestors = found ? getAncestorGroups(root, found.container.id) : [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const m = ancestors[i].material;
    if (m) return m;
  }
  return DEFAULT_MATERIAL;
}

/**
 * Material editor for the selection. Edits create an own material on every
 * selected item (starting from what it renders with); Reset drops it again so
 * the item inherits from its group.
 */
export function MaterialFields({ items }: { items: SceneItem[] }) {
  const root = useSceneStore((s) => s.root);
  const updateItems = useSceneStore((s) => s.updateItems);
  const effective = items.map((item) => effectiveMaterial(root, item));
  const ids = items.map((item) => item.id);
  const anyOwn = items.some((item) => item.material);
  const allGroups = items.every((item) => item.kind === "group");
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const edit = (patch: Partial<Material>) =>
    updateItems(ids, (item) => ({
      ...item,
      material: { ...effectiveMaterial(root, item), ...patch },
    }));

  const color = common(effective.map((m) => colorToHex(m.color)));
  const inheritedFrom = (() => {
    if (anyOwn || items.length !== 1) return null;
    const found = findItem(root, items[0].id);
    const ancestors = found ? getAncestorGroups(root, found.container.id) : [];
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (ancestors[i].material) return ancestors[i].name;
    }
    return null;
  })();

  return (
    <>
      <div className="props-section-title props-section-title--row" style={{ marginTop: "16px" }}>
        Material
        {anyOwn && (
          <button
            type="button"
            className="props-section-action"
            title={allGroups ? "Remove this group's material" : "Use the group's / default material"}
            onClick={() => updateItems(ids, ({ material: _drop, ...rest }) => rest as SceneItem)}
          >
            <RotateCcw size={11} />
            Reset
          </button>
        )}
      </div>
      <div className="material-presets" role="list" aria-label="Material presets">
        {MATERIAL_PRESETS.map((p) => {
          const active = effective.every((m) => materialsEqual(m, p.material));
          return (
            <button
              key={p.name}
              type="button"
              role="listitem"
              className={`material-preset${active ? " material-preset--active" : ""}`}
              title={p.name}
              aria-label={`${p.name} material`}
              style={{ "--swatch": colorToHex(p.material.color) } as React.CSSProperties}
              data-metal={p.material.metalness > 0.5 || undefined}
              data-emissive={p.material.emission > 0 || undefined}
              onClick={() => edit({ ...p.material, color: [...p.material.color] })}
            />
          );
        })}
      </div>
      <div className="prop-row">
        <label className="prop-label" htmlFor={`color-${ids[0]}`}>
          Color
        </label>
        <div className="color-field">
          <input
            id={`color-${ids[0]}`}
            className="color-swatch"
            type="color"
            value={color ?? "#808080"}
            aria-label="Color"
            onFocus={pauseHistory}
            onBlur={resumeHistory}
            onChange={(e) => {
              const c = hexToColor(e.target.value);
              if (c) edit({ color: c });
            }}
          />
          <input
            className="prop-input color-hex"
            type="text"
            spellCheck={false}
            aria-label="Hex color"
            value={hexDraft ?? color ?? ""}
            placeholder={color === null ? "mixed" : undefined}
            onFocus={(e) => {
              pauseHistory();
              setHexDraft(color ?? "");
              e.currentTarget.select();
            }}
            onChange={(e) => {
              setHexDraft(e.target.value);
              const c = hexToColor(e.target.value);
              if (c) edit({ color: c });
            }}
            onBlur={() => {
              setHexDraft(null);
              resumeHistory();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
          />
        </div>
      </div>
      <NumericInput
        label="Roughness"
        value={common(effective.map((m) => m.roughness))}
        min={0}
        max={1}
        step={0.05}
        decimals={2}
        fallback={DEFAULT_MATERIAL.roughness}
        onChange={(roughness) => edit({ roughness })}
      />
      <NumericInput
        label="Metalness"
        value={common(effective.map((m) => m.metalness))}
        min={0}
        max={1}
        step={0.05}
        decimals={2}
        fallback={0}
        onChange={(metalness) => edit({ metalness })}
      />
      <NumericInput
        label="Emission"
        value={common(effective.map((m) => m.emission))}
        min={0}
        max={EMISSION_MAX}
        step={0.1}
        decimals={2}
        fallback={0}
        onChange={(emission) => edit({ emission })}
      />
      {allGroups && <p className="props-op-hint">Shapes inside without their own material use this.</p>}
      {inheritedFrom && <p className="props-op-hint">Inherited from “{inheritedFrom}”. Edit to override.</p>}
    </>
  );
}
