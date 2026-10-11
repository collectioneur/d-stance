import { Eye, EyeOff, X } from "lucide-react";
import { useSceneStore, type SceneItem } from "../../store/sceneStore";
import {
  ANIMATION_PRESETS,
  MAX_PERIOD,
  MAX_TRACKS,
  MIN_PERIOD,
  TARGET_LABEL,
  WAVEFORMS,
  WAVE_LABEL,
  type Track,
  type TrackTarget,
  type Waveform,
} from "../../store/animation";
import { useTimelineStore } from "../../store/timelineStore";
import { NumberField } from "./fields";
import { effectiveMaterial } from "./MaterialFields";

/** Properties an item can animate (shapes add their size params). */
function targetsFor(item: SceneItem): TrackTarget[] {
  const base: TrackTarget[] = ["position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z", "scale"];
  if (item.kind === "layer") base.push("param0", "param1", "param2", "param3");
  base.push("smoothK", "emission");
  return base;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <label className="prop-label">{label}</label>
      {children}
    </div>
  );
}

/**
 * Animation tracks of one item: presets add ready-made motion, each track can
 * then be tuned (what moves, how, how much, how fast).
 */
export function AnimationFields({ item }: { item: SceneItem }) {
  const updateItems = useSceneStore((s) => s.updateItems);
  const root = useSceneStore((s) => s.root);
  const tracks = item.animation ?? [];
  const setTracks = (next: Track[]) => {
    // Glow animates the item's own material: give it the one it renders with.
    const needsMaterial = !item.material && next.some((t) => t.target === "emission");
    updateItems([item.id], (it) => {
      const { animation: _drop, ...rest } = it;
      const withMaterial = needsMaterial ? { ...rest, material: { ...effectiveMaterial(root, it) } } : rest;
      return (next.length > 0 ? { ...withMaterial, animation: next } : withMaterial) as SceneItem;
    });
    if (next.length > tracks.length) useTimelineStore.getState().play();
  };
  const replace = (i: number, t: Track) => setTracks(tracks.map((x, j) => (j === i ? t : x)));
  const targets = targetsFor(item);

  return (
    <>
      <div className="props-section-title" style={{ marginTop: "16px" }}>
        Animation
      </div>
      <div className="anim-presets">
        {ANIMATION_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="anim-preset"
            title={p.hint}
            disabled={tracks.length + p.tracks.length > MAX_TRACKS}
            onClick={() => setTracks([...tracks, ...p.tracks.map((t) => ({ ...t }))])}
          >
            {p.name}
          </button>
        ))}
      </div>
      {tracks.map((t, i) => (
        <div key={i} className={`modifier-card${t.off ? " modifier-card--off" : ""}`}>
          <div className="modifier-card-head">
            <select
              className="anim-target"
              aria-label="Animated property"
              value={t.target}
              onChange={(e) => replace(i, { ...t, target: e.target.value as TrackTarget })}
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
              title={t.off ? "Turn on" : "Turn off"}
              aria-label={t.off ? "Turn on track" : "Turn off track"}
              onClick={() => replace(i, t.off ? (({ off: _o, ...rest }) => rest as Track)(t) : { ...t, off: true })}
            >
              {t.off ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            <button
              type="button"
              className="modifier-card-btn"
              title="Remove"
              aria-label="Remove track"
              onClick={() => setTracks(tracks.filter((_, j) => j !== i))}
            >
              <X size={12} />
            </button>
          </div>
          <Row label="Wave">
            <select
              className="prop-input prop-select"
              aria-label="Wave"
              value={t.wave}
              onChange={(e) => replace(i, { ...t, wave: e.target.value as Waveform })}
            >
              {WAVEFORMS.map((w) => (
                <option key={w} value={w}>
                  {WAVE_LABEL[w]}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t.wave === "linear" ? "Per cycle" : "Amount"}>
            <NumberField
              ariaLabel="Amount"
              value={t.amount}
              step={t.target.startsWith("rotation") ? 5 : 0.01}
              decimals={t.target.startsWith("rotation") ? 1 : 3}
              fallback={t.amount}
              onChange={(amount) => replace(i, { ...t, amount })}
            />
          </Row>
          <Row label="Period">
            <NumberField
              ariaLabel="Period"
              value={t.period}
              min={MIN_PERIOD}
              max={MAX_PERIOD}
              step={0.1}
              decimals={2}
              fallback={t.period}
              onChange={(period) => replace(i, { ...t, period })}
            />
          </Row>
          <Row label="Phase">
            <NumberField
              ariaLabel="Phase"
              value={t.phase}
              min={0}
              max={1}
              step={0.05}
              decimals={2}
              fallback={0}
              onChange={(phase) => replace(i, { ...t, phase })}
            />
          </Row>
        </div>
      ))}
    </>
  );
}
