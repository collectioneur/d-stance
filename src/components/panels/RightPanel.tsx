import { useState } from "react";
import {
  useSceneStore,
  findItem,
  pauseHistory,
  resumeHistory,
  IMAGE_ROUND_MAX,
  type ObjectGroup,
  type OpType,
  type SceneItem,
  type ShapeLayer,
  defaultParams,
} from "../../store/sceneStore";
import { OpIcon } from "../OpIcon";
import CodeView from "./CodeView";
import { NumericInput, common } from "./fields";
import { MaterialFields } from "./MaterialFields";
import { ModifierFields } from "./ModifierFields";
import { FormulaField } from "./FormulaField";
import { AnimationFields } from "./AnimationFields";
import { InteractionFields } from "./InteractionFields";
import { TextFields } from "./TextFields";
import type { TextSpec } from "../../utils/textSdf";

// ── Shape size field definitions ──────────────────────────────────────────────

interface SizeField {
  label: string;
  paramIndex: 0 | 1 | 2 | 3;
  min: number;
  step: number;
  max?: number;
}

const SIZE_FIELDS: Record<string, SizeField[]> = {
  sphere: [{ label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 }],
  box: [
    { label: "Width", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Height", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Depth", paramIndex: 2, min: 0.01, step: 0.01 },
  ],
  torus: [
    { label: "Major R", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Minor r", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  cylinder: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  capsule: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  cone: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  roundedBox: [
    { label: "Width", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Height", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Depth", paramIndex: 2, min: 0.01, step: 0.01 },
    { label: "Round r", paramIndex: 3, min: 0, step: 0.01 },
  ],
  boxFrame: [
    { label: "Width", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Height", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Depth", paramIndex: 2, min: 0.01, step: 0.01 },
    { label: "Edge", paramIndex: 3, min: 0.005, step: 0.01 },
  ],
  cappedTorus: [
    { label: "Major R", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Minor r", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Angle °", paramIndex: 2, min: 1, max: 180, step: 1 },
  ],
  link: [
    { label: "Half Length", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Major R", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Minor r", paramIndex: 2, min: 0.01, step: 0.01 },
  ],
  hexPrism: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  triPrism: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  roundedCylinder: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Round r", paramIndex: 1, min: 0.005, step: 0.01 },
    { label: "Half Height", paramIndex: 2, min: 0.01, step: 0.01 },
  ],
  roundCone: [
    { label: "Bottom R", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Top R", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Height", paramIndex: 2, min: 0.01, step: 0.01 },
  ],
  solidAngle: [
    { label: "Angle °", paramIndex: 0, min: 1, max: 179, step: 1 },
    { label: "Radius", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  cutSphere: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Cut Height", paramIndex: 1, min: -10, step: 0.01 },
  ],
  cutHollowSphere: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Cut Height", paramIndex: 1, min: -10, step: 0.01 },
    { label: "Thickness", paramIndex: 2, min: 0.005, step: 0.01 },
  ],
  deathStar: [
    { label: "Sphere R", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Carve R", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Offset", paramIndex: 2, min: 0.01, step: 0.01 },
  ],
  rhombus: [
    { label: "Half Diag A", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Half Diag B", paramIndex: 1, min: 0.01, step: 0.01 },
    { label: "Half Height", paramIndex: 2, min: 0.01, step: 0.01 },
    { label: "Round r", paramIndex: 3, min: 0, step: 0.01 },
  ],
  octahedron: [{ label: "Size", paramIndex: 0, min: 0.01, step: 0.01 }],
  pyramid: [
    { label: "Base", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Height", paramIndex: 1, min: 0.01, step: 0.01 },
  ],
  vesica: [
    { label: "Radius", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Offset", paramIndex: 1, min: 0.005, step: 0.01 },
  ],
  terrain: [
    { label: "Size", paramIndex: 0, min: 0.05, step: 0.05 },
    { label: "Height", paramIndex: 1, min: 0, step: 0.02 },
    { label: "Detail", paramIndex: 2, min: 0.1, max: 40, step: 0.1 },
    { label: "Seed", paramIndex: 3, min: 0, max: 9999, step: 1 },
  ],
  gyroid: [
    { label: "Size", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Cell", paramIndex: 1, min: 0.02, step: 0.01 },
    { label: "Thickness", paramIndex: 2, min: 0.002, step: 0.005 },
  ],
  formula: [
    { label: "Size", paramIndex: 0, min: 0.01, step: 0.05 },
    { label: "Safety", paramIndex: 1, min: 0.05, max: 1, step: 0.05 },
  ],
  image: [
    { label: "Size", paramIndex: 0, min: 0.01, step: 0.01 },
    { label: "Thickness", paramIndex: 1, min: 0.005, step: 0.01 },
    { label: "Bold", paramIndex: 2, min: -10, step: 0.005 },
  ],
};

const OP_OPTIONS: { value: OpType; label: string }[] = [
  { value: "union", label: "Union" },
  { value: "subtract", label: "Subtract" },
  { value: "intersect", label: "Intersect" },
  { value: "sUnion", label: "Smooth Union" },
  { value: "sSubtract", label: "Smooth Subtract" },
  { value: "sIntersect", label: "Smooth Intersect" },
];

const SMOOTH_OPS: Set<OpType> = new Set(["sUnion", "sSubtract", "sIntersect"]);

const OP_HINT: Record<OpType, string> = {
  union: "Merges with the previous result.",
  subtract: "Subtracts from the previous result.",
  intersect: "Keeps only the overlap with the previous result.",
  sUnion: "Smoothly blends with the previous result.",
  sSubtract: "Smoothly subtracts from the previous result.",
  sIntersect: "Smoothly intersects with the previous result.",
};

/** Operation picker for `items` (one, or a whole multi-selection). */
function OperationFields({ items, showOp }: { items: SceneItem[]; showOp: boolean }) {
  const updateItems = useSceneStore((s) => s.updateItems);
  if (!showOp) return null;

  const ids = items.map((item) => item.id);
  const op = common(items.map((item) => item.op));
  const isSmooth = items.some((item) => SMOOTH_OPS.has(item.op));
  const smoothK = common(items.map((item) => item.smoothK));
  const onOpChange = (next: OpType) => updateItems(ids, (item) => ({ ...item, op: next }));
  const onSmoothKChange = (k: number) =>
    updateItems(ids, (item) => ({ ...item, smoothK: k }));

  return (
    <>
      <div className="props-section-title">Operation</div>
      <div className="op-picker" role="radiogroup" aria-label="Operation type">
        {OP_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={op === opt.value}
            className={`op-picker-btn${op === opt.value ? " op-picker-btn--active" : ""}`}
            title={opt.label}
            onClick={() => onOpChange(opt.value)}
          >
            <OpIcon op={opt.value} size={28} />
          </button>
        ))}
      </div>

      {isSmooth && (
        <NumericInput
          label="Smooth K"
          value={smoothK}
          min={0.001}
          step={0.01}
          fallback={0.1}
          onChange={onSmoothKChange}
        />
      )}

      {op && <p className="props-op-hint">{OP_HINT[op]}</p>}
    </>
  );
}

function RootProperties() {
  const root = useSceneStore((s) => s.root);
  const updateRootName = useSceneStore((s) => s.updateRootName);

  return (
    <div className="props-content">
      <div className="props-section-title">Scene</div>
      <div className="prop-row">
        <label className="prop-label">Name</label>
        <input
          className="prop-input"
          type="text"
          value={root.name}
          onFocus={pauseHistory}
          onBlur={resumeHistory}
          onChange={(e) => updateRootName(e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * `shared`: the whole selection (just `group` when alone). Operation edits go to
 * all of it; name and transform fields stay on `group`, the active item.
 */
function GroupProperties({
  group,
  itemIndex,
  shared,
}: {
  group: ObjectGroup;
  itemIndex: number;
  shared: SceneItem[];
}) {
  const updateGroup = useSceneStore((s) => s.updateGroup);
  const showOp = shared.length > 1 || itemIndex > 0;

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const pos: [number, number, number] = [...group.position];
    pos[axis] = v;
    updateGroup(group.id, { position: pos });
  };

  const setRotation = (axis: 0 | 1 | 2, v: number) => {
    const rot: [number, number, number] = [...group.rotation];
    rot[axis] = v;
    updateGroup(group.id, { rotation: rot });
  };

  const setScale = (axis: 0 | 1 | 2, v: number) => {
    const scale: [number, number, number] = [...group.scale];
    scale[axis] = v;
    updateGroup(group.id, { scale });
  };

  return (
    <div className="props-content">
      <div className="props-section-title">Object</div>
      <div className="prop-row">
        <label className="prop-label">Name</label>
        <input
          className="prop-input"
          type="text"
          value={group.name}
          onFocus={pauseHistory}
          onBlur={resumeHistory}
          onChange={(e) => updateGroup(group.id, { name: e.target.value })}
        />
      </div>

      <OperationFields items={shared} showOp={showOp} />

      <div className="props-section-title" style={{ marginTop: showOp ? "16px" : undefined }}>
        Position
      </div>
      <NumericInput label="X" value={group.position[0]} fallback={0} decimals={2} onChange={(v) => setPosition(0, v)} />
      <NumericInput label="Y" value={group.position[1]} fallback={0} decimals={2} onChange={(v) => setPosition(1, v)} />
      <NumericInput label="Z" value={group.position[2]} fallback={0} decimals={2} onChange={(v) => setPosition(2, v)} />

      <div className="props-section-title" style={{ marginTop: "16px" }}>Rotation (°)</div>
      <NumericInput label="Rx" value={group.rotation[0]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(0, v)} />
      <NumericInput label="Ry" value={group.rotation[1]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(1, v)} />
      <NumericInput label="Rz" value={group.rotation[2]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(2, v)} />

      <div className="props-section-title" style={{ marginTop: "16px" }}>Scale</div>
      <NumericInput label="Sx" value={group.scale[0]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(0, v)} />
      <NumericInput label="Sy" value={group.scale[1]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(1, v)} />
      <NumericInput label="Sz" value={group.scale[2]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(2, v)} />

      {shared.length === 1 && <ModifierFields item={group} />}
      {shared.length === 1 && <AnimationFields item={group} />}
      {shared.length === 1 && <InteractionFields item={group} />}
      <MaterialFields items={shared} />
    </div>
  );
}

/**
 * `shared`: the whole selection (just `layer` when alone). Operation and size
 * edits go to all of it (size only when every item is this shape type);
 * transform fields stay on `layer`, the active item.
 */
function LayerProperties({
  layer,
  containerId,
  itemIndex,
  shared,
}: {
  layer: ShapeLayer;
  containerId: string;
  itemIndex: number;
  shared: SceneItem[];
}) {
  const updateLayer = useSceneStore((s) => s.updateLayer);
  const updateItems = useSceneStore((s) => s.updateItems);
  const sameShapes = shared.every(
    (item): item is ShapeLayer => item.kind === "layer" && item.shapeType === layer.shapeType,
  )
    ? (shared as ShapeLayer[])
    : null;
  const sameIds = sameShapes?.map((item) => item.id) ?? [];
  const updateSameShapes = (map: (l: ShapeLayer) => ShapeLayer) =>
    updateItems(sameIds, (item) => (item.kind === "layer" ? map(item) : item));

  const setPosition = (axis: 0 | 1 | 2, v: number) => {
    const pos: [number, number, number] = [...layer.position];
    pos[axis] = v;
    updateLayer(containerId, layer.id, { position: pos });
  };

  const setRotation = (axis: 0 | 1 | 2, v: number) => {
    const rot: [number, number, number] = [...layer.rotation];
    rot[axis] = v;
    updateLayer(containerId, layer.id, { rotation: rot });
  };

  const setParam = (idx: 0 | 1 | 2 | 3, v: number) =>
    updateSameShapes((l) => {
      const params: [number, number, number, number] = [...l.params];
      params[idx] = v;
      return { ...l, params };
    });

  const setScale = (axis: 0 | 1 | 2, v: number) => {
    const scale: [number, number, number] = [...layer.scale];
    scale[axis] = v;
    updateLayer(containerId, layer.id, { scale });
  };

  const sizeFields = sameShapes ? (SIZE_FIELDS[layer.shapeType] ?? []) : [];
  const showOp = shared.length > 1 || itemIndex > 0;
  const textLayer = shared.length === 1 && layer.image?.text ? (layer as ShapeLayer & { image: { text: TextSpec } }) : null;

  return (
    <div className="props-content">
      <OperationFields items={shared} showOp={showOp} />
      {textLayer && <TextFields key={layer.id} layer={textLayer} spaced={showOp} />}

      <div className="props-section-title" style={{ marginTop: showOp || textLayer ? "16px" : undefined }}>
        Position
      </div>
      <NumericInput label="X" value={layer.position[0]} fallback={0} decimals={2} onChange={(v) => setPosition(0, v)} />
      <NumericInput label="Y" value={layer.position[1]} fallback={0} decimals={2} onChange={(v) => setPosition(1, v)} />
      <NumericInput label="Z" value={layer.position[2]} fallback={0} decimals={2} onChange={(v) => setPosition(2, v)} />

      <div className="props-section-title" style={{ marginTop: "16px" }}>Rotation (°)</div>
      <NumericInput label="Rx" value={layer.rotation[0]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(0, v)} />
      <NumericInput label="Ry" value={layer.rotation[1]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(1, v)} />
      <NumericInput label="Rz" value={layer.rotation[2]} step={1} fallback={0} decimals={2} onChange={(v) => setRotation(2, v)} />

      <div className="props-section-title" style={{ marginTop: "16px" }}>Scale</div>
      <NumericInput label="Sx" value={layer.scale[0]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(0, v)} />
      <NumericInput label="Sy" value={layer.scale[1]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(1, v)} />
      <NumericInput label="Sz" value={layer.scale[2]} min={0.01} fallback={1} decimals={2} onChange={(v) => setScale(2, v)} />

      {sizeFields.length > 0 && (
        <div className="props-section-title" style={{ marginTop: "16px" }}>Size</div>
      )}
      {sizeFields.map((f) => (
        <NumericInput
          key={f.label}
          label={f.label}
          value={common(sameShapes!.map((l) => l.params[f.paramIndex]))}
          min={f.min}
          max={f.max}
          step={f.step}
          decimals={f.step < 0.01 ? 3 : 2}
          fallback={defaultParams(layer.shapeType)[f.paramIndex]}
          onChange={(v) => setParam(f.paramIndex, v)}
        />
      ))}
      {sameShapes && layer.shapeType === "image" && layer.image && (
        <NumericInput
          label="Round"
          value={common(sameShapes.map((l) => l.image?.round ?? 0))}
          min={0}
          max={IMAGE_ROUND_MAX}
          step={0.005}
          fallback={0}
          decimals={3}
          onChange={(v) =>
            updateSameShapes((l) => (l.image ? { ...l, image: { ...l.image, round: v } } : l))
          }
        />
      )}
      {sameShapes && layer.shapeType === "image" && (
        <div className="prop-row">
          <label className="prop-label" htmlFor={`invert-${layer.id}`}>
            Invert
          </label>
          <input
            id={`invert-${layer.id}`}
            className="ui-check"
            type="checkbox"
            checked={sameShapes.every((l) => l.params[3] > 0.5)}
            onChange={(e) => setParam(3, e.target.checked ? 1 : 0)}
            title="Plate with the silhouette cut out"
          />
        </div>
      )}

      {shared.length === 1 && layer.shapeType === "formula" && (
        <FormulaField key={layer.id} layer={layer} containerId={containerId} />
      )}
      {shared.length === 1 && <ModifierFields item={layer} />}
      {shared.length === 1 && <AnimationFields item={layer} />}
      {shared.length === 1 && <InteractionFields item={layer} />}
      <MaterialFields items={shared} />
    </div>
  );
}

export default function RightPanel() {
  const root = useSceneStore((s) => s.root);
  const selectedItemId = useSceneStore((s) => s.selectedItemId);
  const selectedIds = useSceneStore((s) => s.selectedIds);
  const rootSelected = useSceneStore((s) => s.rootSelected);
  const [tab, setTab] = useState<"props" | "code">("props");

  const found = selectedItemId ? findItem(root, selectedItemId) : null;
  const shared = selectedIds.flatMap((id) => findItem(root, id)?.item ?? []);
  const extraSelected = shared.length - 1;

  let title = root.name;
  let content: React.ReactNode = null;

  if (found?.item.kind === "layer") {
    title = found.item.name;
    content = (
      <LayerProperties
        layer={found.item}
        containerId={found.container.id}
        itemIndex={found.index}
        shared={shared}
      />
    );
  } else if (found?.item.kind === "group") {
    title = found.item.name;
    content = <GroupProperties group={found.item} itemIndex={found.index} shared={shared} />;
  } else if (rootSelected) {
    content = <RootProperties />;
  } else {
    title = "Properties";
    content = (
      <p className="scene-object-empty">Nothing selected - click an object in the viewport or scene tree.</p>
    );
  }

  return (
    <div className="panel panel-right">
      <div className="panel-header panel-header--tabs">
        <button
          className={`panel-tab${tab === "props" ? " panel-tab--active" : ""}`}
          onClick={() => setTab("props")}
        >
          Properties
        </button>
        <div className="panel-tab-divider" />
        <button
          className={`panel-tab${tab === "code" ? " panel-tab--active" : ""}`}
          onClick={() => setTab("code")}
        >
          Code
        </button>
      </div>
      {tab === "props" ? (
        <>
          <div className="props-shape-name">
            {title}
            {extraSelected > 0 && (
              <span
                className="props-shape-extra"
                title="Operation and size apply to all selected; position, rotation and scale to this object"
              >
                +{extraSelected} selected
              </span>
            )}
          </div>
          {content}
        </>
      ) : (
        <CodeView />
      )}
    </div>
  );
}
