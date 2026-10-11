import { useEffect } from "react";
import { Pause, Play } from "lucide-react";
import { useSceneStore } from "../../store/sceneStore";
import { hasAnimation } from "../../store/animation";
import { MAX_DURATION, MIN_DURATION, useTimelineStore } from "../../store/timelineStore";
import { sceneUsesTime } from "../../gpu/sceneCompiler";

/**
 * Playback bar, shown while something in the scene moves. Space plays /
 * pauses (outside text fields); the slider scrubs the loop.
 */
export default function TimelinePanel() {
  const root = useSceneStore((s) => s.root);
  const animated = hasAnimation(root.items) || sceneUsesTime(root);
  const { playing, time, duration, toggle, seek, pause, setDuration } = useTimelineStore();

  useEffect(() => {
    if (!animated) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [animated, toggle]);

  return (
    <div className="timeline motion-pop" data-open={animated} aria-hidden={!animated}>
      <button
        type="button"
        className="timeline-play"
        onClick={toggle}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <span className="timeline-time" aria-label="Time">
        {time.toFixed(1)}s
      </span>
      <input
        className="timeline-scrub"
        type="range"
        aria-label="Scrub"
        min={0}
        max={duration}
        step={0.01}
        value={time}
        style={{ "--progress": `${(time / duration) * 100}%` } as React.CSSProperties}
        onPointerDown={pause}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <label className="timeline-duration" title="Loop length (seconds)">
        <input
          type="number"
          aria-label="Loop length"
          min={MIN_DURATION}
          max={MAX_DURATION}
          step={0.5}
          value={duration}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) setDuration(v);
          }}
        />
        s
      </label>
    </div>
  );
}
