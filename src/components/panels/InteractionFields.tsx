import { Eye, EyeOff, MousePointerClick, X } from "lucide-react";
import { useSceneStore, type SceneItem } from "../../store/sceneStore";
import { TARGET_LABEL, type TrackTarget } from "../../store/animation";
import {
  MAX_REACTIONS,
  REACTION_PRESETS,
  TRIGGERS,
  TRIGGER_LABEL,
  type Reaction,
  type Trigger,
} from "../../store/interaction";
import { useTryStore } from "../../store/tryStore";
import { NumberField } from "./fields";
import { effectiveMaterial } from "./MaterialFields";
import { targetsFor } from "./AnimationFields";

/**
 * Reactions of one item to the viewer: hover, click, pointer. Presets add
 * ready-made ones; "Try" turns the viewport into the embed to feel them.
 */
export function InteractionFields({ item }: { item: SceneItem }) {
  const updateItems = useSceneStore((s) => s.updateItems);
  const root = useSceneStore((s) => s.root);
  const trying = useTryStore((s) => s.trying);
  const setTrying = useTryStore((s) => s.setTrying);
  const reactions = item.interaction ?? [];
  const setReactions = (next: Reaction[]) => {
    // Glow reacts on the item's own material: give it the one it renders with.
    const needsMaterial = !item.material && next.some((r) => r.target === "emission");
    updateItems([item.id], (it) => {
      const { interaction: _drop, ...rest } = it;
      const withMaterial = needsMaterial ? { ...rest, material: { ...effectiveMaterial(root, it) } } : rest;
      return (next.length > 0 ? { ...withMaterial, interaction: next } : withMaterial) as SceneItem;
    });
  };
  const replace = (i: number, r: Reaction) => setReactions(reactions.map((x, j) => (j === i ? r : x)));
  const targets = targetsFor(item);

  return (
    <>
      <div className="props-section-title props-section-title--row" style={{ marginTop: "16px" }}>
        Interaction
        <button
          type="button"
          className={`props-section-action${trying ? " props-section-action--on" : ""}`}
          title="Hover, click and move the pointer in the viewport, like in the exported embed (Esc to stop)"
          aria-pressed={trying}
          onClick={() => setTrying(!trying)}
        >
          <MousePointerClick size={11} />
          {trying ? "Trying" : "Try"}
        </button>
      </div>
      <div className="anim-presets">
        {REACTION_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="anim-preset"
            title={p.hint}
            disabled={reactions.length + p.reactions.length > MAX_REACTIONS}
            onClick={() => setReactions([...reactions, ...p.reactions.map((r) => ({ ...r }))])}
          >
            {p.name}
          </button>
        ))}
      </div>
      {reactions.length === 0 && <p className="props-op-hint">Make it react when people hover, click or move the pointer over your embed.</p>}
      {reactions.map((r, i) => (
        <div key={i} className={`modifier-card${r.off ? " modifier-card--off" : ""}`}>
          <div className="modifier-card-head">
            <select
              className="anim-target"
              aria-label="Reacting property"
              value={r.target}
              onChange={(e) => replace(i, { ...r, target: e.target.value as TrackTarget })}
            >
              {targets.map((k) => (
                <option key={k} value={k}>
                  {TARGET_LABEL[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="modifier-card-btn"
              title={r.off ? "Turn on" : "Turn off"}
              aria-label={r.off ? "Turn on reaction" : "Turn off reaction"}
              onClick={() => replace(i, r.off ? (({ off: _o, ...rest }) => rest as Reaction)(r) : { ...r, off: true })}
            >
              {r.off ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              type="button"
              className="modifier-card-btn"
              title="Remove"
              aria-label="Remove reaction"
              onClick={() => setReactions(reactions.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </div>
          <div className="prop-row">
            <label className="prop-label">When</label>
            <select
              className="prop-input prop-select"
              aria-label="Trigger"
              value={r.trigger}
              onChange={(e) => replace(i, { ...r, trigger: e.target.value as Trigger })}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="prop-row">
            <label className="prop-label">{r.target === "scale" ? "Grow by" : "Change"}</label>
            <NumberField
              ariaLabel="Change"
              value={r.amount}
              step={r.target.startsWith("rotation") ? 5 : 0.01}
              decimals={r.target.startsWith("rotation") ? 1 : 3}
              fallback={r.amount}
              onChange={(amount) => replace(i, { ...r, amount })}
            />
          </div>
        </div>
      ))}
    </>
  );
}
